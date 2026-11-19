#!/usr/bin/env node
// Codex Stop hook = the Codex doorbell (verified in S2).
//
// Runs every time a Codex turn ends. If this thread joined the bridge (found by reading the session
// transcript for a completed `bridge.join` MCP call), it parks here and long-polls the daemon for
// mail — the model is idle and costs nothing. Mail arrives → {"decision":"block","reason":…}, which
// Codex treats as a new user prompt. Threads that never joined return {} immediately, so the user's
// other conversations in the project are unaffected. Pressing Stop in Codex releases a parked hook.
//
// Env: BRIDGE_URL (default http://127.0.0.1:7878), BRIDGE_PARK_SECONDS (default 600; keep it below the
// hook "timeout" in hooks.json), BRIDGE_HEARTBEAT=0 to let Codex stop instead of re-parking after a
// quiet park window, BRIDGE_MCP_NAME (default "bridge": the MCP server name used in Codex's config).
import fs from "node:fs";

const BASE = (process.env.BRIDGE_URL ?? "http://127.0.0.1:7878").replace(/\/$/, "");
const PARK_MS = Number(process.env.BRIDGE_PARK_SECONDS ?? 600) * 1000;
const HEARTBEAT = process.env.BRIDGE_HEARTBEAT !== "0";
const SERVER = process.env.BRIDGE_MCP_NAME ?? "bridge";

// On Windows, writes to a pipe are asynchronous: exiting right after write() can drop the output, and
// Codex then sees an empty answer and simply stops. Exit only once the write has been flushed.
let finished = false;
const out = (obj) => {
  if (finished) return new Promise(() => {});
  finished = true;
  process.stdout.write(JSON.stringify(obj), () => process.exit(0));
  return new Promise(() => {}); // park the caller until exit
};

/** Last agent_id this thread successfully joined as, or null. */
function joinedAgent(transcriptPath) {
  if (typeof transcriptPath !== "string") return null;
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  let agent = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"McpToolCall"') || !line.includes('"join"')) continue;
    try {
      const item = JSON.parse(line).payload?.item;
      if (item?.type !== "McpToolCall" || item.server !== SERVER || item.tool !== "join" || item.status !== "completed") continue;
      const r = JSON.parse(item.result?.content?.[0]?.text ?? "{}");
      if (r.agent_id && !r.error) agent = r.agent_id;
    } catch {}
  }
  return agent;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  let ev = {};
  try {
    ev = JSON.parse(input);
  } catch {}
  const agent = joinedAgent(ev.transcript_path);
  if (!agent) return out({}); // not a bridge worker thread: behave as if there were no hook

  try {
    await fetch(`${BASE}/api/codex/thread`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: ev.session_id, agent }),
    });
  } catch {
    return out({}); // daemon not running: don't hold Codex
  }

  const start = Date.now();
  while (Date.now() - start < PARK_MS) {
    const remaining = Math.ceil((PARK_MS - (Date.now() - start)) / 1000);
    let j;
    try {
      const r = await fetch(`${BASE}/api/doorbell/wait?agent=${encodeURIComponent(agent)}&kind=codex-hook&timeout=${Math.min(50, remaining)}`);
      if (!r.ok) return out({});
      j = await r.json();
    } catch {
      return out({}); // daemon went away
    }
    if (j.ring) return out({ decision: "block", reason: j.text });
  }
  if (HEARTBEAT)
    return out({
      decision: "block",
      reason: "[协作桥] 心跳：暂时没有新信。不要调用任何工具，只回复「待命」两个字，然后结束本回合。",
    });
  return out({});
});
