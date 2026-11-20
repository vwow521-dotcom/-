#!/usr/bin/env node
// Codex Stop hook: registers the Codex conversation with the bridge, and is the fallback Codex doorbell.
//
// Runs every time a Codex turn ends. Threads that never joined the bridge (no completed `bridge.join`
// MCP call in the session transcript) return {} immediately, so the user's other conversations are
// unaffected. A joined thread registers its id (session_id) as the agent's "codex-thread" endpoint.
// When the bridge can reach the agent through `codex queue` (codex-queue doorbell) it answers park:false
// and the hook returns {} at once, so the turn ends and queued messages can start the next one.
// Otherwise (no codex CLI found, an older bridge, or the doorbell config says so) the hook parks and
// long-polls the daemon for mail — the model is idle and costs nothing. Mail arrives →
// {"decision":"block","reason":…}, which Codex treats as a new user prompt (but drops some of them,
// see docs/ARCHITECTURE-v2.md §14). Pressing Stop in Codex releases a parked hook.
//
// Env: BRIDGE_URL (default http://127.0.0.1:7878), BRIDGE_PARK_SECONDS (default 600; keep it below the
// hook "timeout" in hooks.json), BRIDGE_HEARTBEAT=0 to let Codex stop instead of re-parking after a
// quiet park window, BRIDGE_MCP_NAME (default "bridge": the MCP server name used in Codex's config),
// BRIDGE_DOWN_GRACE_SECONDS (default 90): how long to keep retrying while the daemon is unreachable, so
// restarting the bridge doesn't release a parked Codex. A daemon that never comes back still lets Codex go.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { readCodexTranscript } from "./codex-transcript.mjs";

const BASE = (process.env.BRIDGE_URL ?? "http://127.0.0.1:7878").replace(/\/$/, "");
const PARK_MS = Number(process.env.BRIDGE_PARK_SECONDS ?? 600) * 1000;
const HEARTBEAT = process.env.BRIDGE_HEARTBEAT !== "0";
const SERVER = process.env.BRIDGE_MCP_NAME ?? "bridge";
const DOWN_GRACE_MS = Number(process.env.BRIDGE_DOWN_GRACE_SECONDS ?? 90) * 1000;
const LOG = process.env.BRIDGE_HOOK_LOG ?? path.join(os.tmpdir(), "ai-bridge", "codex-stop-hook.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(event, data) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n");
  } catch {} // diagnostics must not interfere with the hook protocol
}

/** Tell the bridge this conversation's id. Returns whether to park as the doorbell (old bridges: always). */
async function register(agent, sessionId) {
  const post = (url, body) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const r = await post(`${BASE}/api/agents/${encodeURIComponent(agent)}/endpoint`, { kind: "codex-thread", address: sessionId ?? "" });
  if (r.status >= 500) throw new Error("HTTP " + r.status);
  if (r.status === 404) {
    await post(`${BASE}/api/codex/thread`, { session_id: sessionId, agent }); // bridge before 0.5
    return true;
  }
  const j = await r.json().catch(() => ({}));
  return j.park !== false;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.once("end", async () => {
  let stdin;
  try {
    stdin = JSON.parse(input);
  } catch {}
  log("stdin", { stdin: stdin === undefined ? input : stdin });
  const ev = stdin ?? {};
  const context = { session_id: ev.session_id, turn_id: ev.turn_id, stop_hook_active: ev.stop_hook_active };
  const transcript = readCodexTranscript(ev.transcript_path, SERVER);
  const agent = transcript.agent;
  let parkStarted = null;
  const out = (output, cause, mailIds) => {
    const data = { ...context, agent, cause, mailIds, parked_ms: parkStarted === null ? 0 : Math.round(performance.now() - parkStarted), output };
    log("output", data);
    // On Windows, exiting before the pipe write completes can drop the block response.
    process.stdout.write(JSON.stringify(output), (error) => {
      log("stdout_complete", { ...context, error: error?.message ?? null });
      process.exit(error ? 1 : 0);
    });
  };
  if (!agent) {
    if (transcript.drift) {
      log("transcript_drift", { version: transcript.version });
      await fetch(BASE + "/api/diagnostics/codex-transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: ev.session_id, version: transcript.version }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
      return out({}, "transcript_drift");
    }
    return out({}, "not_joined");
  }

  // The daemon may be restarting: tolerate it being unreachable for up to DOWN_GRACE_MS in a row.
  let downSince = null;
  const unreachable = async () => {
    downSince ??= Date.now();
    if (Date.now() - downSince > DOWN_GRACE_MS) return true; // gone for good: let Codex stop
    await sleep(2000);
    return false;
  };

  let registered = false;
  parkStarted = performance.now();
  log("park", { ...context, agent, park_ms: PARK_MS });
  const start = Date.now();
  while (Date.now() - start < PARK_MS) {
    try {
      if (!registered) {
        const park = await register(agent, ev.session_id);
        registered = true;
        log("registered", { ...context, agent, park });
        // The bridge reaches this conversation through `codex queue` now: let the turn end, so queued
        // messages (which wait for the turn to finish) start a new one.
        if (!park) return out({}, "queue_doorbell");
      }
      const remaining = Math.ceil((PARK_MS - (Date.now() - start)) / 1000);
      const r = await fetch(`${BASE}/api/doorbell/wait?agent=${encodeURIComponent(agent)}&kind=codex-hook&timeout=${Math.max(1, Math.min(50, remaining))}`);
      if (r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) return out({}, `doorbell_http_${r.status}`);
      const j = await r.json();
      downSince = null;
      if (j.ring) return out({ decision: "block", reason: j.text }, "ring", j.mailIds);
    } catch {
      registered = false; // re-register after the daemon comes back (its in-memory state is new)
      if (await unreachable()) return out({}, "daemon_unreachable");
    }
  }
  if (HEARTBEAT)
    return out({
      decision: "block",
      reason: "[协作桥] 心跳：暂时没有新信。不要调用任何工具，只回复「待命」两个字，然后结束本回合。",
    }, "heartbeat");
  return out({}, "park_timeout");
});
