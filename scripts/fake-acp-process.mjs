#!/usr/bin/env node
// A stubborn ACP agent for the process-ownership smoke (scripts/acp-process-smoke.ts). It starts a long-lived
// detached process of its own (like the tools agy runs) and ignores stdin EOF, so only the bridge's
// supervisor, taskkill /T or the startup sweep can end it.
//   FAKE_PROC_LOG            JSONL log of what happened (pid, child pid, methods)
//   FAKE_PROC_EXIT_ON_PROMPT exit (code 3) on session/prompt, leaving the child behind
//   FAKE_PROC_EXIT_ON_EOF    exit at once on stdin EOF (a well-behaved agent), leaving the child behind
//   FAKE_PROC_LEDGER         on initialize, log whether the bridge ledger already holds this agent's exact identity
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createInterface } from "node:readline";

const logFile = process.env.FAKE_PROC_LOG;
const log = (event, data = {}) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ event, pid: process.pid, at: Date.now(), ...data }) + "\n");
};

// Detached: outside Node's kill-on-close job, like the processes a non-Node agent (agy) starts.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", windowsHide: true, detached: true });
log("started", { child: child.pid });

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let prompt;
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (typeof method !== "string") return;
  log("method", { method });
  if (method === "initialize") {
    if (process.env.FAKE_PROC_LEDGER) {
      let recorded = false;
      try {
        const entry = JSON.parse(fs.readFileSync(process.env.FAKE_PROC_LEDGER, "utf8")).find((e) => e.agentProc?.pid === process.pid);
        recorded = !!(entry?.agentProc.created && entry.supervisor?.created && entry.daemon?.created);
      } catch { /* not recorded */ }
      log("identity", { recorded });
    }
    send({ id, result: { protocolVersion: 1, agentInfo: { name: "fake-proc", version: "1.0.0" },
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } } } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId: "proc-" + process.pid } });
  } else if (method === "session/prompt") {
    if (process.env.FAKE_PROC_EXIT_ON_PROMPT) process.exit(3);
    prompt = id; // Hold the turn open until it is cancelled.
  } else if (method === "session/cancel") {
    if (prompt !== undefined) send({ id: prompt, result: { stopReason: "cancelled" } });
    prompt = undefined;
  } else if (method === "session/close") {
    send({ id, result: {} });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: "Method not supported" } });
  }
});
// By default, ignore EOF and broken pipes: a real agent may keep running after its client is gone.
process.stdin.on("end", () => {
  log("stdin_end");
  if (process.env.FAKE_PROC_EXIT_ON_EOF) process.exit(0);
});
process.stdin.on("error", (error) => log("stdin_error", { code: error.code }));
process.stdout.on("error", () => {});
setInterval(() => {}, 1 << 30);
