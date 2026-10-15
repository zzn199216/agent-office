# 本机构建与验收

## 0.15.0-preview.8 Grok 接入引导

Grok 默认走已存在的本人本机工具桥接：主页面直接显示「复制连接说明 → 发给 Grok Bot → 自动检查连接」，不再把尚未实测的原生对话接口作为默认连接按钮。新增成员选择器和已有成员设置使用同一个引导，只保留一个弹窗；待接通时显示「稍后继续」，真实握手后进入办公室。Grok 群聊独立于人物接入。

连接状态轮询只读；缺少首次入口时仅在用户明确复制时准备，主动撤销的入口不会被轮询恢复。已有成员、长期入口与配置继续复用。原生接口缺失时在网络请求前返回明确原因。专用无头浏览器验收使用 `node scripts/validate-grok-guided-flow.cjs`，保留测试截图与结果于 `output/playwright/grok-guided/`；不操作真实 Grok 或用户窗口。

秘书聊天支持「接入一下 Grok」等明确口语请求，沿用同一份真实接入进度。能自动完成时继续自动接入；需要本人窗口操作时，聊天直接显示复制说明、发送目标和继续接入入口。秘书用普通语言说明当前进度和下一步，技术原因收在诊断中；复制说明、历史验证记录和应用开着均不算本次连接成功。

## 0.15.0-preview.7 连接连续性

- 已有原生人物连接使用持久化退避重连，沿用原对话；断线后的未决轮次先核对，不自动重发。撤销授权、没有房间时暂停，版本、身份、权限问题保留明确原因。
- 用户主动接入后，自动发送一次带关联标识的验证消息。正确人物的原生执行证据和实际回复吻合后，页面进入办公室；读取进度和重启不重复调用模型。MCP 信箱保持手动处理的能力说明。
- 稳定安装入口保存经过路径、安装标记和内容校验的当前 runtime。Windows 上旧 EXE 被 MCP 占用时，核对原文件后保留运行中的旧映像，将原命令路径切换到新版；其他文件锁不允许切换时才并排安装，稍后打开新版再更新稳定入口。
- 原凭据、URL、人物、会话、历史与其他 MCP 配置保留。稳定路径更新后，仍运行的旧 stdio 进程也能通过原路径启动新版后台，无需重配或结束该 MCP 进程。

隔离验收命令：

```powershell
node scripts/validate-onboarding-verification.cjs
node scripts/validate-connection-assist-ui.cjs
node scripts/validate-onboarding-layout.cjs
node scripts/validate-mcp-continuity.cjs release/AgentOffice-0.15.0-preview.7-windows-x64/AgentOffice.exe release/AgentOffice-0.15.0-preview.6-windows-x64/AgentOffice.exe
```

前三项使用专属无头浏览器与假原生客户端，不接触个人窗口和账号；最后一项用旧版程序创建临时数据库，保留原 stdio 进程并实际锁住旧 EXE，再升级到新包，核对原 HTTP 会话、地址、凭据、历史、人物原生会话和明确撤销状态；停止新版后台后，同一个旧 MCP 进程还须能启动新版。

## 产品命令行诊断

`agentoffice selftest --json`（源码入口为 `node src/main.cjs selftest --json`）在独立临时目录用假客户端检查审批、只读权限拒绝、秘书幂等指派和房间删除。输出逐项状态，失败时退出非零；清理临时目录，不启动服务或真实模型，也不使用指定的用户数据目录。该自检证明核心本机流程，不能代替第三方客户端和模型的真实验收。

`agentoffice approvals --json [--data-dir PATH]` 只从已运行的服务读取待确认请求和拒绝说明，不自动启动或恢复服务。服务关闭或无法访问时输出 `available: false`、`approvals: null`、`approval_reviews: null`，不能据此判断待办为零。已运行且可读取时才返回实际数组。成员入口卡不能调用这两个本机用户诊断命令。

发布流程的打包冒烟会再次执行最终可执行文件中的这两个命令，核对自检通过及离线诊断无副作用。

在 Windows x64、Node 22.13 或更新版本、已安装项目依赖的仓库根目录运行：

```powershell
node scripts/release.cjs --json
```

顺序为 JavaScript 检查、完整测试、隔离构建、打包 MCP、打包运行冒烟、最终文件夹和 ZIP 核对。检查失败立即停止并以非零退出。测试和冒烟使用临时数据及假客户端，不调用真实模型，不打开用户 AO，不安装或部署到用户数据目录。

每次运行记录在 `output/releases/<run-id>/result.json`，包含分步日志、耗时、源码 HEAD、是否干净、内容指纹、产物大小和 SHA256。`output/release-<version>.json` 是最近一次运行的索引，历史运行不覆盖。构建在本地临时目录完成，成功后只复制清单中的公共文件到 `release/AgentOffice-<version>-windows-x64`；目标已存在时追加 run-id，不覆盖历史文件夹或 ZIP。失败时保留本地临时目录用于诊断，其位置在结果 JSON 中。

`--skip-tests` 跳过测试；`--skip-build` 只验证最近一次与当前源码完全匹配的交付包，同时跳过构建和测试。两者都返回 `partial`、`fully_verified: false`，不能当作完整发布验收。旧包没有来源清单或源码已变化时，必须重新构建。结果 JSON 始终写入，`--json` 可用于明确脚本调用意图。

最终包的 `release-manifest.json` 绑定源码与公共文件指纹；干净提交使用 Git 规范化内容身份，另保留 worktree_fingerprint 字节摘要，兼容 PS1/CMD 的换行转换。验证同时核对桌面清单、全部 ZIP 条目和实际字节，拒绝额外文件、缺失文件、重复条目与路径穿越。运行中的源码变化会使验收失败。

此流程只生成本地交付包。不会上传、push、安装到默认数据目录或启动真实模型。直接运行旧的 `scripts/build.cjs` 仍保留兼容行为；日常使用上面的发布入口以获得隔离输出和完整报告。

## 无界面请求队列

`node scripts/release-runner.cjs --once` 读取 `output/release-requests/` 中的请求并按时间顺序处理。写入前先保存临时文件，再原子重命名为 `<id>.json`：

```json
{"id":"release-example-001","created":"2026-10-15T01:00:00.000Z","steps":["release"],"expected_version":"0.15.0-preview.6","expected_head":"填写提交后的完整 Git HEAD"}
```

时间必须更新为实际 UTC 时间。只接受 `steps: ["check"]`（仅语法检查）或 `["release"]`（完整构建验收）；不接收命令、参数或输出路径。ID 只用小写字母、数字和连字符，最多 64 字符。要求工作区干净、预期版本及完整提交都匹配，超过 10 分钟或明显来自未来的请求拒绝。

状态写入 `output/release-status/<id>.json`，包含 queued/running/ok/failed/rejected、日志目录和结果路径。同一主机运行一个队列执行器，并与直接发布入口共用发布锁；每项最多执行 20 分钟，取消会终止其拥有的子进程树。相同 ID 的终态永不重跑；失败后核对原因，以新的 ID 明确提交下一次请求。主机异常退出留下的 running 记录标为 failed，不自动重试。

每次执行从指定提交克隆到本地临时目录，使用已安装且版本符合 lockfile 的固定依赖，不执行安装脚本，不下载依赖。结果绑定实际快照；共享源码变化时不发布。仅复制 lockfile 中实际已安装的包，不递归扫描整个 node_modules 或历史 release。产物和日志复制回共享目录后移除快照。

安装当前用户的隐藏入口（无需管理员，每分钟检查一次）：

```powershell
node scripts/release-task.cjs install
Get-ScheduledTask -TaskName AgentOfficeReleaseRunner
Start-ScheduledTask -TaskName AgentOfficeReleaseRunner
```

安装器将映射盘转换为 UNC，启动脚本保存到当前用户 LOCALAPPDATA/AgentOfficeReleaseRunner，计划任务使用执行安装器的 Node 路径，按当前已登录用户、普通权限执行，忽略重叠启动，不出现交互窗口。NAS 上未签名 PowerShell 脚本可能受 RemoteSigned 限制，因此首选 Node 安装入口，无需修改执行策略。使用稳定的 Node 安装执行安装器，不依赖任务环境的 PATH 或 Y: 映射。可先创建一个 `steps: ["check"]` 的请求，然后查看状态及日志，确认主机读写链路。`node scripts/release-task.cjs status` 查看实际任务配置及最后退出码。

停用或卸载：

```powershell
Disable-ScheduledTask -TaskName AgentOfficeReleaseRunner
node scripts/release-task.cjs uninstall
```

正在构建时卸载脚本会要求等待完成，不删除请求、报告或交付包。账号未登录、NAS 不可访问或 Node 路径失效时，任务不能接单；这不代表构建已完成，必须以请求状态中的 ok 和完整发布报告为准。
