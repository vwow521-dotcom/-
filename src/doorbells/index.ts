// The doorbell registry: per-agent chains and the drivers behind them.
import type { Config } from "../config.js";
import { productById } from "../products/index.js";
import { AcpDoorbell, type AcpBindings } from "./acp.js";
import { CODEX_THREAD, CodexQueueDoorbell } from "./codex-queue.js";
import { ParkedDoorbell } from "./parked.js";
import { PollDoorbell } from "./poll.js";
import type { Doorbell, DoorbellContext, DoorbellKind } from "./types.js";

export type { Doorbell, DoorbellKind, Wake, RingOutcome } from "./types.js";
export { DOORBELL_KINDS } from "./types.js";
export type { RingResult } from "./parked.js";
export { CODEX_THREAD } from "./codex-queue.js";

/** Unknown product with doorbell: auto — whatever the client registers. */
const AUTO_CHAIN: DoorbellKind[] = ["claude-socket", "codex-hook", "poll"];

type WakeResult = "pending" | "delivered" | "confirmed" | "timeout" | "failed";
interface DoorbellStats {
  rings: number;
  confirmed: number;
  failed: number;
  consecutiveFailures: number;
  ringFailuresInStreak: number;
  unconfirmedInStreak: number;
  lastResult: WakeResult | null;
  at: string | null;
  degradedUntil: string | null;
}
const emptyStats = (): DoorbellStats => ({
  rings: 0, confirmed: 0, failed: 0, consecutiveFailures: 0, ringFailuresInStreak: 0, unconfirmedInStreak: 0,
  lastResult: null, at: null, degradedUntil: null,
});

function resetFailureStreak(stats: DoorbellStats) {
  stats.consecutiveFailures = 0;
  stats.ringFailuresInStreak = 0;
  stats.unconfirmedInStreak = 0;
}

export class Doorbells {
  readonly claudeSocket: ParkedDoorbell;
  readonly codexHook: ParkedDoorbell;
  readonly codexQueue: CodexQueueDoorbell;
  readonly acp: AcpDoorbell;
  readonly poll: PollDoorbell;
  private byKind: Map<DoorbellKind, Doorbell>;
  private outcomes = new Map<string, Map<DoorbellKind, DoorbellStats>>();

  constructor(
    private cfg: Config,
    private ctx: DoorbellContext,
    isPolling: (agent: string) => boolean,
    acpBindings: AcpBindings,
  ) {
    this.claudeSocket = new ParkedDoorbell(
      "claude-socket",
      "Claude 消息注入",
      false,
      ["你不需要轮询。有新信时，你会收到一条以「[协作桥]」开头的消息（显示为另一个会话发来的），收到后调用 fetch_inbox 处理。"],
      ctx,
      () => false, // only once the stdio proxy announces it (join hint) or long-polls
    );
    this.codexHook = new ParkedDoorbell(
      "codex-hook",
      "Codex Stop hook",
      true,
      ["你不需要轮询。处理完后正常结束本回合即可；有新信时，协作桥会让你继续，并给你一条以「[协作桥]」开头的指示，照它说的调用 fetch_inbox。"],
      ctx,
      (agent) => ctx.product(agent) === "codex" || !!ctx.store.endpoint(agent, CODEX_THREAD),
    );
    this.codexQueue = new CodexQueueDoorbell(ctx);
    this.acp = new AcpDoorbell(cfg, ctx, acpBindings);
    this.poll = new PollDoorbell(isPolling);
    this.byKind = new Map<DoorbellKind, Doorbell>([this.claudeSocket, this.codexQueue, this.codexHook, this.acp, this.poll].map((d) => [d.kind, d]));
  }

  get(kind: DoorbellKind): Doorbell {
    return this.byKind.get(kind)!;
  }

  /** The agent's ordered chain: configured list or single kind, else its product's default. */
  chain(agent: string): readonly DoorbellKind[] {
    const conf = this.cfg.agents[agent]?.doorbell ?? "auto";
    const product = this.cfg.agents[agent]?.product;
    const defaults = productById(product)?.doorbells ?? AUTO_CHAIN;
    const list = conf === "auto" ? defaults : Array.isArray(conf) ? conf : [conf];
    return list.includes("poll") ? list : [...list, "poll"];
  }

  /** What the agent should expect: the first doorbell in its chain that could serve it. */
  primary(agent: string): Doorbell {
    for (const k of this.chain(agent)) if (!this.degraded(agent, k) && this.get(k).possible(agent)) return this.get(k);
    return this.poll;
  }

  available(agent: string, kind: DoorbellKind): boolean {
    return !this.degraded(agent, kind) && this.get(kind).available(agent);
  }

  /** The doorbell to ring now: first in the chain (polling aside) that can deliver, skipping `exclude`. */
  pick(agent: string, exclude: ReadonlySet<DoorbellKind> = new Set()): Doorbell | undefined {
    for (const k of this.chain(agent)) {
      if (k === "poll" || exclude.has(k)) continue;
      if (this.available(agent, k)) return this.get(k);
    }
    return undefined;
  }

  armed(agent: string): boolean {
    return this.chain(agent).some((k) => !this.degraded(agent, k) && this.get(k).armed(agent));
  }

  /** Reachable without an open MCP session (Codex): the agent isn't "offline" just because none is bound. */
  sessionless(agent: string): boolean {
    return this.chain(agent).some((k) => !this.degraded(agent, k) && this.get(k).sessionless && this.get(k).possible(agent));
  }

  stats(agent: string) {
    return this.chain(agent).map((kind) => ({
      kind, label: this.get(kind).label, ...(this.outcomes.get(agent)?.get(kind) ?? emptyStats()),
    }));
  }

  recordRing(agent: string, bell: Doorbell) {
    const stats = this.recordFor(agent, bell.kind);
    stats.rings++;
    this.recordResult(agent, bell, bell.verify ? "pending" : "delivered");
  }

  resetCooldown(agent: string, kind: DoorbellKind) {
    const stats = this.outcomes.get(agent)?.get(kind);
    if (!stats) return;
    stats.degradedUntil = null;
    resetFailureStreak(stats);
  }

  recordResult(agent: string, bell: Doorbell, outcome: WakeResult, cooldown = false) {
    const stats = this.recordFor(agent, bell.kind);
    stats.lastResult = outcome;
    stats.at = new Date().toISOString();
    if (outcome === "confirmed") stats.confirmed++;
    if (outcome === "confirmed" || outcome === "delivered") resetFailureStreak(stats);
    if (outcome === "timeout" || outcome === "failed") {
      stats.failed++;
      stats.consecutiveFailures++;
      if (outcome === "failed") stats.ringFailuresInStreak++;
      else stats.unconfirmedInStreak++;
      const failuresForCooldown = bell.kind === "acp" ? stats.unconfirmedInStreak : stats.consecutiveFailures;
      // The ACP host owns retry timing for a failed delivery. A prior wake check must not prolong it.
      if (bell.kind === "acp" && outcome === "failed") stats.degradedUntil = null;
      else if (bell.verify && (cooldown || failuresForCooldown >= this.cfg.doorbells.max_unconfirmed_rings))
        this.degrade(agent, bell, stats);
    }
    this.ctx.changed();
  }

  private degraded(agent: string, kind: DoorbellKind) {
    return !!this.outcomes.get(agent)?.get(kind)?.degradedUntil;
  }

  private recordFor(agent: string, kind: DoorbellKind) {
    let kinds = this.outcomes.get(agent);
    if (!kinds) {
      kinds = new Map();
      this.outcomes.set(agent, kinds);
    }
    let stats = kinds.get(kind);
    if (!stats) {
      stats = emptyStats();
      kinds.set(kind, stats);
    }
    return stats;
  }

  private degrade(agent: string, bell: Doorbell, stats: DoorbellStats) {
    if (stats.degradedUntil) return;
    const duration = this.cfg.doorbells.cooldown_seconds * 1000;
    const until = new Date(Date.now() + duration).toISOString();
    stats.degradedUntil = until;
    this.ctx.log("doorbell_degraded", { agent, via: bell.kind, until, failures: stats.consecutiveFailures });
    this.ctx.event(agent, "doorbell_degraded", agent + " 的「" + bell.label + "」暂时降级");
    setTimeout(() => {
      if (stats.degradedUntil !== until) return;
      stats.degradedUntil = null;
      resetFailureStreak(stats);
      this.ctx.log("doorbell_recovered", { agent, via: bell.kind });
      this.ctx.event(agent, "doorbell_recovered", agent + " 的「" + bell.label + "」已恢复");
      this.ctx.recovered(agent);
    }, duration).unref();
  }
}
