import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";
import { loadConfig } from "../src/config.js";

interface Fixture {
  base: string;
  startDaemon(project: string): Promise<void>;
  stopDaemon(): Promise<void>;
  api(path: string, body?: object): Promise<{ status: number; json: any }>;
  call(client: Client, method: string, args: Record<string, unknown>): Promise<any>;
  check(ok: unknown, message: string): void;
}

export async function smokeMemberNotes({ base, startDaemon, stopDaemon, api, call, check }: Fixture) {
  console.log("\nMember notes");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-member-notes-"));
  execFileSync("git", ["init", "-q", project]);
  const notes = "轻活：文档、摘要与文字类第二意见。保留 <b>示例</b> & 原文。";
  const writer = { product: "test-writer", doorbell: "poll", notes: `  ${notes}　` };
  const writeConfig = () => fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: { planner: {}, writer, blank: { notes: "　 " } },
    pipeline: [{ id: "implement", role: "实现", agent: "planner" }],
    notify: { enabled: false },
  }, { lineWidth: 0 }));
  writeConfig();
  const config = loadConfig(project);
  check(config.agents.writer.notes === notes, "Chinese member notes load and trim surrounding whitespace");
  check(config.agents.planner.notes === undefined, "old member configuration without notes still loads");

  const limit = "𠮷".repeat(200);
  writer.notes = ` ${limit} `;
  writeConfig();
  const acceptsLimit = loadConfig(project).agents.writer.notes === limit;
  writer.notes = limit + "字";
  writeConfig();
  assert.throws(() => loadConfig(project), /agents\.writer\.notes: notes 最多 200 字/);
  check(acceptsLimit, "notes accept 200 characters after trimming and reject 201 characters");
  writer.notes = `  ${notes}　`;
  writeConfig();

  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  const planner = new Client({ name: "member-notes-smoke", version: "1.0.0" });
  const members = [
    { id: "planner", product: null, notes: null },
    { id: "writer", product: writer.product, notes },
    { id: "blank", product: null, notes: null },
  ];
  try {
    await startDaemon(project);
    const state = await api("/api/state");
    assert.equal(state.status, 200);
    const panelNotes = state.json.agents.map(({ id, notes }: { id: string; notes: string | null }) => ({ id, notes }));
    check(isDeepStrictEqual(panelNotes, members.map(({ id, notes }) => ({ id, notes }))),
      "/api/state includes Chinese notes and uses null for missing or blank notes");

    await planner.connect(transport);
    const identity = { agent_id: "planner" };
    assert.equal((await call(planner, "join", identity)).agent_id, "planner");
    const opened = await api("/api/meetings", { topic: "成员备注", participants: ["planner"] });
    assert.equal(opened.status, 200);
    const meetingId = opened.json.meeting_id;
    const fetchTurn = async () => {
      const { mails } = await call(planner, "fetch_inbox", identity);
      assert.equal(mails?.length, 1);
      assert.equal(mails[0].kind, "meeting");
      return mails[0].meeting;
    };
    const submit = async (content: string, tasks?: { id: string; title: string; owner: string }[]) => {
      const result = await call(planner, "submit_meeting_turn", { ...identity, meeting_id: meetingId, content, tasks });
      assert.equal(result.status, "submitted");
    };
    const next = async (action: "critique" | "finalize") => {
      assert.equal((await api(`/api/meetings/${meetingId}/next`, { action })).status, 200);
      return fetchTurn();
    };

    const proposal = await fetchTurn();
    check(proposal.kind === "proposal" && isDeepStrictEqual(proposal.members, members),
      "proposal mail lists all configured members and their notes");
    await submit("整理文档。");
    const critique = await next("critique");
    check(critique.kind === "critique" && !Object.hasOwn(critique, "members"), "critique mail omits members");
    await submit("同意整理文档。");
    const final = await next("finalize");
    check(final.kind === "final" && isDeepStrictEqual(final.participants, ["planner"])
      && isDeepStrictEqual(final.members, members) && final.instructions.includes("分配负责人时参考 members[].notes。"),
    "final mail lists nonparticipants and points the facilitator to members[].notes");
    await submit("安排未参会的成员整理文档。", [{ id: "T1", title: "整理文档", owner: "writer" }]);
  } finally {
    try {
      if (transport.sessionId) await transport.terminateSession().catch(() => {});
      await planner.close();
    } finally {
      await stopDaemon();
    }
  }
}
