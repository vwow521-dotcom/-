import { $, esc, rows } from "./dom.js";
import { resolveInbox, splitTimeline } from "./model.js";
import { jump, label, timeTag } from "./cards/common.js";
import { handoffCard } from "./cards/handoff.js";
import { questionCard } from "./cards/question.js";
import { roundCard } from "./cards/round.js";

const locations = { chat: "聊天室", meeting: "会议室", office: "办公室" };

function inboxCard(item, ids) {
  const context = item.context;
  let card;
  if (context?.type === "handoff") card = handoffCard(context);
  else if (context?.type === "round") card = roundCard(context, ids, { topic: true });
  else if (context?.type === "question") card = questionCard(context);
  else if (context?.type === "delivery") {
    card = {
      className: "card delivery-card",
      heading: '<div class="row-meta">' + label("投递异常", "urgent") + timeTag(item.at) + "</div><h3>" + esc(item.title) + "</h3>" +
        '<p class="prose">' + esc(context.message) + "</p>",
    };
  } else {
    card = { className: "card", heading: "<h3>" + esc(item.title) + "</h3>" };
  }
  return {
    ...card, key: item.id,
    body: (card.body || "") + '<p class="card-link">' + jump(item.target, "在" + locations[item.target.view] + "查看 →") + "</p>",
  };
}

export function renderInbox({ inbox, contexts, ids }) {
  const groups = resolveInbox(inbox, splitTimeline(contexts));
  rows($("#inbox-items"), groups.length ? groups.map((group) => ({
    key: group.urgency, className: "inbox-group",
    heading: groups.length > 1 ? "<h3>" + (group.urgency === "high" ? "优先处理" : "其他待办") + "</h3>" : "",
    children: group.items.map((item) => inboxCard(item, ids)),
  })) : [{ key: "empty", className: "empty", body: "没有待你处理的事项。" }]);
}
