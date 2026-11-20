import { $, avatar, content, day, esc, rows, showError } from "../dom.js";
import { deliveryHint, splitTimeline, timelineTarget } from "../model.js";
import { chatCard } from "../cards/chat.js";
import { jump, timeTag } from "../cards/common.js";
import { questionCard } from "../cards/question.js";

function timelineRow(it, ids, messages) {
  if (it.type === "chat") return chatCard(it, ids, messages);
  const target = timelineTarget(it);
  if (it.type === "question") return questionCard(it, target.anchor);
  let text = it.text;
  if (it.type === "round") {
    const speakers = it.turns.map((t) => t.agent).join("、");
    text = "会议 #" + it.meeting_id + " 第 " + it.round + " 轮 · " + speakers + " 已发言";
    if (it.status === "awaiting_approval") text += " · 定稿待批准";
  } else if (it.type === "handoff") {
    text = [it.task?.key, it.stage_role, it.gate ? "交接待你审批" : "已交接 · " + it.data.summary].filter(Boolean).join(" ");
  }
  const linkable = it.type !== "sys" || it.cat === "task" || it.cat === "meeting";
  return {
    key: it.type + "-" + (it.id ?? target.anchor),
    className: "timeline-summary",
    body: timeTag(it.at) + (linkable ? jump(target, text + " →", "summary-link") : '<span class="summary-text">' + esc(text) + "</span>"),
  };
}

export function renderMembers(agents) {
  const ids = agents.map((a) => a.id);
  $("#member-count").textContent = agents.length;
  content($("#members"), agents.map((a) => {
    const count = [
      a.pendingMail ? "未取 " + a.pendingMail : "",
      a.waitingForTurn ? "排队 " + a.waitingForTurn : "",
    ].filter(Boolean).join(" · ");
    return '<button type="button" class="member" data-act="member" data-agent="' + esc(a.id) + '" aria-haspopup="dialog">' +
      avatar(a.id, ids) + '<span class="member-text"><strong>' + esc(a.id) + '</strong><span class="member-status">' +
      '<span class="state-dot ' + esc(a.state) + '" aria-hidden="true"></span>' + esc(a.label) + "</span>" +
      (count ? '<span class="muted">' + esc(count) + "</span>" : "") + "</span></button>";
  }).join(""));
}

export function renderChat({ timeline, chat, ids }) {
  const scroll = $("#chat-scroll");
  const atBottom = scroll.clientHeight && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64;
  const { messages } = splitTimeline(timeline, chat);
  const items = [];
  let previousDay = "";
  for (const item of timeline) {
    const current = new Date(item.at).toDateString();
    if (previousDay !== current) {
      previousDay = current;
      items.push({ key: "day-" + current, className: "chat-date", body: esc(day(item.at)) });
    }
    items.push(timelineRow(item, ids, messages));
  }
  rows($("#chat-timeline"), items.length ? items : [{
    key: "empty", className: "empty", body: "还没有消息。选一个成员发消息，或发起协作。",
  }]);
  if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}

export function createComposer(post) {
  const form = $("#composer");
  const text = $("#chat-text");
  const targets = new Set();
  let reply = null;
  let agents = [];

  function hint() {
    $("#delivery-hint").textContent = deliveryHint(agents, targets, reply, text.value);
  }

  function fit() {
    if (!text.clientHeight) return;
    text.style.height = "auto";
    text.style.height = Math.min(text.scrollHeight + 2, 180) + "px";
  }

  function render() {
    const chips = [["all", "@所有人"], ...agents.map(({ id }) => [id, "@" + id])];
    content($("#recipients"), '<span class="muted">发给</span>' + chips.map(([id, label]) =>
      '<button type="button" class="recipient" data-act="target" data-agent="' + esc(id) +
      '" aria-pressed="' + targets.has(id) + '">' + esc(label) + "</button>").join(""));
    const bar = $("#reply-bar");
    bar.hidden = !reply;
    content(bar, reply ? "<span>回复 " + esc(reply.who === "human" ? "你" : reply.who) + " · #" + reply.id +
      '</span><button type="button" class="text-link" data-act="unreply">取消回复</button>' : "");
    hint();
  }

  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  text.addEventListener("input", () => {
    fit();
    hint();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = text.value.trim();
    if (!body || !agents.length) return;
    const replying = reply;
    const success = await post("chat", $('button[type="submit"]', form), { text: body, mentions: [...targets], reply_to: replying?.id });
    if (success) {
      if (replying === reply) reply = null;
      fit();
      render();
      const scroll = $("#chat-scroll");
      if (scroll.clientHeight) scroll.scrollTop = scroll.scrollHeight;
    }
  });
  return {
    update(members) {
      agents = members;
      for (const id of targets) if (id !== "all" && !agents.some((a) => a.id === id)) targets.delete(id);
      render();
    },
    target(id) {
      const remove = targets.has(id);
      if (id === "all") targets.clear();
      else targets.delete("all");
      if (remove) targets.delete(id);
      else targets.add(id);
      render();
    },
    pick(id) {
      targets.clear();
      targets.add(id);
      reply = null;
      showError(form, null);
      render();
    },
    replyTo(id, who) {
      reply = { id, who };
      render();
      text.focus();
    },
    unreply() {
      reply = null;
      render();
      text.focus();
    },
  };
}
