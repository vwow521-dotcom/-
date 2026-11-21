import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";

interface Fixture {
  root: string;
  base: string;
  codexEnv: Record<string, string>;
  startDaemon(project: string, wakeGrace: string, env: Record<string, string>): Promise<void>;
  stopDaemon(): Promise<void>;
  api(path: string, body?: object): Promise<{ status: number; json: any }>;
  state(): Promise<any>;
  call(client: Client, method: string, args: object): Promise<any>;
  check(ok: unknown, message: string): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, description: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await sleep(35);
  }
  throw new Error("ACP: " + description);
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function smokeAcp({ root, base, codexEnv, startDaemon, stopDaemon, api, state, call, check }: Fixture) {
  console.log("\nK. ACP background members");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-acp-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "bridge-smoke");
  git("config", "user.email", "bridge-smoke@example.invalid");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(project, "README.md"), "ACP fixture\n");
  git("add", "README.md");
  git("commit", "-qm", "init");

  const logs = { stdio: path.join(project, "stdio.jsonl"), http: path.join(project, "http.jsonl") };
  const methods = (agent: keyof typeof logs) => fs.existsSync(logs[agent])
    ? fs.readFileSync(logs[agent], "utf8").trim().split("\n").flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }) : [];
  const events = (agent: keyof typeof logs, kind: string) => methods(agent).filter((entry) => entry.event === kind);
  const command = process.execPath;
  const args = ["%BRIDGE_FIXTURE_AGENT%"];
  const acpEnv = (agent: keyof typeof logs) => ({
    BRIDGE_FIXTURE_AGENT: path.join(root, "scripts", "fake-acp-agent.mjs"),
    FAKE_ACP_LOG: logs[agent], FAKE_ACP_TURN_MS: "1200", FAKE_ACP_PERMISSIONS: "1",
    TMP: project, TEMP: project, TMPDIR: project,
  });
  fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: {
      stdio: { product: "antigravity", acp: { command: "%BRIDGE_FIXTURE_NODE%", args, mode: "accept-edits", permissions: "allow",
        env: { ...acpEnv("stdio"), BRIDGE_FIXTURE_NODE: command, FAKE_ACP_CRASH_AT: "4" } } },
      http: { product: "deepseek-harness", acp: { command, args, mcp: "http", permissions: "deny", env: acpEnv("http") } },
    },
    pipeline: [
      { id: "implement", role: "实现", agent: "stdio", owns: ["README.md"] },
      { id: "review", role: "审查", agent: "http", gate: true, on_reject: "implement" },
    ],
    wait: { poll_seconds: 3, stale_after_seconds: 1, offline_after_seconds: 90 },
    notify: { enabled: false },
  }));
  // Fixture telemetry stays out of the commits made by the pipeline.
  fs.appendFileSync(path.join(project, ".git", "info", "exclude"), "\n/*.jsonl*\n/bridge.config.yaml\n/ai-bridge/\n");
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: "smoke-ignored", CLAUDE_CODE_MESSAGING_TOKEN: "smoke-ignored",
    CLAUDE_CODE_ENTRYPOINT: "smoke-ignored", BRIDGE_ACP_RETRY_SECONDS: "0.9", GIT_OPTIONAL_LOCKS: "1" };
  const member = async (id: string) => (await state()).agents.find((a: any) => a.id === id);
  const chat = async (id: string, text: string) => (await api("/api/chat", { text: `@${id} ${text}` })).json.mail_ids[id];
  const hasFetched = (agent: keyof typeof logs, id: string) => events(agent, "fetched").some((row) => row.ids.includes(id));

  await startDaemon(project, "8", env);
  check((await member("stdio")).acp.state === "not_started" && !methods("stdio").length, "ACP workers are lazy");
  const interactive = new Client({ name: "antigravity-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  await interactive.connect(transport);
  try {
    const joined = await call(interactive, "join", {});
    check(joined.agent_id === "stdio" && joined.doorbell === "poll", "interactive Antigravity gets identity and poll instructions");
    const poll = call(interactive, "wait_for_mail", { agent_id: "stdio" });
    await until(async () => (await member("stdio")).status === "waiting", "interactive wait did not start");
    const polled = await chat("stdio", "deliver to active poll");
    check((await poll).mails.some((m: any) => m.id === polled) && !methods("stdio").length, "a blocked poll takes priority over ACP");
    const gapMail = await chat("stdio", "deliver in the gap between polls");
    check(!methods("stdio").length && (await member("stdio")).acp.state === "not_started", "a recent poll keeps priority between calls");
    const gap = await call(interactive, "wait_for_mail", { agent_id: "stdio" });
    check(gap.mails.some((m: any) => m.id === gapMail), "the next interactive poll fetches queued mail");
    await sleep(1050);

    check((await api("/api/runs", { goal: "ACP two-stage fixture" })).status === 200, "ACP pipeline starts");
    await until(() => events("stdio", "fetched").length, "stdio ACP did not fetch the task");
    const replaced = await call(interactive, "fetch_inbox", { agent_id: "stdio" });
    check(/后台会话正在处理/.test(replaced.error), "the ACP join automatically takes over an inactive interactive binding");
    const duringTurn = await member("stdio");
    check(duringTurn.acp.state === "running" && duringTurn.activity.state === "working", "ACP updates feed the member activity");
    const gate = await until(async () => {
      const snapshot = await state();
      return snapshot.run?.status === "awaiting_approval" ? snapshot : null;
    }, "stdio implementation and HTTP review did not reach approval");
    check(gate.handoffs.length === 2 && gate.handoffs.every((h: any) => !!h.commit_sha) && gate.handoffs[1].data.verdict === "approve"
      && git("rev-list", "--count", "HEAD") === "3", "stdio and HTTP both fetched, handed off, and created commits");
    check(events("stdio", "session/set_mode").some((row) => row.modeId === "accept-edits")
      && events("stdio", "mcp_connected")[0]?.name === "bridge_acp"
      && events("stdio", "joined")[0]?.doorbell === "acp" && events("http", "joined")[0]?.doorbell === "acp"
      && /不要调用 wait_for_mail/.test(events("http", "joined")[0]?.protocol ?? ""), "managed sessions get ACP identity and the configured mode");
    check(events("stdio", "decision")[0]?.outcome?.optionId === "allow" && events("http", "decision")[0]?.outcome?.optionId === "deny"
      && gate.events.filter((e: any) => e.kind === "acp_permission").length >= 2, "allow and deny select the correct option and record both decisions");
    check(["stdio", "http"].every((id) => {
      const row = events(id as keyof typeof logs, "environment")[0];
      return row?.doorbell === "acp" && row.bridgeAgent === id && !row.claudeKeys.length;
    }), "ACP environment supplies its own identity and strips every Claude variable");
    const output = (await member("stdio")).acp.output;
    check(output.length === 50 && output.at(-1) === "输出末行", "only the last 50 output lines are available in the panel");
    const review = gate.attempts.find((attempt: any) => attempt.status === "awaiting_approval");
    await api("/api/attempts/" + review.id + "/decide", { action: "approve" });
  } finally {
    await transport.terminateSession().catch(() => {});
    await interactive.close();
  }

  const initialSession = events("stdio", "session/prompt")[0].sessionId;
  const first = await chat("stdio", "first active turn");
  await until(() => hasFetched("stdio", first), "first chat was not fetched");
  const second = await chat("stdio", "queued while first turn is active");
  await sleep(50);
  check(events("stdio", "session/prompt").length === 2 && !hasFetched("stdio", second), "a busy ACP member does not get an overlapping prompt");
  await until(() => hasFetched("stdio", second), "ACP did not deliver the second chat after the turn ended");
  await until(async () => (await member("stdio")).acp.state === "ready", "follow-up turn did not finish");
  check(events("stdio", "session/prompt").length === 3 && events("stdio", "session/new").length === 1,
    "ACP sends one follow-up and reuses the long-lived session");

  const crashed = await chat("stdio", "retry after a crash");
  const retry = await until(async () => {
    const acp = (await member("stdio")).acp;
    return acp.state === "retrying" ? acp : null;
  }, "ACP crash did not enter backoff");
  check(!!retry.retryAt && /47/.test(retry.reason), "ACP crash reports its code and retry deadline");
  await until(() => hasFetched("stdio", crashed), "ACP did not recover and fetch after its backoff");
  const resumed = events("stdio", "session/resume")[0];
  check(resumed?.sessionId === initialSession && resumed.pid !== events("stdio", "session/new")[0].pid, "crash recovery resumes the same session in a new process");

  await until(async () => (await member("stdio")).acp.state === "ready", "resumed turn did not finish");
  await api("/api/runs", { goal: "cancel the running ACP task" });
  await until(async () => (await member("stdio")).doing.some((a: any) => a.status === "in_progress"), "ACP did not start the task to cancel");
  await api("/api/runs/stop", {});
  await until(() => events("stdio", "session/cancel").length, "ACP never received session/cancel");
  await until(async () => (await member("stdio")).acp.state === "ready", "cancelled ACP turn did not exit");
  check((await state()).events.some((event: any) => event.kind === "acp_turn_end" && event.text.includes("cancelled")),
    "stopping a run cancels its fetched ACP turn");

  const http = (await member("http")).acp;
  check((await api("/api/agents/http/acp/stop", {})).status === 200 && !alive(http.pid)
    && (await member("http")).acp.state === "stopped" && events("http", "session/close").length === 1,
    "stopping a background member closes its session and exits its process");
  check((await api("/api/agents/http/acp/restart", {})).status === 200
    && (await member("http")).acp.state === "ready" && events("http", "session/resume").length === 1,
    "restarting a member resumes its session inside the same daemon");
  const pids = [(await member("stdio")).acp.pid, (await member("http")).acp.pid];
  await stopDaemon();
  check(pids.every((pid) => pid && !alive(pid)) && events("stdio", "session/close").some((line) => line.pid === pids[0]),
    "daemon shutdown closes the ACP sessions and leaves no agent processes");

  await startDaemon(project, "8", env);
  const newHttp = await chat("http", "use fresh MCP after daemon restart");
  await until(() => hasFetched("http", newHttp), "HTTP worker did not fetch after daemon restart");
  const httpPrompts = events("http", "session/prompt");
  check(events("http", "session/new").length === 2 && events("http", "session/resume").length === 1
    && httpPrompts[0].sessionId !== httpPrompts.at(-1).sessionId, "HTTP starts a fresh ACP session after a daemon restart");
  await until(async () => (await member("http")).acp.state === "ready", "HTTP turn after restart did not finish");

  const before = { stdio: methods("stdio").length, http: methods("http").length };
  const doctor = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--probe", "--project", project], {
    cwd: root, env: { ...process.env, ...codexEnv, ...env, BRIDGE_URL: base }, encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  check(["stdio", "http"].every((id) => {
    const key = id as keyof typeof logs;
    const added = methods(key).slice(before[key]).filter((entry) => entry.event !== "environment");
    return added.length === 1 && added[0].event === "initialize" && !alive(added[0].pid);
  }) && /stdio：ACP fake-acp 1\.0\.0/.test(doctor) && /http：ACP fake-acp 1\.0\.0/.test(doctor),
  "doctor --probe reports ACP capabilities, sends only initialize, and exits both probes");
}
