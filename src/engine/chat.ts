// The project chat room: short messages between the human and the agents, outside any task or meeting.
// A message is stored once (chat_messages) and delivered to each @mentioned agent as a `chat` mail that
// needs no ack; that mail's status is the per-recipient receipt shown on the panel.
import type { ChatMessage, Mail } from "../store.js";
import { err, type EngineContext, type Result } from "./context.js";
import type { Postman } from "./postman.js";
import type { Presence } from "./presence.js";

const ALL = new Set(["all", "全体", "所有人"]);
const CLIP = 600; // characters of each earlier message sent along with a chat mail

export const chatMailId = (messageId: number, agent: string) => `chat-${messageId}-${agent}`;

export class Chat {
  constructor(
    private readonly ctx: EngineContext,
    private readonly presence: Presence,
    private readonly postman: Postman,
  ) {}

  /** `@id` in the text plus explicit mentions; `@all` means every agent. Unknown names are returned separately. */
  private resolveMentions(text: string, explicit: string[]) {
    const ids = this.presence.agentIds();
    // Match known names right after each @ (longest first), so "@claude你好" still finds claude.
    const names = [...ids, ...ALL].sort((a, b) => b.length - a.length);
    const inText: string[] = [];
    for (const at of text.matchAll(/@/g)) {
      const rest = text.slice(at.index + 1);
      const hit = names.find((n) => rest.toLowerCase().startsWith(n.toLowerCase()) && !/^[A-Za-z0-9_-]/.test(rest.slice(n.length)));
      if (hit) inText.push(ids.find((id) => id.toLowerCase() === hit.toLowerCase()) ?? hit);
    }
    const named = [...explicit, ...inText];
    const out = new Set<string>();
    const unknown: string[] = [];
    for (const n of named) {
      if (ALL.has(n.toLowerCase())) ids.forEach((id) => out.add(id));
      else if (ids.includes(n)) out.add(n);
      else if (explicit.includes(n)) unknown.push(n);
    }
    return { mentions: [...out], unknown };
  }

  /** Post a message from the human or an agent. Mentioned agents (never the sender) get a chat mail. */
  post(from: string, text: string, explicit: string[] = [], replyTo?: number, wake = true): Result {
    const body = text.trim();
    if (!body) return err("消息不能为空");
    const reply = replyTo ? this.ctx.store.chatMessage(replyTo) : undefined;
    if (replyTo && !reply) return err(`没有编号为 ${replyTo} 的聊天消息`);
    const { mentions: named, unknown } = this.resolveMentions(body, explicit);
    if (unknown.length) return err(`未知成员：${unknown.join("、")}。可选：${this.presence.agentIds().join(", ")}`);
    // Replying to another agent's message reaches that agent without an explicit @.
    if (reply && reply.from_agent !== "human" && !named.includes(reply.from_agent)) named.push(reply.from_agent);
    // wake=false: say it in the room (e.g. closing a topic) without waking anyone.
    const mentions = wake ? named.filter((a) => a !== from) : [];
    if (from === "human" && !mentions.length) return err("用 @ 指定要发给谁，例如 @claude，或 @all 发给所有人");

    // Agents talking among themselves without the human: stop waking each other after max_agent_turns.
    const { max_agent_turns } = this.ctx.cfg.chat;
    const streak = from === "human" ? 0 : this.ctx.store.chatSinceHuman().length;
    const muted = from !== "human" && mentions.length > 0 && streak >= max_agent_turns;
    const delivered = muted ? [] : mentions;

    const run = this.ctx.store.openRun();
    const meeting = this.ctx.store.openMeeting();
    const id = this.ctx.store.addChat({
      from_agent: from,
      text: body,
      mentions: delivered,
      reply_to: reply?.id ?? null,
      run_id: run?.id ?? null,
      meeting_id: meeting?.id ?? null,
    });
    this.ctx.log("chat", { id, from, mentions: delivered, muted: muted ? mentions : undefined });
    const snippet = body.length > 40 ? body.slice(0, 40) + "…" : body;
    const mailIds: Record<string, string> = {};
    for (const to of delivered) {
      mailIds[to] = this.postman.sendMail({
        id: chatMailId(id, to),
        run_id: run?.id ?? null,
        from,
        to,
        kind: "chat",
        subject: `${from === "human" ? "用户" : from} 在聊天里找你：${snippet}`,
        body,
        importance: from === "human" ? "high" : "normal",
      }).id;
    }
    this.ctx.onChange();
    return {
      ok: true,
      message_id: id,
      delivered_to: delivered,
      mail_ids: mailIds,
      ...(muted
        ? {
            muted: mentions,
            note: `成员之间已经连续聊了 ${streak} 条，用户还没插话。这条消息已经记在聊天里，但不会叫醒 ${mentions.join("、")}。等用户回复后再继续。`,
          }
        : {}),
    };
  }

  /** `say` from an agent. */
  say(agent: string, sessionId: string | undefined, text: string, mentions: string[] = [], replyTo?: number, wake = true): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    return this.post(agent, text, mentions, replyTo, wake);
  }

  private view(m: ChatMessage) {
    return { id: m.id, from: m.from_agent, text: m.text.length > CLIP ? m.text.slice(0, CLIP) + "…" : m.text, reply_to: m.reply_to, at: m.created_at };
  }

  /** fetch_inbox payload for a chat mail: the message and the conversation leading up to it. */
  readChatMail(mail: Mail): Result | null {
    const n = Number(/^chat-(\d+)-/.exec(mail.id)?.[1]);
    const m = n ? this.ctx.store.chatMessage(n) : undefined;
    if (!m) return null;
    const reply = m.reply_to ? this.ctx.store.chatMessage(m.reply_to) : undefined;
    return {
      message_id: m.id,
      from: m.from_agent,
      text: m.text,
      mentions: m.mentions,
      reply_to: reply ? this.view(reply) : null,
      earlier: this.ctx.store.recentChat(this.ctx.cfg.chat.history, m.id).map((x) => this.view(x)),
      instructions:
        "这是聊天消息，不需要 ack。需要回答时调用 say（reply_to=" + m.id + "）；只是知会你、不需要回答时什么都不用做。" +
        (m.from_agent !== "human" ? "回复成员的消息会叫醒对方；想收住话题、不再叫醒对方时，say 带 wake=false。" : "") +
        "回答要简短。手上有任务时先把任务做完再处理聊天，不要因为聊天中断任务。",
    };
  }

  /** Recent messages with per-recipient receipts, for the panel. */
  recent(limit = 50, busy: (agent: string) => boolean = () => false) {
    return this.ctx.store.recentChat(limit).map((m) => ({
      ...m,
      receipts: m.mentions.map((agent) => {
        const mail = this.ctx.store.mail(chatMailId(m.id, agent));
        const status = mail?.status ?? "void";
        return { agent, status, waitingForTurn: status === "rung" && busy(agent), read_at: mail?.fetched_at ?? null };
      }),
    }));
  }

  /** Short history for get_context. */
  history(limit = 10) {
    return this.ctx.store.recentChat(limit).map((m) => this.view(m));
  }
}
