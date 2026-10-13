# agent-room-alkl/agent-room 与目标对照

审查日期：2026-10-12。本次为文档与源码只读审查，未安装客户端、执行安装脚本、创建在线房间或改动当前 AgentRoom 配置。

固定源码：主仓 `93ef0d3763de15298b11a69111d1cfb0bea804c4`；关联 MCP 客户端 `95820c512376e3781ecb5816bf553220178af2a7`，源码包版本 0.26.24。公开文件缓存位于 `.local/research/agent-room-alkl`。

## 结论

它实现了“现有跨工具 agent 进入同一个可观察聊天室”的主干。从产品结构看，比之前研究的 Concord 更接近我们的共享聊天室想法。仍缺少我们要求的完整本机部署、已停止会话的通用后台唤醒，以及 Grok 原生群桥接。

| 目标 | 源码/文档检查结果 |
| --- | --- |
| 跨工具或同工具多个会话进入同房间 | 有 join/send/listen、线程隔离、成员名和角色、共享消息协议 |
| 浏览器查看共同讨论 | 有 React 房间界面、房间邀请码、任务/讨论状态和发言模式 |
| 简单安装、Windows | 有自动配置安装器和 PowerShell 入口；仍需重启宿主并让 agent 执行加入。未在本机实测其安装 |
| 检测新打开的聊天，点击添加即接入 | 安装器检测工具/配置目录，不是检测任意已打开的具体聊天；没有发现该完整流程 |
| 停止一轮后，外部消息随时唤醒该原会话 | 持续 listen 和 Stop hook 续轮有实现；未发现任意已停会话的原生控制器唤醒实现 |
| 无自购服务器、协作层在本机 | 使用其当前免费托管可免自购服务器；默认消息仍经过在线 room API 和 Redis，非本机独立聊天室 |
| Grok Bot 原群中桥接外部成员 | 未发现专项适配或创建/加群/回原群实现；远程 MCP 接入是可研究的兼容性路径 |

房间与协作协议主源：[README](https://github.com/agent-room-alkl/agent-room/blob/93ef0d3763de15298b11a69111d1cfb0bea804c4/README.md)、[协议](https://github.com/agent-room-alkl/agent-room/blob/93ef0d3763de15298b11a69111d1cfb0bea804c4/docs/AGENT_ROOM_PROTOCOL.md)。

## 本地安装与本地服务的区别

主仓负责界面、房间协议和存储，`agent-room-mcp` 是另一个仓库，二者经 HTTP 相连。MCP 客户端默认连接 `https://www.agent-room.com`，可用 `AGENT_ROOM_BASE_URL` 指向自托管 API。安装本机包不代表房间状态留在本机。[仓库关系](https://github.com/agent-room-alkl/agent-room/blob/93ef0d3763de15298b11a69111d1cfb0bea804c4/docs/REPOS.md)

默认后端基于 Upstash Redis REST。Postgres 持久模式已有实现，但临时协调仍保留 Redis；未找到独立 SQLite/本地文件后端的一键发行。默认 Redis 房间为24小时行为，长期项目需另外处理持久化。[存储设计](https://github.com/agent-room-alkl/agent-room/blob/93ef0d3763de15298b11a69111d1cfb0bea804c4/docs/durable-room-storage.md)

## 自动回复与真正唤醒的区别

`room_listen` 保持一个待完成的工具调用；消息到来后作为结果进入当前模型轮次。Stop hook 可以在一轮结束边界要求继续 listen，源码有空闲续轮上限。它没有替任意已终止聊天调用原生 turn/start 的守护器。客户端自身的活动房间约定也明确说明：结束后没有东西自动重新启动它。

针对有 gateway 的常驻助手有独立 Webhook 路线，不能扩展为全部桌面工具都支持。[客户端 tools](https://github.com/agent-room-alkl/agent-room-mcp/blob/95820c512376e3781ecb5816bf553220178af2a7/apps/mcp/src/tools.ts)、[hook 源码](https://github.com/agent-room-alkl/agent-room-mcp/blob/95820c512376e3781ecb5816bf553220178af2a7/apps/mcp/src/hook.ts)

## Grok 的可能接法

Grok 官方支持自定义 Remote HTTPS MCP，因此让一个 Grok 原生桥接 Bot 接入它的托管 MCP 并加入房间，在协议层面值得验证。这是兼容性推断，尚未实测；它加入的是该项目的房间，而不是自动把外部 agent 变成 Grok 原生群成员。[Grok 插件支持](https://docs.x.ai/grok-bot/team-bots#plugins)

它的现有 Webhook 使用 HMAC 标头，未发现可配置 Bearer Authorization；不能直接把我们 Grok Routine 的 key 当成其 webhook secret。仍需适配发送认证和原群回报工作流。[实际 Webhook 发送实现](https://github.com/agent-room-alkl/agent-room/blob/93ef0d3763de15298b11a69111d1cfb0bea804c4/api/_webhookDispatch.ts)

## 借鉴建议

优先参考或复用房间协议、成员/角色、邀请、发言管理、客户端配置安装器和界面交互。这些已有实现，不需要为相同部分另起一套。

如果接受在线托管，它值得作为现成聊天室试用。如果继续坚持协作状态本机保存、消息到达时启动处理、以及 Grok 原群桥接，需要保留或补齐这三个部分，不能直接宣布替换当前实现就能完成目标。

当前我们自己的0.2也尚未完成 Grok 原群往返验收；这项缺口不能通过换一个同样没有原群适配的项目自动消失。
