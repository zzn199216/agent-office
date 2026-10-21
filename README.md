# Agent 办公室 · Agent Office

把选定的 AI 成员接入同一间本地办公室，通过文字聊天或像素办公室协作。项目目前为 Windows x64 开发预览版；当前版本以 [package.json](package.json) 和窗口显示的实际服务版本为准。

## 本地开发与测试入口

需要 Node.js 22.13+、Windows x64 和 WebView2 Runtime。

```powershell
npm ci
npm run check
npm run prepare:desktop
npm test
npm run build
```

构建完成后打开 **`dev/OPEN_TEST.cmd`**。`npm run build` 与 `npm run build:dev` 更新同一个 `dev/` 目录，不生成 ZIP 或按版本堆积完整安装包。源码、依赖和构建过程不依赖旧项目目录。首次构建会下载固定版本、校验 SHA256 的官方 WebView2 SDK。

打开软件自动启动本机服务；关闭软件停止服务。需要后台继续处理任务时，使用窗口最小化按钮，页面刷新、动画和 WebView 会暂停，恢复窗口后重新读取进度。独立命令行服务仍可用于开发：

```powershell
npm start
# 或只启动服务：npm run serve
```

正式分发包按需执行 `npm run build:release`，产物进入 `release/`。完整发布验收和已有隐藏发布任务的说明见 [本机发布与诊断](docs/RELEASE.md)。普通开发无需创建正式包或注册发布任务。

## 连接成员

在「接入成员」中扫描本机，再选择需要的成员。已运行的候选优先展示；未完成真实验证的接入尝试不占办公室工位。接通秘书后自动进入办公室，失败时保留原进度并给出下一步。

| 成员入口 | 实际能力与条件 |
| --- | --- |
| Codex、Claude Code、Qwen Code、Gemini CLI | 专用后台协作会话；沿用各自可用的账号或 API 配置，须完成实际验证。 |
| Qwen、豆包桌面 | 支持的 Windows 客户端版本可通过「连接本人对话」保存独立人物会话，自动派发并回写回答；首次需开启本机连接。 |
| Grok Bot | 复用已有 Bot 的本人窗口桥接；需要可用的本机执行入口和真实握手，群聊不是接入前提。 |
| Claude 桌面及其他 MCP 客户端 | 导入、启用本机 MCP 后领取和回复消息；自动唤醒能力须按客户端单独验证。 |

连接属于办公室人物，加入新房间、删除旧房间或升级软件不要求重新导入 MCP。原 `AgentRoom.exe`、`agentroom_*` 工具名和 `.agentroom` 数据路径保留兼容。安装、登记、进程存在与真实接通是不同状态；实际回复仍以当前验证结果为准。

Codex 使用原有登录配置与 AO 专用工作会话，不接管正在使用的个人对话。Qwen Code 与 Qwen 桌面使用不同的认证入口，不能把桌面已登录当成 CLI 已认证。各客户端的支持版本、权限和连接要求见下面的指南。

## 使用与资料

文字与办公室视图共用房间、成员和消息。Enter 发送，Shift + Enter 换行；聊天支持 Markdown 和图片，图片派发能力取决于成员适配器。已授权的日常协作自动继续，需要确认的操作放在对应成员的最新对话中。

房间可归档、恢复或删除；删除前显示本房间的未完成工作并要求确认。其他房间与共享连接保留。运行记录、成员凭据与 MCP 配置留在本机，不属于 Git 源码。

- [使用指南](docs/USER_GUIDE.md)：启动、聊天、房间和工作记录。
- [秘书与协作](docs/SECRETARY_GUIDE.md)、[团队协作](docs/TEAM_COLLABORATION.md)：目标、派工与会议。
- [原生桌面对话](docs/NATIVE_DESKTOP.md)、[豆包接入](docs/DOUBAO_CONNECTOR_GUIDE.md)：桌面版本和首次连接要求。
- [通用 MCP 安装](docs/AGENT_INSTALLATION.md)、[其他客户端](docs/ADDITIONAL_AGENTS_RESEARCH.md)：兼容模板及验收边界。
- [Grok 接入排查](docs/GROK_CONNECTION_TROUBLESHOOTING.md)、[Grok Skill](integrations/agentroom/GROK_SKILL.md)。
- [成员操作与确认](docs/OPERATION_POLICY.md)、[办公室外观](docs/OFFICE_APPEARANCE.md)。

## 项目维护

`src/` 为本机服务和适配器，`web/` 为界面与运行素材，`desktop/` 为 Windows 宿主，`tests/` 为回归测试，`scripts/` 为构建与验收工具。当前架构与检查入口见 [开发交接](docs/HANDOFF.md)。

每个完成并通过检查的改动做一次 Git 提交，从开发分支推送 GitHub；用提交回退源码，再重新构建固定开发版。依赖、SDK 缓存、打包文件、测试输出、数据库和个人配置均不提交。Git 历史保留旧版本和设计资料，不在当前目录重复存放历史包。

当前尚未开放给用户，不引入用户账号数据库、生产数据迁移或长期备份流程。程序运行所需的本机状态与连接配置仍正常保留；隔离测试使用可丢弃的临时数据。
