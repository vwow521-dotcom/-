// The doorbell registry: per-agent chains and the drivers behind them.
import type { Config } from "../config.js";
import { products } from "../products/index.js";
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

export class Doorbells {
  readonly claudeSocket: ParkedDoorbell;
  readonly codexHook: ParkedDoorbell;
  readonly codexQueue: CodexQueueDoorbell;
  readonly poll: PollDoorbell;
  private byKind: Map<DoorbellKind, Doorbell>;

  constructor(
    private cfg: Config,
    ctx: DoorbellContext,
    isPolling: (agent: string) => boolean,
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
    this.poll = new PollDoorbell(isPolling);
    this.byKind = new Map<DoorbellKind, Doorbell>([this.claudeSocket, this.codexQueue, this.codexHook, this.poll].map((d) => [d.kind, d]));
  }

  get(kind: DoorbellKind): Doorbell {
    return this.byKind.get(kind)!;
  }

  /** The agent's ordered chain: configured list or single kind, else its product's default. */
  chain(agent: string): readonly DoorbellKind[] {
    const conf = this.cfg.agents[agent]?.doorbell ?? "auto";
    const product = this.cfg.agents[agent]?.product;
    const defaults = products.find((p) => product && p.ids.includes(product))?.doorbells ?? AUTO_CHAIN;
    const list = conf === "auto" ? defaults : Array.isArray(conf) ? conf : [conf];
    return list.includes("poll") ? list : [...list, "poll"];
  }

  /** What the agent should expect: the first doorbell in its chain that could serve it. */
  primary(agent: string): Doorbell {
    for (const k of this.chain(agent)) if (this.get(k).possible(agent)) return this.get(k);
    return this.poll;
  }

  /** The doorbell to ring now: first in the chain (polling aside) that can deliver, skipping `exclude`. */
  pick(agent: string, exclude: ReadonlySet<DoorbellKind> = new Set()): Doorbell | undefined {
    for (const k of this.chain(agent)) {
      if (k === "poll" || exclude.has(k)) continue;
      const d = this.get(k);
      if (d.available(agent)) return d;
    }
    return undefined;
  }

  armed(agent: string): boolean {
    return this.chain(agent).some((k) => this.get(k).armed(agent));
  }

  /** Reachable without an open MCP session (Codex): the agent isn't "offline" just because none is bound. */
  sessionless(agent: string): boolean {
    return this.chain(agent).some((k) => k !== "poll" && this.get(k).sessionless && this.get(k).possible(agent));
  }
}
