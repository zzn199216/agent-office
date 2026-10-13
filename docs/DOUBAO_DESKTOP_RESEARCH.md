# 豆包桌面版个人 MCP 导入：只读资源核查

核查日期：2026-10-13。范围是当前机器的安装资源；没有操作界面，没有调用豆包私有接口，没有读取用户资料、聊天记录、Cookies 或令牌，没有改动豆包配置。本文是资源证据记录，不是已完成的导入验收。

## 当前版本

- 安装位置：`W:\ProgramData\Doubao\app\Doubao.exe`。
- `app\manifest.json`：`productName=Doubao`、`version=2.31.4`、`updateChannel=release`、`stable=release`，commit `69f7436cfbe07b8f2420bde4b5c3af90d4d382e1`。
- EXE 的文件版本是 `147.0.7727.149`，不能把它当作豆包产品版本。
- `local_webcontents\extensions\ai-views\manifest.json`：扩展版本 `1.0.4.1777`。

## 已确认的原生功能文案

安装目录中的 `local_webcontents\extensions\ai-views\static\js\91066.js` 包含以下中文界面文案。它们比单独存在 `mcp_helper.dll` 更能证明产品中有个人 MCP 的设计，但不能证明当前账户、入口或灰度开关已启用。

| 字符串键（省略共同前缀 `skill_hub_business_`） | 文案 |
| --- | --- |
| `create_mcp_desktop_only_tip_cn` | 请前往豆包电脑版新建自定义连接器 |
| `create_mcp_label_cn` | 新建自定义连接器 |
| `personal_mcp_create_title_cn` | 新建自定义连接器 |
| `personal_mcp_edit_title_cn` | 编辑自定义连接器 |
| `personal_mcp_subtitle_cn` | 自定义连接器仅支持在本地电脑中使用 |
| `personal_mcp_transport_cn` | 传输类型 |
| `personal_mcp_server_name_cn` | 服务器名称 |
| `personal_mcp_server_url_cn` | 服务器 URL |
| `personal_mcp_server_url_placeholder_cn` | https://mcp.example.com/mcp |
| `personal_mcp_command_cn` | 命令 |
| `personal_mcp_command_placeholder_cn` | 请输入命令，如 python、node 或 ./script.sh |
| `personal_mcp_args_cn` | 参数 |
| `personal_mcp_env_cn` | 环境变量 |
| `personal_mcp_headers_cn` | 自定义 Headers |
| `personal_mcp_local_environment_not_ready_cn` | 本地电脑未初始化 |
| `personal_mcp_authorization_description_cn` | 你创建的连接器需要通过授权后才可正常使用 |
| `personal_mcp_creating_cn` | 正在连接服务器... |

同一资源有“技能 · 连接器”、“管理”、“我的技能”、“个人”、“连接器”、“新建”等文案。可以据此提示用户在技能/连接器管理页寻找“新建自定义连接器”；尚未核实一个逐步点击的精确路径。

## 传输和字段：资源模型，不等于公开导入合同

`static\js\async\s1-mcp-app-node.js` 中的通用连接器数据转换包含：

| 枚举 | 转换后的字段 |
| --- | --- |
| `STREAMABLE_HTTP=1` | `transport: "http"`, `endpoint`, `headers` |
| `SSE_HTTP=2` | `transport: "sse"`, `endpoint`, `headers` |
| `STDIO=3` | `transport: "stdio"`, `command`, `params: []`, `env: {}` |

同一资源区分 `RuntimeType_Cloud_VM=1` 和 `RuntimeType_Local_PC=2`，以及 User/System/Enterprise/Local/Store 类型。不能把连接器通用枚举推断成个人新增表单一定支持全部三种传输。

`UNSUPPORTED_PERSONAL_MCP_TRANSPORT` 和 `DUPLICATE_MCP_VARIABLE_KEY` 被归类为前端校验失败；说明个人 MCP 另有协议/变量校验。目前没有在本机随安装资源中定位到这些错误实际抛出的新增表单实现，无法据此确定允许协议列表或重复变量的完整规则。

在已核查的 `local_webcontents` JavaScript 中，没有找到 `mcpServers` 配置名或一个面向用户的 JSON 导入合同。不能把通用转换字段当作 Claude/Cursor 式 JSON 导入格式。

## 启动、授权和重试的边界

`static\js\async\3041.js` 和相关资源中存在连接器管理、安装、本地运行状态、授权和重试流程；原生桥接标识包含 `queryLocalConnectors`、`retryConnector`、`authorizeConnector`。这些是随包代码里的内部桥接名，不是经过确认的公共 API。核查期间没有调用它们。

文案中有“本地电脑未初始化”、“连接器运行失败，你可在管理中重新启动”，以及“去授权”、“重新授权”、“重新启动”。这意味着保存连接器、运行准备完成、工具可用和授权完成应分别验收；仅写入某个文件或重启豆包不能证明导入成功。

## 全自动导入的结论和剩余证据

目前可以确认产品资源包含个人 MCP 的原生设计。没有证据足以承诺 AgentRoom 能在完全不操作界面、不使用私有接口的条件下自动注册到豆包。

本次只读核查没有定位到面向用户公开的 MCP 注册 CLI、配置文件导入合同或 MCP 导入深链接；这是“未找到”的有限结论，不是证明它们不存在。`doubao-office` 随包代码有文档打开深链接，但不能用于推断 MCP 导入能力。

正式实现前，需要至少完成一次用户手动打开原生页面的核实：入口确实可见、个人表单实际支持的协议及字段、保存时的授权/本地环境步骤、连接状态和工具列表。若后续有正式公开的 CLI、配置文件或导入深链接文档，再据该合同实现自动导入。

导入 MCP 和后台唤醒也是两个独立能力。即使豆包成功导入 AgentRoom 工具，也只证明豆包在主动对话中有机会调用它们；还需要正式的入站通知/唤醒机制和真实回执，才能声称 AgentRoom 消息可自动唤醒豆包。本文没有验证豆包加入 AgentRoom，也没有验证后台唤醒。

## 资源指纹（SHA-256）

| 文件（相对 `W:\ProgramData\Doubao\app`） | SHA-256 |
| --- | --- |
| `manifest.json` | `2E971553B9E1AA36EEDADEE44A1864577DA8862009E28A79C725FB836AEA4850` |
| `local_webcontents\extensions\ai-views\static\js\91066.js` | `E979D8902463F462EEF5D5781F6CBCEDFC5D676D289DB0FF61F52E97FC2C7161` |
| `local_webcontents\extensions\ai-views\static\js\async\s1-mcp-app-node.js` | `99E7F1E2FFF45097B6CE2BC7CBC9672EFA09C4DFD58C9FA61151B09E635740F4` |
| `local_webcontents\extensions\ai-views\static\js\async\3041.js` | `1B4043988E42F6511FF0123EFD4B9875C25A32196107122608A615EA599E69B9` |
