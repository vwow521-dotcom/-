import { $, avatar, details, esc, rows, since, time } from "../dom.js";
import { meetingOpen } from "../model.js";
import { jump, label, postButton } from "../cards/common.js";

const symbols = {
  idle: "○", working: "▰", reviewing: "▤", meeting: "◆", awaiting_you: "▣",
  unreachable: "!", offline: "×", "never-joined": "–", stale: "◷", unknown: "?",
};

function station(agent, ids) {
  const { id, activity } = agent;
  const state = activity.state;
  const task = activity.link.view === "meeting" ? activity.link : { view: "meeting" };
  return {
    key: id, anchor: "member-" + id, className: "card station",
    heading: '<div class="station-title">' + avatar(id, ids) + "<h3>" + esc(id) + "</h3>" +
      label(activity.label, state === "unreachable" ? "bad" : "") + "</div>",
    body: '<div class="station-art ' + esc(state) + '" aria-hidden="true"><div class="screen">' + esc(symbols[state]) +
      '</div><div class="desk"></div></div><p class="evidence">' + esc(activity.evidence) + "</p>" +
      (activity.since ? '<time class="muted" data-since datetime="' + esc(activity.since) + '" title="' + esc(time(activity.since)) + '">' +
        since(activity.since) + '</time>' : '<span class="muted">暂无活动时间</span>') +
      '<div class="button-row station-actions">' + jump(task, "看任务") +
      '<button type="button" class="text-link" data-act="message" data-agent="' + esc(id) + '">发消息</button>' +
      '<button type="button" class="text-link" data-act="member" data-agent="' + esc(id) + '">' +
      (["unreachable", "stale", "offline", "never-joined"].includes(state) ? "查看异常" : "成员详情") + "</button></div>",
  };
}

export function renderOffice({ agents, meeting, approvals }) {
  const ids = agents.map((a) => a.id);
  const tables = [];
  if (meetingOpen(meeting)) {
    tables.push({
      key: "meeting-table", className: "card office-table meeting-table",
      heading: '<h2>会议桌</h2><p class="prose">' + esc(meeting.topic) + "</p>",
      body: '<div class="table-seats">' + meeting.participants.map((id) => '<span class="participant">' +
        avatar(id, ids) + esc(id) + "</span>").join("") + "</div>" +
        jump({ view: "meeting", anchor: "round-" + meeting.id + "-" + meeting.round }, "查看第 " + meeting.round + " 轮"),
    });
  }
  if (approvals) {
    tables.push({
      key: "approvals", className: "card office-table approval-table",
      heading: "<h2>审批桌</h2>",
      body: '<button type="button" class="approval-stack" data-act="inbox" aria-haspopup="dialog">' +
        '<span class="paper-stack" aria-hidden="true"></span><span>' + approvals + " 项待审批 →</span></button>",
    });
  }
  rows($("#office-tables"), tables);
  rows($("#office-stations"), agents.map((agent) => station(agent, ids)));
}

export function renderMemberDetails(agent, ids, delivery) {
  const container = $("#member-details");
  $("#member-title").textContent = agent?.id ?? "成员详情";
  if (!agent) {
    rows(container, []);
    return;
  }
  const { activity, binding, id } = agent;
  const start = "你是 AI 协作桥中的 " + id + "。调用 bridge 的 join（agent_id = " + JSON.stringify(id) +
    "），然后按返回的 protocol 工作。交接单和进度汇报用中文。";
  const info = [
    ["门铃", (agent.doorbellLabel || agent.doorbell) + (agent.doorbell === "poll" ? "" : agent.doorbellArmed ? " · 已接通" : " · 未接通")],
    ["门铃顺序", agent.doorbellChain.join(" → ")],
    ["最近门铃", [agent.lastRingVia, time(agent.lastRingAt)].filter(Boolean).join(" · ")],
    ["会话绑定", binding ? [binding.session, time(binding.since), binding.open ? "已连接" : "已断开"].filter(Boolean).join(" · ") : "暂无"],
    ["最近活动", time(agent.lastSeenAt)],
    ["信件", ["未取 " + agent.pendingMail, "排队 " + agent.waitingForTurn, "待确认 " + agent.unackedMail].join(" · ")],
  ];
  rows(container, [{
    key: id, className: "card diagnostics",
    heading: '<div class="station-title">' + avatar(id, ids) + "<h3>" + esc(id) + "</h3>" + label(activity.label) + "</div>" +
      '<p class="prose">' + esc(activity.evidence) + "</p>" +
      (delivery ? '<p class="notice">' + esc(delivery.message) + "</p>" : ""),
    control: binding ? { buttons: postButton("release", id, "释放身份", { style: "danger" }) } : undefined,
    body: '<dl class="diagnostic-list">' + info.filter((entry) => entry[1]).map(([name, value]) =>
      "<div><dt>" + esc(name) + "</dt><dd>" + esc(value) + "</dd></div>").join("") + "</dl>" +
      (agent.doorbellError ? '<p class="bad prose">' + esc(agent.doorbellError) + "</p>" : "") +
      (activity.state === "never-joined" || delivery?.reason === "never-joined"
        ? details("join", "启动提示词", '<p class="detail-body prose">' + esc(start) + "</p>") : ""),
  }]);
}
