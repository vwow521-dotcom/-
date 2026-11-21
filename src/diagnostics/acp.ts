import { loadConfig } from "../config.js";
import { resolveAcpCommand } from "../doorbells/acp-command.js";
import { AcpRpc, shortText } from "../doorbells/acp-rpc.js";
import { productById, versionWarning } from "../products/index.js";

type Check = { state: "ok" | "bad" | "info"; text: string };

export async function acpChecks(projectDir: string, version: string, probe: boolean): Promise<Check[]> {
  let cfg;
  try {
    cfg = loadConfig(projectDir);
  } catch (error) {
    return [{ state: "bad", text: (error as Error).message }];
  }
  const members = Object.entries(cfg.agents).filter(([, agent]) => !!agent.acp);
  return Promise.all(members.map(async ([id, { acp, product }]): Promise<Check> => {
    let rpc: AcpRpc | undefined;
    try {
      const command = resolveAcpCommand(cfg, id, acp!);
      if (!probe) {
        const profile = productById(product);
        const installed = await profile?.detectVersion(command.command) ?? "unknown";
        const warning = profile ? versionWarning(profile, installed) : null;
        const detail = `${id}：ACP 命令 ${command.command} · ${profile?.label ?? "产品"}版本 ${installed === "unknown" ? "未知" : installed}`;
        return { state: warning || installed === "unknown" ? "info" : "ok", text: warning ? detail + " · " + warning : detail };
      }
      rpc = new AcpRpc(command);
      const init = await rpc.initialize(version);
      const caps = init.agentCapabilities;
      const http = caps?.mcpCapabilities?.http === true;
      const mismatch = command.mcp === "http" && !http;
      const support = [
        "HTTP MCP " + (http ? "支持" : "不支持"),
        "会话恢复 " + (caps?.sessionCapabilities?.resume ? "支持" : "不支持"),
        "会话加载 " + (caps?.loadSession || (caps?.sessionCapabilities && "load" in caps.sessionCapabilities) ? "支持" : "不支持"),
        "会话关闭 " + (caps?.sessionCapabilities?.close ? "支持" : "不支持"),
      ];
      return { state: mismatch ? "bad" : "ok",
        text: `${id}：ACP ${shortText(init.agentInfo?.name) || "代理"} ${shortText(init.agentInfo?.version) || "版本未知"} · ${support.join(" · ")} · 配置 mcp: ${command.mcp}` +
          (mismatch ? " 与代理能力不匹配" : "") + "（仅 initialize）" };
    } catch (error) {
      return { state: "bad", text: `${id}：${(error as Error).message}` };
    } finally {
      await rpc?.terminate();
    }
  }));
}
