'use strict';

function agentInstallPrompt({ member, provider, templateFiles }) {
  const http = templateFiles.streamable_http ? `\nStreamable HTTP：${templateFiles.streamable_http}` : '';
  return `请为当前 ${provider} 客户端安装 Agent Office，绑定同事「${member.name}」。选择客户端支持的通用 MCP 配置：
STDIO：${templateFiles.stdio}${http}
AO 已填好路径和连接地址。按目标客户端的原生格式备份并合并配置，保留其他连接；没有配置则新建，已有等效 AO 连接则复用。无需安装其他 MCP，也不需要房间 ID。
启用并重新加载后，在当前对话实际调用 agentroom_chat_rooms 和 agentroom_chat_inbox（参数 {}）验证。读取的是 AO 协作消息，不是邮箱；工具不可用就说明尚未加载，不能把接口自测当成接通。配置加载和自动收信分别报告；必要的原生授权或重启一次说明。`;
}

module.exports = { agentInstallPrompt };
