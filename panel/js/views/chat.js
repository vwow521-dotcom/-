import { $, content, day, esc, rows, showError } from "../dom.js";
import { chatMessages, deliveryHint, folderTarget, meetingOpen, runTarget, waitingSpeakers } from "../model.js";
import { chatCard } from "../cards/chat.js";
import { timeTag } from "../cards/common.js";
import { questionCard } from "../cards/question.js";
import { href, icons } from "../visuals.js";

function systemLine(snapshot, it) {
  const round = it.type === "round";
  const need = !!it.gate || it.status === "awaiting_approval";
  const anchor = round ? "round-" + it.meeting_id + "-" + it.round : "handoff-" + it.id;
  const target = round ? folderTarget("m" + it.meeting_id, "discuss", anchor)
    : folderTarget(runTarget(snapshot, it.run_id), "handoffs", anchor);
  let text;
  if (round) {
    const waiting = waitingSpeakers(it);
    text = "会议 #" + it.meeting_id + " 第 " + it.round + " 轮";
    if (need) text += " · 定稿待批准";
    else if (waiting.length) text += " · 等待 " + waiting.join("、");
    else text += " · " + it.turns.length + " 人已发言";
  } else {
    text = [it.task?.key, it.stage_role, it.gate ? "交接待你审批" : "已交接 · " + it.data.summary].filter(Boolean).join(" ");
  }
  return { key: anchor, body: `<div class="sysline ${need ? "need" : ""}">
    ${round ? icons.meeting : need ? icons.bell : icons.run}<span>${esc(text)}</span>
    ${href(target, need ? "去审批" : "查看")}${timeTag(it.at)}</div>` };
}

export function renderChat(snapshot) {
  const list = $("#chat-timeline");
  const scroll = $("#chat-scroll");
  const followLatest = !list.firstElementChild || (scroll.clientHeight > 0 && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64);
  const { timeline, chat, meeting, agents } = snapshot;
  const ids = agents.map((a) => a.id);
  const messages = chatMessages(timeline, chat);
  const visible = timeline.filter((it) => ["chat", "round", "handoff"].includes(it.type)).slice(-150);
  if (meetingOpen(meeting) && !visible.some((it) => it.type === "round" && it.meeting_id === meeting.id && it.round === meeting.round)) {
    const now = snapshot.now_playing.find((it) => it.folder === "m" + meeting.id);
    visible.push({ type: "round", meeting_id: meeting.id, round: meeting.round, status: meeting.status,
      expected: meeting.expected, turns: [], at: now?.since ?? meeting.created_at });
  }
  const items = [];
  let previousDay = "";
  for (const item of visible) {
    const current = new Date(item.at).toDateString();
    if (previousDay !== current) {
      previousDay = current;
      items.push({ key: "day-" + current, className: "chat-date", body: esc(day(item.at)) });
    }
    items.push(item.type === "chat" ? chatCard(item, ids, messages) : systemLine(snapshot, item));
  }
  for (const item of timeline.filter((it) => it.type === "question")) items.push(questionCard(item, "question-" + item.id));
  rows(list, items);
  $("#chat-people").textContent = [...ids, "你"].join("、");
  $("#chat-status").textContent = messages.size ? "" : "暂无聊天消息 · " +
    (agents.map((a) => a.id + " " + a.activity.label).join(" · ") || "协作桥在线");
  if (followLatest) scroll.scrollTop = scroll.scrollHeight;
}

export function createComposer(post) {
  const form = $("#composer");
  const text = $("#chat-text");
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("bridge.composer") ?? "{}"); } catch { /* Start with empty recipients. */ }
  const targets = new Set(saved.targets ?? []);
  let reply = saved.reply ?? null;
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
    try { sessionStorage.setItem("bridge.composer", JSON.stringify({ targets: [...targets], reply })); } catch { /* Optional on reload. */ }
    const chips = [...agents.map(({ id }) => [id, "@" + id]), ["all", "@所有人"]];
    content($("#recipients"), chips.map(([id, label]) =>
      '<button type="button" class="chip" data-act="target" data-agent="' + esc(id) +
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
  text.addEventListener("focus", fit);
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
