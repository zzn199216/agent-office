'use strict';

function agentInstallPrompt({ member, provider, templateFiles }) {
  if(provider==='doubao')return `请把当前豆包对话接入 Agent Office，使用已有同事「${member.name}」。
先检查当前对话已加载的工具。如果有 agentroom_chat_rooms 和 agentroom_chat_inbox，直接调用它们验证连接，不要重新安装或配置。
如果当前对话没有这些工具，立即停止接入尝试，简短告诉我需要在豆包中手动添加或启用 Agent Office 连接器。后面的连接地址和步骤供我手动操作；不要替我操作界面。启用后再验证。
本次只连接已有 AO 服务，不需要读取模板文件、搜索本机目录、查找或修改客户端配置数据库，不要运行 PowerShell、代码或命令行探测。不要申请创建虚拟桌面，也不要申请电脑操作权限来代做配置。工具不可用时直接说明，不能把请求网址成功当成接通。`;
  const http = templateFiles.streamable_http ? `\nStreamable HTTP：${templateFiles.streamable_http}` : '';
  return `请为这台电脑上的 ${provider} 客户端安装或更新 Agent Office，绑定同事「${member.name}」。选择客户端支持的通用 MCP 配置：
STDIO：${templateFiles.stdio}${http}
AO 已填好路径和连接地址。先用已有 AO 工具或本机配置核对实例与成员身份；没有配置则新建，已有等效 AO 连接则复用，无需重复添加。同一实例、同一成员的旧配置才更新为模板中的当前值；先备份，只合并该 AO 条目，保留其他连接、未知字段和客户端原有配置格式。其他实例或其他成员的连接不能覆盖；身份不明时说明具体冲突，不猜测。写入前再次核对文件未被其他程序修改，写后重新读取核验；失败时保留原配置和可恢复备份。无需安装其他 MCP，也不需要用户填写房间 ID。
当前对话没有获授权的本机文件或客户端配置工具时，明确说明需要在客户端手动配置；不能用云端代码解释器访问这台电脑，也不能只凭这句话宣称配置完成。
启用并重新加载后，在当前对话实际调用 agentroom_chat_rooms 和 agentroom_chat_inbox（参数 {}）验证。读取的是 AO 协作消息，不是邮箱；工具不可用就说明尚未加载，不能把接口自测当成接通。配置加载和自动收信分别报告；必要的原生授权或重启一次说明。`;
}

module.exports = { agentInstallPrompt };
