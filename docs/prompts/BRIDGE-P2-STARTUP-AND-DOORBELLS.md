# 任务：P2，一键加入（斜杠命令）和门铃加固

> 交给 Codex 执行，Claude 审查。和 `docs/prompts/UI-REFACTOR-P1.md` 一样，通过协作桥运行。
> 目标版本 0.8.0。分成两部分：A 减少用户粘贴启动提示词；B 应对「依赖 AI 产品内部实现」的风险。

## 0. 先读

1. `AGENTS.md`，以及 `docs/ARCHITECTURE-v2.md` 第 4、14、15、18、20 节。
2. 代码：
   - MCP 和启动：`src/mcp.ts`（McpServer，工具注册）、`bin/bridge-mcp.mjs`（stdio 转接程序，底层 `Server`，目前只声明了 `tools` 能力）
   - 安装与体检：`src/cli.ts`（setup / uninstall / doctor，GitHub 版本比较在 `git ls-remote` 附近）、`src/products/{claude,codex,types}.ts`
   - 门铃：`src/doorbells/*`、`bin/codex-stop-hook.mjs`
3. 现在的启动提示词在 `docs/USAGE.md` 第 3 节。

## 1. 禁区（用协作桥改协作桥）

在 P1 的禁区之上，这次还会碰到用户的真实配置，所以多了几条：

- 不运行 `npm run reinstall`、`ai-bridge update`，也不要停止或重启 7878 端口上的守护进程；不读写 `.bridge/`。
- **不要对真实的 `~/.claude`、`~/.claude.json`、`~/.codex` 运行 `setup` 或 `uninstall`。** 测试 setup、uninstall、doctor 时，把 `USERPROFILE` 和 `HOME` 都指向一个临时目录（Windows 上 `os.homedir()` 读的是 `USERPROFILE`），或者用 `--dry-run`。CLAUDE.md 里写过：setup 和 uninstall 还会清理 Codex 配置里列出的真实项目目录下的 `.codex/hooks.json`，所以临时目录里的 Codex 配置不能列出真实项目。smoke 里的相关测试也必须这样隔离。
- 探针（第 B2 节）必须只读：**不能运行 `codex queue`，也不能往 Claude 消息套接字写任何东西。** 一旦写了，就会叫醒用户真实的对话。
- 要预览面板，仍然用 7879 端口加一个临时 git 仓库来起开发守护进程。

## 2. 背景：各产品能用的斜杠命令（2026-11 调研，需要你在本机复核）

| 方式 | Claude 终端版（CLI） | Claude 桌面版（Code 标签页） | Codex（ChatGPT 桌面版） |
|---|---|---|---|
| MCP prompts → `/mcp__bridge__<名字>` | 支持（官方文档） | **有一个未解决的 issue 说不显示** | 不支持（openai/codex#8342 还是功能请求） |
| 用户级 skill 文件 | `~/.claude/skills/<名字>/SKILL.md`，输入 `/<名字>` 调用 | 同左 | `~/.codex/skills/<名字>/SKILL.md`（用户机器上这个目录已经存在，里面有别的 skill），用 `$<名字>` 或 `/skills` 调用 |

结论：**两条路都做。** MCP prompts 是标准做法，以后哪个产品支持了就能直接用；skill 文件现在在两边都能用。

## 3. A：一键加入

### A1. MCP prompts

- 在 `src/mcp.ts` 里用 `registerPrompt` 注册两个 prompt：
  - `join`：可选参数 `agent_id`。返回的用户消息就是现在 USAGE.md 里的启动提示词（「你是 AI 协作桥中的 X。调用 bridge 的 join……」）。不传 `agent_id` 时，正文写成「调用 join，不填 agent_id」，由下面的 A2 推断。
  - `inbox`：「调用 bridge 的 fetch_inbox，按返回内容继续工作」，叫不醒时用户可以用它代替手打「继续」。
- `bin/bridge-mcp.mjs` 要声明 `prompts` 能力，并把 `prompts/list`、`prompts/get` 转发给守护进程。守护进程没连上时，返回一个能说明原因的错误。
- `McpServer` 的版本号现在硬编码成 `"0.6.0"`，改为读 `package.json`。

### A2. 不填 `agent_id` 也能 join

- 转接程序在每个请求的 header 里带上上游客户端的信息：`x-bridge-client: <initialize 时的 clientInfo.name>`，再加上它已经知道的产品线索（有 Claude 消息套接字就说明是 Claude）。
- `join` 的 `agent_id` 改为可选。不填时，按产品线索在 `bridge.config.yaml` 的 `agents` 里找 `product` 匹配的成员：**正好一个就用它；零个或多个就返回错误，列出可选的 agent_id**，不要猜。
- 找到的成员如果已经被别的会话占用，沿用现有的 `bindingError` 说明，不要自动 takeover。
- 先查清楚两边的 `clientInfo.name` 实际是什么：从守护进程的 `mcp_session_open` 日志里看（日志在守护进程自己的输出里，**不在** `.bridge/`。不确定的话就让转接程序在测试实例里打印一次），然后写进架构文档。

### A3. setup 安装 skill 文件

- 新增两个 skill，名字都叫 `bridge`，内容是简短的说明加启动步骤：
  - Claude：`~/.claude/skills/bridge/SKILL.md`。frontmatter 里设置 `disable-model-invocation: true`，只在用户输入 `/bridge` 时调用，避免模型在无关对话里自己加入。字段名请查 Claude Code 文档确认。
  - Codex：`~/.codex/skills/bridge/SKILL.md`。description 写明「只在用户明确要求加入协作桥时使用」。查一下 Codex 有没有类似「仅限用户调用」的字段，有就用上。
- skill 正文：调用 bridge 的 join（不填 agent_id，失败就按错误里的候选问用户），然后按返回的 protocol 工作，交接和汇报用中文。
- 遵守现有规则：
  - `setup`：两个产品都装。每个文件都识别是不是协作桥的（例如带一个 `ai-bridge` 标记），**不覆盖用户自己写的同名 skill**，写之前备份。
  - `setup --refresh`：**只更新已经存在的、协作桥装的那份。** 对应产品的 bridge MCP 配置不存在时，不新增 skill（用户删掉 Codex 的 bridge 配置是有意的，绝不能加回去）。
  - `uninstall`：只删除协作桥装的那份。
  - `doctor`：检查两个 skill 是否存在、是否最新。
- 更新 `docs/USAGE.md` 第 3 节：首选 `/bridge`（Claude）和 `$bridge`（Codex），MCP prompt 作为备选，原来的粘贴文本留作兜底。斜杠命令在两个桌面版里还没实测，USAGE 里要如实写「待验证」。

## 4. B：门铃加固

### B1. 版本门控

- `ProductProfile` 增加 `detectVersion()` 和 `verifiedVersions`（已验证过的版本前缀列表）。
  - Codex：从选中的 `codex.exe` 所在的 releases 目录名取版本（例如 `0.171.0-…`），或者运行 `codex --version`，只读，不排队。目前已验证：0.170（第 15 节）。运行 #1 期间 `codex queue` 成功过多次，当时装的很可能是 0.171：请用 releases 目录的修改时间确认，确认了才加进列表。
  - Claude 桌面版：找一个只读的版本来源（环境变量、进程可执行文件的版本信息等）。**找不到就返回 `unknown`，不要报错。**
- 只提示，不阻止：版本不在已验证列表里时，`doctor` 显示一条黄色提示「未验证的版本，门铃可能失效」；面板的成员详情里也显示（数据放在 `snapshot().agents[].product`，增量字段）。

### B2. `ai-bridge doctor --probe`：只读探针

产品升级后跑一次，逐项给出 ✓ / ✗ / ·：

- `codex --help` 或 `codex queue --help` 的输出里还有 `--thread` 和 `--message`；
- `~/.codex/queue_1.sqlite` 能以只读方式打开，`queued_items` 表还有 `thread_id` 列；
- 找到最近修改的一份 Codex 会话记录（位置参考 Stop hook 收到的 `transcript_path`，在 `~/.codex` 下面），用 `codex-stop-hook.mjs` 里**同一份**解析逻辑解析。先把它抽成一个可以共享的模块。能解析出 `McpToolCall` 结构算 ✓；文件里有 bridge 的 join 却解析不出来，算 ✗，并提示「会话记录格式可能变了」；找不到会话记录算 ·；
- Claude：消息套接字只能在 Claude 启动的进程里看到，所以由转接程序在 join 时报告「是否有 `CLAUDE_CODE_MESSAGING_SOCKET`，管道是否存在」。探针从运行中的守护进程的 `/api/state` 读这个结果，守护进程没在运行就显示 ·。

### B3. 格式漂移检测

只读路径失败时，不能再静默降级：

- Stop hook：会话记录里有 bridge 的 join 字样，但解析不出完整的 `McpToolCall`，就上报 `POST /api/agents/:id/endpoint` 的同源接口或一个新的诊断接口（你来选，写进文档），记一条 `drift` 事件，事件里带产品和版本。
- codex-queue 的 `pending()`：数据库存在但查询失败（表或列不对），记一次 `drift` 事件（守护进程每次运行只记一次），然后照旧选择「排队」。
- claude-socket：沿用现有的 `/api/doorbell/result` 报错。
- 面板：`drift` 显示在成员详情的诊断区；`inbox` 增加 `kind: "diagnostic"`，urgency 为 normal，内容是「X 的 Y 格式可能变了，运行 ai-bridge doctor --probe」。

### B4. 唤醒成功率和统一降级

- 在 `Doorbells` 注册表（不是某一个驱动里）为每个「成员 × 门铃」统计：按铃次数、确认醒来次数、确认失败次数、最近一次结果。放在内存里就行，不加表。
- 统一规则：`verify` 类门铃连续 N 次（默认 3，可以放进配置）没能确认醒来，就在这个成员的门铃链里降级 10 分钟。codex-queue 现有的 `failedAt` 冷却并入这套规则，或者保留但走同一个出口。降级和恢复各记一条事件。
- 统计数据放进 `snapshot().agents[].doorbellStats`。Office 的 `unreachable` 和成员详情的 evidence 引用它（例如「最近 3 次队列叫醒都没确认」）。

### B5. 一键复制叫醒语

- 面板的「叫不醒」卡片（inbox 的 `delivery`）和成员详情里加一个「复制叫醒语」按钮，复制 `$bridge` / `/bridge`、`inbox` prompt，或者一句「[协作桥] 你有新信，调用 fetch_inbox」（按产品选最合适的一种）。用 Clipboard API，失败时退回选中文本让用户自己复制。

### B6. doctor 对 GitHub 版本的判断

- 现在只用 `git ls-remote` 取 main 的 SHA，不一致就提示「运行 ai-bridge update」。本地领先、还没 push 时这是误报：照着做会装回旧版本（2026-11-20 实际出现过）。
- 改为：SHA 不一致时，用 GitHub 的 compare API（`/repos/{owner}/{repo}/compare/{main}...{installed}`，匿名调用，超时 5 秒）判断状态。
  - `ahead`：显示 ·「安装的版本比 GitHub 新（还没推送）」；
  - `behind`：显示 ✗，建议运行 update；
  - `diverged`：显示 ✗，说明情况，**不建议 update**；
  - 查询失败：显示 ·「和 GitHub 不一致，无法判断谁新」，不建议 update。

## 5. 不做

- 不改任务状态机、会议、邮局的投递规则、数据库表结构。
- 不做 ACP worker、剪贴板成员，不做 Office 动效。
- 不加新的叫醒手段（不往别的私有接口里写东西）。

## 6. 验收标准

1. 开发实例里，用 MCP 客户端（smoke 里的测试客户端就可以）通过转接程序调用 `prompts/list` 能看到 `join` 和 `inbox`，`prompts/get` 返回正确的文本。
2. `join` 不填 `agent_id` 时：唯一匹配就加入成功；没有匹配或多个匹配时返回候选列表；已被占用时报现有的占用错误。smoke 覆盖这三种情况。
3. 在隔离的临时 HOME 下：
   - `setup` 装好两个 skill，并备份；
   - 已有一个用户自写的同名 skill 时不覆盖；
   - `setup --refresh` 在没有 Codex bridge 配置时不新增 Codex skill；
   - `uninstall` 只删协作桥装的那份；
   - `doctor` 能反映以上每种状态。
   smoke 或单独的测试脚本要覆盖。**没有碰真实的用户目录。**
4. `doctor --probe` 在本机运行：每一项都有结果，没有叫醒任何对话（可以用 Codex 队列为空、Claude 对话没有收到消息来佐证），输出贴进交接单。
5. 漂移：用伪造的会话记录和伪造的队列数据库（表名不对）分别触发 `drift` 事件和 `diagnostic` 待办；正常格式不触发。smoke 覆盖。
6. 降级：用 smoke 里现有的假门铃模拟连续 3 次没确认，门铃被降级、换下一个，10 分钟后（测试里可以把时间调短）恢复；`doorbellStats` 数字正确。
7. doctor 对 GitHub 的四种状态显示正确（用模拟的 compare 响应测试）。
8. 面板的「复制叫醒语」在开发实例里能用；P1 的全部功能没有回归。
9. `npm run typecheck`、`npm run build`、`npm run smoke` 全部通过；版本号 0.8.0；`ARCHITECTURE-v2.md` 新增第 21 节；`CLAUDE.md` 和 `AGENTS.md` 同步更新；`USAGE.md` 更新。

## 7. 交接

- 建议分几次提交：① MCP prompts + agent_id 推断；② skill 安装（setup / uninstall / doctor）；③ 版本门控 + 探针；④ 漂移检测 + 成功率降级；⑤ 面板和文档。
- 交接单的 `todo` 里**必须**列出只有用户能在真实产品里验证的事情，写成可以照着做的步骤：
  - Claude 桌面版里输入 `/` 能不能看到 `bridge` skill，以及 `mcp__bridge__join`；
  - Codex 桌面版里 `$bridge` 或 `/skills` 能不能调用；
  - 用 `/bridge` 或 `$bridge` 加入后，门铃是否正常。
- 其他要求同 P1：写清楚每条验收标准怎么验证的、哪些没验证；和本文档有出入的设计决定写明原因；需要用户决定的事用 `ask_human`，不要停下来等。
