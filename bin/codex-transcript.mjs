// Shared by the Stop hook and doctor. Only inspect native tool records, never quote transcript text.
import fs from "node:fs";

export function readCodexTranscript(file, server = "bridge") {
  const result = { readable: false, hasToolCall: false, agent: null, drift: false, version: null };
  if (typeof file !== "string") return result;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return result;
  }
  result.readable = true;
  let suspicious = false;
  let parsedJoin = false;
  for (const line of text.split("\n")) {
    if (!line.includes('"McpToolCall"') && !line.includes("join") && !line.includes('"session_meta"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry?.payload;
    const version = entry?.type === "session_meta" && payload?.cli_version;
    if (typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,30})?$/.test(version)) result.version = version;
    const item = payload?.item ?? payload;
    const toolCall = item?.type === "McpToolCall" && typeof item.server === "string" && typeof item.tool === "string";
    if (toolCall) result.hasToolCall = true;
    const join = item?.server === server && item?.tool === "join";
    const namedJoin = ["function_call", "mcp_tool_call", "tool_call", "McpToolCall"].includes(item?.type) &&
      (item.name === "mcp__" + server + "__join" || item.name === server + ".join");
    if (!join && !namedJoin) continue;
    if (!toolCall) {
      suspicious = true;
      continue;
    }
    // An interrupted or rejected join is a valid record and does not bind the conversation.
    if (item.status === "in_progress" || item.status === "failed") continue;
    if (item.status === "completed") {
      try {
        const reply = JSON.parse(item.result?.content?.[0]?.text ?? "null");
        if (typeof reply?.agent_id === "string" && reply.agent_id && !reply.error) {
          result.agent = reply.agent_id;
          parsedJoin = true;
          continue;
        }
        if (reply?.error || item.result?.isError) {
          parsedJoin = true;
          continue;
        }
      } catch {
        if (item.result?.isError) {
          parsedJoin = true;
          continue;
        }
      }
    }
    suspicious = true;
  }
  result.drift = suspicious && !parsedJoin;
  return result;
}
