const rendered = new WeakMap();
const drafts = new Map();
let draftPrefix = "bridge.draft.";
try { draftPrefix += (sessionStorage.getItem("bridge.draftProject") ?? "") + "."; } catch { /* Optional storage. */ }

export const $ = (selector, root = document) => root.querySelector(selector);
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function content(element, html = "") {
  if (rendered.get(element) === html) return;
  const details = new Map([...element.querySelectorAll("details[data-detail]")].map((d) => [d.dataset.detail, d.open]));
  const copies = copyTokens(element);
  const focused = focusedCopyField(element);
  element.innerHTML = html;
  for (const d of element.querySelectorAll("details[data-detail]")) {
    if (details.has(d.dataset.detail)) d.open = details.get(d.dataset.detail);
  }
  restoreCopyFallbacks(element, copies, focused);
  restoreDrafts(element);
  rendered.set(element, html);
}

// 「复制叫醒语」 boxes get a token when clicked. The token (and its manual-copy fallback) survives only a
// re-render of the same card body showing the same phrase; a removed card, another member or another
// phrase yields a fresh box without it, so a late clipboard answer for the old box is dropped.
const copyFallbacks = new Map();
let nextCopyToken = 1;

function copyBoxKey(box) {
  return $("button[data-wake]", box)?.dataset.wake ?? "";
}

export function copyToken(box) {
  if (!box.dataset.copyToken) box.dataset.copyToken = String(nextCopyToken++);
  return box.dataset.copyToken;
}

export function findCopyBox(token) {
  return document.querySelector('.wake-copy[data-copy-token="' + token + '"]');
}

/** Records (or with null, forgets) the fallback state for a copy box's token. */
export function rememberCopyFallback(token, fallback) {
  if (fallback) copyFallbacks.set(token, fallback);
  else copyFallbacks.delete(token);
}

function copyTokens(element) {
  const tokens = new Map();
  for (const box of element.querySelectorAll(".wake-copy[data-copy-token]")) tokens.set(copyBoxKey(box), box.dataset.copyToken);
  return tokens;
}

export function showCopyFallback(box, { value, status }, { focus = false, selection = null } = {}) {
  const field = $("input", box);
  field.value = value;
  field.hidden = false;
  $("[data-copy-status]", box).textContent = status;
  if (!focus) return;
  field.focus({ preventScroll: true });
  if (selection) field.setSelectionRange(selection[0], selection[1], selection[2]);
  else field.select();
}

function focusedCopyField(element) {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !element.contains(active)) return null;
  const token = active.closest(".wake-copy[data-copy-token]")?.dataset.copyToken;
  return token ? { token, selection: [active.selectionStart, active.selectionEnd, active.selectionDirection] } : null;
}

function restoreCopyFallbacks(element, tokens, focused) {
  if (tokens.size) {
    for (const box of element.querySelectorAll(".wake-copy")) {
      const token = tokens.get(copyBoxKey(box));
      if (!token) continue;
      tokens.delete(copyBoxKey(box));
      box.dataset.copyToken = token;
      const fallback = copyFallbacks.get(token);
      if (fallback) showCopyFallback(box, fallback, { focus: focused?.token === token, selection: focused?.selection });
    }
  }
  // Tokens whose box is gone (card removed, member switched, phrase changed) drop their state.
  for (const token of copyFallbacks.keys()) if (!findCopyBox(token)) copyFallbacks.delete(token);
}

function draft(key) {
  if (drafts.has(key)) return drafts.get(key);
  try { return sessionStorage.getItem(draftPrefix + key) ?? ""; } catch { return ""; }
}

export function restoreDrafts(root) {
  for (const field of root.querySelectorAll("[data-keep]")) field.value = draft(field.dataset.keep);
}

export function setDraftProject(project) {
  const prefix = "bridge.draft." + project + ".";
  if (prefix === draftPrefix) return;
  drafts.clear();
  draftPrefix = prefix;
  try { sessionStorage.setItem("bridge.draftProject", project); } catch { /* Optional storage. */ }
  restoreDrafts(document);
}

// A tab keeps its drafts across reloads and syncs copies of a shared control.
export function saveDraft(field, value = field.value) {
  const key = field.dataset.keep;
  drafts.set(key, value);
  try {
    if (value) sessionStorage.setItem(draftPrefix + key, value);
    else sessionStorage.removeItem(draftPrefix + key);
  } catch { /* The in-memory draft is still available. */ }
  for (const peer of document.querySelectorAll("[data-keep]")) {
    if (peer.dataset.keep === key && peer.value !== value) peer.value = value;
  }
}

export function showError(area, error) {
  $("[data-error]", area).textContent = error?.message || "";
}

function renderControl(element, control) {
  element.hidden = !control;
  if (!control) return;
  const fieldArea = $(".control-field", element);
  const field = control.field;
  const existing = fieldArea.firstElementChild;
  if (field && existing?.dataset.keep === field.key) {
    existing.placeholder = field.placeholder;
    existing.setAttribute("aria-label", field.label);
  } else if (field || existing) {
    const input = field && document.createElement(field.inline ? "input" : "textarea");
    if (input) {
      input.dataset.keep = field.key;
      if (field.inline) input.className = "field";
      input.placeholder = field.placeholder;
      input.setAttribute("aria-label", field.label);
      if (!field.inline) input.rows = 2;
      input.value = draft(field.key);
    }
    fieldArea.replaceChildren(...(input ? [input] : []));
    showError(element, null);
  }
  fieldArea.hidden = !field;
  content($(".button-row", element), control.buttons);
}

function renderRow(element, row) {
  const className = row.className || "";
  if (element.className !== className) element.className = className;
  if (row.anchor && element.id !== row.anchor) {
    element.id = row.anchor;
    element.tabIndex = -1;
  }
  const heading = element.children[0];
  const controls = element.children[1];
  const body = element.children[2];
  const children = element.children[3];
  heading.hidden = !row.heading;
  body.hidden = !row.body;
  children.hidden = !row.children?.length;
  content(heading, row.heading);
  renderControl(controls, row.control);
  content(body, row.body);
  if (row.children?.length || children.firstElementChild) rows(children, row.children ?? []);
}

// Stable row keys prevent unrelated refreshes from replacing editable controls or open cards.
export function rows(container, data) {
  const focused = document.activeElement;
  const editable = container.contains(focused) && focused.matches("[data-keep]");
  const selection = editable && [focused.selectionStart, focused.selectionEnd, focused.selectionDirection];
  const keys = new Set(data.map((row) => String(row.key)));
  const existing = new Map();
  for (const row of [...container.children]) {
    if (keys.has(row.dataset.key)) existing.set(row.dataset.key, row);
    else row.remove();
  }
  let next = container.firstElementChild;
  for (const row of data) {
    const key = String(row.key);
    let element = existing.get(key);
    if (!element) {
      element = document.createElement("article");
      element.dataset.key = key;
      element.innerHTML = '<div class="row-heading"></div><div class="row-controls" data-action-area hidden><div class="control-field"></div><div class="button-row"></div><p class="form-error" data-error role="alert"></p></div><div class="row-body"></div><div class="row-items"></div>';
    }
    // Keep ancestor identity too when a new, higher-priority card precedes the focused one.
    if (element !== next) {
      if (element.parentElement === container && container.moveBefore) container.moveBefore(element, next);
      else container.insertBefore(element, next);
    }
    renderRow(element, row);
    next = element.nextElementSibling;
  }
  if (selection && document.activeElement !== focused && focused.isConnected && focused.getClientRects().length) {
    focused.focus({ preventScroll: true });
    if (selection[0] !== null) focused.setSelectionRange(...selection);
  }
}

const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const relative = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
export const time = (iso) => iso ? clock.format(new Date(iso)) : "";

export function since(iso) {
  if (!iso) return "时间待确认";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return relative.format(-minutes, "minute");
  if (minutes < 1440) return relative.format(-Math.floor(minutes / 60), "hour");
  return relative.format(-Math.floor(minutes / 1440), "day");
}

export function day(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN");
}

export const memberColor = (id) => ["claude", "codex", "human"].includes(id) ? id : "unknown";
export function avatar(id, ids) {
  const name = id === "human" ? "你" : id;
  const first = name.slice(0, 1);
  const shared = ids.some((other) => other !== id && other[0]?.toLowerCase() === first.toLowerCase());
  const letter = id === "codex" ? "X" : first.toUpperCase() + (shared ? name.slice(1, 2) : "");
  return '<span class="av ' + memberColor(id) + '" aria-hidden="true">' + esc(letter) + "</span>";
}

export const list = (items) => items?.length ? "<ul>" + items.map((text) => "<li>" + esc(text) + "</li>").join("") + "</ul>" : "";

export function details(key, label, body, reveal = false) {
  return '<details data-detail="' + esc(key) + '"' + (reveal ? " data-reveal" : "") + "><summary>" + esc(label) + "</summary>" + body + "</details>";
}
