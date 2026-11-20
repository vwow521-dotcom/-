import { $, saveDraft, showError } from "./dom.js";

const meeting = (id, end) => "/api/meetings/" + id + "/" + end;
const endpoints = {
  chat: () => "/api/chat",
  decide: (id) => "/api/attempts/" + id + "/decide",
  nextRound: (id) => meeting(id, "next"),
  decideMeeting: (id) => meeting(id, "decide"),
  cancelMeeting: (id) => meeting(id, "cancel"),
  answer: (id) => "/api/questions/" + id + "/answer",
  release: (id) => "/api/agents/" + encodeURIComponent(id) + "/release",
  startRun: () => "/api/runs",
  startMeeting: () => "/api/meetings",
  stopRun: () => "/api/runs/stop",
};

const confirmations = {
  release: (id) => "释放 " + id + " 的身份？新会话可以重新加入，原会话会失去绑定。",
  stopRun: () => "停止当前任务？进行中的阶段会被取消。",
  cancelMeeting: () => "取消当前会议？本轮未处理的邀请会作废。",
};

function payload(action, button, field, area) {
  const value = field?.value ?? "";
  if (action === "answer") return { answer: value };
  if (action === "startRun") return { goal: value };
  if (action === "startMeeting") {
    const participants = [...area.querySelectorAll("#participants input:checked")].map((el) => el.value);
    return { topic: value, participants, facilitator: $("#facilitator", area).value || undefined };
  }
  return { action: button.dataset.value, note: value };
}

export function createActions(refresh) {
  const busy = new Set();
  return async (action, button, chatBody) => {
    const area = button.closest("[data-action-area]");
    const url = endpoints[action];
    if (!area || !url) return false;
    const id = button.dataset.id;
    const path = url(id);
    // The same approval is available in the drawer and the underlying view.
    const operation = path.startsWith("/api/meetings/") ? "/api/meetings/" + id : path;
    if (busy.has(operation) || area.getAttribute("aria-busy") === "true") return false;
    const confirmText = button.dataset.confirm || confirmations[action]?.(id);
    if (confirmText && !window.confirm(confirmText)) return false;
    const field = $("[data-keep]", area);
    const previous = field?.value;
    busy.add(operation);
    area.setAttribute("aria-busy", "true");
    button.disabled = true;
    showError(area, null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chatBody ?? payload(action, button, field, area)),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error) throw new Error(result.error || "HTTP " + response.status);
      if (field && previous === field.value && !["cancelMeeting", "stopRun", "release"].includes(action)) saveDraft(field, "");
      return result;
    } catch (error) {
      showError(area, error);
      return false;
    } finally {
      button.disabled = false;
      area.removeAttribute("aria-busy");
      busy.delete(operation);
      void refresh();
    }
  };
}
