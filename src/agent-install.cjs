'use strict';

// This is a user-delegated installation brief, not an automatic client
// installer or evidence that a native conversation loaded the connection.
function agentInstallPrompt({ member, provider, entryFile, localUrl }) {
  const http = localUrl ? `若目标支持 Streamable HTTP，可从入口文件读取 credential_id 和 secret，组成本机 ${localUrl}/mcp/<credential_id>/<secret>。这两个占位值须由你从文件替换，不能让用户手填；不要把完整地址打印到报告。` : '';
  return `请为当前 ${provider} 客户端安装 Agent Office（AO / AgentRoom）协作连接，绑定同事「${member.name}」，安装配置由你完成，保留已有连接。
1. 先确认你有本机文件、进程和目标客户端配置能力，识别当前客户端、真实档案和支持的 MCP 传输。优先复用本客户端已经能用的 MCP（例如 WorldRole）的配置方式；不要把另一客户端、云端沙箱或仅下载的配置文件当作本人的安装位置。
2. 读取本机已有长期入口文件：${entryFile}。复用它的成员身份和凭据，不重新发卡。入口里的 room_id 只是兼容默认值，连接适用于用户让该人物加入的所有房间，不要求用户填写房间 ID。
3. 优先使用目标客户端的正式安装命令；没有命令但已确认原生配置格式与位置时，备份受影响的配置并合并一个 Agent Office 条目，保留其他服务器、有效密钥、设置和本地修改。若只能从原生设置添加，使用你已有且获授权的界面操作能力代办；原生授权或确实无法执行的步骤一次说明，不要猜配置路径或仅返回操作清单。
4. 选择本客户端确实支持的传输。STDIO 配置以入口文件中的 launch_command 为 command，args 为 launch_args 后追加 mcp、--entry、上述入口文件路径；每个参数单独一项。${http}不要把 Streamable HTTP 配成 SSE，也不要创建公网隧道。
5. 保存并在目标客户端启用连接，按该客户端支持的方式重新加载。不要擅自关闭用户正在处理的任务；确实需要重启或授权时准确说明剩余步骤。
6. 必须在当前目标对话的真实工具列表中找到 agentroom_chat_rooms 和 agentroom_chat_inbox，并通过该对话调用。单独运行 HTTP / STDIO 自测、initialize 或 tools/list 成功，只证明接口可用，不能报告当前对话已接入。
7. 先调用 agentroom_chat_rooms，再调用 agentroom_chat_inbox，参数为 {}。这是 AO 协作消息，不是电子邮箱，不要调用邮件工具。有发给本人的问题时，用 agentroom_chat_reply 回复返回的 message_id；工具不可用时明确报告连接器未加载，不要误报空列表。
8. 最后分别报告：配置是否写入目标客户端、当前对话是否加载工具、消息是否实际回写 AO、收到第二条消息是否无需用户催收即可处理。最后一项未验证或需要用户每次去窗口发指令，就报告手动信箱模式，不能声称自动接管。升级或更换房间沿用原连接。
安装不扩大你原有的文件、发布、付费或其他客户端权限。`;
}

module.exports = { agentInstallPrompt };
