# ai-bridge · 本地 AI 协作桥

让 Claude 桌面版的 Code 标签页和 ChatGPT 桌面版里的 Codex 通过 MCP 接力完成同一个项目。你可以在本地网页面板上发起任务、审批交接和查看进度。

- **任务接力**：按配置分配角色和阶段，以信件交付任务、用户消息和问题答复。
- **开会与并行**：各 AI 先提案、互评，定稿出带依赖的任务清单；批准后并行分派，用文件租约避免互相改乱，按任务范围提交。
- **空闲唤醒**：有信时通过 Claude 消息套接字或 Codex Stop hook 唤醒对应会话。
- **审批与返工**：从面板批准、打回或回答问题，返工要求会随下一次交接传达。
- **交接记录**：信件状态保存在本地 SQLite，Git 提交记录交接与审查结论。

## 在 Windows 上从 GitHub 安装

需要 Node.js 22.13 或更新版本，以及 Git。在 PowerShell 中运行：

```powershell
git clone https://github.com/vwow521-dotcom/Interaction-ai.git
cd Interaction-ai
npm ci
node bin/ai-bridge.mjs update
ai-bridge setup
ai-bridge doctor
```

`update` 会从 GitHub 取 `main`，在临时目录里构建并打包，再全局安装。克隆下来的这份只用来第一次启动 `update`，之后可以删掉。不要用 `npm install -g github:…`：npm 全局安装 git 包时，构建拿不到依赖，会失败，而且失败时已经删掉了原来的安装。`ai-bridge setup` 会先备份配置，再注册 Claude 和 Codex 的 MCP 服务以及 Codex Stop hook。只用其中一个客户端的话，`setup` 之后把另一个的配置删掉即可，后续更新不会把它加回来。

安装后，在 Codex 的 **Settings > Hooks** 里信任新的 Stop hook，然后在 Claude 和 Codex 里各新开一个对话。

## 保持最新

所有客户端都指向同一个全局安装，所以只需要更新这一处：

```powershell
ai-bridge doctor     # 第一行显示安装自哪个提交，以及是否落后于 GitHub main
ai-bridge update     # 从 GitHub 重新安装，然后只刷新已经配置了 bridge 的客户端
```

`update` 还支持 `--ref <分支|标签|提交>`、`--force` 和 `--dry-run`。更新后要新开对话；如果桥正在运行，需要重新 `ai-bridge start` 一次。运行 `update` 时最好先关掉 Codex，否则 Codex 可能用它内存里的旧配置覆盖 `~/.codex/config.toml`。

## 使用

```powershell
ai-bridge init "E:\某项目"    # 首次使用时生成 bridge.config.yaml，必要时初始化 Git 仓库
ai-bridge start "E:\某项目"   # 启动协作桥
```

在两边的对话里各粘贴一句启动提示词：

```
你是 AI 协作桥中的 claude。调用 bridge 的 join（agent_id = "claude"），然后严格按它返回的 protocol 工作。交接单和进度汇报用中文。
```

Codex 用同一句，把 `claude` 换成 `codex`。两边加入后，在浏览器打开 [本地面板](http://127.0.0.1:7878/)，输入项目目标，点「开始（流水线）」按规划 → 编码 → 审查一步步做，或点「开会讨论」先让各个 AI 出方案、定稿任务清单再并行做。

## 卸载 / 重装

```powershell
ai-bridge uninstall          # 移除 setup 添加的全部配置，也会清理旧版的手动配置
npm uninstall -g ai-bridge
```

重装就运行 `ai-bridge update --force`。各项目里的 `.bridge/` 数据和 `bridge.config.yaml` 不受影响。

## 更多

- [使用说明与故障排查](docs/USAGE.md)
- [当前架构](docs/ARCHITECTURE-v2.md)与[设计决策](docs/DESIGN.md)
