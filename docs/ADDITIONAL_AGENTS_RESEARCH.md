# 其他 Agent 的公开接入合同

核对日期：2026-10-13，对应 Agent Office 0.12.0。这里区分已经实现的本机接入路径与后续后台适配研究，不把安装配置、发现进程或模型品牌当成已经接通的会话。只在用户要求时扫描，只准备用户点名的成员。

## 0.12.0 已交付的接入路径

| provider | 本版实现 | 真实接入条件 |
| --- | --- | --- |
| `gemini-cli` | 官方 Gemini CLI 0.63.0+ 独立后台协作；用户明确选择后可隔离安装官方包与 Node，不改全局 npm、PATH 或账号 | 本人的 CLI 认证、模型额度以及实际 MCP join；fixture 与安装材料检查未调用真实模型 |
| `doubao` | 原生个人连接器字段材料，默认本机 HTTP；非 JSON 自动导入合同 | 本人原生表单实际可用、保存启用、MCP room_ensure / heartbeat 成功；之后为信箱 |
| `opencode` | 官方 `mcp.agentroom.type:local` 与命令数组的 STDIO JSON 材料 | 本人合并实际配置、加载工具并握手；本版不启动 OpenCode 模型服务 |
| `cherry-studio` | `mcpServers` 下 command / args / env 的 STDIO JSON 导入材料 | 启用服务器、绑定给指定 Agent、本人调用工具握手 |
| `cline`、`roo-code` | 对应扩展实际设置中的 STDIO JSON 材料；仅通过官方扩展 manifest 识别安装元数据 | 用户合并并加载，本人会话真实握手；不把 VS Code 进程当成员在线 |

现有 Codex、Claude Code、Qwen Code 后台和 Claude/Qwen 桌面信箱路径继续保留。以上手动客户端的 `automatic_launch:false`，不能把 `ready_mailbox`、窗口开着或工具已安装变成后台唤醒能力。软件只生成 owned 导入材料，不写入未知原生配置档案，也不自动加群。

Gemini 的协议、隔离安装、认证和未完成真实模型验收见 [Gemini 适配依据](GEMINI_CLI_RESEARCH.md)，官方依据为[安装](https://geminicli.com/docs/get-started/installation/)、[认证](https://geminicli.com/docs/get-started/authentication/)与[后台模式](https://geminicli.com/docs/cli/headless/)。豆包的官方公开站及当前本机资源证据见 [豆包接入指南](DOUBAO_CONNECTOR_GUIDE.md)；没有确认消费者自动注册的公共文件或深链接合同，因此只提供真实可核对的个人表单流程。

## OpenCode：公开后台接口，适合下一项独立适配

OpenCode 的 `serve` 是正式的本机 HTTP 服务入口，支持 Basic Auth。公开接口可以创建和读取 session，向指定 session 发消息、等待回答和中止工作；无需操作窗口。它会启动独立服务，不能据此声称接管用户已有 TUI / Desktop 聊天。[Server](https://opencode.ai/docs/server/)、[SDK](https://opencode.ai/docs/sdk)、[CLI](https://opencode.ai/docs/cli/)

这次检查到稳定发布标签为 [v1.19.0](https://github.com/anomalyco/opencode/releases/tag/v1.19.0)。该发布已经保留 v1 接口并开始兼容 v2；实现时应锁定已测试的协议范围，不能把 `dev` 分支或网站的新功能默认套到用户的旧版本上。

建议后台适配步骤：

1. 通过用户选择的真实 OpenCode 可执行文件检查版本；不下载、不全局安装，不执行模型请求。
2. 用户发问时启动自己拥有的 child：`opencode serve --hostname 127.0.0.1 --port 0`。密码由 Agent Office 随机生成，通过 child 环境变量交付 `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`，不写入 prompt、日志或返回状态。不扫描现有监听端口，不自动连接别人的服务。
3. 只接受该 child stdout 的启动地址，严格验证为 `http://127.0.0.1:<port>`，禁止重定向；携带独立 Basic Auth。v1.19.0 的 `--port 0` 会先尝试 4096 再尝试随机端口，因此不得假定实际端口一定随机。[serve source](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/cli/cmd/serve.ts)、[listener source](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/server/server.ts)
4. 为每个成员固定 Agent Office MCP 的 member / room 环境变量。只允许明确的通信工具与项目只读工具；禁止 shell、写文件、子 agent、外部网络和安装操作。不能使用无限 `allow`、`--auto` 或宽泛的 `agentroom_*` 权限替代精确 allowlist。[Permissions](https://opencode.ai/docs/permissions/)、[MCP](https://opencode.ai/docs/mcp-servers/)
5. 创建 session 前验证生效配置、MCP 连接及专用 agent 权限；创建返回后校验真实 session ID 与项目目录，再持久绑定。恢复只使用该绑定 ID，核对返回的 directory，不使用“最后一个 session”。最终返回必须验证 assistant role、sessionID、parentID、完成状态和文本 parts。[generated v1 SDK types](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/sdk/js/src/gen/types.gen.ts)
6. 超时或连接断开后的请求结果记为待核对，保留绑定并停止自己创建的 child；不自动重建 session 或重复发问。可对原 session 做只读查询来核对结果。

### 不能跳过的配置隔离

官方说明配置会合并，而不是整体覆盖。全局、项目、家目录 `.opencode`、运行时 inline 与管理员配置都可能参与；加一份临时 JSON 不等于只加载这份 JSON。[Config](https://opencode.ai/docs/config/)

v1.19.0 的 `OPENCODE_PURE=true` 会跳过外部插件，保留内置认证插件。但自定义 `tools/*.js/ts` 仍由 ToolRegistry 在加载时 import；普通模型权限 `deny` 不能阻止其模块顶层代码运行。`OPENCODE_DISABLE_PROJECT_CONFIG` 也不排除家目录 `.opencode`。需隔离或在启动前拒绝这些额外来源，并对管理员配置覆盖保持失败关闭；仅在请求后检查 `/config` 太迟。[plugin source](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/plugin/index.ts)、[tool registry source](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/tool/registry.ts)、[config paths source](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/config/paths.ts)、[runtime flags source](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/effect/runtime-flags.ts)

结论：OpenCode 有可靠公开后台入口，但上述 `serve` adapter 尚未交付。**本版已交付的 `opencode` 是本人 MCP 信箱接入**，不会执行这套后台启动计划，`can_wake=false`。在完成真实 CLI / fixture 的隔离、身份、权限和超时检查前，不以它冒充后台接通。现有客户端自己的账号/模型配置由本人维护；不从其他客户端复制认证，不把“有 auth 文件”显示为模型认证已经验证。

## 标准 MCP 客户端：已实现的信箱材料

以下入口文档已核对，并用于本版的导入材料生成。用户点名后可创建绑定同一实例/房间的成员入口，本人实际调用工具才完成接入；本轮验证使用协议 fixtures，未向真实原生客户端自动写入配置，也没有调用其模型。

| 客户端 | 官方准备方式 | 产品边界 |
| --- | --- | --- |
| Cline | 面板 MCP Servers → Configure 打开实际配置；`mcpServers` 的本机条目为 `command` / `args` / `env`。CLI 配置位置为 `~/.cline/data/settings/cline_mcp_settings.json`，可由 `CLINE_MCP_SETTINGS_PATH` 覆盖。HTTP transport 名为 `streamableHttp`。 | 保留其他 server；`autoApprove` 初始为空，仅逐项开放必要通信工具。扩展和 CLI 配置不能互相冒充。 |
| Roo Code | 用户选定项目的 `.roo/mcp.json` 或通过 Edit Global MCP 定位的全局 `mcp_settings.json`；本机 STDIO 支持 `command` / `args` / `env`。 | 项目同名 server 覆盖全局；`alwaysAllow` 只列具体通信工具。不要把整个 VS Code 进程当成特定 Roo conversation。 |
| Cherry Studio | 设置 → MCP → 添加 / JSON 导入，配置本机命令、参数、环境变量；启用后还需在目标 Agent 的 MCP 绑定中选择该 server。 | 导入 server 和给某个 Agent 绑定是两步；工具实际调用才算握手。API 网关是另一类接口，不能自动等同于已有聊天。 |

官方依据：[Cline MCP](https://docs.cline.bot/mcp/mcp-overview)、[Roo Code MCP](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/)、[Cherry Studio MCP](https://docs.cherryai.com.cn/advanced-basic/extensions/mcp.md)。

Cherry Studio 官方 [JSON 导入代码](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/pages/settings/McpSettings/AddMcpServerModal.tsx)明确解析 `mcpServers`，其[配置 schema](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/types/mcp.ts)支持 command / args / env，省略 type 时使用 STDIO。Cline 的[官方扩展 manifest](https://github.com/cline/cline/blob/main/apps/vscode/package.json)为 publisher `saoudrizwan` / name `claude-dev`；Roo 的[官方 manifest](https://github.com/RooCodeInc/Roo-Code/blob/main/src/package.json)为 publisher `RooVeterinaryInc` / name `roo-cline`。本机扫描只读取匹配目录的这些产品字段，不读取聊天、Cookies 或账号令牌。

本版统一生成专属 STDIO 入口，使用软件稳定 EXE 的绝对路径（开发版保留 Node 前置参数），通过 `mcp --entry <成员入口文件>` 绑定同一个持久实例、房间和成员。材料保存为本机 `client-config/<provider>/<room_id>-<member_id>.json`；只在受授权接入面板提供，不进入公共进度、日志或群消息。用户合并客户端配置前保留其他条目和同名已有入口。目标 Agent 本人实际调用 `agentroom_room_ensure` / `agentroom_heartbeat` 后才判定 `ready_mailbox`；消息需要在自己的 Agent 窗口领取并回复。

连接诊断只读取所选房间、入口与已保存原群报告，不调用扫描、issue、wake 或 provider 网络。Grok Windows 宿主需要在 Grok 核对，Webhook 配置不能替代宿主证据；旧成员不存在时提供本房间重新选择入口，不新建替代身份。详见 [连接排查](GROK_CONNECTION_TROUBLESHOOTING.md)。

## Cursor CLI：有正式 headless，需单独审计后加入

新版官方文档给出 Windows CLI 安装、print mode、结构化输出与 `--resume`。CLI 和 Cursor 编辑器中的已有聊天仍是不同入口。[Headless](https://cursor.com/docs/cli/headless)、[Parameters](https://cursor.com/docs/cli/reference/parameters)

官方提供文件 / shell 权限及运行模式规则。[Permissions](https://cursor.com/docs/cli/reference/permissions)、[Run modes](https://cursor.com/docs/agent/security/run-modes)。下一项实现应审计 hooks、MCP、plugins、项目规则以及只读边界是否能被 invocation 独立限定；不能为了后台处理就启用 `--force` / `--yolo`，也不能修改用户全局权限来影响原来的工作。直到这一层验证完成，只提供现有 Cursor MCP 信箱接入。

## 尚不能定配置的客户端

Trae 本轮未获取到可核对的官方配置页面，所以不猜文件路径、transport 字段或原生 wake 能力。出现进程时可以如实标注已发现，接入需对应版本的正式文档或通用 MCP 导入入口。以后添加新的桌面产品也遵循同一边界。
