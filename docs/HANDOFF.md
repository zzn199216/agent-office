# 交接说明：从云端会话转到本机 Claude Code

更新：2026-10-14。分支 `claude/pixel-office-overhaul`。`claude/connect-overhaul` 已快进合并进这个分支，可以删除。

## 最近完成（ac5000c）

- 成员凭据按成员发，不再按房间发。同一份 MCP 配置（stdio `--entry` 或 Qwen/豆包的 HTTP URL）在这个成员加入的所有房间都能用；没加入的房间一律拒绝。
  - 路由策略：`src/member-policy.cjs` 的 `requestRoom` / `assertMemberRoute`。
  - 传输层：`src/mcp.cjs` 和 `src/mcp-http.cjs` 各自再查一次座位。
- 同一个客户端再次接入时沿用已验证的成员：`launch.cjs` 的 `reusableMember`。已验证成员进入新房间不再握手。
- 新增 `POST /api/chat/members/cleanup`：把没接通的成员移出所有房间，聊天记录保留。
- 连接弹窗按客户端只给一种方法：`chat.cjs` 的 `clientGuide`，前端是 `renderConnectGuide`。Qwen 给 streamable-HTTP JSON；豆包给连接器字段；Claude 桌面给 stdio entry 配置；Grok 给命令说明；后台 CLI 不需要复制任何东西。
- 扫描改进：进程列表超时放宽到 15 秒，失败时退回 Get-Process；Qwen/豆包在 C 盘之外安装也能通过 `installMarkers` 识别。
- 服务端口优先使用 47831–47839，导入到客户端的 URL 重启后仍然有效。
- 接入卡片显示已用时间，需要确认的步骤直接在卡片上「允许 / 拒绝」；需要模型参与的握手超时改为 2 分钟。
- 默认进入办公室视图；没接通的成员也会显示状态；收件人默认是秘书，只有一位同事时默认是它。

## 待用户验证

在真实 Qwen 里导入一次新的 HTTP 配置，然后在新房间里确认不用重新导入也能工作。测试步骤见对话记录。

旧版 Qwen 配置绑在单个房间上，需要删掉后重新导入一次。

## 下一步（来自产品审计）

1. 首次使用压缩到 3 步：自动检测本机 agent → 选文件夹 → 直接进办公室。
2. 概念收敛到 5 个：办公室、同事、秘书、任务、需要你。会议、例会、Grok 桥接降为可选。
3. 加一个全局「需要你」收件箱，统一放确认、登录、待核对、信箱领取这几类事情。
4. 不 @ 任何人时，默认把消息交给秘书分派。
5. 拆分 `web/app.js`：现在约 1400 行，很多行超过 600 字符。

## 注意事项

- 仓库在网络盘 Y: 上，git 和测试都慢。删除文件可能失败，会在 `.git` 里留下 `stale-*` 锁文件，可以直接删掉。
- 在带有 `ANTHROPIC_*` 环境变量的 shell 里，`tests/claude.test.cjs` 会受宿主 Claude 配置影响而失败。跑这组测试前先清掉这些变量。
- 与 Codex 并行开发时，各用一个分支或 worktree，避免互相覆盖。
