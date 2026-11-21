// Assemble the bridge engine. The HTTP and MCP layers call each service directly.
import type { Config } from "./config.js";
import { Doorbells } from "./doorbells/index.js";
import { Chat } from "./engine/chat.js";
import { EngineContext } from "./engine/context.js";
import { Diagnostics } from "./engine/diagnostics.js";
import { Leases } from "./engine/leases.js";
import { Meetings } from "./engine/meetings.js";
import { Postman } from "./engine/postman.js";
import { Presence } from "./engine/presence.js";
import { Room } from "./engine/room.js";
import { Scheduler } from "./engine/scheduler.js";
import { Workspace } from "./engine/workspace.js";
import type { Store } from "./store.js";

export class Engine {
  readonly context: EngineContext;
  readonly presence: Presence;
  readonly postman: Postman;
  readonly leases: Leases;
  readonly scheduler: Scheduler;
  readonly meetings: Meetings;
  readonly workspace: Workspace;
  readonly chat: Chat;
  readonly diagnostics: Diagnostics;
  readonly doorbells: Doorbells;

  constructor(readonly cfg: Config, store: Store, bridgeUrl: string, closeAcpSessions: (agent: string) => Promise<void>) {
    const ctx = this.context = new EngineContext(cfg, store);
    this.diagnostics = new Diagnostics(ctx);
    const doorbells = this.doorbells = new Doorbells(
      cfg,
      {
        store,
        log: (event, data) => ctx.log(event, data),
        event: (agent, kind, text) => ctx.event(null, agent, kind, text),
        changed: () => ctx.onChange(),
        recovered: (agent) => this.postman.kick(agent),
        queueDrift: (agent, command) => { void this.diagnostics.queueDrift(agent, command); },
        product: (agent) => cfg.agents[agent]?.product,
        boundAt: (agent) => this.presence.get(agent)?.boundAt,
      },
      (agent) => !!this.presence.get(agent)?.waiting,
      {
        bridgeUrl,
        polling: (agent) => this.presence.recentlyPolling(agent),
        retry: (agent, ids) => this.postman.retryAcpMail(agent, ids),
        failed: (agent, ids, error) => this.postman.doorbellResult(agent, ids, false, error, "acp"),
        closeSessions: closeAcpSessions,
      },
    );
    this.presence = new Presence(ctx, doorbells, {
      wakeWaiter: (agent) => this.postman.wakeWaiter(agent),
      resendLiveTask: (agent) => this.scheduler.resendLiveTask(agent),
    });
    this.postman = new Postman(ctx, this.presence, doorbells, {
      task: (mail) => this.scheduler.readTaskMail(mail),
      meeting: (mail) => this.meetings.readMeetingMail(mail),
      chat: (mail) => this.chat.readChatMail(mail),
    });
    this.leases = new Leases(ctx, this.presence, this.postman, {
      currentTask: (agent) => this.scheduler.currentTask(agent),
      schedule: (runId) => this.scheduler.schedule(runId),
    });
    this.scheduler = new Scheduler(ctx, this.presence, this.postman, this.leases);
    this.meetings = new Meetings(ctx, this.presence, this.postman, this.scheduler);
    this.chat = new Chat(ctx, this.presence, this.postman);
    const room = new Room(ctx, this.postman, this.scheduler, this.meetings, this.chat);
    this.workspace = new Workspace(ctx, this.presence, this.postman, this.scheduler, this.leases, this.meetings, this.chat, room, doorbells, this.diagnostics);
    this.postman.startSweep(() => this.scheduler.retryBlockedTasks());
  }
}
