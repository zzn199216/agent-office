# 豆包桌面连接器接入指南与能力边界

核查日期：2026-10-13。本文把豆包本人窗口的协作入口与火山方舟 API 分开。未使用 computer use、豆包私有接口、聊天数据库、Cookies、用户令牌或实际模型调用。文中“准备配置”不表示本机豆包已经完成导入或问答。

## 本次适配的目标

Agent Office 为用户点选的豆包成员准备长期入口和原生连接器字段，用户在豆包原生设置保存一次，在豆包自己的对话中真实调用工具后成为可协作成员。收件和回复使用 MCP 消息信箱；发现 `Doubao.exe`、生成材料和打开窗口都不能证明模型在线，更不能证明后台自动回答。

建议候选展示名为 **豆包桌面 · 本人窗口协作**，保留已有 provider ID `doubao`。能力声明应为 `adapter: mailbox`、`automatic_launch: false`、`mcp_install: false`、`mcp_prepare: true`、`attach_existing: false`。`native_group_proxy: true` 仅表示可以准备 Grok 代理角色；实际原生 Bot 创建和加群仍须 Grok 真实工具回报。

准备后为 `awaiting_import`；导入后仍等待本人窗口 MCP 握手；只有绑定成员的真实 `agentroom_room_ensure` 和 `agentroom_heartbeat` 成功才显示消息信箱已接入。`can_wake` 始终是 `false`，不能把这个成员自动替换为其他 CLI 或 API 身份。

## 官方证据与当前限制

本机安装资源是豆包 **2.31.4 release**，位于 `W:\ProgramData\Doubao\app`。产品版本来自 `manifest.json`，EXE 文件版本不是产品版本。

资源 `local_webcontents\extensions\ai-views\static\js\91066.js` 明确包含“新建自定义连接器”“自定义连接器仅支持在本地电脑中使用”、服务器名称、传输类型、服务器 URL、自定义 Headers、命令、参数及环境变量等表单文案。详细字符串键和资源指纹见 [只读资源核查](DOUBAO_DESKTOP_RESEARCH.md)。这证明安装包有个人连接器设计，不能独立证明当前账号的入口、灰度开关或传输选择已启用。

同包 `async\72221.js` 和 `async\s1-mcp-app-node.js` 的通用资源模型含 `STREAMABLE_HTTP`、`SSE_HTTP`、`STDIO`。它还区分 `Local_PC`、`Cloud_VM`、installed、connected、enabled、authorization_required 及 environment_not_ready。**通用模型的三种枚举不是个人新增表单一定支持三种协议的合同。** 此次重新核查仍未定位到个人表单允许协议的完整实现。

[豆包开放平台](https://open.doubao.com/) 的公开页面和[官方前端静态文件](https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/flow/open_platform/static/js/main.741f61f072.js) 介绍 Skill、Plugin 和 OpenAPI；Plugin 可组合 Skill、MCP、CLI。页面仍提示内测和提交入驻意向。官方页面链接到[插件接入指南](https://open.doubao.com/document/doubao-developer-guide/plugin-integration-guide)，但本次匿名读取其正文得到“没有权限”（code 41410），没有尝试登录或绕过权限。因此这份开发者插件文档不能当作已验证的消费者个人 MCP 自动注册合同。

截至核查时，没有确认面向消费者的公共 MCP 注册 CLI、配置文件写入合同或导入深链接。不要猜测 `mcpServers` 用户文件、操作随包内部桥接，或把第三方 `doubao-cli` 当官方接入。后续官方公开合同出现后，再添加真正的一键导入。

## 在豆包原生页面填写的材料

在豆包技能/连接器或插件管理中寻找“新建自定义连接器”。不同版本名称可能变化；当前机器未操作界面，因此不把固定点击路径当作已经验收的事实。选择可使用本机工具的 **本地电脑** 运行环境。

Agent Office 的接入向导应提供逐字段复制按钮，默认准备标准 **Streamable HTTP** 本机入口：

| 豆包字段 | Agent Office 提供的值 |
| --- | --- |
| 服务器名称 | `Agent Office`，或用户自己的协作入口名称 |
| 传输类型 | 若个人表单提供 `HTTP`，选择对应 Streamable HTTP；不能选旧版 SSE 来替代 |
| 服务器 URL | 当前所选成员的本机 URL，由软件生成，形如 `http://127.0.0.1:47831/mcp/<credential_id>/<secret>` |
| 自定义 Headers | 留空；当前 Agent Office 入口使用 URL 中的成员凭据鉴权，不要求额外 Bearer |

URL 只在受保护的本机接入面板和材料文件中提供，不能出现在公共状态接口、日志、截图或发给外部 Bot 的提示词。示例占位符不可直接连接；旧用户聊天里分享过的其他软件 Authorization 标头也不能用于此入口。

生成的材料可以使用结构化 JSON 保存以上字段，方便逐项复制，但它是 **Agent Office 自己的导入材料**，不是声称豆包原生支持 `mcpServers` JSON 自动导入。若个人表单不提供 HTTP、拒绝 localhost 或要求 HTTPS，界面应报告这一具体阻碍，不能自动开公网隧道或假装连接成功。

HTTP 入口要求 Agent Office 的本机服务正在运行。服务停止时豆包无法通过这个 URL 冷启动它；用户启动 Agent Office 后连接可重试。若本人的原生表单实际提供 **STDIO**，可以另外填写本机长期入口中的 command 和 args：

```text
命令：Agent Office 向导显示的稳定本机 EXE 绝对路径
参数：mcp
      --entry
      当前豆包成员的长期入口文件绝对路径
环境变量：留空
```

每个参数各一项。开发版需保留向导给出的 Node 前置参数；不要把一串 PowerShell 命令放进“命令”字段。STDIO 只有在用户实际看到该传输选择并成功调用工具后才算豆包支持；它的服务启动能力也不表示能唤醒豆包模型。

## 授权和真实接入验收

1. 用户在豆包原生设置保存并启用连接器。如果提示本地电脑未初始化，按豆包原生流程初始化；如果提示需要授权、重新授权或权限确认，由本人完成。Agent Office 不代取豆包账户凭据。
2. 在豆包本人对话中选中该连接器，发送下面的无凭据提示词。若看不到工具，就明确回报缺少的入口或失败步骤。
3. 软件根据绑定成员的真实工具调用验收；入口文件、用户口头确认和进程存在不替代握手。

```text
使用我已经添加的 Agent Office 连接器完成接入。
实际调用 agentroom_room_ensure，然后调用 agentroom_heartbeat。
两次调用成功后，调用 agentroom_chat_inbox 查看发给本人的问题。
有问题就处理，并用 agentroom_chat_reply 回复对应消息。
不要使用其他 AI 的身份，也不要仅用文字宣称接入成功。
如果没有这些工具，告诉我具体缺少哪一步。
```

配置成功只代表工具入口可用。群里发给豆包的问题会持久化到本人信箱；豆包需要在自己的窗口领取和回复，后台唤醒尚无已验证入口。Grok 的豆包代理必须保持这一说明，pending 请求继续等待同一 request_id，不能换模型冒名回答。

## 独立的豆包 API 后台成员

豆包 API 是另一条已公开的官方路径，可作为独立的 **豆包 API · 火山方舟** 成员设计，不能继承豆包桌面成员 ID、原生聊天、登录或对话上下文。

[方舟快速入门](https://docs.volcengine.com/docs/ark/quick-start?lang=zh) 明确说明获取方舟 API Key、配置 `ARK_API_KEY`、开通模型服务，并展示官方 SDK 和 OpenAI SDK。模型入口基础 URL 是 `https://ark.cn-beijing.volces.com/api/v3`；模型 ID 使用用户已开通模型的准确 ID或推理接入点，不能固定猜测一个名称。

[方舟 ChatCompletions API Explorer](https://api.volcengine.com/api-explorer/?action=ChatCompletions&groupName=%E5%AF%B9%E8%AF%9D%28Chat%29+API&serviceCode=ark&tab=2&version=2024-01-01) 给出 `POST /api/v3/chat/completions` 合同；[官方上下文管理指南](https://docs.volcengine.com/docs/ark/context-management?lang=zh) 提供 OpenAI SDK 的多轮 messages 示例。未来实现可直接从本机后台发 HTTP 请求，持久化这个独立成员的会话，凭据放本机配置、不进入公开 DTO。

普通豆包应用登录不等于已取得方舟 API Key 或模型服务权限。此适配使用在线模型服务，不能宣传为模型离线运行，也不能承诺豆包免费账号自动拥有 API 配额。发现环境变量或配置只表示材料存在，须实际成功问答才可验证后台能力；本轮未进行这类调用或开通收费服务。

[豆包助手 API 官方文档](https://docs.volcengine.com/docs/ark/doubao-assistant?lang=zh) 是扩展豆包能力的另一类 API，官方说明其可能需要测试资格和额外开通。本次基础协作不依赖该内测工具，也不因为集成 API 宣称为豆包官方合作产品。

## 面向实现的验收清单

- 扫描只在用户发起时发生；只准备用户选中的豆包，不自动添加其他进程。
- 重复点击复用同一房间、桌面成员和通信入口，不产生多个身份。
- 默认 HTTP 材料只允许回环地址；URL 凭据不进入公共状态、错误日志或外部提示词。
- 设置保存、工具可用、成员握手、真实问答与 Grok 原生入群分别记录。
- 无本人握手时 `local_verified: false`；桌面消息信箱握手后仍 `can_wake: false`。
- HTTP 服务离线时说明启动 Agent Office；不通过电脑操作、私有通信或公网隧道补足能力。
- 独立 API 成员和桌面成员的身份、认证、会话与后台能力分开。
