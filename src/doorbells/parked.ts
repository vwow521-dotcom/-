// Parked doorbells: an outside process holds a long-poll on GET /api/doorbell/wait and acts when it
// returns with a ring. Used by the stdio proxy inside Claude (injects a message into the Claude
// messaging socket) and by the Codex Stop hook in parking mode (returns {"decision":"block"}).
import type { Doorbell, DoorbellContext, DoorbellKind, RingOutcome, Wake } from "./types.js";

export interface RingResult {
  ring: boolean;
  mailIds?: string[];
  text?: string;
}

const ARMED_MS = 70_000; // a long-poll is re-opened at least every ~55 s while the process lives

export class ParkedDoorbell implements Doorbell {
  readonly verify = true;
  private waiters = new Map<string, Set<(r: RingResult) => void>>();
  private seenAt = new Map<string, number>(); // last time a long-poll was open (or the agent registered)

  constructor(
    readonly kind: Extract<DoorbellKind, "claude-socket" | "codex-hook">,
    readonly label: string,
    readonly sessionless: boolean,
    private instructions: string[],
    private ctx: DoorbellContext,
    private couldServe: (agent: string) => boolean,
  ) {}

  /** The agent's client announced this doorbell (e.g. the proxy's join hint) before any long-poll. */
  markRegistered(agent: string) {
    this.seenAt.set(agent, this.seenAt.get(agent) ?? 0);
  }
  possible(agent: string) {
    return this.seenAt.has(agent) || this.couldServe(agent);
  }
  available(agent: string) {
    return !!this.waiters.get(agent)?.size;
  }
  armed(agent: string) {
    return this.available(agent) || Date.now() - (this.seenAt.get(agent) ?? 0) < ARMED_MS;
  }
  waitInstructions() {
    return this.instructions;
  }

  /** The long-poll itself. The waiter is registered synchronously, before this returns. */
  wait(agent: string, timeoutMs: number, signal: AbortSignal, onChange: () => void): Promise<RingResult> {
    if (signal.aborted) return Promise.resolve({ ring: false });
    this.seenAt.set(agent, Date.now());
    const set = this.waiters.get(agent) ?? new Set();
    this.waiters.set(agent, set);
    return new Promise((resolve) => {
      const done = (r: RingResult) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        set.delete(done);
        this.seenAt.set(agent, Date.now());
        resolve(r);
        onChange();
      };
      const onAbort = () => done({ ring: false });
      const timer = setTimeout(() => done({ ring: false }), timeoutMs);
      signal.addEventListener("abort", onAbort);
      set.add(done);
      onChange();
    });
  }

  async ring(w: Wake): Promise<RingOutcome> {
    const set = this.waiters.get(w.agent);
    if (!set?.size) return { ok: false, error: "没有正在等信的连接" };
    for (const finish of [...set]) finish({ ring: true, mailIds: w.mailIds, text: w.text });
    return { ok: true };
  }
}
