import { esc, time } from "../dom.js";
import { routeHref } from "../router.js";

export function postButton(action, id, label, { style = "", value = "", confirm = "", icon } = {}) {
  const cls = icon ? "ib" : "pillbtn sm " + (style === "primary" ? "run primary" : style || "ghost");
  return '<button type="button" class="' + cls + '" data-post="' + esc(action) + '" data-id="' + esc(id) +
    '" data-value="' + esc(value) + '" data-confirm="' + esc(confirm) + '"' +
    (icon ? ' aria-label="' + esc(label) + '" title="' + esc(label) + '">' + icon : '>' + esc(label)) + "</button>";
}

export function jump(target, text, style = "text-link") {
  return '<a class="' + esc(style) + '" data-jump href="' + esc(routeHref(target)) + '">' + esc(text) + "</a>";
}

export function timeTag(iso) {
  return iso ? '<time datetime="' + esc(iso) + '">' + time(iso) + "</time>" : "";
}

export function label(text, style = "") {
  const tone = { urgent: "need", good: "ok", bad: "bad", run: "run" }[style] ?? "done";
  return '<span class="pill ' + tone + '">' + esc(text) + "</span>";
}

export function copyWakeButton(phrase) {
  return '<div class="wake-copy"><button type="button" class="pillbtn ghost sm" data-act="copyWake" data-wake="' +
    esc(phrase) + '">复制叫醒语</button><span class="muted" data-copy-status role="status"></span>' +
    '<input type="text" readonly hidden aria-label="叫醒语"></div>';
}
