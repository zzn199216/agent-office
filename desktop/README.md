# Agent Office desktop host

Windows 10/11 x64 独立 WinForms 窗口，使用系统 Evergreen WebView2 Runtime。本地 .NET Framework 4.7.2 或更新版本；本机验证为 .NET Framework 4.8。

`node scripts/build-desktop.cjs` 从官方 NuGet 下载固定、SHA256 验证的 WebView2 SDK，使用 Windows 自带 .NET 编译器编译；不执行远程脚本，不全局安装 SDK，不捆绑整个浏览器 Runtime。只分发 WinForms/Core DLL、x64 Loader、NuGet 许可及应用公共界面资源。

显示品牌为 Agent 办公室 / Agent Office，程序集与互斥实例名仍为 AgentRoom，以兼容已有本机安装。窗口只调用完整安装包固定相邻或父目录 `AgentOffice.exe` 或兼容 `AgentRoom.exe` 的 `desktop-state` / `desktop-start` / `desktop-stop`。`--agentroom` 只接受这四个固定位置之一，`--data-dir` 仅来自桌面进程命令行，网页无法指定文件路径。`desktop-state --room UUID` 只读读取同一实例的房间、成员及历史。初次打开窗口不隐式启动服务；服务关闭仍可查看持久房间历史；关闭窗口保留服务。

在线只允许 CLI 返回的精确 `http://127.0.0.1:PORT` 原点；离线只允许公共 `desktop-web` 资源映射的 `https://agentroom.local`。成员自定义形象仅允许受限大小的 PNG/JPEG/WebP data URL 图片子资源，不允许 data 导航、脚本或 frame。导航、frame、popup、下载、网络子请求均受限制。WebView 不提供 native host objects；postMessage 仅接收同原点、已定义 schema 的固定服务操作，无 shell、URL、路径或任意命令。

文字和办公室界面共用公共 `office.js` / `office.css` 与显式名单的 `assets/office` 素材。成员外观通过固定只读 CLI 状态返回，无需给 WebView 映射任何私有文件夹。SVG 为随包的公开原创素材，用户替换只能采用服务已校验的 raster data。离线不发送消息或保存新外观。

公共桥契约：

```js
window.chrome.webview.postMessage({
  source: 'agentroom-ui', type: 'desktop-command', id: 'unique-id',
  operation: 'state' // start_service | stop_service | select_room
  // room_id: 'UUID' // select_room 必须填写
});
// Host message: { source:'agentroom-desktop', type:'desktop-result', id, result|error }
// result: { running, url, busy, snapshot, history, selected_room_id }
```

缺少 WebView2 Runtime 时显示原生错误与 Microsoft 官方下载入口；不会自动下载安装或请求管理员权限。现有 `AgentRoom.exe` 浏览器和 MCP/CLI 入口保持兼容。

验证自己的新窗口：`node scripts/validate-desktop.cjs` 创建独立临时实例，调用固定服务操作，并通过本应用的 `CoreWebView2.CapturePreviewAsync` 生成 PNG。不会使用 Computer Use 或操作用户已有应用。

SDK 来源：<https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31>。
