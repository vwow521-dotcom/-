// Codex's MCP configuration and user-level Stop hook, including legacy project hook cleanup.
import fs from "node:fs";
import path from "node:path";
import { codexHome, detectCodexVersion, findCodexCommand } from "./codex-runtime.js";
import { doctorSkill, setupSkill, uninstallSkill } from "./skills.js";
import type { ProductCli, ProductProfile } from "./types.js";

const CODEX_DIR = codexHome();
const CODEX_TOML = path.join(CODEX_DIR, "config.toml");
const CODEX_HOOKS = path.join(CODEX_DIR, "hooks.json");
const skill = { product: "codex" as const, label: "Codex", target: CODEX_DIR };

const fwd = (p: string) => p.replace(/\\/g, "/");
const quoteIfSpace = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

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
function codexBlock(eol: string, { node, proxy }: ProductCli) {
  return ["[mcp_servers.bridge]", `command = '${node}'`, `args = ['${proxy}']`, "tool_timeout_sec = 120", ""].join(eol);
}
const ownsMcpBlock = (block: string, port: number) => block.includes("bridge-mcp.mjs") || block.includes("127.0.0.1:" + port);

function codexMcpSetup(cli: ProductCli) {
  const { refresh, port, info, ok, bad, writeFile } = cli;
  const text = fs.existsSync(CODEX_TOML) ? fs.readFileSync(CODEX_TOML, "utf8") : "";
  const { eol, lines, start, end, block } = tomlSplit(text);
  if (refresh && start < 0) {
    info("Codex：没有配置 bridge，跳过（要加上就运行 ai-bridge setup）");
    return false;
  }
  const want = codexBlock(eol, cli);
  if (start >= 0 && block.trim() === want.trim().replace(/\r\n/g, "\n")) {
    ok("Codex：bridge 已是最新配置");
    return true;
  }
  if (start >= 0 && !ownsMcpBlock(block, port)) {
    bad("Codex：已有一个不是协作桥的 [mcp_servers.bridge]，没有覆盖，请手动检查 config.toml");
    return false;
  }
  const rest = start >= 0 ? [...lines.slice(0, start), ...lines.slice(end)] : lines;
  while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
  writeFile(CODEX_TOML, rest.join(eol) + eol + eol + want, "Codex MCP 配置（stdio 转接程序）");
  return true;
}
function codexMcpUninstall({ port, info, writeFile }: ProductCli) {
  if (!fs.existsSync(CODEX_TOML)) return info("Codex：没有 config.toml");
  const { eol, lines, start, end, block } = tomlSplit(fs.readFileSync(CODEX_TOML, "utf8"));
  if (start < 0 || !ownsMcpBlock(block, port)) return info("Codex：没有协作桥的 MCP 配置");
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

function ourHookEntry({ node, packageDir }: ProductCli) {
  const hook = path.join(packageDir, "bin", "codex-stop-hook.mjs");
  return {
    type: "command",
    command: `${quoteIfSpace(fwd(node))} ${quoteIfSpace(fwd(hook))}`,
    timeout: 660,
    statusMessage: "等待协作桥来信…",
  };
}
function codexHookSetup(cli: ProductCli) {
  const { refresh, info, ok, writeFile } = cli;
  const j = fs.existsSync(CODEX_HOOKS) ? JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8")) : { hooks: {} };
  const current = (j.hooks?.Stop ?? []).flatMap((g: any) => g.hooks ?? []).filter(isOurHook);
  if (refresh && !current.length) return info("Codex：没有协作桥的 Stop hook，跳过");
  const want = ourHookEntry(cli);
  if (current.length === 1 && JSON.stringify(current[0]) === JSON.stringify(want)) return ok("Codex：Stop hook 已是最新");
  stripOurHooks(j);
  j.description ??= "Codex lifecycle hooks";
  j.hooks ??= {};
  j.hooks.Stop = [...(j.hooks.Stop ?? []), { hooks: [want] }];
  writeFile(CODEX_HOOKS, JSON.stringify(j, null, 2) + "\n", "Codex Stop hook（用户级，只对加入协作桥的对话生效）");
}
function codexHookUninstall({ info, removeFile, writeFile }: ProductCli) {
  if (!fs.existsSync(CODEX_HOOKS)) return info("Codex：没有用户级 hooks.json");
  const j = JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8"));
  if (!stripOurHooks(j)) return info("Codex：用户级 hooks.json 里没有协作桥的 hook");
  if (hookCount(j) === 0) removeFile(CODEX_HOOKS, "Codex 用户级 hooks.json（只剩协作桥的 hook）");
  else writeFile(CODEX_HOOKS, JSON.stringify(j, null, 2) + "\n", "移除 Codex 用户级 hooks.json 里的协作桥 hook");
}

/** Projects Codex knows about ([projects.'<path>'] in config.toml) plus any --project dirs. */
function knownProjects(project?: string): string[] {
  const dirs = new Set<string>();
  if (fs.existsSync(CODEX_TOML))
    for (const m of fs.readFileSync(CODEX_TOML, "utf8").matchAll(/^\[projects\.'([^']+)'\]/gm)) dirs.add(m[1]);
  if (project) dirs.add(path.resolve(project));
  return [...dirs];
}
function legacyProjectHooks(project?: string): string[] {
  return knownProjects(project)
    .map((d) => path.join(d, ".codex", "hooks.json"))
    .filter((f) => {
      try {
        return fs.existsSync(f) && (JSON.parse(fs.readFileSync(f, "utf8")).hooks?.Stop ?? []).some((g: any) => (g.hooks ?? []).some(isOurHook));
      } catch {
        return false;
      }
    });
}
function cleanupLegacyProjectHooks({ project, info, removeFile, writeFile }: ProductCli) {
  const files = legacyProjectHooks(project);
  if (!files.length) return info("没有遗留的项目级协作桥 hook");
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    stripOurHooks(j);
    if (hookCount(j) === 0) removeFile(f, "项目级协作桥 hook（已改为用户级）");
    else writeFile(f, JSON.stringify(j, null, 2) + "\n", "移除项目级协作桥 hook（已改为用户级）");
  }
}

function setup(cli: ProductCli) {
  if (codexMcpSetup(cli)) setupSkill(cli, skill);
  codexHookSetup(cli);
  cleanupLegacyProjectHooks(cli);
}

function uninstall(cli: ProductCli) {
  uninstallSkill(cli, skill);
  codexMcpUninstall(cli);
  codexHookUninstall(cli);
  cleanupLegacyProjectHooks(cli);
}

function doctor(cli: ProductCli) {
  const { proxy, project, ok, bad, info } = cli;
  const { block } = fs.existsSync(CODEX_TOML) ? tomlSplit(fs.readFileSync(CODEX_TOML, "utf8")) : { block: "" };
  if (block.includes(proxy)) ok("Codex：bridge 指向本安装的转接程序");
  else if (block) bad("Codex：bridge 指向别处 → 运行 ai-bridge setup");
  else info("Codex：没有配置 bridge（不用 Codex 就忽略；要用就运行 ai-bridge setup）");
  doctorSkill(cli, skill, ownsMcpBlock(block, cli.port));

  let hookOk = false;
  if (!block) {
    // Codex not in use: only complain about a leftover hook.
    try {
      const left = (JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8")).hooks?.Stop ?? []).flatMap((g: any) => g.hooks ?? []).filter(isOurHook);
      if (left.length) bad("Codex：没有 bridge 配置，却还留着协作桥的 Stop hook → 运行 ai-bridge setup 补全，或 ai-bridge uninstall 清掉");
    } catch {}
  } else try {
    const hooks = (JSON.parse(fs.readFileSync(CODEX_HOOKS, "utf8")).hooks?.Stop ?? []).flatMap((g: any) => g.hooks ?? []).filter(isOurHook);
    hookOk = hooks.length === 1 && JSON.stringify(hooks[0]) === JSON.stringify(ourHookEntry(cli));
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

  const legacy = legacyProjectHooks(project);
  if (legacy.length) bad(`还有项目级的旧 hook，会和用户级 hook 重复：${legacy.join("、")} → 运行 ai-bridge setup`);
  else ok("没有遗留的项目级 hook");

  const command = findCodexCommand();
  if (command) ok(`Codex：找到队列门铃用的 codex 命令（${command.map(quoteIfSpace).join(" ")}）`);
  else bad("Codex：找不到队列门铃用的 codex 命令");
}

export const codex: ProductProfile = {
  ids: ["codex"],
  label: "Codex CLI",
  clientNames: ["codex-mcp-client", "codex"],
  doorbells: ["codex-queue", "codex-hook", "poll"],
  verifiedVersions: ["0.170"],
  detectVersion: detectCodexVersion,
  setupHint: "在 Codex 的 Settings > Hooks（或输入框旁的 Review hooks）里信任新的 Stop hook。",
  setup,
  uninstall,
  doctor,
};
