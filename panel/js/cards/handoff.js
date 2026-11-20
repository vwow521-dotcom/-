import { details, esc, list } from "../dom.js";
import { label, postButton, timeTag } from "./common.js";

function block(title, content) {
  return content ? "<h4>" + esc(title) + "</h4>" + content : "";
}

export function handoffCard(item, anchor, rejectStage) {
  const { data, gate } = item;
  const stage = [item.task?.key, item.stage_role].filter(Boolean).join(" ");
  const verdict = data.verdict === "approve" ? label("审查通过", "good") : data.verdict === "reject" ? label("建议打回", "bad") : "";
  const mark = gate ? label("待你审批", "urgent") : label("交接");
  const commit = item.commit_sha
    ? '<a href="/api/commits/' + esc(item.commit_sha) + '" target="_blank" rel="noopener">提交 ' + esc(item.commit_sha.slice(0, 8)) + "</a>"
    : item.commit_error ? '<span class="bad">' + esc(item.commit_error) + "</span>" : "";
  const basis = gate?.feedback;
  const long = data.summary.length > 180;
  const summary = '<p class="prose">' + esc(long ? data.summary.slice(0, 180) + "…" : data.summary) + "</p>";
  const body = block("交接摘要", long && '<p class="prose">' + esc(data.summary) + "</p>")
    + block("本轮要求", list(basis && [...basis.user_requirements, ...basis.blocking]))
    + block("阻塞问题", list(data.review_comments))
    + block("观察", list(data.observations))
    + block("已完成", list(data.done))
    + block("待办", list(data.todo))
    + block("关键决策", list(data.decisions?.map((d) => d.what + " — " + d.why)))
    + block("给下一位", data.notes_for_next && '<p class="prose">' + esc(data.notes_for_next) + "</p>")
    + block("改动文件", list(data.files_changed))
    + block("范围提示", list(item.scope_notes));
  let control;
  if (gate) {
    const approve = postButton("decide", gate.attempt_id, gate.reject_first ? "仍然通过" : "批准", {
      value: "approve", style: gate.reject_first ? "" : "primary",
    });
    const stage = rejectStage ?? gate.reject_to;
    const reject = postButton("decide", gate.attempt_id, (gate.reject_first ? "确认打回" : "打回") + "到「" + stage + "」", {
      value: "reject", style: "danger", confirm: "打回这份交接并重新分派「" + stage + "」？",
    });
    control = {
      field: { key: "gate-" + gate.attempt_id, label: "交接审批备注", placeholder: "备注或修改要求（可选）", inline: true },
      buttons: gate.reject_first ? reject + approve : approve + reject,
    };
  }
  return {
    key: "handoff-" + item.id, anchor, className: gate ? "card decision-card" : "card handoff-card",
    heading: '<div class="row-meta">' + mark + verdict + timeTag(item.at) + "</div>" +
      "<h3>" + esc(stage) + " 交接</h3>" + summary +
      '<div class="card-byline">' + esc(item.agent) + (commit ? " · " + commit : "") + "</div>",
    control,
    body: body ? details("handoff", "查看交接详情", '<div class="detail-body">' + body + "</div>") : "",
  };
}
