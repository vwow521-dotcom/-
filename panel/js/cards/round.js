import { avatar, details, esc, list } from "../dom.js";
import { roundActions, roundKind, waitingSpeakers } from "../model.js";
import { label, postButton, timeTag } from "./common.js";

function planTable(tasks, final) {
  return '<div class="table-wrap" tabindex="0" aria-label="任务表"><table><caption>' + (final ? "任务清单" : "任务草案") + '</caption><thead><tr><th scope="col">编号</th><th scope="col">任务</th><th scope="col">负责 / 审查</th><th scope="col">依赖</th><th scope="col">文件范围</th></tr></thead><tbody>' +
    tasks.map((t) => "<tr><td>" + esc(t.id) + "</td><td><strong>" + esc(t.title) + "</strong><p class=\"prose\">" + esc(t.description) +
      "</p></td><td>" + esc(t.owner) + " / " + esc(t.reviewer || "—") + "</td><td>" + esc(t.depends_on.join("、") || "—") +
      "</td><td>" + esc(t.paths.join("、") || "—") + "</td></tr>").join("") + "</tbody></table></div>";
}

function speaker(id, turn, agents, final) {
  let body = '<p class="muted">等待发言</p>';
  if (turn) {
    const text = esc(turn.content);
    const short = turn.content.length <= 180;
    const prose = '<p class="prose">' + (short ? text : esc(turn.content.slice(0, 180)) + "…") + "</p>";
    const decisions = turn.decisions.length ? "<h4>关键决策</h4>" + list(turn.decisions.map((d) => d.what + " — " + d.why)) : "";
    body = prose + (!short || decisions ? details("turn-" + id, short ? "查看关键决策" : "查看全文", '<div class="detail-body">' +
      (short ? "" : '<p class="prose">' + text + "</p>") + decisions + "</div>") : "");
    if (turn.tasks?.length) {
      const table = planTable(turn.tasks, final);
      body += final ? table : details("plan-" + id, "查看任务草案", table);
    }
  }
  return '<section class="speaker"><div class="speaker-head">' + avatar(id, agents) + "<strong>" + esc(id) + "</strong>" +
    timeTag(turn?.at) + "</div>" + body + "</section>";
}

function controls(round, waiting) {
  const valid = roundActions(round);
  if (!valid.length) return;
  const id = round.meeting_id;
  const cancel = postButton("cancelMeeting", id, "取消会议", { style: "danger" });
  if (valid.includes("approve")) {
    return {
      field: { key: "meeting-note-" + id + "-" + round.round, label: "定稿审批备注", placeholder: "批准备注或修改要求（可选）" },
      buttons: postButton("decideMeeting", id, "批准定稿并分派", { style: "primary", value: "approve" }) +
        postButton("decideMeeting", id, "打回定稿", { style: "danger", value: "reject" }) + cancel,
    };
  }
  if (!valid.includes("critique")) return { buttons: cancel };
  const prefix = waiting.length ? "跳过未发言者并" : "";
  const confirm = waiting.length ? "跳过 " + waiting.join("、") + " 的发言并结束本轮？" : "";
  return {
    field: { key: "meeting-note-" + id + "-" + round.round, label: "下一轮意见", placeholder: "给下一轮发言人的意见（可选）" },
    buttons: postButton("nextRound", id, prefix + "再互评一轮", { style: "primary", value: "critique", confirm }) +
      postButton("nextRound", id, prefix + "请 " + round.facilitator + " 定稿", { value: "finalize", confirm }) + cancel,
  };
}

export function roundCard(round, agents, { anchor, history = false, topic = false } = {}) {
  const heading = "第 " + round.round + " 轮 · " + roundKind[round.kind];
  const waiting = waitingSpeakers(round);
  const participants = round.status === "collecting" ? round.expected : round.turns.map((t) => t.agent);
  const speakers = participants.length ? '<div class="speaker-grid">' + participants.map((id) =>
    speaker(id, round.turns.find((t) => t.agent === id), agents, round.kind === "final")).join("") + "</div>" : "";
  const note = round.note ? '<p class="round-note prose"><strong>本轮意见</strong> ' + esc(round.note) + "</p>" : "";
  const minutes = round.doc_path ? '<p class="muted">会议纪要 <code>' + esc(round.doc_path) + "</code></p>" : "";
  const body = note + speakers + minutes;
  const key = "round-" + round.meeting_id + "-" + round.round;
  if (history) {
    const summary = "会议 #" + round.meeting_id + " · " + heading + " · " + round.turns.map((t) => t.agent).join("、");
    return { key, anchor, className: "card history-round", body: details("round", summary, body, true) };
  }
  return {
    key, anchor, className: round.status === "awaiting_approval" || round.status === "review" ? "card decision-card" : "card round-card",
    heading: '<div class="row-meta">' + label("会议 #" + round.meeting_id) +
      (round.status === "awaiting_approval" ? label("待你批准", "urgent") : "") + timeTag(round.at) + "</div>" +
      "<h3>" + esc(topic ? round.topic : heading) + "</h3>" +
      (topic ? '<p class="muted">' + esc(heading) + "</p>" : "") +
      (waiting.length ? '<p class="wait-line">等待 ' + esc(waiting.join("、")) + " 发言</p>" : ""),
    control: controls(round, waiting),
    body,
  };
}
