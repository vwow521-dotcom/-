import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
export const codexQueueDb = () => path.join(codexHome(), "queue_1.sqlite");
const run = promisify(execFile);

/** The same command for the queue driver, doctor and the read-only probe. */
export function findCodexCommand(): string[] | null {
  const env = process.env.BRIDGE_CODEX_BIN;
  if (env) return /\.(m?js)$/i.test(env) ? [process.execPath, env] : [env];
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const releases = path.join(codexHome(), "packages", "app-server-daemon", "releases");
  try {
    for (const dir of fs.readdirSync(releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const p = path.join(releases, dir, "bin", exe);
      if (fs.existsSync(p)) return [p];
    }
  } catch {}
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return [p];
  }
  return null;
}

export async function detectCodexVersion(command = findCodexCommand()) {
  if (!command) return "unknown";
  if (command.length === 1) {
    const release = command[0].match(/[\\/]releases[\\/](\d+\.\d+\.\d+)(?:-[^\\/]+)?[\\/]bin[\\/]codex(?:\.exe)?$/i);
    if (release) return release[1];
  }
  try {
    const { stdout } = await run(command[0], [...command.slice(1), "--version"], { windowsHide: true, timeout: 3_000 });
    return stdout.match(/\b(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?\b/)?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}
