// ai-bridge command line: install/uninstall client configuration, set up a project, start the daemon, diagnose.
//
//   ai-bridge setup                 configure Claude + Codex to use this installed copy (idempotent)
//   ai-bridge uninstall             remove everything `setup` (and older manual installs) added
//   ai-bridge init <dir>            prepare a project folder (git, bridge.config.yaml)
//   ai-bridge start [dir] [--port]  run the bridge for a project (default: current folder)
//   ai-bridge doctor                check that everything is consistent and current
//
// Every file change makes a timestamped backup first (<file>.bak-ai-bridge-<time>). `--dry-run` shows changes only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version;
const NODE = process.execPath;
const PROXY = path.join(PKG, "bin", "bridge-mcp.mjs");
const HOOK = path.join(PKG, "bin", "codex-stop-hook.mjs");
const HOME = os.homedir();
const CLAUDE_JSON = path.join(HOME, ".claude.json");
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(HOME, ".codex");
const CODEX_TOML = path.join(CODEX_DIR, "config.toml");
const CODEX_HOOKS = path.join(CODEX_DIR, "hooks.json");
const PORT = 7878;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag("dry-run");

const ok = (m: string) => console.log("  ✓ " + m);
const bad = (m: string) => console.log("  ✗ " + m);
const info = (m: string) => console.log("  · " + m);
const fwd = (p: string) => p.replace(/\\/g, "/");
const samePath = (a?: string, b?: string) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const quoteIfSpace = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

function backup(file: string) {
  if (!fs.existsSync(file) || DRY) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  fs.copyFileSync(file, `${file}.bak-ai-bridge-${stamp}`);
}
function writeFile(file: string, content: string, what: string) {
  if (DRY) return info(`[dry-run] 会写入 ${file}（${what}）`);
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  ok(`${what} → ${file}`);
}
function removeFile(file: string, what: string) {
  if (DRY) return info(`[dry-run] 会删除 ${file}（${what}）`);
  backup(file);
  fs.rmSync(file);
  ok(`已删除 ${what}：${file}`);
}

// ---------- Claude: ~/.claude.json mcpServers.bridge ----------

function isOurClaudeEntry(e: any) {
  if (!e) return false;
  const s = JSON.stringify(e);
  return s.includes("bridge-mcp.mjs") || s.includes(`127.0.0.1:${PORT}/mcp`);
}
function claudeSetup() {
  const j = fs.existsSync(CLAUDE_JSON) ? JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")) : {};
  j.mcpServers ??= {};
  const want = { type: "stdio", command: NODE, args: [PROXY], env: {} };
  if (JSON.stringify(j.mcpServers.bridge) === JSON.stringify(want)) return ok("Claude：bridge 已是最新配置");
  if (j.mcpServers.bridge && !isOurClaudeEntry(j.mcpServers.bridge)) return bad("Claude：已有一个不是协作桥的 bridge 配置，没有覆盖，请手动检查 ~/.claude.json");
  j.mcpServers.bridge = want;
  writeFile(CLAUDE_JSON, JSON.stringify(j, null, 2), "Claude MCP 配置（stdio 转接程序）");
}
function claudeUninstall() {
  if (!fs.existsSync(CLAUDE_JSON)) return info("Claude：没有 ~/.claude.json");
  const j = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  if (!isOurClaudeEntry(j.mcpServers?.bridge)) return info("Claude：没有协作桥的配置");
  delete j.mcpServers.bridge;
  writeFile(CLAUDE_JSON, JSON.stringify(j, null, 2), "移除 Claude 的 bridge 配置");
}

// ---------- Codex: ~/.codex/config.toml [mcp_servers.bridge] ----------

function tomlSplit(text: string) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.bridge]");
  if (start < 0) return { eol, lines, start: -1, end: -1, block: "" };
  let end = start + 1;
  while (end < lines.length) {
    const t = lines[end].trim();
    if (t.startsWith("[") && !t.startsWith("[mcp_servers.bridge.")) break;
    end++;
  }
  return { eol, lines, start, end, block: lines.slice(start, end).join("\n") };
}
function codexBlock(eol: string) {
  return ["[mcp_servers.bridge]", `command = '${NODE}'`, `args = ['${PROXY}']`, "tool_timeout_sec = 120", ""].join(eol);
}
function codexMcpSetup() {
  const text = fs.existsSync(CODEX_TOML) ? fs.readFileSync(CODEX_TOML, "utf8") : "";
  const { eol, lines, start, end, block } = tomlSplit(text);
  const want = codexBlock(eol);
  if (start >= 0 && block.trim() === want.trim().replace(/\r\n/g, "\n")) return ok("Codex：bridge 已是最新配置");
  if (start >= 0 && !block.includes("bridge-mcp.mjs") && !block.includes(`127.0.0.1:${PORT}`))
    return bad("Codex：已有一个不是协作桥的 [mcp_servers.bridge]，没有覆盖，请手动检查 config.toml");
  const rest = start >= 0 ? [...lines.slice(0, start), ...lines.slice(end)] : lines;
  while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
  writeFile(CODEX_TOML, rest.join(eol) + eol + eol + want, "Codex MCP 配置（stdio 转接程序）");
}
function codexMcpUninstall() {
  if (!fs.existsSync(CODEX_TOML)) return info("Codex：没有 config.toml");
  const { eol, lines, start, end, block } = tomlSplit(fs.readFileSync(CODEX_TOML, "utf8"));
  if (start < 0 || (!block.includes("bridge-mcp.mjs") && !block.includes(`127.0.0.1:${PORT}`))) return info("Codex：没有协作桥的 MCP 配置");
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  writeFile(CODEX_TOML, rest.join(eol), "移除 Codex 的 bridge 配置");
}

// ---------- Codex Stop hook: ~/.codex/hooks.json (user level), plus cleanup of older project-level copies ----------

const isOurHook = (h: any) => typeof h?.command === "string" && h.command.includes("codex-stop-hook.mjs");

/** Remove our Stop hook from a hooks.json object; returns how many were removed. */
function stripOurHooks(j: any): number {
  let n = 0;
  for (const ev of Object.keys(j?.hooks ?? {})) {
    const groups = (j.hooks[ev] as any[]).map((g) => {
      const before = (g.hooks ?? []).length;
      const hooks = (g.hooks ?? []).filter((h: any) => !isOurHook(h));
      n += before - hooks.length;
      return { ...g, hooks };
    });
    j.hooks[ev] = groups.filter((g) => g.hooks.length);
    if (!j.hooks[ev].length) delete j.hooks[ev];
  }
  return n;
}
const hookCount = (j: any) => Object.values(j?.hooks ?? {}).reduce((s: number, gs: any) => s + gs.reduce((t: number, g: any) => t + (g.hooks?.length ?? 0), 0), 0);

function ourHookEntry() {
  return {
    type: "command",
    command: `${quoteIfSpace(fwd(NODE))} ${quoteIfSpace(fwd(HOOK))}`,
    timeout: 660,
    statusMessage: "等待协作桥来信…",
  };
}
function codexHookSetup() {
  const j = fs.existsSync(CODEX_HOOKS) ? JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8")) : { hooks: {} };
  const current = (j.hooks?.Stop ?? []).flatMap((g: any) => g.hooks ?? []).filter(isOurHook);
  const want = ourHookEntry();
  if (current.length === 1 && JSON.stringify(current[0]) === JSON.stringify(want)) return ok("Codex：Stop hook 已是最新");
  stripOurHooks(j);
  j.description ??= "Codex lifecycle hooks";
  j.hooks ??= {};
  j.hooks.Stop = [...(j.hooks.Stop ?? []), { hooks: [want] }];
  writeFile(CODEX_HOOKS, JSON.stringify(j, null, 2) + "\n", "Codex Stop hook（用户级，只对加入协作桥的对话生效）");
}
function codexHookUninstall() {
  if (!fs.existsSync(CODEX_HOOKS)) return info("Codex：没有用户级 hooks.json");
  const j = JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8"));
  if (!stripOurHooks(j)) return info("Codex：用户级 hooks.json 里没有协作桥的 hook");
  if (hookCount(j) === 0) removeFile(CODEX_HOOKS, "Codex 用户级 hooks.json（只剩协作桥的 hook）");
  else writeFile(CODEX_HOOKS, JSON.stringify(j, null, 2) + "\n", "移除 Codex 用户级 hooks.json 里的协作桥 hook");
}

/** Projects Codex knows about ([projects.'<path>'] in config.toml) plus any --project dirs. */
function knownProjects(): string[] {
  const dirs = new Set<string>();
  if (fs.existsSync(CODEX_TOML))
    for (const m of fs.readFileSync(CODEX_TOML, "utf8").matchAll(/^\[projects\.'([^']+)'\]/gm)) dirs.add(m[1]);
  const extra = opt("project");
  if (extra) dirs.add(path.resolve(extra));
  return [...dirs];
}
function legacyProjectHooks(): string[] {
  return knownProjects()
    .map((d) => path.join(d, ".codex", "hooks.json"))
    .filter((f) => {
      try {
        return fs.existsSync(f) && (JSON.parse(fs.readFileSync(f, "utf8")).hooks?.Stop ?? []).some((g: any) => (g.hooks ?? []).some(isOurHook));
      } catch {
        return false;
      }
    });
}
function cleanupLegacyProjectHooks() {
  const files = legacyProjectHooks();
  if (!files.length) return info("没有遗留的项目级协作桥 hook");
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    stripOurHooks(j);
    if (hookCount(j) === 0) removeFile(f, "项目级协作桥 hook（已改为用户级）");
    else writeFile(f, JSON.stringify(j, null, 2) + "\n", "移除项目级协作桥 hook（已改为用户级）");
  }
}

// ---------- commands ----------

function setup() {
  console.log(`协作桥 ${VERSION}：配置客户端（安装位置 ${PKG}）`);
  claudeSetup();
  codexMcpSetup();
  codexHookSetup();
  cleanupLegacyProjectHooks();
  console.log(`
接下来：
  1. 在 Codex 的 Settings > Hooks（或输入框旁的 Review hooks）里信任新的 Stop hook。
  2. Claude 和 Codex 都新开对话（已开的对话还在用旧配置）。
  3. 为项目启动协作桥：ai-bridge start <项目目录>
  随时运行 ai-bridge doctor 检查配置。`);
}

function uninstall() {
  console.log("协作桥：移除客户端配置");
  claudeUninstall();
  codexMcpUninstall();
  codexHookUninstall();
  cleanupLegacyProjectHooks();
  console.log("\n各项目里的 .bridge/ 数据和 bridge.config.yaml 没有动。要移除程序本身：npm uninstall -g ai-bridge");
}

function init() {
  const dir = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  console.log(`协作桥：准备项目 ${dir}`);
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "bridge.config.yaml");
  if (fs.existsSync(cfg)) ok("已有 bridge.config.yaml，保持不变");
  else writeFile(cfg, fs.readFileSync(path.join(PKG, "bridge.config.example.yaml"), "utf8"), "流水线配置 bridge.config.yaml");
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let isRepo = false;
  try {
    isRepo = git("rev-parse", "--is-inside-work-tree") === "true";
  } catch {}
  if (!isRepo) {
    if (DRY) info("[dry-run] 会 git init 并提交 bridge.config.yaml");
    else {
      git("init", "-q", "-b", "main");
      git("add", "bridge.config.yaml");
      git("commit", "-q", "-m", "Initial setup for AI bridge");
      ok("已 git init 并做了初始提交（协作桥的自动提交需要已有的历史）");
    }
  } else {
    let hasCommit = true;
    try {
      git("rev-parse", "HEAD");
    } catch {
      hasCommit = false;
    }
    if (hasCommit) ok("已是 git 仓库");
    else bad("是 git 仓库但还没有任何提交：请先做一个初始提交");
  }
  console.log(`\n启动：ai-bridge start ${dir}`);
}

async function start() {
  const dir = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  process.argv = [process.argv[0], "daemon", "--project", dir, "--port", opt("port") ?? String(PORT)];
  await import("./daemon.js");
}

function proxyResponds(): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(NODE, [PROXY], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const done = (r: string | null) => {
      clearTimeout(timer);
      p.kill();
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 8000);
    p.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        try {
          const j = JSON.parse(line);
          if (j.id === 2) done((j.result?.tools ?? []).map((t: any) => t.name).join(","));
        } catch {}
      }
    });
    const send = (o: object) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-bridge-doctor", version: VERSION } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    }, 300);
  });
}

async function doctor() {
  console.log(`协作桥 ${VERSION} 体检（安装位置 ${PKG}）`);
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}：需要 22.13 或更新（内置 SQLite）`);

  try {
    const e = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).mcpServers?.bridge;
    if (e && samePath(e.command, NODE) && samePath(e.args?.[0], PROXY)) ok("Claude：bridge 指向本安装的转接程序");
    else if (e) bad(`Claude：bridge 指向别处（${e.url ?? e.args?.[0] ?? "?"}）→ 运行 ai-bridge setup`);
    else bad("Claude：没有配置 bridge → 运行 ai-bridge setup");
  } catch {
    bad("Claude：读不到 ~/.claude.json");
  }

  const { block } = fs.existsSync(CODEX_TOML) ? tomlSplit(fs.readFileSync(CODEX_TOML, "utf8")) : { block: "" };
  if (block.includes(PROXY)) ok("Codex：bridge 指向本安装的转接程序");
  else if (block) bad("Codex：bridge 指向别处 → 运行 ai-bridge setup");
  else bad("Codex：没有配置 bridge → 运行 ai-bridge setup");

  let hookOk = false;
  try {
    const hooks = (JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8")).hooks?.Stop ?? []).flatMap((g: any) => g.hooks ?? []).filter(isOurHook);
    hookOk = hooks.length === 1 && JSON.stringify(hooks[0]) === JSON.stringify(ourHookEntry());
    if (hookOk) ok("Codex：用户级 Stop hook 已安装且是最新");
    else if (hooks.length) bad("Codex：Stop hook 不是最新或有重复 → 运行 ai-bridge setup");
    else bad("Codex：没有 Stop hook → 运行 ai-bridge setup");
  } catch {
    bad("Codex：没有用户级 hooks.json → 运行 ai-bridge setup");
  }
  if (hookOk) {
    const toml = fs.existsSync(CODEX_TOML) ? fs.readFileSync(CODEX_TOML, "utf8").toLowerCase() : "";
    if (toml.includes(`[hooks.state.'${CODEX_HOOKS.toLowerCase()}:stop:`))
      ok("Codex：这个 hook 有信任记录（hook 内容变过的话，Codex 会要求重新信任）");
    else bad("Codex：hook 还没被信任 → Codex 的 Settings > Hooks 里信任它");
  }

  const legacy = legacyProjectHooks();
  if (legacy.length) bad(`还有项目级的旧 hook，会和用户级 hook 重复：${legacy.join("、")} → 运行 ai-bridge setup`);
  else ok("没有遗留的项目级 hook");

  const tools = await proxyResponds();
  if (tools === null) bad("转接程序没有响应");
  else if (tools.includes("fetch_inbox")) ok("转接程序正常，桥在运行，工具齐全");
  else ok("转接程序正常（桥没在运行，所以只有占位工具；ai-bridge start <项目> 后自动切换）");

  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/state`);
    const s: any = await r.json();
    info(`桥正在运行：项目 ${s.project}，成员 ${s.agents.map((a: any) => `${a.id}=${a.status}`).join("、")}`);
  } catch {
    info(`桥没有在 ${PORT} 端口运行`);
  }
}

function help() {
  console.log(`ai-bridge ${VERSION}

  ai-bridge setup                 配置 Claude 和 Codex 使用本安装（可反复运行）
  ai-bridge uninstall             移除 setup 加的所有配置（也会清理旧的手动配置）
  ai-bridge init <目录>           准备一个项目：bridge.config.yaml、git
  ai-bridge start [目录] [--port 7878]
                                  为项目启动协作桥（面板 http://127.0.0.1:7878/）
  ai-bridge doctor                检查配置是否一致、是否最新

  通用选项：--dry-run 只显示会做什么，不改文件。`);
}

const cmd = args[0];
switch (cmd) {
  case "setup":
  case "install":
    setup();
    break;
  case "uninstall":
    uninstall();
    break;
  case "init":
    init();
    break;
  case "start":
    await start();
    break;
  case "doctor":
    await doctor();
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  default:
    help();
}
