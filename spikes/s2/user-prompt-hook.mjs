// S2b: Codex UserPromptSubmit hook. Logs that the user spoke and drops a flag the parked Stop hook watches.
// Never blocks or alters the prompt: prints nothing and exits 0.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = path.join(ROOT, ".bridge");
fs.mkdirSync(DIR, { recursive: true });

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let ev = {};
  try {
    ev = JSON.parse(input);
  } catch {}
  fs.writeFileSync(path.join(DIR, `s2-user-${ev.session_id ?? "unknown"}.flag`), new Date().toISOString());
  fs.appendFileSync(
    path.join(DIR, "s2-hook.log"),
    `${new Date().toISOString()} [pid ${process.pid}] user prompt submitted ${JSON.stringify({ session: ev.session_id, turn: ev.turn_id, promptChars: String(ev.prompt ?? "").length })}\n`,
  );
});
