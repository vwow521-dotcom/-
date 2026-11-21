// Windows process ownership for ACP agents. Node ends a dead daemon's direct children (kill-on-close job), but
// not what a non-Node agent such as agy started itself: those processes would keep running. Two layers:
//   1. a supervisor (bin/acp-supervisor.mjs) is each agent's parent and outlives the daemon. It holds the
//      agent's stdio, so when the daemon goes away it ends the agent's whole tree while the agent is still alive;
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
    "@(Get-CimInstance Win32_Process -ErrorAction Stop -Filter (($ids|ForEach-Object{\"ProcessId=$_\"}) -join ' or ')|" +
    "ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;created=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null});cmd=[string]$_.CommandLine}})" +
    "|ConvertTo-Json -Compress";
}

/** null when the answer cannot be read: that verifies nothing and must not be taken as "no such process". */
function parseProcesses(out: string): Map<number, ProcessInfo> | null {
  const map = new Map<number, ProcessInfo>();
  const text = out.trim();
  if (!text) return map;
  try {
    const parsed = JSON.parse(text) as ProcessInfo | ProcessInfo[];
    for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!Number.isInteger(row?.pid)) return null;
      map.set(row.pid, { pid: row.pid, created: row.created ?? null, cmd: row.cmd ?? "" });
    }
  } catch {
    return null;
  }
  return map;
}

const shellArgs = (pids: number[]) => ["-NoProfile", "-NonInteractive", "-Command", processScript(pids)];
export type ProcessQuery = (pids: number[]) => Map<number, ProcessInfo> | null;

/**
 * Live processes among `pids`, with their exact creation time and command line (Windows only). A PID missing
 * from the map is reliably gone; null means the query itself failed and nothing is known.
 */
export const queryProcesses: ProcessQuery = (pids) => {
  if (!win || !pids.some((pid) => pid > 0)) return new Map();
  try {
    return parseProcesses(execFileSync("powershell.exe", shellArgs(pids),
      { encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
};

export function queryProcessesAsync(pids: number[]): Promise<Map<number, ProcessInfo> | null> {
  if (!win || !pids.some((pid) => pid > 0)) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile("powershell.exe", shellArgs(pids), { encoding: "utf8", windowsHide: true, timeout: 20_000 },
      (error, out) => resolve(error ? null : parseProcesses(out)));
  });
}

export type TreeKill = (pid: number) => boolean;
const killTree: TreeKill = (pid) => {
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// ---------- ledger ----------

let ledger: { file: string; project: string } | undefined;
let daemonCreated: Promise<string | null> | undefined;
const ownCreated = () => queryProcessesAsync([process.pid]).then((info) => info?.get(process.pid)?.created ?? null);

/** The daemon calls this once at startup. Without it (doctor --probe), agents are supervised but not recorded. */
export function configureAcpLedger(file: string, project: string) {
  ledger = { file, project: path.resolve(project) };
  daemonCreated = ownCreated();
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

/** Returns false when the ledger could not be written; callers that depend on the record must not proceed. */
function writeLedger(entries: LedgerEntry[]) {
  if (!ledger) return false;
  const tmp = `${ledger.file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(ledger.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
    fs.renameSync(tmp, ledger.file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

function updateLedger(change: (entries: LedgerEntry[]) => LedgerEntry[]) {
  return !!ledger && writeLedger(change(readLedger()));
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
 * Record a supervised agent in the ledger as soon as its PID is known, then fill in the exact creation times of
 * the daemon, the supervisor and the agent. AcpRpc sends no ACP traffic until this resolves, so the agent cannot
 * start working before the ledger can identify it. Rejects (and drops the entry) when the identity cannot be
 * captured after one retry. Resolves to the function that removes the entry when the agent exits.
 */
export async function recordAcpProcess(agent: string, command: string, supervisorPid: number, agentPid: number): Promise<() => void> {
  if (!ledger) return () => {};
  const id = randomUUID();
  const remove = () => { updateLedger((entries) => entries.filter((e) => e.id !== id)); };
  const written = updateLedger((entries) => [...entries, {
    id, agent, project: ledger!.project, command, at: new Date().toISOString(),
    daemon: { pid: process.pid, created: null },
    supervisor: { pid: supervisorPid, created: null },
    agentProc: { pid: agentPid, created: null },
  }]);
  if (!written) throw new Error(`无法写入后台进程台账：${ledger.file}`);
  let created = await (daemonCreated ??= ownCreated());
  if (!created) created = await (daemonCreated = ownCreated());
  const complete = (info: Map<number, ProcessInfo> | null) => !!info?.get(supervisorPid)?.created && !!info.get(agentPid)?.created;
  let info = await queryProcessesAsync([supervisorPid, agentPid]);
  if (!complete(info)) info = await queryProcessesAsync([supervisorPid, agentPid]);
  if (!created || !complete(info)) {
    remove();
    throw new Error("无法记录后台进程的精确身份（进程查询失败）");
  }
  const identity = {
    daemon: { pid: process.pid, created },
    supervisor: { pid: supervisorPid, created: info!.get(supervisorPid)!.created },
    agentProc: { pid: agentPid, created: info!.get(agentPid)!.created },
  };
  updateLedger((entries) => entries.map((e) => e.id !== id ? e : { ...e, ...identity }));
  // Open the gate only once the complete record can be read back from disk.
  const stored = readLedger().find((e) => e.id === id);
  if (stored?.daemon.created !== identity.daemon.created || stored?.supervisor?.created !== identity.supervisor.created
    || stored?.agentProc.created !== identity.agentProc.created) {
    remove();
    throw new Error(`无法写入后台进程台账：${ledger.file}`);
  }
  return remove;
}

// ---------- startup sweep ----------

export interface SweepReport {
  kind: "acp_orphan_killed" | "acp_orphan_skipped";
  agent: string;
  role: "supervisor" | "agent" | "entry";
  pid: number;
  reason: string;
}

type Identity = "gone" | "match" | "other" | "unknown";

/** gone: reliably not running. match: same PID and exact creation time. other: the PID now belongs to another
 * process. unknown: running, but the identity cannot be confirmed (no recorded or no readable creation time). */
function identify(owned: Owned, live: Map<number, ProcessInfo>): Identity {
  const info = live.get(owned.pid);
  if (!info) return "gone";
  if (!owned.created || !info.created) return "unknown";
  return info.created === owned.created ? "match" : "other";
}

/**
 * Run once after the port is bound and before the first ACP delivery. It is synchronous on purpose: nothing can
 * spawn a new agent until it returns. An entry is acted on only when its daemon is proven gone (not running, or
 * its PID now belongs to another process). A process is ended only when its PID and exact creation time match
 * (the supervisor must also still be running acp-supervisor.mjs), and an end counts only once a fresh query
 * confirms it. Whatever cannot be confirmed stays in the ledger for the next start.
 * `deps` replaces the process query and taskkill in tests.
 */
export function sweepAcpOrphans(deps: { query?: ProcessQuery; kill?: TreeKill } = {}): SweepReport[] {
  const query = deps.query ?? queryProcesses;
  const kill = deps.kill ?? killTree;
  if (!ledger || (!win && !deps.query)) return [];
  const entries = readLedger();
  if (!entries.length) return [];
  const reports: SweepReport[] = [];
  const report = (kind: SweepReport["kind"], e: LedgerEntry, role: SweepReport["role"], pid: number, reason: string) =>
    reports.push({ kind, agent: e.agent, role, pid, reason });
  const pids = [...new Set(entries.flatMap((e) => [e.daemon?.pid, e.supervisor?.pid, e.agentProc?.pid]).filter((p): p is number => !!p))];
  const first = query(pids);
  if (!first) {
    for (const e of entries) report("acp_orphan_skipped", e, "entry", e.agentProc?.pid ?? 0, "无法查询进程，保留记录待下次启动");
    return reports;
  }
  let live: Map<number, ProcessInfo> = first;
  const keep: LedgerEntry[] = [];

  /** End one verified process tree, then confirm with a fresh query. Returns false when it may still be running. */
  const end = (e: LedgerEntry, role: "supervisor" | "agent", owned: Owned, reason: string) => {
    kill(owned.pid);
    const checked = [...new Set([owned.pid, e.agentProc.pid])];
    const after = query(checked);
    if (!after) {
      report("acp_orphan_skipped", e, role, owned.pid, "结束后无法复核，保留记录");
      return false;
    }
    live = new Map([...[...live].filter(([pid]) => !checked.includes(pid)), ...after]);
    // Only "gone" or "other" proves the end. A PID still listed whose creation time cannot be read is unconfirmed.
    const now = identify(owned, live);
    if (now === "match" || now === "unknown") {
      report("acp_orphan_skipped", e, role, owned.pid, now === "match" ? "结束失败，保留记录" : "结束后身份无法核实，保留记录");
      return false;
    }
    report("acp_orphan_killed", e, role, owned.pid, reason);
    return true;
  };

  for (const e of entries) {
    if (!e.daemon?.pid || !e.agentProc?.pid) continue;
    // The project must be stated, absolute and this one. Anything else cannot be verified and is only reported.
    if (typeof e.project !== "string" || !path.isAbsolute(e.project) || path.resolve(e.project) !== ledger.project) {
      report("acp_orphan_skipped", e, "entry", e.agentProc.pid, "记录没有写明本项目目录，保留记录");
      keep.push(e);
      continue;
    }
    const daemon = identify(e.daemon, live);
    if (daemon === "match" || daemon === "unknown") {
      report("acp_orphan_skipped", e, "entry", e.agentProc.pid,
        daemon === "match" ? "记录它的守护进程仍在运行" : "无法确认原守护进程已退出，保留记录");
      keep.push(e);
      continue;
    }
    let pending = false;
    if (e.supervisor) {
      const state = identify(e.supervisor, live);
      if (state === "unknown") {
        report("acp_orphan_skipped", e, "supervisor", e.supervisor.pid, "身份无法核实，保留记录");
        pending = true;
      } else if (state === "other" || (state === "match" && !live.get(e.supervisor.pid)!.cmd.includes(SUPERVISOR_NAME))) {
        report("acp_orphan_skipped", e, "supervisor", e.supervisor.pid, "PID 已被其他进程使用");
      } else if (state === "match" && !end(e, "supervisor", e.supervisor, "监督进程身份核验通过")) {
        // The supervisor's end was not confirmed (or the re-check failed, so `live` may be stale): leave the agent
        // for the next start rather than act on an old snapshot.
        report("acp_orphan_skipped", e, "agent", e.agentProc.pid, "监督进程未确认结束，代理留待下次核验");
        keep.push(e);
        continue;
      }
    }
    // `live` holds the fresh answer after the supervisor's tree was ended, so a gone agent is not ended twice.
    const state = identify(e.agentProc, live);
    if (state === "unknown") {
      report("acp_orphan_skipped", e, "agent", e.agentProc.pid, e.agentProc.created ? "身份无法核实，保留记录" : "没有记录到创建时间，保留记录");
      pending = true;
    } else if (state === "other") {
      report("acp_orphan_skipped", e, "agent", e.agentProc.pid, "PID 已被其他进程使用");
    } else if (state === "match" && !end(e, "agent", e.agentProc, "代理身份核验通过")) {
      pending = true;
    }
    if (pending) keep.push(e);
  }
  writeLedger(keep);
  return reports;
}
