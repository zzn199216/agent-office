# 从 Grok 群直接使用 AgentRoom：官方能力与最短流程

当前 0.4.1 的产品边界是按用户请求扫描、只接入用户点名成员，不启用定期扫描和自动扩充成员。下面保留 0.4.0 的早期能力调研与设计推断，不能用作重新启用自动同步的指令。

核查日期：2026-10-12。仅查阅官方公开说明，没有使用 Computer Use、私有缓存、内部接口或真实创建 Bot。下面把官方明确支持的能力与产品设计推断分开。

## 可以把用户入口缩成一次安装和一句话

建议入口是：用户安装 AgentRoom 本机 helper 与 Skill/MCP，在目标 Grok 群里发出“把这台电脑上的可用 agents 加入本群”。安装时保留宿主必要的本机执行授权；后续扫描、身份建立、成员对应、冷启动与问答由程序和 Grok 原生 Bot 处理。网页用于诊断，不作为每次使用的必经步骤。

这条流程中有两个操作者：AgentRoom 负责本机发现、可靠执行和记录；Grok 自身的 Bot 负责其账号里的 Bot、群和原生消息。MCP 是本机能力入口，Skill 是 Grok 代办流程，不能把“安装 MCP”等同于“拥有 Grok 全部群管理权限”。这是基于下列官方能力的产品方案，尚不是这些平台对 AgentRoom 的端到端承诺。

## Grok 原生 Bots 和群

| 操作 | 官方确认 | 对实现的要求 |
| --- | --- | --- |
| 创建专职 Bot | 现有 Bot 可以建议或创建一个有长期职责的 Bot | 让当前 Bot 原生创建；有真实结果才保存绑定。 |
| 命名、描述、头像 | Bot 菜单 / Edit Profile 可以编辑；官方更新记录还确认 Bot 可以修改自己的标题及头像形状、颜色 | 可以让对应代理自己改名；没有通用 `renameBot` 外部接口，不能只凭请求文字显示“已改名”。 |
| 复用已有 Bot | 文档支持找回已有 Bots、重复使用持久身份 | 以宿主实际找到的引用复用；相同名字不是同一个 Bot 的证明。 |
| 群成员 | 群目前支持 2–6 Bots，之后可编辑成员 | 超过容量时明确分组；不承诺所有本机 agents 无限加入同一个 Grok 群。 |
| 群内转交和唤醒 | Bots 可以发群消息，也能异步联系其他 Bot 并唤醒它 | 为每个外部 agent 配一个稳定的代理 Bot，宿主之间用原生转交；代理收到任务后调用实际外部 agent。 |

出处：[Create and manage Bots](https://docs.x.ai/grok-bot/bots)、[Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)、[Bot changelog，v0.51.0 自行修改标题](https://x.ai/changelog/bot)。

没有在这次官方文档检索中找到给第三方安装器直接管理 Grok Bot 身份、改名、编辑群成员、访问现有群会话的公开 REST / Windows 本地配置合同。应让 Grok 原生 Bot 用其实际可用工具执行这些操作；工具不具备某个操作时，只留下那个最小手动步骤。不得用 `api.x.ai/v1/responses` 的新模型会话假称已有 Grok Bot 或原群。

代理 Bot 可以名为 `Codex`、`Claude Code`，标签或描述标明“AgentRoom 外部 agent 代理”。一个本机 agent 对应一个稳定绑定，不再每次创建一个泛用“桥接 Bot”。同名多实例时补项目名；代理不自己猜测答案冒充外部 agent，必须领取真实结果再发回群。

## Skill、Plugin 与 MCP 安装边界

Grok 支持在聊天中请求“保存这套方法为 Skill”；私有 Skill 库为同账号各 Bots 共享，通过 `/` 引用。Marketplace 可安装打包的 Skills/Connectors。Team Bot 的所有者或管理者也能在聊天中配置其 Plugins、Skills、Files。由此可以请求保存一次 `/AgentRoom`，让后续代理沿用同一协作流程。[Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)、[Team Bots](https://docs.x.ai/grok-bot/team-bots)。

本次未找到 Grok Bot 桌面版公布的 `mcp.json`、本机 `SKILL.md` 安装目录、安装 URI 或无需宿主操作的 Skill/Plugin 导入 API。不要给 Grok Bot 写 `~/.grok/config.toml` 后声称安装完成；那个文件属于 **Grok Build CLI**，产品身份不同。[Grok Build Skills / Plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces)、[Grok Build MCP](https://docs.x.ai/build/features/mcp-servers)。

本机安装器可以装 AgentRoom helper、为有公开配置格式的宿主安装 MCP/Skill，并输出一份短的 Grok 引导请求。Grok 端由 Bot 保存私有 Skill / 原生安装支持的 Plugin。只有该宿主实测已列出工具或已保存 Skill，才显示“宿主安装完成”；本机文件写成功只说明本机安装完成。

## Windows 本机执行，不必再走公开服务器

Grok 官方明确区分云端 Bot computer 和用户眼前的 Mac/Windows 电脑。本机命令是独立能力：首次请求出现本机执行授权，允许一次或按本机策略持续允许。该选择作用于对应电脑上的所有 Bots；管理员可以限制它。产品应沿用用户已授权的本机命令入口，而不是每次让用户复制 PowerShell / 数据目录 / UUID。[Local computer permissions](https://docs.x.ai/grok-bot/approvals-security-and-privacy#control-access-to-your-local-computer)。

Command MCP 官方保证运行在该会话所用的 Bot computer，不保证因为 Grok app 在 Windows 打开，命令就落在用户 Windows。Remote HTTPS MCP 则要求调用方能到达它；普通 Grok Web 自定义 MCP 的官方说明要求公网可达，localhost 不可直接接入。无公网服务器方案应先用已授权的本机命令能力调用 helper；不能把云端 `/workspace` 或 `127.0.0.1` 指向用户电脑。[Team Bots — Plugins](https://docs.x.ai/grok-bot/team-bots#plugins)、[Custom MCP connectors](https://docs.x.ai/grok/connectors#custom-mcp-connectors)。

网络出口经桌面路由是另一个正式功能，不等于可直接读取本机文件，也不能据此宣称任意 Command MCP 已在本机运行。[Private networks](https://docs.x.ai/grok-bot/private-networks)。

## 豆包：发现 Windows 进程与接入当前会话仍须区分

豆包官方开放平台已经公布 Skill、Plugin（可打包 Skill/MCP/CLI）和 OpenAPI 的入口，并明确平台正在内测、可提交入驻意向。因此不能说“豆包没有开放能力”。本次能公开读取的开发者页面尚未给出普通 Windows 豆包已打开聊天的会话查找、后台发消息、唤醒或本机安装配置合同；不能仅凭 `Doubao.exe` 存在就标记“可自动接入”。[豆包开放平台](https://open.doubao.com/)、[技能接入入口](https://open.doubao.com/document/doubao-developer-guide/skill-integration-guide)。

火山方舟的豆包模型 / 豆包助手 API 是独立 API 接入能力。官方把豆包 App 与 API 区分，API 集成并不等同于控制用户当前打开的 App 对话。若未来增加这种 adapter，应明确叫“豆包模型 API”或“豆包助手 API”，单独授权凭据，不能自动替换成用户当前的桌面 agent 身份。[豆包助手 API](https://docs.volcengine.com/docs/ark/doubao-assistant?lang=zh)。

现在的发现列表可显示“豆包：已运行，宿主接入待适配”；面向已参加开放平台内测的用户，之后按其正式 Plugin/Skill 合同接入。不要走界面注入、私有 cookies 或反向工程的桌面请求来补齐。

## 最小可交付的日常流程

1. 安装器一次安装本机 helper，并为已支持宿主注册 AgentRoom MCP/Skill；入口绑定同一持久实例。
2. 用户在 Grok **目标群**执行一次 `/AgentRoom`（首次用一份短引导保存 Skill）：“把可用 agents 加入这个群”。本机权限尚未授予时，宿主只弹一次必要授权。
3. helper 扫描进程/已安装客户端和公开能力，返回可直接运行、需宿主接入、尚无适配器三个真实类别。运行状态本身不证明通讯能力。
4. Grok 代办创建/复用对应命名代理，绑定到实际外部成员、保存代理职责，加入明确群。AgentRoom 保存每项原生操作的结果；失败项在群中用一句话报告，网页留细节。
5. `@Codex` 或 `@Claude Code` 发问，代理自动确认实例、恢复后台、路由并等待真实结果，在原群回复；用户无需看 helper 参数、邀请、房间 ID 或处理回执。

第一版应把 Codex 和有正式无交互执行能力的 Claude Code 做到上述闭环。豆包桌面对话等暂无公开宿主合同的项目，显示“发现，暂不可桥接”，而不是让整个安装流程失败，也不让另一模型顶替它。

本次研究的验收界限：官方资料足以支持上述实现方向；不等于 Grok 当前账号已经接受新 Skill、所有原生代办工具都可用、豆包内测资格已获批，或所有代理已经加入群。后续每项按实际调用结果验收。

## 安装以后，新开 agent 如何自动同步进原群

**可以让 Grok 在对话中创建自己的定时 Routine，不需要用户先手工打开配置面板。** 官方示例直接要求负责的 Bot 按时间运行 Skill，Bot 会创建 Routine 并展示下次运行；定时最小间隔为五分钟，长时间无人使用可能自动暂停。因此可以把“保存 AgentRoom Skill”和“建立成员同步 Routine”合并成首次接入的一条指令，后续由 Grok 自身定时唤醒，而不是让用户每次重新发消息。[Create / manage routines](https://docs.x.ai/grok-bot/skills-routines-and-automations#create-a-routine)。

建议首次请求附上：

> 请在你自己的 Grok 原生例程中创建或复用“AgentRoom 成员同步”，每十分钟运行一次 AgentRoom 的成员同步步骤，使用刚刚明确指定的原群和已授权本机入口。一次只调用 helper 检查变化；没有变化就安静结束。有新增可用成员时，按已保存规则创建或复用对应代理并加入原群。保留实际 Routine 引用和下次运行时间，不重复创建。原群不可定位、本机不可达、工具不允许某个操作时报告对应待处理状态，不新建同名群。

这是可实现的**低频自动同步设计**。它仍会产生 Grok 原生 Routine 的模型工作和额度消耗，不能声称新进程出现就实时入群。电脑休眠、关机或本机访问权限失效时，云端 Routine 能运行也不代表 Windows helper 能执行。用户可以暂停 Routine；恢复后处理持久化的变化即可。

本机持续发现进程可以由普通 helper 完成，将变化去重写进状态机，不需要 LLM 一直扫描。原生 Bot 的创建/改名/加群由下一次 Routine 或明确宿主事件处理。不要安排无限 `while` 模型轮询、循环短等待，或让每个扫描 tick 都开启新模型任务。

**Webhook 已正式存在，但其秘密能否被 Bot 原生工具直接取得尚未被公开合同证明。** 官方更新记录确认例程可由 Webhook 触发、拥有 URL/key，并能接收请求体；本次检索的 Grok Bot 文档、[官方文档索引](https://docs.x.ai/llms.txt)和[公开 API schema](https://docs.x.ai/openapi.json)没有找到“读取自身 Webhook URL/key”的原生工具 schema。可以请求 Bot 优先原生创建并通过安全工具交付配置；只有实际拿到可保存的值才启用通知，不能默认可自动读取，也不能访问私有缓存或要求把 key 粘进群。未配置 Webhook 时，前述低频 Routine 不需要它。[Webhook routines / payload 更新记录](https://x.ai/changelog/bot)。

**没有查到任意本机后台命令结束、MCP 长等待结束就能重启已结束 Grok turn 的公开合同。** 更新记录确实说明 Grok 会处理自身后台工作的完成事件及排队更新，但没有规定第三方 detached process、磁盘文件变化或 MCP notification 的通用唤醒接口。当前可依赖的宿主唤醒入口是原生消息、已创建 Routine、已配置 Webhook；不能把本机 watcher 已启动显示成 Grok 原生自动同步已启用。[Background work 更新记录](https://x.ai/changelog/bot)。

网页应分别保存“本机发现已运行”和“Grok 同步 Routine 已实际创建”。后者需有宿主真实返回的例程引用、周期、下次运行等证据；只有生成了上面的指令时仍为待执行。Routine 的运行可能受宿主审批策略影响，后台审批过期不会执行动作，不能悄悄记为成功。[Background approvals](https://docs.x.ai/grok-bot/approvals-security-and-privacy#review-an-action)。
