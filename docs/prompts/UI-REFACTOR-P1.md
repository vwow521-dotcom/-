# 任务：面板重构 P1（Chat / Meeting / Office 骨架 + 「待你处理」）

> 交给 Codex 执行，Claude 审查。设计依据：`docs/UI-VISION-CHAT-OFFICE-MEETING.md`。
> 这次只做愿景文档里的 P0 + P1，再加一个 Office 静态原型。动效、精装修和门铃加固另开任务。

## 0. 先读

1. `AGENTS.md`：项目结构、命令、约定。
2. `docs/UI-VISION-CHAT-OFFICE-MEETING.md`：全文读完，第 3、7、10 节是验收依据。
3. `docs/ARCHITECTURE-v2.md` 第 16–18 节（聊天、会议室面板、运行 #6）。
4. 现有代码：`panel/room.{html,css,js}`、`src/engine/room.ts`（时间线读模型）、`src/engine/workspace.ts` 的 `snapshot()`、`src/daemon.ts` 的 `/api/*` 路由、`scripts/smoke.ts`。

## 1. 你正在用协作桥改协作桥本身：必须遵守

你现在通过协作桥收到这项任务。负责收发信件的守护进程跑的是**全局安装的那一份**（`%APPDATA%\npm\node_modules\ai-bridge`），它的项目目录就是本仓库。所以：

- **不要**运行 `npm run reinstall`、`ai-bridge update`、`ai-bridge setup`、`ai-bridge uninstall`，也不要停止或重启 7878 端口上的守护进程。否则你自己和审查方的门铃都会断。改完由用户决定什么时候装。
- **不要**读写 `.bridge/` 目录，那是正在运行的守护进程的数据库。
- 要在浏览器里看新面板，就起一个**开发守护进程**，项目目录用一个**临时 git 仓库**，不能是本仓库，否则两个进程会共用同一个数据库：
  ```
  mkdir %TEMP%\bridge-ui-dev && cd %TEMP%\bridge-ui-dev && git init
  npm start -- --project %TEMP%\bridge-ui-dev --port 7879     # 在本仓库目录里运行
  ```
  smoke 测试自己会用 7891 端口，不冲突。
- 你修改的 `panel/` 文件不会影响正在运行的面板（那一份是从全局安装目录提供的），可以放心改。

## 2. 范围

### 不做

- 不改任务状态机、会议流程、邮局、门铃、MCP 工具、数据库表结构、CLI。
- 不引入前端框架、打包工具或构建步骤。面板继续是 `panel/` 下的静态文件，随 npm 包一起发布（`package.json` 的 `files` 已包含 `panel`）。
- 不做 3D、复杂动画或美术素材；不复制 Discord 或 Marvis 的任何素材。
- 不删除 `/classic`。

### 要做

#### A. 服务端：只做**增量**读模型（`src/engine/`）

已有字段（`attention`、`timeline`、`agents[]` 等）保持不变，旧页面和 smoke 还在用它们。

1. **`snapshot().inbox`：「待你处理」的唯一来源。** 返回一个数组，每项包括：
   - `kind`：`handoff_gate` | `meeting_final` | `meeting_stalled` | `question` | `delivery`
   - `id`（稳定，例如 `gate-<attempt_id>`、`question-<id>`）
   - `title`（一句话）、`agent`、`at`、`urgency`（`high` | `normal`）
   - `target`：`{ view: "meeting" | "chat" | "office", anchor: string }`，前端据此跳转
   - `ref`：对应时间线条目的定位信息（例如 handoff 的 `id`、round 的 `meeting_id` + `round`），前端用它找到完整卡片

   各类的来源（必须复用现有判断，不要另写一套）：
   - `handoff_gate`：状态为 `awaiting_approval` 的 attempt（就是 `Room.handoff()` 里 `gate` 不为空的那些）。
   - `meeting_final`：会议状态为 `awaiting_approval`。
   - `meeting_stalled`：会议在 `review`（等你决定再互评还是定稿），或在 `collecting` 但 `expectedSpeakers` 里有人超过一段时间没发言（阈值复用现有配置，没有合适的就只做 `review`）。
   - `question`：`store.openQuestions()`。
   - `delivery`：和 `attention` 的 `fallback` 判断同源（有 stuck 信、叫不醒、轮到某个成员但它没加入或离线）。每个成员一项，`attention` 的计算改为从 `inbox` 派生或共用同一个函数。

   顺序：`high` 在前，其余按时间。

2. **`agents[].activity`：给 Office 用，只依据有证据的状态。** 每个成员一项：
   ```
   { state, label, evidence, since, link }
   ```
   - `state`：`offline` | `never-joined` | `stale` | `idle` | `working` | `reviewing` | `meeting` | `awaiting_you` | `unreachable` | `unknown`
   - `evidence`：给人看的依据，例如「attempt #12 in_progress（T2 实现）」「会议 #3 第 2 轮还没发言」「有 2 封信叫不醒」「最后一次工具调用 14:20:31」
   - `since`：这个状态的依据时间（attempt 更新时间、轮次开始时间、最后一次调用时间等）
   - `link`：同 `inbox.target`

   判定顺序（高的优先）：unreachable（有 stuck 或叫不醒的信）> offline / never-joined / stale（来自 `presence.status`）> meeting（欠当前轮发言）> awaiting_you（它的 attempt 在等审批）> reviewing / working（它有 `in_progress` 的 attempt）> idle（在线且手上没有活）。
   - 区分 reviewing 和 working：阶段的 `agent` 是 `reviewer` 模板，或者阶段 id / role 能明确判断出是审查时，算 reviewing。**判断不了就算 working，不要猜。**
   - 只有 `ready`、还没被取走的 attempt 不算 working：此时 `state` 保持原样，在 `evidence` 里写「有任务待领取」。

3. 不新增 API 路由。前端继续只读 `/api/state` 和 `/api/stream`，所有动作调用现有 POST 接口。

#### B. 前端：把 `room.js` 拆成模块，加三个视图

**目录结构**（建议，可以调整，但职责要分开）：
```
panel/
  index.html          新入口（服务在 /）
  app.css
  js/
    main.js           启动、委托点击、SSE + 5 秒兜底刷新
    state.js          拉 /api/state，按区域比较变化，订阅者模式
    router.js         hash 路由：#/chat  #/meeting  #/office，带 anchor（#/meeting?gate=12）
    model.js          纯函数（不碰 DOM）：收件人解析、送达提示、inbox 分组、时间线拆分等
    actions.js        所有 POST 动作，统一显示错误，危险动作要确认
    cards/            handoff.js  round.js  question.js  chat.js：卡片渲染，各视图和抽屉共用
    views/            chat.js  meeting.js  office.js
    inbox.js          「待你处理」抽屉
  v1/                 现在的 room.html/css/js 原样搬过来，服务在 /v1，作为回退
```
- 用原生 ES 模块：`<script type="module">`。`daemon.ts` 继续用 `/panel/*` 提供静态文件。注意 `.js` 要以 JavaScript MIME 类型返回（Express static 默认没问题，确认一下）。
- `model.js` 必须是纯函数、不访问 DOM，这样 smoke 可以直接 `import` 来测。

**全局布局**
- 顶栏：项目名、三个视图切换（Chat / Meeting / Office）、「待你处理 N」按钮（数字来自 `inbox.length`，有 `high` 项时醒目）、连接状态（连不上协作桥时的横幅沿用现有文案）。
- 「待你处理」是**抽屉或浮层，不是第四个页面**。每一项直接渲染完整的上下文卡片：交接审批卡带批准、打回和备注框；定稿卡带批准和打回；问题卡带回答框；送达异常卡写明该怎么做。卡片可以直接操作，也可以「在会议室中查看」跳到对应位置。
- 手机宽度（< 768px）：视图切换放到底部导航，抽屉全屏，审批按钮不用滚动很远就能点到。

**Chat 视图**（默认视图）
- 左侧：成员列表，只显示名字、简要状态（`activity.label`）、未读或排队数。门铃链、会话绑定、释放按钮收进「成员详情」，点成员才打开。
- 中间：时间线里只完整展示 `type: "chat"` 的条目，保留回执、回复和 @。会议轮次、交接、任务事件折叠成**一行可跳转的摘要**（例如「会议 #3 第 2 轮：claude、codex 已发言 →」「T2 实现交接待你审批 →」），点击跳到 Meeting 视图的对应位置。问题卡保留完整卡片，因为它需要你回答。
- 底部输入框：沿用现有的收件人选择、@ 解析、Enter 发送 / Shift+Enter 换行、回复、送达提示（`deliveryHint`），行为必须和旧页面一致。
- 「发起」入口（开会讨论 / 直接开始流水线 / 停止）放进一个按钮打开的小面板，不常驻左栏。

**Meeting 视图**：会议 + 执行
- 顶部：议题、当前轮次、参会成员、阶段条（提案 → 互评 → 定稿 → 批准 → 执行）。
- 「讨论」区：当前轮的发言按成员**分栏并排**（窄屏改为上下排列），长文默认折叠；明确显示「等待谁发言」。更早的轮次折叠成摘要，点开看全文。定稿轮显示任务清单表。
- 操作区：**只显示当前合法的动作**（来自现有 round 卡的逻辑：再互评、请定稿、跳过没发言的、批准或打回定稿、取消会议），带备注框。
- 「执行」区：当前 run 的任务卡（依赖、负责人、状态、租约）、每个任务的交接卡（待审批的带审批卡）、停止按钮（要确认）。这部分取代旧右栏的任务和租约。
- 没有会议也没有 run 时显示空状态，提供发起入口。

**Office 视图**：静态原型
- 每个成员一个「工位」卡片（简单的 CSS / SVG 图形就行），显示 `activity.state` 对应的图标和文字、`evidence`、`since`（相对时间）。
- 会议进行中时，参会者显示在「会议桌」区域；有 `awaiting_you` 时，「审批桌」显示数量，点击打开抽屉。
- 每个工位只有几个按钮：看任务（跳 Meeting）、发消息（跳 Chat 并选好收件人）、查看异常（打开成员详情）。
- 只允许极轻的 CSS 过渡，并遵守 `prefers-reduced-motion`。**`unknown` 或 `stale` 状态必须静态显示**，不能有任何「在工作」的动效。

**状态保留**（愿景文档第 10 节的完成标准）
- 刷新时只重建数据真正变化了的区域。正在编辑的输入框（聊天草稿、审批备注、回答框、发起框）不能被清空，也不能失焦。现有的 `data-keep` 机制要推广到所有视图和抽屉。
- 每个视图的滚动位置和展开状态在切换视图后要保留。聊天草稿在切换视图后也要保留。
- 切换视图只是渲染，不能触发任何 POST。

#### C. 路由和文件（`src/daemon.ts`）

- `/` → 新的 `panel/index.html`；`/v1` → `panel/v1/room.html`（它引用的资源路径改为 `/panel/v1/...`）；`/classic` 不变。

#### D. 测试（`scripts/smoke.ts`），按 AGENTS.md 要求扩展

- `inbox`：分别造出一个待审批的交接、一个待批准的定稿、一个未回答的问题、一个叫不醒的成员，检查每种 `kind` 都出现，`target` 和 `ref` 能对上时间线里的条目；审批、回答之后对应项消失。
- `activity`：编码中 → `working`，欠会议发言 → `meeting`，有 stuck 信 → `unreachable`，从未加入 → `never-joined`；每项都有非空的 `evidence`。
- 静态资源：`/`、`/panel/js/main.js`、`/v1`、`/classic` 都能访问，`.js` 的 Content-Type 是 JavaScript。
- 直接 `import` `panel/js/model.js` 测纯函数：`@claude你好` 的收件人解析、送达提示文案（包括现有 smoke 检查的「排队中，等它这一轮结束」）。现有对 `/panel/room.js` 内容的检查改为针对新文件，或者针对 `/panel/v1/room.js`。
- `npm run typecheck`、`npm run build`、`npm run smoke` 全部通过。

#### E. 文档

- `docs/ARCHITECTURE-v2.md` 新增一节「20. 面板 P1：三视图与待你处理」，写清楚 `inbox` 和 `activity` 的来源和判定顺序、模块结构、`/v1` 回退。
- `CLAUDE.md` 和 `AGENTS.md` 里描述面板的段落**同步更新**（两个文件必须一起改）。
- `docs/USAGE.md` 里面板相关的说明。
- `package.json` 版本号改为 `0.7.0`（`package-lock.json` 同步）。

## 3. 验收标准（审查方会逐项实测）

1. 打开 `/`，几秒内能看出三件事：有什么要我处理（顶栏数字和抽屉）、谁在干什么（Office 或成员状态）、怎么下达新目标（发起入口）。
2. 发消息、@ 一人或多人、回复、回执、批准或打回交接、会议的再互评 / 定稿 / 批准 / 打回 / 取消、回答问题、停止 run、释放身份：全部能在新页面完成，行为和 `/v1` 一致。
3. 「待你处理」抽屉里能直接完成审批，失败时显示错误，危险操作有确认。
4. 切换视图不丢草稿、不丢滚动位置、不发请求；后台刷新不打断正在输入的框。
5. 手机宽度（375px）下没有横向滚动，从「待你处理」到点下批准按钮不用滚动很远。
6. Office 上的每个状态都能在 `evidence` 里找到出处；`unknown` 或 `stale` 没有动效。
7. `/v1` 和 `/classic` 仍然可用。
8. typecheck、build、smoke 全部通过。服务端只做了增量修改，没有改状态机、门铃或表结构。

## 4. 交接

- 建议分几次提交，便于审查：① 服务端 `inbox` / `activity` + smoke；② 前端拆模块、`/v1` 回退；③ Chat 和抽屉；④ Meeting；⑤ Office 和文档。
- `submit_handoff` 里写清楚：
  - 改了哪些文件；
  - 每条验收标准**怎么验证的**，哪些在开发守护进程的浏览器里亲自点过，哪些没验证（例如手机宽度只用窗口缩放看过）；
  - 和本文档有出入的设计决定，以及原因；
  - 发现但没在本次处理的问题。
- 遇到需要用户决定的事，用 `ask_human`，不要停下来等，先做别的部分。
