// Doorbell drivers: the only place that knows how a given product is woken up.
// The engine decides *that* an agent has mail; a driver decides *how* to get its attention. Each agent
// has an ordered chain of doorbells (config `agents.<id>.doorbell`, or its product's default); the
// postman rings the first one that can deliver right now and, if the agent shows no sign of life
// within the wake grace, falls through to the next one before asking the human.
import type { Store } from "../store.js";

export const DOORBELL_KINDS = ["claude-socket", "codex-queue", "codex-hook", "poll"] as const;
export type DoorbellKind = (typeof DOORBELL_KINDS)[number];

export interface Wake {
  agent: string;
  mailIds: string[];
  text: string; // one short "[协作桥] … call fetch_inbox" line; the content always stays in the mailbox
}

export type RingOutcome = { ok: true; note?: string; reused?: boolean } | { ok: false; error: string; cooldown?: boolean };

export interface DoorbellContext {
  store: Store;
  log(event: string, data?: Record<string, unknown>): void;
  event(agent: string, kind: string, text: string): void;
  changed(): void;
  recovered(agent: string): void;
  queueDrift(agent: string, command: string[]): void;
  /** The agent's `product` from the config (claude-code, codex, …). */
  product(agent: string): string | undefined;
  /** When the agent's current MCP session joined (ms), if it is bound. */
  boundAt(agent: string): number | undefined;
}

export interface Doorbell {
  readonly kind: DoorbellKind;
  readonly label: string;
  /** The agent stays reachable without an open MCP session (the doorbell lives outside the session). */
  readonly sessionless: boolean;
  /** Check for a sign of life after ringing, and fall through / alert if there is none. */
  readonly verify: boolean;
  /** Could this doorbell serve the agent at all? Decides what `join` tells the agent about waiting. */
  possible(agent: string): boolean;
  /** Can it deliver to the agent right now? */
  available(agent: string): boolean;
  /** A live path to the agent exists (presence: "armed"). */
  armed(agent: string): boolean;
  ring(wake: Wake): Promise<RingOutcome>;
  /** Protocol lines for `join`: how the agent should wait for mail. */
  waitInstructions(agent: string): string[];
}
