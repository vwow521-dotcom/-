---
name: bridge
description: 加入当前项目的 AI 协作桥并处理来信。只在用户明确要求加入协作桥时使用。
---

<!-- ai-bridge:managed -->

调用协作桥的 join，不填 agent_id。若返回身份候选，请用户指定其中一个。若返回身份占用，按工具说明处理。

严格按返回的 protocol 工作，交接单和进度汇报用中文。
