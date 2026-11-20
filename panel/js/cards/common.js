import { esc, time } from "../dom.js";
import { routeHref } from "../router.js";

export function postButton(action, id, label, { style = "", value = "", confirm = "" } = {}) {
  return '<button type="button" class="button ' + esc(style) + '" data-post="' + esc(action) + '" data-id="' + esc(id) +
    '" data-value="' + esc(value) + '" data-confirm="' + esc(confirm) + '">' + esc(label) + "</button>";
}

export function jump(target, text, style = "text-link") {
  return '<a class="' + esc(style) + '" data-jump href="' + esc(routeHref(target)) + '">' + esc(text) + "</a>";
}

export function timeTag(iso) {
  return iso ? '<time datetime="' + esc(iso) + '">' + time(iso) + "</time>" : "";
}

export function label(text, style = "") {
  return '<span class="status-label ' + esc(style) + '">' + esc(text) + "</span>";
}
