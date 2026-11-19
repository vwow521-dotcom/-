// S1 spike: can a stdio MCP child of a Claude desktop session wake that session by writing
// to CLAUDE_CODE_MESSAGING_SOCKET? Framing per open-agent-bridge (verified there on Linux only):
//   {"type":"auth","token":<TOKEN>}\n  then  {"type":"user","message":{"role":"user","content":<text>}}\n
// Trigger: write .bridge/s1-trigger.json  {"text": "..."}  — the doorbell polls for it (our process, not the model).
// Log:     .bridge/s1-doorbell.log (never logs the token value).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, ".bridge");
fs.mkdirSync(DIR, { recursive: true });
const LOG = path.join(DIR, "s1-doorbell.log");
const TRIGGER = path.join(DIR, "s1-trigger.json");
const log = (msg, data) => fs.appendFileSync(LOG, `${new Date().toISOString()} [pid ${process.pid}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);

const SOCK = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
log("doorbell started", { socket: SOCK ?? null, hasToken: !!TOKEN, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null });

function ring(text) {
  return new Promise((resolve) => {
    if (!SOCK || !TOKEN) {
      log("ring skipped: messaging env missing");
      return resolve({ ok: false, reason: "env missing" });
    }
    const replies = [];
    const sock = net.connect(SOCK);
    const finish = (r) => {
      clearTimeout(timer);
      sock.destroy();
      log("ring finished", { ...r, replies });
      resolve({ ...r, replies });
    };
    const timer = setTimeout(() => finish({ ok: true, note: "no close within 3s (kept open)" }), 3000);
    sock.on("connect", () => {
      log("pipe connected");
      sock.write(JSON.stringify({ type: "auth", token: TOKEN }) + "\n");
      sock.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
      log("frames written", { textChars: text.length });
    });
    sock.on("data", (d) => replies.push(d.toString().slice(0, 500)));
    sock.on("error", (e) => finish({ ok: false, error: e.message }));
    sock.on("close", () => finish({ ok: true, note: "closed by peer" }));
  });
}

let busy = false;
setInterval(async () => {
  if (busy || !fs.existsSync(TRIGGER)) return;
  busy = true;
  try {
    const { text } = JSON.parse(fs.readFileSync(TRIGGER, "utf8"));
    fs.rmSync(TRIGGER);
    log("trigger picked up");
    await ring(String(text));
  } catch (e) {
    log("trigger error", { error: e.message });
  } finally {
    busy = false;
  }
}, 500);

const server = new McpServer({ name: "s1-doorbell", version: "0.0.1" });
server.registerTool(
  "doorbell_status",
  { title: "门铃状态", description: "S1 测试：报告门铃程序是否拿到了 Claude 的消息套接字。", inputSchema: {} },
  async () => ({
    content: [{ type: "text", text: JSON.stringify({ pid: process.pid, socketPresent: !!SOCK, tokenPresent: !!TOKEN, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }) }],
  }),
);
await server.connect(new StdioServerTransport());
log("mcp stdio connected");
