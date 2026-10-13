# Gemini CLI 适配依据

核对日期：2026-10-13。官方 GitHub Releases API 当日返回稳定版 **v0.63.0**，发布时间为 2026-10-06 20:38:49 UTC。实现以该 tag 的源码为准；搜索摘要中仍显示 v0.62.0，不把缓存摘要当作当前发布版本。

## 支持入口与边界

Agent Office 的后台入口是 Google 官方 `@google/gemini-cli`，最低版本 `0.63.0`，使用 Gemini CLI 自己的认证。它是独立的协作会话，不控制、替代或继承 Gemini 网页聊天。网页打开、进程存在、认证配置存在，都不证明某个成员已经接入。

已有官方 npm CLI 可以直接复用；官方手动安装命令是 `npm install -g @google/gemini-cli`。应用也提供下文的一键隔离安装，不要求用户自己配置全局 npm。两种入口都不修改登录、不读取 OAuth token 或 keyring。Windows 的 npm `.cmd` 启动器不能通过 `shell:false` 当作可执行程序运行；应用发现层应验证官方包的 package metadata 与 entry，然后提供受信 Node 可执行文件和固定 entry 参数。不要将未知进程或用户输入的 shell 字符串当作官方 CLI。

认证支持 Google OAuth、Gemini API key、Vertex AI；登录与模型服务的额度适用 Google 自身规则。状态检查仅执行 `--version`，以及读取 `.gemini/settings.json` 中的认证类型枚举/环境变量是否存在。`signedIn:null`、`authVerified:false` 是刻意保留的状态，只有实际模型和 MCP 握手完成才可视为可工作。没有调用模型来“检查登录”。

来源：[官方安装说明](https://geminicli.com/docs/get-started/installation/)、[官方认证说明](https://geminicli.com/docs/get-started/authentication/)、[v0.63.0 发布](https://github.com/google-gemini/gemini-cli/releases/tag/v0.63.0)。

## 一键安装的实际来源与布局

`RuntimeInstaller.install({provider:'gemini-cli'})` 只安装用户请求的这个入口。先复核已有的完整专用运行时收据；如发现已安装且 package metadata 符合官方包的本机 npm CLI，则只执行 Node/Gemini 的 `--version` 并复用。现有 npm 包以 `origin:existing-official-package` 标明，不冒充这次下载校验的 artifact。

没有可复用入口时，应用下载官方 npm tarball 和官方 Windows x64 Node ZIP。安装不运行 npm、包里的安装脚本或远程 PowerShell 安装器，不修改 PATH，也不影响现有全局 npm/Node。官方 GitHub bundle ZIP 在本次环境中下载不稳定，最终采用相同官方发行方的 npm 发布包；无需给 GitHub 签名 CDN 地址开放宽泛 query 或 redirect 权限。

固定版本和完整性：

| 文件 | 官方来源 | 校验 |
| --- | --- | --- |
| Gemini CLI 0.63.0 tgz | [npm 元数据](https://registry.npmjs.org/@google/gemini-cli/0.63.0)、[官方包](https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-0.63.0.tgz) | npm SHA-512 integrity 与应用内固定值一致，20,810,043 bytes；另校验 SHA-256 |
| Node 22.22.2 win-x64 ZIP | [官方校验清单](https://nodejs.org/dist/v22.22.2/SHASUMS256.txt)、[官方 ZIP](https://nodejs.org/dist/v22.22.2/node-v22.22.2-win-x64.zip) | 官方清单必须唯一匹配应用内固定 SHA-256 |

Gemini SHA-512：`mmhqMmAdsoplCzrLQQC4yJBqr4uSKXghnrLspgUU6N9drmsaq7pi7oF09skRYzEq2dYK6eMT4UpFQP6rG2o/ew==`。

Gemini SHA-256：`97a6edfc10645463b517f0518d46a8c72efbdc12558a9a948607f726284a0420`。

Node SHA-256：`7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c`。

目录固定为：

```text
<data-dir>/runtimes/gemini-cli/0.63.0-<本次随机 UUID>/
  payload/package/bundle/gemini.js
  payload/package/bundle/<其他官方 chunks/vendor/assets>
  node/node-v22.22.2-win-x64/node.exe
  agentroom-runtime.json
```

不能只复制 `gemini.js`：真实 npm 包有 449 个普通文件、98,439,442 bytes 内容，包含多个 chunks 和第三方资源。安全 TAR reader 校验 gzip、TAR header checksum、USTAR prefix、完整结束标记和大小上限，只接受 `package` 根下的普通文件/目录；拒绝路径穿越、Windows 保留名、重复大小写路径、文件目录冲突、symlink/hardlink、PAX/GNU 扩展。Node ZIP 同样在验证 SHA-256 之后校验中心目录、路径、链接、边界重叠及展开大小，并只接受 `node-v22.22.2-win-x64` 根。

展开后的全部 package 和 Node 文件均记录路径/SHA-256；复用时核对完整文件清单和每个 digest，缺失或变化的 chunk/vendor/Node 文件会在新的 UUID 目录重新安装，旧文件保留。只有两个 `--version` 与固定版本一致才发布运行时路径：`AGENTROOM_GEMINI_PATH=node.exe`、`AGENTROOM_GEMINI_SCRIPT=package/bundle/gemini.js`。`connected:false` 表示安装完成尚未真实协作握手。

下载仅允许固定官方 HTTPS host/path，不允许附加 credentials、query、外部源或其他 npm package；Windows 网络故障可使用既有静态系统代理下载 helper，URL 和私有目标文件通过 stdin 提供，保留 TLS 和体积限制。失败结果返回 `stage`（元数据、下载、校验、展开或版本检查），只清理本次已验证属于应用根的 UUID 目录。

包没有普通 `dependencies`，有 keytar/pty 等 `optionalDependencies`。应用不额外安装它们；受控 headless 路径和实际官方包的版本启动需要独立验收，账号认证、可用额度和模型问答还需要用户自己的真实握手。安装成功不等于 Google 账户可用。

## 后台输出和会话身份

非 TTY stdin 触发 headless，使用 `--output-format stream-json`；任务正文通过 stdin 提供，不放在进程命令行。

真实输出形态与 Claude/Qwen 不同：

```json
{"type":"init","timestamp":"...","session_id":"真实 UUID","model":"..."}
{"type":"message","role":"assistant","content":"回答片段","delta":true}
{"type":"result","timestamp":"...","status":"success","stats":{}}
```

只接受 `init.session_id` 的实际 UUID 建立绑定。`init` 没有 cwd、工具列表、MCP 连接状态；`result` 也不保证有 session ID、答案或 turn UUID。答案来自 assistant message，必须同时有真实 init、成功 result、退出码 0 和非空答案。`turnId:null` 不虚构 provider turn ID。只看到 init 不能冒充 MCP 已连接；应用必须核对 `agentroom_join` 的真实 `ok:true` 和成员状态。

后续轮次传 `--resume <同一个完整 UUID>`，不用 latest、索引、continue 或另一个新 ID。Gemini 自己按当前项目查找会话；适配器以注册目录的 realpath、固定 spawn cwd、已绑定 UUID 和本进程会话项目表复核边界。跨应用重启后的讨论→项目身份关联由应用数据库持有。恢复报错、返回另一 UUID、取消、断流、缺结果或超时都不会自动创建替代会话或重发原问题。新建前未得到 init 的模糊结果标记 `creation_uncertain`，后续请求拒绝自动重建；已有绑定保留原 ID 并报告 `outcome_uncertain`。

来源：[官方 headless 说明](https://geminicli.com/docs/cli/headless/)、[会话管理](https://geminicli.com/docs/cli/session-management/)、[v0.63.0 nonInteractiveCli.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/cli/src/nonInteractiveCli.ts)、[sessionUtils.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/cli/src/utils/sessionUtils.ts)。

## 输入预处理必须单独防护

Gemini headless 在模型请求和工具 policy 之前仍处理 `/命令` 和 `@文件`。所以把一个来自其他 agent 的 `@C:/private/.env` 原样传给 stdin 并不安全，仅禁用 shell 或依赖工具权限不足。

实际输入使用受控的非 slash 前缀，任务、发送者、项目名和额外指令全部作为 JSON 字段。所有 literal `@` 编码为 JSON `\u0040`；模型可以解码内容，CLI 预处理器看不到 `@`。该转换是数据编码，不是过滤掉任务。包括 `\@`、多个 `@`、Windows 引号路径、成员名也统一编码。

来源：[v0.63.0 atCommandProcessor.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/cli/src/ui/hooks/atCommandProcessor.ts)、[nonInteractiveCli.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/cli/src/nonInteractiveCli.ts)。

## 调用范围与临时配置

固定参数：`--approval-mode default`、`--allowed-mcp-server-names agentroom`、`--extensions none`、`--policy <本轮专用文件>`。不会启用 yolo。`tools.allowed` 只是免确认规则，不是工具白名单；不能用它代替约束。

临时 settings 使用官方 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`；文件位于应用 data-dir 的 `gemini-runtime`，每轮以独立随机名称、exclusive create 写入，结束后删除。持久手动 MCP 接入的官方位置是用户 `~/.gemini/settings.json` 或项目 `.gemini/settings.json` 下的 `mcpServers.agentroom`，结构为 `command`、`args`、`env`、`includeTools`。后台 adapter 不修改这些用户配置。

限制包括：

- `tools.core` 只允许 `read_file`、`glob`、`list_directory`。暂不开放递归 grep，因为仅约束搜索根目录无法证明匹配内容不包含项目里的凭据。
- 专用 user-tier policy 默认拒绝所有工具，明确允许上述只读工具及 12 个 AgentRoom 通信工具；高优先级规则拒绝 `.env*`、各 CLI 私有目录、SSH/AWS、本应用数据和 secrets 路径。附加 ignore 文件进一步限制文件发现。未知新工具按拒绝处理。
- AgentRoom MCP 使用 `includeTools` 严格列举通信操作，不开放安装、成员配置、例程、原生群管理等应用控制工具。实际模型工具名可能是 `agentroom_agentroom_join`，policy 使用 `mcpName="agentroom"` 加原始 toolName，不猜别家的 `mcp__` 命名。
- hooks、扩展、skills、子 agent、自动记忆、todo、worktree、自动更新、遥测和通用 `.env` 加载关闭；自定义工具 discovery/call command 关闭。保留 provider auth 环境，移除 debug、system prompt 文件、活动日志和 IDE stdio command 环境覆盖。
- 自有 policy 使用 `--policy` 的 user 层，未用 `--admin-policy` 覆盖中央管理员规则。如机器已有系统级 settings 或显式系统 settings path 指向真实文件，返回 `gemini_managed_settings`，不会替换或读取它。远端企业管理配置仍可能阻止接入；不要绕过。
- `shell:false`、`windowsHide:true`；每轮只终止自己持有的 child。出错时返回固定可处理状态，不把原始 provider stderr、密钥或任务正文写进错误日志。

来源：[官方配置层与参数](https://geminicli.com/docs/reference/configuration/)、[Policy Engine](https://geminicli.com/docs/reference/policy-engine/)、[MCP 配置](https://geminicli.com/docs/tools/mcp-server/)、[v0.63.0 config.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/cli/src/config/config.ts)、[settingsSchema.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/cli/src/config/settingsSchema.ts)、[policy/config.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/core/src/policy/config.ts)、[mcp-tool.ts](https://github.com/google-gemini/gemini-cli/blob/v0.63.0/packages/core/src/tools/mcp-tool.ts)。

## 应用接线接口

```js
const { GeminiClient, MIN_VERSION, versionSupported } = require('./gemini.cjs');
const client = new GeminiClient({
  executable, args: officialEntryArgs, dataDir, env,
  mcpEnvironment: { AGENTROOM_MEMBER_ID: memberId },
  developerInstructions
});
const health = await client.status();
const result = await client.run({
  project, discussion, request, signal,
  onBinding, onTurn, onProgress, timeout
});
// result: { threadId, turnId: null, answer, permissionDenials }
await client.close();
```

`project.path` 必须是注册目录，`project.canonical` 为其 realpath。`discussion.thread_id` 只能来自真实 init；`discussion.binding_state` 的 creating/bound/creation_uncertain 更新要持久化。status 的 authConfigured 只能支持“待握手”，不能当作已上线。

明确需要用户处理的错误包含 `gemini_login_required`、`gemini_quota_required`、`gemini_resume_required`、`gemini_mcp_setup`、`gemini_managed_settings`、`gemini_upgrade_required`、`gemini_tool_scope_mismatch`；这些错误带 `needsAction:true`。

## 验证与未验证事项

`node --test tests/gemini.test.cjs` 使用受控 Node fake CLI 子进程，覆盖真实事件结构、新建/恢复身份、路径边界、无原生 turn UUID、任务预处理编码、工具限制、权限拒绝、认证/额度错误、超时、取消、进程退出、禁止并发和临时文件清理。没有调用 Google 模型、网页登录、付费、全局安装或读取真实凭据。

`node --test tests/gemini-runtime-installer.test.cjs tests/runtime-installer.test.cjs` 使用受控 fetch/extractor/runner 与小型 TAR/ZIP fixtures，覆盖来源、两个 artifact 校验、依赖完整收据、复用/损坏替换、stage、失败清理、拒绝链接/路径穿越/ZIP bomb、固定 Node/CLI 元数据、现有官方 npm 入口复用，以及原 Qwen/Claude 安装器兼容性。测试不下载真实包、不运行模型。本次另只读解析了经过完整性校验的官方 Gemini tgz，确认全部 449 条目可处理。

fixture 测试证明 adapter 的协议处理与边界，不证明当前用户的 Google 账户可用，也不证明真实 MCP join 已发生。产品只有完成原生 CLI 实际 join 后才能显示 ready；Gemini 网页会话仍是独立入口。
