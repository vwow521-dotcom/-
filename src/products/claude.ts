// Claude's user-level MCP configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProductCli, ProductProfile } from "./types.js";

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const samePath = (a?: string, b?: string) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function isOurClaudeEntry(e: unknown, port: number) {
  if (!e) return false;
  const s = JSON.stringify(e);
  return s.includes("bridge-mcp.mjs") || s.includes(`127.0.0.1:${port}/mcp`);
}
function setup({ refresh, node, proxy, port, info, ok, bad, writeFile }: ProductCli) {
  const j = fs.existsSync(CLAUDE_JSON) ? JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")) : {};
  j.mcpServers ??= {};
  if (refresh && !j.mcpServers.bridge) return info("Claude：没有配置 bridge，跳过（要加上就运行 ai-bridge setup）");
  const want = { type: "stdio", command: node, args: [proxy], env: {} };
  if (JSON.stringify(j.mcpServers.bridge) === JSON.stringify(want)) return ok("Claude：bridge 已是最新配置");
  if (j.mcpServers.bridge && !isOurClaudeEntry(j.mcpServers.bridge, port)) return bad("Claude：已有一个不是协作桥的 bridge 配置，没有覆盖，请手动检查 ~/.claude.json");
  j.mcpServers.bridge = want;
  writeFile(CLAUDE_JSON, JSON.stringify(j, null, 2), "Claude MCP 配置（stdio 转接程序）");
}
function uninstall({ port, info, writeFile }: ProductCli) {
  if (!fs.existsSync(CLAUDE_JSON)) return info("Claude：没有 ~/.claude.json");
  const j = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  if (!isOurClaudeEntry(j.mcpServers?.bridge, port)) return info("Claude：没有协作桥的配置");
  delete j.mcpServers.bridge;
  writeFile(CLAUDE_JSON, JSON.stringify(j, null, 2), "移除 Claude 的 bridge 配置");
}

function doctor({ node, proxy, ok, bad }: ProductCli) {
  try {
    const e = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).mcpServers?.bridge;
    if (e && samePath(e.command, node) && samePath(e.args?.[0], proxy)) ok("Claude：bridge 指向本安装的转接程序");
    else if (e) bad(`Claude：bridge 指向别处（${e.url ?? e.args?.[0] ?? "?"}）→ 运行 ai-bridge setup`);
    else bad("Claude：没有配置 bridge → 运行 ai-bridge setup");
  } catch {
    bad("Claude：读不到 ~/.claude.json");
  }
}

export const claude: ProductProfile = {
  ids: ["claude-code", "claude"],
  doorbells: ["claude-socket", "poll"],
  setup,
  uninstall,
  doctor,
};
