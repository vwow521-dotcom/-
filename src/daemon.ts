// Bridge daemon: one process serving the MCP endpoint, the JSON API and the panel.
//   npm start -- --project <目标项目目录> [--port 7878]
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { buildServer } from "./mcp.js";
import { isRepo, dirtyFiles, show } from "./git.js";
import { PANEL_HTML } from "./panel.js";
import { toast } from "./notify.js";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const projectDir = path.resolve(arg("project") ?? process.env.BRIDGE_PROJECT ?? process.cwd());
if (!fs.existsSync(projectDir)) {
  console.error(`项目目录不存在：${projectDir}`);
  process.exit(1);
}
const PORT = Number(arg("port") ?? process.env.BRIDGE_PORT ?? 7878);

let cfg;
try {
  cfg = loadConfig(projectDir);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const store = new Store(projectDir);
const engine = new Engine(cfg, store);
engine.context.notifyHuman = (title, body) => {
  if (cfg.notify.enabled) toast(title, body, `http://127.0.0.1:${PORT}/`);
};

// ---------- MCP endpoint ----------
const transports = new Map<string, StreamableHTTPServerTransport>();
engine.presence.isSessionOpen = (id) => transports.has(id);

const app = express();
app.use(express.json({ limit: "4mb" }));

app.post("/mcp", async (req, res) => {
  const sid = req.header("mcp-session-id");
  let transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      res.status(sid ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session" }, id: null });
      return;
    }
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, t);
        engine.context.log("mcp_session_open", { session: id, client: req.body?.params?.clientInfo });
      },
    });
    t.onclose = () => {
      if (!t.sessionId) return;
      transports.delete(t.sessionId);
      engine.context.log("mcp_session_close", { session: t.sessionId });
      engine.presence.sessionClosed(t.sessionId);
    };
    await buildServer(engine).connect(t);
    transport = t;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest = async (req: express.Request, res: express.Response) => {
  const t = transports.get(req.header("mcp-session-id") ?? "");
  if (!t) {
    res.status(404).send("Unknown session");
    return;
  }
  await t.handleRequest(req, res);
};
app.get("/mcp", sessionRequest);
app.delete("/mcp", sessionRequest);

// ---------- panel + JSON API ----------
const sseClients = new Set<express.Response>();
let changeTimer: NodeJS.Timeout | null = null;
engine.context.onChange = () => {
  if (changeTimer) return; // coalesce bursts
  changeTimer = setTimeout(() => {
    changeTimer = null;
    for (const c of sseClients) c.write("data: change\n\n");
  }, 150);
};

app.get("/", (_req, res) => {
  res.type("html").send(PANEL_HTML);
});

app.get("/api/state", async (_req, res) => {
  res.json({ ...engine.workspace.snapshot(), git: { repo: await isRepo(projectDir), dirty: (await dirtyFiles(projectDir)).length } });
});

app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write("data: hello\n\n");
  sseClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

const reply = (res: express.Response, r: Record<string, unknown>) => res.status(r.error ? 409 : 200).json(r);

app.post("/api/runs", (req, res) => {
  const goal = String(req.body?.goal ?? "").trim();
  if (!goal) return void res.status(400).json({ error: "目标不能为空" });
  reply(res, engine.scheduler.startRun(goal));
});
app.post("/api/runs/stop", (_req, res) => reply(res, engine.scheduler.stopRun()));
app.post("/api/attempts/:id/decide", (req, res) => {
  const action = req.body?.action;
  if (action !== "approve" && action !== "reject") return void res.status(400).json({ error: "action 必须是 approve 或 reject" });
  reply(res, engine.scheduler.decide(Number(req.params.id), action, String(req.body?.note ?? "")));
});
app.post("/api/meetings", (req, res) => {
  const topic = String(req.body?.topic ?? "").trim();
  if (!topic) return void res.status(400).json({ error: "议题不能为空" });
  const parts = Array.isArray(req.body?.participants) ? req.body.participants.map(String) : undefined;
  reply(res, engine.meetings.startMeeting(topic, parts, req.body?.facilitator ? String(req.body.facilitator) : undefined));
});
app.post("/api/meetings/:id/next", (req, res) => {
  const action = req.body?.action;
  if (action !== "critique" && action !== "finalize") return void res.status(400).json({ error: "action 必须是 critique 或 finalize" });
  reply(res, engine.meetings.meetingNext(Number(req.params.id), action, String(req.body?.note ?? "")));
});
app.post("/api/meetings/:id/decide", async (req, res) => {
  const action = req.body?.action;
  if (action !== "approve" && action !== "reject") return void res.status(400).json({ error: "action 必须是 approve 或 reject" });
  reply(res, await engine.meetings.meetingDecide(Number(req.params.id), action, String(req.body?.note ?? "")));
});
app.post("/api/meetings/:id/cancel", (req, res) => reply(res, engine.meetings.meetingCancel(Number(req.params.id))));
app.post("/api/questions/:id/answer", (req, res) => {
  const answer = String(req.body?.answer ?? "").trim();
  if (!answer) return void res.status(400).json({ error: "回答不能为空" });
  reply(res, engine.workspace.answer(Number(req.params.id), answer));
});
app.post("/api/agents/:id/release", (req, res) => reply(res, engine.presence.release(req.params.id, "human")));

// The human's chat: `mentions` and/or @names in the text pick who is woken.
app.post("/api/chat", (req, res) => {
  const mentions = Array.isArray(req.body?.mentions) ? req.body.mentions.map(String) : [];
  const replyTo = req.body?.reply_to ? Number(req.body.reply_to) : undefined;
  reply(res, engine.chat.post("human", String(req.body?.text ?? ""), mentions, replyTo));
});
// One agent's message box: a chat message to that agent. `id` is its mail (the receipt).
app.post("/api/mail", (req, res) => {
  const to = String(req.body?.to ?? "");
  if (!engine.presence.isAgent(to)) return void res.status(409).json({ error: "未知收件人" });
  const r = engine.chat.post("human", String(req.body?.text ?? ""), [to]);
  reply(res, r.error ? r : { ...r, id: (r.mail_ids as Record<string, string>)[to] });
});

// Parked doorbells: the stdio proxy (claude-socket) and a parking Codex Stop hook (codex-hook) long-poll here.
app.get("/api/doorbell/wait", async (req, res) => {
  const agent = String(req.query.agent ?? "");
  const kind = String(req.query.kind ?? "");
  if (!engine.presence.isAgent(agent) || !["claude-socket", "codex-hook"].includes(kind))
    return void res.status(400).json({ error: "agent 或 kind 无效" });
  // New Claude proxies tie their parked doorbell to the bound MCP session.
  const session = kind === "claude-socket" ? req.get("mcp-session-id") : undefined;
  const stillBound = () => !session || engine.presence.get(agent)?.sessionId === session;
  const disconnected = () => res.status(409).json({ reconnect: !!session && !transports.has(session) });
  if (!stillBound()) return void disconnected();
  const timeoutMs = Math.min(Math.max(Number(req.query.timeout ?? 50), 1), 55) * 1000;
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const r = await engine.postman.doorbellWait(agent, kind as "claude-socket" | "codex-hook", timeoutMs, ac.signal);
  if (!res.writableEnded && !ac.signal.aborted && stillBound()) return void res.json(r);
  if (!res.writableEnded && !ac.signal.aborted) disconnected();
  if (r.ring && r.mailIds) engine.postman.doorbellResult(agent, r.mailIds, false, "门铃连接在送达前断开", kind as "claude-socket" | "codex-hook");
});
app.post("/api/doorbell/result", (req, res) => {
  const agent = String(req.body?.agent ?? "");
  if (!engine.presence.isAgent(agent)) return void res.status(400).json({ error: "agent 无效" });
  engine.postman.doorbellResult(agent, Array.isArray(req.body?.mailIds) ? req.body.mailIds.map(String) : [], !!req.body?.ok, req.body?.error);
  res.json({ ok: true });
});
// Where an agent's client can be reached outside MCP. The Codex Stop hook registers its conversation id
// (kind "codex-thread") at the end of every turn; the answer tells it whether to park as the doorbell.
app.post("/api/agents/:id/endpoint", (req, res) => {
  reply(res, engine.postman.registerEndpoint(req.params.id, String(req.body?.kind ?? ""), String(req.body?.address ?? "")));
});
// Pre-0.5 hooks.
app.post("/api/codex/thread", (req, res) => {
  reply(res, engine.postman.registerEndpoint(String(req.body?.agent ?? ""), "codex-thread", String(req.body?.session_id ?? "")));
});

app.get("/api/commits/:sha", async (req, res) => {
  res.type("text/plain; charset=utf-8").send(await show(projectDir, req.params.sha));
});

app.listen(PORT, "127.0.0.1", async () => {
  engine.context.log("server_start", { port: PORT, project: projectDir, config: cfg.source, pollSeconds: cfg.wait.poll_seconds });
  const repo = await isRepo(projectDir);
  console.log(`项目:  ${projectDir}${repo ? "" : "  （警告：不是 git 仓库，交接不会自动提交）"}`);
  console.log(`配置:  ${cfg.source}`);
  console.log(`MCP:   http://127.0.0.1:${PORT}/mcp`);
  console.log(`面板:  http://127.0.0.1:${PORT}/`);
});
