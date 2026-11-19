// Scripted end-to-end check of the M0 bridge with two fake agents.
// Start the server first with a short poll, e.g.  BRIDGE_POLL_SECONDS=2 npm run m0
// then:  npm run m0:smoke

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:7878";

const transportOf = new Map<Client, StreamableHTTPClientTransport>();
async function connect(name: string) {
  const c = new Client({ name: `smoke-${name}`, version: "0.0.1" });
  const t = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"));
  await c.connect(t);
  transportOf.set(c, t);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return JSON.parse(r.content[0].text);
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok  ", msg);
}

const claude = await connect("claude");
const codex = await connect("codex");

const tools = await claude.listTools();
assert(["join", "wait_for_my_turn", "submit_handoff"].every((t) => tools.tools.some((x) => x.name === t)), "tools listed");

assert((await call(claude, "join", { agent_id: "claude" })).role, "claude joined");
assert((await call(codex, "join", { agent_id: "codex" })).role, "codex joined");

// Identity binding: a second session can't act as an agent that is already live.
const imposter = await connect("imposter");
assert((await call(imposter, "join", { agent_id: "claude" })).error, "duplicate join rejected while claude is live");
assert((await call(imposter, "wait_for_my_turn", { agent_id: "claude" })).error, "unbound session cannot wait as claude");

// Nothing assigned yet: a wait must come back keep_waiting after the poll window.
assert((await call(codex, "wait_for_my_turn", { agent_id: "codex" })).status === "keep_waiting", "idle wait returns keep_waiting");

// Codex blocks; meanwhile a run starts with claude, claude hands off, codex must wake up.
const start = (g: string) =>
  fetch(BASE + "/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: g, agent: "claude" }) });
const codexWait = call(codex, "wait_for_my_turn", { agent_id: "codex" });
assert((await start("smoke test")).ok, "run started");
assert((await start("second goal")).status === 409, "second start rejected while a run is active");
const t1 = await call(claude, "wait_for_my_turn", { agent_id: "claude" });
assert(t1.status === "your_turn" && t1.goal === "smoke test", "claude receives the run");

assert((await call(codex, "submit_handoff", { agent_id: "codex", summary: "x", notes_for_next: "x" })).error, "non-holder cannot submit");

const sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "planned", notes_for_next: "implement it", files_changed: ["a.md"] });
assert(sub.next === "codex", "handoff routed to codex");

const t2 = await codexWait;
assert(t2.status === "your_turn" && t2.handoff?.summary === "planned", "blocked codex wait woken with the handoff");

await call(codex, "submit_handoff", { agent_id: "codex", summary: "implemented", notes_for_next: "review it" });
const t3 = await call(claude, "wait_for_my_turn", { agent_id: "claude" });
assert(t3.status === "your_turn" && t3.handoff?.from === "codex", "baton returns to claude");

// Reviewer finishes the goal: run ends, nobody gets the baton.
const done = await call(claude, "submit_handoff", { agent_id: "claude", summary: "approved", notes_for_next: "", goal_done: true });
assert(done.status === "goal_done", "goal_done ends the run");
let status: any = await (await fetch(BASE + "/api/status")).json();
assert(status.goal === null && status.pending === null && status.holder === null, "no goal, pending or holder after goal_done");
assert(status.handoffs.length === 3, "status shows 3 handoffs");
assert((await call(codex, "wait_for_my_turn", { agent_id: "codex" })).status === "keep_waiting", "codex just keeps waiting after the run ends");
assert((await start("next goal")).ok, "a new run can start after goal_done");
await fetch(BASE + "/api/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

// Takeover: the imposter can explicitly claim the identity; the old session is then locked out.
assert(!(await call(imposter, "join", { agent_id: "claude", takeover: true })).error, "takeover join accepted");
assert((await call(claude, "wait_for_my_turn", { agent_id: "claude" })).error, "old session locked out after takeover");

// Terminating a session (HTTP DELETE) frees its identity. Clients that just vanish
// stay bound until OFFLINE_SECONDS passes without activity.
await transportOf.get(imposter)!.terminateSession();
await imposter.close();
await new Promise((r) => setTimeout(r, 200));
assert(!(await call(claude, "join", { agent_id: "claude" })).error, "identity free again after the bound session closes");

await claude.close();
await codex.close();
console.log("smoke test passed");
