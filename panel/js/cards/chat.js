import { avatar, esc } from "../dom.js";
import { mentionsInText, receiptLabel } from "../model.js";
import { timeTag } from "./common.js";

function highlight(text, ids) {
  let start = 0;
  let html = "";
  for (const { index, length } of mentionsInText(text, ids)) {
    html += esc(text.slice(start, index)) + '<span class="mention">' + esc(text.slice(index, index + length)) + "</span>";
    start = index + length;
  }
  return html + esc(text.slice(start));
}

const name = (id) => id === "human" ? "你" : id;

export function chatCard(item, ids, messages) {
  const anchor = "message-" + item.id;
  const quote = item.reply_to && messages.get(item.reply_to);
  let quoted = "";
  if (quote) {
    const text = quote.text;
    quoted = "<blockquote>回复 " + esc(name(quote.from_agent)) + " · " + esc(text.length > 80 ? text.slice(0, 80) + "…" : text) + "</blockquote>";
  } else if (item.reply_to) {
    quoted = "<blockquote>回复消息 #" + item.reply_to + "</blockquote>";
  }
  const receipts = item.receipts.map((receipt) => {
    const [status, style] = receiptLabel(receipt);
    return '<span class="' + esc(style) + '">' + esc(receipt.agent) + " " + esc(status) +
      (style === "read" ? " " + timeTag(receipt.read_at) : "") + "</span>";
  }).join("");
  return {
    key: anchor, anchor, className: "message" + (item.from_agent === "human" ? " mine" : ""),
    body: avatar(item.from_agent, ids) + '<div class="message-content"><div class="message-meta"><strong>' + esc(name(item.from_agent)) +
      "</strong>" + timeTag(item.at) + '<button type="button" class="text-link" data-act="reply" data-id="' + item.id +
      '" data-agent="' + esc(item.from_agent) + '">回复</button></div><div class="bubble">' + quoted +
      '<p class="prose">' + highlight(item.text, ids) + "</p></div>" +
      (receipts ? '<div class="receipts" aria-label="送达回执">' + receipts + "</div>" : "") + "</div>",
  };
}
