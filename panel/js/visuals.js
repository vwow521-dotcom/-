import { avatar, esc, memberColor } from "./dom.js";
import { routeHref } from "./router.js";

export const icons = {
  meeting: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v8H6l-3 3v-3H2z"/></svg>',
  run: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5v4H2zm7 0h5v4H9zM2 9h5v4H2zm9.5 0L14 11l-2.5 2V9z"/></svg>',
  bell: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v3L2 11v1h12v-1l-1.5-2V6A4.5 4.5 0 0 0 8 1.5zM6.2 13a1.8 1.8 0 0 0 3.6 0z"/></svg>',
  office: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  home: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 3 10.5V21h6.5v-6h5v6H21V10.5z"/></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  check: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5 12 8l-8 5.5z"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>',
  redo: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3v4H9"/><path d="M13 7a5.5 5.5 0 1 0 .5 3"/></svg>',
  jump: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  detail: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M10 2.5v11"/></svg>',
  chat: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 3h12v8H6l-3 3v-3H2z"/></svg>',
  queue: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h12M2 8h8M2 12h6"/><path d="M12 10v4M10 12h4"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m3 3 10 10M13 3 3 13"/></svg>',
  eq: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="6" width="2.5" height="8" rx="1"/><rect x="6.75" y="2" width="2.5" height="12" rx="1"/><rect x="11.5" y="8" width="2.5" height="6" rx="1"/></svg>',
  lib: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h2v18H4zM9 3h2v18H9zm5.2.6 1.9-.6 5.6 17.2-1.9.6z"/></svg>',
};

export const scenes = {
  working: ["工作中", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><rect x="14" y="18" width="68" height="46" rx="6"/><path d="M38 76h20M48 64v12"/><path d="M28 34l8 7-8 7M42 48h14" /></svg>', "run"],
  reviewing: ["审查中", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M22 14h34l14 14v40a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z"/><path d="M30 34h22M30 44h16"/><circle cx="62" cy="62" r="11"/><path d="M70 70l10 10"/></svg>', "run"],
  meeting: ["开会中", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4"><ellipse cx="48" cy="54" rx="28" ry="12"/><circle cx="20" cy="30" r="7"/><circle cx="48" cy="22" r="7"/><circle cx="76" cy="30" r="7"/></svg>', "run"],
  awaiting: ["等你审批", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"><path d="M14 56l12-30h44l12 30v18a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z"/><path d="M14 56h22l4 8h16l4-8h22"/><circle cx="72" cy="22" r="10" fill="currentColor" stroke="none"/></svg>', "need"],
  idle: ["待命", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M22 40h44v16a18 18 0 0 1-18 18h-8a18 18 0 0 1-18-18z"/><path d="M66 46h6a8 8 0 0 1 0 16h-6"/><path d="M36 18c0 6 6 6 6 12M50 18c0 6 6 6 6 12"/></svg>', "ok"],
  unreach: ["叫不醒", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"><path d="M48 14l36 64H12z"/><path d="M48 40v18M48 66v2" stroke-linecap="round"/></svg>', "bad"],
  unknown: ["状态未知", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-dasharray="6 6"><circle cx="48" cy="48" r="32"/><path d="M38 40a10 10 0 1 1 14 9c-3 2-4 4-4 7M48 66v1" stroke-dasharray="0"/></svg>', "done"],
  stale: ["连接待确认", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4"><circle cx="48" cy="52" r="28"/><path d="M38 14h20M48 24v10M48 38v16l8 7"/></svg>', "need"],
  "never-joined": ["未加入", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M30 23v15m22-15v15M23 40h36v10a18 18 0 0 1-36 0zm18 28v12h26m-1-36 12 12m0-12L66 56"/></svg>', "done"],
  offline: ["离线", '<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M60 18a30 30 0 1 0 18 46A26 26 0 0 1 60 18z"/></svg>', "done"],
};

export const kindLabel = (folder) => folder.kind === "meeting" ? "会议" : "工作流";
export const folderLabel = (folder) => kindLabel(folder) + " #" + folder.id.slice(1);
const status = {
  active: "执行中", awaiting_approval: "待你审批", collecting: "征集发言", review: "待你决定下一步",
  done: "已完成", stopped: "已停止", cancelled: "已取消",
};
export const statusLabel = (folder) => status[folder.status] ?? folder.status;
export const isClosed = (folder) => ["done", "stopped", "cancelled"].includes(folder.status);
export const sceneKey = (a) => ({ awaiting_you: "awaiting", unreachable: "unreach" })[a.activity.state] ?? a.activity.state;
export const scene = (a) => scenes[sceneKey(a)] ?? scenes.unknown;
export const pill = (text, tone = "done") => `<span class="pill ${tone}">${esc(text)}</span>`;
export const who = (id, ids) => `<span class="who">${avatar(id, ids)}${esc(id)}</span>`;

const coverColors = ["#2b59c3", "#0b8173", "#7c4ddb", "#a3520b", "#475467"];
export function coverTint(folder) {
  const hash = [...folder.id].reduce((n, char) => (n * 31 + char.charCodeAt(0)) >>> 0, 0);
  const member = memberColor(folder.members[0]);
  return [
    `color-mix(in srgb, var(--m-${member}) 55%, ${coverColors[hash % coverColors.length]})`,
    coverColors[(hash + 2) % coverColors.length],
  ];
}
export function cover(folder, style = "") {
  if (!folder) return `<span class="cv ${style}" aria-hidden="true">${icons.run}</span>`;
  const [a, b] = coverTint(folder);
  return `<span class="cv ${style}" style="--g:linear-gradient(135deg,${a},${b})" aria-hidden="true">${icons[folder.kind]}</span>`;
}
export const needCover = () => `<span class="cv need-cover" aria-hidden="true">${icons.bell}</span>`;
export const officeCover = () => `<span class="cv office-cover" aria-hidden="true">${icons.office}</span>`;
export function memberCover(id, style = "") {
  const letter = id === "codex" ? "X" : [...id][0]?.toUpperCase();
  return `<span class="cv round ${style}" style="--g:var(--m-${memberColor(id)})" aria-hidden="true"><b>${esc(letter)}</b></span>`;
}

export function href(target, body, { cls = "", label, attrs = "" } = {}) {
  return `<a class="${cls}" data-jump href="${esc(routeHref(target))}"${label ? ` title="${esc(label)}" aria-label="${esc(label)}"` : ""} ${attrs}>${body}</a>`;
}
export function localButton(action, body, { cls = "", label, attrs = "" } = {}) {
  return `<button type="button" class="${cls}" data-act="${action}"${label ? ` title="${esc(label)}" aria-label="${esc(label)}"` : ""} ${attrs}>${body}</button>`;
}
export const memberMessage = (agent, body = "发消息", cls = "pillbtn ghost sm") =>
  localButton("message", body, { cls, label: "给 " + agent + " 发消息", attrs: `data-agent="${esc(agent)}"` });
export const elapsed = (iso) => "已 " + Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000)) + " 分钟";
