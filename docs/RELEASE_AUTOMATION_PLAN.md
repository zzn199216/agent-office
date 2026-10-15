# 发布自动化与无界面验证构想（交给 Codex 实现）

实现状态（2026-10-15）：用户已授权逐步修复与实现。三项审计修复、发布流程、固定提交队列、隐藏任务安装入口及 CLI 诊断均已落地，操作说明见 [RELEASE.md](RELEASE.md)，验证记录见 [HANDOFF.md](HANDOFF.md) 与 output 下的逐次报告。以下保留原设计背景；不要据此重复创建流程。缺失 threadId 的请求现明确拒绝；其他三项产品/身份/刷新决策保持原语义。

起因：0.15.0-preview.4 的构建只能在 Windows x64 主机上跑（`scripts/build.cjs` 会拒绝其他平台），而审计/修复所在的云端环境是 Linux。这次只能靠电脑操作双击一个临时 `.cmd` 来触发，脆弱且依赖屏幕与授权。目标：构建、打包验证和发布检查全部可以用命令行触发、读结果，不需要界面。

## 原则

- 小步推进：每一步单独实现、单独测试、通过后单独 commit；不 push。
- 触发方只能请求固定动作，不能传命令；不碰用户数据目录（默认 `~/.agentroom`）、旧版本 release 目录、真实模型与个人客户端。
- 项目在 NAS 映射盘（Y:）上，递归扫描大目录（node_modules、release）很慢，脚本避免全盘扫描，临时数据放本地临时目录。

## 第 1 步：`scripts/release.cjs` 一条命令发布流程

- 顺序：`scripts/check.cjs` → 全量测试 → `scripts/build.cjs` → `validate-packaged-mcp.cjs` → `package-smoke.cjs` → 核对产物。
- 非交互，不弹窗、不 pause；任何一步失败立即停止，退出码非 0。
- 参数：`--skip-tests`、`--skip-build`（只做验证）、`--json`（结果写 `output/release-<version>.json`，含各步骤状态、耗时、日志路径、git HEAD 与是否干净、产物 sha256 与大小）。
- 非 win32 时给出明确说明并退出，不尝试交叉构建。
- 验收：在 Windows 主机上运行一次得到完整 JSON；故意让某一步失败时退出码与 JSON 都正确；单元测试覆盖参数解析与结果汇总（不真的构建）。

## 第 2 步：无界面触发器 `scripts/release-runner.cjs`

目的：云端会话把请求文件写进共享项目目录，主机上的小任务接手执行，结果写回同一目录，不再需要点击界面。

- 请求：`output/release-requests/<id>.json`，只含 `id`、`created`、`steps`（白名单枚举）、`expected_version`。不接受任何命令或路径字段。
- 状态：`output/release-status/<id>.json`，状态为 queued / running / ok / failed / rejected，含日志路径与结果 JSON 路径。
- 同一时刻只运行一个请求；超时（建议 20 分钟）终止；超过 10 分钟的旧请求忽略；`expected_version` 与 `package.json` 不一致时 rejected。
- 提供用户级（无需管理员）计划任务的安装与卸载脚本，并在文档说明如何确认、如何停用。
- 验收：用假执行器测试队列、单飞锁、超时、拒绝逻辑；人工在主机上放一个请求，确认状态文件正确更新。

## 第 3 步（可选）：内置命令行自检

让非界面部分能直接用命令行验证：

- `agentoffice selftest --json`：在临时目录用假客户端跑审批、权限审查、秘书指派、房间删除等核心路径，输出结构化结果。
- `agentoffice approvals --json`：列出当前待确认审批与操作检查记录（只读），便于排查“提醒不消失”这类问题。
- 前端逻辑已有 vm 夹具测试，这一步不重复。

## 上次审计遗留的待决项（不要擅自改，先确认）

1. `approvalsReviewer: 'auto_review'`：可写项目下由原生自动审查放行日常操作，是产品决策，需用户明确确认。
2. `workspaceOwner` 要求标记里的 `legacy_home` 与当前一致：显式更换 Codex 保存目录会报“身份不匹配”，以前放行。
3. 秘书长时间未就绪时每次 refresh 多触发一次状态刷新（至多两倍，不递归）。
4. Codex 审批事件处理现在要求 `threadId` 完全匹配，缺失 threadId 的请求会被忽略而不回应；协议上应有该字段，建议补一条日志或回应拒绝，避免对端无限等待。

## 其他备忘

- 云端会话环境没有配置 Git 身份；提交时用环境变量借用仓库已有作者，不改 git 配置。
- 构建日志与结果放 `output/`（已被 .gitignore 忽略）。
