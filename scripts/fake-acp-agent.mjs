// ACP v1 fixture: talks to the real bridge over the MCP transport specified by each session request.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const agent = process.env.BRIDGE_AGENT_ID;
const { FAKE_ACP_LOG: logFile, FAKE_ACP_PERMISSIONS, FAKE_ACP_TURN_MS, FAKE_ACP_CRASH_AT, FAKE_ACP_NO_HTTP } = process.env;
const log = (event, fields) => fs.appendFileSync(logFile, JSON.stringify({ event, pid: process.pid, agent, ...fields }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let client;
let transport;
let sessionId;
let cwd;
let joined = false;
let turn;
let prompts = 0;
let sequence = 0;
const requests = new Map();

async function open(params) {
  const [server] = params.mcpServers;
  if (!["bridge", "bridge_acp"].includes(server?.name)) throw new Error("bridge MCP server missing");
  const name = server.type === "http" ? "dsh-mcp-client" : "antigravity-client";
  const tempEnv = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
  transport = server.type === "http"
    ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) } })
    : new StdioClientTransport({ command: server.command, args: server.args, env: {
        ...tempEnv, ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      } });
  client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  log("mcp_connected", { name: server.name, transport: server.type ?? "stdio", mcpPid: transport.pid });
  cwd = params.cwd;
  sessionId = params.sessionId ?? randomUUID();
  return { sessionId };
}

async function call(name, args = {}) {
  const reply = await client.callTool({ name, arguments: { agent_id: agent, ...args } });
  const result = JSON.parse(reply.content[0].text);
  if (result.error || reply.isError) throw new Error(name + ": " + reply.content[0].text);
  return result;
}

function update(fields) {
  send({ method: "session/update", params: { sessionId, update: fields } });
}

async function permission() {
  const id = "permission-" + ++sequence;
  const result = new Promise((resolve) => requests.set(id, resolve));
  send({ id, method: "session/request_permission", params: { sessionId, toolCall: { title: "fixture file", toolCallId: "check" },
    options: [
      { kind: "allow_always", optionId: "always", name: "Always allow" },
      { kind: "allow_once", optionId: "allow", name: "Allow once" },
      { kind: "reject_once", optionId: "deny", name: "Reject once" },
    ],
  } });
  log("decision", await result);
}

async function prompt() {
  if (turn) throw new Error("a second prompt overlapped the active turn");
  const current = turn = new AbortController();
  try {
    prompts++;
    const marker = logFile + ".crashed";
    if (prompts === Number(FAKE_ACP_CRASH_AT) && !fs.existsSync(marker)) {
      fs.writeFileSync(marker, String(process.pid));
      process.exit(47);
    }
    if (!joined) {
      const result = await call("join");
      log("joined", { doorbell: result.doorbell, agent_id: result.agent_id, protocol: result.protocol.at(-2) });
      joined = true;
    }
    update({ sessionUpdate: "tool_call", toolCallId: "inbox", title: "fetch_inbox", status: "in_progress" });
    const { mails } = await call("fetch_inbox");
    update({ sessionUpdate: "tool_call_update", toolCallId: "inbox", status: "completed" });
    log("fetched", { ids: mails.map((m) => m.id) });
    if (FAKE_ACP_PERMISSIONS === "1") await permission();
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture\n".repeat(54) + "输出末行" } });
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, Number(FAKE_ACP_TURN_MS || 0));
      current.signal.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once: true });
      if (current.signal.aborted) { clearTimeout(timeout); resolve(); }
    });
    if (current.signal.aborted) return { stopReason: "cancelled" };
    for (const mail of mails.filter((m) => !m.void)) {
      if (mail.kind === "task") {
        const view = mail.task.stage.id === "review";
        if (!view) fs.appendFileSync(path.join(cwd, "README.md"), "fixture ACP handoff\n");
        const result = await call("submit_handoff", { summary: "fixture " + agent, files_changed: view ? [] : ["README.md"],
          ...(view ? { verdict: "approve" } : {}) });
        if (result.status !== "submitted") throw new Error("handoff failed");
      } else if (mail.kind === "chat") {
        await call("say", { text: "fixture received " + mail.id, reply_to: mail.chat.message_id });
      } else if (mail.ack_required) await call("ack", { mail_ids: [mail.id] });
    }
    return { stopReason: "end_turn" };
  } finally {
    turn = undefined;
  }
}

const methods = {
  initialize() {
    log("environment", {
      claudeKeys: Object.keys(process.env).filter((key) => /^CLAUDE_CODE_/i.test(key)),
      doorbell: process.env.BRIDGE_DOORBELL, bridgeAgent: agent,
    });
    return { protocolVersion: 1, agentInfo: { name: "fake-acp", version: "1.0.0" },
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: !FAKE_ACP_NO_HTTP }, sessionCapabilities: { resume: {}, close: {} } } };
  },
  "session/new": open,
  "session/resume": open,
  "session/load": open,
  "session/set_mode": () => ({}),
  "session/prompt": prompt,
  "session/cancel": () => { turn?.abort(); },
  async "session/close"() {
    turn?.abort();
    await transport?.terminateSession?.().catch(() => {});
    await client?.close();
    return {};
  },
};

async function receive(line) {
  const { id, method, params, result } = JSON.parse(line);
  if (!method) {
    requests.get(id)?.(result);
    requests.delete(id);
    return;
  }
  log(method, { sessionId: params.sessionId ?? sessionId, modeId: params.modeId });
  try {
    if (!Object.hasOwn(methods, method)) throw new Error("unknown method " + method);
    const reply = await methods[method](params);
    if (id !== undefined) send({ id, result: reply });
  } catch (error) {
    if (id !== undefined) send({ id, error: { code: -32603, message: error.message } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => void receive(line));
