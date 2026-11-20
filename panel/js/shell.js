import { $, content, esc, since } from "./dom.js";
import { folderTarget, inboxContexts, officeTarget, playingTarget, runOpen } from "./model.js";
import { renderHomeActions, renderQueue } from "./inbox.js";
import { postButton } from "./cards/common.js";
import { cover, elapsed, folderLabel, href, icons, isClosed, localButton, memberCover, memberMessage, needCover, officeCover, pill, scene, statusLabel } from "./visuals.js";

const filters = [["all", "全部"], ["meeting", "会议"], ["run", "工作流"], ["agent", "成员"]];
const groups = [["need", "待你处理"], ["run", "进行中"], ["done", "已完成"]];
const isKind = (folder, filter) => filter === "all" || folder.kind === filter;
const when = (iso) => `<time datetime="${esc(iso)}" data-since>${esc(since(iso))}</time>`;
const queue = (body, opts = {}) => localButton("right", body, { ...opts, attrs: `data-mode="queue" ${opts.attrs ?? ""}` });
const badge = (count) => count ? `<span class="badge">${count}</span>` : "";
const chip = ([id, title], active, action) => localButton(action, title, {
  cls: "chip", attrs: `data-filter="${id}" aria-pressed="${id === active}"`,
});

export function renderLibrary(snapshot, folders, route, filter, more, error) {
  const first = snapshot.now_playing[0]?.folder;
  const n = snapshot.inbox.length;
  content($("#lib-chips"), filters.map((option) => chip(option, filter, "libFilter")).join(""));
  const pinned = queue(`${needCover()}<span class="bd"><span class="t">待你处理</span><span class="s">已固定 · ${n} 项</span></span>
    <span class="n">${n}</span>`, { cls: "li" + (n ? " has-need" : ""), label: "待你处理 · " + n + " 项" });
  const entries = groups.map(([group, title]) => {
    const matching = folders.filter((f) => f.group === group && isKind(f, filter));
    if (!matching.length) return "";
    return `<h3 class="lib-group">${title}</h3>${matching.map((f) =>
      href(folderTarget(f.id), `${cover(f)}<span class="bd"><span class="t ${first === f.id ? "playing" : ""}">${esc(f.title)}</span>
        <span class="s">${folderLabel(f)} · ${esc(statusLabel(f))}</span></span>${f.needs_you ? `<span class="n">${f.needs_you}</span>` :
          first === f.id ? `<span class="eq">${icons.eq}</span>` : ""}`, {
        cls: "li" + (f.needs_you ? " has-need" : ""), label: f.title,
        attrs: `data-group="${group}" aria-current="${route.id === f.id}"`,
      })).join("")}`;
  }).join("");
  const agents = ["all", "agent"].includes(filter) ? snapshot.agents.map((a) =>
    href(officeTarget(a.id), `${memberCover(a.id)}<span class="bd"><span class="t">${esc(a.id)}</span>
      <span class="s">成员 · ${esc(a.activity.label)}</span></span>`, { cls: "li", label: a.id })).join("") : "";
  const next = filter !== "agent" && more ? localButton("moreFolders", "更多", { cls: "lib-more pillbtn ghost sm", label: "更多文件夹" }) : "";
  const reset = filter === "all" ? "" : localButton("libFilter", "全部", { cls: "narrow-reset lib-more pillbtn ghost sm", attrs: 'data-filter="all"' });
  content($("#lib-list"), pinned + entries + (agents ? '<h3 class="lib-group">成员</h3>' + agents : "") + next + reset +
    (error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""));
}

function shortCut(graphic, title, dot) {
  return graphic + '<span class="t">' + esc(title) + '</span>' + (dot ? '<span class="dot"></span>' : "") +
    '<span class="go" aria-hidden="true">' + icons.arrow + "</span>";
}

function section(title, action, cards) {
  return cards.length ? `<section class="sec"><div class="sec-h"><h2>${title}</h2>${action}</div><div class="cards">${cards.join("")}</div></section>` : "";
}

export function renderHome(snapshot, filter) {
  const recent = snapshot.folders_head.filter((f) => isKind(f, filter));
  content($("#home-chips"), filters.slice(0, 3).map((option) => chip(option, filter, "homeFilter")).join(""));
  content($("#home-shortcuts"), queue(shortCut(needCover(), "待你处理", snapshot.inbox.length), { cls: "sc-i" }) +
    recent.slice(0, 6).map((f) => href(folderTarget(f.id), shortCut(cover(f), f.title, f.needs_you), { cls: "sc-i", label: f.title })).join("") +
    href(officeTarget(), shortCut(officeCover(), "办公室", false), { cls: "sc-i" }));
  const folderCard = (f) => href(folderTarget(f.id), `${cover(f, "fill")}<span class="t">${esc(f.title)}</span>
    <span class="s">${pill(statusLabel(f), f.group)} ${when(f.updated_at)}</span><span class="go" aria-hidden="true">${icons.arrow}</span>`,
  { cls: "card" + (f.needs_you ? " need-card" : ""), label: f.title });
  const all = (group) => localButton("fullGroup", "显示全部", { cls: "link", attrs: `data-group="${group}"` });
  const people = filter === "all" ? snapshot.agents.map((a) =>
    href(officeTarget(a.id), `${memberCover(a.id, "fill")}<span class="t">${esc(a.id)}</span>
      <span class="s">${pill(a.activity.label, scene(a)[2])}${a.activity.since ? " " + when(a.activity.since) : ""}</span>`,
    { cls: "card", label: a.id })) : [];
  content($("#home-lists"), section("进行中", all("run"), recent.filter((f) => !isClosed(f)).map(folderCard)) +
    section("成员", href(officeTarget(), "去办公室", { cls: "link" }), people) +
    section("最近完成", all("done"), recent.filter(isClosed).map(folderCard)));
  renderHomeActions(snapshot, inboxContexts(snapshot));
}

export function renderRight(snapshot, detail, folder, mode, folders) {
  $("#right-title").textContent = mode === "queue" ? "待你处理" : folder?.title ?? "详情";
  $("#right-title").title = $("#right-title").textContent;
  $("#right-details").hidden = mode !== "detail";
  $("#right-queue").hidden = mode !== "queue";
  $('.rp-h [data-mode="detail"]').hidden = mode !== "queue";
  if (mode === "none") return;
  if (mode === "queue") return renderQueue(snapshot, folders);
  $("#right-context").textContent = folder ? folderLabel(folder) + " · " + statusLabel(folder) : "";
  const agents = folder ? snapshot.agents.filter((a) => folder.members.includes(a.id)) : snapshot.agents;
  const empty = (msg) => '<p class="empty">' + msg + "</p>";
  content($("#right-members"), agents.map((a) =>
    `<div class="mem">${memberCover(a.id)}${href(officeTarget(a.id), "<b>" + esc(a.id) + "</b>")}
      ${memberMessage(a.id)}<small>${pill(a.activity.label, scene(a)[2])} ${a.activity.since ? when(a.activity.since) : ""}</small></div>`
  ).join("") || empty("暂无成员"));
  const runId = detail?.run?.id;
  const leases = folder ? snapshot.leases.filter((l) => runId && l.run_id === runId) : snapshot.leases;
  content($("#right-leases"), leases.map((l) =>
    `<div class="lease"><code title="${esc(l.glob)}">${esc(l.glob)}</code>
    <span class="muted">${esc(l.agent + (l.task ? " · " + l.task : ""))}${l.expired ? ' · <span class="need-text">已过期</span>' : ""}</span></div>`
  ).join("") || empty("暂无租约"));
  const notes = folder ? snapshot.notes.filter((n) => n.run_id === null || n.run_id === runId) : snapshot.notes;
  content($("#right-notes"), notes.map((note) =>
    `<p class="note prose"><b>${esc(note.topic)}</b> · ${esc(note.agent)}<br>${esc(note.text)}</p>`
  ).join("") || empty("暂无共享笔记"));
  content($("#right-events"), (folder ? detail?.events ?? [] : snapshot.events).slice(0, 12).map((event) =>
    `<li>${when(event.created_at)}<span>${esc(event.agent ? event.agent + " · " : "")}${esc(event.text)}</span></li>`
  ).join("") || "<li>暂无动态</li>");
}

export function renderPlayer(snapshot, folders, mode, mobile, route) {
  const n = snapshot.inbox.length;
  const item = snapshot.now_playing[0];
  const panelButton = (target, icon, title, count = 0) => localButton("right", icon + badge(count), {
    cls: "ib", label: title, attrs: `data-mode="${target}" aria-pressed="${mode === target}"`,
  });
  const right = `<div class="rt">${panelButton("detail", icons.detail, "详情")}
    ${panelButton("queue", icons.queue, "待你处理" + (n ? " · " + n + " 项" : ""), n)}</div>`;
  if (item) {
    const f = folders.get(item.folder);
    const target = playingTarget(item, snapshot);
    const stageInfo = "第 " + (item.stage_index + 1) + " 步，共 " + item.stage_count + " 步";
    const segs = Array.from({ length: item.stage_count }, (_, i) => `<i class="${i < item.stage_index ? "done" : i === item.stage_index ? "now" : ""}"></i>`).join("");
    const stop = item.attempt_id && runOpen(snapshot.run) ? postButton("stopRun", snapshot.run.id, "停止工作流", { icon: icons.stop }) : "";
    content($("#player"), `<div class="np">${href(folderTarget(item.folder), cover(f), { label: f?.title ?? "文件夹" })}
      <div class="bd"><div class="t">${esc(item.task + " " + item.stage)}</div><div class="s">
      ${href(officeTarget(item.agent), esc(item.agent))} · ${href(folderTarget(item.folder), esc(f ? folderLabel(f) : item.folder))}</div></div></div>
      <div class="ctr"><div class="btns" data-action-area>${memberMessage(item.agent, icons.chat, "ib")}
      ${href(target, icons.jump, { cls: "play", label: "查看这一步" })}${queue(icons.queue, { cls: "ib", label: "接下来" })}${stop}
      <p class="form-error" data-error role="alert"></p></div>
      <div class="prog"><span>${item.attempt_id ? "attempt #" + item.attempt_id : "会议"}</span>
      <div class="segs" style="--stages:${item.stage_count}" role="img" aria-label="${stageInfo}">${segs}</div>
      <time datetime="${esc(item.since)}" data-elapsed>${elapsed(item.since)}</time></div></div>${right}`);
  } else {
    const last = [...folders.values()].find(isClosed);
    content($("#player"), `<div class="np idle-player">${last ? cover(last) : officeCover()}<div class="bd">
      <div class="t">空闲</div><div class="s">${last ? href(folderTarget(last.id), "最近结束 · " + esc(last.title)) : "暂无进行中的工作"}</div>
      </div></div><div></div>${right}`);
  }
  const page = mobile === "right" ? mode : route.view === "workspace" ? "workspace" : route.view === "chat" ? "chat" : "home";
  const attrs = (name) => `aria-current="${name === page ? "page" : "false"}"`;
  content($("#mnav"),
    href({ view: "home" }, icons.home + "<span>主页</span>", { attrs: attrs("home") }) +
    href({ view: "workspace" }, icons.lib + "<span>工作区</span>", { attrs: attrs("workspace") }) +
    href({ view: "chat" }, icons.chat + "<span>聊天</span>", { attrs: attrs("chat") }) +
    queue(icons.queue + "<span>待处理</span>" + badge(n), { attrs: attrs("queue") }));
}
