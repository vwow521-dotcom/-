import { $, avatar, details, esc, rows, time } from "../dom.js";
import { currentRound, meetingOpen, meetingStatus, roundKind, runOpen, timelineTarget } from "../model.js";
import { jump, label, postButton, timeTag } from "../cards/common.js";
import { handoffCard } from "../cards/handoff.js";
import { roundCard } from "../cards/round.js";

const phaseNames = ["提案", "互评", "定稿", "批准", "执行"];
const taskStatus = { pending: "未开始", active: "进行中", done: "已完成", cancelled: "已取消" };
const runStatus = { active: "执行中", awaiting_approval: "待你审批", done: "已完成", stopped: "已停止" };

function stages(meeting, runs) {
  const execution = runs.find((r) => r.id === meeting.run_id);
  let current = phaseNames.indexOf(roundKind[meeting.round_kind]);
  if (meeting.status === "awaiting_approval") current = 3;
  if (meeting.status === "done") current = 4;
  const didCritique = meeting.round_kind === "critique" || meeting.turns.some((t) => t.kind === "critique");
  return '<ol class="phases" aria-label="会议进度">' + phaseNames.map((name, index) => {
    const skipped = index === 1 && current > 1 && !didCritique;
    const complete = (index < current && !skipped) || (index === 4 && execution?.status === "done");
    const active = index === current && meeting.status !== "cancelled" && !complete;
    return '<li class="' + (complete ? "complete" : active ? "active" : "") + '"' +
      (active ? ' aria-current="step"' : "") + ">" + name + (skipped ? '<small>跳过</small>' : "") + "</li>";
  }).join("") + "</ol>";
}

function leaseList(leases) {
  if (!leases.length) return "";
  return '<ul class="leases">' + leases.map((lease) =>
    '<li><code>' + esc(lease.glob) + '</code><span class="' + (lease.expired ? "bad" : "muted") + '">' +
    esc(lease.agent) + (lease.expired ? " · 已过期" : lease.expires_at ? " · 到 " + time(lease.expires_at) : "") + "</span></li>").join("") + "</ul>";
}

function taskRow(task, tasks, leases, handoffs, ids, goal) {
  const stage = task.live && task.stages.find((step) => step.id === task.live.stage_id);
  const status = task.live?.status === "awaiting_approval" ? label("待你审批", "urgent")
    : task.live?.status === "ready" ? label("待领取") : label(taskStatus[task.status], task.status === "done" ? "good" : "");
  const dependencies = task.depends_on.map((key) => {
    const dep = tasks.find((t) => t.key === key);
    return dep ? jump({ view: "meeting", anchor: "task-" + dep.id }, key + " " + taskStatus[dep.status]) : esc(key);
  });
  const body = '<dl class="task-meta"><div><dt>负责人</dt><dd>' + avatar(task.owner, ids) + esc(task.owner) +
    "</dd></div>" + (task.reviewer ? "<div><dt>审查人</dt><dd>" + esc(task.reviewer) + "</dd></div>" : "") +
    (task.live ? "<div><dt>当前阶段</dt><dd>" + esc(stage?.role || task.live.stage_id) + " · " + esc(task.live.agent) + "</dd></div>" : "") +
    (dependencies.length ? "<div><dt>依赖</dt><dd>" + dependencies.join("、") + "</dd></div>" : "") +
    "</dl>" + (task.waiting ? '<p class="wait-line">' + esc(task.waiting) + "</p>" : "") +
    (task.description && task.description !== goal ? details("task-description", "任务说明", '<p class="detail-body prose">' + esc(task.description) + "</p>") : "") +
    (task.paths.length ? details("scope", "文件范围", '<p class="detail-body"><code>' + esc(task.paths.join("、")) + "</code></p>") : "") +
    (leases.length ? details("leases", "文件租约 " + leases.length, leaseList(leases)) : "");
  const anchor = "task-" + task.id;
  return {
    key: anchor, anchor, className: "card task-card", body,
    heading: '<div class="row-meta">' + label(task.key) + status + "</div><h3>" + esc(task.title) + "</h3>",
    children: handoffs.map((item) => handoffCard(item, timelineTarget(item).anchor)),
  };
}

export function renderMeeting({ meeting, run, tasks, leases, rounds, handoffs, events, ids, notes, recentRuns }) {
  const items = [];
  if (meeting) {
    const round = currentRound(meeting, rounds);
    items.push({
      key: "meeting-" + meeting.id, className: "card meeting-header",
      heading: '<div class="row-meta">' + label("会议 #" + meeting.id) + label(meetingStatus[meeting.status]) + "</div>" +
        "<h2>" + esc(meeting.topic) + '</h2><div class="participant-line"><span class="muted">参会</span>' +
        meeting.participants.map((id) => '<span class="participant">' + avatar(id, ids) + esc(id) + "</span>").join("") + "</div>",
      body: stages(meeting, recentRuns),
    });
    if (meetingOpen(meeting) || round.turns.length) {
      items.push(roundCard(round, ids, { anchor: timelineTarget(round).anchor }));
    }
    for (const older of [...rounds].reverse()) {
      if (older.meeting_id !== meeting.id || older.round !== round.round)
        items.push(roundCard(older, ids, { anchor: timelineTarget(older).anchor, history: true }));
    }
  }

  const attached = new Set();
  if (run) {
    const cards = tasks.map((task) => {
      const own = handoffs.filter((h) => h.run_id === run.id && (h.task_id === task.id || (!h.task_id && tasks.length === 1)));
      for (const handoff of own) attached.add(handoff.id);
      return taskRow(task, tasks, leases.filter((l) => l.task_id === task.id), own, ids, run.goal);
    });
    items.push({
      key: "run-" + run.id, anchor: "run-" + run.id, className: "execution",
      heading: '<div class="section-head"><h2>执行</h2>' + label(runStatus[run.status]) + "</div>" +
        '<p class="prose"><strong>任务 #' + run.id + "</strong> · " + esc(run.goal) + "</p>",
      control: runOpen(run) ? { buttons: postButton("stopRun", "", "停止当前任务", { style: "danger" }) } : undefined,
      children: cards,
    });
  }
  if (!meeting && !run) {
    items.push({ key: "empty", className: "empty", body: "当前没有会议或任务。可以发起讨论，也可以直接开始流水线。" });
  }
  const old = handoffs.filter((h) => !attached.has(h.id));
  if (old.length) {
    items.push({
      key: "past-handoffs", className: "execution", heading: "<h2>历史交接</h2>",
      children: [...old].reverse().map((h) => handoffCard(h, timelineTarget(h).anchor)),
    });
  }
  const manual = leases.filter((l) => !tasks.some((t) => t.id === l.task_id));
  if (manual.length) {
    items.push({ key: "manual-leases", className: "card", body: details("manual-leases", "其他文件租约", leaseList(manual)) });
  }
  if (events.length) {
    items.push({
      key: "events", className: "card",
      body: details("events", "最近会议与任务事件", '<ol class="event-list">' + [...events].reverse().map((event) =>
        '<li id="event-' + event.id + '" tabindex="-1">' + timeTag(event.at) + "<span>" + esc(event.text) + "</span></li>").join("") + "</ol>"),
    });
  }
  if (notes.length) {
    items.push({
      key: "notes", className: "card", body: details("notes", "共享笔记", '<ul class="detail-body">' + notes.map((n) =>
        '<li class="prose"><strong>' + esc(n.topic) + "</strong> · " + esc(n.agent) + "<br>" + esc(n.text) + "</li>").join("") + "</ul>"),
    });
  }
  const otherRuns = recentRuns.filter((r) => r.id !== run?.id);
  if (otherRuns.length) {
    items.push({
      key: "recent-runs", className: "card", body: details("recent-runs", "最近任务", '<ul class="detail-body">' + otherRuns.map((r) =>
        "<li>#" + r.id + " · " + esc(r.goal) + " · " + esc(runStatus[r.status]) + "</li>").join("") + "</ul>"),
    });
  }
  rows($("#meeting-content"), items);
}
