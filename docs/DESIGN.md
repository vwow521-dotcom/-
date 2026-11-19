# AI 协作桥 设计文档（v0.1 草案）

## 1. 目标

让不同产品的 AI 编码代理按角色流水线接力完成同一个项目，替代"一个 AI 做完更新 md → 人工切到另一个 AI"的手工交接。各 AI 都在自己的图形界面里工作（Claude Code 桌面版、Codex 桌面 App），由桥负责派活、传递结构化交接内容、在关键节点等人审批。

### 已确认的决定

| 项 | 决定 |
|---|---|
| 第一版接入 | Claude Code 桌面版、Codex 桌面 App（Gemini CLI、DeepSeek-TUI 后续） |
| 桥的形态 | 本地常驻服务，对外提供 MCP 服务 + Web 面板 |
| 协作模式 | 角色分工流水线，角色↔产品按项目配置 |
| 唤醒 | A 为主：会话调用 `wait_for_my_turn` 挂起等待；B 兜底：会话失联时系统通知你去说"继续" |
| 自动化 | 半自动。只在"规划完成"和"审查结论"两处停下等你 |
| 审查打回 | 不自动重做，先由你确认后才退回编码 |
| 权限 | 接受各 AI 自动执行权限 |
| 工作区 | 同一目录 + 同一 git 仓库，每个阶段完成自动提交 |
| 控制台 | 本地 Web 面板 |
| 技术栈 | TypeScript / Node |

### 接入分级（按产品能力）

你实际使用的都是桌面端，它们能力差别很大，桥按两档接入：

| 档位 | 能力 | 产品（待逐个验证） | 能担任的角色 |
|---|---|---|---|
| 一档：代理型 | 能连本地 MCP、能读写项目文件、能跑命令 | Claude 桌面版（Code 标签页）、ChatGPT Windows 桌面版里的 Codex（已确认可用，本地 MCP 待 M0 验证）、Antigravity | 任意角色，包括编码 |
| 二档：聊天型 | 不能连本地 MCP，也碰不到项目文件 | ChatGPT 普通对话、Gemini 桌面版、DeepSeek 桌面版 | 只能做咨询类角色：规划建议、方案评审、代码审阅（桥把相关代码贴进提示词） |

二档的交接方式："剪贴板适配器"。轮到它时，面板生成一段完整提示词（目标 + 交接单 + 相关代码片段），你一键复制、粘贴到对应应用；再把它的回答粘回面板，桥解析成交接单继续流转。这一档没法自动唤醒，每一步都要你操作。

### 第一版不做

并行任务拆分、按特长动态路由、交叉辩论、多项目同时运行、远程/多机。

## 2. 总体架构

```
 ┌──────────────────┐        ┌──────────────────┐
 │ Claude Code 桌面版 │        │   Codex 桌面 App  │
 │  （规划/审查会话）  │        │   （编码会话）     │
 └────────┬─────────┘        └────────┬─────────┘
          │ MCP (HTTP)                 │ MCP (HTTP 或 stdio 转接)
          ▼                            ▼
 ┌────────────────────────────────────────────────┐
 │                bridge 守护进程 (Node)            │
 │  MCP 端点 /mcp │ 调度器(状态机) │ Web 面板 + SSE  │
 │  git 提交器    │ 通知器(Windows toast)           │
 │  存储：<项目>/.bridge/bridge.db (SQLite)         │
 └────────────────────────────────────────────────┘
          ▲
          │ http://localhost:7878
        你（浏览器：看进度、批准/打回）
```

**关键点：必须是单进程守护服务。** 如果用普通 stdio MCP，每个客户端会各自拉起一个独立进程，状态无法共享。因此桥以守护进程运行，MCP 走 Streamable HTTP（`http://localhost:7878/mcp`）。若某个客户端只支持 stdio，则提供一个很薄的 `bridge-mcp-stdio` 转接程序，把 stdio 请求转发到守护进程。

## 3. 流水线与状态机

### 3.1 配置文件 `bridge.config.yaml`（放在目标项目根目录）

```yaml
project: my-app
agents:
  claude: { product: claude-code }
  codex:  { product: codex }
pipeline:
  - id: plan
    role: 规划/架构
    agent: claude
    gate: true              # 完成后等你批准
  - id: implement
    role: 编码
    agent: codex
  - id: review
    role: 审查
    agent: claude
    gate: true              # 审查结论等你确认
    on_reject: implement    # 你确认打回后退回到哪个阶段
wait:
  poll_seconds: 50          # 每次 wait 调用最长阻塞时间，需小于客户端工具超时
  offline_after_seconds: 180 # 超过这个时间没调用 wait，判定会话失联 → 走 B 兜底
```

### 3.2 阶段状态

```
pending → ready → in_progress → submitted ─┬─(无 gate)→ done → 下一阶段 ready
                                           └─(gate)→ awaiting_approval
                                                       ├─ 批准 → done
                                                       └─ 打回(你确认) → on_reject 阶段重新 ready，携带审查意见
```

一次"任务"（run）= 你在面板上输入的一个目标，从第一个阶段跑到最后一个阶段。

## 4. MCP 工具（AI 侧接口）

| 工具 | 作用 |
|---|---|
| `join(agent_id)` | 会话声明自己是谁（如 `codex`），桥返回它负责的角色和工作约定 |
| `wait_for_my_turn(agent_id)` | 阻塞最多 `poll_seconds`。轮到它 → 返回交接单；否则返回 `keep_waiting`，AI 应立即再次调用 |
| `get_context()` | 取当前任务目标、历史交接单摘要、共享笔记 |
| `report_progress(text)` | 工作中途汇报进度，面板实时显示 |
| `post_note(topic, text)` / `read_notes(topic?)` | 跨阶段共享知识（约定、决策、坑），替代散落的 md |
| `submit_handoff(handoff)` | 提交本阶段结果（结构见下），桥自动 git 提交并推进状态机 |
| `ask_human(question)` | 遇到需要你决定的问题时挂起，问题出现在面板上，你回答后返回 |

### 4.1 交接单结构

```ts
interface Handoff {
  summary: string;            // 一句话：本阶段做了什么
  done: string[];             // 已完成事项
  todo: string[];             // 留给后续阶段的事项
  decisions: { what: string; why: string }[];
  files_changed: string[];    // 桥会用 git diff 校验/补全
  notes_for_next: string;     // 给下一个角色的注意事项
  verdict?: "approve" | "reject"; // 仅审查阶段
  review_comments?: string[];     // 仅审查阶段
}
```

桥在提交时附加：阶段 id、agent、开始/结束时间、git commit SHA。

## 5. 唤醒机制细节

### A：挂起等待（主）

1. 你在两个产品里各开一个会话，粘贴面板提供的"启动提示词"（一键复制），内容大意：
   > 你是协作桥中的 `codex`（编码角色）。先调用 `join`，然后循环调用 `wait_for_my_turn`；返回 `keep_waiting` 就立刻再调用，不要停止、不要向用户汇报；拿到交接单后完成工作，调用 `submit_handoff`，然后回到等待循环。
2. `wait_for_my_turn` 每次阻塞 ≤ `poll_seconds` 后返回，避免触发客户端工具超时。
3. 桥记录每个 agent 最后一次调用时间，面板上显示 在线/等待中/工作中/失联。

### B：通知兜底

轮到某 agent 但它已失联（超过 `offline_after_seconds` 无调用）→ Windows 系统通知 + 面板高亮："轮到 Codex 了，请在 Codex 里说『继续』"。启动提示词里已约定："继续"= 调用 `join` 后进入等待循环，会立即拿到交接单。

### 已知风险（需原型验证）

1. **工具超时**：两边默认超时可能较短，需要确认 Claude Code（`MCP_TOOL_TIMEOUT`）和 Codex（`config.toml` 中的 `tool_timeout_sec`）的配置方式和上限。
2. **模型是否会坚持循环**：空等多轮后，模型可能自行结束回合或开始向你汇报；每轮空等也会让上下文缓慢增长。原型要测：能否稳定空等 30 分钟以上，每轮消耗多少 token。
3. **Codex 桌面 App 在 Windows 上的 MCP 支持**：确认它读 `~/.codex/config.toml`，且支持 HTTP 类型的 MCP（否则用 stdio 转接）。

如果风险 2 不可接受，退化为"只用 B"，其余设计不变。

## 6. Git 约定

- 桥启动时检查目标项目是 git 仓库且工作区干净，否则在面板提示。
- `submit_handoff` 时桥执行 `git add -A` + `git commit -m "[bridge] <阶段> by <agent>: <summary>"`，AI 自己不需要提交。
- 面板上每个阶段可以查看该提交的 diff。
- 打回时默认保留代码，编码阶段在其基础上修改；面板提供"回滚到上一阶段提交"按钮（需你确认）。

## 7. Web 面板

- **任务页**：输入目标，启动一次运行。
- **流水线视图**：各阶段状态、当前负责的 agent、实时进度（SSE）。
- **审批卡片**：显示交接单 + diff，按钮：批准 / 打回（填写意见）。
- **agent 状态**：在线 / 等待 / 工作中 / 失联，以及复制启动提示词。
- **共享笔记**、`ask_human` 问题的回答入口。

## 8. 目录结构（桥自身仓库）

```
src/
  daemon.ts         入口：启动 HTTP 服务（MCP + 面板 + SSE）
  mcp/              MCP 工具定义
  engine/           状态机、调度、等待队列
  store/            SQLite 存取
  git/              提交与 diff
  notify/           系统通知
  config/           bridge.config.yaml 解析与校验
web/                面板前端
bin/bridge-mcp-stdio.ts  stdio→HTTP 转接
```

命令行（仅用于启动守护进程）：`bridge start --project <目标项目路径>`。

## 9. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| M0 原型验证 ✅ | 最小 HTTP MCP 服务，只有 `wait_for_my_turn` + `submit_handoff` | 第 5 节三个风险都有结论；两边能连上并空等 30 分钟 |
| M1 核心 ✅ | 状态机、存储、全部 MCP 工具、git 提交，外加可用的审批面板 | 冒烟测试跑通 plan → 审批 → implement → review 打回 → 返工 → 通过，以及重启恢复 |
| M2 面板 | 流水线视图、审批、打回、通知兜底 | 你只通过面板和两个图形界面完成一次完整运行 |
| M3 打磨 | 回滚、共享笔记 UI、启动提示词、配置校验 | — |
| M4 扩展 | 接入 Gemini CLI、DeepSeek-TUI | — |

## 10. 面板定位与同类工具的教训

面板是你唯一需要盯的地方：随手发任务、看进度、看反馈。AI 的对话仍留在各自的桌面应用里。

| 同类工具 | 问题 | 本项目的对策 |
|---|---|---|
| AI 圆桌会议类（用户主持、多 AI 讨论方向和分工） | 靠 CLI 登录接入，有些 AI 根本登不上 | 不新增任何登录：桥只是一个本地 MCP 服务，接入你已经登录好的桌面应用 |
| Discord 群聊类（每个 AI 一个机器人） | 适合聊天，不适合干活：没有共享工作区，结果散落在消息流里 | 共享同一个 git 工作区；结构化交接单 + diff 才是"反馈"，不是聊天记录 |

圆桌会议里值得借鉴的是"你主持、多个 AI 先各自出方案再定分工"。后续可以加一个可选的**规划会议**阶段：目标发起后，所有在线 agent 各提交一份方案（方向、拆分、分工建议），面板并排展示，你选定或合并后，再进入流水线。它依赖 M1 的状态机，排在 M3 之后。

面板设计原则：只做调度和观察，不做聊天；一屏看完（任务输入、agent 状态、交接时间线，审批/打回/ask_human 都是时间线上的卡片）；零配置，一条命令启动。
