# 使用说明（M2b：邮递员）

协作桥把任务、你的消息、问题答复都当作**信件**投递。有信时，桥按"门铃"叫醒对应的 AI，AI 自己调用 `fetch_inbox` 取信。空闲的 AI 不轮询、不花额度。

| 成员 | 门铃 | 需要的配置 |
|---|---|---|
| Claude 桌面版（Code 标签页） | 往 Claude 的消息套接字注入一条「[协作桥]」消息 | Claude 的 MCP 配置改用本地转接程序（第 2 步） |
| Codex（ChatGPT 桌面版） | Stop hook 停靠等信，有信时让 Codex 继续 | 目标项目里放 hooks.json 并信任（第 3 步） |
| 其他 / 门铃失效时 | AI 循环调用 `wait_for_mail` | 无 |

## 1. 启动桥

```powershell
cd E:\Interaction-ai
npm start -- --project D:\你的项目
```

- 面板：<http://127.0.0.1:7878/>
- 数据存在 `<项目>/.bridge/`，不会被提交进 git。
- 审批、提问、门铃按不响、确认超时时，会弹 Windows 通知。不想要通知，就在 `bridge.config.yaml` 里设 `notify: { enabled: false }`。

## 2. Claude：用本地转接程序接入（一次性）

Claude 必须通过转接程序 `bin/bridge-mcp.mjs` 接入，门铃才能用。它是一个 stdio MCP 服务器，由 Claude 启动，因此能拿到 Claude 的消息套接字；它会把所有工具调用转给桥。

在 `~/.claude.json` 的 `mcpServers` 里，把 `bridge` 改成：

```json
"bridge": {
  "type": "stdio",
  "command": "node",
  "args": ["E:/Interaction-ai/bin/bridge-mcp.mjs"]
}
```

改完后新开的 Claude 会话生效。转接程序的日志在 `%TEMP%\ai-bridge\proxy.log`。

## 3. Codex：安装 Stop hook（每个目标项目一次）

1. Codex 里 `bridge` 这个 MCP 服务器保持现在的配置（HTTP，`http://127.0.0.1:7878/mcp`）。
2. 把 [bin/codex-hooks.example.json](../bin/codex-hooks.example.json) 复制到目标项目的 `.codex/` 目录，**并改名为 `hooks.json`**（Codex 只认这个文件名）。注意：桥每次交接都会 `git add -A`，`.codex/hooks.json` 会被一起提交进目标项目；不想提交就把 `.codex/` 加进 `.gitignore`。
3. 在 Codex 里信任这个项目，并在 **Settings > Hooks**（或输入框旁的 **Review hooks**）里信任这个 hook。

这个 hook 只对**调用过 bridge 的 join 的对话**生效，其他对话结束时立即放行，跟没装一样。工作线程停靠等信时：

- 你想直接和它说话：先点停止，再输入，跟平常一样秒回。或者在面板上给它发消息，不需要点停止。
- 停靠满 10 分钟还没有信时，Codex 会回一句「待命」，然后重新停靠（心跳）。不想要心跳，就设环境变量 `BRIDGE_HEARTBEAT=0`。

## 4. 启动提示词

Claude：

```
你是 AI 协作桥中的 claude。调用 bridge 的 join（agent_id = "claude"），然后严格按它返回的 protocol 工作。
```

Codex（在装好 hook 的项目里新开对话）：

```
你是 AI 协作桥中的 codex。调用 bridge 的 join（agent_id = "codex"），然后严格按它返回的 protocol 工作。
```

`join` 会告诉 AI 它用的是哪种门铃、该怎么等信。提示词不用改。

## 5. 日常流程

1. 面板顶部输入目标，点「开始」。第一个阶段的任务信会投给负责的 AI，门铃把它叫醒。
2. 需要审批时，面板出现审批卡片，同时弹 Windows 通知。批准或打回后，下一封任务信自动发出。
3. AI 用 `ask_human` 提问后立即返回，问题出现在面板上；你回答后，答复以信件送达并叫醒它。
4. 想对某个 AI 说话，在面板「成员」表里给它发消息。这类消息优先级高，需要 AI 确认。
5. 面板「信件」栏能看到每封信走到了哪一步：待投递 → 已按门铃 → 已取走 → 已确认。

## 6. 异常情况

| 面板 / 通知 | 含义 | 你要做的 |
|---|---|---|
| 某封信"送不到"，通知"需要你叫醒 X" | 门铃按了 3 次（间隔 2 分钟），X 一直没来取信 | 去 X 里说「继续」；会话没了就新开一个，重新粘贴启动提示词 |
| "确认超时" | AI 取走了需要确认的信，10 分钟没有确认 | 看看它是不是卡住了 |
| 门铃一栏显示红字错误 | Claude 消息注入失败（例如 Claude 更新后接口变了） | 信件会重新投递；一直失败的话，在 Claude 里说「改用 wait_for_mail 等信」 |
| AI 说"身份已被另一个会话占用" | 同一个身份开了两个会话 | 关掉多余的，或者在新会话里说"用 takeover=true 重新 join" |
