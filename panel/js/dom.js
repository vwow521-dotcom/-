const rendered = new WeakMap();
const drafts = new Map();

export const $ = (selector, root = document) => root.querySelector(selector);
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function content(element, html = "") {
  if (rendered.get(element) === html) return;
  const details = new Map([...element.querySelectorAll("details[data-detail]")].map((d) => [d.dataset.detail, d.open]));
  const focused = focusedCopyField(element);
  element.innerHTML = html;
  for (const d of element.querySelectorAll("details[data-detail]")) {
    if (details.has(d.dataset.detail)) d.open = details.get(d.dataset.detail);
  }
  restoreCopyFallbacks(element, focused);
  rendered.set(element, html);
}

// Manual-copy fallbacks of 「复制叫醒语」, kept across re-renders of the same card and phrase.
const copyFallbacks = new Map();

/** Identifies a copy box by where it is (drawer or view), its card's row keys, and its phrase. */
export function copyBoxKey(box) {
  const keys = [];
  for (let row = box.closest("[data-key]"); row; row = row.parentElement?.closest("[data-key]")) keys.unshift(row.dataset.key);
  const scope = box.closest("dialog[id], [id^='view-']")?.id ?? "";
  return [scope, ...keys, $("button[data-wake]", box)?.dataset.wake ?? ""].join("\u0000");
}

export function findCopyBox(key) {
  return [...document.querySelectorAll(".wake-copy")].find((box) => copyBoxKey(box) === key) ?? null;
}

/** Records (or with null, forgets) the fallback state for a copy box. */
export function rememberCopyFallback(key, fallback) {
  if (fallback) copyFallbacks.set(key, fallback);
  else copyFallbacks.delete(key);
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
  if (!copyFallbacks.size || !(active instanceof HTMLInputElement) || !element.contains(active)) return null;
  const box = active.closest(".wake-copy");
  return box ? { key: copyBoxKey(box), selection: [active.selectionStart, active.selectionEnd, active.selectionDirection] } : null;
}

function restoreCopyFallbacks(element, focused) {
  if (!copyFallbacks.size) return;
  for (const box of element.querySelectorAll(".wake-copy")) {
    const key = copyBoxKey(box);
    const fallback = copyFallbacks.get(key);
    if (fallback) showCopyFallback(box, fallback, { focus: focused?.key === key, selection: focused?.selection });
  }
  // A card that is gone, switched to another member, or now shows another phrase drops its state.
  for (const key of copyFallbacks.keys()) if (!findCopyBox(key)) copyFallbacks.delete(key);
}

// The same question or approval can appear in a view and in the drawer.
export function saveDraft(field, value = field.value) {
  const key = field.dataset.keep;
  if (value) drafts.set(key, value);
  else drafts.delete(key);
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
      input.placeholder = field.placeholder;
      input.setAttribute("aria-label", field.label);
      if (!field.inline) input.rows = 2;
      input.value = drafts.get(field.key) ?? "";
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

const colors = ["amber", "green", "blue", "berry", "olive", "violet"];
export function avatar(id, ids) {
  const name = id === "human" ? "你" : id;
  const first = name.slice(0, 1);
  const shared = ids.some((other) => other !== id && other[0]?.toLowerCase() === first.toLowerCase());
  const color = id === "human" ? "human" : colors[Math.max(0, ids.indexOf(id)) % colors.length];
  return '<span class="avatar ' + color + '" aria-hidden="true">' + esc(first.toUpperCase() + (shared ? name.slice(1, 2) : "")) + "</span>";
}

export const list = (items) => items?.length ? "<ul>" + items.map((text) => "<li>" + esc(text) + "</li>").join("") + "</ul>" : "";

export function details(key, label, body, reveal = false) {
  return '<details data-detail="' + esc(key) + '"' + (reveal ? " data-reveal" : "") + "><summary>" + esc(label) + "</summary>" + body + "</details>";
}
