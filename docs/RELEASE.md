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
