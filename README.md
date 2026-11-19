# ai-bridge · 本地 AI 协作桥

让 Claude 桌面版的 Code 标签页和 ChatGPT 桌面版里的 Codex 通过 MCP 接力完成同一个项目。你可以在本地网页面板上发起任务、审批交接和查看进度。

- **任务接力**：按配置分配角色和阶段，以信件交付任务、用户消息和问题答复。
- **空闲唤醒**：有信时通过 Claude 消息套接字或 Codex Stop hook 唤醒对应会话。
- **审批与返工**：从面板批准、打回或回答问题，返工要求会随下一次交接传达。
- **交接记录**：信件状态保存在本地 SQLite，Git 提交记录交接与审查结论。

## 在 Windows 上从源码安装

需要 Node.js 22.13 或更新版本，以及 Git。在 PowerShell 中运行：

```powershell
git clone https://github.com/vwow521-dotcom/Interaction-ai.git
cd Interaction-ai
npm ci
npm pack
npm install -g .\ai-bridge-0.3.0.tgz
ai-bridge setup
ai-bridge doctor
```

`npm pack` 会自动构建，并输出安装包文件名。若版本更新，用它输出的文件名替换示例中的 `ai-bridge-0.3.0.tgz`。`ai-bridge setup` 会先备份配置，再注册 Claude 和 Codex 的 MCP 服务及 Codex Stop hook。

安装后，在 Codex 的 **Settings > Hooks** 里信任新的 Stop hook，然后在 Claude 和 Codex 中各新开一个对话。

## 使用

```powershell
ai-bridge init "E:\某项目"    # 首次使用时生成 bridge.config.yaml，必要时初始化 Git 仓库
ai-bridge start "E:\某项目"   # 启动协作桥
```

在两边的对话里各粘贴一句启动提示词：

```
你是 AI 协作桥中的 claude。调用 bridge 的 join（agent_id = "claude"），然后严格按它返回的 protocol 工作。交接单和进度汇报用中文。
```

Codex 用同一句，把 `claude` 换成 `codex`。两边加入后，在浏览器打开 [本地面板](http://127.0.0.1:7878/)，输入项目目标并开始。

## 卸载 / 重装

```powershell
ai-bridge uninstall          # 移除 setup 添加的全部配置，也会清理旧版的手动配置
npm uninstall -g ai-bridge
```

重装：先 `npm install -g` 新的安装包，再运行一次 `ai-bridge setup`。各项目里的 `.bridge/` 数据和 `bridge.config.yaml` 不受影响。

## 更多

- [使用说明与故障排查](docs/USAGE.md)
- [当前架构](docs/ARCHITECTURE-v2.md)与[设计决策](docs/DESIGN.md)
