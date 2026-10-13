# Grok 群聊与 AgentRoom 桥接 Bot

日期：2026-10-12。本文对应 0.3.0 的桥接接入流程，**不是已经完成的 Grok 群聊端到端验收记录**。字段、命令、参数以及长期入口路径以界面当前生成的接入说明为准；简明操作见 [接入向导](BRIDGE_SETUP.md)。

## 我们要实现的体验

用户继续在 Grok 的原生群聊里安排工作。群内的原生 Grok Bots 可以直接协作；一个名为 **AgentRoom桥接Bot** 的原生 Bot 负责联系本机 AgentRoom 里的 Codex、Claude Code 或其他外部成员。

外部成员的答案由桥接 Bot 带着来源标记发回当前群。例如它可以写明“来自 Codex · 项目开发会话”，并保留问题与回答的对应关系。外部成员不是 Grok 原生账号，也不会因接入 AgentRoom 而自动出现在 Grok 的原生成员列表中。

## 最小操作流程

1. **在 AgentRoom 准备对应 room。** 添加需要的外部成员，再添加“Grok 桥接 Bot”成员，打开它的接入向导。
2. **把完整接入请求交给现有 Grok Bot。** 由它优先使用可用的原生工具，创建或复用“AgentRoom桥接Bot”，把规则和长期恢复入口说明交给它。现有 Bot 代建属于 Grok 自身能力，不能据此假定存在供 AgentRoom 调用的创建 Bot REST API。
3. **明确选定原群。** 通过 Grok 实际 `@` 引用群，或在目标群发出请求，让 Grok 将桥接 Bot 与所需原生 Bots 放进这个群。仅群名不能唯一定位。原生工具缺失或需批准时，让它指出那个最小步骤，完成后继续，不重复创建 Bot。
4. **使用获授权的 Windows 本机入口完成接入。** 按生成的说明运行 `enter --entry ENTRY_FILE`，确认调用位置是用户 Windows。后续命令继续带同一入口文件，校验实例、房间和成员；配置保存和进程存在不代替真实接入。
5. **在原群发起一次只读问题。** 点名桥接 Bot，在正文指定 AgentRoom 的外部成员。桥接 Bot 用 `bridge-request` 提交，保存 entry ID；pending 时用 `bridge-wait` 继续等待，不能重复提交。
6. **把实际结果带回原群并核对。** `response_text` 是纯答案，`native_return_text` 是桥接 Bot 完整复制回原群的文本，包含来源和确认码。原生发送工具真的返回消息引用后，才能用 `bridge-report` 记录。用户在实际原群看到匹配确认码后，在向导填写，才完成原群人工确认。

关键路由是：**Grok 原群 → 原生桥接 Bot → 获授权的 Windows helper → 本地 room 的外部成员 → 桥接 Bot → 原群**。同时从多个群发起请求时，必须保留各自的来源关联，避免把甲群的结果发到乙群；不能只使用一个全局“最后打开的群”。

## 来源关联与 CLI

下列是参数结构；使用向导生成的完整入口、数据目录和身份，不把示例值作为实际引用：

```text
AgentRoom.exe enter --entry ENTRY_FILE
AgentRoom.exe bridge-request --entry ENTRY_FILE --room ROOM_ID --member MY_ID --to PEER_ID --file question.md --key UNIQUE --wait 300
AgentRoom.exe bridge-wait ENTRY_ID --entry ENTRY_FILE --member MY_ID
AgentRoom.exe bridge-report ENTRY_ID --entry ENTRY_FILE --member MY_ID --origin ACTUAL_ORIGIN_REF --reply-ref ACTUAL_REPLY_REF
```

如果宿主确实提供定位值，首个命令追加 `--origin ACTUAL_ORIGIN_REF --source-message ACTUAL_MESSAGE_REF`。没有原生引用时不填 origin，只在当前上下文同步等待并回复；此时原群未绑定，禁止在另一个会话或例程里猜测群目标。中文问题使用 UTF-8 文件；PowerShell 保留生成命令的 `Out-String` 管道，领取真实 JSON。

`bridge-report` 是桥接 Bot 对原生工具结果的记录，不是 AgentRoom 独立读取 Grok 的证据。原生工具没有返回引用或明确失败时，不捏造 `--reply-ref`，不报告发送成功。Bot 自报回执、Webhook 受理和本机领取确认都不会替代用户在原群看到确认码后的核对。

## 房间离线与成员在线是两回事

聊天室本身是本机 SQLite 状态机。网页、MCP 或服务断连后，消息、成员身份与会话关联仍在。0.3.0 默认固定目录是 `%USERPROFILE%\.agentroom`；已有实例按长期入口的真实数据目录定位，避免桌面工具虚拟化 `%LOCALAPPDATA%` 而进入另一份空库。

任意获授权的本机 agent 可以用 `room-state --entry ENTRY_FILE --offline` 仅读磁盘状态，用 `room-ensure --entry ENTRY_FILE` 恢复原处理服务。长期入口不因服务重启过期；用户撤销或成员离开会阻止继续接入。不要以新的短期邀请或同名新房间代替原实例恢复。

状态中分别记录成员验证、最近心跳、后台进程与可唤醒能力。心跳有效期内的联络证据不保证任意原生窗口一直工作。`wake --entry ENTRY_FILE --to PEER_ID` 仅适用于已适配的后台工具，例如 Codex；没有适配器的 Grok 或 Claude 等需要在各自窗口主动进入，或使用已授权的外部通知。状态机保存待办和结果，不会凭空唤醒不存在的进程。

## 官方已确认的能力与边界

Grok 支持创建原生 Bot，也允许现有 Bot 创建专职 Bot。Bot 有持续的角色和自己的会话，能通过群聊、私聊和共享文件传递上下文。[Create and manage Bots](https://docs.x.ai/grok-bot/bots)

原生群创建时可以选择 2–6 个 Bots，成员可以后续编辑；Bot 可以异步向另一 Bot 发消息，接收方会唤醒处理并稍后回报。这说明原生协作入口存在，尚不能证明我们能从外部程序直接创建群、邀请外部账号或操作已有群会话。[Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)

官方说明支持自定义 MCP 的 Remote HTTPS 与 Command 接法。**Command 运行在对应会话使用的 Grok Bot computer 上，不应默认理解为这台 Windows 电脑。** 需要 Windows 本机能力时，必须核实调用的是获授权的本机执行入口；不能把云端的 `localhost` 指向用户电脑。若使用 Remote HTTPS，则必须具备从云端可达的服务地址与认证，纯本机监听地址本身不够。[Team Bots — Plugins](https://docs.x.ai/grok-bot/team-bots#plugins)、[Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)

Webhook 可以触发一个固定例程，并将请求 body 交给 Bot；它提供唤醒入口，**没有证明能任意选定原 group 续接，也没有提供通用读取答案接口**。若以后用于外部成员主动通知，需要额外验收例程与指定群的绑定以及回报行为。[Grok Bot Changelog](https://x.ai/changelog/bot)

本次检查的官方 OpenAPI 没有 Bot、group、conversation 或 routine 管理路径。`/v1/responses` 等模型推理接口不能当作 Grok Bot 原生聊天管理接口。当前未找到公开的外部 `createBot / addToGroup / getConversationId / sendMessage` 合同；这是已查文档的结论，不代表断言厂商不存在内部实现。[OpenAPI specification](https://docs.x.ai/openapi.json)、[Official documentation index](https://docs.x.ai/llms.txt)

## 当前验收状态

本机可执行文件 metadata 显示 Grok Bot 0.68.1，与本次查到的官方 Changelog 最新版本一致；具体账号的功能开放、权限、插件加载以及群聊工具仍需实测，不能仅凭版本号认定可用。

上述流程尚未完成以下真实验收：桥接 Bot 创建及入群、Windows helper 获授权运行、真实身份握手、群问题送达指定外部会话、外部结果返回原群，以及多群并发不串线。既有的 Webhook HTTP 接收成功不覆盖这些项目。

首次验收应只用一个群、一个桥接 Bot、一个外部成员与一条带唯一校验值的只读问题。确认真实问答闭环后，再验证忙碌、离线、超时和并发群聊。全程使用原生工具和获授权的本机 helper，不通过模拟键鼠、桌面窗口切换或读取私有聊天缓存完成通信。
