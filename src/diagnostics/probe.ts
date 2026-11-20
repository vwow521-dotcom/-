import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readCodexTranscript } from "../../bin/codex-transcript.mjs";
import { codexHome, codexQueueDb, findCodexCommand } from "../products/codex-runtime.js";

type Check = { state: "ok" | "bad" | "info"; text: string };
const run = promisify(execFile);
const ok = (text: string): Check => ({ state: "ok", text });
const bad = (text: string): Check => ({ state: "bad", text });
const info = (text: string): Check => ({ state: "info", text });

async function queueHelp(): Promise<Check> {
  const command = findCodexCommand();
  if (!command) return info("Codex 队列命令：找不到 codex 可执行文件");
  try {
    // --help exits before any queue operation. No conversation ID or message is passed.
    const { stdout, stderr } = await run(command[0], [...command.slice(1), "queue", "--help"], { windowsHide: true, timeout: 5_000 });
    const output = stdout + stderr;
    if (/--thread\b/.test(output) && /--message\b/.test(output))
      return ok("Codex 队列命令：帮助里有 --thread 和 --message");
    return bad("Codex 队列命令：帮助缺少 --thread 或 --message");
  } catch {
    return bad("Codex 队列命令：无法读取 queue --help");
  }
}

function queueSchema(): Check {
  const file = codexQueueDb();
  if (!fs.existsSync(file)) return info("Codex 队列数据库：尚无 queue_1.sqlite");
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      // Match the driver's SELECT to validate both the table and the column.
      db.prepare("SELECT thread_id FROM queued_items LIMIT 0").all();
      const count = db.prepare("SELECT count(*) AS n FROM queued_items").get()?.n;
      return ok("Codex 队列数据库：可只读查询 queued_items.thread_id，当前排队 " + count + " 项");
    } finally {
      db.close();
    }
  } catch {
    return bad("Codex 队列数据库：无法只读查询 queued_items.thread_id");
  }
}

function latestTranscript() {
  let latest: { file: string; modified: number } | undefined;
  for (const folder of ["sessions", "archived_sessions"]) {
    const root = path.join(codexHome(), folder);
    try {
      for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const file = path.join(entry.parentPath, entry.name);
        try {
          const { mtimeMs: modified } = fs.statSync(file);
          if (!latest || modified > latest.modified) latest = { file, modified };
        } catch {}
      }
    } catch {}
  }
  return latest?.file;
}

function transcriptFormat(): Check {
  const file = latestTranscript();
  if (!file) return info("Codex 会话记录：找不到会话记录");
  const view = readCodexTranscript(file, process.env.BRIDGE_MCP_NAME ?? "bridge");
  if (!view.readable) return bad("Codex 会话记录：无法读取最近一份记录");
  if (view.drift) return bad("Codex 会话记录：发现 bridge 的 join 痕迹，会话记录格式可能变了");
  if (view.hasToolCall) return ok("Codex 会话记录：已解析 McpToolCall");
  return info("Codex 会话记录：最近的记录里暂无可验证的 McpToolCall");
}

export async function probe(readState: () => Promise<any>) {
  const [help, state] = await Promise.all([queueHelp(), readState()]);
  const checks = [help, queueSchema(), transcriptFormat()];
  const socketReports = (state?.agents ?? []).filter((agent: any) => agent.product?.id === "claude-code" && agent.product.claudeSocket);
  for (const agent of socketReports) {
    const { present, pipe } = agent.product.claudeSocket;
    const label = "Claude 消息套接字（" + agent.id + "）";
    if (!present) checks.push(info(label + "：转接程序没有收到套接字变量"));
    else if (pipe === null) checks.push(info(label + "：有套接字变量，管道存在性待确认"));
    else if (pipe) checks.push(ok(label + "：有套接字变量，管道存在"));
    else checks.push(bad(label + "：有套接字变量，管道未找到"));
  }
  if (socketReports.length === 0)
    checks.push(info(state ? "Claude 消息套接字：守护进程尚未收到转接程序的报告" : "Claude 消息套接字：守护进程未运行"));
  return checks;
}
