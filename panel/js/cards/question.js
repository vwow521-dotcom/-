import { esc } from "../dom.js";
import { label, postButton, timeTag } from "./common.js";

export function questionCard(item, anchor) {
  const key = "question-" + item.id;
  return {
    key, anchor, className: "card question-card",
    heading: '<div class="row-meta">' + label("待回答") + timeTag(item.at) +
      "</div><h3>" + esc(item.agent) + ' 的问题</h3><p class="prose">' + esc(item.question) + "</p>",
    control: {
      field: { key, label: "给 " + item.agent + " 的回答", placeholder: "写下回答", inline: true },
      buttons: postButton("answer", item.id, "回答", { style: "primary" }),
    },
  };
}
