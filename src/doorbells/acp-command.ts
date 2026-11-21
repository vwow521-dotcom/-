import fs from "node:fs";
import path from "node:path";
import type { AcpConfig, Config } from "../config.js";
import { productById } from "../products/index.js";

export interface AcpCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mcp: "stdio" | "http";
  mcpName: string;
}

const win = process.platform === "win32";
const matchingKey = (key: string) => win ? key.toUpperCase() : key;
const envValue = (env: NodeJS.ProcessEnv, name: string) =>
  env[Object.keys(env).find((key) => matchingKey(key) === matchingKey(name)) ?? name];

function childEnv(overrides: Record<string, string> = {}) {
  const entries = new Map<string, [string, string]>();
  for (const source of [process.env, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      const upper = key.toUpperCase();
      if (value !== undefined && !upper.startsWith("CLAUDE_CODE_") && !upper.startsWith("BRIDGE_CODEX_")
        && !["BRIDGE_URL", "BRIDGE_AGENT_ID", "BRIDGE_DOORBELL"].includes(upper))
        entries.set(matchingKey(key), [key, value]);
    }
  }
  return Object.fromEntries(entries.values());
}

function executable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (win && /\.(cmd|bat)$/i.test(command)) return undefined;
  const names = win && !path.extname(command) ? [command, command + ".exe"] : [command];
  const dirs = /[\\/]/.test(command) || path.isAbsolute(command)
    ? [cwd] : (envValue(env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.resolve(cwd, dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
}

export function resolveAcpCommand(cfg: Config, agent: string, acp: AcpConfig): AcpCommand {
  const defaults = productById(cfg.agents[agent]?.product)?.acp;
  const env = childEnv(acp.env);
  const expand = (value: string) => value.replace(/%([^%]+)%/g, (literal, key) => envValue(env, key) ?? literal);
  const cwd = path.resolve(cfg.projectDir, expand(acp.cwd ?? "."));
  const configured = acp.command ?? defaults?.command;
  if (!configured) throw new Error(`请在 agents.${agent}.acp.command 填写可执行文件的绝对路径，并配置启动参数`);
  const command = executable(expand(configured), cwd, env)
    ?? (!acp.command && defaults?.pathFallback ? executable(defaults.pathFallback, cwd, env) : undefined);
  if (!command) throw new Error(`找不到 ACP 可执行文件：${expand(configured)}。Windows 请配置 exe，直接传入 args`);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`ACP 工作目录不存在：${cwd}`);
  return { command, cwd, env, args: (acp.args ?? defaults?.args ?? []).map(expand),
    mcp: acp.mcp ?? defaults?.mcp ?? "stdio", mcpName: defaults?.mcpName ?? "bridge" };
}
