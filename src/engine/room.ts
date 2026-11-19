// The room timeline for the panel: chat, meeting rounds, handoffs (with their approval gates), open
// questions and system events, merged in time order. A read model only; actions go through the
// existing services (scheduler.decide, meetings.*, chat.post, workspace.answer).
import type { BridgeEvent, Handoff, Meeting, MeetingTurn } from "../store.js";
import type { Chat } from "./chat.js";
import type { EngineContext } from "./context.js";
import type { Meetings } from "./meetings.js";
import type { Postman } from "./postman.js";
import type { Scheduler } from "./scheduler.js";

export type TimelineCategory = "chat" | "meeting" | "task" | "other";

const RUNS = 3; // handoffs of this many recent runs
const MEETINGS = 3;
const CHAT = 120;
const EVENTS = 250;
const MAX_ITEMS = 300;

// Events already shown as their own card, or too chatty for the room.
const HIDDEN_EVENT_KINDS = new Set(["doorbell", "handoff"]);
const CATEGORY: Record<string, TimelineCategory> = {
  meeting: "meeting",
  run: "task",
  task: "task",
  gate: "task",
  lease: "task",
  scope: "task",
  turn: "task",
  progress: "task",
};

export class Room {
  constructor(
    private readonly ctx: EngineContext,
    private readonly postman: Postman,
    private readonly scheduler: Scheduler,
    private readonly meetings: Meetings,
    private readonly chat: Chat,
  ) {}

  timeline() {
    const store = this.ctx.store;
    const items: ({ at: string; type: string; cat: TimelineCategory } & Record<string, unknown>)[] = [];

    for (const c of this.chat.recent(CHAT, (a) => this.postman.isBusy(a))) items.push({ type: "chat", cat: "chat", at: c.created_at, ...c });

    for (const m of store.recentMeetings(MEETINGS)) items.push(...this.rounds(m));

    for (const run of store.recentRuns(RUNS)) for (const h of store.handoffs(run.id)) items.push(this.handoff(h));

    for (const q of store.openQuestions()) items.push({ type: "question", cat: "task", at: q.created_at, id: q.id, agent: q.agent, question: q.question });

    for (const e of store.recentEvents(EVENTS)) {
      if (!this.showEvent(e)) continue;
      items.push({ type: "sys", cat: CATEGORY[e.kind] ?? "other", at: e.created_at, id: e.id, kind: e.kind, agent: e.agent, text: e.text });
    }

    // Stable order: by time, then by type so a handoff precedes the events it caused.
    const rank: Record<string, number> = { round: 0, handoff: 1, chat: 2, question: 3, sys: 4 };
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank[a.type] - rank[b.type]));
    return items.slice(-MAX_ITEMS);
  }

  private showEvent(e: BridgeEvent) {
    if (HIDDEN_EVENT_KINDS.has(e.kind)) return false;
    if (e.kind === "meeting" && /轮.{0,4}发言$/.test(e.text)) return false; // a turn: the round card shows it
    if (e.kind === "gate" && e.text.endsWith("等待你在面板上审批")) return false; // the handoff card carries the gate
    return true;
  }

  /** One card per meeting round that has turns. The latest round of an open meeting carries its controls. */
  private rounds(m: Meeting) {
    const turns = this.ctx.store.meetingTurns(m.id);
    const byRound = new Map<number, MeetingTurn[]>();
    for (const t of turns) byRound.set(t.round, [...(byRound.get(t.round) ?? []), t]);
    const open = ["collecting", "review", "awaiting_approval"].includes(m.status);
    return [...byRound.entries()].map(([round, ts]) => {
      const current = open && round === m.round;
      return {
        type: "round",
        cat: "meeting" as const,
        at: ts[0].created_at,
        meeting_id: m.id,
        topic: m.topic,
        facilitator: m.facilitator,
        round,
        kind: ts[0].kind,
        turns: ts.map((t) => ({ agent: t.agent, at: t.created_at, content: t.content, decisions: t.decisions, tasks: t.tasks })),
        // Controls on the current round: what the human can do now.
        status: current ? m.status : null,
        expected: current ? this.meetings.expectedSpeakers(m) : null,
        note: current ? m.round_note : null,
        doc_path: m.status === "done" && round === m.round ? m.doc_path : null,
      };
    });
  }

  private handoff(h: Handoff) {
    const a = this.ctx.store.attempt(h.attempt_id);
    const task = a?.task_id ? this.ctx.store.task(a.task_id) : undefined;
    const multi = task ? this.ctx.store.tasks(task.run_id).length > 1 : false;
    let gate = null;
    if (a?.status === "awaiting_approval") {
      const stage = task?.stages.find((s) => s.id === a.stage_id) ?? this.ctx.cfg.pipeline.find((s) => s.id === a.stage_id);
      gate = {
        attempt_id: a.id,
        reject_to: stage?.on_reject ?? a.stage_id,
        reject_first: h.data.verdict === "reject",
        feedback: this.scheduler.parseFeedback(a.feedback),
      };
    }
    return {
      type: "handoff",
      cat: "task" as const,
      at: h.created_at,
      id: h.id,
      run_id: h.run_id,
      agent: h.agent,
      stage_id: h.stage_id,
      task: task && multi ? { key: task.key, title: task.title } : null,
      data: h.data,
      commit_sha: h.commit_sha,
      commit_error: h.commit_error,
      scope_notes: h.scope_notes,
      gate,
    };
  }
}
