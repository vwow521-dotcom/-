# ai-bridge：本地 AI 协作桥

让不同桌面产品里的 AI（Claude 桌面版的 Code 标签页、ChatGPT 桌面版里的 Codex，后续还有 Gemini、DeepSeek 等）按角色流水线接力完成同一个项目。

- 任务、用户消息、问题答复都以**信件**的形式投递。
- AI 空闲时不轮询、不消耗额度，有信时由**门铃**叫醒：Claude 用消息注入，Codex 用 Stop hook。
- 你在本地网页面板上发目标、审批或打回、发消息，查看每封信走到了哪一步。
- 每次交接自动生成一个 git 提交，审查结论也会写进 `git log`。

## 安装

需要 Node.js 22.13 或更新版本，以及 git。

```powershell
npm install -g ai-bridge-<版本>.tgz   # 安装包由 npm pack 生成
ai-bridge setup                       # 配置 Claude 和 Codex（可以反复运行，每次都会先备份配置文件）
ai-bridge doctor                      # 检查配置是否一致、是否最新
```

装好后，在 Codex 的 **Settings > Hooks** 里信任新的 Stop hook，然后 Claude 和 Codex 各新开一个对话。

## 使用

```powershell
ai-bridge init E:\某项目     # 第一次使用某个项目时运行：生成 bridge.config.yaml，没有 git 仓库就初始化一个
ai-bridge start E:\某项目    # 启动桥，面板地址 http://127.0.0.1:7878/
```

在两边的对话里各粘贴一句启动提示词：

```
你是 AI 协作桥中的 claude。调用 bridge 的 join（agent_id = "claude"），然后严格按它返回的 protocol 工作。交接单和进度汇报用中文。
```

Codex 用同一句，把 `claude` 换成 `codex`。

## 卸载 / 重装

```powershell
ai-bridge uninstall          # 移除 setup 添加的全部配置，也会清理旧版的手动配置
npm uninstall -g ai-bridge
```

重装：先 `npm install -g` 新的安装包，再运行一次 `ai-bridge setup`。各项目里的 `.bridge/` 数据和 `bridge.config.yaml` 不受影响。

## 更多

- 日常使用和异常处理：[docs/USAGE.md](docs/USAGE.md)
- 架构与设计决策：`docs/ARCHITECTURE-v2.md`、`docs/DESIGN.md`（源码仓库中）
