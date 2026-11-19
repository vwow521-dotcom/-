// S2 spike: a Codex Stop hook that parks the turn end and waits for mail — no model calls while waiting.
// Codex docs: Stop with {"decision":"block","reason":R} makes Codex continue, using R as a new user prompt.
// Stand-in for the bridge's mailbox: E:/Interaction-ai/.bridge/s2-trigger.json  {"text": "..."}
//
// S2b: while parked, the user's own message is queued behind this hook. Release immediately when the
// user speaks. Two candidate signals, both logged so we can see which one actually fires:
//   A. the UserPromptSubmit hook (user-prompt-hook.mjs) drops .bridge/s2-user-<session>.flag
//   B. the session transcript file (stdin.transcript_path) grows
// Log: .bridge/s2-hook.log
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, ".bridge");
fs.mkdirSync(DIR, { recursive: true });
const LOG = path.join(DIR, "s2-hook.log");
const TRIGGER = path.join(DIR, "s2-trigger.json");
const WAIT_MS = Number(process.env.S2_WAIT_SECONDS ?? 240) * 1000; // must stay below the hook's "timeout" (300 s)
const log = (msg, data) => fs.appendFileSync(LOG, `${new Date().toISOString()} [pid ${process.pid}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);
const size = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  let ev = {};
  try {
    ev = JSON.parse(input);
  } catch {}
  const flag = path.join(DIR, `s2-user-${ev.session_id ?? "unknown"}.flag`);
  fs.rmSync(flag, { force: true });
  const transcript = typeof ev.transcript_path === "string" ? ev.transcript_path : null;
  const size0 = transcript ? size(transcript) : -1;
  log("stop hook fired", {
    session: ev.session_id,
    turn: ev.turn_id,
    stop_hook_active: ev.stop_hook_active,
    transcript: transcript ? path.basename(transcript) : null,
    transcriptSize: size0,
    lastMessage: String(ev.last_assistant_message ?? "").slice(0, 60),
  });

  const start = Date.now();
  let sawGrowth = false;
  while (Date.now() - start < WAIT_MS) {
    if (fs.existsSync(TRIGGER)) {
      let text = "S2 门铃测试";
      try {
        text = String(JSON.parse(fs.readFileSync(TRIGGER, "utf8")).text ?? text);
      } catch {}
      fs.rmSync(TRIGGER, { force: true });
      log("mail found → block (continue)", { waitedMs: Date.now() - start });
      process.stdout.write(JSON.stringify({ decision: "block", reason: text }));
      return;
    }
    if (fs.existsSync(flag)) {
      fs.rmSync(flag, { force: true });
      log("signal A: UserPromptSubmit flag → release", { waitedMs: Date.now() - start, transcriptGrewFirst: sawGrowth });
      process.stdout.write("{}");
      return;
    }
    if (transcript && !sawGrowth) {
      const s = size(transcript);
      if (s !== size0) {
        sawGrowth = true;
        // Only log for now: growth may also come from Codex itself. Release on it only if A never fires.
        log("signal B: transcript grew", { waitedMs: Date.now() - start, from: size0, to: s });
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log("no mail → allow stop", { waitedMs: Date.now() - start, transcriptGrew: sawGrowth });
  process.stdout.write("{}");
});
