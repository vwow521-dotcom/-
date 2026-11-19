// Loads <project>/bridge.config.yaml (see bridge.config.example.yaml). Missing file → built-in default pipeline.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const StageSchema = z.object({
  id: z.string().regex(/^[\w-]+$/, "stage id 只能包含字母、数字、_ 和 -"),
  role: z.string(),
  agent: z.string(),
  gate: z.boolean().default(false),
  on_reject: z.string().optional(),
  instructions: z.string().optional(),
  // Files this stage is responsible for (globs, relative to the project). Advisory: another stage
  // touching them is flagged on the approval card, not blocked.
  owns: z.array(z.string()).optional(),
});

const ConfigSchema = z
  .object({
    project: z.string().optional(),
    agents: z.record(
      z.string(),
      z
        .object({
          product: z.string().optional(),
          // How the postman wakes this agent. auto = whatever registers (the stdio proxy registers
          // claude-socket when it runs inside Claude desktop), otherwise poll (wait_for_mail).
          doorbell: z.enum(["auto", "claude-socket", "codex-hook", "poll"]).default("auto"),
        })
        .default({ doorbell: "auto" }),
    ),
    pipeline: z.array(StageSchema).min(1),
    wait: z
      .object({
        poll_seconds: z.number().positive().default(50),
        stale_after_seconds: z.number().positive().default(90),
        offline_after_seconds: z.number().positive().default(300),
      })
      .default({ poll_seconds: 50, stale_after_seconds: 90, offline_after_seconds: 300 }),
    mail: z
      .object({
        ring_retry_seconds: z.number().positive().default(120), // rung but not fetched → ring again
        max_rings: z.number().int().positive().default(3), // then ask the human to wake the agent
        ack_timeout_seconds: z.number().positive().default(600), // fetched ack_required mail not acked → flag
      })
      .default({ ring_retry_seconds: 120, max_rings: 3, ack_timeout_seconds: 600 }),
    notify: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    git: z
      .object({
        auto_commit: z.boolean().default(true),
        // A handoff that changed nothing but carries a review verdict still gets an (empty) commit,
        // so review conclusions show up in `git log`.
        commit_reviews: z.boolean().default(true),
      })
      .default({ auto_commit: true, commit_reviews: true }),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const s of c.pipeline) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `stage id 重复：${s.id}` });
      ids.add(s.id);
      if (!(s.agent in c.agents)) ctx.addIssue({ code: "custom", message: `stage ${s.id} 的 agent「${s.agent}」不在 agents 里` });
    }
    for (const s of c.pipeline)
      if (s.on_reject && !ids.has(s.on_reject)) ctx.addIssue({ code: "custom", message: `stage ${s.id} 的 on_reject「${s.on_reject}」不存在` });
  });

export type Stage = z.infer<typeof StageSchema>;
export type Config = z.infer<typeof ConfigSchema> & { projectDir: string; source: string };

export const DEFAULT_CONFIG_YAML = `agents:
  claude: { product: claude-code, doorbell: auto }
  codex:  { product: codex, doorbell: codex-hook }
pipeline:
  - id: plan
    role: 规划/架构
    agent: claude
    gate: true
    instructions: 把目标细化成可执行的设计说明和验收标准，写进项目文件，交接单里列出关键决策。
    owns: [PLAN.md, "docs/**", "doc/**"]
  - id: implement
    role: 编码
    agent: codex
    instructions: 按规划阶段的设计说明实现，并自己跑一遍验收标准。
  - id: review
    role: 审查
    agent: claude
    gate: true
    on_reject: implement
    instructions: 对照验收标准逐项实测。verdict 填 approve 或 reject；review_comments 只写必须修改的阻塞问题，不影响通过的建议写进 observations。
`;

export function loadConfig(projectDir: string): Config {
  const file = path.join(projectDir, "bridge.config.yaml");
  const exists = fs.existsSync(file);
  const raw = YAML.parse(exists ? fs.readFileSync(file, "utf8") : DEFAULT_CONFIG_YAML);
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`配置文件无效：${exists ? file : "(内置默认配置)"}\n${msgs}`);
  }
  return { ...parsed.data, projectDir, source: exists ? file : "(内置默认配置)" };
}
