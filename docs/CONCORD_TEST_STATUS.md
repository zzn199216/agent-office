# Concord 0.12.0 安装与本机验收

日期：2026-10-11。

## 安装状态

- 使用 npm 安装官方 `@concord-ai/concord-mcp@0.12.0`，版本固定；当前运行环境 Node 22.22.2。
- 包目录：`C:\nvm4w\nodejs\node_modules\@concord-ai\concord-mcp`。
- `concord --version`、工作区初始化、状态查询和 doctor 均可以运行。
- 测试仓库位于 `%LOCALAPPDATA%\AgentRoom\ConcordTest\workspace`。初始化使用 `--no-mcp --no-adapters`，接入配置仅传给测试专用原生会话。
- 使用前后对比确认原有 Codex `config.toml` 没有更改。未启用全局 remote control，也没有接管或中断其他工作会话。
- 本轮所有测试和提供的看板/重跑入口都关闭 Concord 的遥测及更新检测；没有连接 Concord Cloud。

## 真实验收结果

使用官方已安装 Concord MCP 和两个真实 Codex App Server 会话。两端使用各自私有的本机 WebSocket 服务与 Concord 原生桥接器；通信使用 Concord 的 Windows 本机命名管道端点。

| 检查项 | 结果 |
| --- | --- |
| 两个成员注册及可达端点 | 通过 |
| 两端原生 Codex 真实调用 Concord MCP | 通过 |
| A 模型调用 prompt 向 B 提问 | 通过 |
| B 原生会话被消息唤醒 | 通过 |
| B 真实执行只读命令，读到 README 中的项目标识 | 通过 |
| B 模型调用 reply 回给原消息 | 通过 |
| 中文校验文本随消息及回报保留 | 通过 |
| 回报唤醒 A 的同一个原生会话 | 通过 |
| 两端所有原生轮次成功结束后才退出 | 通过 |

最终测试观测到 A 三轮、B 两轮，包含各一轮工具准备检查；没有额外重复开启的测试轮次。测试后的端点离线是主动退出的结果，不能用注册表里“live/active”文字代替实时端点检查。

第一轮已经验证了实际回复，随后补充原生文件读取和轮次结束检查再验收。两轮证据分别保留为 `output/validation/concord/first-receipt-pass.json` 与 `live-result.json`。

## 当前限制

1. 这是 Codex ↔ Codex 的真实测试，没有宣称跨产品协作通过。没有找到本机 Claude Code 或 Grok Build CLI；当前运行的 Grok Bot 不是 Concord 文档中的 Grok Build。
2. 原生 Codex 全局后台服务探测失败，报告了控制 socket 连接错误。本次改用 Concord 支持的私有 WebSocket 路径并成功收发，没有为了测试启用全局远程控制。
3. 已安装包和本机测试入口，不代表当前桌面中任意已打开聊天都已接入。日常自动会话发现、宿主插件加载及 hooks 信任还需要单独完成接入验收。
4. Concord 自带看板是终端界面，当前浏览器里的 AgentRoom 界面没有因此变成 Concord 前端。
5. 这次数据库在本机磁盘。网络盘/UNC 上的 SQLite WAL 工作区没有列为已验证能力。

## 如何继续测试

打开仓库根目录的 `Concord-测试` 文件夹，双击“打开看板.cmd”查看记录；双击“再次运行协作测试.cmd”重跑真实问答。看板使用默认终端，重跑测试的 agent 在后台运行，整个收发过程不使用模拟键鼠。

下一项最有价值的验收是安装并登录真实 Claude Code 后，验证 Claude 与 Codex 的双向问答，以及空闲会话被自动唤醒。当前 Grok Bot 应走独立适配器验收。

## 证据

`output/validation/concord/live-result.json` 保存原生 thread/turn ID、MCP 调用、项目文件读取输出和消息记录。`installation.json` 保存安装路径、版本、配置哈希核对结果和原生轮次统计。证据只保留在本机，不进入 AgentRoom 发行包。
