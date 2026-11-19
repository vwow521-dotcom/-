// Run/task/stage state machine, meetings, file leases and the postman.
// Work reaches agents as mail. The postman wakes an agent with its doorbell (Claude: messaging-socket
// injection via the stdio proxy; Codex: a parked Stop hook) or, without one, the agent long-polls
// wait_for_mail. Durable state (runs, tasks, attempts, handoffs, leases, meetings, mail, notes,
// questions) lives in the Store; presence, identity bindings, doorbell waiters and blocked waits are in memory.
//
// A run is a DAG of tasks. Each task runs its own stage chain (attempts: ready → in_progress →
// awaiting_approval/done). A pipeline run ("开始") is one task whose stages are the config pipeline;
// a meeting's approved plan becomes a run with one task per planned task, each using task_template.
// Tasks whose dependencies are done and whose paths don't collide with someone else's lease start;
// each agent works on one task at a time, so further task mail waits until it is free.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type {
  Attempt,
  Feedback,
  HandoffData,
  Lease,
  Mail,
  MailKind,
  Meeting,
  MeetingTurnKind,
  PlannedTask,
  Run,
  Store,
  Task,
  TaskStage,
} from "./store.js";
import { changedFiles, commitAll, commitPaths, globMatch, globsOverlap, normGlob } from "./git.js";

export type DoorbellKind = "claude-socket" | "codex-hook" | "poll";
export type PresenceStatus = "working" | "armed" | "waiting" | "idle" | "stale" | "offline" | "never-joined";

interface Presence {
  id: string;
  sessionId?: string; // the one MCP session allowed to act as this agent
  boundAt?: number;
  lastSeenAt?: number; // last tool call from the bound session
  registeredDoorbell?: DoorbellKind; // what the proxy / hook registered (used when config says auto)
  doorbellSeenAt?: number; // last time a doorbell long-poll was open
  doorbellError?: string;
  lastRingAt?: number;
  // wait_for_mail (poll fallback) metrics, kept from M0
  waiting: boolean;
  waitCalls: number;
  lastReturnAt?: number;
  maxGapMs: number;
  totalGapMs: number;
  gapCount: number;
}

export interface RingResult {
  ring: boolean;
  mailIds?: string[];
  text?: string;
}

interface DoorbellWaiter {
  kind: DoorbellKind;
  finish: (result: RingResult) => void;
}

type Result = Record<string, unknown>;
const err = (error: string): Result => ({ error });
const DOORBELL_ARMED_MS = 70_000;
// After a Codex ring, how long to wait for a sign of life before telling the human. A woken Codex may
// think for a while before its first tool call; a Codex that ignored the block ends its turn within ~1 s.
const CODEX_WAKE_GRACE_MS = Number(process.env.BRIDGE_CODEX_WAKE_GRACE_SECONDS ?? 20) * 1000;
const LIVE_MAIL = ["queued", "rung", "stuck"] as const;
const KIND_LABEL: Record<MeetingTurnKind, string> = { proposal: "提案", critique: "互评", final: "定稿" };
const norm = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const inGlob = (g: string, f: string) => globMatch(normGlob(g), f);

export class Engine {
  private presence = new Map<string, Presence>();
  private doorbellWaiters = new Map<string, Set<DoorbellWaiter>>();
  private codexWakeAlerts = new Set<string>(); // mail IDs already reported to the human
  private mailWakers = new Map<string, () => void>();
  private taskWaits = new Map<number, string>(); // task id → why a ready-to-start task hasn't started (lease conflict)
  private logFile: string;
  private sweepTimer: NodeJS.Timeout;
  /** Set by the HTTP layer: is this MCP session still open? */
  isSessionOpen: (sessionId: string) => boolean = () => true;
  /** Set by the HTTP layer: notify panel listeners that state changed. */
  onChange: () => void = () => {};
  /** Set by the daemon: tell the human (Windows toast). */
  notifyHuman: (title: string, body: string) => void = () => {};

  constructor(
    readonly cfg: Config,
    readonly store: Store,
  ) {
    for (const id of Object.keys(cfg.agents))
      this.presence.set(id, { id, waiting: false, waitCalls: 0, maxGapMs: 0, totalGapMs: 0, gapCount: 0 });
    this.logFile = path.join(cfg.projectDir, ".bridge", "bridge-log.jsonl");
    store.migrateLegacyRuns(this.pipelineStages());
    this.sweepTimer = setInterval(() => this.sweep(), 5_000);
    this.sweepTimer.unref();
  }

  get pollMs() {
    return this.cfg.wait.poll_seconds * 1000;
  }

  log(event: string, data: Record<string, unknown> = {}) {
    const line = { t: new Date().toISOString(), event, ...data };
    fs.appendFileSync(this.logFile, JSON.stringify(line) + "\n");
    console.log(`[${line.t.slice(11, 19)}] ${event}`, Object.keys(data).length ? JSON.stringify(data) : "");
  }

  private event(run_id: number | null, agent: string | null, kind: string, text: string) {
    this.store.addEvent(run_id, agent, kind, text);
    this.onChange();
  }

  agentIds() {
    return [...this.presence.keys()];
  }
  isAgent(id: string) {
    return this.presence.has(id);
  }
  rolesOf(agent: string) {
    return this.cfg.pipeline.filter((s) => s.agent === agent).map((s) => `${s.id}（${s.role}）`);
  }
  private pipelineStages(): TaskStage[] {
    return this.cfg.pipeline.map((s) => ({ ...s }));
  }
  private stageOf(task: Task, id: string): TaskStage {
    return task.stages.find((s) => s.id === id) ?? task.stages[0];
  }
  /** Concrete stages for a meeting-planned task: owner/reviewer filled in, reviewer stages dropped when there is none. */
  private templateStages(owner: string, reviewer: string | null): TaskStage[] {
    const kept = this.cfg.task_template.filter((s) => s.agent !== "reviewer" || reviewer);
    const ids = new Set(kept.map((s) => s.id));
    return kept.map((s) => ({
      ...s,
      agent: s.agent === "owner" ? owner : s.agent === "reviewer" ? reviewer! : s.agent,
      on_reject: s.on_reject && ids.has(s.on_reject) ? s.on_reject : undefined,
    }));
  }

  // ---------- presence, identity, doorbells ----------

  doorbellKind(agent: string): DoorbellKind {
    const configured = this.cfg.agents[agent]?.doorbell ?? "auto";
    if (configured !== "auto") return configured;
    return this.presence.get(agent)?.registeredDoorbell ?? "poll";
  }

  doorbellArmed(agent: string) {
    const p = this.presence.get(agent)!;
    if (this.doorbellWaiters.get(agent)?.size) return true;
    return !!p.doorbellSeenAt && Date.now() - p.doorbellSeenAt < DOORBELL_ARMED_MS;
  }

  status(id: string): PresenceStatus {
    const p = this.presence.get(id)!;
    const run = this.store.openRun();
    if (run && this.store.agentAttempts(run.id, id, ["in_progress"]).length) return "working";
    if (this.store.mailByStatus(id, ["fetched"]).some((m) => m.kind === "meeting")) return "working";
    if (this.doorbellKind(id) !== "poll" && this.doorbellArmed(id)) return "armed";
    if (p.waiting) return "waiting";
    if (!p.lastSeenAt) return "never-joined";
    if (!p.sessionId && this.doorbellKind(id) !== "codex-hook") return "offline";
    const since = Date.now() - Math.max(p.lastSeenAt, p.lastReturnAt ?? 0, p.doorbellSeenAt ?? 0);
    if (since > this.cfg.wait.offline_after_seconds * 1000) return "offline";
    if (since > this.cfg.wait.stale_after_seconds * 1000) return "stale";
    return "idle";
  }

  private bindingError(agent: string, sessionId: string | undefined): string | null {
    const p = this.presence.get(agent);
    if (!p) return `未知 agent_id，可选：${this.agentIds().join(", ")}`;
    if (!p.sessionId) return `你还没有以 ${agent} 身份 join，请先调用 join。`;
    if (p.sessionId !== sessionId)
      return `身份 ${agent} 已被另一个会话占用。请确认你的身份（可选：${this.agentIds().join(", ")}）；如果确实是你，用 join(agent_id, takeover=true) 接管。`;
    p.lastSeenAt = Date.now();
    return null;
  }

  join(agent: string, sessionId: string | undefined, takeover = false, doorbellHint?: string): Result {
    const p = this.presence.get(agent);
    if (!p) return err(`未知 agent_id，可选：${this.agentIds().join(", ")}`);
    const st = this.status(agent);
    const boundElsewhere = p.sessionId && p.sessionId !== sessionId && this.isSessionOpen(p.sessionId) && st !== "offline";
    if (boundElsewhere && !takeover) {
      this.log("join_rejected", { agent, session: sessionId, boundTo: p.sessionId });
      const idleS = p.lastSeenAt ? Math.round((Date.now() - p.lastSeenAt) / 1000) : null;
      const releaseIn = idleS === null ? null : Math.max(0, this.cfg.wait.offline_after_seconds - idleS);
      return {
        error: `身份 ${agent} 已被另一个会话占用。你很可能拿错了启动提示词，请确认自己的身份（可选：${this.agentIds().join(", ")}）。`,
        bound_session: p.sessionId,
        bound_since: p.boundAt ? new Date(p.boundAt).toISOString() : null,
        bound_session_idle_seconds: idleS,
        auto_release_in_seconds: releaseIn,
        options: [
          "如果旧会话已经不用了：用 takeover=true 重新 join，立即接管。",
          "或者请用户在面板「成员」表里点「释放」，再重新 join。",
          releaseIn !== null ? `或者等约 ${releaseIn} 秒，旧会话无活动后会被视为离线，届时可直接 join。` : "",
        ].filter(Boolean),
      };
    }
    if (p.sessionId && p.sessionId !== sessionId) {
      this.mailWakers.get(agent)?.();
      this.log("join_takeover", { agent, from: p.sessionId, to: sessionId });
    }
    if (p.sessionId !== sessionId) p.boundAt = Date.now();
    p.sessionId = sessionId;
    p.lastSeenAt = Date.now();
    if (doorbellHint === "claude-socket") {
      p.registeredDoorbell = "claude-socket";
      p.doorbellError = undefined;
    }
    const kind = this.doorbellKind(agent);
    this.log("join", { agent, session: sessionId, doorbell: kind });
    this.event(null, agent, "join", `${agent} 加入（门铃：${DOORBELL_LABEL[kind]}）`);
    this.resendLiveTask(agent);

    const wake: Record<DoorbellKind, string[]> = {
      "claude-socket": [
        "你不需要轮询。有新信时，你会收到一条以「[协作桥]」开头的消息（显示为另一个会话发来的），收到后调用 fetch_inbox 处理。",
      ],
      "codex-hook": [
        "你不需要轮询。处理完后正常结束本回合即可；有新信时，协作桥会让你继续，并给你一条以「[协作桥]」开头的指示，照它说的调用 fetch_inbox。",
      ],
      poll: [
        "处理完后调用 wait_for_mail(agent_id) 等信；它返回 keep_waiting 时立即再调用一次，不要停下、不要向用户汇报。等待被中断或取消时也立即重新调用。",
      ],
    };
    return {
      agent_id: agent,
      doorbell: kind,
      roles: this.rolesOf(agent),
      pipeline: this.cfg.pipeline.map((s) => `${s.id}：${s.role}（${s.agent}${s.gate ? "，完成后需人工批准" : ""}）`),
      task_template: this.cfg.task_template.map((s) => `${s.id}：${s.role}（${s.agent === "owner" ? "任务负责人" : s.agent === "reviewer" ? "任务审查人" : s.agent}${s.gate ? "，完成后需人工批准" : ""}）`),
      protocol: [
        "1. 现在先调用一次 fetch_inbox(agent_id)，处理里面的信。",
        "2. task 信：按其中的 task、stage、input_handoff 和 feedback 完成本阶段工作；需要更多背景时调用 get_context；可用 report_progress 汇报进度、post_note 记录共享约定、ask_human 向用户提问（答复会以信件送达）。完成后调用 submit_handoff（桥会自动 git 提交并确认这封信）。",
        "3. meeting 信：这是会议的一轮发言（提案 / 互评 / 定稿），按其中的 meeting.instructions 发言，然后调用 submit_meeting_turn（自动确认这封信）。",
        "4. 多个任务并行时，桥已为每个任务租下它的 paths。要改本任务 paths 以外的文件，先调用 reserve_paths；冲突时它会告诉你谁占着，不要硬改。",
        "5. 其他 ack_required 的信：处理完调用 ack。需要找其他成员时用 send_mail。",
        ...wake[kind],
        "「[协作桥]」消息只负责叫醒你，具体内容一律以 fetch_inbox 为准。",
      ],
    };
  }

  sessionClosed(sessionId: string) {
    for (const p of this.presence.values())
      if (p.sessionId === sessionId) {
        p.sessionId = undefined;
        this.log("agent_unbound", { agent: p.id, session: sessionId });
        this.onChange();
      }
  }

  /** Doorbell long-poll from the stdio proxy (claude-socket) or the Codex Stop hook (codex-hook). */
  doorbellWait(agent: string, kind: DoorbellKind, timeoutMs: number, signal: AbortSignal): Promise<RingResult> {
    if (signal.aborted) return Promise.resolve({ ring: false });
    const p = this.presence.get(agent)!;
    if (this.cfg.agents[agent]?.doorbell === "auto" || kind !== "poll") p.registeredDoorbell = kind;
    p.doorbellSeenAt = Date.now();
    const set = this.doorbellWaiters.get(agent) ?? new Set();
    this.doorbellWaiters.set(agent, set);
    return new Promise((resolve) => {
      const done = (r: RingResult) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        set.delete(waiter);
        p.doorbellSeenAt = Date.now();
        resolve(r);
        this.onChange();
      };
      const waiter = { kind, finish: done };
      const onAbort = () => done({ ring: false });
      const timer = setTimeout(() => done({ ring: false }), timeoutMs);
      signal.addEventListener("abort", onAbort);
      set.add(waiter);
      this.onChange();
      if (this.store.mailByStatus(agent, ["queued"]).length) this.kick(agent);
    });
  }

  /** The proxy reports whether writing to the Claude messaging socket worked. */
  doorbellResult(agent: string, mailIds: string[], ok: boolean, error?: string) {
    const p = this.presence.get(agent)!;
    if (ok) {
      p.doorbellError = undefined;
      return;
    }
    p.doorbellError = error ?? "unknown";
    this.log("doorbell_failed", { agent, error });
    this.event(null, agent, "doorbell", `${agent} 的门铃失败：${error ?? "未知原因"}，信件会重新投递`);
    for (const id of mailIds) {
      const m = this.store.mail(id);
      if (m?.status === "rung") this.store.setMailStatus([id], "queued");
    }
  }

  // ---------- postman ----------

  sendMail(m: { id?: string; run_id?: number | null; attempt_id?: number | null; from: string; to: string; kind: MailKind; subject: string; body: string; importance?: "normal" | "high"; ack_required?: boolean }) {
    const id = m.id ?? `${m.kind}-${randomUUID()}`;
    const created = this.store.addMail({
      id,
      run_id: m.run_id ?? null,
      attempt_id: m.attempt_id ?? null,
      from_agent: m.from,
      to_agent: m.to,
      kind: m.kind,
      subject: m.subject,
      body: m.body,
      importance: m.importance ?? "normal",
      ack_required: m.ack_required ? 1 : 0,
    });
    if (!created) {
      this.log("mail_duplicate", { id });
      return { id, duplicate: true };
    }
    this.log("mail_queued", { id, to: m.to, kind: m.kind, subject: m.subject });
    this.kick(m.to);
    this.onChange();
    return { id, duplicate: false };
  }

  /** Something is waiting for `agent`: wake its poll waiter and ring any open doorbell. */
  kick(agent: string) {
    const queued = this.store.mailByStatus(agent, ["queued"]);
    if (!queued.length) return;
    const mw = this.mailWakers.get(agent);
    if (mw) {
      this.mailWakers.delete(agent);
      mw();
    }
    const waiters = this.doorbellWaiters.get(agent);
    if (!waiters?.size) return;
    const ids = queued.map((m) => m.id);
    const text =
      `[协作桥] ${agent}，你有 ${queued.length} 封新信：` +
      queued.map((m) => m.subject).slice(0, 5).join("；") +
      (queued.length > 5 ? " 等" : "") +
      `。请调用 bridge 的 fetch_inbox（agent_id="${agent}"）查看并处理。`;
    this.store.setMailStatus(ids, "rung");
    const p = this.presence.get(agent)!;
    p.lastRingAt = Date.now();
    this.log("doorbell_ring", { agent, via: this.doorbellKind(agent), mails: ids });
    this.event(null, agent, "doorbell", `按门铃叫醒 ${agent}（${queued.length} 封信）`);
    const parked = [...waiters];
    for (const w of parked) w.finish({ ring: true, mailIds: ids, text });
    if (parked.some((w) => w.kind === "codex-hook")) {
      const rangAt = Date.now();
      setTimeout(() => this.checkCodexWake(agent, ids, rangAt), CODEX_WAKE_GRACE_MS).unref();
    }
  }

  /** A completed hook poll only proves that the bridge rang. Give Codex a few seconds to fetch. */
  private checkCodexWake(agent: string, ids: string[], rangAt: number) {
    const waiters = this.doorbellWaiters.get(agent);
    if (waiters && [...waiters].some((w) => w.kind === "codex-hook")) return;
    // Any tool call since the ring means Codex woke up and is working; it will fetch in its own time.
    if ((this.presence.get(agent)?.lastSeenAt ?? 0) >= rangAt) return;
    const unread = ids.filter((id) => {
      const status = this.store.mail(id)?.status;
      return (status === "rung" || status === "queued") && !this.codexWakeAlerts.has(id);
    });
    if (!unread.length) return;
    for (const id of unread) this.codexWakeAlerts.add(id);
    this.log("codex_wake_timeout", { agent, mails: unread, graceMs: CODEX_WAKE_GRACE_MS });
    this.event(null, agent, "doorbell", `${agent} 已响铃，Stop hook 已结束等待，仍有 ${unread.length} 封信未取`);
    this.notifyHuman(`协作桥：需要你叫醒 ${agent}`, `${agent} 已响铃但尚未取信。请在该对话里说「继续」。`);
  }

  /** Periodic: re-ring mail nobody fetched, give up after max_rings, flag overdue acks, retry lease-blocked tasks. */
  private sweep() {
    const now = Date.now();
    const { ring_retry_seconds, max_rings, ack_timeout_seconds } = this.cfg.mail;
    for (const id of this.codexWakeAlerts) {
      const status = this.store.mail(id)?.status;
      if (!status || !LIVE_MAIL.some((s) => s === status)) this.codexWakeAlerts.delete(id);
    }
    for (const m of this.store.allMailByStatus(["rung"])) {
      if (now - Date.parse(m.rung_at!) < ring_retry_seconds * 1000) continue;
      if (m.ring_count >= max_rings) {
        this.store.setMailStatus([m.id], "stuck");
        this.log("mail_stuck", { id: m.id, to: m.to_agent });
        this.event(m.run_id, m.to_agent, "stuck", `${m.to_agent} 没有响应门铃：「${m.subject}」`);
        if (!this.codexWakeAlerts.has(m.id))
          this.notifyHuman("协作桥：需要你叫醒 " + m.to_agent, `门铃按了 ${m.ring_count} 次没有回应。请在 ${m.to_agent} 里说「继续」。`);
      } else {
        this.store.setMailStatus([m.id], "queued");
        this.kick(m.to_agent);
      }
    }
    // Queued mail that no doorbell can deliver (agent not parked / proxy gone, not polling, not busy) → ask the human.
    for (const m of this.store.allMailByStatus(["queued"])) {
      if (now - Date.parse(m.created_at) < ring_retry_seconds * 1000) continue;
      const st = this.status(m.to_agent);
      if (st === "working" || st === "armed" || st === "waiting") continue;
      this.store.setMailStatus([m.id], "stuck");
      this.log("mail_stuck", { id: m.id, to: m.to_agent, reason: "no doorbell" });
      this.event(m.run_id, m.to_agent, "stuck", `${m.to_agent} 的门铃没有接上，「${m.subject}」送不到`);
      if (!this.codexWakeAlerts.has(m.id))
        this.notifyHuman("协作桥：需要你叫醒 " + m.to_agent, `${m.to_agent} 现在没有在等信。请在 ${m.to_agent} 里说「继续」。`);
    }
    for (const m of this.store.allMailByStatus(["fetched"])) {
      if (!m.ack_required || m.overdue_flagged || now - Date.parse(m.fetched_at!) < ack_timeout_seconds * 1000) continue;
      this.store.flagOverdue(m.id);
      this.log("ack_overdue", { id: m.id, to: m.to_agent });
      this.event(m.run_id, m.to_agent, "overdue", `${m.to_agent} 取走了「${m.subject}」但一直没有确认`);
      this.notifyHuman("协作桥：确认超时", `${m.to_agent} 取走了「${m.subject}」，超过 ${Math.round(ack_timeout_seconds / 60)} 分钟没有确认。`);
    }
    // A hand-reserved lease may have expired: tasks waiting on it can start now.
    const run = this.store.openRun();
    if (run && this.taskWaits.size) this.schedule(run.id);
  }

  private mailView(m: Mail) {
    return { id: m.id, kind: m.kind, from: m.from_agent, subject: m.subject, importance: m.importance, ack_required: !!m.ack_required, sent_at: m.created_at };
  }

  fetchInbox(agent: string, sessionId: string | undefined): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const mails = this.store.mailByStatus(agent, [...LIVE_MAIL]);
    const out: Result[] = [];
    for (const m of mails) {
      if (m.kind === "task") {
        const a = m.attempt_id ? this.store.attempt(m.attempt_id) : undefined;
        const run = a && this.store.run(a.run_id);
        if (!a || !run || !["ready", "in_progress"].includes(a.status) || !["active", "awaiting_approval"].includes(run.status)) {
          this.store.setMailStatus([m.id], "void");
          out.push({ ...this.mailView(m), void: true, note: "这个任务已停止或已被替换，忽略即可。" });
          continue;
        }
        const resumed = a.status === "in_progress";
        if (!resumed) this.store.updateAttempt(a.id, { status: "in_progress", started_at: new Date().toISOString() });
        const task = this.store.task(a.task_id)!;
        this.log("task_fetched", { agent, run: run.id, task: task.key, stage: a.stage_id, attempt: a.id, resumed, latencyMs: Date.now() - Date.parse(m.created_at) });
        this.event(run.id, agent, "turn", `${agent} 开始「${this.taskLabel(task)}${a.stage_id}」${resumed ? "（继续）" : ""}`);
        out.push({ ...this.mailView(m), task: this.turnPayload(run, this.store.attempt(a.id)!, resumed) });
      } else if (m.kind === "meeting") {
        const ref = this.meetingMailRef(m.id);
        const mt = ref && this.store.meeting(ref.meeting);
        if (!ref || !mt || mt.status !== "collecting" || mt.round !== ref.round) {
          this.store.setMailStatus([m.id], "void");
          out.push({ ...this.mailView(m), void: true, note: "这一轮会议已经结束或被取消，忽略即可。" });
          continue;
        }
        out.push({ ...this.mailView(m), meeting: this.meetingPayload(mt, agent) });
      } else {
        out.push({ ...this.mailView(m), body: m.body });
      }
      this.store.setMailStatus([m.id], "fetched");
      if (m.rung_at) this.log("rung_mail_fetched", { id: m.id, agent, sinceRingMs: Date.now() - Date.parse(m.rung_at) });
    }
    this.onChange();
    const kind = this.doorbellKind(agent);
    return {
      mails: out,
      instructions: out.length
        ? "逐封处理：task 信完成后调用 submit_handoff（自动确认）；meeting 信发言后调用 submit_meeting_turn（自动确认）；其他 ack_required 的信处理后调用 ack。" +
          (kind === "poll" ? "全部处理完后调用 wait_for_mail 继续等信。" : "全部处理完后结束本回合，有新信时会叫醒你。")
        : kind === "poll"
          ? "没有新信。调用 wait_for_mail 等信。"
          : "没有新信。直接结束本回合，有新信时会叫醒你。",
    };
  }

  ack(agent: string, sessionId: string | undefined, ids: string[]): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const mine = ids.filter((id) => this.store.mail(id)?.to_agent === agent);
    this.store.setMailStatus(mine, "acked");
    this.log("mail_acked", { agent, ids: mine });
    this.onChange();
    return { ok: true, acked: mine.length };
  }

  /** Poll fallback for agents without a doorbell. Keeps M0's gap metrics. */
  async waitForMail(agent: string, sessionId: string | undefined, signal: AbortSignal, onTick?: (n: number) => void): Promise<Result> {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const p = this.presence.get(agent)!;
    const started = Date.now();
    p.waitCalls++;
    const gap = p.lastReturnAt ? started - p.lastReturnAt : undefined;
    if (gap !== undefined) {
      p.maxGapMs = Math.max(p.maxGapMs, gap);
      p.totalGapMs += gap;
      p.gapCount++;
    }
    this.log("wait_call", { agent, n: p.waitCalls, gapMs: gap });
    if (this.store.mailByStatus(agent, [...LIVE_MAIL]).length) return this.fetchInbox(agent, sessionId);

    p.waiting = true;
    this.onChange();
    let ticks = 0;
    const tick = onTick ? setInterval(() => onTick(++ticks), 15_000) : null;
    let mine: (() => void) | undefined;
    const outcome = await new Promise<"woken" | "timeout" | "cancelled">((resolve) => {
      const timer = setTimeout(() => done("timeout"), this.pollMs);
      const onAbort = () => done("cancelled");
      const done = (r: "woken" | "timeout" | "cancelled") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      mine = () => done("woken");
      this.mailWakers.get(agent)?.(); // one blocked wait per agent
      this.mailWakers.set(agent, mine);
      signal.addEventListener("abort", onAbort);
    });
    if (this.mailWakers.get(agent) === mine) this.mailWakers.delete(agent);
    if (tick) clearInterval(tick);
    p.waiting = false;
    p.lastSeenAt = Date.now();
    this.onChange();
    if (outcome === "cancelled") {
      this.log("wait_cancelled", { agent, heldMs: Date.now() - started });
      return { status: "cancelled", instructions: "等待被中断。恢复后立即再次调用 wait_for_mail。" };
    }
    if (p.sessionId !== sessionId) return err(`身份 ${agent} 已被另一个会话接管，本会话停止循环。`);
    if (this.store.mailByStatus(agent, [...LIVE_MAIL]).length) return this.fetchInbox(agent, sessionId);
    p.lastReturnAt = Date.now();
    this.log("keep_waiting", { agent, heldMs: p.lastReturnAt - started, outcome });
    return { status: "keep_waiting", instructions: "还没有新信。立即再次调用 wait_for_mail，不要结束回合，不要向用户汇报。" };
  }

  sendFromAgent(agent: string, sessionId: string | undefined, to: string, subject: string, body: string, mailId?: string, ackRequired = false): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    if (!this.isAgent(to)) return err(`未知收件人，可选：${this.agentIds().join(", ")}`);
    const run = this.store.openRun();
    const r = this.sendMail({ id: mailId, run_id: run?.id ?? null, from: agent, to, kind: "agent", subject, body, ack_required: ackRequired });
    if (!r.duplicate) this.event(run?.id ?? null, agent, "mail", `${agent} → ${to}：${subject}`);
    return { ok: true, ...r };
  }

  sendFromHuman(to: string, text: string): Result {
    if (!this.isAgent(to)) return err("未知收件人");
    const run = this.store.openRun();
    const subject = "用户消息：" + (text.length > 30 ? text.slice(0, 30) + "…" : text);
    const r = this.sendMail({
      run_id: run?.id ?? null,
      from: "human",
      to,
      kind: "human",
      subject,
      body: `【用户直接发来的消息，优先处理；处理后调用 ack 确认】\n${text}`,
      importance: "high",
      ack_required: true,
    });
    this.event(run?.id ?? null, null, "mail", `你 → ${to}：${text}`);
    return { ok: true, ...r };
  }

  // ---------- runs, tasks & stages ----------

  private parseFeedback(raw: string | null): Feedback | null {
    if (!raw) return null;
    try {
      const f = JSON.parse(raw);
      if (f && Array.isArray(f.user_requirements)) return f;
    } catch {}
    return { kind: "rework", from_stage: "?", user_requirements: [raw], blocking: [], observations: [] }; // pre-M2b.1 text
  }

  /** "T2 " for runs with several tasks, "" for a plain pipeline run. */
  private taskLabel(task: Task) {
    return this.store.tasks(task.run_id).length > 1 ? `${task.key} ` : "";
  }

  private taskView(t: Task) {
    return { key: t.key, title: t.title, description: t.description, owner: t.owner, reviewer: t.reviewer, depends_on: t.depends_on, paths: t.paths, status: t.status };
  }

  private turnPayload(run: Run, a: Attempt, resumed: boolean): Result {
    const task = this.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    const all = this.store.tasks(run.id);
    const multi = all.length > 1;
    const handoffs = this.store.taskHandoffs(task.id);
    const input = handoffs.at(-1) ?? null;
    const fb = this.parseFeedback(a.feedback);
    const fbGuide: Record<Feedback["kind"], string> = {
      rework:
        "这是一次返工：user_requirements（用户要求）和 blocking（阻塞问题）必须全部完成；observations（非阻塞观察）自行判断，不做也可以。只做这些要求需要的最小改动。",
      approval_note: "用户批准上一阶段时附了要求（user_requirements），请一并满足。",
      carried:
        "本轮是返工后的复审：重点核对 user_requirements 和 blocking 是否都已满足，同时回归原有验收标准。",
    };
    const owned = task.stages.filter((s) => s.owns?.length).map((s) => `${s.id}：${s.owns!.join("、")}`);
    const deps = all.filter((t) => task.depends_on.includes(t.key));
    const meeting = run.meeting_id ? this.store.meeting(run.meeting_id) : undefined;
    const parallel = all.filter((t) => t.id !== task.id && t.status === "active").map((t) => `${t.key}（${t.owner}）：${t.paths.join("、") || "未声明范围"}`);
    return {
      resumed,
      run: { id: run.id, goal: run.goal },
      task: multi || meeting ? this.taskView(task) : undefined,
      stage: { id: stage.id, role: stage.role, instructions: stage.instructions ?? null, needs_approval: stage.gate, owns: stage.owns ?? [] },
      feedback: fb,
      input_handoff: input && { from: `${input.agent}/${input.stage_id}`, commit: input.commit_sha, ...input.data },
      earlier_handoffs: handoffs.slice(0, -1).map((h) => `${h.agent}/${h.stage_id}：${h.data.summary}`),
      dependencies: deps.map((t) => {
        const last = this.store.taskHandoffs(t.id).at(-1);
        return { key: t.key, title: t.title, status: t.status, summary: last?.data.summary ?? null, commit: last?.commit_sha ?? null, files_changed: last?.data.files_changed ?? [] };
      }),
      meeting_minutes: meeting?.doc_path ?? undefined,
      parallel_tasks: parallel.length ? parallel : undefined,
      instructions:
        (resumed ? "这是你之前领到但还没提交的阶段，请继续完成。" : "") +
        `你现在负责${multi ? `任务「${task.key}：${task.title}」的` : ""}阶段「${stage.id}：${stage.role}」。完成后调用 submit_handoff，并在 files_changed 里列全你改动的文件。` +
        (meeting?.doc_path ? `会议纪要在 ${meeting.doc_path}，有疑问先读它。` : "") +
        (task.paths.length ? `本任务的文件范围（已为它租下）：${task.paths.join("、")}。` : "") +
        (parallel.length
          ? "有其他任务在并行：只改本任务范围内的文件；确实要改范围外的文件，先调用 reserve_paths。提交时桥只提交本任务范围内的文件和你在 files_changed 里声明的文件。"
          : "") +
        (fb ? fbGuide[fb.kind] : "") +
        (owned.length ? `文件分工（${owned.join("；")}）：改动其他阶段负责的文件时，请在交接单 notes_for_next 里说明原因。` : "") +
        (stage.on_reject ? "这是审查阶段：verdict 填 approve 或 reject；review_comments 只写必须修改的阻塞问题，不影响通过的建议写进 observations。" : ""),
    };
  }

  /** After a (re)join: re-mail an in-progress task that has no unfetched mail, then deliver the next ready one. */
  private resendLiveTask(agent: string) {
    const run = this.store.openRun();
    if (!run) return;
    for (const a of this.store.agentAttempts(run.id, agent, ["in_progress"])) {
      const pending = this.store.taskMailFor(a.id).some((m) => (LIVE_MAIL as readonly string[]).includes(m.status));
      if (!pending) this.sendTaskMail(run.id, a, "（继续）");
    }
    this.deliver(agent);
  }

  private sendTaskMail(run_id: number, a: Attempt, suffix = "") {
    const task = this.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    this.sendMail({
      run_id,
      attempt_id: a.id,
      from: "bridge",
      to: a.agent,
      kind: "task",
      subject: `任务：${this.taskLabel(task)}${stage.id}（${stage.role}）${suffix}`,
      body: "",
      ack_required: true,
    });
  }

  /** One task at a time per agent: mail its oldest ready attempt once it has nothing in progress or in its inbox. */
  private deliver(agent: string) {
    const run = this.store.openRun();
    if (!run) return;
    if (this.store.agentAttempts(run.id, agent, ["in_progress"]).length) return;
    const ready = this.store.agentAttempts(run.id, agent, ["ready"]);
    if (!ready.length) return;
    const mailed = ready.some((a) => this.store.taskMailFor(a.id).some((m) => [...LIVE_MAIL, "fetched"].includes(m.status as any)));
    if (!mailed) this.sendTaskMail(run.id, ready[0]);
  }

  private guardIdle(): string | null {
    const open = this.store.openRun();
    if (open) return `已有任务 #${open.id} 在进行中，请先停止它。`;
    const m = this.store.openMeeting();
    if (m) return `会议 #${m.id}「${m.topic}」还没结束，请先定稿或取消它。`;
    return null;
  }

  startRun(goal: string): Result {
    const busy = this.guardIdle();
    if (busy) return err(busy);
    const run = this.store.createRun(goal);
    const stages = this.pipelineStages();
    this.store.createTask(run.id, { key: "T1", title: goal, description: "", owner: stages[0].agent, reviewer: null, depends_on: [], paths: [], stages });
    this.log("run_start", { run: run.id, goal });
    this.event(run.id, null, "run", `任务 #${run.id} 开始：${goal}`);
    this.schedule(run.id);
    return { ok: true, run_id: run.id };
  }

  stopRun(): Result {
    const run = this.store.openRun();
    if (!run) return err("当前没有进行中的任务。");
    for (const a of this.store.attempts(run.id))
      if (["ready", "in_progress", "awaiting_approval"].includes(a.status)) {
        this.store.updateAttempt(a.id, { status: "cancelled", ended_at: new Date().toISOString() });
        const open = this.store.taskMailFor(a.id).filter((m) => (LIVE_MAIL as readonly string[]).includes(m.status));
        this.store.setMailStatus(open.map((m) => m.id), "void");
      }
    for (const t of this.store.tasks(run.id)) if (t.status === "pending" || t.status === "active") this.store.setTaskStatus(t.id, "cancelled");
    this.store.releaseLeasesOfRun(run.id);
    this.taskWaits.clear();
    this.store.setRunStatus(run.id, "stopped");
    this.log("run_stop", { run: run.id });
    this.event(run.id, null, "run", `任务 #${run.id} 已停止`);
    return { ok: true };
  }

  /** Start every task whose dependencies are done and whose paths are free; finish the run when all tasks are. */
  private schedule(run_id: number) {
    const run = this.store.run(run_id);
    if (!run || (run.status !== "active" && run.status !== "awaiting_approval")) return;
    const tasks = this.store.tasks(run_id);
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    for (const t of tasks) {
      if (t.status !== "pending") continue;
      if (!t.depends_on.every((k) => byKey.get(k)?.status === "done")) continue;
      const conflicts = this.leaseConflicts(t.paths, { agent: t.owner, taskId: t.id, exclusive: true });
      if (conflicts.length) {
        const why = `等文件租约：${conflicts.map((c) => `${c.lease_glob}（${c.held_by}${c.task ? "/" + c.task : ""}）`).join("、")}`;
        if (this.taskWaits.get(t.id) !== why) this.event(run_id, null, "lease", `${t.key} ${why}`);
        this.taskWaits.set(t.id, why);
        continue;
      }
      this.taskWaits.delete(t.id);
      this.store.setTaskStatus(t.id, "active");
      t.status = "active";
      for (const g of t.paths) this.store.addLease({ run_id, task_id: t.id, agent: t.owner, glob: normGlob(g), exclusive: 1, reason: `任务 ${t.key}`, expires_at: null });
      if (tasks.length > 1) this.event(run_id, null, "task", `${t.key}「${t.title}」开始（${t.owner}）`);
      this.log("task_start", { run: run_id, task: t.key, owner: t.owner, paths: t.paths });
      this.assign(run, t, t.stages[0], null);
    }
    const left = this.store.tasks(run_id).filter((t) => t.status === "pending" || t.status === "active");
    if (!left.length) {
      this.store.setRunStatus(run_id, "done");
      this.taskWaits.clear();
      this.log("run_done", { run: run_id });
      this.event(run_id, null, "run", `任务 #${run_id} 完成`);
      this.notifyHuman("协作桥：任务完成", `#${run_id} ${run.goal}`);
      return;
    }
    this.refreshRunStatus(run_id);
  }

  /** awaiting_approval when everything live is waiting at a gate, otherwise active. */
  private refreshRunStatus(run_id: number) {
    const run = this.store.run(run_id);
    if (!run || (run.status !== "active" && run.status !== "awaiting_approval")) return;
    const live = this.store.liveAttempts(run_id);
    const next = live.length && live.every((a) => a.status === "awaiting_approval") ? "awaiting_approval" : "active";
    if (next !== run.status) this.store.setRunStatus(run_id, next);
  }

  private assign(run: Run, task: Task, stage: TaskStage, feedback: Feedback | null) {
    const a = this.store.createAttempt(run.id, task.id, stage.id, stage.agent, feedback ? JSON.stringify(feedback) : null);
    this.log("stage_assigned", { run: run.id, task: task.key, stage: stage.id, agent: stage.agent, attempt: a.id, agentStatus: this.status(stage.agent) });
    this.deliver(stage.agent);
    this.refreshRunStatus(run.id);
  }

  private advance(run: Run, task: Task, fromStage: string, feedback: Feedback | null) {
    const i = task.stages.findIndex((s) => s.id === fromStage);
    const next = task.stages[i + 1];
    if (next) return this.assign(run, task, next, feedback);
    this.store.setTaskStatus(task.id, "done");
    this.store.releaseLeasesOfTask(task.id);
    this.log("task_done", { run: run.id, task: task.key });
    if (this.store.tasks(run.id).length > 1) this.event(run.id, null, "task", `${task.key}「${task.title}」完成`);
    this.schedule(run.id);
  }

  /** Decide what the handoff commits and what to tell the human about scope. */
  private async scopeAndCommit(run: Run, task: Task, stage: TaskStage, agent: string, data: HandoffData) {
    const changed = await changedFiles(this.cfg.projectDir);
    const declared = new Set(data.files_changed.map(norm));
    const parallel = this.store.tasks(run.id).some((t) => t.id !== task.id && t.status === "active");
    const review = !!data.verdict || stage.id === "review";
    const leases = this.activeLeases();
    const mine = (l: Lease) => l.task_id === task.id || (l.agent === agent && (l.task_id === null || l.task_id === task.id));
    const otherLeases = leases.filter((l) => !mine(l));
    const ownGlobs = [...task.paths, ...leases.filter(mine).map((l) => l.glob)];
    const holderOf = (f: string) => otherLeases.find((l) => inGlob(l.glob, f));
    const scope_notes: string[] = [];

    let toCommit: string[] | null = null; // legacy unscoped pipeline handoff
    let considered = changed;
    if (parallel || ownGlobs.length || review) {
      const taken: string[] = [];
      const outside: string[] = [];
      toCommit = [];
      for (const f of changed) {
        const holder = holderOf(f);
        const ownsIt = declared.has(norm(f)) || (!review && ownGlobs.some((g) => inGlob(g, f)));
        if (holder) {
          if (declared.has(norm(f))) taken.push(`${f}（${holder.agent}${holder.task_id ? "/" + this.store.task(holder.task_id)?.key : ""}）`);
        } else if (ownsIt) toCommit.push(f);
        else outside.push(f);
      }
      considered = toCommit;
      if (taken.length) scope_notes.push(`声明的文件属于其他任务的租约，没有提交：${taken.join("、")}`);
      if (outside.length) {
        const why = review ? "审查交接未声明这些改动" : "改动不在本任务范围、也没在交接单里声明";
        scope_notes.push(`${why}，没有提交：${outside.join("、")}`);
      }
    }
    const undeclared = data.files_changed.length ? considered.filter((f) => !declared.has(norm(f))) : [];
    if (undeclared.length) scope_notes.push(`改动了但没在交接单里声明：${undeclared.join("、")}`);
    for (const other of task.stages) {
      if (other.id === stage.id || !other.owns?.length || stage.owns?.some((g) => other.owns!.includes(g))) continue;
      const hit = considered.filter((f) => other.owns!.some((g) => globMatch(g, f)) && !stage.owns?.some((g) => globMatch(g, f)));
      if (hit.length) scope_notes.push(`改动了「${other.id}」阶段负责的文件：${hit.join("、")}`);
    }

    let commit_sha: string | null = null;
    let commit_error: string | null = null;
    if (this.cfg.git.auto_commit) {
      const multi = this.store.tasks(run.id).length > 1;
      const verdictText = data.verdict === "approve" ? "审查通过 — " : data.verdict === "reject" ? "审查打回 — " : "";
      const subject = `[bridge] ${multi ? task.key + " " : ""}${stage.id} by ${agent}: ${verdictText}${data.summary}`.slice(0, 120);
      const bodyParts = [`run #${run.id}: ${run.goal}`];
      if (multi) bodyParts.push(`task ${task.key}: ${task.title}`);
      if (data.review_comments?.length) bodyParts.push("阻塞问题：\n- " + data.review_comments.join("\n- "));
      if (data.observations?.length) bodyParts.push("观察：\n- " + data.observations.join("\n- "));
      if (data.notes_for_next) bodyParts.push(data.notes_for_next);
      if (scope_notes.length) bodyParts.push("范围提示：\n- " + scope_notes.join("\n- "));
      const body = bodyParts.join("\n\n").slice(0, 6000);
      const allowEmpty = !!data.verdict && this.cfg.git.commit_reviews;
      const r = toCommit
        ? await commitPaths(this.cfg.projectDir, toCommit.map((f) => `:(top,literal)${f}`), subject, body, { allowEmpty })
        : await commitAll(this.cfg.projectDir, subject, body, { allowEmpty });
      if ("sha" in r) commit_sha = r.sha;
      else if ("error" in r) commit_error = r.error;
      else commit_error = `未提交：${r.skipped}`;
    }
    return { commit_sha, commit_error, scope_notes, scoped: !!toCommit };
  }

  async submitHandoff(agent: string, sessionId: string | undefined, data: HandoffData, taskKey?: string): Promise<Result> {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.store.openRun();
    const mineNow = run ? this.store.agentAttempts(run.id, agent, ["in_progress"]) : [];
    const a = taskKey ? mineNow.find((x) => this.store.task(x.task_id)?.key === taskKey) : mineNow[0];
    if (!run || !a)
      return err(
        taskKey && mineNow.length
          ? `你正在进行的任务里没有「${taskKey}」。`
          : "当前没有分配给你、正在进行的阶段，不能提交。请先调用 fetch_inbox 看有没有任务信。",
      );
    const task = this.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    const { commit_sha, commit_error, scope_notes } = await this.scopeAndCommit(run, task, stage, agent, data);

    const h = this.store.addHandoff({ run_id: run.id, attempt_id: a.id, stage_id: stage.id, agent, data, commit_sha, commit_error, scope_notes });
    const label = this.taskLabel(task);
    if (scope_notes.length) this.event(run.id, agent, "scope", `「${label}${stage.id}」交接的范围提示：${scope_notes.join("；")}`);
    this.store.setMailStatus(this.store.taskMailFor(a.id).filter((m) => m.status !== "void").map((m) => m.id), "acked");
    const ended = new Date().toISOString();
    this.presence.get(agent)!.lastReturnAt = Date.now();
    this.log("handoff", { run: run.id, task: task.key, stage: stage.id, agent, summary: data.summary, verdict: data.verdict, commit: commit_sha, commitError: commit_error });
    this.event(run.id, agent, "handoff", `${agent} 完成「${label}${stage.id}」：${data.summary}`);

    const after = this.doorbellKind(agent) === "poll" ? "立即调用 wait_for_mail 等信。" : "可以结束本回合了，有新信时会叫醒你。";
    if (stage.gate) {
      this.store.updateAttempt(a.id, { status: "awaiting_approval", handoff_id: h.id, ended_at: ended });
      this.refreshRunStatus(run.id);
      this.event(run.id, null, "gate", `「${label}${stage.id}」等待你在面板上审批`);
      this.notifyHuman("协作桥：等你审批", `${agent} 完成了「${label}${stage.id}」：${data.summary}`);
      this.deliver(agent);
      return { status: "submitted", commit: commit_sha, commit_note: commit_error, scope_notes, next: "等待用户在面板上审批", instructions: "已提交。" + after };
    }
    this.store.updateAttempt(a.id, { status: "done", handoff_id: h.id, ended_at: ended });
    // A rework round's requirements travel on, so the next reviewer knows what this round was for.
    const fb = this.parseFeedback(a.feedback);
    this.advance(run, task, stage.id, fb && fb.kind !== "approval_note" ? { ...fb, kind: "carried" } : null);
    this.deliver(agent);
    const nextLive = this.store.taskLiveAttempt(task.id);
    const runNow = this.store.run(run.id)!;
    return {
      status: "submitted",
      commit: commit_sha,
      commit_note: commit_error,
      scope_notes,
      next: nextLive ? `${nextLive.agent}/${nextLive.stage_id}` : runNow.status === "done" ? "任务完成" : `${task.key} 完成`,
      instructions: "已交接。" + after,
    };
  }

  decide(attemptId: number, action: "approve" | "reject", note: string): Result {
    const a = this.store.attempt(attemptId);
    if (!a || a.status !== "awaiting_approval") return err("这个阶段不在等待审批。");
    const run = this.store.run(a.run_id)!;
    const task = this.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    const label = this.taskLabel(task);
    const h = a.handoff_id ? this.store.handoff(a.handoff_id) : undefined;
    const trimmed = note.trim();
    this.store.updateAttempt(a.id, { status: action === "approve" ? "approved" : "rejected", decided_note: trimmed || null });
    this.log("gate_decision", { run: run.id, task: task.key, stage: stage.id, attempt: a.id, action, note: trimmed });

    if (action === "approve") {
      this.event(run.id, null, "gate", `你批准了「${label}${stage.id}」${trimmed ? "：" + trimmed : ""}`);
      this.advance(
        run,
        task,
        stage.id,
        trimmed ? { kind: "approval_note", from_stage: stage.id, user_requirements: [trimmed], blocking: [], observations: [] } : null,
      );
    } else {
      const target = this.stageOf(task, stage.on_reject ?? stage.id);
      const comments = h?.data.review_comments ?? [];
      const rejected = h?.data.verdict === "reject";
      // Review comments are blocking only when the reviewer itself rejected; otherwise they are observations.
      const fb: Feedback = {
        kind: "rework",
        from_stage: stage.id,
        user_requirements: trimmed ? [trimmed] : [],
        blocking: rejected ? comments : [],
        observations: [...(rejected ? [] : comments), ...(h?.data.observations ?? [])],
      };
      this.event(run.id, null, "gate", `你打回了「${label}${stage.id}」→「${target.id}」${trimmed ? "：" + trimmed : ""}`);
      this.assign(run, task, target, fb);
    }
    this.refreshRunStatus(run.id);
    return { ok: true };
  }

  // ---------- file leases ----------

  /** Unreleased leases that still count: no expiry (task leases) or not yet expired. */
  private activeLeases(): Lease[] {
    const now = Date.now();
    return this.store.openLeases().filter((l) => !l.expires_at || Date.parse(l.expires_at) > now);
  }

  /** Leases held by someone else that collide with `globs`. A lease collides when either side is exclusive. */
  private leaseConflicts(globs: string[], who: { agent: string; taskId?: number | null; exclusive: boolean }) {
    const out: { glob: string; lease_id: number; lease_glob: string; held_by: string; task: string | null; expires_at: string | null }[] = [];
    if (!globs.length) return out;
    for (const l of this.activeLeases()) {
      if (who.taskId != null && l.task_id === who.taskId) continue;
      if (l.agent === who.agent && (l.task_id === null || l.task_id === who.taskId)) continue;
      if (!who.exclusive && !l.exclusive) continue;
      for (const g of globs)
        if (globsOverlap(g, l.glob))
          out.push({ glob: g, lease_id: l.id, lease_glob: l.glob, held_by: l.agent, task: l.task_id ? (this.store.task(l.task_id)?.key ?? null) : null, expires_at: l.expires_at });
    }
    return out;
  }

  private currentTask(agent: string): Task | undefined {
    const run = this.store.openRun();
    if (!run) return undefined;
    const a = this.store.agentAttempts(run.id, agent, ["in_progress"])[0] ?? this.store.agentAttempts(run.id, agent, ["ready", "awaiting_approval"])[0];
    return a ? this.store.task(a.task_id) : undefined;
  }

  reservePaths(agent: string, sessionId: string | undefined, globs: string[], exclusive = true, ttlSeconds?: number, reason = ""): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const clean = [...new Set(globs.map(normGlob).filter(Boolean))];
    if (!clean.length) return err("globs 不能为空。");
    const run = this.store.openRun();
    const task = this.currentTask(agent);
    const conflicts = this.leaseConflicts(clean, { agent, taskId: task?.id ?? null, exclusive });
    if (conflicts.length) {
      for (const holder of new Set(conflicts.map((c) => c.held_by))) {
        if (holder === agent) continue;
        const mine = conflicts.filter((c) => c.held_by === holder);
        this.sendMail({
          id: `conflict-${agent}-${mine.map((c) => c.lease_id).join("_")}-${clean.join(",")}`.slice(0, 200),
          run_id: run?.id ?? null,
          from: "bridge",
          to: holder,
          kind: "system",
          subject: `文件冲突：${agent} 想改 ${mine.map((c) => c.lease_glob).join("、")}`,
          body:
            `${agent}${task ? `（任务 ${task.key}）` : ""} 想租下 ${clean.join("、")}${reason ? `，原因：${reason}` : ""}，和你持有的租约冲突：` +
            mine.map((c) => `${c.lease_glob}${c.task ? `（任务 ${c.task}）` : ""}`).join("、") +
            "。如果你已经不需要这部分文件，调用 release_paths 释放；否则用 send_mail 和对方商量。不需要回复这封信。",
        });
      }
      this.log("lease_conflict", { agent, globs: clean, conflicts });
      this.event(run?.id ?? null, agent, "lease", `${agent} 申请 ${clean.join("、")} 冲突：${conflicts.map((c) => `${c.lease_glob}（${c.held_by}）`).join("、")}`);
      return {
        granted: false,
        conflicts,
        instructions: "这些文件已被其他成员占用，没有租给你。不要修改它们；已通知占用者。可以先做别的部分，或用 send_mail 和占用者商量。",
      };
    }
    const ttl = ttlSeconds ?? this.cfg.leases.default_ttl_seconds;
    const expires = new Date(Date.now() + ttl * 1000).toISOString();
    const open = this.store.openLeases().filter((l) => l.agent === agent && l.expires_at);
    const granted: Result[] = [];
    for (const g of clean) {
      const same = open.find((l) => l.glob.toLowerCase() === g.toLowerCase() && l.task_id === (task?.id ?? null));
      if (same) this.store.setLeaseExpiry(same.id, expires);
      const id = same?.id ?? this.store.addLease({ run_id: run?.id ?? null, task_id: task?.id ?? null, agent, glob: g, exclusive: exclusive ? 1 : 0, reason, expires_at: expires });
      granted.push({ lease_id: id, glob: g, exclusive, expires_at: expires, renewed: !!same });
    }
    this.log("lease_granted", { agent, globs: clean, task: task?.key, ttl });
    this.event(run?.id ?? null, agent, "lease", `${agent} 租下 ${clean.join("、")}${exclusive ? "（独占）" : "（共享）"}，${Math.round(ttl / 60)} 分钟`);
    return {
      granted: true,
      leases: granted,
      instructions: `已租给你，${Math.round(ttl / 60)} 分钟后到期（再调用一次即续期）。${task ? `任务 ${task.key} 结束时自动释放。` : ""}用完可调用 release_paths 提前释放。`,
    };
  }

  releasePaths(agent: string, sessionId: string | undefined, globs?: string[]): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const want = globs?.length ? new Set(globs.map((g) => normGlob(g).toLowerCase())) : null;
    const mine = this.store.openLeases().filter((l) => l.agent === agent && l.expires_at && (!want || want.has(l.glob.toLowerCase())));
    for (const l of mine) this.store.releaseLease(l.id);
    this.log("lease_released", { agent, ids: mine.map((l) => l.id) });
    if (mine.length) this.event(null, agent, "lease", `${agent} 释放了 ${mine.map((l) => l.glob).join("、")}`);
    const run = this.store.openRun();
    if (run) this.schedule(run.id);
    return {
      ok: true,
      released: mine.map((l) => l.glob),
      note: "任务自带的租约（任务的 paths）在任务结束时自动释放，这里不能提前释放。",
    };
  }

  // ---------- meetings ----------

  private meetingMailId(meetingId: number, round: number, agent: string) {
    return `meeting-${meetingId}-${round}-${agent}`;
  }
  private meetingMailRef(id: string) {
    const m = /^meeting-(\d+)-(\d+)-(.+)$/.exec(id);
    return m ? { meeting: Number(m[1]), round: Number(m[2]), agent: m[3] } : null;
  }
  private expectedSpeakers(m: Meeting) {
    return m.round_kind === "final" ? [m.facilitator] : m.participants;
  }

  private meetingPayload(m: Meeting, agent: string): Result {
    const turns = this.store.meetingTurns(m.id);
    const rounds: Result[] = [];
    for (let r = 1; r < m.round; r++) {
      const ts = turns.filter((t) => t.round === r);
      if (!ts.length) continue;
      rounds.push({
        round: r,
        kind: ts[0].kind,
        turns: ts.map((t) => ({ agent: t.agent, content: t.content, tasks: t.tasks ?? undefined, decisions: t.decisions.length ? t.decisions : undefined })),
      });
    }
    const taskSpec =
      "tasks 是任务清单，每项：id（如 T1）、title、description（要做什么、验收标准）、owner（负责人，可选：" +
      this.agentIds().join("、") +
      "）、reviewer（审查人，可选，留空则不审查）、depends_on（依赖的任务 id）、paths（预计改动的文件 glob，例如 src/ui/**；并行任务的 paths 不要重叠，桥按它分配文件租约）。";
    const guide: Record<MeetingTurnKind, string> = {
      proposal:
        "这是第 1 轮：提案。独立给出你的方案：思路、关键决策和理由、风险。可以附一份任务拆分草案（tasks，可选）。先读项目代码再提案，不要改任何文件。",
      critique:
        "这是互评轮。逐条评价上一轮各方（包括你自己）的方案：同意什么、反对什么、为什么，以及你修正后的立场。不要改任何文件。",
      final:
        "这是定稿轮，由你负责。综合各轮讨论写出最终方案（content）、关键决策（decisions，每项 what + why）和任务清单（tasks，必填）。" +
        "任务之间能并行就并行，有先后关系的用 depends_on 表示；尽量让每个任务的 paths 互不重叠。不要改任何文件。",
    };
    return {
      meeting_id: m.id,
      topic: m.topic,
      round: m.round,
      kind: m.round_kind,
      participants: m.participants,
      facilitator: m.facilitator,
      you: agent,
      human_note: m.round_note ?? undefined,
      previous_rounds: rounds,
      instructions:
        guide[m.round_kind] +
        (m.round_note ? "用户对本轮的要求见 human_note，必须回应。" : "") +
        (m.round_kind === "final" || m.round_kind === "proposal" ? taskSpec : "") +
        `写完后调用 submit_meeting_turn(agent_id, meeting_id=${m.id}, content${m.round_kind === "final" ? ", decisions, tasks" : m.round_kind === "proposal" ? ", tasks?" : ""})。`,
    };
  }

  private sendRoundMail(m: Meeting) {
    for (const agent of this.expectedSpeakers(m))
      this.sendMail({
        id: this.meetingMailId(m.id, m.round, agent),
        from: "bridge",
        to: agent,
        kind: "meeting",
        subject: `会议「${m.topic.slice(0, 30)}」第 ${m.round} 轮：${KIND_LABEL[m.round_kind]}`,
        body: "",
        ack_required: true,
      });
  }

  private voidRoundMail(m: Meeting) {
    const open = this.store.mailWithPrefix(`meeting-${m.id}-`).filter((x) => [...LIVE_MAIL, "fetched"].includes(x.status as any));
    this.store.setMailStatus(open.map((x) => x.id), "void");
  }

  startMeeting(topic: string, participants?: string[], facilitator?: string): Result {
    const t = topic.trim();
    if (!t) return err("议题不能为空。");
    const busy = this.guardIdle();
    if (busy) return err(busy);
    const parts = participants?.length ? [...new Set(participants)] : this.agentIds();
    const bad = parts.filter((p) => !this.isAgent(p));
    if (bad.length) return err(`未知成员：${bad.join("、")}`);
    const fac = facilitator || this.cfg.meetings.facilitator || parts[0];
    if (!this.isAgent(fac)) return err(`未知主持人：${fac}`);
    if (!parts.includes(fac)) parts.push(fac);
    const m = this.store.createMeeting(t, parts, fac);
    this.log("meeting_start", { meeting: m.id, topic: t, participants: parts, facilitator: fac });
    this.event(null, null, "meeting", `会议 #${m.id} 开始：${t}（${parts.join("、")}，定稿：${fac}）`);
    this.sendRoundMail(m);
    return { ok: true, meeting_id: m.id };
  }

  /** Problems with a planned task list; empty = fine. */
  validatePlan(tasks: PlannedTask[]): string[] {
    const errs: string[] = [];
    if (!tasks.length) errs.push("tasks 不能为空。");
    const ids = new Set<string>();
    for (const t of tasks) {
      if (!/^[\w-]+$/.test(t.id ?? "")) errs.push(`任务 id「${t.id}」只能包含字母、数字、_ 和 -。`);
      if (ids.has(t.id)) errs.push(`任务 id 重复：${t.id}`);
      ids.add(t.id);
      if (!t.title?.trim()) errs.push(`${t.id}：title 不能为空。`);
      if (!this.isAgent(t.owner)) errs.push(`${t.id}：owner「${t.owner}」不是成员（可选：${this.agentIds().join("、")}）。`);
      if (t.reviewer && !this.isAgent(t.reviewer)) errs.push(`${t.id}：reviewer「${t.reviewer}」不是成员。`);
    }
    for (const t of tasks)
      for (const d of t.depends_on ?? []) {
        if (d === t.id) errs.push(`${t.id} 不能依赖自己。`);
        else if (!ids.has(d)) errs.push(`${t.id} 依赖的「${d}」不在任务清单里。`);
      }
    // Cycle check (DFS).
    const graph = new Map(tasks.map((t) => [t.id, t.depends_on ?? []]));
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, trail: string[]): boolean => {
      if (state.get(id) === 2) return false;
      if (state.get(id) === 1) {
        errs.push(`依赖成环：${[...trail, id].join(" → ")}`);
        return true;
      }
      state.set(id, 1);
      for (const d of graph.get(id) ?? []) if (graph.has(d) && visit(d, [...trail, id])) return true;
      state.set(id, 2);
      return false;
    };
    for (const id of graph.keys()) if (visit(id, [])) break;
    return errs;
  }

  submitMeetingTurn(
    agent: string,
    sessionId: string | undefined,
    meetingId: number,
    content: string,
    tasks?: PlannedTask[],
    decisions: { what: string; why: string }[] = [],
  ): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const m = this.store.meeting(meetingId);
    if (!m) return err(`会议 #${meetingId} 不存在。`);
    if (m.status !== "collecting") return err(`会议 #${m.id} 现在不收发言（状态：${m.status}）。`);
    if (!this.expectedSpeakers(m).includes(agent)) return err(`第 ${m.round} 轮（${KIND_LABEL[m.round_kind]}）不需要你发言。`);
    const turns = this.store.meetingTurns(m.id);
    if (turns.some((t) => t.round === m.round && t.agent === agent)) return err(`第 ${m.round} 轮你已经发过言了。`);
    if (!content.trim()) return err("content 不能为空。");
    const planned = tasks?.map((t) => ({ ...t, depends_on: t.depends_on ?? [], paths: t.paths ?? [], description: t.description ?? "", reviewer: t.reviewer || null }));
    if (m.round_kind === "final") {
      const problems = this.validatePlan(planned ?? []);
      if (problems.length) return { error: "任务清单有问题，请修改后重新提交。", problems };
    }
    this.store.addMeetingTurn({ meeting_id: m.id, round: m.round, kind: m.round_kind, agent, content: content.trim(), tasks: planned ?? null, decisions });
    this.store.setMailStatus([this.meetingMailId(m.id, m.round, agent)], "acked");
    this.presence.get(agent)!.lastReturnAt = Date.now();
    this.log("meeting_turn", { meeting: m.id, round: m.round, kind: m.round_kind, agent, tasks: planned?.length ?? 0 });
    this.event(null, agent, "meeting", `${agent} 在会议 #${m.id} 第 ${m.round} 轮${KIND_LABEL[m.round_kind]}发言`);

    const spoken = new Set([...turns.filter((t) => t.round === m.round).map((t) => t.agent), agent]);
    const complete = this.expectedSpeakers(m).every((a) => spoken.has(a));
    if (complete) {
      if (m.round_kind === "final") {
        this.store.updateMeeting(m.id, { status: "awaiting_approval" });
        this.event(null, null, "meeting", `会议 #${m.id} 定稿完成，等你批准`);
        this.notifyHuman("协作桥：会议定稿等你批准", `${m.topic}（${planned?.length ?? 0} 个任务）`);
      } else {
        this.store.updateMeeting(m.id, { status: "review" });
        this.event(null, null, "meeting", `会议 #${m.id} 第 ${m.round} 轮发言已齐，等你决定：再互评一轮或定稿`);
        this.notifyHuman("协作桥：会议发言已齐", `${m.topic} 第 ${m.round} 轮`);
      }
    }
    const after = this.doorbellKind(agent) === "poll" ? "立即调用 wait_for_mail 等信。" : "可以结束本回合了，下一轮开始时会叫醒你。";
    return { status: "submitted", round: m.round, waiting_for: this.expectedSpeakers(m).filter((a) => !spoken.has(a)), instructions: "已发言。" + after };
  }

  /** Human: open the next round (another critique, or the final plan). Allowed while some are still silent. */
  meetingNext(meetingId: number, action: "critique" | "finalize", note: string): Result {
    const m = this.store.meeting(meetingId);
    if (!m || !["collecting", "review"].includes(m.status)) return err("这个会议现在不能进入下一轮。");
    if (m.round_kind === "final") return err("已经在定稿了。");
    const turns = this.store.meetingTurns(m.id).filter((t) => t.round === m.round);
    if (!turns.length) return err("本轮还没有任何人发言。");
    this.voidRoundMail(m);
    const kind: MeetingTurnKind = action === "critique" ? "critique" : "final";
    this.store.updateMeeting(m.id, { status: "collecting", round: m.round + 1, round_kind: kind, round_note: note.trim() || null });
    const next = this.store.meeting(m.id)!;
    this.log("meeting_round", { meeting: m.id, round: next.round, kind });
    this.event(null, null, "meeting", `会议 #${m.id} 进入第 ${next.round} 轮：${KIND_LABEL[kind]}${note.trim() ? "（你的意见：" + note.trim() + "）" : ""}`);
    this.sendRoundMail(next);
    return { ok: true, round: next.round };
  }

  meetingCancel(meetingId: number): Result {
    const m = this.store.meeting(meetingId);
    if (!m || !["collecting", "review", "awaiting_approval"].includes(m.status)) return err("这个会议已经结束。");
    this.voidRoundMail(m);
    this.store.updateMeeting(m.id, { status: "cancelled" });
    this.log("meeting_cancel", { meeting: m.id });
    this.event(null, null, "meeting", `会议 #${m.id} 已取消`);
    return { ok: true };
  }

  /** Human: approve the final plan (minutes → git, tasks → a run) or send it back to the facilitator. */
  async meetingDecide(meetingId: number, action: "approve" | "reject", note: string): Promise<Result> {
    const m = this.store.meeting(meetingId);
    if (!m || m.status !== "awaiting_approval") return err("这个会议不在等待批准。");
    const trimmed = note.trim();
    if (action === "reject") {
      this.store.updateMeeting(m.id, { status: "collecting", round: m.round + 1, round_kind: "final", round_note: trimmed || "用户要求修改定稿。" });
      this.event(null, null, "meeting", `你打回了会议 #${m.id} 的定稿${trimmed ? "：" + trimmed : ""}`);
      this.sendRoundMail(this.store.meeting(m.id)!);
      return { ok: true };
    }
    if (this.store.openRun()) return err("已有任务在进行中，先停止它再批准。");
    const final = this.store.meetingTurns(m.id).filter((t) => t.kind === "final").at(-1);
    if (!final?.tasks?.length) return err("定稿里没有任务清单。");

    const rel = this.minutesPath(m);
    const abs = path.join(this.cfg.projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, this.minutes(m, final.tasks, final.content, final.decisions, trimmed));
    let commit: string | null = null;
    let commit_note: string | null = null;
    if (this.cfg.git.auto_commit) {
      const r = await commitPaths(this.cfg.projectDir, [`:(literal)${rel}`], `[bridge] 会议纪要：${m.topic}`.slice(0, 120), `meeting #${m.id}，${final.tasks.length} 个任务`);
      if ("sha" in r) commit = r.sha;
      else commit_note = "error" in r ? r.error : r.skipped;
    }

    const run = this.store.createRun(m.topic, m.id);
    for (const t of final.tasks)
      this.store.createTask(run.id, {
        key: t.id,
        title: t.title,
        description: t.description + (trimmed ? `\n\n用户批准会议定稿时的要求：${trimmed}` : ""),
        owner: t.owner,
        reviewer: t.reviewer || null,
        depends_on: t.depends_on,
        paths: t.paths.map(normGlob),
        stages: this.templateStages(t.owner, t.reviewer || null),
      });
    this.store.updateMeeting(m.id, { status: "done", run_id: run.id, doc_path: rel });
    this.log("meeting_approved", { meeting: m.id, run: run.id, doc: rel, commit, tasks: final.tasks.length });
    this.event(run.id, null, "meeting", `你批准了会议 #${m.id} 的定稿：纪要 ${rel}，${final.tasks.length} 个任务开始分派`);
    this.event(run.id, null, "run", `任务 #${run.id} 开始：${m.topic}`);
    this.schedule(run.id);
    return { ok: true, run_id: run.id, doc_path: rel, commit, commit_note };
  }

  private minutesPath(m: Meeting) {
    const day = new Date().toISOString().slice(0, 10);
    const slug = m.topic.replace(/[<>:"/\\|?*\u0000-\u001f#%]/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || `meeting-${m.id}`;
    const dir = this.cfg.meetings.dir.replace(/\\/g, "/").replace(/\/+$/, "");
    let rel = `${dir}/${day}-${slug}.md`;
    if (fs.existsSync(path.join(this.cfg.projectDir, rel))) rel = `${dir}/${day}-${slug}-${m.id}.md`;
    return rel;
  }

  private minutes(m: Meeting, tasks: PlannedTask[], finalContent: string, decisions: { what: string; why: string }[], note: string) {
    const turns = this.store.meetingTurns(m.id);
    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const L: string[] = [
      `# 会议纪要：${m.topic}`,
      "",
      `- 日期：${new Date().toISOString().slice(0, 10)}`,
      `- 参与：${m.participants.join("、")}（定稿：${m.facilitator}）`,
      `- 会议编号：#${m.id}`,
      "",
      "## 议题",
      "",
      m.topic,
      "",
    ];
    const rounds = [...new Set(turns.map((t) => t.round))].sort((a, b) => a - b);
    for (const r of rounds) {
      const ts = turns.filter((t) => t.round === r);
      if (ts[0].kind === "final" && r === rounds.at(-1)) continue; // the adopted final is written below
      L.push(`## 第 ${r} 轮：${KIND_LABEL[ts[0].kind]}`, "");
      for (const t of ts) {
        L.push(`### ${t.agent}`, "", t.content, "");
        if (t.tasks?.length) L.push("任务草案：" + t.tasks.map((x) => `${x.id} ${x.title}（${x.owner}）`).join("；"), "");
      }
    }
    L.push("## 定稿", "", finalContent, "");
    if (decisions.length) L.push("### 关键决策", "", ...decisions.map((d) => `- ${d.what} —— ${d.why}`), "");
    L.push("## 你的决定", "", "批准。" + (note ? note : ""), "");
    L.push("## 任务清单", "", "| 编号 | 任务 | 负责 | 审查 | 依赖 | 文件范围 |", "|---|---|---|---|---|---|");
    for (const t of tasks)
      L.push(`| ${t.id} | ${cell(t.title)} | ${t.owner} | ${t.reviewer || "—"} | ${t.depends_on.join("、") || "—"} | ${cell(t.paths.join("、")) || "—"} |`);
    L.push("");
    for (const t of tasks) L.push(`### ${t.id} ${t.title}`, "", t.description || "（无描述）", "");
    return L.join("\n");
  }

  // ---------- context, progress, notes, questions ----------

  getContext(agent: string, sessionId: string | undefined, lastN = 3): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.store.openRun();
    const tasks = run ? this.store.tasks(run.id) : [];
    const task = this.currentTask(agent);
    const handoffs = task ? this.store.taskHandoffs(task.id) : run ? this.store.handoffs(run.id) : [];
    const n = Math.max(0, Math.min(lastN, handoffs.length));
    const live = run ? (this.store.agentAttempts(run.id, agent, ["in_progress", "ready", "awaiting_approval"])[0] ?? this.store.liveAttempt(run.id)) : undefined;
    const meeting = run?.meeting_id ? this.store.meeting(run.meeting_id) : this.store.openMeeting();
    const keyOf = (id: number) => tasks.find((t) => t.id === id)?.key;
    return {
      run: run ? { id: run.id, goal: run.goal, status: run.status } : null,
      current_task: task ? this.taskView(task) : null,
      current_round: live ? { task: keyOf(live.task_id), stage: live.stage_id, agent: live.agent, status: live.status, feedback: this.parseFeedback(live.feedback) } : null,
      tasks: tasks.length > 1 ? tasks.map((t) => ({ ...this.taskView(t), description: undefined, stage: this.store.taskLiveAttempt(t.id)?.stage_id ?? null, waiting: this.taskWaits.get(t.id) })) : undefined,
      stages: run ? this.store.attempts(run.id).map((a) => ({ task: keyOf(a.task_id), stage: a.stage_id, agent: a.agent, status: a.status, gate_note: a.decided_note })) : [],
      handoffs_total: handoffs.length,
      older_handoffs: handoffs.slice(0, handoffs.length - n).map((h) => `${h.agent}/${h.stage_id}：${h.data.summary}`),
      recent_handoffs: handoffs.slice(handoffs.length - n).map((h) => ({ from: `${h.agent}/${h.stage_id}`, commit: h.commit_sha, at: h.created_at, ...h.data })),
      leases: this.activeLeases().map((l) => ({ glob: l.glob, agent: l.agent, task: l.task_id ? keyOf(l.task_id) ?? null : null, exclusive: !!l.exclusive, expires_at: l.expires_at })),
      meeting: meeting ? { id: meeting.id, topic: meeting.topic, status: meeting.status, minutes: meeting.doc_path } : null,
      notes: this.store.notes().map((x) => ({ topic: x.topic, by: x.agent, text: x.text, at: x.created_at })),
      project_dir: this.cfg.projectDir,
    };
  }

  /** Free an identity: from the panel (human) or the agent itself via `leave`. */
  release(agent: string, by: "human" | "agent", sessionId?: string): Result {
    const p = this.presence.get(agent);
    if (!p) return err("未知 agent");
    if (by === "agent") {
      const be = this.bindingError(agent, sessionId);
      if (be) return err(be);
    }
    const old = p.sessionId;
    p.sessionId = undefined;
    this.mailWakers.get(agent)?.();
    this.log("identity_released", { agent, by, session: old });
    this.event(null, agent, "join", `${agent} 的身份已释放（${by === "human" ? "你在面板上操作" : "它自己退出"}）`);
    return { ok: true, released_session: old ?? null };
  }

  reportProgress(agent: string, sessionId: string | undefined, text: string): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.store.openRun();
    this.log("progress", { agent, text });
    this.event(run?.id ?? null, agent, "progress", text);
    return { ok: true };
  }

  postNote(agent: string, sessionId: string | undefined, topic: string, text: string): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.store.openRun();
    const id = this.store.addNote(run?.id ?? null, agent, topic, text);
    this.event(run?.id ?? null, agent, "note", `[${topic}] ${text}`);
    return { ok: true, note_id: id };
  }

  readNotes(agent: string, sessionId: string | undefined, topic?: string): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    return { notes: this.store.notes(topic).map((n) => ({ topic: n.topic, by: n.agent, text: n.text, at: n.created_at })) };
  }

  /** Non-blocking: the answer arrives later as mail, so nobody sits polling for it. */
  askHuman(agent: string, sessionId: string | undefined, question: string): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    if (!question.trim()) return err("问题不能为空。");
    const run = this.store.openRun();
    const id = this.store.addQuestion(run?.id ?? null, agent, question.trim());
    this.log("ask_human", { agent, question_id: id, question });
    this.event(run?.id ?? null, agent, "question", `${agent} 提问：${question}`);
    this.notifyHuman(`协作桥：${agent} 问你`, question);
    return {
      status: "submitted",
      question_id: id,
      instructions:
        "问题已出现在用户的面板上，答复会以信件送达。能先做的部分先做；需要等答复时" +
        (this.doorbellKind(agent) === "poll" ? "调用 wait_for_mail。" : "直接结束本回合，答复到达时会叫醒你。"),
    };
  }

  answer(questionId: number, answer: string): Result {
    const q = this.store.question(questionId);
    if (!q || q.answer !== null) return err("问题不存在或已回答。");
    this.store.answerQuestion(questionId, answer);
    this.log("human_answer", { question_id: questionId });
    this.event(q.run_id, null, "answer", `你回答了 ${q.agent}：${answer}`);
    this.sendMail({
      id: `answer-${questionId}`,
      run_id: q.run_id,
      from: "human",
      to: q.agent,
      kind: "answer",
      subject: `用户回答了你的问题 #${questionId}`,
      body: `你的问题：${q.question}\n用户的回答：${answer}`,
      importance: "high",
    });
    return { ok: true };
  }

  registerCodexThread(sessionId: string, agent: string): Result {
    if (!this.isAgent(agent)) return err("未知 agent");
    this.store.registerCodexThread(sessionId, agent);
    return { ok: true };
  }

  // ---------- read model for the panel / API ----------

  snapshot() {
    const run = this.store.openRun() ?? this.store.recentRuns(1)[0];
    const attempts = run ? this.store.attempts(run.id) : [];
    const live = run ? this.store.liveAttempt(run.id) : undefined;
    const lives = run ? this.store.liveAttempts(run.id) : [];
    const handoffs = run ? this.store.handoffs(run.id) : [];
    const tasks = run ? this.store.tasks(run.id) : [];
    const keyOf = (id: number | null) => (id ? tasks.find((t) => t.id === id)?.key ?? null : null);
    let codexWake: string | undefined;
    const agents = this.agentIds().map((id) => {
      const p = this.presence.get(id)!;
      const pending = this.store.mailByStatus(id, [...LIVE_MAIL]);
      if (!codexWake && pending.some((m) => this.codexWakeAlerts.has(m.id))) codexWake = id;
      const unacked = this.store.mailByStatus(id, ["fetched"]).filter((m) => m.ack_required);
      return {
        id,
        roles: this.rolesOf(id),
        status: this.status(id),
        doorbell: this.doorbellKind(id),
        doorbellArmed: this.doorbellArmed(id),
        doorbellError: p.doorbellError ?? null,
        binding: p.sessionId
          ? {
              session: p.sessionId.slice(0, 8),
              since: p.boundAt ? new Date(p.boundAt).toISOString() : null,
              open: this.isSessionOpen(p.sessionId),
              autoReleaseAt: p.lastSeenAt ? new Date(p.lastSeenAt + this.cfg.wait.offline_after_seconds * 1000).toISOString() : null,
            }
          : null,
        pendingMail: pending.length,
        stuckMail: pending.filter((m) => m.status === "stuck").length,
        unackedMail: unacked.length,
        waitCalls: p.waitCalls,
        lastSeenAt: p.lastSeenAt ? new Date(Math.max(p.lastSeenAt, p.lastReturnAt ?? 0, p.doorbellSeenAt ?? 0)).toISOString() : null,
        lastRingAt: p.lastRingAt ? new Date(p.lastRingAt).toISOString() : null,
      };
    });
    let attention: { kind: "fallback" | "stale"; agent: string; message: string } | null = null;
    const stuck = agents.find((a) => a.stuckMail > 0);
    if (stuck) attention = { kind: "fallback", agent: stuck.id, message: `${stuck.id} 没有响应门铃，有 ${stuck.stuckMail} 封信送不到。请在 ${stuck.id} 里说「继续」。` };
    else if (codexWake) attention = { kind: "fallback", agent: codexWake, message: `${codexWake} 已响铃但尚未取信。请在对应对话里说「继续」。` };
    else if (run && (run.status === "active" || run.status === "awaiting_approval"))
      for (const l of lives) {
        if (l.status !== "ready" && l.status !== "in_progress") continue;
        const st = this.status(l.agent);
        if (st === "never-joined")
          attention = { kind: "fallback", agent: l.agent, message: `轮到 ${l.agent}，但它还没有加入协作桥。请在 ${l.agent} 里粘贴启动提示词。` };
        else if (st === "offline" && this.doorbellKind(l.agent) !== "codex-hook")
          attention = { kind: "fallback", agent: l.agent, message: `轮到 ${l.agent}，但它不在线。请在 ${l.agent} 里说「继续」。` };
        else if (st === "stale") attention = { kind: "stale", agent: l.agent, message: `${l.agent} 一段时间没有响应，可能是网络波动，正在等它恢复。` };
        if (attention) break;
      }
    const meeting = this.store.openMeeting() ?? this.store.recentMeetings(1)[0];
    const now = Date.now();
    return {
      project: this.cfg.projectDir,
      configSource: this.cfg.source,
      pipeline: this.cfg.pipeline.map((s) => ({ id: s.id, role: s.role, agent: s.agent, gate: s.gate, on_reject: s.on_reject ?? null })),
      run: run ?? null,
      attempts,
      live: live ?? null,
      lives,
      tasks: tasks.map((t) => {
        const la = this.store.taskLiveAttempt(t.id);
        const deps = t.depends_on.filter((k) => tasks.find((x) => x.key === k)?.status !== "done");
        return {
          ...t,
          live: la ?? null,
          rounds: attempts.filter((a) => a.task_id === t.id).length,
          waiting: t.status === "pending" ? (deps.length ? `等 ${deps.join("、")}` : (this.taskWaits.get(t.id) ?? null)) : null,
        };
      }),
      leases: this.store.openLeases().map((l) => ({ ...l, task: keyOf(l.task_id), expired: !!l.expires_at && Date.parse(l.expires_at) <= now })),
      meeting: meeting
        ? {
            ...meeting,
            expected: this.expectedSpeakers(meeting),
            turns: this.store.meetingTurns(meeting.id),
          }
        : null,
      handoffs,
      agents,
      attention,
      questions: this.store.openQuestions(),
      mail: this.store.recentMail(25).map((m) => ({ id: m.id, from: m.from_agent, to: m.to_agent, kind: m.kind, subject: m.subject, status: m.status, ring_count: m.ring_count, created_at: m.created_at, overdue: !!m.overdue_flagged })),
      codexThreads: this.store.codexThreads().slice(0, 5),
      notes: this.store.notes().slice(-20).reverse(),
      events: this.store.recentEvents(40),
      recentRuns: this.store.recentRuns(10),
    };
  }
}

export const DOORBELL_LABEL: Record<DoorbellKind, string> = {
  "claude-socket": "Claude 消息注入",
  "codex-hook": "Codex Stop hook",
  poll: "轮询",
};
