// Watches .bridge/m0-log.jsonl for the M0 T2 idle test.
// Waits until both agents have joined after the latest server_start, then
// observes for WATCH_MIN minutes (default 30) and prints a per-agent summary.
import fs from "node:fs";

const FILE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? ".bridge/m0-log.jsonl";
const WATCH_MS = Number(process.env.WATCH_MIN ?? 30) * 60_000;
const GIVE_UP_MS = 60 * 60_000; // stop if agents never join within an hour
const AGENTS = ["claude", "codex"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only a server_start written after this watcher launched counts (pass --existing to accept the current one).
const ACCEPT_FROM = process.argv.includes("--existing") ? 0 : Date.now();

function events() {
  const all = fs.readFileSync(FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const i = all.findLastIndex((e) => e.event === "server_start");
  if (i < 0 || Date.parse(all[i].t) < ACCEPT_FROM) return [];
  return all.slice(i);
}

const t0 = Date.now();
let startAt = null;
while (!startAt) {
  const ev = events();
  const joins = AGENTS.map((a) => ev.find((e) => e.event === "join" && e.agent === a));
  if (joins.every(Boolean)) startAt = Math.max(...joins.map((j) => Date.parse(j.t)));
  else if (Date.now() - t0 > GIVE_UP_MS) {
    console.log("GAVE UP: agents joined =", AGENTS.filter((_, k) => joins[k]));
    process.exit(2);
  } else await sleep(15_000);
}
console.log("both joined at", new Date(startAt).toISOString());
await sleep(Math.max(0, startAt + WATCH_MS - Date.now()));

const ev = events().filter((e) => Date.parse(e.t) >= startAt);
const end = Date.now();
for (const a of AGENTS) {
  const mine = ev.filter((e) => e.agent === a);
  const gaps = mine.filter((e) => e.event === "wait_call" && e.gapMs != null).map((e) => e.gapMs).sort((x, y) => x - y);
  const last = mine.filter((e) => ["wait_call", "keep_waiting"].includes(e.event)).at(-1);
  const counts = {};
  for (const e of mine) counts[e.event] = (counts[e.event] ?? 0) + 1;
  console.log(`\n== ${a}`);
  console.log("events:", JSON.stringify(counts));
  if (gaps.length) console.log(`gaps ms: n=${gaps.length} median=${gaps[gaps.length >> 1]} p90=${gaps[Math.floor(gaps.length * 0.9)]} max=${gaps.at(-1)}`);
  console.log("last activity:", last ? `${last.event} ${Math.round((end - Date.parse(last.t)) / 1000)}s before end` : "none");
}
const other = ev.filter((e) => !e.agent && !["mcp_session_open", "mcp_session_close"].includes(e.event));
console.log("\nother events:", other.map((e) => `${e.t.slice(11, 19)} ${e.event}`).join(", ") || "none");
