// Shared project state and daemon callbacks.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Store } from "../store.js";

export type Result = Record<string, unknown>;
export const err = (error: string): Result => ({ error });

export class EngineContext {
  private readonly logFile: string;
  /** Set by the HTTP layer: notify panel listeners that state changed. */
  onChange: () => void = () => {};
  /** Set by the daemon: tell the human (Windows toast). */
  notifyHuman: (title: string, body: string) => void = () => {};

  constructor(readonly cfg: Config, readonly store: Store) {
    this.logFile = path.join(cfg.projectDir, ".bridge", "bridge-log.jsonl");
  }

  log(event: string, data: Record<string, unknown> = {}) {
    const line = { t: new Date().toISOString(), event, ...data };
    fs.appendFileSync(this.logFile, JSON.stringify(line) + "\n");
    console.log(`[${line.t.slice(11, 19)}] ${event}`, Object.keys(data).length ? JSON.stringify(data) : "");
  }

  event(run_id: number | null, agent: string | null, kind: string, text: string) {
    this.store.addEvent(run_id, agent, kind, text);
    this.onChange();
  }

  guardIdle(): string | null {
    const open = this.store.openRun();
    if (open) return `已有任务 #${open.id} 在进行中，请先停止它。`;
    const m = this.store.openMeeting();
    if (m) return `会议 #${m.id}「${m.topic}」还没结束，请先定稿或取消它。`;
    return null;
  }
}
