// Windows process ownership for ACP agents. Node ends a dead daemon's direct children (kill-on-close job), but
// not what a non-Node agent such as agy started itself: those processes would keep running. Two layers:
//   1. a supervisor (bin/acp-supervisor.mjs) is each agent's parent and outlives the daemon. When the daemon
//      goes away it ends the agent's whole tree while the agent is still alive;
//   2. a ledger (<project>/.bridge/acp-hosts.json) lets the next daemon end what the supervisor could not,
//      but only processes whose PID and exact creation time both match what was recorded.
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const win = process.platform === "win32";
export const SUPERVISOR_SCRIPT = fileURLToPath(new URL("../../bin/acp-supervisor.mjs", import.meta.url));
const SUPERVISOR_NAME = path.basename(SUPERVISOR_SCRIPT);

export interface ProcessInfo { pid: number; created: string | null; cmd: string }
interface Owned { pid: number; created: string | null }
export interface LedgerEntry {
  id: string;
  agent: string;
  project: string;
  command: string;
  at: string;
  daemon: Owned;
  supervisor: Owned | null;
  agentProc: Owned;
}

// ---------- process queries ----------

function processScript(pids: number[]) {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(",");
  // CreationDate is exact to the tick, so a reused PID never matches a recorded time.
  return "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    `$ids=@(${ids});` +
    "@(Get-CimInstance Win32_Process -Filter (($ids|ForEach-Object{\"ProcessId=$_\"}) -join ' or ')|" +
    "ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;created=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null});cmd=[string]$_.CommandLine}})" +
    "|ConvertTo-Json -Compress";
}

function parseProcesses(out: string) {
  const map = new Map<number, ProcessInfo>();
  const text = out.trim();
  if (!text) return map;
  try {
    const parsed = JSON.parse(text) as ProcessInfo | ProcessInfo[];
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      if (Number.isInteger(row?.pid)) map.set(row.pid, { pid: row.pid, created: row.created ?? null, cmd: row.cmd ?? "" });
    }
  } catch { /* An unreadable answer verifies nothing. */ }
  return map;
}

const shellArgs = (pids: number[]) => ["-NoProfile", "-NonInteractive", "-Command", processScript(pids)];

/** Live processes among `pids`, with their exact creation time and command line (Windows only). */
export function queryProcesses(pids: number[]): Map<number, ProcessInfo> {
  if (!win || !pids.some((pid) => pid > 0)) return new Map();
  try {
    return parseProcesses(execFileSync("powershell.exe", shellArgs(pids),
      { encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return new Map();
  }
}

export function queryProcessesAsync(pids: number[]): Promise<Map<number, ProcessInfo>> {
  if (!win || !pids.some((pid) => pid > 0)) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile("powershell.exe", shellArgs(pids), { encoding: "utf8", windowsHide: true, timeout: 20_000 },
      (error, out) => resolve(error ? new Map() : parseProcesses(out)));
  });
}

function killTree(pid: number) {
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------- ledger ----------

let ledger: { file: string; project: string } | undefined;
let daemonCreated: Promise<string | null> | undefined;

/** The daemon calls this once at startup. Without it (doctor --probe), agents are supervised but not recorded. */
export function configureAcpLedger(file: string, project: string) {
  ledger = { file, project: path.resolve(project) };
}

export function readLedger(file = ledger?.file): LedgerEntry[] {
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string") : [];
  } catch {
    return [];
  }
}

function writeLedger(entries: LedgerEntry[]) {
  if (!ledger) return;
  try {
    fs.mkdirSync(path.dirname(ledger.file), { recursive: true });
    const tmp = `${ledger.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
    fs.renameSync(tmp, ledger.file);
  } catch { /* The watcher still covers this agent. */ }
}

function updateLedger(change: (entries: LedgerEntry[]) => LedgerEntry[]) {
  if (ledger) writeLedger(change(readLedger()));
}

// ---------- per-agent supervision ----------

export const supervised = win;

/** How AcpRpc starts an agent on Windows: through the detached supervisor, which becomes the agent's parent. */
export function supervisorSpawn(command: string, args: readonly string[]) {
  return {
    command: process.execPath,
    args: [SUPERVISOR_SCRIPT, String(process.pid), command, ...args],
    // detached: the supervisor stays out of Node's kill-on-close job, so it outlives a daemon that dies and can
    // still end the agent's whole tree. It has no console of its own; the agent gets a hidden one (windowsHide).
    options: { stdio: ["pipe", "pipe", "pipe", "ipc"] as ("pipe" | "ipc")[], detached: true },
  };
}

/**
 * Record a supervised agent in the ledger as soon as its PID is known, then fill in the exact creation times.
 * Returns the function that removes the entry when the agent exits normally.
 */
export function recordAcpProcess(agent: string, command: string, supervisorPid: number, agentPid: number): () => void {
  if (!ledger) return () => {};
  const id = randomUUID();
  const entry: LedgerEntry = {
    id, agent, project: ledger.project, command, at: new Date().toISOString(),
    daemon: { pid: process.pid, created: null },
    supervisor: { pid: supervisorPid, created: null },
    agentProc: { pid: agentPid, created: null },
  };
  updateLedger((entries) => [...entries, entry]);
  let removed = false;
  daemonCreated ??= queryProcessesAsync([process.pid]).then((info) => info.get(process.pid)?.created ?? null);
  void Promise.all([daemonCreated, queryProcessesAsync([supervisorPid, agentPid])]).then(([created, info]) => {
    if (removed) return;
    updateLedger((entries) => entries.map((e) => e.id !== id ? e : {
      ...e,
      daemon: { ...e.daemon, created },
      supervisor: e.supervisor ? { ...e.supervisor, created: info.get(supervisorPid)?.created ?? null } : null,
      agentProc: { ...e.agentProc, created: info.get(agentPid)?.created ?? null },
    }));
  });
  return () => {
    if (removed) return;
    removed = true;
    updateLedger((entries) => entries.filter((e) => e.id !== id));
  };
}

// ---------- startup sweep ----------

export interface SweepReport {
  kind: "acp_orphan_killed" | "acp_orphan_skipped";
  agent: string;
  role: "supervisor" | "agent" | "entry";
  pid: number;
  reason: string;
}

/**
 * Run once after the port is bound and before the first ACP delivery. It is synchronous on purpose: nothing can
 * spawn a new agent until it returns. Only an entry whose daemon has exited is touched, and only processes whose
 * PID and exact creation time match (the watcher must also still be running acp-supervisor.mjs) are ended.
 */
export function sweepAcpOrphans(): SweepReport[] {
  if (!win || !ledger) return [];
  const entries = readLedger();
  if (!entries.length) return [];
  const pids = [...new Set(entries.flatMap((e) => [e.daemon?.pid, e.supervisor?.pid, e.agentProc?.pid]).filter((p): p is number => !!p))];
  const live = queryProcesses(pids);
  const reports: SweepReport[] = [];
  const keep: LedgerEntry[] = [];
  const report = (kind: SweepReport["kind"], e: LedgerEntry, role: SweepReport["role"], pid: number, reason: string) =>
    reports.push({ kind, agent: e.agent, role, pid, reason });
  const matches = (owned: Owned, info: ProcessInfo | undefined) => !!info && !!owned.created && info.created === owned.created;

  for (const e of entries) {
    if (!e.daemon?.pid || !e.agentProc?.pid) continue;
    if (path.resolve(e.project ?? "") !== ledger.project) {
      report("acp_orphan_skipped", e, "entry", e.agentProc.pid, "记录不属于本项目");
      continue;
    }
    const daemon = live.get(e.daemon.pid);
    // A live daemon with the recorded identity (or one we cannot tell apart) still owns its agents.
    if (daemon && (!e.daemon.created || daemon.created === e.daemon.created)) {
      report("acp_orphan_skipped", e, "entry", e.agentProc.pid, "记录它的守护进程仍在运行");
      keep.push(e);
      continue;
    }
    if (e.supervisor) {
      const info = live.get(e.supervisor.pid);
      if (info && matches(e.supervisor, info) && info.cmd.includes(SUPERVISOR_NAME)) {
        killTree(e.supervisor.pid);
        report("acp_orphan_killed", e, "supervisor", e.supervisor.pid, "监督进程身份核验通过");
      } else if (info) {
        report("acp_orphan_skipped", e, "supervisor", e.supervisor.pid, "PID 已被其他进程使用");
      }
    }
    const info = live.get(e.agentProc.pid);
    if (info && matches(e.agentProc, info)) {
      killTree(e.agentProc.pid);
      report("acp_orphan_killed", e, "agent", e.agentProc.pid, "代理身份核验通过");
    } else if (info) {
      report("acp_orphan_skipped", e, "agent", e.agentProc.pid, e.agentProc.created ? "PID 已被其他进程使用" : "没有记录到创建时间，无法核验");
    }
  }
  writeLedger(keep);
  return reports;
}
