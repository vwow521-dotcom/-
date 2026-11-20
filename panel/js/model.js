// Pure projections of the panel snapshot and composer state.
const ALL = new Set(["all", "全体", "所有人"]);

export function mentionsInText(text, ids) {
  const names = [...ids, ...ALL].sort((a, b) => b.length - a.length);
  return [...text.matchAll(/@/g)].flatMap(({ index }) => {
    const rest = text.slice(index + 1);
    const hit = names.find((name) =>
      rest.toLowerCase().startsWith(name.toLowerCase()) && !/^[A-Za-z0-9_-]/.test(rest.slice(name.length)),
    );
    return hit ? [{ index, length: hit.length + 1, name: hit }] : [];
  });
}

export function recipients(ids, selected, reply, text) {
  const found = new Set();
  const named = [...selected, ...mentionsInText(text, ids).map((hit) => hit.name), reply?.who];
  for (const id of named) {
    if (ALL.has(id?.toLowerCase())) ids.forEach((member) => found.add(member));
    else if (ids.includes(id)) found.add(id);
  }
  return [...found];
}

export function deliveryHint(agents, selected, reply, text) {
  const ids = recipients(agents.map((a) => a.id), selected, reply, text);
  if (!ids.length) return "选收件人，或在消息里 @ 成员。Enter 发送，Shift+Enter 换行。";
  return ids.map((id) => {
    const a = agents.find((agent) => agent.id === id);
    if (a.status === "never-joined") return id + " 还没加入，加入后才能收到";
    if (a.doing.some((d) => d.status === "in_progress") || a.waitingForTurn)
      return id + " 正在做任务，消息排队到这一轮结束";
    if (a.status === "offline") return id + " 不在线，消息会等它回来";
    return id + " 会被「" + (a.doorbellLabel || a.doorbell) + "」叫醒";
  }).join("；") + "。";
}

const RECEIPTS = {
  queued: ["待投递", ""], rung: ["已按门铃", ""], fetched: ["已读", "read"],
  acked: ["已读", "read"], stuck: ["送不到", "bad"], void: ["作废", ""],
};

export function receiptLabel(receipt) {
  return receipt.waitingForTurn ? ["排队中，等它这一轮结束", "queued"] : RECEIPTS[receipt.status] ?? [receipt.status, ""];
}

export function runOpen(run) {
  return run?.status === "active" || run?.status === "awaiting_approval";
}

export function meetingOpen(meeting) {
  return ["collecting", "review", "awaiting_approval"].includes(meeting?.status);
}

export const roundKind = { proposal: "提案", critique: "互评", final: "定稿" };
export const meetingStatus = { collecting: "发言中", review: "待你决定下一步", awaiting_approval: "定稿待批准", done: "已批准", cancelled: "已取消" };

export function waitingSpeakers(round) {
  if (round.status !== "collecting") return [];
  return round.expected.filter((id) => !round.turns.some((t) => t.agent === id));
}

export function roundActions(round) {
  if (round.status === "awaiting_approval") return ["approve", "reject", "cancel"];
  if (["collecting", "review"].includes(round.status)) {
    // The API requires at least one turn and allows no next-round request during finalization.
    if (round.kind !== "final" && round.turns.length) return ["critique", "finalize", "cancel"];
    return ["cancel"];
  }
  return [];
}

export function timelineTarget(it) {
  if (it.type === "round") return { view: "meeting", anchor: "round-" + it.meeting_id + "-" + it.round };
  if (it.type === "handoff") return { view: "meeting", anchor: "handoff-" + it.id };
  if (it.type === "question") return { view: "chat", anchor: "question-" + it.id };
  if (it.type === "delivery") return { view: "office", anchor: "member-" + it.agent };
  if (it.type === "sys") return { view: "meeting", anchor: "event-" + it.id };
  return { view: "chat", anchor: "message-" + it.id };
}

function timelineKey(it) {
  return it.type === "round" ? "round/" + it.meeting_id + "/" + it.round : it.type + "/" + it.id;
}

export function splitTimeline(timeline, chat = []) {
  const context = new Map(timeline.map((it) => [timelineKey(it), it]));
  const messages = new Map(chat.map((it) => [it.id, it]));
  const rounds = [];
  const handoffs = [];
  const events = [];
  for (const it of timeline) {
    if (it.type === "chat") messages.set(it.id, it);
    else if (it.type === "round") rounds.push(it);
    else if (it.type === "handoff") handoffs.push(it);
    else if (it.type === "sys" && (it.cat === "task" || it.cat === "meeting")) events.push(it);
  }
  return { context, messages, rounds, handoffs, events };
}

export function resolveInbox(inbox, timeline) {
  return ["high", "normal"].map((urgency) => ({
    urgency,
    items: inbox.filter((item) => item.urgency === urgency).map((item) => ({
      ...item, context: timeline.context.get(timelineKey(item.ref)),
    })),
  })).filter((group) => group.items.length);
}

export function currentRound(meeting, rounds) {
  const round = rounds.find((it) => it.meeting_id === meeting.id && it.round === meeting.round);
  if (round) return round;
  // An active round can have no turns yet and therefore no historical timeline card.
  return {
    type: "round", meeting_id: meeting.id, round: meeting.round, kind: meeting.round_kind,
    topic: meeting.topic, facilitator: meeting.facilitator, turns: [],
    status: meetingOpen(meeting) ? meeting.status : null, expected: meeting.expected, note: meeting.round_note,
  };
}
