// ACP v1 over newline-delimited JSON-RPC. The bridge delegates tools to the agent and its MCP servers.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AcpCommand } from "./acp-command.js";
import { recordAcpProcess, supervised, supervisorSpawn } from "./acp-process.js";

type Id = string | number;
type Json = Record<string, unknown>;
interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export interface AcpInitialize {
  protocolVersion: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean };
    sessionCapabilities?: { resume?: object; close?: object };
  };
}

export function shortText(value: unknown, max = 240) {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").slice(0, max) : "";
}

export class AcpRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<Id, Pending>();
  private sequence = 0;
  private exit?: Error;
  private readonly exited: Promise<void>;
  private killing?: Promise<void>;
  private agentPid?: number;
  private unrecord?: () => void;
  private spawnError?: string;
  private announce!: (error?: Error) => void;
  /** ACP traffic waits for this: on Windows, until the ledger holds the agent's exact identity. */
  private readonly gate: Promise<void>;

  constructor(command: AcpCommand, callbacks?: {
    update(params: Json): void;
    permission(params: Json): unknown;
    exit(error: Error, code: number | null): void;
  }) {
    this.gate = new Promise<void>((resolve, reject) => { this.announce = (error) => error ? reject(error) : resolve(); });
    this.ready = this.gate.catch(() => {});
    if (supervised) {
      // Windows: the supervisor is the agent's parent and ends its whole tree if this process dies (acp-process.ts).
      const host = supervisorSpawn(command.command, command.args);
      this.child = spawn(host.command, host.args, {
        cwd: command.cwd, env: command.env, windowsHide: true, ...host.options,
      }) as unknown as ChildProcessWithoutNullStreams;
      this.child.on("message", (message: { type?: string; pid?: number; message?: string }) => {
        if (message?.type === "agent" && Number.isInteger(message.pid) && !this.agentPid) {
          this.agentPid = message.pid;
          // A failure rejects every request, so the host reports it and retries instead of running unrecorded.
          recordAcpProcess(command.env.BRIDGE_AGENT_ID ?? "probe", command.command, this.child.pid!, message.pid!).then((remove) => {
            this.unrecord = remove;
            if (this.exit) remove();
            this.announce();
          }, (error: Error) => this.announce(error));
        } else if (message?.type === "error") this.spawnError = shortText(message.message);
      });
      // The IPC channel must not keep a short-lived owner (doctor --probe) alive.
      this.child.channel?.unref();
    } else {
      this.child = spawn(command.command, command.args, {
        cwd: command.cwd, env: command.env, stdio: "pipe", windowsHide: true, detached: true,
      });
      this.announce();
    }
    this.child.stderr.resume();
    const reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    reader.on("line", (line) => this.receive(line, callbacks));
    this.exited = new Promise((resolve) => {
      const end = (error: Error, code: number | null) => {
        if (this.exit) return;
        this.exit = error;
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(error);
        }
        this.pending.clear();
        reader.close();
        this.unrecord?.();
        this.announce();
        resolve();
        callbacks?.exit(error, code);
      };
      this.child.once("error", (error) => end(error, null));
      this.child.once("exit", (code, signal) => end(new Error(this.spawnError ? `ACP 进程无法启动：${this.spawnError}`
        : `ACP 进程已退出（${code ?? signal}）`), code));
      // An exit or a failed write rejects its request. Never let EPIPE become an unhandled stream error.
      this.child.stdin.on("error", () => {});
    });
  }

  /** The agent's own PID. On Windows it arrives from the supervisor a few milliseconds after spawn. */
  get pid() { return supervised ? this.agentPid : this.child.pid; }
  /** The Windows supervisor (bin/acp-supervisor.mjs), the root of the agent's process tree. */
  get hostPid() { return supervised ? this.child.pid : undefined; }
  /** Resolves once pid is known and recorded (at once off Windows), or when identity capture fails or the process exits. */
  readonly ready: Promise<void>;
  get alive() { return !this.exit; }

  async initialize(version: string) {
    const result = await this.request<AcpInitialize>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "ai-bridge", version },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, 12_000);
    if (result?.protocolVersion !== 1) throw new Error("ACP 代理未使用协议版本 1");
    return result;
  }

  request<T>(method: string, params: Json, timeoutMs?: number): Promise<T> {
    const id = ++this.sequence;
    return this.gate.then(() => new Promise<T>((resolve, reject) => {
      if (this.exit) return reject(this.exit);
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} 响应超时`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
      this.write({ id, method, params }, (error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    }));
  }

  notify(method: string, params: Json) {
    void this.gate.then(() => this.write({ method, params }), () => {});
  }

  terminate() {
    return this.killing ??= this.killTree();
  }

  private async killTree() {
    // The tree's root: the supervisor on Windows (its child is the agent), the agent's process group elsewhere.
    const pid = this.child.pid;
    if (!pid) return this.exited;
    if (process.platform === "win32") {
      if (this.alive) await new Promise<void>((resolve) => {
        execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 4500 }, (error) => {
          if (error && this.alive) this.child.kill();
          resolve();
        });
      });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { /* The process group already exited. */ }
    }
    return this.exited;
  }

  private write(message: Json, onError?: (error: Error) => void) {
    if (this.exit || this.child.stdin.destroyed) {
      onError?.(this.exit ?? new Error("ACP 输入已关闭"));
      return;
    }
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n", (error) => {
      if (error) onError?.(error);
    });
  }

  private receive(line: string, callbacks?: ConstructorParameters<typeof AcpRpc>[1]) {
    let message: Json;
    try { message = JSON.parse(line); } catch { return; }
    if (message?.jsonrpc !== "2.0") return;
    const { id, method, params } = message;
    if (typeof method === "string") {
      const payload = (params ?? {}) as Json;
      if (id === undefined && method === "session/update") callbacks?.update(payload);
      if (typeof id !== "number" && typeof id !== "string") return;
      if (method === "session/request_permission" && callbacks) {
        this.write({ id, result: callbacks.permission(payload) });
      } else {
        this.write({ id, error: { code: -32601, message: "Method not supported" } });
      }
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = message.error as { code?: number; message?: string } | undefined;
    if (error) pending.reject(new Error(`ACP ${error.code ?? "错误"}：${shortText(error.message)}`));
    else pending.resolve(message.result);
  }
}
