import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AcpConfig, Config } from "../config.js";
import { resolveAcpCommand, type AcpCommand } from "./acp-command.js";
import { AcpRpc, shortText, type AcpInitialize } from "./acp-rpc.js";
import type { Doorbell, DoorbellContext, RingOutcome, Wake } from "./types.js";

export const ACP_SESSION = "acp-session";
const version: string = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const proxy = fileURLToPath(new URL("../../bin/bridge-mcp.mjs", import.meta.url));
const retrySeconds = Number(process.env.BRIDGE_ACP_RETRY_SECONDS ?? 30);
const retryMs = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.min(retrySeconds, 30) * 1000 : 30_000;
const cancelGraceSeconds = Number(process.env.BRIDGE_ACP_CANCEL_GRACE_SECONDS ?? 30);
const cancelGraceMs = cancelGraceSeconds > 0 && cancelGraceSeconds <= 2_147_483 ? cancelGraceSeconds * 1000 : 30_000;

export interface AcpBindings {
  bridgeUrl: string;
  polling(agent: string): boolean;
  retry(agent: string, ids?: string[]): void;
  failed(agent: string, ids: string[], error: string): void;
  closeSessions(agent: string): Promise<void>;
}

interface AcpTurn {
  wake: Wake;
  ids: Set<string>;
  fetched: Set<string>;
  toolTitles: Map<string, string>;
  started: number;
  done: Promise<void>;
  finish(): void;
  cancel?: { started: number; timer: NodeJS.Timeout };
}

interface AcpSession {
  id: string;
  close: boolean;
  firstPrompt: boolean;
  mcpName: string;
}

class AcpHost {
  private rpc?: AcpRpc;
  private session?: AcpSession;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closingTurn?: AcpTurn;
  private turn?: AcpTurn;
  private stopped?: string;
  private reason?: string;
  private failures = 0;
  private retryAt?: number;
  private retryTimer?: NodeJS.Timeout;
  private followed = new Set<string>();
  private info?: AcpInitialize["agentInfo"];
  private activity?: { evidence: string; since: string };
  private output: string[] = [];
  private permissions: { tool: string; decision: string; at: string }[] = [];
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly cfg: Config,
    private readonly agent: string,
    private readonly config: AcpConfig,
    private readonly ctx: DoorbellContext,
    private readonly bindings: AcpBindings,
  ) {}

  private command() {
    return resolveAcpCommand(this.cfg, this.agent, this.config);
  }

  private commandError() {
    try { this.command(); } catch (error) { return (error as Error).message; }
  }

  possible() {
    return !this.stopped && !this.retryAt && !this.closing && (this.rpc?.alive || !this.commandError());
  }

  available() {
    return this.possible() && !this.bindings.polling(this.agent);
  }

  armed() {
    return !!this.session && this.connecting();
  }

  connecting() {
    return !!this.rpc?.alive && !this.stopped && !this.closing;
  }

  snapshot() {
    const configError = !this.rpc && !this.stopped && !this.retryAt ? this.commandError() : undefined;
    const state = this.stopped || configError ? "stopped" : this.retryAt ? "retrying"
      : this.turn ? "running" : this.starting ? "starting" : this.armed() ? "ready" : "not_started";
    return {
      state, reason: this.stopped ?? configError ?? this.reason ?? null,
      retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : null,
      pid: this.rpc?.pid ?? null, info: this.info ?? null,
      activity: this.activity ?? null, output: this.output, permissions: this.permissions,
    };
  }

  async ring(wake: Wake): Promise<RingOutcome> {
    if (!this.available()) return { ok: false, error: "后台成员当前不可用" };
    // Mail stays in the mailbox while a prompt is running. endTurn checks for everything that arrived meanwhile.
    if (this.turn || this.starting) return { ok: true, reused: true, note: "回合进行中，结束后补发" };
    if (!this.armed()) await this.start();
    if (!this.available() || !this.rpc || !this.session)
      return { ok: false, error: "交互会话正在等信，或后台已停止" };
    if (this.turn) return { ok: true, reused: true, note: "回合进行中，结束后补发" };
    const unread = this.ctx.store.mailByStatus(this.agent, ["queued", "rung"]);
    if (unread.length) this.prompt(this.rpc, this.session, wake, unread.map((mail) => mail.id));
    return unread.length ? { ok: true } : { ok: true, reused: true };
  }

  private start() {
    if (this.starting) return this.starting;
    if (this.armed()) return Promise.resolve();
    const starting = this.open().catch((error: Error) => {
      if (!this.stopped && !this.retryAt) this.fail(error);
      throw error;
    }).finally(() => {
      this.starting = undefined;
      this.ctx.changed();
    });
    this.starting = starting;
    this.ctx.changed();
    return starting;
  }

  private async open() {
    const command = this.command();
    const env = { BRIDGE_URL: this.bindings.bridgeUrl, BRIDGE_AGENT_ID: this.agent, BRIDGE_DOORBELL: "acp" };
    const rpc: AcpRpc = this.rpc = new AcpRpc({ ...command, env: { ...command.env, ...env } }, {
      update: (params) => { if (this.rpc === rpc) this.update(params); },
      permission: (params) => this.permission(rpc, params),
      exit: (error, code) => { if (this.rpc === rpc && !this.stopped) this.fail(error, code); },
    });
    this.emit("acp_spawn", `启动后台代理（PID ${rpc.pid ?? "未知"}）`, { command: command.command, pid: rpc.pid });
    const init = await rpc.initialize(version);
    this.info = init.agentInfo;
    const capabilities = init.agentCapabilities;
    this.emit("acp_initialize", `ACP 已初始化（${this.info?.name ?? "代理"} ${this.info?.version ?? "版本未知"}）`, { info: this.info, capabilities });
    if (command.mcp === "http" && capabilities?.mcpCapabilities?.http !== true)
      throw new Error("配置使用 mcp: http，但 ACP 代理没有声明 HTTP MCP 能力");

    const mcp = this.mcpServer(command, env);
    const params = { cwd: command.cwd, mcpServers: [mcp] };
    const endpoint = this.ctx.store.endpoint(this.agent, ACP_SESSION);
    const sameDaemon = !!endpoint && endpoint.registered_at >= this.startedAt;
    const reuse = endpoint && (command.mcp === "stdio" || sameDaemon);
    const started = Date.now();
    let method = "new";
    let id = "";
    if (reuse) {
      const methods = [
        ...(capabilities?.sessionCapabilities?.resume ? ["resume"] : []),
        ...(capabilities?.loadSession || (capabilities?.sessionCapabilities && "load" in capabilities.sessionCapabilities) ? ["load"] : []),
      ];
      for (const candidate of methods) {
        try {
          await rpc.request("session/" + candidate, { ...params, sessionId: endpoint.address }, 14_000);
          method = candidate;
          id = endpoint.address;
          break;
        } catch (error) {
          if (this.rpc !== rpc || this.stopped || !rpc.alive) throw error;
          this.ctx.log("acp_session_reuse_failed", { agent: this.agent, method: candidate, error: shortText((error as Error).message) });
        }
      }
    }
    if (!id) {
      const result = await rpc.request<{ sessionId?: string }>("session/new", params, 18_000);
      if (typeof result?.sessionId !== "string" || !result.sessionId) throw new Error("ACP session/new 未返回会话 ID");
      id = result.sessionId;
    }
    if (this.rpc !== rpc || this.stopped) throw new Error("后台成员已经停止");
    this.session = { id, close: !!capabilities?.sessionCapabilities?.close, firstPrompt: true, mcpName: command.mcpName };
    this.ctx.store.setEndpoint(this.agent, ACP_SESSION, id);
    this.emit("acp_session", `ACP 会话${{ new: "新建", resume: "恢复", load: "加载" }[method]}（${id}）`,
      { sessionId: id, method, elapsedMs: Date.now() - started });
    if (this.config.mode) await rpc.request("session/set_mode", { sessionId: id, modeId: this.config.mode }, 8000);
    this.reason = undefined;
  }

  private mcpServer(command: AcpCommand, env: Record<string, string>) {
    return command.mcp === "http" ? {
      type: "http", name: command.mcpName, url: this.bindings.bridgeUrl + "/mcp",
      headers: [{ name: "x-bridge-agent", value: this.agent }, { name: "x-bridge-doorbell", value: "acp" }],
    } : {
      name: command.mcpName, command: process.execPath, args: [proxy],
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    };
  }

  private prompt(rpc: AcpRpc, session: AcpSession, wake: Wake, ids: string[]) {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const turn = this.turn = {
      wake, ids: new Set(ids), fetched: new Set<string>(), toolTitles: new Map<string, string>(), started: Date.now(),
      done, finish,
    };
    // Use the MCP mailbox for the work itself. Include join on a new connection even if ACP resumed a conversation.
    const mcp = `本会话的协作桥工具在 MCP 服务器 ${session.mcpName} 下。取信、交接等协作桥操作均使用这个服务器。`;
    const intro = session.firstPrompt
      ? `你是作业目录 ${this.cfg.projectDir} 的协作桥成员 ${this.agent}。先调用 join（agent_id=${JSON.stringify(this.agent)}），再按返回的协议取信并处理。交接、进度和会议发言用中文。`
      : "如果取信提示未加入，先重新调用 join，再取信。";
    session.firstPrompt = false;
    const message = mcp + "\n" + intro + "\n" + wake.text.replace("调用 bridge 的 fetch_inbox", `调用 ${session.mcpName} 的 fetch_inbox`) +
      "\n处理完毕后结束回合。后台会话无需调用 wait_for_mail。只处理取信返回的信件。";
    this.activity = { evidence: "正在查收协作桥来信", since: new Date(turn.started).toISOString() };
    if (this.output.at(-1)) this.appendOutput("\n");
    this.emit("acp_prompt", `收到 ACP 唤醒（${ids.length} 封信）`, { mails: ids });
    void rpc.request<{ stopReason?: string }>("session/prompt", {
      sessionId: session.id, prompt: [{ type: "text", text: message }],
    }).then((result) => {
      if (this.turn !== turn || this.stopped) return;
      if (typeof result?.stopReason !== "string") throw new Error("ACP session/prompt 未返回 stopReason");
      this.endTurn(turn, result.stopReason);
    }).catch((error: Error) => {
      if (this.turn === turn && !this.stopped) this.fail(error);
    });
  }

  fetched(ids: string[]) {
    for (const id of ids) this.turn?.fetched.add(id);
  }

  cancelling() {
    return !!(this.turn ?? this.closingTurn)?.cancel;
  }

  voided(ids: string[]) {
    const turn = this.turn ?? this.closingTurn;
    if (!turn || !ids.some((id) => turn.ids.has(id) || turn.fetched.has(id))) return;
    if (turn === this.turn) this.cancel("信件已作废");
    return turn.done;
  }

  private cancel(reason: string) {
    const turn = this.turn;
    if (!turn || turn.cancel || !this.session || !this.rpc?.alive) return;
    turn.cancel = {
      started: performance.now(),
      timer: setTimeout(() => {
        if (this.turn === turn && !this.stopped) void this.cancelTimedOut(turn);
      }, cancelGraceMs).unref(),
    };
    this.rpc.notify("session/cancel", { sessionId: this.session.id });
    this.activity = { evidence: "正在取消后台回合", since: new Date().toISOString() };
    this.emit("acp_cancel", reason, { mails: [...new Set([...turn.ids, ...turn.fetched])], graceMs: cancelGraceMs });
  }

  private finishTurn(turn: AcpTurn, outcome: string) {
    if (turn.cancel) {
      clearTimeout(turn.cancel.timer);
      const elapsedMs = Math.round(performance.now() - turn.cancel.started);
      this.emit("acp_cancel_end", `取消回合已收尾（${elapsedMs} 毫秒）`, { elapsedMs, outcome });
    }
    turn.finish();
  }

  private async cancelTimedOut(turn: AcpTurn) {
    this.emit("acp_cancel_timeout", "ACP 取消回合超时，正在结束进程树", {
      graceMs: cancelGraceMs, failures: this.failures,
    });
    const rpc = this.detach();
    this.requeueFetched(turn);
    await this.close(rpc, "timeout");
    const unread = this.ctx.store.mailByStatus(this.agent, ["queued", "rung"]);
    if (!this.stopped && unread.length) this.bindings.retry(this.agent, unread.map((mail) => mail.id));
  }

  private endTurn(turn: AcpTurn, stopReason: string) {
    this.turn = undefined;
    this.activity = undefined;
    if (turn.cancel) {
      this.requeueFetched(turn);
      this.followed.clear();
    } else if (stopReason !== "cancelled") this.failures = 0;
    this.emit("acp_turn_end", `ACP 回合结束（${shortText(stopReason, 60)}）`,
      { stopReason: shortText(stopReason, 60), elapsedMs: Date.now() - turn.started });
    this.finishTurn(turn, stopReason);
    if (!this.available()) return;
    const unread = this.ctx.store.mailByStatus(this.agent, ["queued", "rung"]);
    const ids = unread.filter((mail) => !this.followed.has(mail.id)).map((mail) => mail.id);
    // Each unread mail can trigger one immediate follow-up. Further retries use the postman's cadence.
    this.followed = new Set(unread.map((mail) => mail.id));
    if (ids.length) this.bindings.retry(this.agent, ids);
  }

  private unackedIds(turn?: AcpTurn) {
    return [...(turn?.fetched ?? [])].filter((id) => {
      const mail = this.ctx.store.mail(id);
      return mail?.status === "fetched" && mail.ack_required;
    });
  }

  private requeueFetched(turn?: AcpTurn) {
    const ids = this.unackedIds(turn);
    this.ctx.store.setMailStatus(ids, "queued");
    return ids;
  }

  private fail(error: Error, code?: number | null) {
    const turn = this.turn;
    const rpc = this.detach();
    this.reason = shortText(error.message);
    const retries = ++this.failures;
    // On the third consecutive failure, a manual restart is required.
    if (retries >= 3) this.stopped = "连续失败 3 次：" + this.reason;
    else this.retryAt = Date.now() + retryMs * (retries === 1 ? 1 : 4);
    this.emit("acp_exit", this.stopped ?? `后台异常：${this.reason}，稍后重试`, { code, failures: retries, retryAt: this.retryAt, error: this.reason });
    this.requeueFetched(turn);
    if (turn) this.bindings.failed(this.agent, turn.wake.mailIds, this.reason);
    void this.close(rpc, "process_exit");
    if (this.retryAt) this.retryTimer = setTimeout(async () => {
      await this.closing;
      if (this.stopped) return;
      this.retryAt = undefined;
      this.ctx.changed();
      this.bindings.retry(this.agent);
    }, Math.max(0, this.retryAt - Date.now())).unref();
  }

  private detach() {
    const rpc = this.rpc;
    this.rpc = undefined;
    this.session = undefined;
    if (this.turn) {
      clearTimeout(this.turn.cancel?.timer);
      this.closingTurn = this.turn;
    }
    this.turn = undefined;
    this.activity = undefined;
    this.followed.clear();
    return rpc;
  }

  private close(rpc: AcpRpc | undefined, outcome: "stopped" | "timeout" | "process_exit", session?: AcpSession) {
    if (this.closing) return this.closing;
    const close = async () => {
      if (session?.close && rpc?.alive) {
        await rpc.request("session/close", { sessionId: session.id }, 2000).catch(() => {});
      }
      await Promise.all([rpc?.terminate(), this.bindings.closeSessions(this.agent)]);
      if (this.closingTurn) this.finishTurn(this.closingTurn, outcome);
      this.closingTurn = undefined;
    };
    this.closing = close().finally(() => { this.closing = undefined; this.ctx.changed(); });
    return this.closing;
  }

  async stop(reason: string) {
    this.stopped = reason;
    this.retryAt = undefined;
    clearTimeout(this.retryTimer);
    const { session, turn, starting } = this;
    this.cancel(reason);
    const rpc = this.detach();
    this.requeueFetched(turn);
    this.ctx.changed();
    await this.close(rpc, "stopped", session);
    await starting?.catch(() => {});
    if (rpc) this.emit("acp_exit", reason, { pid: rpc.pid });
  }

  async restart() {
    await this.stop("后台正在重启");
    if (this.stopped !== "后台正在重启") return;
    this.stopped = undefined;
    this.reason = undefined;
    this.failures = 0;
    await this.start();
    this.bindings.retry(this.agent);
  }

  private update(params: Record<string, unknown>) {
    const turn = this.turn;
    if (!turn || params.sessionId !== this.session?.id) return;
    const update = params.update as Record<string, unknown> | undefined;
    const since = new Date().toISOString();
    if (update?.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type !== "text" || typeof content.text !== "string") return;
      this.appendOutput(content.text);
      if (!turn.cancel) this.activity = { evidence: "正在回复", since };
    } else if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
      const id = shortText(update.toolCallId, 120);
      const title = shortText(update.title, 160) || turn.toolTitles.get(id) || id || "工具";
      const status = shortText(update.status, 40);
      if (id) turn.toolTitles.set(id, title);
      if (!turn.cancel) this.activity = { evidence: "正在调用 " + title, since };
      if (update.sessionUpdate === "tool_call" || status) this.ctx.log("acp_tool", { agent: this.agent, title, status });
    } else return;
    this.ctx.changed();
  }

  private appendOutput(text: string) {
    const lines = text.split(/\r?\n/);
    const previous = this.output.pop() ?? "";
    lines[0] = previous + lines[0];
    this.output = [...this.output, ...lines.slice(-50).map((line) => line.slice(-1000))].slice(-50);
  }

  private permission(rpc: AcpRpc, params: Record<string, unknown>) {
    const turn = this.turn;
    const toolCall = params.toolCall as { title?: string; toolCallId?: string } | undefined;
    const options = (Array.isArray(params.options) ? params.options : []) as { kind?: string; optionId?: string }[];
    const valid = this.rpc === rpc && params.sessionId === this.session?.id && !this.stopped && turn && !turn.cancel;
    const optionFor = (kind: string) => options.find((o) => o?.kind === kind && typeof o.optionId === "string");
    const option = valid && (this.config.permissions === "allow"
      ? optionFor("allow_once") ?? optionFor("allow_always") : optionFor("reject_once"));
    const title = shortText(toolCall?.title, 160) || turn?.toolTitles.get(shortText(toolCall?.toolCallId, 120)) || "工具";
    const decision = option ? option.kind! : "cancelled";
    this.permissions = [...this.permissions.slice(-19), { tool: title, decision, at: new Date().toISOString() }];
    this.emit("acp_permission", `工具权限「${title}」：${decision}`, { tool: title, decision, optionId: option ? option.optionId : undefined });
    return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
  }

  private emit(kind: string, message: string, data: Record<string, unknown>) {
    this.ctx.log(kind, { agent: this.agent, ...data });
    this.ctx.event(this.agent, kind, this.agent + " · " + message);
  }
}

export class AcpDoorbell implements Doorbell {
  readonly kind = "acp";
  readonly label = "后台（ACP）";
  readonly sessionless = true;
  readonly verify = true;
  readonly waitsForTurn = true;
  private readonly hosts = new Map<string, AcpHost>();

  constructor(cfg: Config, ctx: DoorbellContext, bindings: AcpBindings) {
    for (const [id, { acp }] of Object.entries(cfg.agents)) {
      if (acp) this.hosts.set(id, new AcpHost(cfg, id, acp, ctx, bindings));
    }
  }

  possible(agent: string) { return this.hosts.get(agent)?.possible() ?? false; }
  available(agent: string) { return this.hosts.get(agent)?.available() ?? false; }
  armed(agent: string) { return this.hosts.get(agent)?.armed() ?? false; }
  connecting(agent: string) { return this.hosts.get(agent)?.connecting() ?? false; }
  snapshot(agent: string) { return this.hosts.get(agent)?.snapshot() ?? null; }
  fetched(agent: string, ids: string[]) { this.hosts.get(agent)?.fetched(ids); }
  cancelling(agent: string) { return this.hosts.get(agent)?.cancelling() ?? false; }
  voided(ids: string[]) {
    const turns = [...this.hosts.values()].flatMap((host) => {
      const done = host.voided(ids);
      return done ? [done] : [];
    });
    return turns.length <= 1 ? turns[0] : Promise.all(turns).then(() => {});
  }
  stop(agent: string) { return this.hosts.get(agent)?.stop("已手动停止"); }
  restart(agent: string) { return this.hosts.get(agent)?.restart(); }
  shutdown() { return Promise.all([...this.hosts.values()].map((host) => host.stop("协作桥退出"))); }

  ring(wake: Wake): Promise<RingOutcome> {
    return this.hosts.get(wake.agent)?.ring(wake) ?? Promise.resolve({ ok: false, error: "没有 ACP 配置" });
  }

  waitInstructions() {
    return ["处理完就结束本回合，不要调用 wait_for_mail。有新信时协作桥会再给你发消息。"];
  }
}
