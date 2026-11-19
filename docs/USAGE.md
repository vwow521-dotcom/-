# 使用说明（0.3：安装包）

协作桥把任务、你的消息、问题答复都当作**信件**投递。有信时，桥按"门铃"叫醒对应的 AI，AI 自己调用 `fetch_inbox` 取信。空闲的 AI 不轮询，也不花额度。

| 成员 | 门铃 | 由谁配置 |
|---|---|---|
| Claude 桌面版（Code 标签页） | 往 Claude 的消息套接字注入一条「[协作桥]」消息 | `ai-bridge setup` |
| Codex（ChatGPT 桌面版） | Stop hook 停靠等信，有信时让 Codex 继续 | `ai-bridge setup`，再在 Codex 里信任一次 hook |
| 其他，或门铃失效时 | AI 循环调用 `wait_for_mail` | 无需配置 |

## 1. 安装（一次）

需要 Node.js 22.13 或更新版本，以及 git。

```powershell
npm install -g E:\Interaction-ai\release\ai-bridge-0.3.0.tgz
ai-bridge setup
ai-bridge doctor
```

`setup` 会做下面几件事，每改一个文件都会先在原位置备份（`*.bak-ai-bridge-<时间>`）：

- `~/.claude.json`：`bridge` 改为由 Claude 启动本机安装的转接程序 `bin/bridge-mcp.mjs`。
- `~/.codex/config.toml`：`[mcp_servers.bridge]` 改为同一个转接程序。转接程序由客户端自己启动，所以桥没启动时也能先拿到占位工具，桥一起来就自动换成真实工具，不用在意启动顺序。
- `~/.codex/hooks.json`：加入**用户级** Stop hook。它对所有项目生效，但只拦下调用过 bridge `join` 的对话；其他对话结束时 0.1 秒就放行，跟没装一样。
- 清理旧版留在各项目 `.codex/hooks.json` 里的 hook，避免和用户级 hook 重复。

然后：

1. 在 Codex 的 **Settings > Hooks**（或输入框旁的 **Review hooks**）里信任新的 Stop hook。`doctor` 会告诉你是否已信任。
2. Claude 和 Codex 都**新开对话**。已经开着的对话还在用旧配置。

## 2. 准备项目并启动桥

```powershell
ai-bridge init E:\某项目     # 第一次用这个项目时：生成 bridge.config.yaml；不是 git 仓库就初始化并做一次提交
ai-bridge start E:\某项目    # 启动桥，面板 http://127.0.0.1:7878/
```

- 数据存在 `<项目>/.bridge/`，不会被提交进 git。
- 审批、提问、门铃没人应、确认超时时，会弹 Windows 通知。不想要通知，在 `bridge.config.yaml` 里设 `notify: { enabled: false }`。
- 重启桥只需关掉终端再 `ai-bridge start` 一次。Claude 由转接程序自动重连；正在停靠的 Codex 会在 90 秒内反复重连，不会被放走。

## 3. 启动提示词

Claude：

```
你是 AI 协作桥中的 claude。调用 bridge 的 join（agent_id = "claude"），然后严格按它返回的 protocol 工作。交接单和进度汇报用中文。
```

Codex：

```
你是 AI 协作桥中的 codex。调用 bridge 的 join（agent_id = "codex"），然后严格按它返回的 protocol 工作。交接单和进度汇报用中文。
```

`join` 会告诉 AI 它用的是哪种门铃、该怎么等信。

Codex 的工作对话停靠等信时，你想直接跟它说话，先点停止再输入，跟平常一样秒回。也可以直接在面板上给它发消息，不用点停止。停靠满 10 分钟还没有信，它会回一句「待命」，然后重新停靠（心跳）。

## 4. 日常流程

1. 面板顶部输入目标，点「开始」。第一个阶段的任务信会投给负责的 AI，门铃把它叫醒。
2. 需要审批时，面板出现审批卡片，同时弹 Windows 通知。批准或打回后，下一封任务信自动发出。
3. AI 用 `ask_human` 提问后不会干等。问题出现在面板上，你回答后，答复以信件送达并叫醒它。
4. 想对某个 AI 说话，在面板「成员」表里给它发消息。这类消息优先级高，AI 处理后需要确认。
5. 面板「信件」栏能看到每封信走到了哪一步：待投递 → 已按门铃 → 已取走 → 已确认。
6. 打回时，你写的备注是「用户要求」，AI 必须做到。审查者的意见分为「阻塞问题」（必须修）和「观察」（可选）。返工完成后，复审的 AI 会拿到同一份要求逐条核对。
7. 审批卡片上的「范围提示」是提醒你：有改动没写进交接单，或者某个阶段改了别的阶段负责的文件（例如编码阶段改了 PLAN.md）。只提示，不阻止。
8. 审查阶段即使没改文件也会生成一个空提交，`git log` 里能直接看到每一轮的审查结论。

## 5. 异常情况

| 面板 / 通知 | 含义 | 你要做的 |
|---|---|---|
| 某封信"送不到"，通知"需要你叫醒 X" | 门铃按了 3 次（间隔 2 分钟）X 都没来取信，或者 X 当时没在等信 | 去 X 里说「继续」；会话没了就新开一个，重新粘贴启动提示词 |
| "确认超时" | AI 取走了需要确认的信，10 分钟没有确认 | 看看它是不是卡住了 |
| 门铃一栏显示红字错误 | Claude 消息注入失败，比如 Claude 更新后接口变了 | 信件会重新投递；一直失败的话，在 Claude 里说「改用 wait_for_mail 等信」 |
| AI 说"身份已被另一个会话占用" | 同一个身份开了两个会话，或旧会话还没超时 | 在面板「成员」表里点它的「释放」，再让新会话 join；或在新会话里说"用 takeover=true 重新 join"。它的回复里会写明旧会话空闲了多久、多久后自动释放 |
| 不确定配置对不对 | — | `ai-bridge doctor` |

## 6. 卸载 / 重装

```powershell
ai-bridge uninstall          # 移除 setup 添加的全部配置，也会清理旧版的手动配置
npm uninstall -g ai-bridge
```

重装：先 `npm install -g <新的安装包>`，再 `ai-bridge setup`。在源码仓库里，`npm run reinstall` 会一步完成"卸载配置 → 重新打包 → 全局安装 → setup → doctor"。各项目的 `.bridge/` 数据和 `bridge.config.yaml` 不受影响。
