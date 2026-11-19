// Deliver mail, ring doorbells and retry unread deliveries.
import { randomUUID } from "node:crypto";
import { CODEX_THREAD, type Doorbell, type Doorbells, type DoorbellKind, type RingResult } from "../doorbells/index.js";
import type { Mail, MailKind } from "../store.js";
import { err, type EngineContext, type Result } from "./context.js";
import type { Presence } from "./presence.js";

// After a ring, how long to wait for a sign of life (any tool call) before trying the next doorbell in the
// agent's chain or telling the human. A woken agent may think a while before its first tool call.
const WAKE_GRACE_MS = Number(process.env.BRIDGE_WAKE_GRACE_SECONDS ?? process.env.BRIDGE_CODEX_WAKE_GRACE_SECONDS ?? 30) * 1000;
export const LIVE_MAIL = ["queued", "rung", "stuck"] as const;

export class Postman {
  private readonly wakeAlerts = new Set<string>(); // mail IDs already reported to the human as "rang, no response"
  private readonly mailWakers = new Map<string, () => void>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly presence: Presence,
    private readonly doorbells: Doorbells,
    private readonly payloads: {
      task(mail: Mail): Result | null;
      meeting(mail: Mail): Result | null;
    },
  ) {}

  startSweep(retryBlockedTasks: () => void) {
    setInterval(() => {
      this.sweep();
      retryBlockedTasks();
    }, 5_000).unref();
  }

  isUnanswered(id: string) {
    return this.wakeAlerts.has(id);
  }

  /** A live MCP session is still working on a fetched task or meeting turn. */
  isBusy(agent: string) {
    const session = this.presence.get(agent)?.sessionId;
    return !!session && this.presence.isSessionOpen(session) && this.presence.status(agent) === "working";
  }

  wakeWaiter(agent: string) {
    this.mailWakers.get(agent)?.();
  }

  private get pollMs() {
    return this.ctx.cfg.wait.poll_seconds * 1000;
  }

  /** Doorbell long-poll from the stdio proxy (claude-socket) or a parking Codex Stop hook (codex-hook). */
  doorbellWait(agent: string, kind: "claude-socket" | "codex-hook", timeoutMs: number, signal: AbortSignal): Promise<RingResult> {
    const driver = kind === "claude-socket" ? this.doorbells.claudeSocket : this.doorbells.codexHook;
    const r = driver.wait(agent, timeoutMs, signal, () => this.ctx.onChange());
    if (this.ctx.store.mailByStatus(agent, ["queued"]).length) this.kick(agent);
    return r;
  }

  /**
   * A client tells the bridge where it can be reached outside MCP — today the Codex Stop hook, at the end
   * of every turn of a conversation that joined, registering its conversation id. `park` tells the hook
   * whether to stay parked as the doorbell (false when a codex-queue doorbell can now reach the agent).
   */
  registerEndpoint(agent: string, kind: string, address: string): Result {
    if (!this.presence.isAgent(agent)) return err("未知 agent");
    if (!address) return err("address 不能为空");
    const prev = this.ctx.store.endpoint(agent, kind);
    this.ctx.store.setEndpoint(agent, kind, address);
    if (prev?.address !== address) this.ctx.log("endpoint_registered", { agent, kind, address });
    let park = true;
    if (kind === CODEX_THREAD) {
      const chain = this.doorbells.chain(agent);
      const q = chain.indexOf("codex-queue");
      const h = chain.indexOf("codex-hook");
      park = !(q >= 0 && (h < 0 || q < h) && this.doorbells.codexQueue.available(agent));
    }
    this.ctx.onChange();
    if (!park) this.kick(agent); // mail that arrived while the agent was mid-turn
    return { ok: true, park };
  }

  /** The proxy reports whether writing to the Claude messaging socket worked. */
  doorbellResult(agent: string, mailIds: string[], ok: boolean, error?: string, kind: "claude-socket" | "codex-hook" = "claude-socket") {
    const p = this.presence.get(agent)!;
    if (ok) {
      p.doorbellError = undefined;
      return;
    }
    this.ringFailed(agent, this.doorbells.get(kind), mailIds, error ?? "未知原因", new Set([kind]));
  }

  sendMail(m: { id?: string; run_id?: number | null; attempt_id?: number | null; from: string; to: string; kind: MailKind; subject: string; body: string; importance?: "normal" | "high"; ack_required?: boolean }) {
    const id = m.id ?? `${m.kind}-${randomUUID()}`;
    const created = this.ctx.store.addMail({
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
      this.ctx.log("mail_duplicate", { id });
      return { id, duplicate: true };
    }
    this.ctx.log("mail_queued", { id, to: m.to, kind: m.kind, subject: m.subject });
    this.kick(m.to);
    this.ctx.onChange();
    return { id, duplicate: false };
  }

  /**
   * Something is waiting for `agent`: wake its blocked wait_for_mail, and ring the first doorbell in its
   * chain that can deliver now (skipping `tried`). A failed ring falls through to the next doorbell; a
   * successful one is checked for a sign of life after WAKE_GRACE_MS.
   */
  kick(agent: string, tried: ReadonlySet<DoorbellKind> = new Set()) {
    const queued = this.ctx.store.mailByStatus(agent, ["queued"]);
    if (!queued.length) return;
    const mw = this.mailWakers.get(agent);
    if (mw) {
      this.mailWakers.delete(agent);
      mw();
    }
    const bell = this.doorbells.pick(agent, tried);
    if (!bell) return;
    const ids = queued.map((m) => m.id);
    const text =
      `[协作桥] ${agent}，你有 ${queued.length} 封新信：` +
      queued.map((m) => m.subject).slice(0, 5).join("；") +
      (queued.length > 5 ? " 等" : "") +
      `。请调用 bridge 的 fetch_inbox（agent_id="${agent}"）查看并处理。`;
    this.ctx.store.setMailStatus(ids, "rung");
    const p = this.presence.get(agent)!;
    const rangAt = Date.now();
    p.lastRingAt = rangAt;
    p.lastRingKind = bell.kind;
    this.ctx.log("doorbell_ring", { agent, via: bell.kind, mails: ids });
    this.ctx.event(null, agent, "doorbell", `按门铃叫醒 ${agent}（${bell.label}，${queued.length} 封信）`);
    const nowTried = new Set([...tried, bell.kind]);
    bell
      .ring({ agent, mailIds: ids, text })
      .catch((e): { ok: false; error: string } => ({ ok: false, error: String(e?.message ?? e) }))
      .then((o) => {
        if (o.ok) {
          if (o.note) this.ctx.log("doorbell_note", { agent, via: bell.kind, note: o.note });
          if (bell.verify) setTimeout(() => this.checkWake(agent, bell, ids, rangAt, nowTried), WAKE_GRACE_MS).unref();
          return;
        }
        this.ringFailed(agent, bell, ids, o.error, nowTried);
      });
  }

  /** A ring didn't go through: put the mail back and try the next doorbell in the chain. */
  private ringFailed(agent: string, bell: Doorbell, ids: string[], error: string, tried: ReadonlySet<DoorbellKind>) {
    const p = this.presence.get(agent)!;
    p.doorbellError = `${bell.label}：${error}`;
    this.ctx.log("doorbell_failed", { agent, via: bell.kind, error });
    this.ctx.event(null, agent, "doorbell", `${agent} 的门铃（${bell.label}）失败：${error}，信件会重新投递`);
    const back = ids.filter((id) => this.ctx.store.mail(id)?.status === "rung");
    this.ctx.store.setMailStatus(back, "queued");
    const next = this.doorbells.pick(agent, tried);
    this.kick(agent, tried); // also wakes a blocked wait_for_mail
    if (!next && !this.presence.get(agent)!.waiting) this.alertUnanswered(agent, bell, back);
    this.ctx.onChange();
  }

  /** No doorbell got through: tell the human once per mail. */
  private alertUnanswered(agent: string, bell: Doorbell, ids: string[]) {
    const fresh = ids.filter((id) => !this.wakeAlerts.has(id));
    if (!fresh.length) return;
    for (const id of fresh) this.wakeAlerts.add(id);
    this.ctx.event(null, agent, "doorbell", `${agent} 已响铃（${bell.label}），仍有 ${fresh.length} 封信未取`);
    this.ctx.notifyHuman(`协作桥：需要你叫醒 ${agent}`, `${agent} 已响铃但尚未取信。请在该对话里说「继续」。`);
  }

  /**
   * After a ring: any tool call from the agent means it woke up and will fetch in its own time, and an agent
   * already busy on a bridge task reads its mail when it gets to it. Otherwise try the next doorbell, and
   * when none is left, ask the human.
   */
  private checkWake(agent: string, bell: Doorbell, ids: string[], rangAt: number, tried: ReadonlySet<DoorbellKind>) {
    if ((this.presence.get(agent)?.lastSeenAt ?? 0) >= rangAt) return;
    if (this.isBusy(agent)) return;
    const unread = ids.filter((id) => {
      const st = this.ctx.store.mail(id)?.status;
      return (st === "rung" || st === "queued") && !this.wakeAlerts.has(id);
    });
    if (!unread.length) return;
    this.ctx.log("wake_timeout", { agent, via: bell.kind, mails: unread, graceMs: WAKE_GRACE_MS });
    const next = this.doorbells.pick(agent, tried);
    if (next) {
      this.ctx.event(null, agent, "doorbell", `${agent} 对「${bell.label}」没有反应，改用「${next.label}」`);
      this.ctx.store.setMailStatus(unread.filter((id) => this.ctx.store.mail(id)?.status === "rung"), "queued");
      this.kick(agent, tried);
      return;
    }
    this.alertUnanswered(agent, bell, unread);
    this.ctx.onChange();
  }

  /** Periodic: re-ring mail nobody fetched, give up after max_rings, flag overdue acks, retry lease-blocked tasks. */
  private sweep() {
    const now = Date.now();
    const { ring_retry_seconds, max_rings, ack_timeout_seconds } = this.ctx.cfg.mail;
    for (const id of this.wakeAlerts) {
      const status = this.ctx.store.mail(id)?.status;
      if (!status || !LIVE_MAIL.some((s) => s === status)) this.wakeAlerts.delete(id);
    }
    for (const m of this.ctx.store.allMailByStatus(["rung"])) {
      const lastReturn = this.presence.get(m.to_agent)?.lastReturnAt ?? 0;
      if (now - Math.max(Date.parse(m.rung_at!), lastReturn) < ring_retry_seconds * 1000) continue;
      // A delivered wake can be waiting in the client's queue while its current turn finishes.
      if (this.isBusy(m.to_agent)) continue;
      if (m.ring_count >= max_rings) {
        this.ctx.store.setMailStatus([m.id], "stuck");
        this.ctx.log("mail_stuck", { id: m.id, to: m.to_agent });
        this.ctx.event(m.run_id, m.to_agent, "stuck", `${m.to_agent} 没有响应门铃：「${m.subject}」`);
        if (!this.wakeAlerts.has(m.id))
          this.ctx.notifyHuman("协作桥：需要你叫醒 " + m.to_agent, `门铃按了 ${m.ring_count} 次没有回应。请在 ${m.to_agent} 里说「继续」。`);
      } else {
        this.ctx.store.setMailStatus([m.id], "queued");
        this.kick(m.to_agent);
      }
    }
    // Queued mail that no doorbell can deliver (agent not parked / proxy gone, not polling, not busy) → ask the human.
    for (const m of this.ctx.store.allMailByStatus(["queued"])) {
      if (now - Date.parse(m.created_at) < ring_retry_seconds * 1000) continue;
      const st = this.presence.status(m.to_agent);
      if (st === "working" || st === "armed" || st === "waiting") continue;
      this.ctx.store.setMailStatus([m.id], "stuck");
      this.ctx.log("mail_stuck", { id: m.id, to: m.to_agent, reason: "no doorbell" });
      this.ctx.event(m.run_id, m.to_agent, "stuck", `${m.to_agent} 的门铃没有接上，「${m.subject}」送不到`);
      if (!this.wakeAlerts.has(m.id))
        this.ctx.notifyHuman("协作桥：需要你叫醒 " + m.to_agent, `${m.to_agent} 现在没有在等信。请在 ${m.to_agent} 里说「继续」。`);
    }
    for (const m of this.ctx.store.allMailByStatus(["fetched"])) {
      if (!m.ack_required || m.overdue_flagged || now - Date.parse(m.fetched_at!) < ack_timeout_seconds * 1000) continue;
      this.ctx.store.flagOverdue(m.id);
      this.ctx.log("ack_overdue", { id: m.id, to: m.to_agent });
      this.ctx.event(m.run_id, m.to_agent, "overdue", `${m.to_agent} 取走了「${m.subject}」但一直没有确认`);
      this.ctx.notifyHuman("协作桥：确认超时", `${m.to_agent} 取走了「${m.subject}」，超过 ${Math.round(ack_timeout_seconds / 60)} 分钟没有确认。`);
    }
  }

  private mailView(m: Mail) {
    return { id: m.id, kind: m.kind, from: m.from_agent, subject: m.subject, importance: m.importance, ack_required: !!m.ack_required, sent_at: m.created_at };
  }

  fetchInbox(agent: string, sessionId: string | undefined): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const mails = this.ctx.store.mailByStatus(agent, [...LIVE_MAIL]);
    const out: Result[] = [];
    for (const m of mails) {
      if (m.kind === "task") {
        const task = this.payloads.task(m);
        if (!task) {
          this.ctx.store.setMailStatus([m.id], "void");
          out.push({ ...this.mailView(m), void: true, note: "这个任务已停止或已被替换，忽略即可。" });
          continue;
        }
        out.push({ ...this.mailView(m), task });
      } else if (m.kind === "meeting") {
        const meeting = this.payloads.meeting(m);
        if (!meeting) {
          this.ctx.store.setMailStatus([m.id], "void");
          out.push({ ...this.mailView(m), void: true, note: "这一轮会议已经结束或被取消，忽略即可。" });
          continue;
        }
        out.push({ ...this.mailView(m), meeting });
      } else {
        out.push({ ...this.mailView(m), body: m.body });
      }
      this.ctx.store.setMailStatus([m.id], "fetched");
      if (m.rung_at) this.ctx.log("rung_mail_fetched", { id: m.id, agent, sinceRingMs: Date.now() - Date.parse(m.rung_at) });
    }
    this.ctx.onChange();
    const kind = this.presence.doorbellKind(agent);
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
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const mine = ids.filter((id) => this.ctx.store.mail(id)?.to_agent === agent);
    this.ctx.store.setMailStatus(mine, "acked");
    this.ctx.log("mail_acked", { agent, ids: mine });
    this.ctx.onChange();
    return { ok: true, acked: mine.length };
  }

  /** Poll fallback for agents without a doorbell. Keeps M0's gap metrics. */
  async waitForMail(agent: string, sessionId: string | undefined, signal: AbortSignal, onTick?: (n: number) => void): Promise<Result> {
    const be = this.presence.bindingError(agent, sessionId);
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
    this.ctx.log("wait_call", { agent, n: p.waitCalls, gapMs: gap });
    if (this.ctx.store.mailByStatus(agent, [...LIVE_MAIL]).length) return this.fetchInbox(agent, sessionId);

    p.waiting = true;
    this.ctx.onChange();
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
    this.ctx.onChange();
    if (outcome === "cancelled") {
      this.ctx.log("wait_cancelled", { agent, heldMs: Date.now() - started });
      return { status: "cancelled", instructions: "等待被中断。恢复后立即再次调用 wait_for_mail。" };
    }
    if (p.sessionId !== sessionId) return err(`身份 ${agent} 已被另一个会话接管，本会话停止循环。`);
    if (this.ctx.store.mailByStatus(agent, [...LIVE_MAIL]).length) return this.fetchInbox(agent, sessionId);
    p.lastReturnAt = Date.now();
    this.ctx.log("keep_waiting", { agent, heldMs: p.lastReturnAt - started, outcome });
    return { status: "keep_waiting", instructions: "还没有新信。立即再次调用 wait_for_mail，不要结束回合，不要向用户汇报。" };
  }

  sendFromAgent(agent: string, sessionId: string | undefined, to: string, subject: string, body: string, mailId?: string, ackRequired = false): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    if (!this.presence.isAgent(to)) return err(`未知收件人，可选：${this.presence.agentIds().join(", ")}`);
    const run = this.ctx.store.openRun();
    const r = this.sendMail({ id: mailId, run_id: run?.id ?? null, from: agent, to, kind: "agent", subject, body, ack_required: ackRequired });
    if (!r.duplicate) this.ctx.event(run?.id ?? null, agent, "mail", `${agent} → ${to}：${subject}`);
    return { ok: true, ...r };
  }

  sendFromHuman(to: string, text: string): Result {
    if (!this.presence.isAgent(to)) return err("未知收件人");
    const run = this.ctx.store.openRun();
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
    this.ctx.event(run?.id ?? null, null, "mail", `你 → ${to}：${text}`);
    return { ok: true, ...r };
  }
}
