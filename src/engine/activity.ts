import type { Stage } from "../config.js";
import type { Attempt, Handoff, Meeting, Task } from "../store.js";
import type { PresenceStatus } from "./presence.js";
import type { DeliveryNotice, PanelTarget } from "./room.js";

interface Activity {
  state: "offline" | "never-joined" | "stale" | "idle" | "working" | "reviewing" | "meeting" | "awaiting_you" | "unreachable" | "unknown";
  label: string;
  evidence: string;
  since: string | null;
  link: PanelTarget;
}

const LABEL: Record<Activity["state"], string> = {
  offline: "已离线", "never-joined": "未加入", stale: "连接待确认", idle: "待命",
  working: "执行中", reviewing: "审查中", meeting: "会议待发言", awaiting_you: "待你审批",
  unreachable: "投递异常", unknown: "状态待确认",
};

function isReview(attempt: Attempt, task: Task | undefined, template: Stage[]) {
  const stage = task?.stages.find((s) => s.id === attempt.stage_id);
  return (task?.reviewer === attempt.agent && template.some((s) => s.id === stage?.id && s.role === stage.role && s.agent === "reviewer"))
    || /(?:^|[\s_-])review(?:$|[\s_-])/i.test(attempt.stage_id)
    || /(?:^|[\s_-])review(?:$|[\s_-])|审查|审阅|评审/i.test(stage?.role ?? "");
}

export function activityFor(input: {
  id: string;
  status: PresenceStatus;
  lastSeen: string | null;
  attempts: Attempt[];
  tasks: Task[];
  handoffs: Handoff[];
  template: Stage[];
  meeting?: { meeting: Meeting; invitedAt: string | null };
  delivery?: DeliveryNotice;
}): Activity {
  const { id, status, lastSeen, attempts, tasks, handoffs, template, meeting, delivery } = input;
  const member: PanelTarget = { view: "office", anchor: `member-${id}` };
  const taskLabel = (a: Attempt) => {
    const task = tasks.find((t) => t.id === a.task_id);
    const stage = task?.stages.find((s) => s.id === a.stage_id);
    return `${task ? task.key + " " : ""}${stage?.role ?? a.stage_id}`;
  };
  const taskLink = (a: Attempt): PanelTarget => ({ view: "meeting", anchor: `task-${a.task_id}` });
  const ready = attempts.find((a) => a.status === "ready");
  const result = (state: Activity["state"], evidence: string, since: string | null, link = member): Activity => ({
    state, label: LABEL[state], evidence: ready ? `${evidence}。有任务待领取（${taskLabel(ready)}）` : evidence, since, link,
  });

  if (delivery?.reason === "stuck" || delivery?.reason === "unanswered")
    return result("unreachable", delivery.title, delivery.at);
  if (status === "never-joined") return result(status, "本次守护进程启动后还没有工具调用记录", null);
  if (status === "offline") return result(status, "在线状态已失效，依据 MCP 绑定和最近一次活动判断", lastSeen);
  if (status === "stale") return result(status, "超过在线状态的活动间隔，正在等待连接恢复", lastSeen);
  if (meeting) {
    const { id: meetingId, round } = meeting.meeting;
    return result("meeting", `会议 #${meetingId} 第 ${round} 轮还没发言`, meeting.invitedAt, {
      view: "meeting", anchor: `round-${meetingId}-${round}`,
    });
  }
  const gate = attempts.find((a) => a.status === "awaiting_approval");
  if (gate) {
    const handoff = handoffs.find((h) => h.attempt_id === gate.id);
    return result("awaiting_you", `交接 #${handoff?.id ?? "—"} 等待审批（${taskLabel(gate)}）`, handoff?.created_at ?? gate.started_at ?? gate.assigned_at,
      handoff ? { view: "meeting", anchor: `handoff-${handoff.id}` } : taskLink(gate));
  }
  const active = attempts.find((a) => a.status === "in_progress");
  if (active) {
    const review = isReview(active, tasks.find((t) => t.id === active.task_id), template);
    return result(review ? "reviewing" : "working", `已领取阶段 #${active.id}（${taskLabel(active)}）`, active.started_at ?? active.assigned_at, taskLink(active));
  }
  if (status === "working") return result("unknown", "有工作状态记录，当前没有可定位的阶段或待发言轮次", lastSeen);
  const idleEvidence = { armed: "门铃已接通，暂无已领取的任务", waiting: "正在等待信件", idle: "有在线活动记录，暂无已领取的任务" };
  return result("idle", idleEvidence[status], lastSeen, ready ? taskLink(ready) : member);
}
