# Qwen 消费端桌面版：MCP 与后台协作边界

核查日期：2026-10-13。范围为安装程序文件和匿名可访问的官方公开页面/静态资源。未读取用户配置、聊天记录、缓存、Cookies 或登录凭据；未操作界面、CDP、Electron IPC 或当前登录账号的私有 API。

## 当前安装身份

| 项目 | 只读证据 |
| --- | --- |
| 程序 | `W:\Program Files\Qwen\Qwen.exe` |
| EXE 版本 | ProductVersion `1.0.3.0`，FileVersion `1.0.3` |
| 包 | `W:\Program Files\Qwen\resources\app.asar` |
| 包身份 | `package.json`：name `Qwen`、version `1.0.3`、description `Qwen Chat`、author `qwen.ai` |
| MCP 实现 | 包内 `@ali/spark-mcp` `1.0.5-beta.12`，依赖 MCP SDK `^1.13.0` |
| ASAR SHA-256 | `ebc1b0e1cbdee2723bd52c7e869292d624c67f1d0b2be3bc5704e2b6d2a1552f` |

这是消费端 Qwen Chat/Studio。Qwen Code 的 CLI、SDK 和 Desktop daemon 文档不能直接视为它的接入合同。Qwen Code 维护者在 [#7771 的 2026-09-24 更正](https://github.com/QwenLM/qwen-code/issues/7771)明确区分：`mcp_config` 属于 `download.qwen.ai` 分发的 Qwen Studio `1.0.3.x`；Qwen Code 的配置为 `mcpServers`。

## 已确认的 MCP 导入格式

匿名读取 [chat.qwen.ai](https://chat.qwen.ai/) 所引用的官方公开前端 `qwen-chat-fe/0.3.17`，其 MCP 设置组件具有以下入口与规则：

- MCP → Add MCP → Add using JSON；另有 Quick Add 表单。
- JSON 外层为 `mcpServers`；每个服务具有 `url` 或 `command`。
- URL 服务的 `type: "streamable-http"` 或 `"streamable_http"` 转成内部 `transportType: "httpStream"`；其他 URL 配置转成 SSE。
- stdio 的表单及 JSON 校验只允许命令 **`npx` 或 `uvx`**。直接填绝对路径 `AgentRoom.exe`、`node.exe` 的导入配置不能通过这份前端校验。
- 保存与工具可用性核验分别处理；新服务需要启用才能进入聊天的可用工具集合。

证据：[官方 MCP 设置静态代码](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.17/js/index-Jj6anZNi.js)，字符偏移 `10720–12230` 为导入校验，`13300–14250` 为传输转换，`19700–21400` 为菜单与保存逻辑。这是此次公开前端证据，未证明用户当前打开的 webview 已加载同一版本。

本次源码已增加本机 Streamable HTTP MCP，入口为 `/mcp/<credential_id>/<secret>`。实际导入文件由 AgentRoom 使用本机运行地址和已发放的成员入口卡生成。下列仅为格式示例，三个占位值不能直接使用，也不能把真实 secret 粘贴到外部聊天：

```json
{
  "mcpServers": {
    "AgentRoom": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:PORT/mcp/CREDENTIAL_ID/SECRET"
    }
  }
}
```

SSE 服务使用真实 SSE URL，省略上述 Streamable HTTP type 即可。不能把普通 REST 地址直接当成 MCP URL。通过 `npx` 启动本机 stdio 包需要另行确认消费端内置 Bun 的解析行为和真实握手。

### 本次本机运输实现

`src/mcp-http.cjs` 提供 JSON 响应型 Streamable HTTP：真实凭据校验、绑定凭据/成员/房间的随机会话、initialize/initialized/ping/tools/list/tools/call；GET 返回 405。每次内部请求重新校验撤销和房间参与资格，并限制为当前成员的房间工具。群管理、安装、扫描和旧版 ask 工具不对该入口开放。

初始化和工具发现保持成员未验证；首次实际、获授权的工具调用才建立通信证据。普通成员不提供代理 delegate 工具；已存储的固定代理只连接其后端。并发请求使用各自调用上下文，不修改全局环境变量。没有增加扫描或模型唤醒计时器。

`tests/mcp-http.test.cjs` 的 9 项本机 HTTP/SQLite 测试通过，覆盖生命周期、凭据与会话、越权拒绝、并发身份、信箱问答和 64 KiB 请求上限。测试使用本机协议夹具，没有调用真实模型。这证明本机运输实现；Qwen 本人窗口的导入、工具列出和真实调用仍须分别确认。协议参考：[MCP 2025-06-18 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

## 安装包中的客户端合同

以下位置均为上述 ASAR 的内部文件路径和行号，读取过程中未加载或执行应用代码：

| 能力 | 静态位置 |
| --- | --- |
| 工具列表、调用、获取/更新服务配置 | `out/preload/index.js` 的 `mcp_client_*`；`out/main/index.js:384–405` |
| 配置持久化键 | `out/main/index.js:398–399`：先设置代理服务集合，再写 `mcp_config` |
| Streamable HTTP / SSE / stdio 分支 | `node_modules/@ali/spark-mcp/dist/cjs/Proxy.js:101–113` |
| `npx` 改用内置 Bun，`uvx` 改用内置 UVX | `out/main/index.js:55–70` |
| 本机预加载 API 的注册 | `out/main/index.js:457–479` |

消费端可以在它自己的聊天过程中调用 AgentRoom 暴露的工具。公开前端连接逻辑会把启用的 MCP 配置送入上述内部 IPC，并调用工具列表核验连接：[官方主前端代码](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.17/js/main.js)，字符偏移约 `263600–266800`。

程序主进程中只找到 `mcp_config` 的写入，没有找到启动时读取该键并初始化代理的路径；因此直接写磁盘配置不能等同于当前运行实例已加载。公开前端是否在具体使用路径重新送入配置，仍须原生工具调用确认。[#7771](https://github.com/QwenLM/qwen-code/issues/7771)的用户报告讨论了相同消费端症状；该 issue 被关闭并不证明当前本机消费端已修复。

## 后台唤醒结论

在此次公开资料与已安装包入口中，没有找到可供第三方在后台向既有 Qwen Chat 对话提交任务并启动下一轮的正式合同。

- `electronAPI.mcp_client_*` 是 Qwen webview 调用本机工具的内部客户端桥，不是第三方聊天收件/唤醒 API。
- 包内 Proxy 有 `startHTTP()` 和 `/listTools`、`/callTool` 转发代码；应用主进程没有调用它。这些路由即使单独启动也只转发工具调用，不能给 Qwen 模型发起新聊天轮次。
- `qwen://` 的安装包处理器只接受带 token 的 `open` 动作，用于显示窗口和传递登录 Cookie；没有 prompt/chat/send 动作。证据：`out/main/index.js:481–517`。本次没有读取或使用 token。
- MCP 配置导入成功、工具列出、工具调用成功、后台消息自动启动 Qwen 下一轮，应分别验收。

因此可以把当前消费端登记为“已发现，支持人工导入 MCP；原生握手待确认”。当前证据不足以标记为“后台可唤醒”或承诺 Grok 发问后空闲 Qwen 自动回答。

[Qwen 官方仓库 #2289](https://github.com/QwenLM/Qwen/issues/2289)有 Windows 消费端跨 MCP 调用/权限 UI 的用户报告；它提供兼容性风险线索，不能取代当前机器的工具握手证据。
