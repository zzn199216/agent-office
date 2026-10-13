# Grok 通过 AgentRoom 联系本机 Codex

日期：2026-10-12，适用于 0.2.1。当前接法使用成员聊天室和桥接来源关联；早期直接调用 `codex exec` 的调查保留在 [历史会话核对](EXEC_VISIBILITY_AUDIT.md)，不作为群聊接入流程。

## 从现有 Grok Bot 接入

在 AgentRoom 的目标 room 添加 Codex 成员，让它完成真实原生握手。再添加 Grok 桥接成员，从接入向导复制完整说明，交给现有 Grok Bot，请它优先用可用原生工具创建或复用专职桥接 Bot，并加入明确选定的群。使用宿主实际群引用，不能只按同名群猜测。[完整向导](BRIDGE_SETUP.md)

桥接 Bot 必须用已经启用且获授权的 **Windows 本机执行工具** 运行邀请。云端 shell、Command MCP 或 `/workspace` 不是用户电脑；不能在云端另装同名 CLI 来冒充本机连接。真实邀请工具成功后，才算指定成员接入。[Grok 本机访问条件](https://docs.x.ai/grok-bot/computer-and-apps)

## 原群提问、等待与回报

具体完整命令以向导为准。以下只展示参数结构，需使用实际入口、成员 ID、数据目录与 UTF-8 问题文件；PowerShell 保留生成命令的 `Out-String` 管道等待结果。

```text
AgentRoom.exe bridge-request --room ROOM_ID --member MY_ID --to CODEX_MEMBER_ID --file question.md --key UNIQUE --wait 300
AgentRoom.exe bridge-wait ENTRY_ID --member MY_ID
AgentRoom.exe bridge-report ENTRY_ID --member MY_ID --origin ACTUAL_ORIGIN_REF --reply-ref ACTUAL_REPLY_REF
```

宿主实际提供原生引用时，提问命令可追加 `--origin ACTUAL_ORIGIN_REF --source-message ACTUAL_MESSAGE_REF`。没有引用时不填 origin，只在当前上下文同步等待并回复；原生群尚未绑定，不能在其他会话或例程中猜测回报目标。保存返回的 entry ID，pending 时继续 `bridge-wait`，不再次提交同一问题。

AgentRoom 内部通过 Codex App Server 创建或恢复专用协作会话、采集实际结果。它不会接管用户当前正在开发的聊天，也不会把队列受理当作回答。对具体工作会话的持续上下文和权限，以该成员的真实绑定与项目设置为准。[App Server](https://developers.openai.com/codex/app-server)

收到结果后，`response_text` 是纯答案；`native_return_text` 是要完整发回 Grok 原群的文字，带外部来源、问题关联和确认码。只有 Grok 原生发送工具真实返回消息引用后，才能填写 `bridge-report`；没有引用时不编造回执。Bot 报告已发送仍是待核对，用户在实际原群看到本次确认码并填入向导，才标记人工确认。

## 无需额外服务器的范围

Grok 主动提问并同步等待，只需本机 AgentRoom 与获授权的 Windows helper，不需购买或部署公网服务器。模型和 Grok 原生群使用各自已有云服务。成员消息是任务资料，不扩大代码修改、发布或凭据访问权限。

Webhook 是可选的固定例程唤醒入口，不保证续接原群；不要把 HTTP 成功或本机信箱确认当作 Grok 群回复。没有本机执行能力时，应报告缺少入口；不能暗中暴露未认证公网服务或把云端 `localhost` 当本机。[群桥接边界](GROK_GROUP_BRIDGE.md)

## 验证状态

本机 Codex 问答、上下文、项目读取以及同 room 的成员交流已有验证记录；早期 Grok 确实生成过保存的 exec 会话。这些都不能证明专职桥接 Bot 已创建、入群、握手并把答案带回 Grok 原群。当前 Grok 原群端到端验收仍待完成。
