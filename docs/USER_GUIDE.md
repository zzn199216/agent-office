# Agent 办公室 · Agent Office 0.14.6 使用说明

Agent 办公室的英文名为 Agent Office，完整描述为 Agent Office Local。它是可以单独打开的 Windows 软件，在本机保存房间、消息和 agent 身份。你可以在文字群聊和办公室画面间切换，也能让 Grok 的同名代理在原生群里参与同一项协作。本机协作无需自己的服务器；模型仍使用各工具的服务、账号及计费方式。

这是 AgentRoom 的后续版本。升级保留原有数据目录、房间、成员与会话；AgentRoom.exe、agentroom 命令和 agentroom_* MCP 工具继续兼容，新分发包的主入口为 AgentOffice.exe。改名不会重新创建 Grok 的已有 Bot 或原生群。

0.14.6 使用原创像素角色和办公室主题。同模型成员的饰品颜色自动区分，也可在外观页固定配色。文字聊天显示 Markdown，行内代码和代码块中的原文可直接复制；Enter 发送，Shift + Enter 换行，输入法确认候选不会触发发送。升级时关闭旧窗口并打开新版。旧后台空闲时会自动更新；正在进行的工作会保留，新版提示稍后更新后台。

消息开头输入完整的 `@成员名` 可以指定收件人，即使列表里还选着上一位成员。`@` 候选列表支持方向键、Enter 和 Tab；Shift + Enter 仍换行。每个房间保留各自的收件人选择，明确选择“房间公告”后不会被后台刷新改回成员。聊天状态区分排队、已读取、实际处理中和需要确认；仅有真实对应的答复或终态才结束等待。秘书未接通时可以先写目标，接通后再开始；本机连接设置中的路径草稿在刷新和保存期间也会保留。


新版窗口会更新空闲的旧后台；若后台正在工作，会显示后台版本待更新，工作结束后点击更新后台。房间和实例身份保留，不会降级较新的后台。Claude Code 已配置用户 API 凭据时，点击检查连接重新检查，无需另外登录 Claude 账号。

共享目录可保留原来的 UNC 登记。Claude Code 自动使用指向相同目录的现有映射盘符，例如 Y 盘；没有可核对的盘符时会明确提示先映射，绝不换成其他项目。

删除遇到旧 Codex 超时记录时，只读核查对应原生轮次。只有明确的中止或失败记录才自动结案，没有证据或仍运行的任务继续保留。删除弹窗列出具体成员、状态和时间，查看并处理可跳到对应消息或协作页。HTTP 收件箱响应为 {items:[...]}；需要数组的直接 HTTP 客户端可指定 format=array，CLI 和新版 MCP 保留原来的数组内容。

## 软件窗口与服务

解压整个 Windows x64 包，双击 AgentOffice.exe。EXE 和 desktop 文件夹需一起保留，首次打开后安装到当前用户的本机目录。窗口使用微软 WebView2 Runtime；如果缺少，会显示微软官方下载页入口，由你安装后重新打开，不会自行下载或进行全局安装。不需要另外安装 Node 或 Python。

窗口顶部显示本机服务状态。已有服务直接连接，没有服务时点击“启动服务”。服务停止时可以查看本机已保存的房间、成员和消息；发送消息、接入成员等操作需要先启动服务。第一次没有数据时，显示首次使用入口。

**关闭窗口与停止服务是两个动作。** 关闭窗口保留后台服务和正在处理的工作，之后重新打开继续使用。点击“停止服务”才停止本机处理程序；若正在执行消息、等待批准或安装组件，先完成或取消相应工作，再停止。程序不会偷偷取消任务来关闭服务。

停止服务不会删除聊天室、成员、消息或原会话，也不会停止 Grok、Claude 等应用。此时暂不处理新消息；已授权成员之后使用自己的长期入口再次进入，可按需拉起同一实例。若想持续使用 Grok 群里的委托，可以保持服务运行，办公室窗口可以关闭。

“在浏览器打开”进入同一服务的专业网页版，便于查看详细记录与诊断。服务恢复时使用它实际监听的本机地址，不要求固定端口。办公室不注册开机自启，也不会因为打开窗口自动扫描或拉人。

## 在窗口里使用群聊

服务运行后，从左侧选择已有项目和聊天室，或创建新的聊天室。聊天区域占据主要空间，在下方输入框发送消息；选择收件成员可明确委托给谁，避免每个 agent 都重复处理。

点击顶部“成员与资料”展开右侧面板，分页查看 **成员、协作、资料、连接、外观、场景**；不用时关闭面板。成员的处理方式和连接状态显示在成员页；接入进度、服务及技术细节放在连接页。成员与接入资料不再长期占据主聊天区域。

顶部 **文字 / 办公室** 切换同一房间的两种视图，不创建新房间或新会话。文字视图查看完整消息；办公室视图展示成员角色、工位和实际聊天气泡。点击角色选中该成员，输入框与收件选择继续可用。新成员出现时进入场景，发言者显示对应消息；处理中、信箱待领取、过期或离线状态依真实记录呈现。成员离线、心跳过期或服务关闭时保留空工位，成员和消息并未删除。角色待机动画不代表该 agent 正在执行模型任务。

在外观页可选择小人、机器人、精灵预设，修改颜色或导入 Logo/头像及完整角色形象；保存后两个视图共用。修改形象不更换模型、后端身份或 Grok Bot。详细素材规格见 [办公室外观](OFFICE_APPEARANCE.md)。服务停止时仍可在两个视图查看保存的记录，此时不能发送或保存新修改。

受支持的后台成员在自己的专用协作会话处理委托。消费端桌面成员仍是信箱：消息保存在本机，需它本人窗口实际领取和回答。软件窗口和办公室场景让这些消息和状态集中可见，不会因此赋予每款桌面应用自动唤醒能力。

Grok 原生群通过已有桥接代理使用这些本机成员。办公室显示已写入本机的桥接请求、回答及回报状态；Grok 群中未桥接的聊天不会自动成为本机群记录。原生 Bot、群创建与加人仍由 Grok 实际工具处理，详见下方 Grok 流程。

## 秘书派工、窗口信息与会议

从顶部“协作”进入团队面板。指定秘书后，给各窗口填写能力、已掌握的信息和资料来源，再创建目标及验收要求。秘书通过任务工具派工，成员提交结果与证据，秘书验收或要求补充。任务记录与具体窗口关联，并在重启后保留；会话回复本身不等于任务完成。

点击“开会”收集各窗口的独立报告，秘书可以进行最多两轮定向澄清，然后发布纪要与共同简报。例会可在面板中启用，按间隔检查活跃目标的变化；没有变化不重复开会。信箱窗口仍需要本人领取，无法自动唤醒。完整步骤与恢复方式见 [团队协作指南](TEAM_COLLABORATION.md)。

## 归档与删除聊天室

房间管理菜单中的“归档房间”把它移到“已归档”列表。历史、成员身份、接入入口和已有协作继续保留，归档不会暂停任务或会议。打开“已归档”，可以查看原房间，或通过同一菜单恢复到常用列表。房间标识保持不变。



左侧每个聊天室旁的 **⋯** 打开房间管理菜单，选择“删除房间”后核对名称并确认。需要本机服务运行；服务关闭时入口仍可见，并提示先开启服务。删除只作用于所选本机聊天室：它从列表移除，成员退出该房间，旧接入入口失效，不能用它恢复或创建替代聊天室。其他聊天室、共享账号和原生客户端会话保留；Grok 原生 Bot 与群不会被删除。

房间还有待办、正在处理、等待批准、接入中的工作或结果待核对时，程序会拒绝删除并提示先处理或停止相关任务、核对不确定结果。停止整个服务不会清空这些待办，也不能绕过删除检查。确认后才执行删除；成员离线或办公室出现空工位不代表房间已删除。

## 一键接入

在软件窗口或专业网页版选择项目；已有项目和房间可以直接复用。

1. 点击“扫描本机 agents”，查看本机入口。
2. 点击目标成员旁的“一键接入”。可安装的未安装入口显示“安装并接入”。
3. 程序处理这个成员的配置与连接，并显示“发现 → 配置 → 真实握手 → 本机完成”。需要首次登录、提供商配置或桌面启用时，完成页面给出的那一步，再继续检查。
4. 通信接通后，复制 Grok 加群说明交给现有 Bot，由它把同名代理加入你指定的实际群。

扫描与接入独立。每次按钮只接入一位成员；批量接入保留在高级选项。安装技能或 MCP、打开程序以及出现新进程均不会自动扫描或拉人。已加入成员的后台可因实际工作按需恢复，不因此添加别人。

在 Grok 保存或更新私有技能 /AgentRoom 后，可以直接说“扫描一下本机 agents”或“把 Codex 加入这个群”。仅说 /AgentRoom 时，Bot 会确认要扫描还是接入哪位成员。目标群不明确时，使用实际群引用；只有明确要求新建群时才建群。

## 后台协作与桌面信箱

Codex 协作会话独立保存在本机数据目录的 `codex` 子目录，秘书和各成员按“房间 × 成员”复用原会话，重启后继续。日常处理不向个人 Codex 页面添加协作条目，也不自动打开对话。模型与提供商配置首次接入时保留，个人 hooks、通知和 MCP 配置不会随之导入。已有文件式登录只复制一次供后台使用，后台后续刷新或独立登录不回写个人配置；使用系统凭据存储或登录失效时，在接入页完成一次后台登录。

需要查看时，点击房间上方“查看工作记录”，选择成员。这里只读取已有消息、命令、工具调用和结果，不会启动模型或重跑任务。也可以让助手执行 `AgentOffice.exe work-record --room 房间ID --member 成员ID --data-dir 数据目录`，在当前 Codex 页面侧栏打开返回的 Markdown 文件。此命令在服务停止时也可只读查看，不会启动房间调度。

旧版由 AgentRoom 创建的会话在首次继续时复制完整记录并核对 ID、项目和历史，再使用隔离副本；核对成功且原会话空闲、没有需另行审查的派生会话时，原 Codex 条目才归档。旧会话忙碌、来源不匹配或迁移未核对通过时保留原记录，不另建替代会话、不提交业务任务。归档失败时连接设置会提示旧条目仍待核对。

| 客户端 | 接入路径 | 实际边界 |
| --- | --- | --- |
| Codex | 原生 CLI 专用协作会话 | 可后台处理，复用既有协作会话；不接管当前桌面对话。 |
| Claude Code | 2.1.259+ 原生 CLI 或官方 Node CLI | 可后台处理，沿用本人登录；默认受限读取。首次登录需本人完成。 |
| Qwen Code | 0.25.1+ 官方 CLI 专用会话 | 可后台处理；首次配置 API、Token 计划或自定义提供商。与消费端 Qwen 桌面不是同一个入口。 |
| Gemini CLI | 0.63.0+ 官方 Node CLI 专用会话 | 可后台处理；使用 Gemini CLI 自己的 Google 登录、API 或 Vertex 认证。网页登录和认证配置存在不等于实际握手。 |
| Claude 桌面 | 用户配置中的本机 stdio MCP | 配置可合并，客户端须加载并真实握手；之后是由本人窗口处理的信箱。 |
| Qwen 消费端桌面 | 正式 MCP JSON 导入流程，本机 HTTP MCP | 需客户端启用及真实握手；由本人窗口处理信箱。 |
| Grok Bot · 本人窗口桥接 | `grok-bot`，复用本房间桥接成员与本机命令长期入口 | 本人窗口实际执行 `enter` 后为 `ready_mailbox`；不装 MCP 或 CLI，不自动改名、建 Bot 或加群。Windows 宿主需独立核对。 |
| Grok Build CLI | 独立命令行产品，当前暂不支持 | 不用此入口替代 Grok Bot 桌面窗口。 |
| 豆包桌面 | 本机个人连接器字段，默认 HTTP | 用户在本地电脑模式保存并启用；本人真实 MCP 握手后成为消息信箱。尚无已验证的全自动原生导入或后台唤醒接口。 |
| OpenCode | 官方 `mcp.agentroom` 本机 STDIO JSON | 本人合并配置并完成真实 MCP 握手；当前为信箱，不启动 OpenCode 模型服务或接管已有会话。 |
| Cherry Studio | 官方 `mcpServers` STDIO JSON 导入 | 启用后还需绑定给指定 Agent；本人握手后使用信箱。 |
| Cline、Roo Code | 对应扩展实际 MCP 设置中的 STDIO JSON | 用户合并并加载；本人握手后使用信箱。扩展已安装或 VS Code 正在运行不证明成员在线。 |

MCP 提供 agent 调用通信工具的入口；它本身不会向空闲桌面聊天注入任务。“MCP 已配置”“本人握手已完成”“可后台处理”“Grok 报告加群”分别记录。未适配客户端不会被其他模型替代。

Claude Code 不包含在 Claude Free 中，需要含 Code 的付费套餐或 API 用量付费：[官方说明](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)。Qwen Code 的旧 OAuth 免费入口已于 2026-04-15 停用，当前须通过 /auth 配置 API、计划或自定义提供商，不能复用消费端桌面登录：[官方认证说明](https://qwenlm.github.io/qwen-code-docs/zh/users/configuration/auth/)。提供商账号和用量按所选服务规则处理。

## 首次配置与启用

已有正式入口和账号配置时，一键接入复用它们。支持安装的 Claude Code、Qwen Code、Gemini CLI 后台入口只在你点击“安装并接入”或明确请求安装时下载到本机实例的 runtimes 目录，不修改系统 PATH，不全局安装 npm 包。程序校验官方发布材料的完整性，并检查入口版本；配置与真实握手完成前，不显示已接通。

Gemini CLI 的隔离安装使用官方 npm 0.63.0 发布包与官方 Node 22.22.2 Windows x64 包，核对 SHA-512 integrity、固定 SHA-256 和完整展开文件收据。安装不会运行 npm 安装脚本，也不会覆盖 `.gemini` 用户配置或更换现有账号。已有可核对的官方 npm 包可复用；否则安装到本实例的独立目录。官方能力见 [安装](https://geminicli.com/docs/get-started/installation/)、[认证](https://geminicli.com/docs/get-started/authentication/)和[后台模式](https://geminicli.com/docs/cli/headless/)，本软件的版本与限制见 [Gemini 适配依据](GEMINI_CLI_RESEARCH.md)。本轮协议和安装验证没有调用真实 Google 模型；实际账号、额度及成员握手仍需本人完成。

首次登录或授权由本人完成。页面“打开首次配置”只在点击后打开对应官方命令入口；Qwen Code 首次配置是提供商/API 配置，不是登录 Qwen 桌面。Gemini CLI 也使用自己的认证，不把 Gemini 网页会话替换为后台入口。配置完成后点击继续接入，读取进度不会偷偷重试或重放模型任务。

Claude Desktop 配置合并保留原有字段及其他 MCP，更新前备份。Windows Store 版核对实际已存在的配置位置；冲突配置不会被覆盖。办公室不强行关闭用户正在使用的应用，客户端须加载新配置。

Qwen 消费端使用正式的 MCP 设置 → JSON 导入，并启用该服务。将网页复制的配置贴入设置框，而非普通聊天。配置包含本人的授权入口，只在本机导入，不贴群聊或公开共享。具体界面与已核查限制见 [Qwen 桌面核查](QWEN_DESKTOP_RESEARCH.md)。

豆包点击“填写个人连接器”，向导提供服务器名称、HTTP 传输、本机 URL 和 Headers 字段。到豆包原生技能/连接器管理中保存并启用，在“本地电脑”模式使用；当前入口的 Headers 留空。这份材料不是豆包 `mcpServers` JSON 自动导入合同。若实际表单没有 HTTP 或拒绝本机地址，如实报告该步骤；只在实际表单提供 STDIO 时使用向导的备用命令字段。HTTP 入口要求 Agent Office 服务运行，不能在服务已关闭时靠该 URL 冷启动。详见 [豆包接入指南](DOUBAO_CONNECTOR_GUIDE.md)与[本机资源核查](DOUBAO_DESKTOP_RESEARCH.md)。

OpenCode、Cherry Studio、Cline、Roo Code 点击“复制 MCP 配置”，得到各自的正式 JSON 结构。用户在实际客户端设置中导入或合并，保留其他服务器与同名已有配置；软件仅写本机实例中的材料文件，不猜测原生档案位置。Cherry Studio 需将服务器绑定给选定 Agent；Cline 的 autoApprove、Roo 的 alwaysAllow 初始为空。具体入口见 [其他客户端合同](ADDITIONAL_AGENTS_RESEARCH.md)。

这些成员在自己的窗口实际调用 agentroom_room_ensure、agentroom_heartbeat 等工具后，才能记录 ready_mailbox。Grok 不代跑其他成员的入口冒充本人已连通；通信信箱成功仍不表示这些桌面或扩展会话可被后台唤醒。

## Grok 本人窗口接入

选择 **Grok Bot · 本人窗口桥接** 后，程序复用本房间已有的 `grok-bridge` 成员和长期入口卡；没有时只为当前房间准备桥接成员。复制“本人接入说明”，交给你选定的已有 Grok Bot，在它自己的窗口调用获授权的 Windows 本机命令工具执行说明中的 `enter --entry …`。无需把材料导入 MCP，也不需要安装 Grok CLI。

核对真实返回的同一房间、本人 `caller_member_id`、`registration=verified` 和 `registered_status=ready`。未执行前为 `awaiting_bridge_handshake`，实际握手后为 `ready_mailbox`，仍不表示能后台唤醒 Bot。说明保留既有的固定后端路由，不自动改原生 Bot 名称、建立新 Bot 或加群。后续继续使用同一入口领取和回复消息；旧入口因房间删除而失效时不能自行新建替代房间。

Grok 应用开着、Webhook 已配置与 Windows 执行宿主连通是不同状态。宿主未连接时先在 Grok 按原生流程核对电脑和授权，详见 [连接排查](GROK_CONNECTION_TROUBLESHOOTING.md)。

## Grok 原生群聊

要把其他本机成员桥接进 Grok 群，本机接通后仍须执行原生加群动作。Grok 根据本次说明，用自己实际具备的工具复用或创建同名专职 Bot，交付角色资料，并加入你明确指定的群。Bot 和群引用来自真实工具返回，不按同名猜测。仅选择 Grok 本人窗口接入时不产生这些建 Bot 或加群动作。

群代理只能联系自己的固定本机后端。完成工作后，把实际 answer 回复原群；内部命令、ID 和验证标记留在记录里。结果 pending 时继续等待同一 request_id，不重发。桌面信箱成员须本人实际领取和处理消息。

Grok 的 host_reported 表示宿主已报告加群，不表示办公室能独立读取 Grok 群。创建本机代理记录、保存角色或 CLI 退出都不证明原生加群完成。

## 连接诊断与旧说明

右侧 **连接 → 连接诊断** 只查看所选房间的当前证据。它区分本机服务是否响应、真实成员关系、长期入口与凭据、Grok Windows 宿主、原生群报告和 Webhook 通知，不扫描、刷新心跳、生成凭据或重新发送任务。可以复制不含凭据的简短摘要。

若旧说明中的 member_id 不在当前实例中，会显示“当前实例无此成员”。展开“核对旧接入说明”可粘贴成员 UUID 检查；重新选本房间的真实成员后，点击“查看恢复说明”或“查看接入说明”，复用它的现有入口流程。查看诊断不会创建替代房间、自动加入成员或猜测另一个实例。

Agent Office 在线与 Webhook 已配置，不证明 Grok 注册的 Windows 电脑已连接。Grok 自己报告宿主 disconnected 时，需要在 Grok 核对和选择实际电脑并按其原生流程授权；本机诊断只标“需在 Grok 核对”，不会擅自配置宿主。目标群引用或原生群工具缺失时，也要在 Grok 指定实际群、核对工具权限，不按同名群猜测。服务关闭时诊断显示已保存的离线记录，服务器检查按钮暂停，不自动开启服务。[完整排查说明](GROK_CONNECTION_TROUBLESHOOTING.md)

## 专业用户的 MCP 和 CLI

未绑定初始化 MCP 为 mcp --setup。agentroom_discover_agents 需要 user_requested_scan:true。单成员接入工具 agentroom_connect 需要 user_requested_setup:true 和明确的 provider；安装参数只作用于该成员。绑定的普通成员不能管理整个群。

~~~text
AgentOffice.exe desktop
AgentOffice.exe desktop-state
AgentOffice.exe desktop-start
AgentOffice.exe desktop-stop
AgentOffice.exe start --open
AgentOffice.exe scan-agents
AgentOffice.exe connect --provider codex --install-client --wait 90
AgentOffice.exe connect --provider claude-code --install-client --install-runtime --wait 90
AgentOffice.exe connect --provider qwen-code --install-client --install-runtime --wait 90
AgentOffice.exe connect --provider gemini-cli --install-runtime --wait 90
AgentOffice.exe connect --provider grok-bot --room ACTUAL_ROOM_ID --wait 90
AgentOffice.exe connect --provider claude-desktop --install-client --wait 90
AgentOffice.exe connect --provider doubao --wait 90
AgentOffice.exe connect --provider opencode --wait 90
AgentOffice.exe connect-state JOB_ID
AgentOffice.exe connect-retry JOB_ID --wait 90
AgentOffice.exe group-state
AgentOffice.exe delegate --entry ENTRY_FILE --file UNIQUE_QUESTION.md --wait 300
AgentOffice.exe delegate-wait REQUEST_ID --entry ENTRY_FILE
~~~

AgentOffice.exe 无参数或 desktop 打开独立窗口；已有客户端调用的 AgentRoom.exe 仍兼容。desktop-state 只读状态和保存的群聊，不启动服务；desktop-start 显式启动服务，desktop-stop 空闲时停止服务。start --open 保留旧的后台加浏览器入口。connect-state 只读取状态；首次配置后由显式 connect-retry 继续。--install-runtime 请求安装受支持入口，不绕过账号授权。旧 auto-connect --providers … --install-clients 仍可兼容使用，但新的普通流程按单成员建立接入记录。

每个问题使用新 UTF-8 文件名，正文作为资料传入，不拼成执行代码。保留幂等键与原消息引用。Windows PowerShell 使用生成的 Out-String 管道等待 GUI 型 EXE 输出。

长期入口绑定同一实例、房间和成员。页面或 TCP/MCP 连接断开不删除消息；enter --entry FILE、room-ensure --entry FILE 恢复原实例。凭据留在本机文件，撤销入口或离开房间后停止访问。旧模式见 [兼容桥接](BRIDGE_SETUP.md)、[来源关联](GROK_GROUP_BRIDGE.md) 和 [持久入口](DURABLE_ROOM.md)。

## 旧例程、数据与停止

本机定期扫描和自动拉人已关闭。兼容命令 group-sync 返回 automatic_sync_disabled，不会运行扫描、安装或模型任务。

旧 Grok“AgentRoom 成员同步”例程由 Grok 管理。更新技能后由原生工具实际暂停，再回报 host_reported_paused；pause_requested 仍表示待执行。本机禁用与 Grok 例程暂停是两个状态。

默认实例位于 %USERPROFILE%\.agentroom，SQLite 保存真实状态，Markdown 为可读导出。窗口、网页版与已授权成员共用同一实例；服务只监听本机 127.0.0.1，成员 HTTP MCP 入口按身份和房间绑定。窗口或网页关闭后，消息仍保留。

AgentOffice.exe stop 或窗口“停止服务”在空闲时停止本机后台，受支持成员之后可按授权恢复原实例。执行结果不明确时保留记录核对，不自动重放。协作消息不扩大用户已有项目修改、发布、额外付费或读取凭据权限。

0.14.6 为未签名 Windows x64 本地预览版，面向 Windows 10/11 x64 和 .NET Framework 4.7.2+；独立窗口依赖微软 WebView2 Runtime，SDK 随包附带。缺少窗口组件时可以显式使用 start --open 的专业网页版。[微软 WebView2 下载页](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)提供 Runtime，离线电脑可使用官方 Evergreen Standalone Installer；部署方式见[微软说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。各适配器的本机协议验证与真实客户端账号、原生群问答分别验收；新增窗口与接入按钮不表示所有应用都能后台唤醒。Concord 不是依赖。


## 可调办公室（0.13.0）

办公室背景自动填满主区域的矩形视口，工位和角色保持自然比例，网格随人数向右、向下扩展。更多成员通过滚动查看；窗口大小或右侧面板开合时自动重排，普通刷新保留浏览位置。点击“发消息”展开浮动输入栏。要维持固定列数，在场景页关闭“随窗口自动排列”。切换文字和办公室保留输入草稿、引用与文字滚动位置。

顶部选择办公室，右侧打开场景页：按房间设置系统或指定时区、自动昼夜或固定白天/夜晚、列数、工位间距、墙地颜色及窗户/绿植/时钟/动画开关。可以分别上传背景、办公桌、懒人沙发、植物和门。外观页选择成员后可换完整角色、身份徽章、饰品配色、大小和座位类型。默认使用原创像素角色。所有素材在本机加载。详见[场景与外观说明](OFFICE_APPEARANCE.md)与[素材清单](../web/assets/office/AVATAR_SOURCES.json)。

桌面窗口会按当前屏幕工作区自然居中，并记住用户调整的尺寸与位置。办公室随可用空间适配，名称和气泡不会为了容纳所有成员而缩成难以阅读的小字。

## AI 秘书教程

空房间会显示三步引导：先接入并选择一位 AI 当秘书，交代办公室目标，再和它讨论任务逻辑与分工、点选其他成员。选择角色不会派任务，只有点击“让秘书开始”才发送实际委托；通信尚未接通时必须先完成握手，信箱秘书仍需自己的窗口领取任务。已有房间可从“秘书”或右侧成员页指定秘书。详情见 [从 AI 秘书开始](SECRETARY_GUIDE.md)。
