#!/usr/bin/env node
// stdio MCP proxy for the bridge daemon, and the Claude doorbell.
//
// Claude (desktop Code tab or CLI) launches this as a stdio MCP server named "bridge". It forwards
// every tool call to the daemon's HTTP MCP endpoint. When it runs inside Claude it inherits
// CLAUDE_CODE_MESSAGING_SOCKET / _TOKEN; after a successful join it long-polls the daemon's doorbell
// and, when mail arrives, injects one short "[协作桥] …" user message into the session (verified in S1).
// Anywhere else (no socket) it is a plain proxy and the agent falls back to wait_for_mail.
//
// Env: BRIDGE_URL (default http://127.0.0.1:7878). Logs: <tmp>/ai-bridge/proxy.log (never the token).
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.BRIDGE_URL ?? "http://127.0.0.1:7878").replace(/\/$/, "");
const SOCK = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
const LOG_DIR = path.join(os.tmpdir(), "ai-bridge");
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG = path.join(LOG_DIR, "proxy.log");
const JOIN_FILE = SOCK && TOKEN ? path.join(LOG_DIR, `join-${createHash("sha256").update(SOCK).digest("hex")}.json`) : null;
const log = (msg, data) => {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [pid ${process.pid}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);
  } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

log("proxy start", { base: BASE, socket: !!SOCK, token: !!TOKEN, entry: process.env.CLAUDE_CODE_ENTRYPOINT ?? null });

// ---------- upstream (daemon) ----------
let client = null;
let httpTransport = null;
let connecting = null;
let lastJoin = readJoin();
let closing = false;

function readJoin() {
  if (!JOIN_FILE) return null;
  try {
    const { base, args } = JSON.parse(fs.readFileSync(JOIN_FILE, "utf8"));
    if (base === BASE && typeof args?.agent_id === "string" && typeof args?._recovery?.key === "string") return args;
  } catch {}
  return null;
}

function saveJoin(args) {
  lastJoin = args;
  if (!JOIN_FILE) return;
  const tmp = `${JOIN_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ base: BASE, args }), { mode: 0o600 });
    fs.renameSync(tmp, JOIN_FILE);
  } catch (e) {
    log("join cache write failed", { code: e.code });
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function forgetJoin(removeCache) {
  const old = lastJoin;
  lastJoin = null;
  armDoorbell(null);
  if (removeCache && old && readJoin()?._recovery.key === old._recovery.key) {
    try { fs.rmSync(JOIN_FILE, { force: true }); } catch {}
  }
}

function toolReply(result) {
  if (!result.isError) {
    try { return JSON.parse(result.content?.[0]?.text ?? "{}"); } catch {}
  }
  return {};
}

async function getClient() {
  if (closing) throw new Error("stdio is closing");
  if (connecting) return connecting;
  if (client) return client;
  connecting = (async () => {
    const c = new Client({ name: "bridge-stdio-proxy", version: "0.2.0" });
    const transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"));
    httpTransport = transport;
    try {
      await c.connect(transport);
      if (closing) throw new Error("stdio is closing");
      let doorbellAgent = null;
      if (lastJoin) {
        const args = lastJoin;
        const r = await c.callTool(
          { name: "join", arguments: { ...args, takeover: true, _recovery: { key: args._recovery.key, replay: true } } },
          undefined,
          { timeout: 10_000 },
        );
        const joined = toolReply(r);
        const restored = joined.agent_id === args.agent_id && !joined.error;
        log("join replay", { agent: args.agent_id, restored });
        if (restored && joined.doorbell === "claude-socket") doorbellAgent = args.agent_id;
        if (!restored) forgetJoin(true);
      }
      if (closing) throw new Error("stdio is closing");
      c.onclose = () => {
        if (client === c) client = null;
      };
      client = c;
      armDoorbell(doorbellAgent);
      return c;
    } catch (e) {
      if (!closing) await c.close().catch(() => {});
      throw e;
    }
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function dropClient(c) {
  if (!c || client !== c) return;
  client = null;
  await c.close().catch(() => {});
}

async function upstream(fn) {
  let c;
  try {
    c = await getClient();
    return await fn(c);
  } catch (e) {
    if (closing) throw e;
    // Session lost (daemon restarted) or daemon down: drop the client and retry once.
    log("upstream error, reconnecting", { error: String(e?.message ?? e) });
    await dropClient(c);
    return await fn(await getClient());
  }
}

// ---------- doorbell ----------
let doorbell = null;

function armDoorbell(agent) {
  if (agent && doorbell?.agent === agent) return;
  doorbell?.controller.abort();
  doorbell = null;
  if (!agent || !SOCK || !TOKEN || closing) return;
  const controller = new AbortController();
  doorbell = { agent, controller };
  void ringLoop(agent, controller.signal);
}

function inject(text) {
  return new Promise((resolve) => {
    const sock = net.connect(SOCK);
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: true }), 1500);
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "auth", token: TOKEN }) + "\n");
      sock.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n", (err) => {
        if (err) finish({ ok: false, error: err.message });
      });
    });
    sock.on("error", (e) => finish({ ok: false, error: e.message }));
    sock.on("close", () => finish({ ok: true }));
  });
}

async function ringLoop(agent, signal) {
  log("doorbell armed", { agent });
  while (!signal.aborted) {
    try {
      const previous = await getClient();
      if (signal.aborted) break;
      const session = httpTransport?.sessionId;
      const headers = { "mcp-session-id": session };
      const r = await fetch(`${BASE}/api/doorbell/wait?agent=${encodeURIComponent(agent)}&kind=claude-socket&timeout=50`, { headers, signal });
      if (r.status === 409) {
        const { reconnect } = await r.json();
        if (signal.aborted) break;
        if (reconnect) {
          await dropClient(previous);
          await getClient();
        } else if (client === previous) {
          // A live session lost its identity, so it must wait for an explicit join.
          forgetJoin(false);
        }
        continue;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!j.ring || signal.aborted) continue;
      const res = await inject(j.text);
      if (signal.aborted) break;
      log("doorbell rang", { agent, mails: j.mailIds, ok: res.ok, error: res.error });
      await fetch(`${BASE}/api/doorbell/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, mailIds: j.mailIds, ok: res.ok, error: res.error }),
        signal,
      }).catch(() => {});
    } catch (e) {
      if (signal.aborted) break;
      log("doorbell wait failed", { error: String(e?.message ?? e) });
      await sleep(3000);
    }
  }
}

// ---------- downstream (Claude, stdio) ----------
const server = new Server({ name: "bridge", version: "0.2.0" }, { capabilities: { tools: { listChanged: true } } });
const OFFLINE_TOOL = {
  name: "bridge_offline",
  description: "协作桥守护进程没有运行。调用它查看如何启动。桥启动后工具列表会刷新：如果你是在找 join 等协作桥工具，请重新搜索或列出工具，不要调用这个。",
  inputSchema: { type: "object", properties: {} },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return await upstream((c) => c.listTools());
  } catch (e) {
    log("listTools failed", { error: String(e?.message ?? e) });
    waitForDaemonThenAnnounce();
    return { tools: [OFFLINE_TOOL] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name } = req.params;
  let args = req.params.arguments ?? {};
  if (name === OFFLINE_TOOL.name)
    return {
      content: [{ type: "text", text: `协作桥没有运行（${BASE}）。请让用户运行：ai-bridge start <项目目录>。桥启动后工具列表会自动刷新，重新搜索或列出工具就能看到 join 等工具，再调用 join。` }],
      isError: true,
    };
  if (name === "join") {
    args = { ...args, _recovery: { key: randomUUID(), replay: false } };
    if (SOCK && TOKEN) args._doorbell = "claude-socket";
  }
  const result = await upstream((c) => c.callTool({ name, arguments: args }, undefined, { signal: extra.signal, timeout: 10 * 60_000 }));
  if (name === "join" && !closing) {
    const joined = toolReply(result);
    if (!joined.error && joined.agent_id) {
      saveJoin({ agent_id: joined.agent_id, takeover: args.takeover, _doorbell: args._doorbell, _recovery: args._recovery });
      armDoorbell(joined.doorbell === "claude-socket" ? joined.agent_id : null);
    }
  }
  if (name === "leave" && args.agent_id === lastJoin?.agent_id && toolReply(result).ok) forgetJoin(true);
  return result;
});

let announcing = false;
async function waitForDaemonThenAnnounce() {
  if (announcing) return;
  announcing = true;
  while (!closing) {
    await sleep(5000);
    if (closing) break;
    try {
      await getClient();
      await server.sendToolListChanged();
      log("daemon reachable, tool list changed");
      break;
    } catch {}
  }
  announcing = false;
}

async function shutdown() {
  if (closing) return;
  closing = true;
  armDoorbell(null);
  // A stopped daemon must not keep the proxy alive after its parent has closed stdin.
  const deadline = setTimeout(() => {
    log("stdio closed, upstream cleanup timed out");
    process.exit(0);
  }, 1500);
  try {
    await connecting?.catch(() => {});
    const session = httpTransport?.sessionId;
    if (session) {
      await httpTransport.terminateSession(); // MCP DELETE; the daemon frees this session's bindings
      log("upstream session terminated", { session });
    }
  } catch (e) {
    log("upstream session termination failed", { error: String(e?.message ?? e) });
  } finally {
    await httpTransport?.close();
    await server.close();
    clearTimeout(deadline);
    log("stdio closed, upstream cleanup finished");
  }
}

const transport = new StdioServerTransport();
transport.onclose = shutdown;
// The SDK's stdio server transport does not call onclose on stdin EOF.
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
await server.connect(transport);
log("stdio connected");
if (lastJoin) void getClient().catch(() => waitForDaemonThenAnnounce());
