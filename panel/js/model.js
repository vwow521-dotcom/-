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

export function wakePhrase(agent, product) {
  if (product === "claude-code") return "/bridge";
  if (product === "codex") return "$bridge";
  return "[协作桥] 你有新信。请调用 bridge 的 fetch_inbox（agent_id=" + JSON.stringify(agent) + "）查看并处理。";
}

function timelineKey(it) {
  return it.type === "round" ? "round/" + it.meeting_id + "/" + it.round : it.type + "/" + it.id;
}

export function chatMessages(timeline, chat) {
  const messages = new Map(chat.map((it) => [it.id, it]));
  for (const it of timeline) if (it.type === "chat") messages.set(it.id, it);
  return messages;
}

export function folderTarget(id, tab, anchor, before) {
  return { view: "folder", id, tab, anchor, before };
}

export function runFolder(run) {
  return run.meeting_id ? "m" + run.meeting_id : "r" + run.id;
}

export function runTarget(snapshot, runId) {
  const run = snapshot.run?.id === runId ? snapshot.run : snapshot.recentRuns.find((r) => r.id === runId);
  return run ? runFolder(run) : "r" + runId;
}

export function officeTarget(id) {
  return { view: "office", anchor: id ? "member-" + id : "" };
}

export function playingTarget(item, snapshot) {
  if (item.attempt_id === null) {
    return folderTarget(item.folder, "discuss", "round-" + item.folder.slice(1) + "-" + snapshot.meeting?.round);
  }
  const a = snapshot.lives.find((attempt) => attempt.id === item.attempt_id);
  if (a?.status === "awaiting_approval" && a.handoff_id) return folderTarget(item.folder, "handoffs", "handoff-" + a.handoff_id);
  return folderTarget(item.folder, "tasks", a && "task-" + a.task_id);
}

export function activityTarget(agent, snapshot) {
  const link = agent.activity.link;
  if (link.view !== "meeting") return null;
  const round = /^round-(\d+)-/.exec(link.anchor);
  if (round) return folderTarget("m" + round[1], "discuss", link.anchor);
  if (!snapshot.run) return null;
  return folderTarget(runFolder(snapshot.run), link.anchor.startsWith("handoff-") ? "handoffs" : "tasks", link.anchor);
}

export function inboxContexts(snapshot) {
  const context = new Map(snapshot.timeline.map((it) => [timelineKey(it), it]));
  return snapshot.inbox.map((item) => ({ ...item, context: context.get(timelineKey(item.ref)) }));
}

export function rejectStage(item, tasks) {
  const stage = item.gate?.reject_to;
  return tasks.find((task) => task.id === item.task_id)?.stages.find((s) => s.id === stage)?.role ?? stage;
}

export function inboxTarget(item, snapshot) {
  const it = item.context;
  if (it?.type === "round") return folderTarget("m" + it.meeting_id, "discuss", item.target.anchor);
  if (it?.type === "handoff") return folderTarget(runTarget(snapshot, it.run_id), "handoffs", item.target.anchor);
  return item.target;
}
