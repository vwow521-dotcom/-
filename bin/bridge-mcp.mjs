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
const log = (msg, data) => {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [pid ${process.pid}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);
  } catch {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log("proxy start", { base: BASE, socket: !!SOCK, token: !!TOKEN, entry: process.env.CLAUDE_CODE_ENTRYPOINT ?? null });

// ---------- upstream (daemon) ----------
let client = null;
let connecting = null;
let lastJoin = null; // replayed (with takeover) after the daemon restarts

async function getClient() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new Client({ name: "bridge-stdio-proxy", version: "0.2.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));
    c.onclose = () => {
      if (client === c) client = null;
    };
    client = c;
    if (lastJoin) {
      const r = await c.callTool({ name: "join", arguments: lastJoin });
      log("re-joined after reconnect", { agent: lastJoin.agent_id, isError: !!r.isError });
    }
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function upstream(fn) {
  try {
    return await fn(await getClient());
  } catch (e) {
    // Session lost (daemon restarted) or daemon down: drop the client and retry once.
    log("upstream error, reconnecting", { error: String(e?.message ?? e) });
    try {
      await client?.close();
    } catch {}
    client = null;
    return await fn(await getClient());
  }
}

// ---------- doorbell ----------
let doorbellAgent = null;
let ringLoopRunning = false;

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

async function ringLoop() {
  if (ringLoopRunning) return;
  ringLoopRunning = true;
  log("doorbell armed", { agent: doorbellAgent });
  while (doorbellAgent) {
    const agent = doorbellAgent;
    try {
      const r = await fetch(`${BASE}/api/doorbell/wait?agent=${encodeURIComponent(agent)}&kind=claude-socket&timeout=50`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!j.ring) continue;
      const res = await inject(j.text);
      log("doorbell rang", { agent, mails: j.mailIds, ok: res.ok, error: res.error });
      await fetch(`${BASE}/api/doorbell/result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent, mailIds: j.mailIds, ok: res.ok, error: res.error }),
      }).catch(() => {});
    } catch (e) {
      log("doorbell wait failed", { error: String(e?.message ?? e) });
      await sleep(3000);
    }
  }
  ringLoopRunning = false;
}

// ---------- downstream (Claude, stdio) ----------
const server = new Server({ name: "bridge", version: "0.2.0" }, { capabilities: { tools: { listChanged: true } } });
const OFFLINE_TOOL = {
  name: "bridge_offline",
  description: "协作桥守护进程没有运行。调用它查看如何启动。",
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
      content: [{ type: "text", text: `协作桥没有运行（${BASE}）。请让用户在 E:\\Interaction-ai 里运行：npm start -- --project <项目目录>，然后重新调用 join。` }],
      isError: true,
    };
  if (name === "join" && SOCK && TOKEN) args = { ...args, _doorbell: "claude-socket" };
  const result = await upstream((c) => c.callTool({ name, arguments: args }, undefined, { signal: extra.signal, timeout: 10 * 60_000 }));
  if (name === "join" && !result.isError) {
    try {
      const parsed = JSON.parse(result.content?.[0]?.text ?? "{}");
      if (!parsed.error && parsed.agent_id) {
        lastJoin = { ...args, takeover: true };
        if (SOCK && TOKEN && parsed.doorbell === "claude-socket") {
          doorbellAgent = parsed.agent_id;
          ringLoop();
        }
      }
    } catch {}
  }
  return result;
});

let announcing = false;
async function waitForDaemonThenAnnounce() {
  if (announcing) return;
  announcing = true;
  for (;;) {
    await sleep(5000);
    try {
      await getClient();
      await server.sendToolListChanged();
      log("daemon reachable, tool list changed");
      break;
    } catch {}
  }
  announcing = false;
}

const transport = new StdioServerTransport();
transport.onclose = () => {
  log("stdio closed, exiting");
  process.exit(0);
};
await server.connect(transport);
log("stdio connected");
