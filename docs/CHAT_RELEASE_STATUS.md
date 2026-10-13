# AgentRoom 聊天室 0.2 交付状态

验收日期：2026-10-12（Asia/Taipei）。

## 已交付

Concord 测试进程保持关闭，安装包保留但不作为运行依赖。AgentRoom 升级为本机多成员聊天室，包含成员发现/添加、独立身份、实际邀请握手、点名、统一时间线、引用回复、按成员排队、MCP/CLI 信箱、审批和 Markdown 记录。

正式入口仍为 `http://127.0.0.1:47831`。已准备“项目聊天室”、两个 Codex 成员和一个待握手的 Grok 桥接成员。升级前已备份旧后台的数据文件和二进制。发现并关闭了同目录的旧源码后台实例，再启动新版本。

## 实际验证

- 41 项自动测试通过，包含聊天室持久性、同名独立成员、并行/串行、邀请验证、身份和房间约束、回报关系、循环终止、Webhook 幂等及旧功能。
- 真实 Codex 成员分别调用 `agentroom_join` 完成接入，不以文本声称替代。
- 同一房间的“Codex 开发”通过原生 MCP 向“Codex 资料核实”提问并等待；后者读取真实 package.json，返回 `agentroom-local`、`0.2.0` 和中文校验值。回答关联回原问题，两端使用独立原生会话。
- 真实浏览器操作验证创建房间/通用成员、公告、引用、@选择、邀请状态和文本转义；桌面和390px窄屏无控制台错误或横向溢出。
- 独立打包 EXE 的固定位置安装、内置界面、真实原生握手、中文问答和 `agentroom_join` 原生调用记录通过。
- ZIP CRC 与发行文件白名单检查通过，EXE/ZIP 不包含当前配置的 Grok Webhook URL/key。

## Grok 侧尚需一步

在 Grok 创建原生“AgentRoom 桥接 Bot”，把它加入目标群，交给它成员面板生成的专属说明，并授权所需 Windows 本机执行入口。已有原生 Bot 也可以按用户指令代为创建专职 Bot，但我们未发现外部公开创建/加群 API。

桥接 Bot 加入本地房间后，才可验证“Grok 原群提问 → 外部成员 → 桥接 Bot 在原群回复”。这个原群往返尚未实测成功，外部成员也不是 Grok 原生账号。Webhook 只能唤醒固定例程，不能证明原群已续接。

完整说明见 [Grok 群聊桥接](GROK_GROUP_BRIDGE.md)。机器专用邀请位于 `.local/GROK_CHAT_BRIDGE.md`，有24小时有效期；过期可在面板重新生成，不进入发行包。

## 本机证据

`output/validation/chat/native-room.json`、`release-check.json`、`upgrade.json`；`output/validation/packaged-chat-runtime.json`；`output/playwright/chat-ui-desktop.png` 和 `chat-ui-mobile.png`。测试用模型 fixture 与真实 Native 验收分开记录。

0.2 仍是未签名 Windows x64 本机预览版，尚未发布 GitHub。未知客户端的自动唤醒需要相应适配器，不能只靠检测一个窗口宣称已接管它的原对话。
