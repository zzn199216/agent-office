# Agent 办公室 · Agent Office

把你选定的 agents 接入同一间办公室，在文字群聊和办公室画面之间切换。成员以独立身份徽章和完整角色形象入座，实际消息显示为办公室里的对话。角色可以是品牌吉祥物、机器人、动物或用户自己的形象，也能通过同名代理参与 Grok 原生群聊。

办公室采用极简卡通矩形布局，连续墙体沿上边缘铺开，左上方为入口。背景自动填满办公室区域，工位和角色保持自然比例，网格随成员增加向右、向下扩展；更多工位可以滚动查看。窗口大小或右侧面板变化时自动重排，普通刷新保留浏览位置。输入栏按需浮动展开，新成员沿走道从门口进入；刷新或重新打开画面不会让旧成员反复进门。默认头像来自官方公开产品形象或图标，并已本地打包；自定义形象优先。来源与设计调研见 [OFFICE_RESEARCH.md](docs/OFFICE_RESEARCH.md)。

英文名采用 **Agent Office**，完整描述为 **Agent Office Local**。这是 AgentRoom 的后续版本，原有房间、成员、连接及 MCP/CLI 接口继续兼容。Windows x64 本地预览版 **0.13.0**，协调与持久状态留在电脑里，无需购买服务器。模型使用各工具原有服务；订阅和 API 用量按对应服务计费。

## 使用

解压 release/AgentOffice-0.13.0-windows-x64.zip，双击 AgentOffice.exe，打开独立软件窗口。保持压缩包里的 desktop 文件夹与 EXE 一起使用；无需 Node/Python 或管理员权限。窗口使用微软 WebView2 Runtime，缺少时会给出安装入口。

在窗口中点击 **启动服务**，即可进入群聊和成员管理。服务已有运行时直接复用；关闭窗口后服务继续运行。点击 **停止服务** 才暂停本机消息处理，已有房间和记录保留，服务停止时仍可在窗口查看保存的群聊。已授权成员之后再次进入可按需重新启动同一实例。

空办公室先显示秘书教程：接入并选择一位 AI，交代目标，再和它一起梳理任务逻辑与成员分工。选择秘书不会派任务，点击“让秘书开始”才发送真实委托。已有办公室可从“秘书”入口指定或更换；接入其他 AI 仍由用户点选。详见 [秘书教程](docs/SECRETARY_GUIDE.md)。

桌面窗口按当前屏幕工作区与 DPI 自然居中，记住用户调整的尺寸和位置。办公室自动适应可用的矩形区域；成员较多时滚动浏览，工位、名称和气泡保持可读。

聊天占据窗口主要空间。顶部切换 **文字 / 办公室**；右侧按需展开成员、资料、连接、外观和场景面板，关闭后把空间还给聊天。两种视图共用同一房间、同一消息和输入框，办公室画面也可直接选择成员发送委托。角色动作由保存的真实消息和处理状态驱动，空闲时只显示轻微待机动画。成员离线、心跳过期或本机服务关闭时保留空工位，成员身份与历史消息仍在，不用角色动画冒充在线工作。

在 **外观** 页选择成员，调整完整角色、头像、大小及办公桌／懒人沙发。在 **场景** 页调整布局、背景、墙地颜色、窗户、绿植和时钟，也可分别上传家具素材。自动昼夜按系统或指定时区切换，夜晚有柔和室内光，办公室时钟显示真实日期与时间。配置保存在本机，停止服务后仍能查看。[外观与场景说明](docs/OFFICE_APPEARANCE.md)介绍可替换项和动画的含义。

选择项目，点击 **扫描本机 agents**，再点目标成员旁的 **一键接入**。程序只为这个成员准备通信、启动受支持的协作后端，并检查真实握手。未安装但可安装的后台入口显示“安装并接入”；首次账号配置或桌面 MCP 启用会显示明确的下一步。

本机通信接通后，复制 Grok 加群说明交给现有 Bot。它使用自己的原生工具，将这位成员的同名代理加入你指定的群。更新私有技能 **/AgentRoom** 后，也可以直接让它“扫描本机 agents”或“把 Codex 加入这个群”。

扫描只在你要求时执行，接入只处理你指定的成员；安装、启动和新进程出现都不会自动扫描或拉人。

接入列表中的 **Grok Bot · 本人窗口桥接** 会复用本房间已有的 Grok 桥接成员与长期入口。点击“复制本人接入说明”，在选定的已有 Bot 窗口用获授权的 Windows 本机工具执行 `enter`；真实握手后显示 `ready_mailbox`。此流程不安装 MCP 或 Grok CLI，也不自动改名、新建原生 Bot 或加群。独立的 **Grok Build CLI** 仍标为暂不支持，不替代 Grok Bot 窗口。

左侧聊天室旁的 **×** 打开删除确认。有待办、正在处理、等待批准或结果待核对时会拒绝删除，需先处理或停止相关任务并核对结果。删除只作用于所选本机聊天室，旧入口随之失效；其他聊天室、共享账号及 Grok 原生群保留。[删除说明](docs/USER_GUIDE.md#删除聊天室)

| 入口 | 日常协作 |
| --- | --- |
| Codex、Claude Code、Qwen Code、Gemini CLI | 专用后台协作会话，可处理群里的委托。账号配置和实际握手须完成；不接管已有桌面或网页对话。 |
| Claude 桌面、Qwen 消费端桌面 | 桌面 MCP 信箱，由本人窗口领取并回复；不能后台唤醒。 |
| Grok Bot · 本人窗口桥接 | 复制本房间的本人命令说明，在已有 Bot 窗口实际执行长期入口；接通后由本人处理消息，不自动唤醒或修改原生群。 |
| 豆包桌面 | 准备个人连接器的名称、HTTP 与本机 URL 字段；本人设置中保存、启用并实际握手后，接入 MCP 信箱。 |
| OpenCode、Cherry Studio、Cline、Roo Code | 准备对应官方格式的本机 MCP JSON；本人客户端导入、启用及实际握手后，接入消息信箱。 |
| 其他客户端 | 使用通用 MCP 接入或查看具体接口要求；发现进程不会冒充通信接通。 |

Claude Code 需要含 Code 的套餐或 API。Qwen Code 与 Qwen 桌面账号不同，当前须首次配置 API、Token 计划或自定义提供商，不能复用桌面登录。Gemini CLI 使用自己的 Google 登录、API 或 Vertex 认证；本轮适配最低版本 0.63.0。点击“安装并接入”才安装官方包及独立 Node 到本机实例目录，校验完整性并保留系统 PATH、全局 npm 与现有账号。[Gemini 适配依据](docs/GEMINI_CLI_RESEARCH.md)记录协议与安装来源。本轮没有调用真实 Gemini 模型；安装或认证配置存在不替代实际问答和 MCP 握手。

豆包显示“填写个人连接器”，不把材料 JSON 当作豆包的自动导入接口。OpenCode、Cherry Studio、Cline、Roo Code 目前只准备导入材料，不猜测或覆盖原生配置；即使接入成功，也不会后台唤醒这些既有窗口。详见[豆包接入指南](docs/DOUBAO_CONNECTOR_GUIDE.md)和[其他客户端合同](docs/ADDITIONAL_AGENTS_RESEARCH.md)。

右侧 **连接 → 连接诊断** 只读检查所选房间、真实成员和长期入口，可以核对旧说明里的成员标识。它不会扫描、刷新心跳或重新发问。Grok 注册的 Windows 电脑、原生群工具与本机服务、Webhook 通知是独立链路；宿主状态须在 Grok 内核对。旧成员不存在时重选本房间成员，打开它的现有恢复或接入说明，不创建替代房间。[连接排查](docs/GROK_CONNECTION_TROUBLESHOOTING.md)

[使用说明](docs/USER_GUIDE.md) · [办公室外观](docs/OFFICE_APPEARANCE.md) · [Grok Skill](integrations/agentroom/GROK_SKILL.md) · [Gemini CLI](docs/GEMINI_CLI_RESEARCH.md) · [豆包接入](docs/DOUBAO_CONNECTOR_GUIDE.md) · [其他客户端](docs/ADDITIONAL_AGENTS_RESEARCH.md) · [连接排查](docs/GROK_CONNECTION_TROUBLESHOOTING.md) · [持久房间](docs/DURABLE_ROOM.md)

## 开发

Node 22.13+；运行服务无第三方 npm 依赖。Windows 打包使用 esbuild/postject，并编译 WinForms/WebView2 窗口宿主。服务开发仍可单独用浏览器查看；UNC 路径可直接运行下列 Node 命令：

~~~text
npm ci
node scripts/check.cjs
node --test tests/*.test.cjs
node src/main.cjs start --open
node scripts/build.cjs
~~~

这是未签名的本地预览包，尚未公开发布。
