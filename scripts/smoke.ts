// End-to-end check of the bridge (M2b postman). Spawns its own daemon(s) against a throwaway git project.
//   npm run smoke
// A: pipeline over mail with the poll fallback (wait_for_mail), gates, ask_human-as-mail, human mail, dedupe, restart.
// B: stdio proxy as Claude doorbell, writing into a fake CLAUDE_CODE_MESSAGING_SOCKET named pipe.
// C: Codex Stop hook doorbell against fake transcripts.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = Number(process.env.SMOKE_PORT ?? 7891);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.cwd();
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-"));
const sh = (...args: string[]) => execFileSync("git", ["-C", proj, ...args], { encoding: "utf8" }).trim();
sh("init", "-q");
sh("config", "user.name", "bridge-smoke");
sh("config", "user.email", "bridge-smoke@example.invalid");
sh("config", "core.autocrlf", "false");
fs.writeFileSync(path.join(proj, "README.md"), "smoke\n");
sh("add", "-A");
sh("commit", "-qm", "init");
fs.writeFileSync(
  path.join(proj, "bridge.config.yaml"),
  `agents: { claude: {}, codex: {}, pbot: {}, hbot: {}, hbot2: {}, hbot3: { doorbell: codex-hook } }
pipeline:
  - { id: plan, role: 规划, agent: claude, gate: true, owns: [DESIGN.md] }
  - { id: implement, role: 编码, agent: codex }
  - { id: review, role: 审查, agent: claude, gate: true, on_reject: implement }
wait: { poll_seconds: 2, stale_after_seconds: 30, offline_after_seconds: 60 }
mail: { ring_retry_seconds: 3 }
notify: { enabled: false }
`,
);

let daemon: ChildProcess;
async function startDaemon() {
  daemon = spawn(process.execPath, ["--import", "tsx", "src/daemon.ts", "--project", proj, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BRIDGE_NOTIFY: "0" },
  });
  let out = "";
  daemon.stdout!.on("data", (d) => (out += d));
  daemon.stderr!.on("data", (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    if (out.includes("面板:")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("daemon did not start:\n" + out);
}
async function stopDaemon() {
  const exited = new Promise((r) => daemon.once("exit", r));
  daemon.kill();
  await exited;
}

async function connect(name: string) {
  const c = new Client({ name: `smoke-${name}`, version: "0.0.1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return JSON.parse(r.content[0].text);
}
const api = async (p: string, body?: unknown) => {
  const r = await fetch(BASE + p, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const state = async () => (await api("/api/state")).json;
let failed = false;
function check(cond: unknown, msg: string) {
  console.log(cond ? "ok  " : "FAIL", msg);
  if (!cond) failed = true;
}
const write = (f: string, s: string) => fs.writeFileSync(path.join(proj, f), s);
const task = (r: any) => r.mails?.find((m: any) => m.kind === "task" && !m.void)?.task;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runHook(stdin: object, env: Record<string, string>): Promise<{ out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(ROOT, "bin/codex-stop-hook.mjs")], { env: { ...process.env, BRIDGE_URL: BASE, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => resolve({ out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(stdin));
  });
}

try {
  await startDaemon();

  // ===== A: mail flow with the poll fallback =====
  console.log("— A: pipeline over mail (poll fallback)");
  let claude = await connect("claude");
  const codex = await connect("codex");
  const imposter = await connect("imposter");
  const j = await call(claude, "join", { agent_id: "claude" });
  check(j.roles?.length === 2 && j.doorbell === "poll", "claude joined, no doorbell → poll");
  check(!(await call(codex, "join", { agent_id: "codex" })).error, "codex joined");
  check((await call(imposter, "join", { agent_id: "claude" })).error, "duplicate identity rejected");
  check((await call(claude, "fetch_inbox", { agent_id: "claude" })).mails.length === 0, "empty inbox");
  check((await call(claude, "wait_for_mail", { agent_id: "claude" })).status === "keep_waiting", "idle wait_for_mail → keep_waiting");

  const claudeWait = call(claude, "wait_for_mail", { agent_id: "claude" });
  check((await api("/api/runs", { goal: "做一个 hello 程序" })).status === 200, "run started");
  check((await api("/api/runs", { goal: "again" })).status === 409, "second start rejected while open");
  let t = task(await claudeWait);
  check(t?.stage?.id === "plan" && t.stage.needs_approval, "blocked wait_for_mail woken with plan task");
  write("DESIGN.md", "# hello\nprint hello\n");
  await call(claude, "post_note", { agent_id: "claude", topic: "约定", text: "用 node 写" });
  let sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "写了设计", files_changed: ["DESIGN.md"], notes_for_next: "按 DESIGN.md 实现" });
  check(sub.status === "submitted" && /^[0-9a-f]{40}$/.test(sub.commit), "plan handoff auto-committed");
  let s = await state();
  check(s.run.status === "awaiting_approval", "run waits at plan gate");
  check(s.mail.find((m: any) => m.kind === "task" && m.to === "claude")?.status === "acked", "task mail auto-acked by submit_handoff");

  const codexWait = call(codex, "wait_for_mail", { agent_id: "codex" });
  await api(`/api/attempts/${s.live.id}/decide`, { action: "approve", note: "输出要带感叹号" });
  t = task(await codexWait);
  check(
    t?.stage.id === "implement" && t.feedback?.kind === "approval_note" && t.feedback.user_requirements[0].includes("感叹号") && t.input_handoff?.summary === "写了设计",
    "codex woken with implement task + structured approval note",
  );

  const asked = await call(codex, "ask_human", { agent_id: "codex", question: "用 console.log 吗？" });
  check(asked.status === "submitted", "ask_human returns immediately");
  s = await state();
  check(s.questions.length === 1, "question visible on panel");
  const ansWait = call(codex, "wait_for_mail", { agent_id: "codex" });
  await api(`/api/questions/${s.questions[0].id}/answer`, { answer: "是" });
  const ans = await ansWait;
  check(ans.mails?.some((m: any) => m.kind === "answer" && m.body.includes("是")), "answer arrives as mail");

  await api("/api/mail", { to: "codex", text: "顺便加个注释" });
  const inbox = await call(codex, "fetch_inbox", { agent_id: "codex" });
  const hm = inbox.mails.find((m: any) => m.kind === "human");
  check(hm?.ack_required && hm.body.includes("加个注释"), "human panel message delivered, ack required");
  await call(codex, "ack", { agent_id: "codex", mail_ids: [hm.id] });
  check((await state()).mail.find((m: any) => m.id === hm.id).status === "acked", "human mail acked");

  const d1 = await call(codex, "send_mail", { agent_id: "codex", to: "claude", subject: "提醒", body: "x", mail_id: "dup-1" });
  const d2 = await call(codex, "send_mail", { agent_id: "codex", to: "claude", subject: "提醒", body: "x", mail_id: "dup-1" });
  check(d1.duplicate === false && d2.duplicate === true, "same mail_id is delivered once (dedupe)");

  write("hello.js", "console.log('hello')\n");
  write("extra.txt", "not declared\n");
  sub = await call(codex, "submit_handoff", { agent_id: "codex", summary: "实现 v1", files_changed: ["hello.js"] });
  check(sub.next === "claude/review", "implement → review");
  s = await state();
  check(s.handoffs.at(-1).scope_notes.some((n: string) => n.includes("extra.txt")), "undeclared changed file flagged in scope notes");

  let cm = await call(claude, "fetch_inbox", { agent_id: "claude" });
  t = task(cm);
  check(t?.stage.id === "review" && cm.mails.some((m: any) => m.id === "dup-1"), "claude gets review task and codex's note");
  const ctx = await call(claude, "get_context", { agent_id: "claude", last_n: 1 });
  check(
    ctx.handoffs_total === 2 && ctx.recent_handoffs.length === 1 && ctx.older_handoffs.length === 1 && ctx.notes.some((n: any) => n.text === "用 node 写"),
    "get_context returns only the last N handoffs in full",
  );
  sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "缺感叹号", verdict: "reject", review_comments: ["输出没有感叹号"], observations: ["变量名可以更清楚"] });
  check(/^[0-9a-f]{40}$/.test(sub.commit), "review with no file changes still gets an (empty) commit");
  s = await state();
  await api(`/api/attempts/${s.live.id}/decide`, { action: "reject", note: "按审查意见改" });
  t = task(await call(codex, "wait_for_mail", { agent_id: "codex" }));
  check(
    t?.stage.id === "implement" && t.feedback.kind === "rework" && t.feedback.user_requirements[0] === "按审查意见改" &&
      t.feedback.blocking[0] === "输出没有感叹号" && t.feedback.observations[0] === "变量名可以更清楚",
    "rework feedback split into user requirements / blocking / observations",
  );
  write("hello.js", "console.log('hello!')\n");
  write("DESIGN.md", "# hello\nprint hello!\n");
  await call(codex, "submit_handoff", { agent_id: "codex", summary: "加了感叹号", files_changed: ["hello.js", "DESIGN.md"] });
  s = await state();
  check(s.handoffs.at(-1).scope_notes.some((n: string) => n.includes("plan") && n.includes("DESIGN.md")), "touching another stage's file flagged");
  t = task(await call(claude, "wait_for_mail", { agent_id: "claude" }));
  check(t?.stage.id === "review" && t.feedback?.kind === "carried" && t.feedback.user_requirements[0] === "按审查意见改", "re-review carries this round's user requirements");
  await call(claude, "submit_handoff", { agent_id: "claude", summary: "通过", verdict: "approve" });
  s = await state();
  await api(`/api/attempts/${s.live.id}/decide`, { action: "approve", note: "" });
  s = await state();
  check(s.run.status === "done" && !s.live, "run done after final approval");
  const commits = sh("log", "--oneline").split("\n").filter((l) => l.includes("[bridge]"));
  check(commits.length === 5 && commits.some((c) => c.includes("审查通过")), `5 bridge commits incl. review conclusions (got ${commits.length})`);
  check(!sh("status", "--porcelain").includes(".bridge"), ".bridge/ is not tracked or dirty in git");
  check((await fetch(BASE + "/")).ok, "panel page served");

  await api("/api/runs", { goal: "第二个任务" });
  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.stage.id === "plan", "second run: claude takes plan");
  await stopDaemon();
  await startDaemon();
  s = await state();
  check(s.recentRuns.length === 2 && s.run.goal === "第二个任务", "runs persisted across restart");
  claude = await connect("claude-again");
  await call(claude, "join", { agent_id: "claude" });
  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.resumed === true && t.stage.id === "plan", "in-progress stage re-sent as mail after restart + rejoin");

  // Identity: a blocked join explains how to proceed; the panel can release; the agent can leave.
  const intruder = await connect("intruder");
  const blocked = await call(intruder, "join", { agent_id: "claude" });
  check(blocked.error && typeof blocked.auto_release_in_seconds === "number" && blocked.options?.length >= 2, "blocked join reports idle time, auto-release and options");
  check((await api("/api/agents/claude/release", {})).status === 200, "panel releases the identity");
  check((await call(claude, "fetch_inbox", { agent_id: "claude" })).error, "released session can no longer act");
  check(!(await call(intruder, "join", { agent_id: "claude" })).error, "new session joins without takeover after release");
  check(!(await call(intruder, "leave", { agent_id: "claude" })).error && !(await call(claude, "join", { agent_id: "claude" })).error, "leave frees it for the next session");
  await api("/api/runs/stop", {});

  // ===== B: stdio proxy as the Claude doorbell =====
  console.log("— B: stdio proxy → fake Claude messaging pipe");
  const pipePath = `\\\\.\\pipe\\bridge-smoke-${randomUUID()}`;
  const frames: any[] = [];
  const pipe = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        frames.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => pipe.listen(pipePath, r));
  const proxy = new Client({ name: "fake-claude", version: "0" });
  await proxy.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "bin/bridge-mcp.mjs")],
      env: { ...(process.env as Record<string, string>), BRIDGE_URL: BASE, CLAUDE_CODE_MESSAGING_SOCKET: pipePath, CLAUDE_CODE_MESSAGING_TOKEN: "tok-123" },
    }),
  );
  const tools = await proxy.listTools();
  check(tools.tools.some((x) => x.name === "fetch_inbox"), "proxy lists daemon tools");
  const pj = await call(proxy as Client, "join", { agent_id: "pbot" });
  check(pj.doorbell === "claude-socket", "join through proxy registers the claude-socket doorbell");
  await sleep(500);
  check((await state()).agents.find((a: any) => a.id === "pbot").doorbellArmed, "doorbell armed (proxy long-polling)");
  await api("/api/mail", { to: "pbot", text: "该干活了" });
  for (let i = 0; i < 40 && frames.length < 2; i++) await sleep(100);
  check(frames[0]?.type === "auth" && frames[0].token === "tok-123", "proxy authenticates on the messaging pipe");
  check(frames[1]?.type === "user" && /\[协作桥\].*fetch_inbox/.test(frames[1].message.content), "proxy injects a [协作桥] wake-up message");
  await sleep(300);
  check((await state()).mail.find((m: any) => m.to === "pbot").status === "rung", "mail marked rung");
  const pi = await call(proxy as Client, "fetch_inbox", { agent_id: "pbot" });
  check(pi.mails[0]?.body.includes("该干活了"), "agent fetches the mail through the proxy");
  await proxy.close();
  pipe.close();

  // ===== C: Codex Stop hook as the doorbell =====
  console.log("— C: Codex Stop hook");
  const tx = path.join(proj, "rollout.jsonl");
  const joinLine = (agent: string) =>
    JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "McpToolCall", server: "bridge", tool: "join", status: "completed", arguments: { agent_id: agent }, result: { content: [{ type: "text", text: JSON.stringify({ agent_id: agent, doorbell: "codex-hook" }) }] } } },
    });
  fs.writeFileSync(path.join(proj, "plain.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "user_message" } }) + "\n");
  let h = await runHook({ session_id: "s-plain", transcript_path: path.join(proj, "plain.jsonl") }, { BRIDGE_PARK_SECONDS: "20" });
  check(h.out === "{}" && h.ms < 3000, `thread that never joined is released immediately (${h.ms} ms)`);

  fs.writeFileSync(tx, joinLine("hbot") + "\n");
  const parked = runHook({ session_id: "s-1", transcript_path: tx }, { BRIDGE_PARK_SECONDS: "20" });
  await sleep(1500);
  s = await state();
  check(s.agents.find((a: any) => a.id === "hbot").doorbellArmed && s.codexThreads.some((x: any) => x.session_id === "s-1"), "joined thread parks and registers");
  await api("/api/mail", { to: "hbot", text: "新任务" });
  h = await parked;
  const hj = JSON.parse(h.out);
  check(hj.decision === "block" && /fetch_inbox/.test(hj.reason) && h.ms < 5000, `mail → block with wake-up reason (${h.ms} ms)`);

  // A fresh agent so the unfetched mail above (re-rung by the sweep) cannot interfere.
  const tx2 = path.join(proj, "rollout2.jsonl");
  fs.writeFileSync(tx2, joinLine("hbot2") + "\n");
  h = await runHook({ session_id: "s-2", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "2" });
  check(JSON.parse(h.out).reason?.includes("心跳"), "quiet park window → heartbeat block");
  h = await runHook({ session_id: "s-2", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "2", BRIDGE_HEARTBEAT: "0" });
  check(h.out === "{}", "heartbeat off → let Codex stop");

  // Nobody parked: the mail must not sit silently — after ring_retry_seconds it becomes "stuck".
  await api("/api/mail", { to: "hbot3", text: "没人在等" });
  await sleep(9000);
  s = await state();
  check(s.mail.find((m: any) => m.to === "hbot3")?.status === "stuck" && s.agents.find((a: any) => a.id === "hbot3").stuckMail === 1, "undeliverable mail → stuck + attention banner");

  // Bridge restart while Codex is parked: the hook rides it out and still delivers.
  const survivor = runHook({ session_id: "s-3", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "60", BRIDGE_DOWN_GRACE_SECONDS: "30" });
  await sleep(1500);
  await stopDaemon();
  await sleep(3000);
  await startDaemon();
  await sleep(4000); // hook retries every 2 s
  check((await state()).agents.find((a: any) => a.id === "hbot2").doorbellArmed, "parked hook re-armed after bridge restart");
  await api("/api/mail", { to: "hbot2", text: "重启后的信" });
  h = await survivor;
  check(JSON.parse(h.out).decision === "block", "mail after restart still wakes the parked Codex");

  // Bridge gone for good: after the grace period the hook lets Codex stop.
  const orphan = runHook({ session_id: "s-4", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "60", BRIDGE_DOWN_GRACE_SECONDS: "3" });
  await sleep(1500);
  await stopDaemon();
  h = await orphan;
  check(h.out === "{}" && h.ms < 15000, `bridge gone for good → Codex released after grace (${h.ms} ms)`);
  await startDaemon();
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await stopDaemon().catch(() => {});
}
console.log(failed ? "\nsmoke test FAILED" : "\nsmoke test passed");
console.log("project:", proj);
process.exit(failed ? 1 : 0);
