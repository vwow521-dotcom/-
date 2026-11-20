import fs from "node:fs";
import path from "node:path";
import type { ProductCli } from "./types.js";

const MARKERS = new Set(["<!-- ai-bridge:managed -->", "# ai-bridge:managed"]);
const owned = (content: string | null) => content?.split(/\r?\n/).some((line) => MARKERS.has(line)) ?? false;

interface Skill {
  product: "claude" | "codex";
  label: string;
  target: string;
}

function current(file: string) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function files(cli: ProductCli, skill: Skill) {
  const names = skill.product === "codex" ? ["SKILL.md", "agents/openai.yaml"] : ["SKILL.md"];
  return names.map((name) => {
    const target = path.join(skill.target, "skills", "bridge", name);
    return { target, content: current(target), template: path.join(cli.packageDir, "skills", skill.product, "bridge", name) };
  });
}

export function setupSkill(cli: ProductCli, skill: Skill) {
  const entries = files(cli, skill);
  if (entries.some((file) => file.content !== null && !owned(file.content))) {
    cli.info(skill.label + "：已有用户自有的 bridge skill，保留原文件");
    return;
  }
  if (cli.refresh && entries[0].content === null) {
    cli.info(skill.label + "：没有已安装的 bridge skill，刷新时跳过");
    return;
  }
  for (const file of entries) {
    if (cli.refresh && file.content === null) continue;
    const wanted = fs.readFileSync(file.template, "utf8");
    if (file.content !== wanted) cli.writeFile(file.target, wanted, skill.label + " bridge skill");
  }
}

export function uninstallSkill(cli: ProductCli, skill: Skill) {
  for (const file of files(cli, skill)) {
    if (owned(file.content)) cli.removeFile(file.target, skill.label + " bridge skill");
  }
}

export function doctorSkill(cli: ProductCli, skill: Skill, configured: boolean) {
  const entries = files(cli, skill);
  const subject = skill.label + "：bridge skill";
  if (entries.some((file) => file.content !== null && !owned(file.content))) {
    cli.info(subject + " 由用户管理");
  } else if (!configured) {
    cli.info(subject + (entries.some((file) => file.content !== null) ? " 已存在，MCP 尚未配置" : " 尚未安装，MCP 尚未配置"));
  } else if (entries.some((file) => file.content === null)) {
    cli.bad(subject + " 文件缺失 → 运行 ai-bridge setup");
  } else if (entries.every((file) => file.content === fs.readFileSync(file.template, "utf8"))) {
    cli.ok(subject + " 已是最新");
  } else {
    cli.bad(subject + " 有旧文件 → 运行 ai-bridge setup");
  }
}
