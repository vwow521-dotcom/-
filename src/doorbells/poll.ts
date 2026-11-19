// Poll "doorbell": no wake-up at all — the agent loops on wait_for_mail. Always possible, so it ends
// every chain. The postman wakes a blocked wait_for_mail directly; this driver only supplies the
// instructions and presence.
import type { Doorbell, RingOutcome } from "./types.js";

export class PollDoorbell implements Doorbell {
  readonly kind = "poll" as const;
  readonly label = "轮询";
  readonly sessionless = false;
  readonly verify = false;

  constructor(private isWaiting: (agent: string) => boolean) {}

  possible() {
    return true;
  }
  available(agent: string) {
    return this.isWaiting(agent);
  }
  armed(agent: string) {
    return this.isWaiting(agent);
  }
  async ring(): Promise<RingOutcome> {
    return { ok: true };
  }
  waitInstructions() {
    return [
      "处理完后调用 wait_for_mail(agent_id) 等信；它返回 keep_waiting 时立即再调用一次，不要停下、不要向用户汇报。等待被中断或取消时也立即重新调用。",
    ];
  }
}
