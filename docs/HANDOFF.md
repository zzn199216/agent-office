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

## 2026-11-10 接入优化与未提交工作筛选

执行计划取代 `.local/CODEX_TASKS_2026-11-10.md`。基线 `6034c20`；主开发目录保持当前 checkout。Y: 的 46 个原始文件已完整保存于 `codex/snapshot-preview20-20261110`（`dbdc950`），该目录保持干净，不删除旧分支或目录。下表逐文件列出筛选结果，未采纳的内容仍可从快照恢复。

下一开发版本统一为 **0.15.0-preview.21**，高于两条线已有版本。安装计划模块有可取的身份校验、等效复用和指纹保护，但成套启用还会恢复自动配置及新增安装阶段，因此只吸收现有路径中的小修复及提示规则。保留现有五种展示状态、Grok 和协作入口；不拆 app.js、不清脚本和文档。

| 快照文件 | 与 6034c20 比较后的处理 |
| --- | --- |
| `docs/AGENT_INSTALLATION.md` | 保存在快照：安装器及历史实测说明不作为当前交付；现有接入与发布文档继续有效。 |
| `docs/CONNECTION_UX_RESEARCH.md` | 保存在快照：安装器及历史实测说明不作为当前交付；现有接入与发布文档继续有效。 |
| `docs/NATIVE_DESKTOP.md` | 保存在快照：安装器及历史实测说明不作为当前交付；现有接入与发布文档继续有效。 |
| `docs/RELEASE.md` | 保存在快照：安装器及历史实测说明不作为当前交付；现有接入与发布文档继续有效。 |
| `package-lock.json` | 与 package.json 同步 preview.21。 |
| `package.json` | 统一版本为 0.15.0-preview.21。 |
| `scripts/build.cjs` | 采用主线滚动 dev 构建、资源清单及完整验收门禁；不回移旧打包逻辑。 |
| `scripts/validate-client-installation.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `scripts/validate-connection-assist-ui.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `scripts/validate-grok-guided-flow.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `scripts/validate-native-clients.cjs` | 保存在快照：涉及实际客户端验收，不加入本轮隔离门禁。 |
| `src/agent-install.cjs` | 采纳通用提示中的身份核对、等效复用与写前指纹；保留主线豆包提示。 |
| `src/chat.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/claude.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/client-config-installer.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `src/client-installations.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `src/connection-assist.cjs` | 采用主线统一展示与新版接入帮助；快照的安装任务 UI 和新成员子阶段不回移；本轮再修原因与动作。 |
| `src/connection-target.cjs` | 采纳：跳过已删除房间的固定代理；旧凭据限制不变。 |
| `src/desktop-client-launcher.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/desktop-doubao.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/desktop-grok.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/desktop-sessions.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/discovery.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/http.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `src/install-clients.cjs` | 采纳 Store 配置迁移识别、缺少 CLI 的明确结果；不导出新安装器接口。 |
| `src/launch.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/main.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `src/mcp-http.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `src/mcp.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `src/onboarding.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `src/service.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `tests/chat-service.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/client-installations.test.cjs` | 保存在快照：安装计划/自动写配置/工具回执联动暂不启用；主线使用手动准备和既有显式安装接口，不引入新接入阶段。 |
| `tests/connection-assist.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/connection-target.test.cjs` | 采纳删除房间代理回归；其余新成员流程不回移。 |
| `tests/desktop-client-launcher.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/desktop-doubao.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/desktop-grok.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/grok-delivery-routing.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/grok-discovery-onboarding.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/grok-guided-onboarding.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/install-clients.test.cjs` | 采纳 Store 迁移回归；现有并发安装回归已覆盖。 |
| `tests/onboarding-attempt-readiness.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `tests/web-connection-assist.test.cjs` | 采用主线统一展示与新版接入帮助；快照的安装任务 UI 和新成员子阶段不回移；本轮再修原因与动作。 |
| `tests/web-native-connect.test.cjs` | 采用主线后续实现及回归：已包含更新的连接/派发/原生适配处理；不回退到快照的旧运行时或绕过版本验证。 |
| `web/app.js` | 采用主线统一展示与新版接入帮助；快照的安装任务 UI 和新成员子阶段不回移；本轮再修原因与动作。 |

验证：每步在全新隔离数据中运行 `scripts/validate-core-flows.cjs`，通过真实页面、HTTP/MCP 完成选目录、接入及关联回复，不操作个人账号或真实模型。交付前执行完整 `npm run verify:dev`。
