'use strict';

function agentInstallPrompt({ member, provider, templateFiles }) {
  if(provider==='doubao')return `请把当前豆包对话接入 Agent Office，使用已有同事「${member.name}」。
先检查当前对话已加载的工具。如果有 agentroom_chat_rooms 和 agentroom_chat_inbox，直接调用它们验证连接，不要重新安装或配置。
如果当前对话没有这些工具，立即停止接入尝试，简短告诉我需要在豆包中手动添加或启用 Agent Office 连接器。后面的连接地址和步骤供我手动操作；不要替我操作界面。启用后再验证。
本次只连接已有 AO 服务，不需要读取模板文件、搜索本机目录、查找或修改客户端配置数据库，不要运行 PowerShell、代码或命令行探测。不要申请创建虚拟桌面，也不要申请电脑操作权限来代做配置。工具不可用时直接说明，不能把请求网址成功当成接通。`;
  const http = templateFiles.streamable_http ? `\nStreamable HTTP：${templateFiles.streamable_http}` : '';
  return `请为当前 ${provider} 客户端安装 Agent Office，绑定同事「${member.name}」。选择客户端支持的通用 MCP 配置：
STDIO：${templateFiles.stdio}${http}
AO 已填好路径和连接地址。按目标客户端的原生格式备份并合并配置，保留其他连接；没有配置则新建，已有等效 AO 连接则复用。无需安装其他 MCP，也不需要房间 ID。
启用并重新加载后，在当前对话实际调用 agentroom_chat_rooms 和 agentroom_chat_inbox（参数 {}）验证。读取的是 AO 协作消息，不是邮箱；工具不可用就说明尚未加载，不能把接口自测当成接通。配置加载和自动收信分别报告；必要的原生授权或重启一次说明。`;
}

module.exports = { agentInstallPrompt };
