#!/usr/bin/env node
// Windows parent process for one ACP agent.
//   node acp-supervisor.mjs <ownerPid> <command> [args...]
// Node puts every non-detached child in a kill-on-close job, so when the daemon dies, Windows ends its direct
// children at once. Processes that a non-Node agent (agy) started itself are not in that job, and once the
// agent is gone, `taskkill /T` can no longer find them. So the daemon starts this supervisor detached (it
// survives the daemon), and the supervisor starts the agent.
//
// The supervisor holds the agent's stdin/stdout/stderr and copies the bytes unchanged. Because of that, the
// agent cannot see EOF or a broken pipe before the supervisor acts: when the owner goes away (IPC disconnect,
// stdin EOF, or its PID is gone), the agent is still alive and `taskkill /T` ends it together with everything
// it started. The supervisor reports the agent's PID over IPC and exits with the agent's exit code.
import { execFile, spawn } from "node:child_process";

const ownerPid = Number(process.argv[2]);
const [command, ...args] = process.argv.slice(3);
if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !command) {
  process.stderr.write("usage: acp-supervisor.mjs <ownerPid> <command> [args...]\n");
  process.exit(2);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
const send = (message) => {
  try { if (process.connected) process.send(message); } catch { /* The owner is gone. */ }
};

const env = { ...process.env };
delete env.NODE_CHANNEL_FD;
delete env.NODE_CHANNEL_SERIALIZATION_MODE;
const agent = spawn(command, args, { stdio: "pipe", windowsHide: true, env });
let ending = false;
let finished = false;

// Copy bytes unchanged in both directions. Never forward EOF to the agent: the owner never closes the agent's
// input on purpose (it ends the tree instead), so an EOF here means the owner is gone.
process.stdin.pipe(agent.stdin, { end: false });
agent.stdout.pipe(process.stdout);
agent.stderr.pipe(process.stderr);
for (const stream of [agent.stdin, process.stdout, process.stderr]) stream.on("error", () => {});

agent.once("error", (error) => {
  finished = true;
  send({ type: "error", message: error.message });
  process.exit(127);
});
if (agent.pid) send({ type: "agent", pid: agent.pid });

// "close" fires after the agent's output is fully copied. Let this process exit on its own so the last bytes
// reach the owner, with the agent's exit code.
agent.once("close", (code, signal) => {
  finished = true;
  process.exitCode = code ?? (signal ? 1 : 0);
  process.stdin.destroy();
  if (process.connected) process.disconnect();
});

function endAgent() {
  if (ending || finished) return;
  ending = true;
  if (!agent.pid || agent.exitCode !== null || agent.signalCode !== null) process.exit(1);
  execFile("taskkill.exe", ["/PID", String(agent.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }, () => {
    if (agent.exitCode === null && agent.signalCode === null) agent.kill();
    setTimeout(() => process.exit(1), 2000).unref();
  });
}

process.stdin.on("end", endAgent);
process.stdin.on("error", endAgent);
process.on("disconnect", endAgent);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(signal, endAgent);
// Backup only: IPC disconnect and stdin EOF are the reliable signals that the owner died.
setInterval(() => { if (!alive(ownerPid)) endAgent(); }, 1000).unref();
