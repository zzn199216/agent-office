# AgentRoom 后台交互约束与检查结果

2026 年 10 月 11 日，Asia/Taipei。

用户要求后台交流：不切换窗口、不模拟点击或输入、不占用鼠标键盘。此前界面方式的尝试被用户停止，尚未发送测试消息；它不作为本项目的接入方案。

## 后台检查

- Grok Bot 有 9 个运行进程，本轮未发现这些进程拥有 TCP 监听端口。这不能排除云端接口、命名管道或其他进程提供服务。
- 当前会话可用工具中没有 Grok Bot 连接器。插件检索未返回匹配的 Grok 集成；检索结果不是完整目录。
- 当前进程和用户环境中，六个已知 Webhook/Bridge 配置变量均未设置；未读取账号密钥、登录令牌或浏览器资料。
- 安装包版本为 `0.68.1`。静态查看本地 coordinator 文件发现 `sendPrompt`、`createAgent`、`sessionId` 及自动化命令。这是内部实现证据，不是经过验证的外部 API。

已检查的变量名：`CURSOR_WEBHOOK_URL`、`CURSOR_WEBHOOK_API_KEY`、`GROK_BOT_WEBHOOK_URL`、`GROK_BOT_WEBHOOK_KEY`、`GROKBOT_BRIDGE_URL`、`GROKBOT_BRIDGE_API_KEY`。未设置不证明账号内没有 Routine。

## 接入优先级

1. 已配置的 Grok Routine Webhook，配合受认证的回调或结果查询。
2. 已配置的 Grok MCP bridge，通过请求 ID 获取异步回答。
3. 内部会话协议仅作为进一步兼容性调研项；需明确可调用入口、认证方法和实际格式后才评估，不猜测端点或提取登录状态来替代正式配置。

Grok 官方确认 Routine 支持 Webhook URL/key 及请求正文：[更新说明](https://x.ai/changelog/bot)。[现成 Bridge](https://github.com/kinopeee/grokbot-mcp-bridge)提供异步调用和回调参考。普通 Grok 模型 API 的回复，不算当前 Grok Bot 的回复。

## 连通测试标准

向已登记 Bot 的后台入口发送一次纯文本测试标识，记录受理状态。随后读取与该请求 ID 对应的实际回答。重复标识必须去重，不触发运营、发布、配置修改或代码执行。

接口返回 2xx 只能证明受理；返回同一请求 ID 的实际 Bot 回答才能证明收发。若要求回原对话，再额外核对来源会话引用和原任务记录。

初始检查时目标 Bot 尚未配置 Webhook。用户随后建立例程并填写本地 URL/key，已完成一次真实后台测试。

## 后台收发实测

- HTTPS POST 返回 HTTP 200、`success: true` 和运行 ID。
- 从已安装 Grok 的本地 transcript replica 缓存只读定位到 `send-message` 回复，正文同时包含本次 request ID 和唯一标识。
- 发送和读取均没有切换窗口、点击、模拟键鼠或通过 UI 读取消息。
- Bot 回复明确表示例程只做摘要，没有执行 payload 中的指令。后台消息能送达并产生回复；按问题回答的工作流尚未配置验证。
- 本轮没有回调地址。读取本地缓存是一次实测的观察方法，不是稳定的生产结果 API；不能据此宣称跨机器回调或任意原生对话续接已实现。

测试标识：`AGENTROOM-BACKGROUND-FA59EDDB3A47`。完整无凭据证据见 [测试记录](evidence/webhook-test-fa59eddb3a47.json)。下一步是把 Routine 设定为明确的文本问答接收者，并建立受认证的回调或结果查询通道。
