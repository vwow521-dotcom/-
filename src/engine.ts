// Run/stage state machine + the postman.
// Work reaches agents as mail. The postman wakes an agent with its doorbell (Claude: messaging-socket
// injection via the stdio proxy; Codex: a parked Stop hook) or, without one, the agent long-polls
// wait_for_mail. Durable state (runs, attempts, handoffs, mail, notes, questions) lives in the Store;
// presence, identity bindings, doorbell waiters and blocked waits are in memory.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config, Stage } from "./config.js";
import type { Attempt, Feedback, HandoffData, Mail, MailKind, Run, Store } from "./store.js";
import { changedFiles, commitAll, globMatch } from "./git.js";

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

type Result = Record<string, unknown>;
const err = (error: string): Result => ({ error });
const DOORBELL_ARMED_MS = 70_000;

export class Engine {
  private presence = new Map<string, Presence>();
  private doorbellWaiters = new Map<string, Set<(r: RingResult) => void>>();
  private mailWakers = new Map<string, () => void>();
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
  stage(id: string): Stage {
    return this.cfg.pipeline.find((s) => s.id === id)!;
  }
  rolesOf(agent: string) {
    return this.cfg.pipeline.filter((s) => s.agent === agent).map((s) => `${s.id}（${s.role}）`);
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
    const live = run && this.store.liveAttempt(run.id);
    if (live?.agent === id && live.status === "in_progress") return "working";
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
      protocol: [
        "1. 现在先调用一次 fetch_inbox(agent_id)，处理里面的信。",
        "2. task 信：按其中的 goal、stage、input_handoff 和 feedback 完成本阶段工作；需要更多背景时调用 get_context；可用 report_progress 汇报进度、post_note 记录共享约定、ask_human 向用户提问（答复会以信件送达）。完成后调用 submit_handoff（桥会自动 git 提交并确认这封信）。",
        "3. 其他 ack_required 的信：处理完调用 ack。需要找其他成员时用 send_mail。",
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
    const p = this.presence.get(agent)!;
    if (this.cfg.agents[agent]?.doorbell === "auto" || kind !== "poll") p.registeredDoorbell = kind;
    p.doorbellSeenAt = Date.now();
    const set = this.doorbellWaiters.get(agent) ?? new Set();
    this.doorbellWaiters.set(agent, set);
    return new Promise((resolve) => {
      const done = (r: RingResult) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        set.delete(done);
        p.doorbellSeenAt = Date.now();
        resolve(r);
        this.onChange();
      };
      const onAbort = () => done({ ring: false });
      const timer = setTimeout(() => done({ ring: false }), timeoutMs);
      signal.addEventListener("abort", onAbort);
      set.add(done);
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
    for (const w of [...waiters]) w({ ring: true, mailIds: ids, text });
  }

  /** Periodic: re-ring mail nobody fetched, give up after max_rings, flag overdue acks. */
  private sweep() {
    const now = Date.now();
    const { ring_retry_seconds, max_rings, ack_timeout_seconds } = this.cfg.mail;
    for (const m of this.store.allMailByStatus(["rung"])) {
      if (now - Date.parse(m.rung_at!) < ring_retry_seconds * 1000) continue;
      if (m.ring_count >= max_rings) {
        this.store.setMailStatus([m.id], "stuck");
        this.log("mail_stuck", { id: m.id, to: m.to_agent });
        this.event(m.run_id, m.to_agent, "stuck", `${m.to_agent} 没有响应门铃：「${m.subject}」`);
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
      this.notifyHuman("协作桥：需要你叫醒 " + m.to_agent, `${m.to_agent} 现在没有在等信。请在 ${m.to_agent} 里说「继续」。`);
    }
    for (const m of this.store.allMailByStatus(["fetched"])) {
      if (!m.ack_required || m.overdue_flagged || now - Date.parse(m.fetched_at!) < ack_timeout_seconds * 1000) continue;
      this.store.flagOverdue(m.id);
      this.log("ack_overdue", { id: m.id, to: m.to_agent });
      this.event(m.run_id, m.to_agent, "overdue", `${m.to_agent} 取走了「${m.subject}」但一直没有确认`);
      this.notifyHuman("协作桥：确认超时", `${m.to_agent} 取走了「${m.subject}」，超过 ${Math.round(ack_timeout_seconds / 60)} 分钟没有确认。`);
    }
  }

  private mailView(m: Mail) {
    return { id: m.id, kind: m.kind, from: m.from_agent, subject: m.subject, importance: m.importance, ack_required: !!m.ack_required, sent_at: m.created_at };
  }

  fetchInbox(agent: string, sessionId: string | undefined): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const mails = this.store.mailByStatus(agent, ["queued", "rung", "stuck"]);
    const out: Result[] = [];
    for (const m of mails) {
      if (m.kind === "task") {
        const a = m.attempt_id ? this.store.attempt(m.attempt_id) : undefined;
        const run = a && this.store.run(a.run_id);
        if (!a || !run || !["ready", "in_progress"].includes(a.status) || run.status !== "active") {
          this.store.setMailStatus([m.id], "void");
          out.push({ ...this.mailView(m), void: true, note: "这个任务已停止或已被替换，忽略即可。" });
          continue;
        }
        const resumed = a.status === "in_progress";
        if (!resumed) this.store.updateAttempt(a.id, { status: "in_progress", started_at: new Date().toISOString() });
        this.log("task_fetched", { agent, run: run.id, stage: a.stage_id, attempt: a.id, resumed, latencyMs: Date.now() - Date.parse(m.created_at) });
        this.event(run.id, agent, "turn", `${agent} 开始「${a.stage_id}」${resumed ? "（继续）" : ""}`);
        out.push({ ...this.mailView(m), task: this.turnPayload(run, this.store.attempt(a.id)!, resumed) });
      } else {
        out.push({ ...this.mailView(m), body: m.body });
      }
      this.store.setMailStatus([m.id], "fetched");
    }
    this.onChange();
    const kind = this.doorbellKind(agent);
    return {
      mails: out,
      instructions: out.length
        ? "逐封处理：task 信完成后调用 submit_handoff（自动确认）；其他 ack_required 的信处理后调用 ack。" +
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
    if (this.store.mailByStatus(agent, ["queued", "rung", "stuck"]).length) return this.fetchInbox(agent, sessionId);

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
    if (this.store.mailByStatus(agent, ["queued", "rung", "stuck"]).length) return this.fetchInbox(agent, sessionId);
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

  // ---------- runs & stages ----------

  private parseFeedback(raw: string | null): Feedback | null {
    if (!raw) return null;
    try {
      const f = JSON.parse(raw);
      if (f && Array.isArray(f.user_requirements)) return f;
    } catch {}
    return { kind: "rework", from_stage: "?", user_requirements: [raw], blocking: [], observations: [] }; // pre-M2b.1 text
  }

  private turnPayload(run: Run, a: Attempt, resumed: boolean): Result {
    const stage = this.stage(a.stage_id);
    const handoffs = this.store.handoffs(run.id);
    const input = handoffs.at(-1) ?? null;
    const fb = this.parseFeedback(a.feedback);
    const fbGuide: Record<Feedback["kind"], string> = {
      rework:
        "这是一次返工：user_requirements（用户要求）和 blocking（阻塞问题）必须全部完成；observations（非阻塞观察）自行判断，不做也可以。只做这些要求需要的最小改动。",
      approval_note: "用户批准上一阶段时附了要求（user_requirements），请一并满足。",
      carried:
        "本轮是返工后的复审：重点核对 user_requirements 和 blocking 是否都已满足，同时回归原有验收标准。",
    };
    const owned = this.cfg.pipeline.filter((s) => s.owns?.length).map((s) => `${s.id}：${s.owns!.join("、")}`);
    return {
      resumed,
      run: { id: run.id, goal: run.goal },
      stage: { id: stage.id, role: stage.role, instructions: stage.instructions ?? null, needs_approval: stage.gate, owns: stage.owns ?? [] },
      feedback: fb,
      input_handoff: input && { from: `${input.agent}/${input.stage_id}`, commit: input.commit_sha, ...input.data },
      earlier_handoffs: handoffs.slice(0, -1).map((h) => `${h.agent}/${h.stage_id}：${h.data.summary}`),
      instructions:
        (resumed ? "这是你之前领到但还没提交的阶段，请继续完成。" : "") +
        `你现在负责阶段「${stage.id}：${stage.role}」。完成后调用 submit_handoff，并在 files_changed 里列全你改动的文件。` +
        (fb ? fbGuide[fb.kind] : "") +
        (owned.length ? `文件分工（${owned.join("；")}）：改动其他阶段负责的文件时，请在交接单 notes_for_next 里说明原因。` : "") +
        (stage.on_reject ? "这是审查阶段：verdict 填 approve 或 reject；review_comments 只写必须修改的阻塞问题，不影响通过的建议写进 observations。" : ""),
    };
  }

  /** After a (re)join: make sure a live task of this agent has an unfetched task mail. */
  private resendLiveTask(agent: string) {
    const run = this.store.openRun();
    const a = run && this.store.liveAttempt(run.id);
    if (!run || !a || a.agent !== agent || !["ready", "in_progress"].includes(a.status)) return;
    const pending = this.store.taskMailFor(a.id).some((m) => ["queued", "rung", "stuck"].includes(m.status));
    if (!pending) this.sendTaskMail(run.id, a, a.status === "in_progress" ? "（继续）" : "");
  }

  private sendTaskMail(run_id: number, a: Attempt, suffix = "") {
    const stage = this.stage(a.stage_id);
    this.sendMail({
      run_id,
      attempt_id: a.id,
      from: "bridge",
      to: a.agent,
      kind: "task",
      subject: `任务：${stage.id}（${stage.role}）${suffix}`,
      body: "",
      ack_required: true,
    });
  }

  startRun(goal: string): Result {
    const open = this.store.openRun();
    if (open) return err(`已有任务 #${open.id} 在进行中，请先停止它。`);
    const run = this.store.createRun(goal);
    this.log("run_start", { run: run.id, goal });
    this.event(run.id, null, "run", `任务 #${run.id} 开始：${goal}`);
    this.assign(run.id, this.cfg.pipeline[0], null);
    return { ok: true, run_id: run.id };
  }

  stopRun(): Result {
    const run = this.store.openRun();
    if (!run) return err("当前没有进行中的任务。");
    for (const a of this.store.attempts(run.id))
      if (["ready", "in_progress", "awaiting_approval"].includes(a.status)) {
        this.store.updateAttempt(a.id, { status: "cancelled", ended_at: new Date().toISOString() });
        const open = this.store.taskMailFor(a.id).filter((m) => ["queued", "rung", "stuck"].includes(m.status));
        this.store.setMailStatus(open.map((m) => m.id), "void");
      }
    this.store.setRunStatus(run.id, "stopped");
    this.log("run_stop", { run: run.id });
    this.event(run.id, null, "run", `任务 #${run.id} 已停止`);
    return { ok: true };
  }

  private assign(run_id: number, stage: Stage, feedback: Feedback | null) {
    const a = this.store.createAttempt(run_id, stage.id, stage.agent, feedback ? JSON.stringify(feedback) : null);
    this.log("stage_assigned", { run: run_id, stage: stage.id, agent: stage.agent, attempt: a.id, agentStatus: this.status(stage.agent) });
    this.sendTaskMail(run_id, a);
  }

  private advance(run: Run, fromStage: string, feedback: Feedback | null) {
    const i = this.cfg.pipeline.findIndex((s) => s.id === fromStage);
    const next = this.cfg.pipeline[i + 1];
    if (!next) {
      this.store.setRunStatus(run.id, "done");
      this.log("run_done", { run: run.id });
      this.event(run.id, null, "run", `任务 #${run.id} 完成`);
      this.notifyHuman("协作桥：任务完成", `#${run.id} ${run.goal}`);
      return;
    }
    this.store.setRunStatus(run.id, "active");
    this.assign(run.id, next, feedback);
  }

  async submitHandoff(agent: string, sessionId: string | undefined, data: HandoffData): Promise<Result> {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.store.openRun();
    const a = run && this.store.liveAttempt(run.id);
    if (!run || !a || a.agent !== agent || a.status !== "in_progress")
      return err("当前没有分配给你、正在进行的阶段，不能提交。请先调用 fetch_inbox 看有没有任务信。");
    const stage = this.stage(a.stage_id);

    // Scope check before committing: undeclared changes and files owned by another stage are flagged.
    const changed = await changedFiles(this.cfg.projectDir);
    const norm = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const declared = new Set(data.files_changed.map(norm));
    const scope_notes: string[] = [];
    const undeclared = data.files_changed.length ? changed.filter((f) => !declared.has(norm(f))) : [];
    if (undeclared.length) scope_notes.push(`改动了但没在交接单里声明：${undeclared.join("、")}`);
    for (const other of this.cfg.pipeline) {
      if (other.id === stage.id || !other.owns?.length || stage.owns?.some((g) => other.owns!.includes(g))) continue;
      const hit = changed.filter((f) => other.owns!.some((g) => globMatch(g, f)) && !stage.owns?.some((g) => globMatch(g, f)));
      if (hit.length) scope_notes.push(`改动了「${other.id}」阶段负责的文件：${hit.join("、")}`);
    }

    let commit_sha: string | null = null;
    let commit_error: string | null = null;
    if (this.cfg.git.auto_commit) {
      const verdictText = data.verdict === "approve" ? "审查通过 — " : data.verdict === "reject" ? "审查打回 — " : "";
      const subject = `[bridge] ${stage.id} by ${agent}: ${verdictText}${data.summary}`.slice(0, 120);
      const bodyParts = [`run #${run.id}: ${run.goal}`];
      if (data.review_comments?.length) bodyParts.push("阻塞问题：\n- " + data.review_comments.join("\n- "));
      if (data.observations?.length) bodyParts.push("观察：\n- " + data.observations.join("\n- "));
      if (data.notes_for_next) bodyParts.push(data.notes_for_next);
      if (scope_notes.length) bodyParts.push("范围提示：\n- " + scope_notes.join("\n- "));
      const r = await commitAll(this.cfg.projectDir, subject, bodyParts.join("\n\n").slice(0, 6000), {
        allowEmpty: !!data.verdict && this.cfg.git.commit_reviews,
      });
      if ("sha" in r) commit_sha = r.sha;
      else if ("error" in r) commit_error = r.error;
      else commit_error = `未提交：${r.skipped}`;
    }

    const h = this.store.addHandoff({ run_id: run.id, attempt_id: a.id, stage_id: stage.id, agent, data, commit_sha, commit_error, scope_notes });
    if (scope_notes.length) this.event(run.id, agent, "scope", `「${stage.id}」交接的范围提示：${scope_notes.join("；")}`);
    this.store.setMailStatus(this.store.taskMailFor(a.id).filter((m) => m.status !== "void").map((m) => m.id), "acked");
    const ended = new Date().toISOString();
    this.presence.get(agent)!.lastReturnAt = Date.now();
    this.log("handoff", { run: run.id, stage: stage.id, agent, summary: data.summary, verdict: data.verdict, commit: commit_sha, commitError: commit_error });
    this.event(run.id, agent, "handoff", `${agent} 完成「${stage.id}」：${data.summary}`);

    const after = this.doorbellKind(agent) === "poll" ? "立即调用 wait_for_mail 等信。" : "可以结束本回合了，有新信时会叫醒你。";
    if (stage.gate) {
      this.store.updateAttempt(a.id, { status: "awaiting_approval", handoff_id: h.id, ended_at: ended });
      this.store.setRunStatus(run.id, "awaiting_approval");
      this.event(run.id, null, "gate", `「${stage.id}」等待你在面板上审批`);
      this.notifyHuman("协作桥：等你审批", `${agent} 完成了「${stage.id}」：${data.summary}`);
      return { status: "submitted", commit: commit_sha, commit_note: commit_error, next: "等待用户在面板上审批", instructions: "已提交。" + after };
    }
    this.store.updateAttempt(a.id, { status: "done", handoff_id: h.id, ended_at: ended });
    // A rework round's requirements travel on, so the next reviewer knows what this round was for.
    const fb = this.parseFeedback(a.feedback);
    this.advance(run, stage.id, fb && fb.kind !== "approval_note" ? { ...fb, kind: "carried" } : null);
    const nextLive = this.store.liveAttempt(run.id);
    return {
      status: "submitted",
      commit: commit_sha,
      commit_note: commit_error,
      next: nextLive ? `${nextLive.agent}/${nextLive.stage_id}` : "任务完成",
      instructions: "已交接。" + after,
    };
  }

  decide(attemptId: number, action: "approve" | "reject", note: string): Result {
    const a = this.store.attempt(attemptId);
    if (!a || a.status !== "awaiting_approval") return err("这个阶段不在等待审批。");
    const run = this.store.run(a.run_id)!;
    const stage = this.stage(a.stage_id);
    const h = a.handoff_id ? this.store.handoff(a.handoff_id) : undefined;
    const trimmed = note.trim();
    this.store.updateAttempt(a.id, { status: action === "approve" ? "approved" : "rejected", decided_note: trimmed || null });
    this.log("gate_decision", { run: run.id, stage: stage.id, attempt: a.id, action, note: trimmed });

    if (action === "approve") {
      this.event(run.id, null, "gate", `你批准了「${stage.id}」${trimmed ? "：" + trimmed : ""}`);
      this.advance(
        run,
        stage.id,
        trimmed ? { kind: "approval_note", from_stage: stage.id, user_requirements: [trimmed], blocking: [], observations: [] } : null,
      );
    } else {
      const target = this.stage(stage.on_reject ?? stage.id);
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
      this.event(run.id, null, "gate", `你打回了「${stage.id}」→「${target.id}」${trimmed ? "：" + trimmed : ""}`);
      this.store.setRunStatus(run.id, "active");
      this.assign(run.id, target, fb);
    }
    return { ok: true };
  }

  // ---------- context, progress, notes, questions ----------

  getContext(agent: string, sessionId: string | undefined, lastN = 3): Result {
    const be = this.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.store.openRun();
    const handoffs = run ? this.store.handoffs(run.id) : [];
    const n = Math.max(0, Math.min(lastN, handoffs.length));
    const live = run ? this.store.liveAttempt(run.id) : undefined;
    return {
      run: run ? { id: run.id, goal: run.goal, status: run.status } : null,
      current_round: live ? { stage: live.stage_id, agent: live.agent, status: live.status, feedback: this.parseFeedback(live.feedback) } : null,
      stages: run
        ? this.store.attempts(run.id).map((a) => ({ stage: a.stage_id, agent: a.agent, status: a.status, gate_note: a.decided_note }))
        : [],
      handoffs_total: handoffs.length,
      older_handoffs: handoffs.slice(0, handoffs.length - n).map((h) => `${h.agent}/${h.stage_id}：${h.data.summary}`),
      recent_handoffs: handoffs.slice(handoffs.length - n).map((h) => ({ from: `${h.agent}/${h.stage_id}`, commit: h.commit_sha, at: h.created_at, ...h.data })),
      notes: this.store.notes().map((n) => ({ topic: n.topic, by: n.agent, text: n.text, at: n.created_at })),
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
    const handoffs = run ? this.store.handoffs(run.id) : [];
    const agents = this.agentIds().map((id) => {
      const p = this.presence.get(id)!;
      const pending = this.store.mailByStatus(id, ["queued", "rung", "stuck"]);
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
    else if (live && (live.status === "ready" || live.status === "in_progress") && run?.status === "active") {
      const st = this.status(live.agent);
      if (st === "never-joined")
        attention = { kind: "fallback", agent: live.agent, message: `轮到 ${live.agent}，但它还没有加入协作桥。请在 ${live.agent} 里粘贴启动提示词。` };
      else if (st === "offline" && this.doorbellKind(live.agent) !== "codex-hook")
        attention = { kind: "fallback", agent: live.agent, message: `轮到 ${live.agent}，但它不在线。请在 ${live.agent} 里说「继续」。` };
      else if (st === "stale")
        attention = { kind: "stale", agent: live.agent, message: `${live.agent} 一段时间没有响应，可能是网络波动，正在等它恢复。` };
    }
    return {
      project: this.cfg.projectDir,
      configSource: this.cfg.source,
      pipeline: this.cfg.pipeline.map((s) => ({ id: s.id, role: s.role, agent: s.agent, gate: s.gate, on_reject: s.on_reject ?? null })),
      run: run ?? null,
      attempts,
      live: live ?? null,
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
