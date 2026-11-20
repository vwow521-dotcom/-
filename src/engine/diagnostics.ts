import { CODEX_THREAD } from "../doorbells/codex-queue.js";
import { detectCodexVersion } from "../products/codex-runtime.js";
import { productByClient, productById, versionWarning } from "../products/index.js";
import type { BridgeClient, ProductProfile } from "../products/types.js";
import type { EngineContext } from "./context.js";

type Source = "codex-transcript" | "codex-queue";

interface VersionCache {
  version: string;
  nextCheckAt: number;
  checking: boolean;
}

function intervalMs(seconds: string | undefined, fallback: number) {
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

const VERSION_REFRESH_MS = intervalMs(process.env.BRIDGE_VERSION_REFRESH_SECONDS, 600_000);
const VERSION_RETRY_MS = intervalMs(process.env.BRIDGE_VERSION_RETRY_SECONDS, 60_000);

export interface DriftNotice {
  id: string;
  source: Source;
  product: "codex";
  version: string;
  title: string;
  message: string;
  agent: string | null;
  at: string;
}

export class Diagnostics {
  private versions = new Map<ProductProfile, VersionCache>();
  private drift = new Map<string, DriftNotice>();
  private reporting = new Set<string>();

  constructor(private readonly ctx: EngineContext) {}

  product(agent: string, client?: BridgeClient & { reportedAt: string }) {
    const configured = this.ctx.cfg.agents[agent]?.product;
    const profile = productById(configured) ?? (client && productByClient(client));
    const id = profile?.ids[0] ?? configured;
    if (!id) return null;
    const version = profile ? this.version(profile) : "unknown";
    return {
      id,
      label: profile?.label ?? id,
      version,
      warning: profile ? versionWarning(profile, version) : null,
      client: client?.name || null,
      claudeSocket: id === "claude-code" && client?.claudeSocket
        ? { ...client.claudeSocket, reportedAt: client.reportedAt } : null,
    };
  }

  notices() {
    return [...this.drift.values()];
  }

  queueDrift(agent: string, command: string[]) {
    return this.record("codex-queue", agent, () => detectCodexVersion(command));
  }

  transcriptDrift(thread: unknown, version: unknown) {
    const agent = typeof thread === "string" && thread.length <= 160
      ? this.ctx.store.endpoints().find((e) => e.kind === CODEX_THREAD && e.address === thread)?.agent : undefined;
    const members = Object.keys(this.ctx.cfg.agents).filter((id) => this.ctx.cfg.agents[id].product === "codex");
    const recipient = agent && Object.hasOwn(this.ctx.cfg.agents, agent) ? agent : members.length === 1 ? members[0] : null;
    return this.record("codex-transcript", recipient, () =>
      typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,30})?$/.test(version)
        ? Promise.resolve(version) : detectCodexVersion());
  }

  private version(profile: ProductProfile) {
    let cached = this.versions.get(profile);
    if (!cached) {
      cached = { version: "unknown", nextCheckAt: 0, checking: false };
      this.versions.set(profile, cached);
    }
    if (!cached.checking && Date.now() >= cached.nextCheckAt) {
      cached.checking = true;
      void this.checkVersion(profile, cached);
    }
    return cached.version;
  }

  private async checkVersion(profile: ProductProfile, cached: VersionCache) {
    let version: string;
    try {
      version = await profile.detectVersion();
    } catch {
      version = "unknown";
    }
    cached.nextCheckAt = Date.now() + (version === "unknown" ? VERSION_RETRY_MS : VERSION_REFRESH_MS);
    cached.checking = false;
    if (version !== "unknown" && version !== cached.version) {
      cached.version = version;
      this.ctx.onChange();
    }
  }

  private async record(source: Source, agent: string | null, getVersion: () => Promise<string>) {
    // The queue DB is shared by all members. Report that schema only once per daemon.
    const key = source === "codex-queue" ? source : source + (agent ? "-" + agent : "");
    if (this.drift.has(key) || this.reporting.has(key)) return;
    this.reporting.add(key);
    try {
      const version = await getVersion();
      const subject = source === "codex-transcript" ? "会话记录" : "队列数据库";
      const title = (agent ?? "Codex") + " 的 " + subject + "格式可能变了";
      const message = title + "。运行 ai-bridge doctor --probe 检查。";
      const notice = { id: "diagnostic-" + key, source, agent, product: "codex" as const, version, title, message, at: new Date().toISOString() };
      this.drift.set(key, notice);
      this.ctx.log("drift", { source, agent, product: notice.product, version });
      this.ctx.event(null, agent, "drift", message + " Codex " + version);
    } finally {
      this.reporting.delete(key);
    }
  }
}
