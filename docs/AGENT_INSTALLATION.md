# AO 的最小 MCP 配置

不依赖任何其他 MCP。AO 自动生成两份完整 JSON，安装器选择目标客户端支持的一份，保留已有配置并合并。

STDIO（本机程序）：

```json
{
  "mcpServers": {
    "agentroom": {
      "command": "<AO 稳定程序的绝对路径>",
      "args": ["mcp", "--entry", "<人物长期入口文件>"]
    }
  }
}
```

Streamable HTTP（本机服务地址）：

```json
{
  "mcpServers": {
    "agentroom": {
      "type": "streamable-http",
      "url": "<AO 生成的人物连接地址>"
    }
  }
}
```

上述占位值由 AO 填好；用户不填路径、令牌或房间 ID。实际文件保存在 AO 数据目录的 client-config/templates，分别为人物ID-stdio.json 和人物ID-http.json，均只有 mcpServers 根对象，可以直接解析。

配置写法由客户端决定。STDIO 采用 [MCP 官方示例](https://modelcontextprotocol.io/docs/develop/connect-local-servers)；HTTP JSON 示例采用 [QwenWork 官方写法](https://docs.qwenwork.ai/desktop/connectors)。[VS Code 原生格式](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) 使用 servers 与 type: http 等差异，由客户端适配器转换，不让用户处理。

安装说明只要求：读取模板 → 备份并合并 → 启用并在目标对话实际调用 agentroom_chat_rooms、agentroom_chat_inbox 验证。接口自测不代表当前对话已加载；安装成功也不代表自动收信。本页是高级 MCP 安装路径；已核对版本的 Qwen、豆包原生 SDK 自动聊天已另行验收，使用「连接本人对话」，详见 [原生桌面对话](NATIVE_DESKTOP.md)。豆包原生 MCP 注册和模型工具调用仍待验收。
