// M0 prototype: minimal shared MCP bridge to validate the three risks in docs/DESIGN.md §5:
//   1. tool-call timeouts on long-poll waits
//   2. whether a model keeps looping on wait_for_my_turn
//   3. whether each desktop client can reach a local HTTP MCP server
// Single process, in-memory state, every event appended to .bridge/m0-log.jsonl for analysis.

import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.BRIDGE_PORT ?? 7878);
const POLL_MS = Number(process.env.BRIDGE_POLL_SECONDS ?? 50) * 1000;
const OFFLINE_MS = Number(process.env.BRIDGE_OFFLINE_SECONDS ?? 180) * 1000;
const PROGRESS_MS = 15_000;
const AGENTS = (process.env.BRIDGE_AGENTS ?? "claude,codex").split(",").map((s) => s.trim()).filter(Boolean);
const LOG_DIR = path.resolve(process.env.BRIDGE_LOG_DIR ?? ".bridge");

fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "m0-log.jsonl");
function log(event: string, data: Record<string, unknown> = {}) {
  const line = { t: new Date().toISOString(), event, ...data };
  fs.appendFileSync(LOG_FILE, JSON.stringify(line) + "\n");
  console.log(`[${line.t.slice(11, 19)}] ${event}`, Object.keys(data).length ? JSON.stringify(data) : "");
}

// ---------- shared state ----------

interface Handoff {
  from: string;
  to: string;
  summary: string;
  notes_for_next: string;
  files_changed: string[];
  at: string;
}

interface AgentStats {
  id: string;
  joinedAt: number;
  sessionId?: string; // the one MCP session allowed to act as this agent
  lastSeenAt: number; // any tool call from the bound session
  waiting: boolean; // a wait_for_my_turn call is currently blocked
  working: boolean; // holds the baton
  waitCalls: number;
  keepWaitingReturns: number;
  lastReturnAt?: number; // when the last wait call returned keep_waiting
  maxGapMs: number; // longest pause between a keep_waiting return and the next wait call
  totalGapMs: number;
  gapCount: number;
  cancelledWaits: number;
}

interface Baton {
  to: string;
  goal: string;
  handoff?: Handoff;
  assignedAt: number;
}

const agents = new Map<string, AgentStats>();
const handoffs: Handoff[] = [];
let goal: string | null = null;
let pending: Baton | null = null; // assigned but not yet picked up
let holder: { agent: string; since: number } | null = null;
const wakers = new Map<string, () => void>();

function stats(id: string): AgentStats {
  let s = agents.get(id);
  if (!s) {
    s = { id, joinedAt: Date.now(), lastSeenAt: Date.now(), waiting: false, working: false, waitCalls: 0, keepWaitingReturns: 0, maxGapMs: 0, totalGapMs: 0, gapCount: 0, cancelledWaits: 0 };
    agents.set(id, s);
  }
  return s;
}

function agentStatus(s: AgentStats): "working" | "waiting" | "idle" | "offline" {
  if (s.working) return "working";
  if (s.waiting) return "waiting";
  if (!s.sessionId) return "offline";
  if (s.lastReturnAt && Date.now() - s.lastReturnAt > OFFLINE_MS) return "offline";
  return "idle";
}

// Identity binding: an agent_id belongs to exactly one live MCP session.
// Returns an error message if `sessionId` may not act as `id`, otherwise null.
function checkBinding(id: string, sessionId: string | undefined): string | null {
  const s = agents.get(id);
  if (!s?.sessionId) return `你还没有以 ${id} 身份 join，请先调用 join。`;
  if (s.sessionId !== sessionId)
    return `身份 ${id} 已被另一个会话占用。请确认你的身份是否正确（可选：${AGENTS.join(", ")}）；如果确实是你，用 join(agent_id, takeover=true) 接管。`;
  s.lastSeenAt = Date.now();
  return null;
}

function holderIsLive(s: AgentStats): boolean {
  return !!s.sessionId && transports.has(s.sessionId) && (s.waiting || s.working || Date.now() - s.lastSeenAt < OFFLINE_MS);
}

function nextAgent(from: string): string {
  const i = AGENTS.indexOf(from);
  return AGENTS[(i + 1) % AGENTS.length] ?? AGENTS[0];
}

function assign(baton: Baton) {
  pending = baton;
  const s = agents.get(baton.to);
  const status = s ? agentStatus(s) : "never-joined";
  log("baton_assigned", { to: baton.to, targetStatus: status });
  if (status === "offline" || status === "never-joined") {
    // Fallback B: in M0 we only surface it in the log and status page.
    log("fallback_B_needed", { to: baton.to, reason: status, hint: `在 ${baton.to} 里说「继续」` });
  }
  wakers.get(baton.to)?.();
}

function role(id: string) {
  return id === AGENTS[0] ? "规划 / 审查" : "编码";
}

function turnPayload(b: Baton) {
  return {
    status: "your_turn",
    goal: b.goal,
    handoff: b.handoff ?? null,
    instructions:
      "轮到你了。按 goal 和 handoff 完成你这一步的工作，然后调用 submit_handoff 交接给下一个角色，交接后立刻回到 wait_for_my_turn 等待循环。" +
      "如果你判断整个目标已经完成（例如审查通过、无需再改），submit_handoff 时设 goal_done=true，不要再交接一个“确认收到”给别人。",
  };
}

// ---------- MCP server (one instance per client session, shared state above) ----------

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "ai-bridge-m0", version: "0.0.1" });

  server.registerTool(
    "join",
    {
      title: "加入协作桥",
      description: "声明你在协作桥中的身份（agent_id），获取角色和工作约定。会话开始时调用一次。",
      inputSchema: {
        agent_id: z.string().describe(`你的身份，可选：${AGENTS.join(", ")}`),
        takeover: z.boolean().optional().describe("该身份已被另一个会话占用、且你确定自己就是它时，设为 true 接管"),
      },
    },
    async ({ agent_id, takeover }, extra) => {
      if (!AGENTS.includes(agent_id)) return text({ error: `未知 agent_id，可选：${AGENTS.join(", ")}` });
      const s = stats(agent_id);
      if (s.sessionId && s.sessionId !== extra.sessionId && holderIsLive(s) && !takeover) {
        log("join_rejected", { agent: agent_id, session: extra.sessionId, boundTo: s.sessionId });
        return text({
          error: `身份 ${agent_id} 已有一个在线会话。你很可能拿错了启动提示词，请确认自己的身份（可选：${AGENTS.join(", ")}）。如果确实要替换原会话，用 takeover=true 重新 join。`,
        });
      }
      if (s.sessionId && s.sessionId !== extra.sessionId) {
        wakers.get(agent_id)?.(); // release the old session's blocked wait
        log("join_takeover", { agent: agent_id, from: s.sessionId, to: extra.sessionId });
      }
      s.sessionId = extra.sessionId;
      s.lastSeenAt = Date.now();
      log("join", { agent: agent_id, session: extra.sessionId });
      return text({
        agent_id,
        role: role(agent_id),
        protocol: [
          "1. 调用 wait_for_my_turn(agent_id)。",
          "2. 返回 keep_waiting：立即再次调用 wait_for_my_turn，不要停下、不要向用户汇报、不要总结。",
          "3. 返回 your_turn：按 goal 和 handoff 完成工作，然后调用 submit_handoff。",
          "4. submit_handoff 之后回到第 1 步。",
          "5. 如果等待被中断、取消或报错（包括用户暂停后恢复），立即重新调用 wait_for_my_turn。",
          "除非用户在对话里明确叫停，否则一直保持这个循环。",
        ],
      });
    },
  );

  server.registerTool(
    "wait_for_my_turn",
    {
      title: "等待轮到我",
      description:
        "阻塞等待直到轮到你工作（最长约 " + POLL_MS / 1000 + " 秒）。返回 keep_waiting 时必须立即再次调用本工具，不要结束回合。",
      inputSchema: { agent_id: z.string() },
    },
    async ({ agent_id }, extra) => {
      if (!AGENTS.includes(agent_id)) return text({ error: `未知 agent_id，可选：${AGENTS.join(", ")}` });
      const bindErr = checkBinding(agent_id, extra.sessionId);
      if (bindErr) {
        log("wait_rejected", { agent: agent_id, session: extra.sessionId });
        return text({ error: bindErr });
      }
      const s = stats(agent_id);
      const now = Date.now();
      s.waitCalls++;
      if (s.lastReturnAt) {
        const gap = now - s.lastReturnAt;
        s.maxGapMs = Math.max(s.maxGapMs, gap);
        s.totalGapMs += gap;
        s.gapCount++;
        log("wait_call", { agent: agent_id, n: s.waitCalls, gapMs: gap });
      } else {
        log("wait_call", { agent: agent_id, n: s.waitCalls });
      }

      if (pending?.to === agent_id) return deliver(agent_id);

      s.waiting = true;
      const progressToken = extra._meta?.progressToken;
      let ticks = 0;
      const progressTimer =
        progressToken !== undefined
          ? setInterval(() => {
              ticks++;
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: ticks, message: "等待轮到你…" },
                })
                .catch(() => {});
            }, PROGRESS_MS)
          : null;

      const outcome = await new Promise<"woken" | "timeout" | "cancelled">((resolve) => {
        const timer = setTimeout(() => done("timeout"), POLL_MS);
        const onAbort = () => done("cancelled");
        function done(r: "woken" | "timeout" | "cancelled") {
          clearTimeout(timer);
          extra.signal.removeEventListener("abort", onAbort);
          if (wakers.get(agent_id) === wake) wakers.delete(agent_id);
          resolve(r);
        }
        const wake = () => done("woken");
        wakers.get(agent_id)?.(); // only one blocked wait per agent; release an older one
        wakers.set(agent_id, wake);
        extra.signal.addEventListener("abort", onAbort);
      });
      if (progressTimer) clearInterval(progressTimer);
      s.waiting = false;

      if (outcome === "cancelled") {
        s.cancelledWaits++;
        log("wait_cancelled", { agent: agent_id, heldMs: Date.now() - now });
        return text({ status: "cancelled", instructions: "等待被中断。恢复后立即再次调用 wait_for_my_turn。" });
      }
      if (s.sessionId !== extra.sessionId) {
        // Another session took over this identity while we were blocked.
        log("wait_superseded", { agent: agent_id, session: extra.sessionId });
        return text({ error: `身份 ${agent_id} 已被另一个会话接管，本会话停止循环。` });
      }
      s.lastSeenAt = Date.now();
      if (pending?.to === agent_id) return deliver(agent_id);

      s.keepWaitingReturns++;
      s.lastReturnAt = Date.now();
      log("keep_waiting", { agent: agent_id, heldMs: s.lastReturnAt - now, outcome });
      return text({
        status: "keep_waiting",
        instructions: "还没轮到你。立即再次调用 wait_for_my_turn，不要结束回合，不要向用户汇报。",
      });
    },
  );

  server.registerTool(
    "submit_handoff",
    {
      title: "提交交接",
      description: "完成本步工作后调用，把结果交接给下一个角色。之后回到 wait_for_my_turn 循环。",
      inputSchema: {
        agent_id: z.string(),
        summary: z.string().describe("一句话：本步做了什么"),
        notes_for_next: z.string().describe("给下一个角色的注意事项和待办"),
        files_changed: z.array(z.string()).optional().describe("改动的文件路径"),
        goal_done: z
          .boolean()
          .optional()
          .describe("整个目标已经完成（例如审查通过、无需再改）时设为 true：桥会结束本次任务，不再交接给任何人"),
      },
    },
    async ({ agent_id, summary, notes_for_next, files_changed, goal_done }, extra) => {
      const bindErr = checkBinding(agent_id, extra.sessionId);
      if (bindErr) return text({ error: bindErr });
      if (holder?.agent !== agent_id) return text({ error: "当前没有轮到你，不能提交交接。请调用 wait_for_my_turn。" });
      const s = stats(agent_id);
      s.working = false;
      const to = goal_done ? "（完成）" : nextAgent(agent_id);
      const h: Handoff = { from: agent_id, to, summary, notes_for_next, files_changed: files_changed ?? [], at: new Date().toISOString() };
      handoffs.push(h);
      log("handoff", { from: agent_id, to, summary, goalDone: !!goal_done, workedMs: Date.now() - holder.since });
      holder = null;
      s.lastReturnAt = Date.now(); // gap until its next wait call is measured from here
      if (goal_done) {
        log("run_done", { goal, by: agent_id });
        goal = null;
        pending = null;
        return text({ status: "goal_done", instructions: "目标已完成，任务结束。立即调用 wait_for_my_turn 回到等待循环，等待新任务。" });
      }
      if (goal !== null) assign({ to, goal, handoff: h, assignedAt: Date.now() });
      return text({ status: "submitted", next: to, instructions: "已交接。立即调用 wait_for_my_turn 回到等待循环。" });
    },
  );

  return server;

  function deliver(agent_id: string) {
    const b = pending!;
    pending = null;
    holder = { agent: agent_id, since: Date.now() };
    const s = stats(agent_id);
    s.working = true;
    log("baton_delivered", { to: agent_id, latencyMs: Date.now() - b.assignedAt });
    return text(turnPayload(b));
  }
}

// ---------- HTTP: MCP endpoint + status page ----------

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sid = req.header("mcp-session-id");
  let transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      res.status(sid ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session" }, id: null });
      return;
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
        log("mcp_session_open", { session: id, client: req.body?.params?.clientInfo });
      },
    });
    transport.onclose = () => {
      const id = transport!.sessionId;
      if (!id) return;
      transports.delete(id);
      log("mcp_session_close", { session: id });
      for (const s of agents.values()) {
        if (s.sessionId === id) {
          s.sessionId = undefined; // free the identity so a new session can join without takeover
          log("agent_unbound", { agent: s.id, session: id });
        }
      }
    };
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest = async (req: express.Request, res: express.Response) => {
  const sid = req.header("mcp-session-id");
  const transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    res.status(404).send("Unknown session");
    return;
  }
  await transport.handleRequest(req, res);
};
app.get("/mcp", sessionRequest);
app.delete("/mcp", sessionRequest);

app.post("/api/start", (req, res) => {
  const g = String(req.body?.goal ?? "").trim();
  const to = String(req.body?.agent ?? AGENTS[0]);
  if (!g || !AGENTS.includes(to)) {
    res.status(400).json({ error: "需要 goal，agent 可选 " + AGENTS.join(", ") });
    return;
  }
  if (goal !== null) {
    log("run_start_rejected", { active: goal, requested: g });
    const msg = "已有任务在进行中，请先点「停止」再开始新任务。";
    if (req.is("application/json")) res.status(409).json({ error: msg });
    else res.status(409).send(`<!doctype html><meta charset="utf-8"><p>${esc(msg)}</p><p><a href="/">返回面板</a></p>`);
    return;
  }
  goal = g;
  holder = null;
  log("run_start", { goal: g, first: to });
  assign({ to, goal: g, assignedAt: Date.now() });
  req.is("application/json") ? res.json({ ok: true }) : res.redirect("/");
});

app.post("/api/stop", (req, res) => {
  log("run_stop", { goal });
  goal = null;
  pending = null;
  holder = null;
  for (const s of agents.values()) s.working = false;
  req.is("application/json") ? res.json({ ok: true }) : res.redirect("/");
});

function snapshot() {
  return {
    goal,
    pending: pending && { to: pending.to, waitingMs: Date.now() - pending.assignedAt },
    holder: holder && { agent: holder.agent, workingMs: Date.now() - holder.since },
    agents: AGENTS.map((id) => {
      const s = agents.get(id);
      if (!s) return { id, status: "never-joined" };
      return {
        id,
        status: agentStatus(s),
        waitCalls: s.waitCalls,
        keepWaitingReturns: s.keepWaitingReturns,
        cancelledWaits: s.cancelledWaits,
        avgGapMs: s.gapCount ? Math.round(s.totalGapMs / s.gapCount) : null,
        maxGapMs: s.maxGapMs,
        sinceLastReturnMs: s.lastReturnAt ? Date.now() - s.lastReturnAt : null,
      };
    }),
    handoffs,
  };
}

app.get("/api/status", (_req, res) => {
  res.json(snapshot());
});

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sec = (ms: number | null | undefined) => (ms == null ? "—" : (ms / 1000).toFixed(1) + "s");

app.get("/", (_req, res) => {
  const s = snapshot();
  const rows = s.agents
    .map((a: any) =>
      `<tr class="${a.status}"><td>${esc(a.id)}</td><td>${esc(a.status)}</td><td>${a.waitCalls ?? 0}</td><td>${a.keepWaitingReturns ?? 0}</td><td>${a.cancelledWaits ?? 0}</td><td>${sec(a.avgGapMs)}</td><td>${sec(a.maxGapMs)}</td><td>${sec(a.sinceLastReturnMs)}</td></tr>`,
    )
    .join("");
  const hs = s.handoffs
    .slice()
    .reverse()
    .map((h) => `<li><b>${esc(h.from)} → ${esc(h.to)}</b> ${esc(h.at.slice(11, 19))}<br>${esc(h.summary)}<br><small>${esc(h.notes_for_next)}</small></li>`)
    .join("");
  // Fallback B: target is offline/never joined, or simply hasn't picked the baton up for 30s.
  const fallback =
    s.pending &&
    s.agents.find((a: any) => a.id === s.pending!.to && (a.status === "offline" || a.status === "never-joined" || s.pending!.waitingMs > 30_000));
  res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>AI Bridge M0</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:960px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}
.offline{background:#fdd}.working{background:#dfd}.waiting{background:#eef}.alert{background:#fe9;padding:8px;margin:8px 0}</style>
<h1>AI Bridge · M0</h1>
<p>目标：${esc(s.goal ?? "（未开始）")}　待领取：${esc(s.pending?.to ?? "—")}　持有者：${esc(s.holder?.agent ?? "—")} ${s.holder ? sec(s.holder.workingMs) : ""}</p>
${fallback ? `<div class="alert">轮到 <b>${esc(s.pending!.to)}</b>，但它不在等待状态。请在 ${esc(s.pending!.to)} 里说「继续」。</div>` : ""}
<table><tr><th>agent</th><th>状态</th><th>wait 调用</th><th>keep_waiting</th><th>被取消</th><th>平均间隔</th><th>最大间隔</th><th>距上次返回</th></tr>${rows}</table>
<form method="post" action="/api/start" style="margin-top:16px"><input name="goal" size="60" placeholder="目标"> 先交给 <select name="agent">${AGENTS.map((a) => `<option>${a}</option>`).join("")}</select> <button>开始</button></form>
<form method="post" action="/api/stop"><button>停止</button></form>
<h2>交接记录</h2><ol>${hs}</ol>`);
});

app.listen(PORT, "127.0.0.1", () => {
  log("server_start", { port: PORT, pollSeconds: POLL_MS / 1000, offlineSeconds: OFFLINE_MS / 1000, agents: AGENTS });
  console.log(`MCP:   http://127.0.0.1:${PORT}/mcp\n面板:  http://127.0.0.1:${PORT}/`);
});
