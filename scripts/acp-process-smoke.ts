// Windows ACP process ownership: the watcher (bin/acp-supervisor.mjs), the ledger (.bridge/acp-hosts.json)
// and the startup sweep. Runs its own daemons on a temporary project.
//   node --import tsx scripts/acp-process-smoke.ts        (standalone, port SMOKE_ACP_PROCESS_PORT or 7893)
// scripts/smoke.ts can call smokeAcpProcess() with its own check().
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { configureAcpLedger, queryProcesses, readLedger, sweepAcpOrphans, type LedgerEntry, type ProcessInfo } from "../src/doorbells/acp-process.js";

interface Options {
  root: string;
  port: number;
  check(ok: unknown, message: string): void;
  info?(message: string): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
const forceKill = (pid: number | undefined, tree = false) => {
  if (!pid) return;
  try { execFileSync("taskkill.exe", ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
};
async function until<T>(read: () => T | Promise<T>, description: string, ms = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error("ACP process: " + description);
}
function sleeper() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", windowsHide: true });
  return child;
}
/** Supervisors still running for this fixture's fake agent. */
function supervisors() {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*acp-supervisor.mjs*fake-acp-process.mjs*' }).Count`],
  { encoding: "utf8", windowsHide: true });
  return Number(out.trim());
}

/** The sweep's decisions with a simulated process table: no real process is touched. */
function sweepDecisions(check: Options["check"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-acp-sweep-"));
  const file = path.join(dir, "acp-hosts.json");
  configureAcpLedger(file, dir);
  const t = (n: number) => `2026-01-01T00:00:0${n}.0000000Z`;
  const proc = (pid: number, created: string | null, cmd = "agent.exe"): [number, ProcessInfo] => [pid, { pid, created, cmd }];
  const entry = (fields: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: "e" + Math.random(), agent: "w", project: dir, command: "agent.exe", at: t(0),
    daemon: { pid: 10, created: t(1) }, supervisor: { pid: 20, created: t(2) }, agentProc: { pid: 30, created: t(3) }, ...fields,
  });
  const run = (entries: LedgerEntry[], world: Map<number, ProcessInfo> | null,
    onKill: (pid: number, world: Map<number, ProcessInfo>) => void = (pid, w) => { w.delete(pid); }) => {
    fs.writeFileSync(file, JSON.stringify(entries));
    const kills: number[] = [];
    const reports = sweepAcpOrphans({
      query: (pids) => world && new Map([...world].filter(([pid]) => pids.includes(pid))),
      kill: (pid) => { kills.push(pid); if (world) onKill(pid, world); return true; },
    });
    return { reports, kills, kept: readLedger(file) };
  };
  const supervisorCmd = "node acp-supervisor.mjs 10 agent.exe";

  let r = run([entry()], null);
  check(r.kept.length === 1 && !r.kills.length && r.reports.every((x) => x.kind === "acp_orphan_skipped"),
    "sweep: a failed process query ends nothing and keeps the ledger");
  r = run([entry()], new Map([proc(10, null), proc(30, t(3))]));
  check(r.kept.length === 1 && !r.kills.length, "sweep: a running daemon PID whose creation time cannot be read is not treated as exited");
  r = run([entry({ daemon: { pid: 10, created: null } })], new Map([proc(10, t(9)), proc(30, t(3))]));
  check(r.kept.length === 1 && !r.kills.length, "sweep: an entry without the daemon's creation time is kept while that PID runs");
  r = run([entry({ supervisor: null })], new Map([proc(30, t(3))]), () => {});
  check(r.kept.length === 1 && r.kills.length === 1 && !r.reports.some((x) => x.kind === "acp_orphan_killed"),
    "sweep: a taskkill that leaves the agent running is not reported as ended and the entry is kept");
  r = run([entry()], new Map([proc(20, t(2), supervisorCmd), proc(30, t(3))]), (pid, w) => { w.delete(pid); w.delete(30); });
  check(r.kept.length === 0 && r.kills.join() === "20" && r.reports.filter((x) => x.kind === "acp_orphan_killed").length === 1,
    "sweep: after the supervisor's tree is ended, a fresh query shows the agent gone and it is not ended again");
  r = run([entry()], new Map([proc(20, t(2), supervisorCmd), proc(30, t(3))]));
  check(r.kept.length === 0 && r.kills.join() === "20,30", "sweep: an agent still running after its supervisor's tree is re-verified and then ended");
  r = run([entry()], new Map([proc(20, t(2), supervisorCmd), proc(30, t(7))]));
  check(r.kills.join() === "20" && r.kept.length === 0, "sweep: an agent PID now owned by another process is not ended");
}

export async function smokeAcpProcess({ root, port, check, info = console.log }: Options) {
  console.log("\nL. Windows ACP process ownership");
  sweepDecisions(check);
  if (process.platform !== "win32") {
    info("skipped: Windows only");
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-acp-proc-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
  git("init", "-q");
  const logs = { w: path.join(project, "w.jsonl"), x: path.join(project, "x.jsonl"), y: path.join(project, "y.jsonl") };
  const ledgerFile = path.join(project, ".bridge", "acp-hosts.json");
  const fake = path.join(root, "scripts", "fake-acp-process.mjs");
  const agent = (env: Record<string, string>) => ({
    product: "antigravity", acp: { command: process.execPath, args: [fake], permissions: "deny", env: { FAKE_PROC_LEDGER: ledgerFile, ...env } },
  });
  fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: {
      w: agent({ FAKE_PROC_LOG: logs.w }),
      x: agent({ FAKE_PROC_LOG: logs.x, FAKE_PROC_EXIT_ON_PROMPT: "1" }),
      y: agent({ FAKE_PROC_LOG: logs.y, FAKE_PROC_EXIT_ON_EOF: "1" }),
    },
    pipeline: [{ id: "implement", role: "实现", agent: "w" }],
    notify: { enabled: false },
  }));
  const rows = (id: keyof typeof logs) => fs.existsSync(logs[id])
    ? fs.readFileSync(logs[id], "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const started = (id: keyof typeof logs) => rows(id).filter((row) => row.event === "started");
  const leftovers = new Set<number>();
  const sleepers: ChildProcess[] = [];

  let daemon: ChildProcess | undefined;
  let output = "";
  async function startDaemon() {
    output = "";
    const child = daemon = spawn(process.execPath, ["--import", "tsx", "src/daemon.ts", "--project", project, "--port", String(port)], {
      cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
      env: { ...process.env, BRIDGE_NOTIFY: "0", BRIDGE_WAKE_GRACE_SECONDS: "120" },
    });
    child.stdout!.on("data", (d) => { output += d; });
    child.stderr!.on("data", (d) => { output += d; });
    await until(async () => {
      if (child.exitCode !== null) throw new Error("daemon exited early:\n" + output);
      try { return (await fetch(base + "/api/state")).ok; } catch { return false; }
    }, "daemon did not start");
    return child;
  }
  async function stopDaemon() {
    const child = daemon;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.send("shutdown");
    await Promise.race([exited, sleep(15_000).then(() => child.kill())]);
  }
  const api = async (route: string, body?: object) => {
    const response = await fetch(base + route, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    return response.json();
  };
  const state = () => api("/api/state");
  /** Wake `id` and wait for a new agent process and its ledger entry (with exact creation times). */
  // A daemon restart re-rings unread mail, so the agent may already be starting. Take the first new live one.
  async function launch(id: keyof typeof logs, live = true) {
    await api("/api/chat", { text: `@${id} 启动后台` });
    return newAgent(id, live);
  }
  async function newAgent(id: keyof typeof logs, live = true) {
    const row = await until(() => started(id).find((r) => !leftovers.has(r.pid) && (!live || alive(r.pid))), `${id} did not start a new agent`);
    leftovers.add(row.pid).add(row.child);
    return row as { pid: number; child: number };
  }
  async function recorded(pid: number) {
    return until(() => {
      const entry = readLedger(ledgerFile).find((e) => e.agentProc.pid === pid);
      return entry && entry.agentProc.created && entry.daemon.created && entry.supervisor?.created ? entry : null;
    }, `ledger has no complete entry for ${pid}`);
  }

  try {
    // (a) Force-kill only the daemon (taskkill /F without /T). Windows would end its direct children anyway, but
    // the fake agent's child is detached, like what agy starts itself; only the supervisor can still reach it.
    // y exits as soon as it sees stdin EOF: it must not see one before its supervisor has ended its tree.
    const first = await startDaemon();
    const a = await launch("w");
    const y = await launch("y");
    const entryA = await recorded(a.pid);
    const entryY = await recorded(y.pid);
    check(alive(entryA.supervisor!.pid) && supervisors() === 2, "each ACP agent runs under one supervisor and has a ledger entry with exact creation times");
    check([...rows("w"), ...rows("y")].filter((row) => row.event === "identity").every((row) => row.recorded)
      && rows("w").some((row) => row.event === "identity"), "the ledger holds the exact identity before the agent receives initialize");
    forceKill(first.pid);
    await until(() => first.exitCode !== null || first.signalCode !== null || !alive(first.pid), "daemon was not killed");
    const goneA = await until(() => !alive(a.pid) && !alive(a.child) && !alive(entryA.supervisor!.pid), "agent tree outlived a force-killed daemon", 5000).catch(() => false);
    check(goneA, "force-killing the daemon ends the agent, the process it started and the supervisor within 5 s");
    const goneY = await until(() => !alive(y.pid) && !alive(y.child) && !alive(entryY.supervisor!.pid), "EOF-exiting agent left its process", 5000).catch(() => false);
    check(goneY && !rows("y").some((row) => row.event === "stdin_end"),
      "an agent that exits on stdin EOF is ended with its process before it can see EOF");

    // (b) An agent outlived both its supervisor and its daemon (forged: an unsupervised fake agent in the ledger).
    const orphanLog = path.join(project, "orphan.jsonl");
    const orphan = spawn(process.execPath, [fake], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: true, env: { ...process.env, FAKE_PROC_LOG: orphanLog } });
    const orphanRow = await until(() => fs.existsSync(orphanLog) && JSON.parse(fs.readFileSync(orphanLog, "utf8").split("\n")[0]), "orphan fixture did not start");
    leftovers.add(orphanRow.pid).add(orphanRow.child);
    // (c) Entries that must not be acted on, and an unrelated node.exe that is in no entry.
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => dead.once("exit", resolve));
    const wrongTime = sleeper(), wrongCmd = sleeper(), unrelated = sleeper();
    sleepers.push(wrongTime, wrongCmd, unrelated);
    await sleep(300);
    const created = queryProcesses([orphan.pid!, wrongCmd.pid!]) ?? new Map<number, ProcessInfo>();
    check(!!created.get(orphan.pid!)?.created && !!created.get(wrongCmd.pid!)?.created, "precondition: exact creation times can be read");
    const old = "2000-01-01T00:00:00.0000000Z";
    const forged = (fields: Partial<LedgerEntry>): LedgerEntry => ({
      id: "forged-" + Math.random(), agent: "w", project, command: process.execPath, at: new Date().toISOString(),
      daemon: { pid: dead.pid!, created: old }, supervisor: { pid: dead.pid!, created: old },
      agentProc: { pid: dead.pid!, created: old }, ...fields,
    });
    const ledger = readLedger(ledgerFile);
    ledger.push(
      forged({ agentProc: { pid: orphan.pid!, created: created.get(orphan.pid!)!.created } }),
      forged({ agentProc: { pid: wrongTime.pid!, created: old } }),
      forged({ supervisor: { pid: wrongCmd.pid!, created: created.get(wrongCmd.pid!)!.created } }),
    );
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));

    await startDaemon();
    check(!alive(orphan.pid) && !alive(orphanRow.child), "the startup sweep ends a recorded orphan agent and the process it started");
    check(alive(wrongTime.pid) && alive(wrongCmd.pid) && alive(unrelated.pid),
      "a PID with a different creation time, a process that is not the supervisor, and an unrelated node.exe are left alone");
    const events = (await state()).events as { kind: string; text: string }[];
    check(events.some((e) => e.kind === "acp_orphan_killed" && e.text.includes(String(orphan.pid)))
      && events.filter((e) => e.kind === "acp_orphan_skipped").length >= 2, "the sweep records what it ended and what it skipped");
    // The restarted daemon may already have spawned a new agent for unread mail; only its own entries may remain.
    check(readLedger(ledgerFile).every((entry) => entry.daemon.pid === daemon!.pid), "the sweep clears the entries it handled");

    // (d) Normal stop, restart and daemon shutdown still end the whole tree and clear the ledger.
    const d = await launch("w");
    const entryD = await recorded(d.pid);
    await api("/api/agents/w/acp/stop", {});
    await until(() => !alive(d.pid) && !alive(d.child) && !alive(entryD.supervisor!.pid), "stop did not end the agent tree", 8000);
    check(!readLedger(ledgerFile).some((e) => e.agentProc.pid === d.pid), "stopping a member ends its tree and supervisor and removes its entry");
    await api("/api/agents/w/acp/restart", {});
    const r = await newAgent("w");
    const entryR = await recorded(r.pid);

    // (e) The agent's root exits on its own and leaves a child: record what happens to that child.
    const e = await launch("x", false);
    await until(() => !alive(e.pid), "x did not exit on its prompt");
    await sleep(2500);
    info(alive(e.child)
      ? `     known limit: when the agent's root exits by itself, a process it started outside Node's job (PID ${e.child}) keeps running; taskkill /T can no longer reach it`
      : "     the process started by an agent whose root exited was also ended");
    check(!readLedger(ledgerFile).some((entry) => entry.agentProc.pid === e.pid), "the supervisor exits with its agent and the entry is removed");
    forceKill(e.child);
    await api("/api/agents/x/acp/stop", {});

    const last = daemon!;
    await stopDaemon();
    check(last.exitCode === 0 && !alive(r.pid) && !alive(r.child) && !alive(entryR.supervisor!.pid),
      "daemon shutdown ends the agent tree and its supervisor");
    check(readLedger(ledgerFile).length === 0, "a clean shutdown leaves an empty ledger");

    const before = rows("w").length;
    const beforeX = rows("x").length;
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--probe", "--project", project],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    const added = rows("w").slice(before);
    const probe = added.find((row) => row.event === "started");
    if (probe) leftovers.add(probe.pid).add(probe.child);
    for (const row of rows("x").slice(beforeX)) if (row.event === "started") leftovers.add(row.pid).add(row.child);
    await sleep(500);
    check(!!probe && added.filter((row) => row.event === "method").every((row) => row.method === "initialize")
      && !alive(probe.pid) && !alive(probe.child) && supervisors() === 0,
    "doctor --probe still sends only initialize and leaves no agent, child or supervisor");
  } finally {
    await stopDaemon().catch(() => {});
    if (daemon && daemon.exitCode === null) forceKill(daemon.pid, true);
    for (const pid of leftovers) forceKill(pid, true);
    for (const s of sleepers) forceKill(s.pid);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let failed = 0;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const check = (ok: unknown, message: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
    if (!ok) failed++;
  };
  try {
    await smokeAcpProcess({ root, port: Number(process.env.SMOKE_ACP_PROCESS_PORT ?? 7893), check });
  } catch (error) {
    console.error(error);
    failed++;
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nACP process smoke passed");
  process.exit(failed ? 1 : 0);
}
