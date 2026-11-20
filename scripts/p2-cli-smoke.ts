// CLI lifecycle tests always run with an isolated user profile, temporary config and a fake Codex CLI.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installedVersion } from "../src/diagnostics/github.js";

export async function smokeCli(base: string, fakeCodex: string, check: (condition: unknown, message: string) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-home-"));
  const env = {
    ...process.env,
    USERPROFILE: home, HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    TMP: home, TEMP: home, TMPDIR: home,
    BRIDGE_URL: base, BRIDGE_CODEX_BIN: fakeCodex,
    GIT_ALLOW_PROTOCOL: "file",
  };
  const cli = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    env, encoding: "utf8", timeout: 40_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const claude = path.join(home, ".claude", "skills", "bridge", "SKILL.md");
  const codex = path.join(env.CODEX_HOME, "skills", "bridge", "SKILL.md");
  const policy = path.join(path.dirname(codex), "agents", "openai.yaml");
  const config = path.join(env.CODEX_HOME, "config.toml");
  const old = "<!-- ai-bridge:managed -->\n旧的启动说明\n";
  const personal = "---\nname: bridge\ndescription: User-defined skill\n---\n\n个人说明\n";
  const text = (file: string) => fs.readFileSync(file, "utf8");
  const put = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const backedUp = (file: string, content: string) => fs.readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(path.basename(file) + ".bak-ai-bridge-"))
    .some((name) => text(path.join(path.dirname(file), name)) === content);

  put(claude, old);
  put(codex, old);
  const dry = cli("setup", "--dry-run");
  check(dry.includes("Claude bridge skill") && dry.includes("Codex bridge skill") &&
    text(claude) === old && text(codex) === old && !fs.existsSync(config), "isolated dry-run reports skill writes without mutating the profile");
  cli("setup");
  check(text(claude).includes("disable-model-invocation: true") && text(codex).includes("只在用户明确要求") &&
    text(policy).includes("allow_implicit_invocation: false") && backedUp(claude, old) && backedUp(codex, old),
  "isolated setup installs and backs up both explicitly invoked skills");
  const currentToml = text(config);
  const doctor = cli("doctor");
  check(doctor.includes("Claude：bridge skill 已是最新") && doctor.includes("Codex：bridge skill 已是最新") &&
    doctor.includes("未验证的版本，门铃可能失效"), "doctor reports both managed skills current and warns on an unverified product version");

  put(codex, old);
  check(cli("doctor").includes("Codex：bridge skill 有旧文件"), "doctor detects a stale bridge skill");
  cli("setup", "--refresh");
  check(text(codex) !== old, "refresh updates an existing bridge skill when its MCP config is present");
  put(claude, personal);
  cli("setup");
  check(text(claude) === personal && cli("doctor").includes("Claude：bridge skill 由用户管理"), "setup and doctor recognize a user-owned skill of the same name");

  put(config, "# No bridge MCP entry in this isolated profile\n");
  put(codex, old);
  cli("setup", "--refresh");
  check(text(codex) === old && !text(config).includes("[mcp_servers.bridge]"), "refresh leaves an existing skill alone when the Codex MCP was removed");
  fs.rmSync(codex);
  fs.rmSync(policy);
  cli("setup", "--refresh");
  check(!fs.existsSync(codex) && !fs.existsSync(policy) && cli("doctor").includes("Codex：bridge skill 尚未安装，MCP 尚未配置"),
    "refresh does not install a missing skill or recreate a removed Codex MCP entry");

  put(config, currentToml);
  check(cli("doctor").includes("Codex：bridge skill 文件缺失"), "doctor distinguishes missing files when Codex MCP is configured");
  cli("setup");
  const managed = text(codex);
  const foreign = "# User-managed Codex skill policy\npolicy:\n  allow_implicit_invocation: false\n";
  put(policy, foreign);
  cli("uninstall");
  check(!fs.existsSync(codex) && backedUp(codex, managed) && text(claude) === personal && text(policy) === foreign,
    "uninstall backs up and removes only managed skill files");

  const dbFile = path.join(env.CODEX_HOME, "queue_1.sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE queued_items (thread_id TEXT)");
  db.close();
  put(path.join(env.CODEX_HOME, "sessions", "rollout-smoke.jsonl"), JSON.stringify({
    payload: { item: { type: "McpToolCall", server: "bridge", tool: "join", status: "completed",
      result: { content: [{ text: JSON.stringify({ agent_id: "qbot" }) }] } } },
  }) + "\n");
  const beforeProbe = fs.readFileSync(dbFile);
  const probe = cli("doctor", "--probe");
  check(probe.includes("✓ Codex 队列命令") && probe.includes("✓ Codex 队列数据库") &&
    probe.includes("✓ Codex 会话记录") && probe.includes("Claude 消息套接字") &&
    Buffer.compare(beforeProbe, fs.readFileSync(dbFile)) === 0, "doctor --probe checks four sources with a read-only queue database");

  for (const [status, state, wording] of [
    ["ahead", "info", "尚未合入 main"], ["behind", "bad", "运行 ai-bridge update"],
    ["diverged", "bad", "已分叉"], ["unavailable", "info", "无法判断谁新"],
  ]) {
    let correctRequest = false;
    const result = await installedVersion("owner/repo", "abc", { commit: "def" }, "def", async (url, options) => {
      correctRequest = url === "https://api.github.com/repos/owner/repo/compare/abc...def" && !!options?.signal;
      return status === "unavailable" ? new Response(null, { status: 404 }) : Response.json({ status });
    });
    check(correctRequest && result.state === state && result.text.includes(wording) &&
      (status === "behind" || !result.text.includes("ai-bridge update")), "GitHub compare " + status + " gives the expected update advice");
  }
}
