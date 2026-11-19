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
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Doorbell, DoorbellContext, RingOutcome, Wake } from "./types.js";

export const CODEX_THREAD = "codex-thread"; // endpoint kind

// Registrations from before this daemon started may belong to a conversation the user has since replaced.
const STARTED_AT = Date.now();

const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

/** Numeric-aware compare of release directory names like 0.170.0-x86_64-pc-windows-msvc. */
const byVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * How to run the Codex CLI: BRIDGE_CODEX_BIN (a .js/.mjs file runs under node — used by the smoke
 * test), else the newest binary the desktop app installed, else codex(.exe) on PATH. npm's codex.cmd
 * shim is skipped: Node can't execFile a .cmd without a shell.
 */
export function findCodexCommand(): string[] | null {
  const env = process.env.BRIDGE_CODEX_BIN;
  if (env) return /\.(m?js)$/i.test(env) ? [process.execPath, env] : [env];
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const releases = path.join(codexHome(), "packages", "app-server-daemon", "releases");
  try {
    for (const dir of fs.readdirSync(releases).sort(byVersion).reverse()) {
      const p = path.join(releases, dir, "bin", exe);
      if (fs.existsSync(p)) return [p];
    }
  } catch {}
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return [p];
  }
  return null;
}

export class CodexQueueDoorbell implements Doorbell {
  readonly kind = "codex-queue" as const;
  readonly label = "Codex 队列消息";
  readonly sessionless = true;
  readonly verify = true;
  private cmd: string[] | null = null;
  private cmdCheckedAt = 0;
  // A failed `codex queue` takes the doorbell out of the chain for a while, so the Stop hook is told to
  // park again (the fallback) at the end of the agent's next turn.
  private failedAt = new Map<string, number>();
  static readonly RETRY_AFTER_MS = 10 * 60_000;

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
    const failed = this.failedAt.get(agent);
    if (failed && Date.now() - failed < CodexQueueDoorbell.RETRY_AFTER_MS) return false;
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
  private pending(thread: string): boolean {
    try {
      const db = new DatabaseSync(path.join(codexHome(), "queue_1.sqlite"), { readOnly: true });
      try {
        return !!db.prepare("SELECT 1 FROM queued_items WHERE thread_id = ? LIMIT 1").get(thread);
      } finally {
        db.close();
      }
    } catch {
      return false; // no queue DB (yet), or its layout changed: just queue
    }
  }

  async ring(w: Wake): Promise<RingOutcome> {
    const cmd = this.command();
    const thread = this.thread(w.agent);
    if (!cmd) return { ok: false, error: "找不到 codex 命令" };
    if (!thread) return { ok: false, error: "还不知道这个 Codex 对话的 ID（它结束一轮后由 Stop hook 登记）" };
    if (this.pending(thread)) return { ok: true, note: "Codex 队列里已经有一条叫醒消息" };
    const args = [...cmd.slice(1), "queue", "--thread", thread, "--message", w.text];
    return new Promise((resolve) => {
      execFile(cmd[0], args, { timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
        this.ctx.log("codex_queue", { agent: w.agent, thread, ok: !err, out: out.slice(0, 300) });
        if (err) this.failedAt.set(w.agent, Date.now());
        else this.failedAt.delete(w.agent);
        resolve(err ? { ok: false, error: `codex queue 失败：${(out || err.message).slice(0, 200)}` } : { ok: true });
      });
    });
  }
}
