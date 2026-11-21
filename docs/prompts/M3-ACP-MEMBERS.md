# 任务：M3，ACP 后台成员（Antigravity、DeepSeek Harness）

版本 0.10.0。协作桥作为 ACP 客户端，自己拉起 `agy acp` 和 DeepSeek Harness 的 ACP 服务，用公开协议投递任务，不再依赖产品内部机制。

## 0. 先读

- `CLAUDE.md`（尤其 Doorbells、Identity binding 两节）、`docs/ARCHITECTURE-v2.md` 第 14、19、21 节
- `src/doorbells/types.ts`、`src/doorbells/index.ts`、`src/doorbells/codex-queue.ts`（一个有进程、有冷却的门铃的写法）
- `src/products/`（产品档案）、`bin/bridge-mcp.mjs`（stdio 转接程序）、`src/engine/presence.ts`、`src/engine/postman.ts`
- ACP 规范：https://agentclientprotocol.com （`initialize`、`session/new`、`session/load`、`session/resume`、`session/prompt`、`session/update`、`session/cancel`、`session/request_permission`、`session/set_mode`）。以规范和下面的实测为准，不要凭印象写字段名。

## 1. 背景

现在有四个成员：
- `claude`（Claude 桌面版，门铃 claude-socket：未公开的命名管道）
- `codex`（ChatGPT 桌面版里的 Codex，门铃 codex-queue + codex-hook：未公开的队列和 Stop hook）
- `antigravity`、`deepseek`：2026-11-21 起通过 MCP 接入，门铃只有 `poll`。实测能 join、`wait_for_mail`、2 到 4 秒内回复聊天、成员之间互相 @。问题是它们必须一直挂着轮询，对话一结束循环就叫不醒。

这两个产品都提供 ACP 服务。M3 让协作桥自己启动并托管它们的 ACP 会话：有信时发一次 `session/prompt`，这就是门铃。不需要它们「醒着」，也不需要任何产品内部机制。

原计划里的「剪贴板成员」不做了：两个新产品都有 ACP，没有需要人工粘贴的成员。在架构文档里记为暂缓。

**成员分工（用户的使用约束）**：主力仍然是 Codex 和 Claude。两个新成员只分轻活：
- DeepSeek 用的是用户自己的账号余额，单价低，但不是免费的；
- Antigravity 是免费档，额度少，Gemini 3.8 Flash 更擅长文字类工作。

适合交给它们的活：文档、文案、纪要、摘要、对文字内容做第二意见式的审查、会议里的提案和互评。重的编码和最终审查不交给它们。

M3 本身不强制这一点。可选做法：给 `agents.<id>` 加一个自由文本字段 `notes`（比如「轻活：文档、文案、第二意见；额度有限」），在会议推进人拟定任务清单时，把它放进推进人看到的成员列表，供分配任务时参考。不做这个字段也不影响验收。

## 2. 实测事实（本机，2026-11-21）

**Antigravity CLI**
- 程序：`%LOCALAPPDATA%\agy\bin\agy.exe`，版本 1.5.13。和桌面版共用登录（Windows 凭据管理器），后台运行不需要再登录。
- `agy acp` 的有用参数：`--disable-telemetry`、`--dangerously-skip-permissions`、`--process-per-session`、`--log-file`、`--add-dir`、`--agent`。
- `initialize` 返回：`agentInfo` 为 `Antigravity ACP Server 1.5.13`；`loadSession: true`；`sessionCapabilities` 有 `resume`、`close`、`load`、`list`、`additionalDirectories`；**没有声明 `mcpCapabilities`**，所以只能挂 stdio 方式的 MCP（ACP 规定的基础能力）。
- `session/new` 带一个 stdio MCP（`node bridge-mcp.mjs`）实测成功，约 2 到 3 秒返回。
  - 返回里有 `models`（`gemini-3.8-flash-high` 等）、`modes`（`default`、`accept-edits`、`auto`、`plan`）和 `configOptions`。
  - agy 会启动转接程序，转接程序以客户端名 `antigravity-client` 连上协作桥。
  - 桥没运行时，转接程序会给出缓存的工具列表，`session/new` 照样成功。
- 新建会话后会推送 `session/update`：`available_commands_update`、`usage_update`。

**DeepSeek Harness**
- 安装在 `E:\Deepseek-Harness`，版本 0.2.2-rc.5，没有登记卸载项，也不在 PATH 上。
- `resources\runtime\cli\bin\dsh.cmd` 实际做的是：设置 `ELECTRON_RUN_AS_NODE=1`，然后运行 `"DeepSeek Harness.exe" --expose-internals "resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" <参数>`。
  - 路径带空格，在 Windows 上通过 shell 调用 `.cmd` 会出错，**必须直接启动 exe 并传入这个环境变量**。
- ACP 入口：`... cli.js --profile acp`（安装自带的 profile）。
- `initialize` 返回：`agentInfo` 为 `deepseek-harness-acp 0.0.1`；`mcpCapabilities: { http: true }`；`sessionCapabilities` 有 `close`、`list`、`resume`；`authMethods` 为空，用的是桌面版已有的账号。
- `session/new` 带 HTTP MCP（`{type:"http", name:"bridge", url:".../mcp", headers:[]}`）实测成功，约 0.5 秒。
  - **桥没运行时会直接失败**，返回 `-32603 "mcp-client(bridge): initial connection or tool synchronization failed"`。所以 DeepSeek 只能在桥运行时建会话；由守护进程自己启动它时，这个条件天然满足。
- 它的 MCP 客户端插件（`@deepseek-ai/dsh-mcp-client`）会响应 `tools/list_changed`，但**断线后不会自动重连**。所以守护进程重启后，旧的 DeepSeek ACP 会话里协作桥的工具会失效，必须重建会话或重启进程。

**两边共同的坑**
- 子进程会继承守护进程的环境变量。实测 agy 启动的转接程序带上了 `CLAUDE_CODE_MESSAGING_SOCKET` 和 `_TOKEN`（日志里显示 `socket:true`），这会让它误以为自己在 Claude 里，去挂 claude-socket 门铃。
  - **启动 ACP 子进程时必须去掉所有 `CLAUDE_CODE_*` 变量**，以及转接程序会读取的其他门铃相关变量。
- 每次 `session/new` 都会在产品自己的历史会话列表里留下一条。所以一个成员在一个项目里应该只用一个长期会话，不要每封信都新建。

## 3. 禁区

和 P1 到 P3 相同：
- 不运行 `reinstall`、`update`、`setup`；
- 不停止或重启 7878；
- 不读写 `.bridge/`；
- 预览用 7879 端口加一个临时 git 仓库；
- 测试 setup 一类的命令时隔离 HOME。

另外：
- 不改用户的 `~/.gemini`、`~/.dsh` 配置。交互式接入（`agy mcp add bridge`、dsh-tui profile 里的 `mcp-bridge` 条目）保持原样，M3 的 `setup` 和 `uninstall` 也不碰它们。
- 用真实的 agy 或 DeepSeek 做实测时，只用 7879 上的临时项目，每个产品最多跑两三次短任务（会消耗用户的模型额度）。smoke 里一律用假的 ACP 代理。

## 4. 设计

### 4.1 配置

`agents.<id>` 新增可选的 `acp` 块，用 zod 校验，并同步更新 `DEFAULT_CONFIG_YAML` 和 `bridge.config.example.yaml`：

```yaml
agents:
  antigravity:
    product: antigravity
    doorbell: auto          # 产品默认链：acp, poll
    acp:
      command: '%LOCALAPPDATA%\agy\bin\agy.exe'   # 可省略，用产品默认值
      args: [acp, --disable-telemetry]
      mcp: stdio            # stdio = 挂 bin/bridge-mcp.mjs；http = 直连 <bridge>/mcp
      mode: accept-edits    # 可选，建会话后发 session/set_mode
      permissions: allow    # allow | deny：如何回答 session/request_permission
  deepseek:
    product: deepseek-harness
    doorbell: auto
    acp:
      command: 'E:\Deepseek-Harness\DeepSeek Harness.exe'
      args: [--expose-internals, 'E:\Deepseek-Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js', --profile, acp]
      env: { ELECTRON_RUN_AS_NODE: '1' }
      mcp: http
      permissions: allow
```

- `command` 和 `args` 里的 `%VAR%` 要展开。
- `cwd` 默认是项目目录。
- 本仓库的 `bridge.config.yaml` 按上面的写法给这两个成员加上 `acp` 块。

### 4.2 产品档案

在 `src/products/` 里新建 `antigravity` 和 `deepseek-harness` 两个档案：
- 两个档案的 `doorbells` 都是 `["acp", "poll"]`；
- `clientNames` 分别是 `antigravity-client` 和 `dsh-mcp-client`；
- `verifiedVersions` 分别填 `1.5.13`，以及 DeepSeek 那边的 `0.2.2-rc.5`（ACP 服务本身报的版本是 0.0.1）；
- agy 的默认 `acp.command` 是 `%LOCALAPPDATA%\agy\bin\agy.exe`，找不到时再到 PATH 上找 `agy.exe`；
- DeepSeek 不猜安装位置：没配 `command` 时，doctor 给出明确提示，告诉用户该怎么填。

M3 里这两个档案的 `setup` 和 `uninstall` 什么都不做，只打印一行说明；`doctor` 只读检查，见 4.8。

### 4.3 新门铃 `acp`（`src/doorbells/acp.ts`）

一个成员对应一个进程和一个长期会话，由 `AcpHost`（或同等结构）管理。

- **启动**：第一次 `ring` 时才启动（懒启动）。
  - 流程：`initialize`（客户端能力里 `fs` 和 `terminal` 都声明为 false，让代理用自己的工具）→ 建会话 → 有 `mode` 就发 `set_mode`。
  - 子进程环境：去掉 `CLAUDE_CODE_*`，加上 `BRIDGE_URL`、`BRIDGE_AGENT_ID=<id>` 和 `BRIDGE_DOORBELL=acp`。
  - Windows 上用 `windowsHide`，不经过 shell。
- **挂载 MCP**：
  - `mcp: stdio` 时，挂 `{name:"bridge", command:<node>, args:[<bin/bridge-mcp.mjs>], env:[BRIDGE_URL, BRIDGE_AGENT_ID, BRIDGE_DOORBELL]}`；
  - `mcp: http` 时，挂 `{type:"http", name:"bridge", url:<BASE>/mcp, headers:[x-bridge-agent, x-bridge-doorbell: acp]}`；
  - 代理没声明 `mcpCapabilities.http` 却配了 `http` 的，报配置错误，并在面板显示原因。
- **会话复用**：会话 id 存进 `agent_endpoints`，kind 为 `acp-session`。
  - 守护进程重启或子进程重启后，先按代理声明的能力试 `session/resume`，不行再试 `session/load`。都失败才 `session/new`，并记一条事件。
  - **`mcp: http` 的成员在守护进程重启后不能复用旧会话**（见第 2 节：dsh 的 MCP 插件不会自动重连），一律新建。
- **门铃属性**：`sessionless: true`、`verify: true`、`waitsForTurn: true`。
  - `possible` 和 `available` 的判断：配置里有 `acp` 块、命令存在、不在冷却期。
  - `armed`：进程活着，并且会话已经建好。
- **`ring`**：
  - 没有进行中的回合时，发 `session/prompt`，内容是唤醒文字。会话第一次收到的提示，要在前面加上「你是协作桥成员 <id>，先调用 join（agent_id=<id>）」，以及工作守则。
  - 已经有回合在进行时，只记一个「待补发」标记，返回 `{ok:true, note:"回合进行中，结束后补发"}`。
  - 回合结束时（`session/prompt` 返回了 `stopReason`），如果这个成员还有排队中或已响铃但没取走的信，再补发一次提示，避免信在回合之间丢失。
- **进入 `join` 的等待说明**：`acp` 门铃要告诉代理「处理完就结束本回合，不要调用 `wait_for_mail`，有新信时协作桥会再给你发消息」。
- **`session/update`**：
  - 把 `tool_call` 和 `agent_message_chunk` 转成 `agents[].activity`，比如「正在调用 fetch_inbox」「正在回复」；
  - 在内存里保留最近 50 行输出，给面板用；
  - 每次工具调用的标题和状态写一条精简日志。这些都不写数据库。
- **`session/request_permission`**：
  - `allow` 时选 `allow_once`，没有就选 `allow_always`；`deny` 时选 `reject_once`；
  - 每次都记事件（工具名和选了什么），面板成员详情里可以看到。
- **取消**：run 被停止、任务被替换，或者正在处理的那封信被作废时，对进行中的回合发 `session/cancel`。
- **出错处理**：
  - 进程退出或 `initialize`、建会话失败时，标记不可用，第 1、2 次失败分别等 30 秒和 2 分钟后重试；
  - 第 3 次失败后停止自动重试，在面板显示原因，并沿用现有的叫不醒提示；
  - （2026-11-21 修订：原文写的是「30 秒、2 分钟、10 分钟退避」，和「3 次后停止」互相矛盾。以 `docs/ARCHITECTURE-v2.md` 第 23 节为准。）
  - 这期间按门铃链退回 `poll`；
  - `ring` 失败时返回 `ringFailed`，现有的「失败后换下一个门铃」逻辑不改。
- **关闭**：
  - 守护进程退出（SIGINT、SIGTERM，或 Windows 控制台关闭）时，先对每个会话发 `session/close`（代理支持的话），再结束整棵进程树。Windows 上用 `taskkill /T /F`，因为 DeepSeek 会派生自己的 Electron 子进程。
  - 面板「停止」按钮的处理方式相同。

### 4.4 身份：交互优先，后台兜底

同一个 `agent_id` 可能同时有两种连接：用户自己打开的交互式对话（agy 窗口、DeepSeek TUI，走 poll），和协作桥托管的 ACP 会话。规则：

1. 有信时，`kick` 先唤醒阻塞中的 `wait_for_mail`。这一步现在就是这样，不改。交互式对话正在轮询的话，信就交给它，不响 ACP 门铃。
2. 这个身份没有绑定在活跃的轮询会话上（最近 `stale_after_seconds` 秒内没有调用过 `wait_for_mail`）时，才响 ACP 门铃。
3. ACP 会话里的 join 一律带 `takeover`，由协作桥替代理补上，不靠模型自己写。
   - 被顶替的交互式会话下次调用工具时，会收到现有的「身份已被接管」说明，内容改成「后台会话正在处理协作桥的信」。
4. ACP 会话的 MCP 连接要带上 `x-bridge-doorbell: acp`。stdio 转接程序从 `BRIDGE_DOORBELL` 环境变量读到这个值后，放进请求头。这样这个身份在任何一次工具调用中被恢复时，门铃都会回到 `acp`，和现在 claude-socket 的做法一样。

`bin/bridge-mcp.mjs` 要能识别 `BRIDGE_DOORBELL`、`BRIDGE_AGENT_ID`，并把它们放进请求头。同时忽略继承来的 Claude 管道变量：设置了 `BRIDGE_DOORBELL=acp` 时，`SOCK` 和 `TOKEN` 都视为空。

### 4.5 面板

在成员卡片和成员详情里：
- 门铃显示「后台（ACP）」；
- 状态分为：未启动、启动中、待命、回合进行中、重试中（附下次重试时间）、已停止（附原因）；
- 详情里显示最近的输出行和最近的权限决定；
- 加两个按钮「重启后台」和「停止后台」，对应 `POST /api/agents/:id/acp/restart` 和 `/stop`。

「正在进行」栏和「待你处理」不用为 ACP 单独处理，它们依据的任务和信件状态没有变化。

### 4.6 不改的部分

信件、任务、会议、聊天、租约、git 提交的逻辑都不改。门铃链、冷却、`checkWake`（看工具调用次数 `callSeq` 有没有增加）直接复用。

### 4.7 日志和事件

新增事件：
- `acp_spawn`：命令、进程号；
- `acp_initialize`：代理名称和版本、能力；
- `acp_session`：会话 id，以及是新建、恢复还是加载；
- `acp_prompt`：信件 id；
- `acp_turn_end`：`stopReason`、耗时；
- `acp_permission`；
- `acp_exit`：退出码、退避时间；
- `acp_cancel`。

**不记录**提示正文和代理输出的完整内容。

### 4.8 doctor

- 对配置了 `acp` 的成员：检查命令是否存在，并显示产品版本是否在已验证范围内。
- `doctor --probe`：对每个 ACP 成员只做一次 `initialize`，然后结束进程。不建会话，不消耗额度。报告代理名称、版本、是否支持 HTTP 方式的 MCP，以及配置的 `mcp: http` 和代理能力是否匹配。

## 5. smoke（新的 K 段）

新建 `scripts/fake-acp-agent.mjs`，用 node 写一个 ACP 代理：
- 收到 `session/new` 时，按传入的 `mcpServers` 连接协作桥：stdio 方式就启动转接程序，http 方式就直接连接。
- 收到 `session/prompt` 时，通过 MCP 依次调用 `join`、`fetch_inbox`，按信件类型调用 `submit_handoff` 或 `say`，然后返回 `end_turn`。过程中发送 `session/update`。
- 可以通过环境变量控制它的行为：
  - 在回合中途请求一次权限；
  - 把回合拖长若干毫秒；
  - 在第 N 次提示时崩溃；
  - 把自己的环境变量报告给测试（测试端核对 `CLAUDE_CODE_*` 是否已经去掉）。

要覆盖的情况：
1. stdio 和 http 两种挂载方式，都能完成一个流水线阶段：收信、交接、提交。
2. 回合进行中又来一封信：不会重复发提示，回合结束后补发一次，第二封信也被取走。
3. 同一个身份有交互式轮询会话在线时，信交给轮询会话，不启动 ACP 进程。
4. 权限请求：配置 `allow` 时批准，配置 `deny` 时拒绝，并且都留下事件。
5. 代理崩溃后进入退避，冷却结束后重启，重启后恢复原来的会话 id。在假代理里实现 `session/resume`。
6. `mcp: http` 的成员在守护进程重启后会新建会话，不复用旧会话。
7. run 被停止时，对进行中的回合发 `session/cancel`。
8. 守护进程退出后，假代理进程也不在了。按进程号检查。
9. 子进程环境里没有 `CLAUDE_CODE_*`，并且有 `BRIDGE_AGENT_ID` 和 `BRIDGE_DOORBELL=acp`。
10. `doctor --probe` 只发 `initialize`。假代理统计收到的方法，不能出现 `session/new`。

现有的 A 到 J 段必须全部照常通过。

## 6. 验收标准

1. `npm run typecheck`、`npm run build` 通过，`npm run smoke` 连续 3 次全部通过。
2. 在 7879 的临时项目里，用真实的 agy 和 DeepSeek 各做一次完整演示，期间不打开它们的交互界面：
   - 在面板上发起一条两阶段流水线，实现交给 `antigravity`，审查交给 `deepseek`。目标要很小，比如「在 README 里加一行」；按第 1 节，它们的额度有限，演示以外不要再派活。
   - 两个阶段都能被 ACP 门铃叫起来，完成后交接，在审批处等你批准。
   - 交接单里写明每一步的耗时，以及 `acp_*` 事件的摘录。
3. 在 2 的过程中，在面板聊天里 @deepseek，它通过 ACP 回复。然后点「停止后台」，确认进程已经退出。
4. 第 4.4 节的「交互优先」规则在 smoke 里有对应的用例（第 5 节的第 3 条）。
5. `doctor --probe` 能显示两个成员的 ACP 版本和能力，并且确实没有建会话。
6. 文档：
   - `docs/ARCHITECTURE-v2.md` 新增第 23 节，写 ACP 门铃、身份规则、实测事实，以及剪贴板成员暂缓；
   - `CLAUDE.md` 和 `AGENTS.md` 同步更新：在 Doorbells 一节加上 `acp` 条目，阶段说明里写 M3 已完成；
   - `docs/USAGE.md` 加一节「后台成员」，说明配置写法、怎么看它在做什么、怎么停止。
7. 版本号改为 0.10.0。

## 7. 交接

建议分 5 个提交：
1. 配置和产品档案；
2. ACP 门铃和进程管理；
3. 转接程序读取环境变量，以及身份规则；
4. 面板和 doctor；
5. smoke 和文档。

交接单要写清楚：
- 哪些是用真实产品验证的，哪些只在假代理上验证过；
- 两个产品各自的回合耗时，以及首次建会话的耗时；
- 已知限制，至少包括 DeepSeek 的 MCP 插件断线后不会重连这一点。
