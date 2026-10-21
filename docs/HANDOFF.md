# 开发交接

本项目目前处于本地开发阶段。以源码、测试和 Git 提交为准；开发入口及构建命令见根目录 README。生成包、依赖缓存、日志、截图和临时测试数据不属于源码，不应提交。历史设计稿、阶段报告和旧交接记录可从 Git 历史查阅。

## 目录与责任

- `src/`：本地服务、持久信箱、MCP、成员权限和客户端适配器。
- `web/`：聊天、办公室、接入流程及本地运行资产。像素资产定义和导出脚本均须保留。
- `desktop/`：Windows WebView 宿主、窗口与服务生命周期。
- `integrations/`：提供给外部客户端的协作说明和工具合同。
- `scripts/`：构建、打包及隔离验证。
- `tests/`：单元与集成回归，包含假客户端和原生事件夹具；不能当作构建垃圾删除。
- `docs/`：当前协议、架构、接入和验证说明。其中部分文件由构建脚本直接随包分发。

## 当前连接与生命周期约束

软件打开时启动本地服务，关闭时停止本窗口拥有的服务；最小化保留后台工作，暂停前端定时器、事件流和动画，恢复后读取最新状态。宿主会尝试挂起隐藏的 WebView。

`src/desktop-lifecycle.cjs` 保存明确的打开/关闭意图。关闭操作核对 activation、实例和后台进程身份；旧窗口不能停止后来接管的服务。MCP 的后台启动路径不能绕过已关闭状态，只有明确重新打开软件才产生新 activation。

MCP 连接跟随人物，工具按当前成员座位核对房间权限。删房间、新建房间或版本更新不应要求重新导入同一人物的 MCP。用户明确撤销的凭据不能自行恢复。已提交但结果不确定的外部任务不能自动重发。

Codex 后台会话使用原生 `shared-cache` 认证方式，保留原环境的凭据存储、模型与提供方配置。AO 不复制或覆盖个人认证；人物使用独立工作线程及确定性 MCP 名称。缓存共享仍可能遇到提供方的认证或刷新错误，不得用测试夹具通过宣称真实账号永远不会失效。

接入状态必须区分：发现应用、写入配置、协议握手、绑定原生对话、真实消息往返。进程存在、心跳、房间座位或接口自测都不足以单独证明自动聊天成功。可用连接先复用；必须人工完成的步骤应给出明确、简短的下一步。

聊天按真实消息 seq 排序。接入进度只合并到同一房间、同一原请求和同一收件成员的真实回复；未回复时在原请求内展示紧凑进度。合成进度不伪造独立人物消息或时间。

## 验证

基础检查不启动真实模型：

```powershell
npm ci
npm run check
node scripts/build-desktop.cjs
node --test --test-concurrency=4 tests/*.test.cjs
git diff --check
```

全新 checkout 须先构建 Windows 桌面依赖，避免 WebView2 测试因缺少 SDK 而跳过。打包后的专项脚本均应使用隔离数据、假客户端和明确的可执行文件路径：

```powershell
node scripts/validate-desktop-lifecycle.cjs <AgentOffice.exe>
node scripts/validate-startup-recovery.cjs <AgentOffice.exe>
node scripts/validate-mcp-continuity.cjs <AgentOffice.exe> [previous-AgentOffice.exe]
node scripts/validate-page-activity.cjs
node scripts/validate-connection-assist-ui.cjs
```

验证结果必须标明使用的是源码、打包程序、假客户端还是实际客户端，以及是否真的收到模型最终回复。隔离浏览器和 C# 夹具测试不等于用户客户端已接通。真实窗口操作须先满足用户对电脑空闲的要求；不要触碰个人账号或现有聊天来做无关验证。

开发测试数据可以重建，不承担尚未发布版本的历史数据兼容义务；这不意味着应把运行数据、账号或凭据写进 Git。当前开发提交和必要连接配置应分别管理，避免为每次修改保存整套旧包。
