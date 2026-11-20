import { $, avatar, content, details, esc, rows, time } from "../dom.js";
import { activityTarget, folderTarget, meetingOpen, wakePhrase } from "../model.js";
import { copyWakeButton, label, postButton } from "../cards/common.js";
import { href, localButton, memberMessage, pill, scene, sceneKey, scenes, who } from "../visuals.js";

export function renderOffice(snapshot) {
  const { agents, meeting, timeline } = snapshot;
  const ids = agents.map((a) => a.id);
  const desks = agents.map((a) => {
    const link = activityTarget(a, snapshot);
    const { activity } = a;
    const [, icon, tone] = scene(a);
    const detail = a.diagnostics?.length || ["unreachable", "stale", "offline", "never-joined"].includes(activity.state) ? "查看异常" : "成员详情";
    return `<article class="desk st-${esc(sceneKey(a))}" id="member-${esc(a.id)}" tabindex="-1">
      <div class="scene" aria-hidden="true">${icon}</div><div class="info">
      <div class="nm">${who(a.id, ids)}${pill(activity.label, tone)}</div><p class="ev prose">${esc(activity.evidence)}</p><div class="acts">
      ${link ? href(link, "看任务", { cls: "pillbtn ghost sm" }) : ""}${memberMessage(a.id)}
      ${localButton("member", detail, { cls: "pillbtn ghost sm", attrs: `data-agent="${esc(a.id)}"` })}</div></div></article>`;
  });
  const [, meetingIcon] = scenes.meeting;
  const open = meetingOpen(meeting);
  desks.push(`<article class="desk st-meeting"><div class="scene" aria-hidden="true">${meetingIcon}</div><div class="info">
    <div class="nm"><b>会议桌</b>${open ? pill("会议 #" + meeting.id + " · 第 " + meeting.round + " 轮", "run") : pill("空闲")}</div>
    ${open ? `<p class="ev prose">${esc(meeting.topic)}</p>
      <div class="acts">${href(folderTarget("m" + meeting.id, "discuss", "round-" + meeting.id + "-" + meeting.round),
          "进入会议", { cls: "pillbtn ghost sm" })}</div>` : ""}</div></article>`);
  const diagnoses = timeline.filter((d) => d.type === "diagnostic" && !d.agent).map((d) =>
    `<article class="card" id="${esc(d.id)}" tabindex="-1"><h3>${esc(d.title)}</h3><p class="prose">${esc(d.message)}</p></article>`);
  const legend = Object.entries(scenes).map(([key, [name, icon]]) =>
    `<div class="lg st-${key}"><span class="sw" aria-hidden="true">${icon}</span>${name}</div>`).join("");
  content($("#view-office"), `<div class="hero office-hero"><h1>办公室</h1></div><div class="pad"><div class="desks">
    ${desks.join("")}</div>${diagnoses.join("")}<section class="sec"><div class="sec-h"><h2>状态图例</h2></div>
    <div class="legend">${legend}</div></section></div>`);
}

export function renderMemberDetails(agent, ids, delivery) {
  const container = $("#member-detail");
  $("#member-name").textContent = agent?.id ?? "成员详情";
  if (!agent) {
    rows(container, []);
    return;
  }
  const { activity, binding, diagnostics, doorbellStats, id, product } = agent;
  const start = "你是 AI 协作桥中的 " + id + "。调用 bridge 的 join（agent_id = " + JSON.stringify(id) +
    "），然后按返回的 protocol 工作。交接单和进度汇报用中文。";
  const info = [
    ["产品版本", product ? product.label + " " + (product.version === "unknown" ? "版本未知" : product.version) : ""],
    ["MCP 客户端", product?.client],
    ["门铃", (agent.doorbellLabel || agent.doorbell) + (agent.doorbell === "poll" ? "" : agent.doorbellArmed ? " · 已接通" : " · 未接通")],
    ["门铃顺序", agent.doorbellChain.join(" → ")],
    ["最近门铃", [agent.lastRingVia, time(agent.lastRingAt)].filter(Boolean).join(" · ")],
    ["会话绑定", binding ? [binding.session, time(binding.since), binding.open ? "已连接" : "已断开"].filter(Boolean).join(" · ") : "暂无"],
    ["最近活动", time(agent.lastSeenAt)],
    ["信件", ["未取 " + agent.pendingMail, "排队 " + agent.waitingForTurn, "待确认 " + agent.unackedMail].join(" · ")],
  ];
  const lastResult = { pending: "等待确认", delivered: "已交给客户端", confirmed: "已确认醒来", timeout: "未确认醒来", failed: "响铃失败" };
  const wakeStats = (doorbellStats ?? []).filter((stat) => stat.rings || stat.failed).map((stat) =>
    "<li><strong>" + esc(stat.label) + "</strong> · 响铃 " + stat.rings + " · 确认 " + stat.confirmed + " · 唤醒异常 " + stat.failed +
    (stat.lastResult ? " · 最近结果 " + esc(lastResult[stat.lastResult]) : "") +
    (stat.degradedUntil ? ' <span class="bad">降级至 ' + time(stat.degradedUntil) + "</span>" : "") + "</li>").join("");
  rows(container, [{
    key: id, className: "card diagnostics",
    heading: '<div class="station-title">' + avatar(id, ids) + "<h3>" + esc(id) + "</h3>" + label(activity.label) + "</div>" +
      '<p class="prose">' + esc(activity.evidence) + "</p>" +
      (product?.warning ? '<p class="notice">' + esc(product.warning) + "</p>" : "") +
      (delivery ? '<p class="notice">' + esc(delivery.message) + "</p>" : ""),
    control: binding ? { buttons: postButton("release", id, "释放身份", { style: "danger" }) } : undefined,
    body: '<dl class="diagnostic-list">' + info.filter((entry) => entry[1]).map(([name, value]) =>
      "<dt>" + esc(name) + "</dt><dd>" + esc(value) + "</dd>").join("") + "</dl>" +
      (agent.doorbellError ? '<p class="bad prose">' + esc(agent.doorbellError) + "</p>" : "") +
      (diagnostics?.length ? '<ul class="detail-body">' + diagnostics.map((d) =>
        "<li>" + esc(d.message) + " · Codex " + esc(d.version) + "</li>").join("") + "</ul>" : "") +
      (wakeStats ? details("wake-stats", "门铃统计", '<ul class="detail-body">' + wakeStats + "</ul>") : "") +
      copyWakeButton(wakePhrase(id, product?.id)) +
      (activity.state === "never-joined" || delivery?.reason === "never-joined"
        ? details("join", "启动提示词", '<p class="detail-body prose">' + esc(start) + "</p>") : ""),
  }]);
}
