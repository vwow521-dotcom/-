#!/usr/bin/env node
// Windows parent process for one ACP agent.
//   node acp-supervisor.mjs <ownerPid> <command> [args...]
// Node puts every non-detached child in a kill-on-close job, so when the daemon dies, Windows ends its direct
// children at once. Processes that a non-Node agent (agy) started itself are not in that job, and once the
// agent is gone, `taskkill /T` can no longer find them. So the daemon starts this supervisor detached (it
// survives the daemon), and the supervisor starts the agent. When the owner goes away (IPC disconnect, or its
// PID is gone), the agent is still alive, and `taskkill /T` ends the agent together with everything it started.
//
// The agent inherits this process's stdin/stdout/stderr, which are the owner's pipes, so ACP messages never
// pass through here. The supervisor reports the agent's PID over IPC and exits with the agent's exit code.
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
const agent = spawn(command, args, { stdio: "inherit", windowsHide: true, env });
let ending = false;

agent.once("error", (error) => {
  send({ type: "error", message: error.message });
  process.exit(127);
});
agent.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
if (agent.pid) send({ type: "agent", pid: agent.pid });

function endAgent() {
  if (ending) return;
  ending = true;
  if (!agent.pid || agent.exitCode !== null || agent.signalCode !== null) process.exit(1);
  execFile("taskkill.exe", ["/PID", String(agent.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }, () => {
    if (agent.exitCode === null && agent.signalCode === null) agent.kill();
    setTimeout(() => process.exit(1), 2000).unref();
  });
}

process.on("disconnect", endAgent);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(signal, endAgent);
// Backup only: IPC disconnect is the reliable signal that the owner died.
setInterval(() => { if (!alive(ownerPid)) endAgent(); }, 1000).unref();
