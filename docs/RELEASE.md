# 本机构建与验收

在 Windows x64、Node 22.13 或更新版本、已安装项目依赖的仓库根目录运行：

```powershell
node scripts/release.cjs --json
```

顺序为 JavaScript 检查、完整测试、隔离构建、打包 MCP、打包运行冒烟、最终文件夹和 ZIP 核对。检查失败立即停止并以非零退出。测试和冒烟使用临时数据及假客户端，不调用真实模型，不打开用户 AO，不安装或部署到用户数据目录。

每次运行记录在 `output/releases/<run-id>/result.json`，包含分步日志、耗时、源码 HEAD、是否干净、内容指纹、产物大小和 SHA256。`output/release-<version>.json` 是最近一次运行的索引，历史运行不覆盖。构建在本地临时目录完成，成功后只复制清单中的公共文件到 `release/AgentOffice-<version>-windows-x64`；目标已存在时追加 run-id，不覆盖历史文件夹或 ZIP。失败时保留本地临时目录用于诊断，其位置在结果 JSON 中。

`--skip-tests` 跳过测试；`--skip-build` 只验证最近一次与当前源码完全匹配的交付包，同时跳过构建和测试。两者都返回 `partial`、`fully_verified: false`，不能当作完整发布验收。旧包没有来源清单或源码已变化时，必须重新构建。结果 JSON 始终写入，`--json` 可用于明确脚本调用意图。

最终包的 `release-manifest.json` 绑定源码与公共文件指纹；验证同时核对桌面清单、全部 ZIP 条目和实际字节，拒绝额外文件、缺失文件、重复条目与路径穿越。运行中的源码变化会使验收失败。

此流程只生成本地交付包。不会上传、push、安装到默认数据目录或启动真实模型。直接运行旧的 `scripts/build.cjs` 仍保留兼容行为；日常使用上面的发布入口以获得隔离输出和完整报告。

## 无界面请求队列

`node scripts/release-runner.cjs --once` 读取 `output/release-requests/` 中的请求并按时间顺序处理。写入前先保存临时文件，再原子重命名为 `<id>.json`：

```json
{"id":"release-example-001","created":"2026-10-15T01:00:00.000Z","steps":["release"],"expected_version":"0.15.0-preview.5","expected_head":"填写提交后的完整 Git HEAD"}
```

时间必须更新为实际 UTC 时间。只接受 `steps: ["check"]`（仅语法检查）或 `["release"]`（完整构建验收）；不接收命令、参数或输出路径。ID 只用小写字母、数字和连字符，最多 64 字符。要求工作区干净、预期版本及完整提交都匹配，超过 10 分钟或明显来自未来的请求拒绝。

状态写入 `output/release-status/<id>.json`，包含 queued/running/ok/failed/rejected、日志目录和结果路径。同一主机运行一个队列执行器，并与直接发布入口共用发布锁；每项最多执行 20 分钟，取消会终止其拥有的子进程树。相同 ID 的终态永不重跑；失败后核对原因，以新的 ID 明确提交下一次请求。主机异常退出留下的 running 记录标为 failed，不自动重试。

每次执行从指定提交克隆到本地临时目录，使用已安装且版本符合 lockfile 的固定依赖，不执行安装脚本，不下载依赖。结果绑定实际快照；共享源码变化时不发布。仅复制 lockfile 中实际已安装的包，不递归扫描整个 node_modules 或历史 release。产物和日志复制回共享目录后移除快照。

安装当前用户的隐藏入口（无需管理员，每分钟检查一次）：

```powershell
.\scripts\install-release-runner.ps1
Get-ScheduledTask -TaskName AgentOfficeReleaseRunner
Start-ScheduledTask -TaskName AgentOfficeReleaseRunner
```

安装脚本将映射盘转换为 UNC，计划任务使用明确的 Node 可执行路径，按当前已登录用户、普通权限执行，忽略重叠启动，不出现交互窗口。使用 `-NodePath` 可指定稳定的 Node 安装；不依赖任务环境的 PATH 或 Y: 映射。可先创建一个 `steps: ["check"]` 的请求，然后查看状态及日志，确认主机读写链路。

停用或卸载：

```powershell
Disable-ScheduledTask -TaskName AgentOfficeReleaseRunner
.\scripts\uninstall-release-runner.ps1
```

正在构建时卸载脚本会要求等待完成，不删除请求、报告或交付包。账号未登录、NAS 不可访问或 Node 路径失效时，任务不能接单；这不代表构建已完成，必须以请求状态中的 ok 和完整发布报告为准。
