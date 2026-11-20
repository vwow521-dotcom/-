import { createActions } from "./actions.js";
import { $, content, copyToken, esc, findCopyBox, rememberCopyFallback, saveDraft, showCopyFallback, since } from "./dom.js";
import { renderInbox } from "./inbox.js";
import { runOpen, splitTimeline } from "./model.js";
import { readRoute, router } from "./router.js";
import { createState } from "./state.js";
import { createComposer, renderChat, renderMembers } from "./views/chat.js";
import { renderMeeting } from "./views/meeting.js";
import { renderMemberDetails, renderOffice } from "./views/office.js";

function connectionChanged(error) {
  const status = $("#connection");
  const banner = $("#connection-error");
  const next = error ? "offline" : "connected";
  if (status.dataset.status !== next) {
    status.dataset.status = next;
    status.textContent = error ? "已断开" : "已连接";
  }
  banner.hidden = !error;
  const message = error ? "连不上协作桥：" + error.message + "（桥停了？运行 ai-bridge start 后会自动恢复）" : "";
  if (banner.textContent !== message) banner.textContent = message;
}

const state = createState(connectionChanged);
const post = createActions(state.refresh);
const composer = createComposer(post);
const ids = (s) => s.agents.map((a) => a.id);
const scrolls = new Map();
const scrollArea = (view) => view === "chat" ? $("#chat-scroll") : $("#view-" + view);
let selectedMember = "";
let activeView = "";
let pendingAnchor = "";
let focusComposer = false;

function jumpToAnchor() {
  if (!pendingAnchor) return;
  const anchor = document.getElementById(pendingAnchor);
  if (!anchor || !$("#view-" + activeView).contains(anchor)) return;
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  const reveal = $("[data-reveal]", anchor);
  if (reveal) reveal.open = true;
  anchor.scrollIntoView({ block: "start" });
  if (!document.querySelector("dialog[open]")) anchor.focus({ preventScroll: true });
  pendingAnchor = "";
}

const navigate = router(({ view, anchor }) => {
  const changed = activeView !== view;
  if (changed) {
    if (activeView) {
      if (state.current) scrolls.set(activeView, scrollArea(activeView).scrollTop);
      $("#view-" + activeView).hidden = true;
    }
    $("#view-" + view).hidden = false;
    activeView = view;
    const scroll = scrollArea(view);
    scroll.scrollTop = scrolls.get(view) ?? (view === "chat" ? scroll.scrollHeight : 0);
    for (const link of document.querySelectorAll("[data-view]")) {
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
  pendingAnchor = anchor;
  jumpToAnchor();
  if (focusComposer && view === "chat") {
    $("#chat-text").focus({ preventScroll: true });
    focusComposer = false;
  }
});

function openDialog(dialog) {
  if (dialog.open) return;
  document.querySelector("dialog[open]")?.close();
  dialog.showModal();
}

function showMember() {
  const s = state.current;
  if (!s) return;
  renderMemberDetails(s.agents.find((a) => a.id === selectedMember), ids(s),
    s.timeline.find((it) => it.type === "delivery" && it.agent === selectedMember));
}

const local = {
  inbox() { openDialog($("#inbox-dialog")); },
  launch() { openDialog($("#launch-dialog")); },
  close(button) { button.closest("dialog").close(); },
  member(button) {
    selectedMember = button.dataset.agent;
    showMember();
    openDialog($("#member-dialog"));
  },
  message(button) {
    composer.pick(button.dataset.agent);
    focusComposer = true;
    navigate({ view: "chat" });
  },
  target(button) { composer.target(button.dataset.agent); },
  reply(button) { composer.replyTo(Number(button.dataset.id), button.dataset.agent); },
  unreply() { composer.unreply(); },
  async copyWake(button) {
    // Bound to this box: a re-render of the same card and phrase keeps the token, anything else drops it.
    const key = copyToken(button.closest(".wake-copy"));
    const phrase = button.dataset.wake;
    let copied = true;
    try {
      await navigator.clipboard.writeText(phrase);
    } catch {
      copied = false;
    }
    // The card may have been re-rendered (or removed) while the clipboard answered.
    const box = findCopyBox(key);
    if (copied) {
      rememberCopyFallback(key, null);
      if (!box) return;
      $("input", box).hidden = true;
      $("[data-copy-status]", box).textContent = "已复制";
      return;
    }
    const fallback = { value: phrase, status: "已选中，请手动复制" };
    rememberCopyFallback(key, fallback);
    if (!box) return;
    // Select the text unless focus has moved on to something else in the meantime.
    const active = document.activeElement;
    const focus = !active || active === document.body || active === button || box.contains(active);
    showCopyFallback(box, fallback, { focus });
  },
};

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-keep]")) saveDraft(event.target);
});

document.addEventListener("click", async (event) => {
  const link = event.target.closest("a[data-jump]");
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    link.closest("dialog")?.close();
    navigate(readRoute(link.hash));
    return;
  }
  const button = event.target.closest("button[data-act],button[data-post]");
  if (!button) return;
  const action = button.dataset.post;
  if (!action) {
    local[button.dataset.act]?.(button);
    return;
  }
  if (await post(action, button) && ["startRun", "startMeeting"].includes(action)) {
    $("#launch-dialog").close();
    navigate({ view: "meeting" });
  }
});

// Track participant choices separately from the snapshot so connection changes leave them intact.
const participantChoices = new Map();
$("#participants").addEventListener("change", (event) => participantChoices.set(event.target.value, event.target.checked));
state.subscribe(ids, (agents) => {
  content($("#participants"), agents.map((id) =>
    '<label><input type="checkbox" value="' + esc(id) + '"' + (participantChoices.get(id) === false ? "" : " checked") +
    "> " + esc(id) + "</label>").join(""));
});
state.subscribe((s) => ({ project: s.project, inbox: s.inbox.map((it) => it.urgency) }), ({ project, inbox }) => {
  $("#project").textContent = project.split(/[\\/]/).filter(Boolean).at(-1) ?? project;
  $("#project").title = project;
  $("#inbox-count").textContent = inbox.length;
  $("#inbox-button").classList.toggle("has-urgent", inbox.includes("high"));
  document.title = (inbox.length ? "(" + inbox.length + ") " : "") + "AI Bridge 协作面板";
});
state.subscribe((s) => ({ project: s.project, git: s.git, open: runOpen(s.run) }), ({ project, git, open }) => {
  $("#launch-stop").hidden = !open;
  $("#launch-project").textContent = project + " · " + (git.repo ? "Git" + (git.dirty ? " · " + git.dirty + " 项未提交改动" : "") : "未初始化 Git");
});
state.subscribe((s) => s.agents.map((a) => ({
  id: a.id, label: a.activity.label, state: a.activity.state, pendingMail: a.pendingMail, waitingForTurn: a.waitingForTurn,
})), renderMembers);
state.subscribe((s) => s.agents.map(({ id, status, doing, waitingForTurn, doorbellLabel, doorbell }) =>
  ({ id, status, doing, waitingForTurn, doorbellLabel, doorbell })), composer.update);
state.subscribe((s) => ({ timeline: s.timeline, chat: s.chat, ids: ids(s) }), (data) => {
  renderChat(data);
  jumpToAnchor();
});
state.subscribe((s) => ({
  meeting: s.meeting, run: s.run, tasks: s.tasks, leases: s.leases, notes: s.notes, recentRuns: s.recentRuns, ids: ids(s),
  timeline: s.timeline.filter((it) => it.type === "round" || it.type === "handoff" || (it.type === "sys" && ["task", "meeting"].includes(it.cat))),
}), ({ timeline, ...data }) => {
  renderMeeting({ ...data, ...splitTimeline(timeline) });
  jumpToAnchor();
});
state.subscribe((s) => ({
  agents: s.agents.map(({ id, activity, diagnostics }) => ({ id, activity, hasDiagnosis: diagnostics?.length > 0 })),
  diagnoses: s.timeline.filter((it) => it.type === "diagnostic" && !it.agent),
  meeting: s.meeting && { id: s.meeting.id, round: s.meeting.round, status: s.meeting.status, topic: s.meeting.topic, participants: s.meeting.participants },
  approvals: s.inbox.filter((it) => it.kind === "handoff_gate" || it.kind === "meeting_final").length,
}), (data) => {
  renderOffice(data);
  jumpToAnchor();
});
state.subscribe((s) => ({
  inbox: s.inbox, ids: ids(s),
  products: Object.fromEntries(s.agents.map((agent) => [agent.id, agent.product?.id])),
  contexts: s.timeline.filter((it) => it.type === "delivery" || it.type === "diagnostic" || it.type === "question" ||
    (it.type === "round" && ["review", "awaiting_approval"].includes(it.status)) || (it.type === "handoff" && it.gate)),
}), renderInbox);
state.subscribe((s) => ({
  agents: s.agents, deliveries: s.timeline.filter((it) => it.type === "delivery"),
}), showMember);

setInterval(() => {
  for (const timestamp of document.querySelectorAll("time[data-since]")) timestamp.textContent = since(timestamp.dateTime);
}, 60_000);
state.start();
