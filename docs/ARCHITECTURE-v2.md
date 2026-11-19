# 架构 v2：邮递员（草案，待评审）

目标：把"每个 AI 每时每刻去信箱看有没有新东西"的长轮询，换成"有信放进信箱，邮递员按门铃通知一下"。同时把界面升级为圆桌会议 + 任务看板（见可点击原型）。

## 1. 借鉴清单

原则：不找一个完美的开源项目，而是从各有长处的项目里各挑出值得借鉴的设计。

| # | 来源 | 借鉴什么 | 在本项目里的落点 |
|---|---|---|---|
| 1 | open-agent-bridge | **事件触发**：消息先落库，再推送给收件方的适配器；收件方忙就排队，空闲（turn 结束）时再投递 | 邮递员的投递队列和"忙/闲"判断 |
| 2 | open-agent-bridge | **会话注入**：Claude Code 子进程继承 `CLAUDE_CODE_MESSAGING_SOCKET` + `TOKEN`，往这个套接字写一条 user 消息，就能唤醒正在运行的会话 | Claude 的门铃（第 4 节） |
| 3 | open-agent-bridge | **消息去重**：`message_id` 做主键，重发不会重复广播；适配器维护有上限的已投递 id 集合，重连时用回执账本重建 | 消息表主键 + 门铃侧去重 |
| 4 | open-agent-bridge | **回执分级**：`delivered_to_bridge` ≠ `displayed_to_client` ≠ 被模型读到 | 投递状态机分级，面板如实显示到了哪一级 |
| 5 | mcp_agent_mail | **可靠收发**：消息有 id、thread、发件人、收件人、重要程度；收件箱按"未读"拉取 | 信件模型和 `fetch_inbox` |
| 6 | mcp_agent_mail | **消息确认**：`ack_required` + `acknowledge`，超时未确认要升级提醒 | 任务分派、审批结果等关键信件必须确认，超时在面板标红 |
| 7 | mcp_agent_mail | **文件占用冲突管理**：按路径或 glob 申请租约（独占/共享，带 TTL），冲突时返回占用者；可选 pre-commit 守卫 | 看板并行任务的前提（第 6 节） |
| 8 | mcp_agent_mail | **人类监督者**：人发的信自动高优先级，并附"先停下处理"的说明 | 你在面板上的追问、打回、回答 |
| 9 | Agent Client Protocol | **分层**：MCP 负责工具（AI 调桥），ACP 负责 Agent 控制（桥启动、驱动、取消 AI 会话，统一处理权限请求） | 后台 worker（第 5 节） |
| 10 | Claude Code channels（官方，研究预览） | MCP 服务器用 `notifications/claude/channel` 往运行中的会话推事件 | Claude CLI 会话的备用门铃 |

后续看到好项目，继续往这张表里加。

## 2. 总体结构

```
          面板（圆桌 / 看板 / 审批）           Windows 通知
                 │                               ▲
                 ▼                               │
  ┌──────────────────── bridge 守护进程 ─────────┴────────┐
  │  会议引擎     任务引擎(DAG)     文件租约     git 提交     │
  │        │           │            │                        │
  │        └───── 产生事件 ────▶ 邮局（信件表 + 回执账本）   │
  │                                   │ 邮递员：按收件人选门铃 │
  └───────────────────────────────────┼──────────────────────┘
        MCP 工具（AI 主动调用）          │ 门铃（桥主动通知）
   join / fetch_inbox / ack / ...       ├─ Claude 桌面版：消息套接字注入
                                        ├─ Claude CLI：channels
                                        ├─ Codex 桌面版：长轮询兜底（见第 4 节）
                                        ├─ ACP worker：session/prompt
                                        └─ 剪贴板成员 / 你：Windows 通知 + 面板
```

两条通道分开：
- **MCP 是"取信和办事"**：AI 被唤醒后，自己调工具取信、确认、提交。
- **门铃只负责"叫醒"**：门铃消息只有一句话，比如"你有 1 封新信：T2 已分派给你，调用 fetch_inbox 查看"。不在门铃里塞正文，所以门铃丢了也不丢信。

## 3. 邮局

### 信件

`id`（主键，发件方生成，用来去重）、`thread`（任务 id 或会议 id）、`from`、`to[]`、`kind`、`subject`、`body`、`importance`（normal / high / human）、`ack_required`、`created_at`、`expires_at`。

信件种类：任务分派、审批结果、打回意见、会议邀请（提案 / 互评一轮）、你的追问、问题回答、文件冲突通知、系统消息。

### 回执账本（每个收件人每封信一行）

```
queued → rung（门铃已按） → fetched（AI 调 fetch_inbox 取走） → acked（AI 确认）
                 └─ 门铃失败 → 重试（最多 3 次，间隔 5 秒）→ 仍失败：标为"需要你去叫醒"
```

- 关键信件（分派、打回、你的追问）`ack_required = true`。超过 `ack_timeout`（默认 10 分钟）还没确认，面板标红，并发 Windows 通知给你。
- 门铃侧去重：每个门铃维护最近 5000 个已按过的 id。重连或重启时，从账本里把 fetched 和 acked 的信件 id 补回这个集合，避免把旧信再推一遍。

### 收件人忙闲

借鉴 open-agent-bridge：收件人正在干活时，门铃不打断，信先排队，等它空闲再按一次，多封信合并成一次。"空闲"的判断：它刚调用了 `submit_handoff` 或 `ack`，或超过 N 分钟没有任何工具调用。

## 4. 门铃（按产品）

| 产品 | 方式 | 依据 | 状态 |
|---|---|---|---|
| Claude 桌面版（Code 标签页） | 桥额外提供一个 **stdio 小程序**（`bridge-doorbell`），由 Claude 作为 MCP 服务器启动。它继承 `CLAUDE_CODE_MESSAGING_SOCKET` 和 `CLAUDE_CODE_MESSAGING_TOKEN`，连上守护进程等门铃；有信时往套接字写 `{"type":"auth"}` 和 `{"type":"user",...}` 两帧，会话就被唤醒 | 本机已确认：Claude 桌面版给子进程设置了这两个变量，套接字是 Windows 命名管道 `\\.\pipe\LOCAL\cc-msg-…`。帧格式来自 open-agent-bridge，它只在 Linux 上验证过 | **待实测（S1）** |
| Claude CLI | channels：`notifications/claude/channel` | 官方文档，研究预览，需要 `--channels` 或开发标志 | 备用 |
| Codex（ChatGPT 桌面版） | **Stop hook 门铃**：Codex 每次结束一轮都会运行 Stop hook。hook 进程向桥长轮询取信（等待期间模型不运行），有信就返回 `{"decision":"block","reason":"你有新信…"}`，Codex 会把 reason 当作新的用户消息继续干活。hook 超时前没有信就放行，之后由兜底接管 | Codex 官方 hooks 文档；S2 实测通过。外部无法直接连桌面版的 app-server（它用 stdio 私有启动），所以不走 app-server | **已验证（S2）** |
| ACP worker（Gemini CLI、codex-acp、claude-agent-acp） | 桥作为 ACP client 启动它们：`session/new` 把桥的 MCP 地址传过去，用 `session/prompt` 下发任务，用 `session/request_permission` 统一审批 | ACP 官方文档 | M3 |
| 剪贴板成员（Gemini、DeepSeek 桌面版） | Windows 通知你；面板一键复制提示词，你再把回答贴回来 | 不需要 AI 端支持 | M2 |
| 你 | Windows 通知（审批、提问、确认超时、失联）+ 面板 | — | M2 |

门铃按"能推就推，推不了就退回长轮询"降级。面板上每个成员旁边标出它当前用的是哪种门铃。

## 5. MCP 与 ACP 分工

- **MCP（工具层）**：所有 AI 都通过同一组工具和桥打交道，包括 `fetch_inbox`、`ack`、`send`、`reserve_paths`、`release_paths`、`submit_handoff`、`post_note`、`ask_human`、会议的 `submit_proposal` / `submit_critique`。和产品无关。
- **ACP（控制层）**：只用于桥自己启动的后台 worker。适合不需要你在桌面应用里看着的活，例如批量审查、跑测试、整理会议纪要。桌面版里的会话仍然由你自己开，桥不去控制它们。

这样就有两类成员：**桌面成员**（你开的会话，桥按门铃）和 **后台成员**（桥用 ACP 开的会话）。面板上一视同仁。

## 6. 文件租约（看板并行的前提）

看板允许不同 AI 同时做不同任务，但它们共用一个工作目录，所以需要租约：

- 开工前调用 `reserve_paths(globs, exclusive, ttl)`。和别人的独占租约冲突时，返回占用者和到期时间，并给双方发一封"文件冲突"信。
- **git 提交只提交本任务租约范围内、且在 `files_changed` 里的文件**，不再用 `git add -A`。并行时用 `-A` 会把别人做到一半的改动一起提交。
- 任务完成或被打回时自动释放租约；租约到期前没有续期，在面板标黄。
- 可选：安装 pre-commit 守卫，挡住 AI 手动提交时碰到别人独占文件的情况。

## 7. 会议与任务

- **会议**：提案 → 互评（可以多轮，你决定何时停）→ 定稿 → 分派。每一轮都给所有到场成员发一封"会议邀请"信，信里带上一轮的全部内容；剪贴板成员走复制粘贴。
- **会议产出**：定稿时写入 `<项目>/doc/meetings/<日期>-<议题>.md`，内容包括议题、各方提案、各轮互评、你的决定、任务清单。这个文件随第一个任务一起提交进 git。目录可以在配置里改。
- **任务**：`id`、`title`、`owner`、`reviewer`、`depends_on[]`、`paths`（预计改动范围，开工时用来申请租约）、`status`。依赖全部完成后，任务才进入"可开工"，然后给负责人发分派信。看板上用连线或"等 T1"标签显示依赖。
- 每个 AI 一次只做一个任务；不同 AI 可以并行。任务内部仍然是"做 → 审查 → 你审批"，复用现在的状态机。

## 8. 从 M1 迁移

- 保留：存储层、身份绑定、git、配置、面板骨架。
- 替换：`wait_for_my_turn` 改为 `wait_for_mail`（只给没有门铃的成员用）；"流水线 run"拆成"会议 + 任务 DAG"。现在的固定流水线变成一种任务模板（规划 → 编码 → 审查）。
- 新增：邮局（信件表、回执表）、门铃程序、文件租约、会议引擎、Windows 通知。

## 9. 先做的两个实测

| 编号 | 验证什么 | 怎么做 | 成功标准 |
|---|---|---|---|
| S1 | Claude 桌面版能否被门铃唤醒 | 写一个最小的 stdio MCP 程序，由 Claude 启动；它向 `CLAUDE_CODE_MESSAGING_SOCKET` 写入 auth 帧和一条 user 消息 | 一个空闲的 Claude 会话收到这条消息并开始工作；记录 Windows 命名管道上的帧格式和版本要求 |
| S2 | Codex 桌面版有没有推送入口 | 查 Codex 的 hooks 文档；试试托管守护进程的 `thread/loaded/list` 能否看到桌面版的线程 | 有入口就接上；没有就确认用长轮询 |

S1 成功，Claude 一侧就彻底不用轮询。S2 不论结果如何，Codex 都已经有能用的方案。

### S1 结果（2026-11-19）：通过

- 环境：Windows 11，Claude 桌面版 Code 标签页（`CLAUDE_CODE_ENTRYPOINT=claude-desktop`）。
- 程序：`spikes/s1/doorbell.mjs`，一个 stdio MCP 服务器，由测试会话通过 `spikes/s1/.mcp.json` 启动。
- 子进程拿到了 `CLAUDE_CODE_MESSAGING_SOCKET`（Windows 命名管道 `\\.\pipe\LOCAL\cc-msg-…`）和 `CLAUDE_CODE_MESSAGING_TOKEN`。
- 帧格式与 open-agent-bridge 一致，Windows 上同样可用：先发 `{"type":"auth","token":…}`，再发 `{"type":"user","message":{"role":"user","content":…}}`，每帧一行 JSON（NDJSON）。管道不回任何数据，约 3 秒后由对端关闭。
- 结果：已空闲的测试会话被立即唤醒，按消息内容回复后自行结束回合。
- 注意：Claude 把注入的消息标成"另一个 Claude 会话发来的消息"，按同伴请求对待，不当作用户授权。这正合适：门铃只负责叫醒，真正的任务内容让 AI 用 MCP 工具从桥上取。
- 风险：这是 Claude 内部接口，没有官方文档，版本更新后可能变化。门铃发送失败时要自动退回长轮询，并记录失败原因。

### S2 结果（2026-11-19）：通过

- 环境：Windows 11，ChatGPT 应用里的 Codex（桌面版），项目 `spikes/s2`，项目级 `.codex/hooks.json`（需要信任项目并审查 hook）。
- 程序：`spikes/s2/stop-hook.mjs`。测试时用一个触发文件代替桥的信箱。
- 时间线（UTC）：
  - 02:26:18：Codex 回复"就绪"，Stop hook 开始等信（`stop_hook_active=false`）
  - 02:26:38：信到，hook 返回 `block`
  - 02:26:41：Codex 回复"门铃已收到"，Stop hook 再次触发（`stop_hook_active=true`，同一个 turn_id）
- 结论：从 hook 返回到 Codex 回复约 3 秒。等信期间模型完全不运行，不花额度。继续的内容仍然算同一轮（turn_id 不变），而 `stop_hook_active` 会一直保持 true，所以 hook 不能靠这个标志判断"是不是死循环"，要用桥这边的投递记录来判断。
- 设计取舍：
  - hook 超时（文档默认 600 秒，未写上限）前没有信时，有两种处理：(a) 放行，Codex 真正停下，之后靠兜底 B；(b) 返回一个极短的 block（"没有新信，直接结束本回合"），让 Codex 花一次很小的调用，重新进入等待，相当于每隔一个超时周期发一次心跳。默认选 (b)，超时设为 3600 秒，也就是每小时最多一次很小的调用；两种都可以在配置里改。
### S2b 结果：用户插话会被挡住，且 hook 收不到任何信号

- 现象：hook 停靠期间你能在 Codex 里输入，但回复明显变慢。
- 原因（日志确认）：hook 停靠时，Codex 把你的输入排在 hook 后面，直到 hook 结束才处理。
- 尝试的两个信号都没用：
  - A：`UserPromptSubmit` 在 hook 放行**之后**才触发（02:42:04 放行，02:42:06 触发），停靠期间不触发。
  - B：等待期间会话记录文件没有任何增长（`transcriptGrew:false`）。你的输入只在 Codex 内存里排队。
- 结论：hook 无法感知你在插话，停靠窗口有多长，你的插话最多就要等多久。

### 由此确定的 Codex 用法（已与用户确认：给工作线程发消息统一走面板）

1. **只停靠"桥的工作线程"**：Stop hook 先问桥"这个 session_id 有没有 join 过桥"。只有 join 过的线程才停靠，你自己在同一项目里开的其他 Codex 对话照常结束、不受影响。
   - 实测佐证：S2 的测试 hook 没有做这个判断，信任后，该项目里**每个**新对话结束时都会停靠；没信任 hook 的对话则不受影响。所以正式版必须有这个判断。
   - 怎么知道这个线程 join 过：桥的 `join` 工具拿到的是 MCP 会话 id，hook 拿到的是 Codex 的 `session_id`，两者不同。办法是 hook 读取 stdin 里给的 `transcript_path`（会话记录 jsonl），查找本线程有没有调用过 bridge 的 `join`，并取出 agent_id，然后向桥登记"这个 Codex session_id 属于 codex"。每个线程只需要查一次，结果缓存。
2. **想和工作线程说话，就走桥**：在面板上给 Codex 发消息（追问、打回、补充说明），这些都变成信件，hook 立刻收到并通过 `block` 交给 Codex，没有任何延迟。这正是邮递员的初衷：人和 AI 都通过信箱沟通。
3. **面板提供"放行"按钮**：如果你还是想直接在工作线程里打字，先在面板点"放行 Codex"，桥会让 hook 立即放行，你的输入马上被处理；处理完后 hook 自动重新停靠。**实测：hook 停靠时，在 Codex 里点停止（暂停）再重新输入，和平常一样秒回**，所以在工作线程里直接打字也没问题：先点停止再说话即可。等这一轮结束后，hook 会自动重新停靠。
4. **停靠窗口**：10 分钟，超时时用一次很小的 block 重新停靠（心跳）。所以就算忘了点放行，插话最多也只等 10 分钟。

### 结论：Claude 和 Codex 都不需要模型层面的轮询了

| 成员 | 门铃 | 等信时的成本 |
|---|---|---|
| Claude 桌面版 | 消息套接字注入（S1） | 0 |
| Codex 桌面版 | Stop hook 停靠（S2），只停靠 join 过桥的工作线程 | 0；每个停靠窗口（默认 10 分钟）最多一次很小的心跳调用 |
| 两者都失败时 | `wait_for_mail` 长轮询兜底 | 30 分钟约 1% 额度（M0 实测） |

## 10. 里程碑（替换 DESIGN.md 里的 M2–M4）

| 阶段 | 内容 |
|---|---|
| M2a ✅ | S1、S2 实测 |
| M2b ✅ | 邮局 + 回执 + 去重；Claude 门铃（stdio 转接程序注入消息）；Codex 门铃（Stop hook 停靠）；`wait_for_mail` 兜底；Windows 通知 |
| M2c | 会议引擎（多轮互评、写入 doc/meetings）+ 任务 DAG + 文件租约 + 按任务范围提交 |
| M2d | 按原型实现面板：圆桌、看板（含依赖）、审批、笔记 |
| M3 | ACP 后台 worker；剪贴板成员适配；接入 Gemini、DeepSeek |

## 参考

- open-agent-bridge：https://github.com/kevinArgueta96/open-agent-bridge
- mcp_agent_mail：https://github.com/Dicklesworthstone/mcp_agent_mail（Python 版已进入维护模式，后续版本在 mcp_agent_mail_rust）
- Agent Client Protocol：https://agentclientprotocol.com
- Claude Code channels：https://code.claude.com/docs/en/channels
- Codex app-server：https://developers.openai.com/codex/app-server

## 11. M2b 首次真实运行（2026-11-19，项目 AnytimeMusic）

目标："在应用里加一个「关于」对话框，显示应用名和 package.json 里的版本号"。默认流水线，Claude 桌面版（stdio 转接程序）+ Codex 桌面版（Stop hook）。

| 时间（UTC） | 事件 |
|---|---|
| 03:18:28 | 开始任务，plan 任务信排队（Claude 尚未加入） |
| 03:18:45 | Claude 经转接程序 join，门铃 = Claude 消息注入，立刻按铃 |
| 03:19:47 | Claude 提交规划 → 自动提交 `c552061`，等审批 |
| 03:19:58 | 你批准 → implement 任务信 → Codex 门铃响，但 Codex **没有醒**（缺陷 1） |
| 03:24:13 | 你在面板上问 Claude「还在线吗」→ 门铃 → 9 秒后 Claude 回复并确认 |
| ~03:25 | 你在 Codex 里手动叫醒；Codex 取信、编码、浏览器实测 |
| 03:31:43 | Codex 交接 → 自动提交 `27fd644` → review 任务信 → Claude 门铃 |
| 03:31:49 | Claude 取走 review（6 秒） |
| 03:33:30 | Claude 审查通过（类型检查、67 项测试、浏览器实测） |
| 03:33:41 | 你批准 → 任务完成。全程约 15 分钟，其中两位 AI 的空等成本为 0 |

此后 Codex 用修好的 hook 正常停靠（面板"待命 ●"）。

### 发现的问题

1. **（已修）Codex hook 的输出被截断**：Windows 上 Node 写管道是异步的，`process.exit()` 抢在输出送达前退出，Codex 收到空回复就结束了这一轮。改为写完再退出。
2. **（已修，重启桥后生效）送不出去的信没人提醒**：Codex 没停靠时，信一直"待投递"。现在超过 `ring_retry_seconds` 仍送不出、对方又不在干活，就标为"送不到"并通知你。
3. **（待改）刚 join 就按铃是多余的**：join 协议本来就让 AI 先 `fetch_inbox`，所以刚 join 就按的那一声铃会多出一个空回合。计划：join 后留 15 秒宽限期，期间不按铃。
4. **（模型行为）回答状态不新鲜**：Claude 被问「还在线吗」时说"规划等你批准"，实际上已经批准过。可以考虑在 `[协作桥]` 叫醒消息或 `fetch_inbox` 结果里附上一行当前任务状态。
5. **（偏好）交接单语言**：Codex 用英文写摘要。在启动提示词里加"交接单用中文"即可。
