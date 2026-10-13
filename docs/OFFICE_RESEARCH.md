# 极简办公室场景调研

检索日期：2026-10-13。以下是公开项目和产品资产的实际观察，以及 Agent Office 采用的设计；没有复制第三方办公室背景、角色或家具包。

## 类似项目

[Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) 把 agent 显示为办公室角色，依据实际工作状态切换走路、阅读、敲键盘等动作。其布局可扩展，人物行为和布局数据分别维护。我们借鉴“状态驱动动画、角色和素材独立”两点；保留自己的极简卡通画风和现有通信层。[人物引擎](https://github.com/pixel-agents-hq/pixel-agents/blob/main/webview-ui/src/office/engine/characters.ts) 与 [布局序列化](https://github.com/pixel-agents-hq/pixel-agents/blob/main/webview-ui/src/office/layout/layoutSerializer.ts) 是实现参考，未复制代码或角色美术。

[Star Office UI](https://github.com/ringhyacinth/Star-Office-UI) 将 agent 状态、访客和可替换美术呈现在办公室看板里。我们借鉴“角色身份、真实状态、外观分别管理”的做法。该项目注明代码 MIT、美术仅限非商业学习用途；因此不引入其背景与人物资产，也不把它的看板展示当成 Agent Office 已有通信能力的证据。

## 本次采用的布局

办公室为可向下增长的矩形房间，左上方固定入口。工位按行排列，保留入口和走道；人数增加时在下方增加工位与地面，已有成员保留各自的位置。滚动查看下方区域，比把所有小人持续缩小更清楚。

新成员加入时从门进入，沿走道到自己的位置。入场动效由新的成员身份触发；状态轮询、切换文字视图或读取旧消息不应反复制造“新加入”。减少动态效果时直接安置角色。发言气泡使用同一份真实聊天记录，待机动作只是一层视觉呈现。

这里采用少量 DOM/CSS 图层和简单角色动作，不新增完整游戏引擎。头部身份图、原创身体、工位与气泡分层，便于用户更换图片，也便于以后增加角色预设。

## 默认头像来源

| 成员 | 此次找到并使用的公开形象 | 原始来源 |
| --- | --- | --- |
| Codex | OpenAI 官方组织 Logo；作为图标备选 | [OpenAI GitHub](https://github.com/openai) |
| Claude / Claude Code | Claude 官方产品图标；作为图标备选 | [官方产品页](https://claude.com/product/claude-code) 链接的 [Claude App Store](https://apps.apple.com/us/app/claude-by-anthropic/id6473753684) |
| Qwen | Qwen 官方组织 Logo；作为图标备选 | [QwenLM GitHub](https://github.com/QwenLM) |
| Grok | Grok 官方产品图标；作为图标备选 | [官方品牌页](https://x.ai/legal/brand-guidelines) 链接的 [Grok App Store](https://apps.apple.com/us/app/grok-ai/id6670324846) |
| Cursor | Cursor 官方网站产品图标；作为图标备选 | [Cursor 品牌页](https://cursor.com/brand) |
| 豆包 | 官网实际公开的豆包女孩头像 | [豆包官网](https://www.doubao.com/chat/) |

Claude Code 的 Clawd 角色确有大量网上讨论和民间素材，但本次未找到可核验、独立可下载的官方角色图；因此先使用官方产品图标，未拿民间衍生图冒充官方素材。其他未确认网络人物形象的工具也采用产品图标。用户可随时用自己的头像或完整人物覆盖它们。

下载后的头像随软件离线打包，运行时不请求第三方图床。资源清单 [AVATAR_SOURCES.json](../web/assets/office/AVATAR_SOURCES.json) 记录每个原始 URL、检索日期、类型、大小、尺寸和 SHA-256，区分官方人物头像、官方图标备选及项目原创通用图标。

## 权利与呈现

品牌资源只用于识别对应 agent，保持原图比例、颜色，与原创人物身体分层显示，不作为 Agent Office 的品牌或第三方背书。公开可下载并不等于已确认可自由商用，开源代码许可证也不自动授权商标或人物形象；清单保留已找到的 [OpenAI](https://openai.com/brand/)、[Grok](https://x.ai/legal/brand-guidelines)、[Cursor](https://cursor.com/brand) 品牌使用说明，未确认独立素材许可的条目如实注明。
