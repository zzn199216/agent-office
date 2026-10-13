# Codex 与 Grok Bot 协作调研

核对日期：2026 年 10 月 11 日，Asia/Taipei。

自动创建或复用 Codex 讨论有明确的协议基础。Grok 具有外部触发入口，但“返回指定原生对话”的能力仍需账户内验证。两端不能仅凭拥有同名聊天室而建立对应关系。

## 证据级别

| 标记 | 含义 |
| --- | --- |
| 本机实测 | 在当前设备执行了对应的只读操作 |
| 本机协议 | 当前可执行文件生成的 schema 声明了接口，未执行该变更 |
| 官方说明 | 官方产品文档或更新说明确认了能力 |
| 源码审查 | 阅读了固定版本的第三方实现，未部署运行 |
| 待验证 | 尚无足够证据证明该行为 |

## 本机现状

| 项目 | 结果 |
| --- | --- |
| 工作目录 | 用户选定的本机目录；首次检查为空，不是 Git 仓库；机器专用路径不随调研文档同步 |
| 本地项目 | 已登记的 AgentRoom 桌面项目；来自桌面 `list_projects`，真实项目 ID 留在本机登记中 |
| Codex | `0.162.0-alpha.17.2`；当前桌面附带的可执行文件 |
| Grok Bot | 可执行文件版本 `0.68.1`；观察到运行进程 |
| 工具 | Node、Python、Git 均可用 |
| 目录指令 | 当前目录及其父目录未发现适用的 `AGENTS.md` |

Grok 进程存在不证明账号已配置 webhook、MCP 或本机访问权限。没有读取登录资料、密钥或浏览器会话。

## Codex 能力

本机生成 schema，并启动独立 stdio App Server，执行 `initialize`、`initialized`、`thread/list`。目录过滤为本目录，`useStateDbOnly: true`。结果：连接成功，返回 1 条聊天元数据；没有调用创建、恢复或运行接口，也没有请求推理。

| 行为 | 接口或机制 | 级别 |
| --- | --- | --- |
| 查找保存的讨论 | `thread/list`，支持目录、来源等过滤 | 本机实测 |
| 新建讨论 | `thread/start` | 本机协议 |
| 继续绑定讨论 | `thread/resume`，要求 `threadId` | 本机协议 |
| 开始处理 | `turn/start`，要求 `threadId` 和 `input` | 本机协议 |
| 显示名称 | `thread/name/set` | 本机协议 |
| 侧边栏分组 | `threadSection/create`、`thread/section/move` 等 | 本机协议 |
| 创建桌面项目 | 当前导出的客户端方法中没有项目创建接口 | 待验证 |

完整字段及 schema 哈希见 [本机证据](evidence/local-capabilities.json)。元数据中的 `notLoaded` 是本轮独立 App Server 的观察，不能据此认定桌面中的同一聊天空闲或没有其他写入者。

本机 schema 没有在 `ThreadStartParams` 中提供 `projectId` 字段。设置 `cwd` 不等于验证了桌面项目归属。侧边栏 section 也不等于 project。当前项目已有登记，第一版应优先绑定它，之后验收新聊天的可见性。

[OpenAI App Server 文档](https://developers.openai.com/codex/app-server)说明了协议、事件和生命周期。模型完成必须由执行状态判断，不能将接口接受请求视为任务完成。

## 钩子的作用

Codex 有 `SessionStart`、`UserPromptSubmit`、`Stop` 等生命周期钩子，可用于载入讨论规则、附加信息和同步结果。它们在相应生命周期发生时执行，不能代替外部信箱的常驻接收器。`Stop` 可以要求当前流程继续，但闲置时不会因新 MD 文件而自然触发。

[OpenAI Hooks 文档](https://developers.openai.com/codex/hooks)同时说明钩子信任要求。设计阶段不安装钩子；初版可直接通过 App Server 完成运行和结果采集。

## Grok Bot 能力

官方更新说明确认 Routine 可有专属 Webhook URL 和 key，并接收请求正文。官方协作说明确认 Grok 内部 Bot 可异步发送消息、唤醒另一 Bot。两者均没有在本轮证明外部程序能创建或恢复任意指定 Grok 原生对话。

| 行为 | 结论 |
| --- | --- |
| 外部事件启动 Routine | 官方确认；本账号配置尚未读取 |
| 接收请求正文 | 官方确认；实际格式待探测 |
| Grok Bot 间异步交流 | 官方确认；不等同于外部 Codex 接入 |
| 调用我们的小型 MCP/HTTP 信箱 | 产品具备相关扩展方式；需安装后验证本账号访问 |
| 回到特定原生聊天 | 待验证；不能虚构 `conversation_id` API |
| 外部创建原生聊天 | 待验证；不调用猜测的私有端点 |

来源：[Webhook 更新](https://x.ai/changelog/bot)、[Bot 协作](https://docs.x.ai/grok-bot/chat-and-collaboration)、[Skills 与 Routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)、[云端电脑](https://docs.x.ai/grok-bot/computer-and-apps)。Grok 云端 `/workspace` 与本机目录分离；同名文件夹不代表同一份数据。

## 现成方案比较

| 方案 | 可复用部分 | 对当前目标的缺口 |
| --- | --- | --- |
| [Agent Room](https://github.com/agent-room-alkl/agent-room) | MCP 房间、监听、记录、任务与发言协调 | Codex 常依赖监听循环；不能据此证明冷启动和原生 Grok 对话路由 |
| [agent-channel](https://github.com/fl4p/agent-channel) | 文件消息、接收游标及等待机制 | Windows 使用轮询；云端共享与原生 UI 对话绑定仍需适配 |
| [grokbot-mcp-bridge](https://github.com/kinopeee/grokbot-mcp-bridge) | Grok Webhook、异步回调、查询和等待结果 | 没有 Codex worker；没有原生 Grok 对话创建或恢复实现 |
| 自建小接收程序 | 精确控制项目和讨论绑定、现有目录及证据 | 需要实现两端适配及恢复规则 |

推荐参考 Grok bridge 的回调流程，自己实现薄的项目路由层，不直接部署整套多人聊天室。

## Grok bridge 源码审查

固定版本：[`39dbeeacafb1e26ca5681ce727fe76fd71a1c072`](https://github.com/kinopeee/grokbot-mcp-bridge/tree/39dbeeacafb1e26ca5681ce727fe76fd71a1c072)，MIT。

审查 `app/tools.py` 和 `app/routes.py`：

- `ask_grokbot` 调用配置的 Routine，生成 run ID 和带 token 的回调地址。
- 结果可等待、查询和取消；每次提问调用都会产生新的 UUID，AgentRoom 还需要自己的重试去重。
- `/hooks/grokbot` 存储入站事件；可选回调是收件确认，不能作为 Codex 已回答的证据。
- 检查的源文件没有 Codex 执行适配器，也没有原生 Grok 对话 ID 的创建或续聊逻辑。

详见 [源码证据](evidence/bridge-review.json)。没有运行安装脚本、部署服务或调用真实 webhook。

## 决策

采用 Markdown 内容归档加事务状态库。触发和对话 ID 绑定由接收程序管理。先复用已登记项目，先实现一条专用讨论。桌面可见性、Grok 原生对话续聊和网络可达性列为独立验收项。
