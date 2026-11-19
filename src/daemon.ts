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
engine.notifyHuman = (title, body) => {
  if (cfg.notify.enabled) toast(title, body, `http://127.0.0.1:${PORT}/`);
};

// ---------- MCP endpoint ----------
const transports = new Map<string, StreamableHTTPServerTransport>();
engine.isSessionOpen = (id) => transports.has(id);

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
        engine.log("mcp_session_open", { session: id, client: req.body?.params?.clientInfo });
      },
    });
    t.onclose = () => {
      if (!t.sessionId) return;
      transports.delete(t.sessionId);
      engine.log("mcp_session_close", { session: t.sessionId });
      engine.sessionClosed(t.sessionId);
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
engine.onChange = () => {
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
  res.json({ ...engine.snapshot(), git: { repo: await isRepo(projectDir), dirty: (await dirtyFiles(projectDir)).length } });
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
  reply(res, engine.startRun(goal));
});
app.post("/api/runs/stop", (_req, res) => reply(res, engine.stopRun()));
app.post("/api/attempts/:id/decide", (req, res) => {
  const action = req.body?.action;
  if (action !== "approve" && action !== "reject") return void res.status(400).json({ error: "action 必须是 approve 或 reject" });
  reply(res, engine.decide(Number(req.params.id), action, String(req.body?.note ?? "")));
});
app.post("/api/questions/:id/answer", (req, res) => {
  const answer = String(req.body?.answer ?? "").trim();
  if (!answer) return void res.status(400).json({ error: "回答不能为空" });
  reply(res, engine.answer(Number(req.params.id), answer));
});
app.post("/api/mail", (req, res) => {
  const to = String(req.body?.to ?? "");
  const t = String(req.body?.text ?? "").trim();
  if (!t) return void res.status(400).json({ error: "消息不能为空" });
  reply(res, engine.sendFromHuman(to, t));
});

// Doorbells: the stdio proxy (claude-socket) and the Codex Stop hook long-poll here.
app.get("/api/doorbell/wait", async (req, res) => {
  const agent = String(req.query.agent ?? "");
  const kind = String(req.query.kind ?? "");
  if (!engine.isAgent(agent) || !["claude-socket", "codex-hook"].includes(kind))
    return void res.status(400).json({ error: "agent 或 kind 无效" });
  const timeoutMs = Math.min(Math.max(Number(req.query.timeout ?? 50), 1), 55) * 1000;
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const r = await engine.doorbellWait(agent, kind as "claude-socket" | "codex-hook", timeoutMs, ac.signal);
  if (!res.writableEnded && !ac.signal.aborted) res.json(r);
  else if (r.ring && r.mailIds) engine.doorbellResult(agent, r.mailIds, false, "门铃连接在送达前断开");
});
app.post("/api/doorbell/result", (req, res) => {
  const agent = String(req.body?.agent ?? "");
  if (!engine.isAgent(agent)) return void res.status(400).json({ error: "agent 无效" });
  engine.doorbellResult(agent, Array.isArray(req.body?.mailIds) ? req.body.mailIds.map(String) : [], !!req.body?.ok, req.body?.error);
  res.json({ ok: true });
});
app.post("/api/codex/thread", (req, res) => {
  reply(res, engine.registerCodexThread(String(req.body?.session_id ?? ""), String(req.body?.agent ?? "")));
});

app.get("/api/commits/:sha", async (req, res) => {
  res.type("text/plain; charset=utf-8").send(await show(projectDir, req.params.sha));
});

app.listen(PORT, "127.0.0.1", async () => {
  engine.log("server_start", { port: PORT, project: projectDir, config: cfg.source, pollSeconds: cfg.wait.poll_seconds });
  const repo = await isRepo(projectDir);
  console.log(`项目:  ${projectDir}${repo ? "" : "  （警告：不是 git 仓库，交接不会自动提交）"}`);
  console.log(`配置:  ${cfg.source}`);
  console.log(`MCP:   http://127.0.0.1:${PORT}/mcp`);
  console.log(`面板:  http://127.0.0.1:${PORT}/`);
});
