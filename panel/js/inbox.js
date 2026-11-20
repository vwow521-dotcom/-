import { $, content, esc, rows } from "./dom.js";
import { inboxContexts, inboxTarget, playingTarget, rejectStage, wakePhrase } from "./model.js";
import { copyWakeButton, jump, label, timeTag } from "./cards/common.js";
import { handoffCard } from "./cards/handoff.js";
import { questionCard } from "./cards/question.js";
import { roundCard } from "./cards/round.js";
import { cover, href, who } from "./visuals.js";

function inboxCard(item, snapshot) {
  const it = item.context;
  const ids = snapshot.agents.map((a) => a.id);
  let card;
  if (it?.type === "handoff") card = handoffCard(it, undefined, rejectStage(it, snapshot.tasks));
  else if (it?.type === "round") card = roundCard(it, ids, { topic: true, showSpeakers: false });
  else if (it?.type === "question") card = questionCard(it);
  else {
    const delivery = it?.type === "delivery";
    const member = snapshot.agents.find((a) => a.id === item.agent);
    card = {
      className: "card",
      heading: `<div class="row-meta">${label(delivery ? "投递异常" : "门铃诊断", delivery ? "urgent" : "")}${timeTag(item.at)}
        </div><h3>${esc(item.title)}</h3><p class="prose">${esc(it?.message)}</p>`,
      body: delivery ? copyWakeButton(wakePhrase(item.agent, member?.product?.id)) : "",
    };
  }
  const target = inboxTarget(item, snapshot);
  const location = { folder: "文件夹", office: "办公室", chat: "聊天" }[target.view] ?? "面板";
  return {
    ...card, key: item.id, anchor: "inbox-" + item.id,
    body: (card.body || "") + '<p class="card-link">' + jump(target, "在" + location + "查看 →") + "</p>",
  };
}

export function renderHomeActions(snapshot, items) {
  $("#home-inbox").hidden = !items.length;
  $("#home-count").textContent = items.length + " 项要你处理";
  const first = items.find((item) => item.kind === "handoff_gate" || item.kind === "meeting_final") ?? items[0];
  const rest = items.filter((item) => item !== first);
  rows($("#home-actions"), first ? [first, ...rest].map((item) => {
    const card = inboxCard(item, snapshot);
    if (item === first) {
      const it = item.context;
      const preview = it?.data?.done?.slice(0, 3);
      const stage = it?.type === "handoff" ? [it.task?.key, it.stage_role].filter(Boolean).join(" ") : "";
      const header = stage
        ? `<div class="row-meta">${label("待你审批", "urgent")}${who(it.agent, snapshot.agents.map((a) => a.id))}
          <span>${esc(stage)}</span>${timeTag(it.at)}</div><h3>${esc(it.data.summary)}</h3>`
        : card.heading;
      return { ...card, anchor: undefined, className: "promo",
        heading: header + (preview?.length ? "<ul>" + preview.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" : "") };
    }
    return { ...card, anchor: undefined, className: "card small-action" };
  }) : []);
}

export function renderQueue(snapshot, folders) {
  const items = inboxContexts(snapshot);
  const playing = snapshot.now_playing;
  const row = (item) => href(playingTarget(item, snapshot),
    `${cover(folders.get(item.folder))}<span class="q-text"><span class="t">${esc(item.task + " " + item.stage)}</span><br>
    <span class="s">${esc(item.agent)}${item.attempt_id ? " · attempt #" + item.attempt_id : ""}</span></span>`, { cls: "q-i" });
  $("#queue-count").textContent = "等你处理" + (items.length ? " · " + items.length : "");
  content($("#queue-playing"), playing.length ? row(playing[0]) : '<p class="empty">空闲</p>');
  rows($("#inbox-items"), items.map((item) => inboxCard(item, snapshot)));
  content($("#queue-next"), playing.length > 1 ? playing.slice(1).map(row).join("") : '<p class="empty">暂无其他进行中的阶段</p>');
}
