// Codex queue doorbell: the bridge runs `codex queue --thread <id> --message <wake text>`.
// The Codex desktop app drains that queue (~/.codex/queue_1.sqlite) itself: an idle conversation
// starts a new turn within seconds (turn_trigger "queue"), a busy one picks the message up when its
// current turn ends. Verified on Codex 0.170 / Windows, 2026-11-19. Unlike a Stop-hook block, this is
// an ordinary new turn, so Codex can't drop it.
//
// The thread id comes from the Codex Stop hook, which registers `session_id` as the agent's
// "codex-thread" endpoint at the end of every turn of a conversation that joined the bridge.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { codexQueueDb, findCodexCommand } from "../products/codex-runtime.js";
import type { Doorbell, DoorbellContext, RingOutcome, Wake } from "./types.js";

export const CODEX_THREAD = "codex-thread"; // endpoint kind

// Registrations from before this daemon started may belong to a conversation the user has since replaced.
const STARTED_AT = Date.now();

export class CodexQueueDoorbell implements Doorbell {
  readonly kind = "codex-queue" as const;
  readonly label = "Codex 队列消息";
  readonly sessionless = true;
  readonly verify = true;
  private cmd: string[] | null = null;
  private cmdCheckedAt = 0;
  // `codex queue` takes a few seconds; a second ring meanwhile would stack another wake (run #6: an empty turn).
  private inFlight = new Set<string>();

  constructor(private ctx: DoorbellContext) {}

  command(): string[] | null {
    if (!this.cmd && Date.now() - this.cmdCheckedAt > 60_000) {
      this.cmd = findCodexCommand();
      this.cmdCheckedAt = Date.now();
    }
    return this.cmd;
  }

  /**
   * The registered thread, unless it was registered before the agent's current binding (it joined from a
   * new session — likely a new conversation) or, when it hasn't joined since, before this daemon started
   * (the user may have opened a new conversation meanwhile). Either way: wait for the Stop hook to
   * register again rather than wake a conversation that may be stale.
   */
  thread(agent: string): string | null {
    const ep = this.ctx.store.endpoint(agent, CODEX_THREAD);
    if (!ep) return null;
    const since = this.ctx.boundAt(agent) ?? STARTED_AT;
    if (Date.parse(ep.registered_at) < since - 1000) return null;
    return ep.address;
  }

  possible(agent: string) {
    return !!this.command() && (this.ctx.product(agent) === "codex" || !!this.ctx.store.endpoint(agent, CODEX_THREAD));
  }
  available(agent: string) {
    return !!this.command() && !!this.thread(agent);
  }
  armed(agent: string) {
    return this.available(agent);
  }
  waitInstructions() {
    return [
      "你不需要轮询。处理完后正常结束本回合即可；有新信时，协作桥会在这个对话里发来一条以「[协作桥]」开头的消息，照它说的调用 fetch_inbox。",
    ];
  }

  /** A wake message already waiting in Codex's queue for this thread: don't stack another one. */
  private pending(agent: string, thread: string, command: string[]): boolean {
    const file = codexQueueDb();
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return !!db.prepare("SELECT 1 FROM queued_items WHERE thread_id = ? LIMIT 1").get(thread);
      } finally {
        db.close();
      }
    } catch {
      if (fs.existsSync(file)) this.ctx.queueDrift(agent, command);
      return false;
    }
  }

  async ring(w: Wake): Promise<RingOutcome> {
    const cmd = this.command();
    const thread = this.thread(w.agent);
    if (!cmd) return { ok: false, error: "找不到 codex 命令" };
    if (!thread) return { ok: false, error: "还不知道这个 Codex 对话的 ID（它结束一轮后由 Stop hook 登记）" };
    if (this.inFlight.has(thread)) return { ok: true, reused: true, note: "上一条叫醒消息正在排进 Codex 队列" };
    if (this.pending(w.agent, thread, cmd)) return { ok: true, reused: true, note: "Codex 队列里已经有一条叫醒消息" };
    const args = [...cmd.slice(1), "queue", "--thread", thread, "--message", w.text];
    this.inFlight.add(thread);
    return new Promise((resolve) => {
      execFile(cmd[0], args, { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        this.inFlight.delete(thread);
        const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
        this.ctx.log("codex_queue", { agent: w.agent, thread, ok: !err, out: out.slice(0, 300) });
        resolve(err ? { ok: false, cooldown: true, error: `codex queue 失败：${(out || err.message).slice(0, 200)}` } : { ok: true });
      });
    });
  }
}
