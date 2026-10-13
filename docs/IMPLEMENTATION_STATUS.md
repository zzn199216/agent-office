# AgentRoom 0.1 本机交付状态

> 历史记录。当前 0.2 聊天室交付范围见 [聊天室交付状态](CHAT_RELEASE_STATUS.md) 和 [使用说明](USER_GUIDE.md)。

验收日期：2026-10-11。当前实现为 Windows x64 本地软件，附带 CLI、stdio MCP 和协作 Skill；以下为实际验收范围。

## 可以使用的入口

- `release/AgentRoom-0.1.0-windows-x64.zip`：解压后双击 `AgentRoom.exe`，无 Node/Python 安装要求。
- 本机已经安装到 `%LOCALAPPDATA%\AgentRoom\bin\AgentRoom.exe` 并安静启动；本次页面为 `http://127.0.0.1:47831`。
- 已登记本工作目录，准备“项目开发与运营”讨论。讨论初始为只查询项目资料。
- 使用方法见 [使用说明](USER_GUIDE.md)。机器专用的 Grok 接入说明在 `.local/GROK_CONNECT.md`，不进入发行包。

## 已验证

- 26 项自动测试全部通过，源码检查通过。覆盖请求去重、队列、取消、回执、重启恢复、安装碰撞、UTF-8、HTTP 校验和 MCP 协议。
- 真实 Codex App Server：中文问答、同一会话持续上下文、读取项目资料。没有使用模拟结果替代真实调用。
- 真实 Codex 调用 AgentRoom MCP，原生调用记录显示工具成功完成。
- 真实本机 CLI 使用 UTF-8 文件提交问题并等待中文答案。
- 打包的独立 EXE：安装到固定位置、内置界面、真实 Codex 与 MCP 问答；执行版本查询不产生安装或后台启动。
- 浏览器实际创建讨论、提交问题并取得回答；桌面和窄屏布局检查通过。最终正式入口截图为 `output/playwright/final-dashboard.png`。
- Grok Webhook 真实触发返回成功和 run UUID。软件将这一步显示为受理，未伪造自动回复。
- 发行 ZIP CRC 检查通过；EXE 和 ZIP 内容没有本机配置的 Webhook URL/key、运行数据库或登录数据。

## 仍需完成的一次性 Grok 设置

现有 Routine 实际仍按摘要流程工作，未授权执行本机协作命令。需要用户把连接设置中“复制给 Grok 的一次性协作说明”交给目标 Bot，并配置为 Routine 的固定流程，授权其本机命令能力。仅在 webhook 正文中附带操作说明不能代替这一步。

Grok 主动向 Codex 提问可使用本机 CLI/MCP，不需要 Webhook；Codex 主动问 Grok 或通知它时需要 Webhook。自动回报协议已实现，但当前 Grok 配置下的双向自动回报尚未验收。任意 Grok 原生聊天的创建与续接也不属于已验收能力。

## 发行边界

当前是未签名的本机预览版，尚未发布到 GitHub。提供了 Windows GitHub Actions 构建工作流和源码压缩包；正式公开发行前仍应完成代码签名及独立目标设备验证。

协作服务、队列和记录位于本机，无需购买或部署服务器。模型推理和 Grok Webhook 仍使用各自供应商的网络服务。

## 验收记录

具体记录保存在 `output/validation/`：`unit-tests.txt`、`live-codex.json`、`live-mcp-request.json`、`live-cli.json`、`live-grok-trigger.json`、`packaged-runtime.json`、`release-check.json` 和 `final-install.json`。这些是本机开发证据，不进入发行包。
