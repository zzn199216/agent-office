# Grok Bot 后台入口的一次性设置

> 历史调研记录：现在已配置 Webhook 并完成真实触发测试。当前操作流程见 [使用说明](USER_GUIDE.md)，已验证与剩余设置见 [交付状态](IMPLEMENTATION_STATUS.md)。下文记录初次配置前的状态。

2026 年 10 月 11 日。用户已确认当前 Bot 尚未配置 Webhook Routine。

实际后台收发测试依赖这个入口，当前还没有发送消息。AgentRoom 不使用界面自动化代替后台连接。

## 交给 Grok 的设置说明

可以在目标 Grok Bot 自己的聊天中交代以下内容：

> 为这个 Bot 创建一个用于 AgentRoom 与 Codex 通信的 Webhook Routine，只在收到 webhook 请求时运行。测试阶段只处理纯文本连通检查：读取请求中的 request_id 和 message，回复同一个 request_id 及文字回答，不执行代码、不发布内容、不修改其他配置。先不要自动运行其他任务。建立后告诉我 Routine 名称及在哪里查看 Webhook URL 和 key；不要把 key 发到聊天正文。

官方说明支持 webhook 触发及接收请求正文：[Grok Bot 更新说明](https://x.ai/changelog/bot)。当前版本和账户中实际能否建立，以设置结果为准。

## 本地配置

首次调研在工作目录的 `.local/grok-webhook.json` 准备了空配置。把该 Routine 的 URL 和 key 填入本机对应字段。`.local/` 已加入项目忽略规则，不随源码同步；该轮没有填写凭据或读取登录令牌。

Routine 的入口位于 Bot 的对话详情中的 Routines。现成 bridge 文档将相关字段称为 POST URL 和 Key，具体界面以当前版本为准：[字段说明](https://github.com/kinopeee/grokbot-mcp-bridge#0-which-value-goes-where)。

不需要在聊天中提供密钥；只需告诉 Codex 本地配置已经填写。

## 后续后台测试

配置入口后，还需提供能收集回答的回调通路或可读取的运行结果入口。Webhook 返回 HTTP 2xx 不等于 Bot 已回复。测试接收器必须与 Grok 云端实际可达；未验证之前不设置自动运营任务。

第一条消息仅要求回显唯一标识。只有收集到同一 request_id 的实际回答才算收发成功。原生聊天续接另行验收。
