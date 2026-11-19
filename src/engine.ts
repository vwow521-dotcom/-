// Assemble the bridge engine. The HTTP and MCP layers call each service directly.
import type { Config } from "./config.js";
import { Doorbells } from "./doorbells/index.js";
import { EngineContext } from "./engine/context.js";
import { Leases } from "./engine/leases.js";
import { Meetings } from "./engine/meetings.js";
import { Postman } from "./engine/postman.js";
import { Presence } from "./engine/presence.js";
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

  constructor(readonly cfg: Config, store: Store) {
    const ctx = this.context = new EngineContext(cfg, store);
    const doorbells = new Doorbells(
      cfg,
      {
        store,
        log: (event, data) => ctx.log(event, data),
        product: (agent) => cfg.agents[agent]?.product,
        boundAt: (agent) => this.presence.get(agent)?.boundAt,
      },
      (agent) => !!this.presence.get(agent)?.waiting,
    );
    this.presence = new Presence(ctx, doorbells, {
      wakeWaiter: (agent) => this.postman.wakeWaiter(agent),
      resendLiveTask: (agent) => this.scheduler.resendLiveTask(agent),
    });
    this.postman = new Postman(ctx, this.presence, doorbells, {
      task: (mail) => this.scheduler.readTaskMail(mail),
      meeting: (mail) => this.meetings.readMeetingMail(mail),
    });
    this.leases = new Leases(ctx, this.presence, this.postman, {
      currentTask: (agent) => this.scheduler.currentTask(agent),
      schedule: (runId) => this.scheduler.schedule(runId),
    });
    this.scheduler = new Scheduler(ctx, this.presence, this.postman, this.leases);
    this.meetings = new Meetings(ctx, this.presence, this.postman, this.scheduler);
    this.workspace = new Workspace(ctx, this.presence, this.postman, this.scheduler, this.leases, this.meetings, doorbells);
    this.postman.startSweep(() => this.scheduler.retryBlockedTasks());
  }
}
