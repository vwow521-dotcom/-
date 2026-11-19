// End-to-end check of the bridge (M2b postman). Spawns its own daemon(s) against a throwaway git project.
//   npm run smoke
// A: pipeline over mail with the poll fallback (wait_for_mail), gates, ask_human-as-mail, human mail, dedupe, restart.
// D: meeting rounds → approved plan → task DAG with parallel tasks, one task per agent at a time, leases, scoped commits.
// B: stdio proxy as Claude doorbell, writing into a fake CLAUDE_CODE_MESSAGING_SOCKET named pipe.
// C: Codex Stop hook doorbell against fake transcripts.
// E: codex-queue doorbell (`codex queue` via a fake CLI in an isolated CODEX_HOME): hook registers and
//    doesn't park, mail → codex queue, dedupe against Codex's queue DB, failure → hook parks as fallback.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
  `agents: { claude: {}, codex: {}, pbot: {}, hbot: {}, hbot2: {}, hbot3: { doorbell: codex-hook }, qbot: { product: codex } }
pipeline:
  - { id: plan, role: 规划, agent: claude, gate: true, owns: [DESIGN.md] }
  - { id: implement, role: 编码, agent: codex }
  - { id: review, role: 审查, agent: claude, gate: true, on_reject: implement }
wait: { poll_seconds: 2, stale_after_seconds: 30, offline_after_seconds: 60 }
mail: { ring_retry_seconds: 12 }
notify: { enabled: false }
`,
);

// A fake Codex CLI: logs its argv; fails while <CODEX_HOME>/fail exists. Never touches the real Codex.
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-codex-"));
const fakeCodex = path.join(codexHome, "fake-codex.mjs");
const fakeCodexLog = path.join(codexHome, "calls.jsonl");
fs.writeFileSync(
  fakeCodex,
  `import fs from "node:fs";
const dir = ${JSON.stringify(codexHome)};
fs.appendFileSync(${JSON.stringify(fakeCodexLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (fs.existsSync(dir + "/fail")) { process.stderr.write("boom"); process.exit(1); }
const i = process.argv.indexOf("--thread");
console.log("Queued message m-1 for thread " + process.argv[i + 1] + ".");
`,
);
const codexCalls = () => (fs.existsSync(fakeCodexLog) ? fs.readFileSync(fakeCodexLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

let daemon: ChildProcess;
async function startDaemon() {
  daemon = spawn(process.execPath, ["--import", "tsx", "src/daemon.ts", "--project", proj, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BRIDGE_NOTIFY: "0", BRIDGE_WAKE_GRACE_SECONDS: "6", BRIDGE_CODEX_BIN: fakeCodex, CODEX_HOME: codexHome },
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

async function connect(name: string, transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"))) {
  const c = new Client({ name: `smoke-${name}`, version: "0.0.1" });
  await c.connect(transport);
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
const hookLog = path.join(proj, "codex-stop-hook.jsonl");

function runHook(stdin: object, env: Record<string, string>): Promise<{ out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(ROOT, "bin/codex-stop-hook.mjs")], { env: { ...process.env, BRIDGE_URL: BASE, BRIDGE_HOOK_LOG: hookLog, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve({ out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(stdin));
  });
}

try {
  await startDaemon();

  // ===== A: mail flow with the poll fallback =====
  console.log("— A: pipeline over mail (poll fallback)");
  let claude = await connect("claude");
  let codex = await connect("codex");
  const imposter = await connect("imposter");
  const j = await call(claude, "join", { agent_id: "claude" });
  check(j.roles?.length === 2 && j.doorbell === "poll", "claude joined, no doorbell → poll");
  check(
    j.protocol?.[0].includes("ToolSearch") &&
      ["submit_handoff", "submit_meeting_turn", "fetch_inbox", "ack", "report_progress"].every((tool) => j.protocol[0].includes(tool)),
    "join tells delayed-loading clients to load all five tools before fetching mail",
  );
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

  // Chat: the per-agent message box and the chat room are chat mail (no ack); the mail status is the receipt.
  const boxed = await api("/api/mail", { to: "codex", text: "顺便加个注释" });
  const inbox = await call(codex, "fetch_inbox", { agent_id: "codex" });
  const hm = inbox.mails.find((m: any) => m.kind === "chat");
  check(hm?.id === boxed.json.id && !hm.ack_required && hm.chat.text === "顺便加个注释" && hm.chat.from === "human", "panel message box → chat mail, no ack required");
  s = await state();
  check(s.chat.at(-1).receipts[0].status === "fetched" && s.chat.at(-1).receipts[0].read_at, "fetching a chat mail is the read receipt");
  check((await api("/api/chat", { text: "没有点名" })).status === 409, "human chat without @ is refused");
  check((await api("/api/chat", { text: "x", mentions: ["nobody"] })).status === 409, "unknown mention refused");
  const room = await api("/api/chat", { text: "@claude你好，@codex 也看一下" });
  check(JSON.stringify(room.json.delivered_to?.sort()) === '["claude","codex"]', "@names found in Chinese text (no space after the name)");
  const roomMail = (await call(codex, "fetch_inbox", { agent_id: "codex" })).mails.find((m: any) => m.kind === "chat");
  check(roomMail?.chat.earlier.some((x: any) => x.text === "顺便加个注释"), "chat mail carries the earlier conversation");
  const said = await call(codex, "say", { agent_id: "codex", text: "收到，等我写完 T1", reply_to: roomMail.chat.message_id, mentions: ["claude"] });
  check(said.ok && JSON.stringify(said.delivered_to) === '["claude"]', "say with mentions wakes the mentioned agent");
  const claudeChat = (await call(claude, "fetch_inbox", { agent_id: "claude" })).mails.filter((m: any) => m.kind === "chat");
  check(claudeChat.length === 2 && claudeChat[1].chat.reply_to?.id === roomMail.chat.message_id, "claude gets the room message and codex's reply");
  const back = await call(claude, "say", { agent_id: "claude", text: "好的", reply_to: said.message_id });
  check(JSON.stringify(back.delivered_to) === '["codex"]', "replying to an agent's message reaches it without @");
  check((await call(claude, "say", { agent_id: "claude", text: "只给用户看" })).delivered_to.length === 0, "say without mentions is for the human only");
  const quiet = await call(claude, "say", { agent_id: "claude", text: "就聊到这儿", reply_to: said.message_id, wake: false });
  check(quiet.ok && quiet.delivered_to.length === 0, "say wake=false replies without waking the author");
  let muted: any;
  for (let i = 0; i < 6 && !muted?.muted; i++) muted = await call(claude, "say", { agent_id: "claude", text: "@codex 再聊一句 " + i });
  check(muted.muted?.[0] === "codex" && muted.delivered_to.length === 0, "agents stop waking each other after max_agent_turns without the human");
  check((await call(codex, "get_context", { agent_id: "codex" })).chat.some((x: any) => x.text === "只给用户看"), "get_context includes recent chat");
  await call(codex, "fetch_inbox", { agent_id: "codex" }); // drain the chat mail

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
  const claudeTransport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"));
  claude = await connect("claude-again", claudeTransport);
  await call(claude, "join", { agent_id: "claude" });
  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.resumed === true && t.stage.id === "plan", "in-progress stage re-sent as mail after restart + rejoin");
  await claudeTransport.terminateSession();
  await claude.close();
  claude = await connect("claude-new-session");
  const recovered = await call(claude, "fetch_inbox", { agent_id: "claude" });
  check(recovered.identity_recovered === true && recovered.identity_note.includes("恢复 claude") && task(recovered)?.resumed, "first tool call rebinds a closed session and resumes its live task");
  const recoveredAgain = await call(claude, "get_context", { agent_id: "claude" });
  check(recoveredAgain.current_round?.stage === "plan" && !recoveredAgain.identity_recovered, "recovery is reported only once");

  // Identity: a blocked join explains how to proceed; the panel can release; the agent can leave.
  const intruder = await connect("intruder");
  const blocked = await call(intruder, "join", { agent_id: "claude" });
  check(blocked.error && typeof blocked.auto_release_in_seconds === "number" && blocked.options?.length >= 2, "blocked join reports idle time, auto-release and options");
  check((await api("/api/agents/claude/release", {})).status === 200, "panel releases the identity");
  check((await call(claude, "fetch_inbox", { agent_id: "claude" })).error, "released session can no longer act");
  check(!(await call(intruder, "join", { agent_id: "claude" })).error, "new session joins without takeover after release");
  check(!(await call(intruder, "leave", { agent_id: "claude" })).error, "leave frees the identity");
  check((await call(claude, "get_context", { agent_id: "claude" })).error, "a deliberate leave requires the next session to join");
  await call(claude, "join", { agent_id: "claude" });
  await api("/api/runs/stop", {});

  // ===== D: meeting → task DAG, file leases, scoped commits =====
  console.log("— D: meeting → task DAG, leases, scoped commits");
  codex = await connect("codex-again"); // its first session died with the daemon restart above
  await call(codex, "join", { agent_id: "codex" });
  const meetingOf = (r: any) => r.mails?.find((m: any) => m.kind === "meeting" && !m.void)?.meeting;
  const mt = await api("/api/meetings", { topic: "拆成并行任务", participants: ["claude", "codex"] });
  check(mt.status === 200, "meeting started");
  const mid = mt.json.meeting_id;
  check((await api("/api/runs", { goal: "x" })).status === 409, "pipeline run refused while a meeting is open");
  let mm = meetingOf(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(mm?.kind === "proposal" && mm.round === 1 && mm.meeting_id === mid, "claude invited to round 1 (proposal)");
  const proposalA = "## 方案 A\n按目录拆。每个模块归给一个人。";
  const proposalB = "方案 B：按功能拆" + "，补充详细说明".repeat(40);
  await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: proposalA });
  check((await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: "again" })).error, "second turn in the same round rejected");
  check((await state()).meeting.status === "collecting", "meeting waits for codex");
  mm = meetingOf(await call(codex, "fetch_inbox", { agent_id: "codex" }));
  await call(codex, "submit_meeting_turn", { agent_id: "codex", meeting_id: mid, content: proposalB, tasks: [{ id: "T1", title: "草案", owner: "codex" }] });
  s = await state();
  check(s.meeting.status === "review" && s.meeting.turns.length === 2, "all proposals in → waits for the human");
  await api(`/api/meetings/${mid}/next`, { action: "critique", note: "重点看能不能并行" });
  mm = meetingOf(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(
    mm?.kind === "critique" && mm.round === 2 && mm.previous_rounds[0].turns.length === 2 && mm.human_note === "重点看能不能并行",
    "critique round carries every proposal and the human's note",
  );
  const proposals = mm?.previous_rounds[0].turns;
  check(proposals?.find((turn: any) => turn.agent === "claude")?.content === proposalA &&
    proposals?.find((turn: any) => turn.agent === "codex")?.content === proposalB &&
    proposals?.find((turn: any) => turn.agent === "codex")?.tasks[0].title === "草案", "the immediately preceding round keeps full text and task drafts");
  await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: "同意 B" });
  await call(codex, "fetch_inbox", { agent_id: "codex" });
  await call(codex, "submit_meeting_turn", { agent_id: "codex", meeting_id: mid, content: "同意" });
  await api(`/api/meetings/${mid}/next`, { action: "finalize", note: "" });
  check(!meetingOf(await call(codex, "fetch_inbox", { agent_id: "codex" })), "final round goes to the facilitator only");
  mm = meetingOf(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(mm?.kind === "final", "facilitator gets the final round");
  const earlier = mm?.previous_rounds.find((round: any) => round.round === 1)?.turns;
  check(earlier?.length === 2 && earlier.every((t: any) => t.summary && !("content" in t) && !("tasks" in t) && !("decisions" in t)) &&
    earlier.find((t: any) => t.agent === "claude")?.summary === "按目录拆。" &&
    earlier.find((t: any) => t.agent === "codex")?.summary.length === 160 &&
    mm.previous_rounds.find((round: any) => round.round === 2)?.turns.some((t: any) => t.content === "同意 B"),
    "final mail summarizes each older speaker and carries the previous critique in full");
  const cyc = await call(claude, "submit_meeting_turn", {
    agent_id: "claude", meeting_id: mid, content: "x",
    tasks: [{ id: "T1", title: "a", owner: "claude", depends_on: ["T2"] }, { id: "T2", title: "b", owner: "nobody", depends_on: ["T1"] }],
  });
  check(cyc.error && cyc.problems.some((p: string) => p.includes("成环")) && cyc.problems.some((p: string) => p.includes("nobody")), "bad plan rejected (cycle, unknown owner)");
  const plan = [
    { id: "T1", title: "做 a", description: "写 a/one.txt", owner: "claude", reviewer: "codex", paths: ["a/**"] },
    { id: "T2", title: "做 b", description: "写 b/one.txt", owner: "codex", paths: ["b/"] },
    { id: "T4", title: "做 d", description: "写 d/one.txt", owner: "codex", paths: ["d/**"] },
    { id: "T3", title: "合并", description: "写 c.txt", owner: "claude", depends_on: ["T1", "T2"], paths: ["c.txt"] },
  ];
  await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: "最终方案：四个任务", decisions: [{ what: "按目录拆", why: "互不干扰" }], tasks: plan });
  check((await state()).meeting.status === "awaiting_approval", "final plan waits for approval");
  write("IMPORTANT.md", "用户的反馈\n");
  sh("add", "--", "IMPORTANT.md");
  write("开工前新增.txt", "用户保留的未暂存文件\n");
  const appr = await api(`/api/meetings/${mid}/decide`, { action: "approve", note: "注意中文注释" });
  check(appr.status === 200 && /^doc\/meetings\/\d{4}-\d{2}-\d{2}-拆成并行任务\.md$/.test(appr.json.doc_path), `approved → minutes at ${appr.json.doc_path}`);
  const minutes = fs.readFileSync(path.join(proj, appr.json.doc_path), "utf8");
  check(minutes.includes("方案 A") && minutes.includes("| T3 | 合并 |") && minutes.includes("按目录拆 —— 互不干扰"), "minutes hold proposals, decisions and the task table");
  check(sh("log", "-1", "--format=%s", "--", appr.json.doc_path).includes("会议纪要") && !sh("status", "--porcelain").includes("doc/"), "minutes committed on their own");
  s = await state();
  const tk = (k: string) => s.tasks.find((x: any) => x.key === k);
  check(tk("T1").status === "active" && tk("T2").status === "active" && tk("T4").status === "active" && tk("T3").waiting === "等 T1、T2", "T1/T2/T4 start, T3 waits on its dependencies");
  check(s.leases.filter((l: any) => !l.released_at).length === 3 && s.leases.some((l: any) => l.glob === "b/**"), "task paths leased (b/ → b/**)");

  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.task?.key === "T1" && t.stage.id === "implement" && t.task.description.includes("注意中文注释") && t.meeting_minutes === appr.json.doc_path, "claude gets T1 with the approval note and minutes path");
  let ci = await call(codex, "fetch_inbox", { agent_id: "codex" });
  const codexTasks = ci.mails.filter((m: any) => m.kind === "task" && !m.void);
  check(codexTasks.length === 1 && codexTasks[0].task.task.key === "T2", "codex gets only one task at a time (T2, T4 held back)");
  const busyDoorbell = fetch(BASE + "/api/doorbell/wait?agent=codex&kind=codex-hook&timeout=10").then((r) => r.json());
  for (let i = 0; i < 30 && !(await state()).agents.find((a: any) => a.id === "codex").doorbellArmed; i++) await sleep(100);
  const queuedDuringT2 = await api("/api/mail", { to: "codex", text: "结束 T2 后再看" });
  check((await busyDoorbell).mailIds?.includes(queuedDuringT2.json.id), "a ring was delivered while codex was working on T2");
  const rungAtBusy = Date.now();

  const rc = await call(codex, "reserve_paths", { agent_id: "codex", globs: ["a/one.txt"], reason: "想顺手改" });
  check(rc.granted === false && rc.conflicts[0].held_by === "claude" && rc.conflicts[0].task === "T1", "lease conflict reports the holder");
  const conflictMail = (await call(claude, "fetch_inbox", { agent_id: "claude" })).mails.find((m: any) => m.kind === "system");
  check(conflictMail?.subject.includes("文件冲突"), "holder is told about the conflict");
  const rs = await call(codex, "reserve_paths", { agent_id: "codex", globs: ["shared/notes.md"], ttl_seconds: 60 });
  check(rs.granted === true, "free path reserved");
  const contextWithLease = await call(codex, "get_context", { agent_id: "codex" });
  check(
    contextWithLease.current_task?.key === "T2" &&
      contextWithLease.meeting?.minutes === appr.json.doc_path &&
      contextWithLease.leases.some((l: any) => l.glob === "shared/notes.md" && l.task === "T2"),
    "context combines the scheduled task, meeting minutes and its live file leases",
  );
  const releasedPath = await call(codex, "release_paths", { agent_id: "codex", globs: ["shared/notes.md"] });
  check(
    releasedPath.released?.includes("shared/notes.md") && !(await state()).leases.some((l: any) => l.glob === "shared/notes.md"),
    "releasing a temporary lease updates the panel state",
  );

  fs.mkdirSync(path.join(proj, "a"), { recursive: true });
  fs.mkdirSync(path.join(proj, "b"), { recursive: true });
  fs.mkdirSync(path.join(proj, "d"), { recursive: true });
  write("a/one.txt", "a (half done by claude)\n");
  write("b/one.txt", "b\n");
  write("stray.txt", "nobody's\n");
  await sleep(Math.max(0, 17_500 - (Date.now() - rungAtBusy))); // cross the 12 s retry threshold and the next 5 s sweep
  s = await state();
  const busyMember = s.agents.find((a: any) => a.id === "codex");
  const busyRing = s.mail.find((m: any) => m.id === queuedDuringT2.json.id);
  check(busyMember.waitingForTurn === 1 && busyMember.unansweredMail === 0 && busyMember.stuckMail === 0 &&
    s.attention?.agent !== "codex" && busyRing?.waitingForTurn && busyRing.status === "rung" && busyRing.ring_count === 1,
    "busy ring stays queued through the sweep, with neither retries nor a wake alert");
  check((await (await fetch(BASE + "/")).text()).includes("排队中，等对方这一轮结束"), "panel includes the busy queue label");
  sub = await call(codex, "submit_handoff", { agent_id: "codex", summary: "b 完成", files_changed: ["b/one.txt"] });
  const t2files = sh("show", "--name-only", "--format=", sub.commit).split("\n").filter(Boolean);
  check(t2files.length === 1 && t2files[0] === "b/one.txt", `parallel commit holds only the task's files (${t2files.join(",")})`);
  const preexistingNote = sub.scope_notes.find((n: string) => n.startsWith("开工前就有的未提交改动"));
  const parallelNote = sub.scope_notes.find((n: string) => n.startsWith("其他任务进行中的改动"));
  check(preexistingNote?.includes("IMPORTANT.md") && preexistingNote.includes("开工前新增.txt") && !preexistingNote.includes("a/one.txt"), "scope notes separate the staged and untracked changes present at task start");
  check(parallelNote?.includes("a/one.txt（claude/T1）") && !parallelNote.includes("IMPORTANT.md"), "scope notes identify the other active task by its lease");
  check(sub.scope_notes.some((n: string) => n.includes("stray.txt") && n.startsWith("改动不在本任务范围")), "an unleased new file still gets a generic scope note");
  check(sh("status", "--porcelain", "-uall").includes("a/one.txt"), "claude's in-flight file still uncommitted");
  fs.rmSync(path.join(proj, "stray.txt"));
  s = await state();
  check(tk("T2").status === "done" && tk("T3").status === "pending" && tk("T3").waiting === "等 T1", "T2 done (no reviewer), T3 still waits for T1");

  check(!(s.mail.find((m: any) => m.id === queuedDuringT2.json.id)?.waitingForTurn), "queue label clears when the active task stage ends");
  const afterBusy = await call(codex, "fetch_inbox", { agent_id: "codex" });
  check(afterBusy.mails.some((m: any) => m.id === queuedDuringT2.json.id), "codex can fetch the waiting mail after handing off T2");
  await call(codex, "ack", { agent_id: "codex", mail_ids: [queuedDuringT2.json.id] });
  t = task(afterBusy);
  check(t?.task?.key === "T4", "codex free → T4 delivered");
  write("a/one.txt", "a\n");
  sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "a 完成", files_changed: ["a/one.txt"] });
  check(sub.next === "codex/review", "T1 implement → review by codex");
  s = await state();
  const reviewAttempt = s.lives.find((x: any) => x.stage_id === "review");
  check(reviewAttempt && !s.mail.some((m: any) => m.kind === "task" && m.to === "codex" && m.status === "queued"), "review of T1 held while codex works on T4");
  write("d/one.txt", "d\n");
  await call(codex, "submit_handoff", { agent_id: "codex", summary: "d 完成", files_changed: ["d/one.txt"] });
  t = task(await call(codex, "fetch_inbox", { agent_id: "codex" }));
  check(t?.task?.key === "T1" && t.stage.id === "review" && t.input_handoff?.summary === "a 完成", "codex then gets the T1 review");
  write("a/one.txt", "a (local change left in the review scope)\n");
  sub = await call(codex, "submit_handoff", { agent_id: "codex", summary: "a 没问题", verdict: "approve", files_changed: [] });
  check(/^[0-9a-f]{40}$/.test(sub.commit) && sh("diff-tree", "-r", "--no-commit-id", "--name-only", sub.commit) === "", "last active task's review commits an empty tree diff");
  check(sh("diff", "--cached", "--name-only") === "IMPORTANT.md" && sh("diff", "--name-only") === "a/one.txt", "empty review preserves both a staged user file and an unstaged file in its task scope");
  s = await state();
  const gate = s.lives.find((x: any) => x.status === "awaiting_approval");
  await api(`/api/attempts/${gate.id}/decide`, { action: "approve", note: "" });
  s = await state();
  check(tk("T1").status === "done" && tk("T3").status === "active", "T1 approved → T3 starts");
  check(!s.leases.some((l: any) => l.task === "T1" || l.task === "T2"), "finished tasks' leases released");
  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.task?.key === "T3" && t.dependencies.length === 2 && t.dependencies.every((d: any) => d.status === "done" && d.commit), "T3 sees its dependencies' results");

  // A replayed task letter reads the current dependency state, even when a dependency is unfinished.
  // This fixture changes only the temporary DB, since normal scheduling waits for T1 before dispatching T3.
  const dependencyDb = new DatabaseSync(path.join(proj, ".bridge", "bridge.db"));
  dependencyDb.exec("PRAGMA busy_timeout = 1000");
  const taskStatus = dependencyDb.prepare("UPDATE tasks SET status = ? WHERE id = ?");
  const attemptStatus = dependencyDb.prepare("UPDATE attempts SET status = ? WHERE id = ?");
  const upstreamId = tk("T1").id;
  try {
    taskStatus.run("active", upstreamId);
    attemptStatus.run("awaiting_approval", gate.id);
    await call(claude, "join", { agent_id: "claude" });
    const resumedTask = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
    const dependency = resumedTask?.dependencies.find((d: any) => d.key === "T1");
    check(resumedTask?.resumed && dependency?.status === "active" && dependency.stage === "review" &&
      dependency.stage_status === "awaiting_approval" && dependency.last_handoff_stage === "review" && dependency.commit === sub.commit,
      "replayed task mail includes the unfinished dependency's current stage and latest handoff commit");
  } finally {
    attemptStatus.run("approved", gate.id);
    taskStatus.run("done", upstreamId);
    dependencyDb.close();
  }
  write("c.txt", "c\n");
  sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "合并完成" });
  check(/^[0-9a-f]{40}$/.test(sub.commit) && sh("diff-tree", "-r", "--no-commit-id", "--name-only", sub.commit) === "c.txt", "last active implementation commits only its task paths");
  check(sub.scope_notes.some((n: string) => n.startsWith("开工前就有的未提交改动") && n.includes("a/one.txt")), "a dependent task gets a fresh baseline when its dependencies finish");
  check(sh("diff", "--cached", "--name-only") === "IMPORTANT.md" && sh("diff", "--name-only") === "a/one.txt", "scoped implementation leaves unrelated staged and unstaged changes intact");
  s = await state();
  check(s.run.status === "done" && s.tasks.every((x: any) => x.status === "done"), "all tasks done → run done");
  check(sh("log", "--format=%s", "-1").includes("T3"), "multi-task commits are labelled with the task key");

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
  async function connectClaudeProxy(socket = pipePath) {
    const proxy = new Client({ name: "fake-claude", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "bin/bridge-mcp.mjs")],
      env: { ...(process.env as Record<string, string>), BRIDGE_URL: BASE, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: "tok-123" },
    });
    await proxy.connect(transport);
    return { proxy, transport };
  }
  let { proxy, transport: claudeProxyTransport } = await connectClaudeProxy();
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
  check(pi.mails[0]?.chat?.text.includes("该干活了"), "agent fetches the mail through the proxy");
  const firstBinding = (await state()).agents.find((a: any) => a.id === "pbot").binding?.session;
  const alias = await connectClaudeProxy(pipePath + "-other");
  check((await call(alias.proxy, "fetch_inbox", { agent_id: "pbot" })).error &&
    (await state()).agents.find((a: any) => a.id === "pbot").binding?.session === firstBinding, "another socket neither loads this join cache nor takes over its binding");
  await alias.proxy.close();
  await proxy.close();
  check(!(await state()).agents.find((a: any) => a.id === "pbot").binding, "closing proxy stdin deletes its MCP session and releases its identity");

  async function waitForProxyBinding() {
    for (let i = 0; i < 60; i++) {
      const agent = (await state()).agents.find((a: any) => a.id === "pbot");
      if (agent.binding && agent.doorbellArmed) return agent.binding.session as string;
      await sleep(100);
    }
    return null;
  }
  async function checkProxyDelivery(client: Client, message: string) {
    const before = frames.length;
    const sent = await api("/api/mail", { to: "pbot", text: message });
    for (let i = 0; i < 40 && frames.length < before + 2; i++) await sleep(100);
    const inbox = await call(client, "fetch_inbox", { agent_id: "pbot" });
    check(
      frames[before + 1]?.message.content.includes(message) && inbox.mails?.some((m: any) => m.id === sent.json.id),
      "restored proxy rings and fetches: " + message,
    );
  }
  ({ proxy, transport: claudeProxyTransport } = await connectClaudeProxy());
  const beforeCrash = await waitForProxyBinding();
  check(beforeCrash, "restarted Claude proxy replays join and arms before its first tool call");
  await checkProxyDelivery(proxy, "正常重启后的首封信");
  const closed = new Promise<void>((resolve) => { proxy.onclose = resolve; });
  process.kill(claudeProxyTransport.pid!, "SIGKILL");
  await closed;
  check((await state()).agents.find((a: any) => a.id === "pbot").binding?.session === beforeCrash, "killed proxy leaves the old HTTP binding behind");
  ({ proxy } = await connectClaudeProxy());
  for (let i = 0; i < 60 && (await state()).agents.find((a: any) => a.id === "pbot").binding?.session === beforeCrash; i++) await sleep(100);
  const afterCrash = await waitForProxyBinding();
  check(afterCrash && afterCrash !== beforeCrash, "same Claude socket takes over the orphaned binding");
  await checkProxyDelivery(proxy, "强制结束转接后的首封信");
  await stopDaemon();
  await startDaemon();
  check(await waitForProxyBinding(), "idle proxy restores its binding and doorbell after daemon restart");
  await checkProxyDelivery(proxy, "守护进程重启后的首封信");

  await api("/api/agents/pbot/release", {});
  await proxy.close();
  ({ proxy } = await connectClaudeProxy());
  check((await call(proxy, "fetch_inbox", { agent_id: "pbot" })).error && !(await state()).agents.find((a: any) => a.id === "pbot").binding, "panel release revokes the cached replay");
  await call(proxy, "join", { agent_id: "pbot" });
  check((await call(proxy, "leave", { agent_id: "pbot" })).ok, "Claude proxy leaves deliberately");
  await proxy.close();
  ({ proxy } = await connectClaudeProxy());
  check((await call(proxy, "fetch_inbox", { agent_id: "pbot" })).error, "leave removes the Claude proxy's restore state");
  await proxy.close();
  pipe.close();

  // Codex uses the same stdio proxy without the Claude socket. A fresh proxy must join without takeover.
  const proxyEnv = { ...process.env, BRIDGE_URL: BASE } as Record<string, string>;
  delete proxyEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete proxyEnv.CLAUDE_CODE_MESSAGING_TOKEN;
  for (const name of ["fake-codex", "restarted-codex"]) {
    const client = new Client({ name, version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "bin/bridge-mcp.mjs")], env: proxyEnv }));
    try {
      check((await call(client, "join", { agent_id: "pbot" })).agent_id === "pbot", `${name} joins without takeover`);
    } finally {
      await client.close();
    }
  }

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
  const hookInput = { session_id: "s-1", transcript_path: tx, turn_id: "t-1", stop_hook_active: true, last_assistant_message: "待命", future_field: { value: 42 } };
  const parked = runHook(hookInput, { BRIDGE_PARK_SECONDS: "20" });
  await sleep(1500);
  s = await state();
  check(s.agents.find((a: any) => a.id === "hbot").doorbellArmed && s.endpoints.some((x: any) => x.agent === "hbot" && x.address === "s-1"), "joined thread parks and registers");
  const rangAt = Date.now();
  const ringMail = await api("/api/mail", { to: "hbot", text: "新任务" });
  h = await parked;
  const hj = JSON.parse(h.out);
  check(hj.decision === "block" && /fetch_inbox/.test(hj.reason) && h.ms < 5000, `mail → block with wake-up reason (${h.ms} ms)`);
  const trace = fs.readFileSync(hookLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const stdinEntry = trace.find((entry) => entry.event === "stdin" && entry.stdin.session_id === hookInput.session_id);
  const hookEvents = trace.filter((entry) => entry.pid === stdinEntry?.pid);
  const outputEntry = hookEvents.find((entry) => entry.event === "output");
  check(JSON.stringify(stdinEntry?.stdin) === JSON.stringify(hookInput), "hook logs all stdin fields, including stop_hook_active, turn_id and unknown fields");
  check(outputEntry?.cause === "ring" && outputEntry.mailIds.includes(ringMail.json.id) && outputEntry.parked_ms > 0 && JSON.stringify(outputEntry.output) === h.out && hookEvents.some((entry) => entry.event === "stdout_complete" && entry.error === null), "hook log correlates parking duration and flushed stdout with the rung mail");

  const tx2 = path.join(proj, "rollout2.jsonl");
  fs.writeFileSync(tx2, joinLine("hbot2") + "\n");
  const fetching = await connect("fetching-codex");
  await call(fetching, "join", { agent_id: "hbot2" });
  const healthy = runHook({ session_id: "s-healthy", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "20" });
  await sleep(700);
  const healthyMail = await api("/api/mail", { to: "hbot2", text: "按铃后马上取信" });
  check(JSON.parse((await healthy).out).decision === "block", "second Codex hook receives its ring");
  check((await call(fetching, "fetch_inbox", { agent_id: "hbot2" })).mails.some((m: any) => m.id === healthyMail.json.id), "healthy Codex fetches its rung mail");

  for (let i = 0; i < 100 && Date.now() - rangAt < 10_500; i++) {
    s = await state();
    if (s.attention?.agent === "hbot") break;
    await sleep(100);
  }
  check(s.attention?.agent === "hbot" && s.attention.message.includes("尚未取信") && s.mail.find((m: any) => m.id === ringMail.json.id)?.status === "rung", `unfetched hook ring triggers a panel warning before sweep (${Date.now() - rangAt} ms)`);
  const manual = await connect("manual-codex");
  await call(manual, "join", { agent_id: "hbot" });
  check((await call(manual, "fetch_inbox", { agent_id: "hbot" })).mails.some((m: any) => m.id === ringMail.json.id), "manual recovery can still fetch the pending mail");
  await sleep(2000); // the healthy ring's own wake-up grace will have expired too
  s = await state();
  check(!s.attention && s.events.filter((e: any) => e.kind === "doorbell" && e.text.includes("仍有")).length === 1, "fetch clears the alert and a timely fetch never triggers one");
  // Woken and working (any tool call after the ring) but slow to fetch: no alert.
  const busyHook = runHook({ session_id: "s-busy", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "20" });
  await sleep(700);
  const busyMail = await api("/api/mail", { to: "hbot2", text: "醒了但先想一会儿" });
  check(JSON.parse((await busyHook).out).decision === "block", "busy Codex hook receives its ring");
  await sleep(1000);
  await call(fetching, "get_context", { agent_id: "hbot2" });
  await sleep(6500);
  s = await state();
  check(!s.attention && !s.events.some((e: any) => e.kind === "doorbell" && e.agent === "hbot2" && e.text.includes("仍有")), "a tool call after the ring suppresses the wake alert");
  await call(fetching, "fetch_inbox", { agent_id: "hbot2" });
  check(s.mail.find((m: any) => m.id === busyMail.json.id)?.status === "rung", "slow mail was still waiting, not re-rung away");
  const deliveryTrace = fs.readFileSync(path.join(proj, ".bridge", "bridge-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  check([ringMail.json.id, healthyMail.json.id].every((id) => deliveryTrace.some((entry) => entry.event === "rung_mail_fetched" && entry.id === id)), "bridge log correlates both fetches with their ring and hook output by mail ID");

  h = await runHook({ session_id: "s-2", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "2" });
  check(JSON.parse(h.out).reason?.includes("心跳"), "quiet park window → heartbeat block");
  h = await runHook({ session_id: "s-2", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "2", BRIDGE_HEARTBEAT: "0" });
  check(h.out === "{}", "heartbeat off → let Codex stop");

  // Nobody parked: the mail must not sit silently — after ring_retry_seconds it becomes "stuck".
  await api("/api/mail", { to: "hbot3", text: "没人在等" });
  await sleep(17_000);
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

  // ===== E: codex-queue doorbell =====
  console.log("— E: codex-queue doorbell (fake codex CLI)");
  const qbot = await connect("qbot");
  const qj = await call(qbot, "join", { agent_id: "qbot" });
  check(qj.doorbell === "codex-queue" && qj.protocol.some((l: string) => l.includes("正常结束本回合")), "product codex joins with the codex-queue doorbell");
  const early = await api("/api/mail", { to: "qbot", text: "对话还没登记时来的信" });
  await sleep(300);
  check((await state()).mail.find((m: any) => m.id === early.json.id)?.status === "queued" && codexCalls().length === 0, "before the hook registers the thread, mail waits (nothing to queue to)");
  const qtx = path.join(proj, "rollout-q.jsonl");
  fs.writeFileSync(qtx, joinLine("qbot") + "\n");
  h = await runHook({ session_id: "thread-q1", turn_id: "t1", stop_hook_active: false, transcript_path: qtx }, { BRIDGE_PARK_SECONDS: "20" });
  check(h.out === "{}" && h.ms < 5000, `hook registers the thread and does not park (${h.ms} ms)`);
  for (let i = 0; i < 30 && codexCalls().length < 1; i++) await sleep(100);
  let calls = codexCalls();
  check(
    calls.length === 1 && calls[0][0] === "queue" && calls[0][calls[0].indexOf("--thread") + 1] === "thread-q1" && /\[协作桥\].*fetch_inbox/.test(calls[0][calls[0].indexOf("--message") + 1]),
    "registration rings the waiting mail via `codex queue --thread <id> --message …`",
  );
  s = await state();
  check(s.mail.find((m: any) => m.id === early.json.id)?.status === "rung" && s.agents.find((a: any) => a.id === "qbot").doorbellArmed, "mail rung, codex-queue doorbell armed");
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });

  // Codex already has a wake message queued for this thread → don't stack another.
  const qdb = new DatabaseSync(path.join(codexHome, "queue_1.sqlite"));
  qdb.exec("CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL, queue_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)");
  qdb.prepare("INSERT INTO queued_items VALUES ('x', 'thread-q1', '{}', 1, 0, 0)").run();
  const dup = await api("/api/mail", { to: "qbot", text: "队列里已有叫醒消息" });
  await sleep(800);
  check(codexCalls().length === 1 && (await state()).mail.find((m: any) => m.id === dup.json.id)?.status === "rung", "a wake already waiting in Codex's queue is not stacked");
  qdb.exec("DELETE FROM queued_items");
  qdb.close();
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });

  // Rung, but no tool call within the grace → the human is told (no other doorbell is available).
  const silent = await api("/api/mail", { to: "qbot", text: "没人理的信" });
  await sleep(7500);
  s = await state();
  check(
    codexCalls().length === 2 && s.agents.find((a: any) => a.id === "qbot").unansweredMail === 1 && s.events.some((e: any) => e.agent === "qbot" && e.text.includes("仍有")),
    "no sign of life after a codex-queue ring → alert",
  );
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });
  check((await state()).agents.find((a: any) => a.id === "qbot").unansweredMail === 0, "fetching clears the alert");

  // `codex queue` fails → mail goes back, the human is told at once, and the next Stop hook parks as fallback.
  fs.writeFileSync(path.join(codexHome, "fail"), "");
  const broken = await api("/api/mail", { to: "qbot", text: "codex queue 坏了" });
  for (let i = 0; i < 30; i++) {
    s = await state();
    if (s.agents.find((a: any) => a.id === "qbot").doorbellError) break;
    await sleep(100);
  }
  const qa = s.agents.find((a: any) => a.id === "qbot");
  check(
    qa.doorbellError?.includes("boom") && s.mail.find((m: any) => m.id === broken.json.id)?.status === "queued" && qa.unansweredMail === 1,
    "failed codex queue → mail requeued, error shown, human alerted immediately",
  );
  fs.rmSync(path.join(codexHome, "fail"));
  const fallback = runHook({ session_id: "thread-q1", turn_id: "t2", stop_hook_active: false, transcript_path: qtx }, { BRIDGE_PARK_SECONDS: "20" });
  h = await fallback;
  check(JSON.parse(h.out).decision === "block" && JSON.parse(h.out).reason.includes("fetch_inbox"), "after a queue failure the hook parks again and delivers the mail itself");
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });
  const qtrace = fs.readFileSync(path.join(proj, ".bridge", "bridge-log.jsonl"), "utf8");
  check(qtrace.includes('"event":"codex_queue"') && qtrace.includes('"via":"codex-queue"'), "bridge log records codex queue calls and rings by doorbell");

  // Bridge restart: the registered thread predates this daemon and qbot hasn't re-joined (the user may have
  // opened a new conversation) → don't wake the old one; wait for the Stop hook to register again.
  await stopDaemon();
  await startDaemon();
  const before = codexCalls().length;
  const afterRestart = await api("/api/mail", { to: "qbot", text: "重启后、还没重新加入时来的信" });
  await sleep(800);
  check(codexCalls().length === before && (await state()).mail.find((m: any) => m.id === afterRestart.json.id)?.status === "queued", "after a restart, a thread registered before it is not woken");
  h = await runHook({ session_id: "thread-q2", turn_id: "t1", stop_hook_active: false, transcript_path: qtx }, { BRIDGE_PARK_SECONDS: "20" });
  for (let i = 0; i < 30 && codexCalls().length === before; i++) await sleep(100);
  calls = codexCalls();
  check(h.out === "{}" && calls.length === before + 1 && calls.at(-1)![calls.at(-1)!.indexOf("--thread") + 1] === "thread-q2", "a fresh registration after the restart is woken");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await stopDaemon().catch(() => {});
}
console.log(failed ? "\nsmoke test FAILED" : "\nsmoke test passed");
console.log("project:", proj);
process.exit(failed ? 1 : 0);
