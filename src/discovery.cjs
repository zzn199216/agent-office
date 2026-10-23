'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process');
const GEMINI_MIN=require('./gemini.cjs').MIN_VERSION;

// Discovery is metadata only. A running UI is never proof that its existing
// conversation can be controlled, and process arguments never leave this module.
const clean=(value,max=240)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max);
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const pathEqual=(a,b,platform)=>platform==='win32'?String(a).toLowerCase()===String(b).toLowerCase():a===b;
const genericWorker=p=>/(?:^|\s)--type(?:=|\s)(?:renderer|gpu-process|utility|zygote|crashpad-handler)\b/i.test(p.commandLine)||/^(?:crashpad_handler|chrome_crashpad_handler)(?:\.exe)?$/i.test(p.name);
const nativeCodex=p=>!/(?:[\\/]WindowsApps[\\/]OpenAI\.Codex_|[\\/]Codex\.app[\\/])/i.test(p.executable)||/[\\/](?:resources[\\/]bin|bin)[\\/]codex(?:\.exe)?$/i.test(p.executable);
const claudeDesktop=value=>/(?:[\\/]WindowsApps[\\/](?:Anthropic\.)?Claude[^\\/]*[\\/]|[\\/]Programs[\\/]Claude[\\/]|[\\/]Claude\.app[\\/]|[\\/]Claude[\\/]claude\.exe$)/i.test(String(value||''));
const qwenDesktop=value=>/(?:[\\/]WindowsApps[\\/]Qwen[^\\/]*[\\/]|[\\/]Programs[\\/]Qwen(?: Studio)?[\\/]|[\\/]Qwen(?: Studio)?\.app[\\/]|[\\/]Qwen(?: Studio)?[\\/]qwen(?: studio)?\.exe$)/i.test(String(value||''));
const grokDesktop=p=>/^(?:Grok Bot|GrokBot)(?:\.exe)?$/i.test(p.name)||/^grok(?:\.exe)?$/i.test(p.name)&&/[\\/](?:Grok(?: Bot)?|GrokBot)(?:\.app)?[\\/]/i.test(p.executable);
const grokCli=p=>/^grok(?:\.exe)?$/i.test(p.name)&&/[\\/]\.grok[\\/]bin[\\/]grok(?:\.exe)?$/i.test(p.executable);
function qwenVendorScript(value){
  const text=String(value||'');if(!path.win32.isAbsolute(text)&&!path.posix.isAbsolute(text)||/[\r\n\u0000]/.test(text)||text.split(/[\\/]/).some(part=>part==='.'||part==='..'))return false;
  // --data-dir can point anywhere. Accept the installer's exact version/UUID
  // namespace under that directory rather than requiring the default home.
  const npm=/[\\/]node_modules[\\/]@qwen-code[\\/]qwen-code[\\/](?:dist[\\/])?(?:cli-entry|cli|index)\.(?:js|mjs|cjs)$/i;
  const runtime=/[\\/]runtimes[\\/]qwen-code[\\/]\d+\.\d+\.\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[\\/](?:vendor|payload[\\/]qwen-code)[\\/](?:(?:lib|dist)[\\/])?cli-entry\.js$/i;
  return npm.test(text)||runtime.test(text);
}
function geminiVendorScript(value){
  const text=String(value||'');
  if(!(path.win32.isAbsolute(text)||path.posix.isAbsolute(text))||/[\r\n\u0000]/.test(text)||text.split(/[\\/]/).some(part=>part==='.'||part==='..'))return false;
  const npm=/[\\/]node_modules[\\/]@google[\\/]gemini-cli[\\/](?:dist[\\/]index\.js|bundle[\\/]gemini\.js)$/i;
  const runtime=/[\\/]runtimes[\\/]gemini-cli[\\/]\d+\.\d+\.\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[\\/]payload[\\/]package[\\/]bundle[\\/]gemini\.js$/i;
  return npm.test(text)||runtime.test(text);
}
function geminiScript(commandLine){
  const match=String(commandLine||'').match(/^\s*(?:"[^"\r\n]+"|[^\s"\r\n]+)\s+(?:"([^"\r\n]+)"|([^\s"\r\n]+))(?:\s|$)/);
  const value=match?.[1]||match?.[2]||'';return geminiVendorScript(value)?value:null;
}
function qwenScript(commandLine){
  const match=String(commandLine||'').match(/^\s*(?:"[^"\r\n]+"|[^\s"\r\n]+)\s+(?:"([^"\r\n]+)"|([^\s"\r\n]+))(?:\s|$)/);
  const value=match?.[1]||match?.[2]||'';return qwenVendorScript(value)?value:null;
}
function qwenCliProcess(process,context={}){
  if(!/^qwen(?:\.exe)?$/i.test(process.name)||!process.executable||qwenDesktop(process.executable))return false;
  if(/[\\/](?:\.qwen[\\/]bin|\.local[\\/]bin|\.agentroom[\\/]runtimes[\\/]qwen-code(?:[\\/][^\\/]+)*)[\\/]qwen(?:\.exe)?$/i.test(process.executable))return true;
  const env=context.env||{},platform=context.platform||'win32',p=context.path||path.win32;
  if(env.AGENTROOM_QWEN_CODE_PATH&&pathEqual(env.AGENTROOM_QWEN_CODE_PATH,process.executable,platform)&&!env.AGENTROOM_QWEN_CODE_SCRIPT)return true;
  return (env.PATH||'').split(platform==='win32'?';':':').filter(Boolean).some(folder=>pathEqual(p.join(folder,platform==='win32'?'qwen.exe':'qwen'),process.executable,platform));
}
function claudeScript(commandLine){
  // Extract only the script token directly after node. A vendor path appearing
  // inside a prompt or after --eval/--import is not an executable entrypoint.
  const match=String(commandLine||'').match(/^\s*(?:"[^"\r\n]+"|[^\s"\r\n]+)\s+(?:"([^"\r\n]+)"|([^\s"\r\n]+))(?:\s|$)/);
  const value=match?.[1]||match?.[2]||'';
  return /[\\/]@anthropic-ai[\\/]claude-code[\\/](?:cli|bin[\\/]claude)\.(?:js|mjs|cjs)$/i.test(value)?value:null;
}

function defaultCatalog(){return [
  {id:'codex',provider:'codex',name:'Codex',adapter:'codex',kind:'managed',capabilities:{automatic_launch:true,mcp_install:true,attach_existing:false,native_group_proxy:true},
    matchProcess:p=>/^codex(?:\.exe)?$/i.test(p.name)?{role:/\bapp-server\b/i.test(p.commandLine)?'worker':nativeCodex(p)?'cli':'desktop',confidence:'process_name'}:/^node(?:\.exe)?$/i.test(p.name)&&/@openai[\\/]codex[\\/]/i.test(p.commandLine)?{role:'cli',confidence:'script_path'}:null,
    executableNames:['codex.exe','codex'],reason:'可启动专用 Codex 协作会话；运行中的桌面聊天仍由原窗口管理。',missingReason:'未找到 Codex 命令入口；桌面应用进程本身不代表已具备后台处理能力。'},
  {id:'claude-code',provider:'claude-code',name:'Claude Code',adapter:'claude-code',kind:'managed',capabilities:{automatic_launch:true,mcp_install:true,runtime_install:true,attach_existing:false,native_group_proxy:true},
    matchProcess:p=>/^claude(?:\.exe)?$/i.test(p.name)&&!claudeDesktop(p.executable)?{role:'cli',confidence:'process_name'}:/^node(?:\.exe)?$/i.test(p.name)&&claudeScript(p.commandLine)?{role:'cli',confidence:'script_path'}:null,
    executableNames:['claude.exe','claude.cmd','claude'],reason:'可启动专用 Claude Code 协作会话并验证通信；需要自己的 Claude Code 登录或 API。已有工作聊天仍由原窗口管理。',missingReason:'可按你的选择安装官方 Claude Code 后台入口；首次仍需自己的登录或 API 认证。'},
  {id:'claude-desktop',provider:'claude-desktop',name:'Claude 桌面客户端',adapter:'mailbox',kind:'mcp',capabilities:{automatic_launch:false,mcp_install:true,mcp_prepare:true,attach_existing:false,native_group_proxy:true},
    matchProcess:p=>/^claude(?:\.exe)?$/i.test(p.name)&&claudeDesktop(p.executable)?{role:'desktop',confidence:'verified_path'}:null,executableNames:[],reason:'可按你的选择安装本机 MCP 并在 Claude 自己的聊天中完成握手；桌面会话的后台唤醒尚未实现，与 Claude Code CLI 不同。'},
  {id:'cursor',provider:'cursor',name:'Cursor',adapter:'mailbox',kind:'mcp',capabilities:{automatic_launch:false,mcp_install:true,attach_existing:false,native_group_proxy:true},
    matchProcess:p=>/^cursor(?:\.exe)?$/i.test(p.name)?{role:'desktop',confidence:'process_name'}:null,executableNames:['cursor.exe','cursor'],reason:'可安装 Cursor MCP 配置；需要加载配置并完成真实握手。'},
  {id:'grok-bot',provider:'grok-bot',name:'Grok Bot · 本人窗口桥接',adapter:'grok-bridge',kind:'bridge',capabilities:{automatic_launch:false,mcp_install:false,manual_connect:true,attach_existing:false,native_group_proxy:true},
    source:'https://docs.x.ai/grok-bot/get-started',matchProcess:p=>grokDesktop(p)?{role:'desktop',confidence:'process_name'}:null,executableNames:[],reason:'可复用本房间的 Grok 桥接成员并准备长期本机命令入口，首次在你选定的 Grok Bot 窗口执行。打开应用不代表 Windows 执行宿主已连通；不安装 Grok CLI、不自动新建 Bot 或加群。'},
  {id:'grok-cli',provider:'grok-cli',name:'Grok Build CLI · 独立产品',adapter:'mailbox',kind:'unsupported',capabilities:{automatic_launch:false,mcp_install:false,attach_existing:false,native_group_proxy:false},
    source:'https://docs.x.ai/build/overview',matchProcess:p=>grokCli(p)?{role:'cli',confidence:'verified_path'}:null,executableNames:[],reason:'这是独立的 Grok Build 命令行产品；当前后台适配尚未实现，不使用它替代 Grok Bot 桌面窗口。'},
  {id:'qwen-code',provider:'qwen-code',name:'Qwen Code',adapter:'qwen-code',kind:'managed',capabilities:{automatic_launch:true,mcp_install:true,runtime_install:true,attach_existing:false,native_group_proxy:true},
    matchProcess:(p,context)=>qwenCliProcess(p,context)?{role:'cli',confidence:'verified_path'}:/^node(?:\.exe)?$/i.test(p.name)&&qwenScript(p.commandLine)?{role:'cli',confidence:'script_path'}:null,
    executableNames:['qwen.exe','qwen.cmd','qwen'],reason:'可启动独立 Qwen Code 后台协作；需要它自己的 API 或模型计划认证，不复用 Qwen 桌面登录。',missingReason:'可按你的选择安装官方 Qwen Code 后台入口；首次需配置它自己的 API 或模型计划。它与 Qwen 桌面客户端分别接入。'},
  {id:'gemini-cli',provider:'gemini-cli',name:'Gemini CLI',adapter:'gemini-cli',kind:'managed',capabilities:{automatic_launch:true,mcp_install:false,runtime_install:true,attach_existing:false,native_group_proxy:true},
    minimumVersion:GEMINI_MIN,source:'https://geminicli.com/docs/get-started/installation/',
    matchProcess:p=>/^node(?:\.exe)?$/i.test(p.name)&&geminiScript(p.commandLine)?{role:'cli',confidence:'script_path'}:null,
    executableNames:['gemini.cmd','gemini'],reason:'可启动独立 Gemini CLI 后台协作；首次需自己的 Google 登录、API 或 Vertex 认证，不接管 Gemini 网页聊天。',missingReason:`可按你的选择安装官方 Gemini CLI ${GEMINI_MIN} 后台入口；首次需自己的 Google 登录、API 或 Vertex 认证。`},
  {id:'qwen-desktop',provider:'qwen-desktop',name:'Qwen 桌面客户端',adapter:'mailbox',kind:'mcp',capabilities:{automatic_launch:false,mcp_install:false,mcp_prepare:true,attach_existing:false,native_group_proxy:true},
    matchProcess:(p,context)=>/^(?:Qwen|Qwen Studio)(?:\.exe)?$/i.test(p.name)&&!qwenCliProcess(p,context)?{role:'desktop',confidence:qwenDesktop(p.executable)?'verified_path':'process_name'}:null,executableNames:[],reason:'已核对版本可连接独立原生人物对话，由 AO 自动派发和回写回答；首次需开启客户端本机连接。高级区保留 MCP 配置，它与 Qwen Code CLI 分别接入。'},
  {id:'doubao',provider:'doubao',name:'豆包桌面 · 本人窗口协作',adapter:'mailbox',kind:'mcp',alwaysAvailable:true,capabilities:{automatic_launch:false,mcp_install:false,mcp_prepare:true,attach_existing:false,native_group_proxy:true},
    source:'https://open.doubao.com/',matchProcess:p=>/^(?:Doubao|豆包)(?:\.exe)?$/i.test(p.name)?{role:'desktop',confidence:'process_name'}:null,executableNames:[],reason:'已核对版本可连接独立原生人物对话，由 AO 自动派发和回写回答；首次需开启客户端本机连接。基础聊天无需配置 MCP，原生 MCP 工具仍需另行配置和验收。'},
  {id:'opencode',provider:'opencode',name:'OpenCode · 本人窗口协作',adapter:'mailbox',kind:'mcp',alwaysAvailable:true,capabilities:{automatic_launch:false,mcp_install:false,mcp_prepare:true,attach_existing:false,native_group_proxy:true},
    source:'https://opencode.ai/docs/mcp-servers/',matchProcess:p=>/^opencode(?:\.exe)?$/i.test(p.name)?{role:'cli',confidence:'process_name'}:null,executableNames:['opencode.exe','opencode'],reason:'可准备官方本机 STDIO MCP 配置，在 OpenCode 自己的会话中领取和回复；本轮不启动模型服务或控制已有聊天。'},
  {id:'cherry-studio',provider:'cherry-studio',name:'Cherry Studio · 本人窗口协作',adapter:'mailbox',kind:'mcp',alwaysAvailable:true,capabilities:{automatic_launch:false,mcp_install:false,mcp_prepare:true,attach_existing:false,native_group_proxy:true},
    source:'https://docs.cherryai.com.cn/advanced-basic/extensions/mcp.md',matchProcess:p=>/^(?:Cherry Studio|CherryStudio|cherry-studio)(?:\.exe)?$/i.test(p.name)?{role:'desktop',confidence:'process_name'}:null,executableNames:[],reason:'可准备 STDIO MCP 导入配置；在 Cherry Studio 启用并绑定到选定 Agent 后真实握手，不能后台唤醒现有窗口。'},
  {id:'cline',provider:'cline',name:'Cline · 本人窗口协作',adapter:'mailbox',kind:'mcp',alwaysAvailable:true,extension:{publisher:'saoudrizwan',name:'claude-dev'},capabilities:{automatic_launch:false,mcp_install:false,mcp_prepare:true,attach_existing:false,native_group_proxy:true},
    source:'https://docs.cline.bot/mcp/mcp-overview',matchProcess:()=>null,executableNames:[],reason:'可准备 Cline 扩展的 MCP 配置；在本人扩展会话中完成真实握手，VS Code 进程不代表 Cline 在线。'},
  {id:'roo-code',provider:'roo-code',name:'Roo Code · 本人窗口协作',adapter:'mailbox',kind:'mcp',alwaysAvailable:true,extension:{publisher:'RooVeterinaryInc',name:'roo-cline'},capabilities:{automatic_launch:false,mcp_install:false,mcp_prepare:true,attach_existing:false,native_group_proxy:true},
    source:'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/',matchProcess:()=>null,executableNames:[],reason:'可准备 Roo Code 扩展的 MCP 配置；在本人扩展会话中完成真实握手，安装元数据不代表后台在线。'},
  {id:'mailbox',provider:'custom',name:'其他 Bot / MCP 客户端',adapter:'mailbox',kind:'mcp',alwaysAvailable:true,capabilities:{automatic_launch:false,mcp_install:false,attach_existing:false,native_group_proxy:true},
    matchProcess:()=>null,executableNames:[],reason:'支持任意能调用标准 MCP 或本机命令的 Agent；自定义适配器须声明可验证的能力。'}
];}

async function windowsProcessInventory({execFile:run=execFile,signal,timeout=15000}={}){
  // Node arguments are used only to distinguish named vendor entrypoints from
  // ordinary node processes. Neither they nor environment variables are returned.
  const script="$other=Get-CimInstance Win32_Process -Filter \"Name <> 'Grok Bot.exe' AND Name <> 'GrokBot.exe' AND Name <> 'Grok.exe'\" | Where-Object {$_.Name -match '^(codex|claude|Cursor|Qwen|Qwen Studio|Doubao|豆包|opencode|Cherry Studio|CherryStudio|cherry-studio|node|crashpad_handler|chrome_crashpad_handler)\\.exe$'} | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine; $grok=Get-CimInstance Win32_Process -Filter \"Name = 'Grok Bot.exe' OR Name = 'GrokBot.exe' OR Name = 'Grok.exe'\" -Property Name,ProcessId,ParentProcessId,ExecutablePath | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath; @($other)+@($grok) | ConvertTo-Json -Compress";
  const query=command=>new Promise(resolve=>run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout,maxBuffer:4*1024*1024,signal},(error,stdout)=>resolve({error,stdout})));
  const result=await query(script);
  if(signal?.aborted)return {processes:[],available:false};
  if(result.error){
    // A cold PowerShell CIM query can take longer than a busy desktop allows.
    // Get-Process is faster; it lacks parents and command lines, so CLI vendor
    // scripts may be missed, but desktop apps are still recognised.
    const quick=await query("Get-Process | Where-Object {$_.ProcessName -match '^(codex|claude|Cursor|Qwen|Qwen Studio|Doubao|豆包|opencode|Cherry Studio|CherryStudio|cherry-studio)$'} | Select-Object @{n='Name';e={$_.ProcessName+'.exe'}},@{n='ProcessId';e={$_.Id}},@{n='ExecutablePath';e={$_.Path}} | ConvertTo-Json -Compress");
    if(quick.error)return {processes:[],available:false,reason:'暂时无法读取本机进程清单。'};
    try{const rows=JSON.parse(quick.stdout||'[]');return {processes:Array.isArray(rows)?rows:rows?[rows]:[],available:true,partial:true};}catch{return {processes:[],available:false,reason:'进程清单格式无法识别。'};}
  }
  try{const rows=JSON.parse(result.stdout||'[]');return {processes:Array.isArray(rows)?rows:rows?[rows]:[],available:true};}catch{return {processes:[],available:false,reason:'进程清单格式无法识别。'};}
}

class DiscoveryCatalog{
  constructor(options={}){
    this.platform=options.platform||process.platform;this.env=options.env||process.env;this.path=this.platform==='win32'?path.win32:path.posix;
    this.exists=options.fileExists||fs.existsSync;this.listFiles=options.listFiles||((folder)=>{try{return fs.readdirSync(folder);}catch{return [];}});
    this.readManifest=options.readManifest||((file)=>{try{if(!fs.statSync(file).isFile()||fs.statSync(file).size>256*1024)return null;const value=JSON.parse(fs.readFileSync(file,'utf8'));return {publisher:value.publisher,name:value.name};}catch{return null;}});
    this.inventory=options.processInventory||options.scan||(input=>this.platform==='win32'?windowsProcessInventory(input):{processes:[],available:false,reason:'当前平台仅检查已安装的命令入口；未读取进程参数。'});
    this.queryState=options.queryState||(()=>null);this.clock=options.now||(()=>new Date().toISOString());
    const catalog=options.catalog||[],defaults=options.includeDefaults===false?[]:defaultCatalog();const map=new Map(defaults.map(d=>[d.id,d]));
    for(const item of catalog){if(!item||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.id||''))throw new TypeError('Adapter id must contain lowercase letters, numbers or hyphens.');map.set(item.id,{...(map.get(item.id)||{}),...item});}this.catalog=[...map.values()];
  }
  safeExists(value){try{return !!value&&this.exists(value)===true;}catch{return false;}}
  nodePaths(){
    const p=this.path,e=this.env,name=this.platform==='win32'?'node.exe':'node',paths=[];
    if(e.AGENTROOM_NODE_PATH&&p.basename(e.AGENTROOM_NODE_PATH).toLowerCase()===name)paths.push(e.AGENTROOM_NODE_PATH);
    if(this.platform==='win32'&&e.NVM_SYMLINK)paths.push(p.join(e.NVM_SYMLINK,name));
    for(const folder of (e.PATH||'').split(this.platform==='win32'?';':':').filter(Boolean))paths.push(p.join(folder,name));
    if(this.platform==='win32'&&e.ProgramFiles)paths.push(p.join(e.ProgramFiles,'nodejs',name));
    return [...new Set(paths)].filter(value=>this.path.isAbsolute(value)&&this.safeExists(value));
  }
  claudeLaunch(paths,processes){
    const native=paths.find(value=>this.platform==='win32'?/^claude\.exe$/i.test(this.path.basename(value)):this.path.basename(value)==='claude');
    if(native)return {executable:native,args:[]};
    const nodes=this.nodePaths();if(!nodes.length)return {executable:null,args:[]};
    for(const shim of paths.filter(value=>/claude\.cmd$/i.test(this.path.basename(value)))){
      const script=this.path.join(this.path.dirname(shim),'node_modules','@anthropic-ai','claude-code','cli.js');
      if(this.safeExists(script))return {executable:nodes[0],args:[script]};
    }
    for(const item of processes){
      if(!/^node(?:\.exe)?$/i.test(item.name)||!nodes.some(node=>pathEqual(node,item.executable,this.platform)))continue;
      const script=claudeScript(item.commandLine);if(script&&this.path.isAbsolute(script)&&this.safeExists(script))return {executable:item.executable,args:[script]};
    }
    return {executable:null,args:[]};
  }
  qwenLaunch(paths,processes){
    const p=this.path,e=this.env,trusted=e.AGENTROOM_QWEN_CODE_PATH,script=e.AGENTROOM_QWEN_CODE_SCRIPT;
    if(typeof trusted==='string'&&p.isAbsolute(trusted)&&this.safeExists(trusted)&&!qwenDesktop(trusted)){
      if(/^qwen(?:\.exe)?$/i.test(p.basename(trusted))&&!script)return {executable:trusted,args:[]};
      if(/^node(?:\.exe)?$/i.test(p.basename(trusted))&&typeof script==='string'&&p.isAbsolute(script)&&qwenVendorScript(script)&&this.safeExists(script))return {executable:trusted,args:[script]};
    }
    const native=paths.find(value=>this.platform==='win32'?/^qwen\.exe$/i.test(p.basename(value)):p.basename(value)==='qwen');
    if(native&&!qwenDesktop(native))return {executable:native,args:[]};
    const nodes=this.nodePaths();
    for(const shim of paths.filter(value=>/qwen\.cmd$/i.test(p.basename(value)))){
      const folder=p.dirname(shim),siblingNode=p.join(folder,this.platform==='win32'?'node.exe':'node');
      const node=this.safeExists(siblingNode)?siblingNode:nodes[0];if(!node)continue;
      for(const suffix of ['cli-entry.js','dist/cli-entry.js','dist/index.js','dist/cli.js']){
        const vendor=p.join(folder,'node_modules','@qwen-code','qwen-code',...suffix.split('/'));
        if(this.safeExists(vendor))return {executable:node,args:[vendor]};
      }
    }
    for(const item of processes){
      if(!/^node(?:\.exe)?$/i.test(item.name)||!nodes.some(node=>pathEqual(node,item.executable,this.platform)))continue;
      const vendor=qwenScript(item.commandLine);if(vendor&&p.isAbsolute(vendor)&&this.safeExists(vendor))return {executable:item.executable,args:[vendor]};
    }
    return {executable:null,args:[]};
  }
  geminiLaunch(paths,processes){
    const p=this.path,e=this.env,trusted=e.AGENTROOM_GEMINI_PATH||e.AGENTROOM_GEMINI_CLI_PATH,script=e.AGENTROOM_GEMINI_SCRIPT;
    if(typeof trusted==='string'&&p.isAbsolute(trusted)&&/^node(?:\.exe)?$/i.test(p.basename(trusted))&&this.safeExists(trusted)&&geminiVendorScript(script)&&this.safeExists(script))return {executable:trusted,args:[script]};
    const nodes=this.nodePaths();
    for(const shim of paths.filter(value=>/^gemini(?:\.cmd)?$/i.test(p.basename(value)))){
      const folder=p.dirname(shim),sibling=p.join(folder,this.platform==='win32'?'node.exe':'node');
      const node=this.safeExists(sibling)?sibling:nodes[0];if(!node)continue;
      for(const suffix of ['bundle/gemini.js','dist/index.js']){const vendor=p.join(folder,'node_modules','@google','gemini-cli',...suffix.split('/'));if(this.safeExists(vendor))return {executable:node,args:[vendor]};}
    }
    for(const item of processes){
      if(!/^node(?:\.exe)?$/i.test(item.name)||!nodes.some(node=>pathEqual(node,item.executable,this.platform)))continue;
      const vendor=geminiScript(item.commandLine);if(vendor&&this.safeExists(vendor))return {executable:item.executable,args:[vendor]};
    }
    return {executable:null,args:[]};
  }
  extensionInstalled(definition){
    if(!definition.extension)return false;
    const p=this.path,home=this.env.USERPROFILE||this.env.HOME||'';
    if(!p.isAbsolute(home))return false;
    const {publisher,name}=definition.extension,prefix=`${publisher}.${name}-`.toLowerCase();
    for(const product of ['.vscode','.vscode-insiders','.vscode-oss','.cursor']){
      const root=p.join(home,product,'extensions');if(!this.safeExists(root))continue;
      let folders=[];try{folders=this.listFiles(root)||[];}catch{}
      for(const folder of folders.filter(value=>typeof value==='string'&&value.toLowerCase().startsWith(prefix)&&!/[\\/]/.test(value)&&!value.includes('..'))){
        const file=p.join(root,folder,'package.json');if(!this.safeExists(file))continue;
        let metadata;try{metadata=this.readManifest(file);}catch{}
        if(typeof metadata?.publisher==='string'&&metadata.publisher.toLowerCase()===publisher.toLowerCase()&&metadata?.name===name)return true;
      }
    }
    return false;
  }
  // Desktop apps are often installed on another drive. Their per-user data and
  // updater folders, or a Start-menu shortcut, still show they are installed.
  installMarkers(definition){
    if(this.platform!=='win32')return false;const e=this.env,p=this.path,app=e.APPDATA||'',local=e.LOCALAPPDATA||'',common=e.ProgramData||'';
    const menus=[app&&p.join(app,'Microsoft','Windows','Start Menu','Programs'),common&&p.join(common,'Microsoft','Windows','Start Menu','Programs')].filter(Boolean);
    const marks={'qwen-desktop':[app&&p.join(app,'Qwen','Local Storage'),local&&p.join(local,'qwen-updater'),...menus.map(m=>p.join(m,'Qwen.lnk')),...menus.map(m=>p.join(m,'Qwen','Qwen.lnk'))],
      doubao:[app&&p.join(app,'Doubao'),local&&p.join(local,'Doubao'),...menus.map(m=>p.join(m,'豆包.lnk'))]}[definition.id]||[];
    return marks.filter(Boolean).some(mark=>this.safeExists(mark));
  }
  installedPaths(definition){
    const p=this.path,e=this.env,home=e.USERPROFILE||e.HOME||'',local=e.LOCALAPPDATA||'',app=e.APPDATA||'';let candidates=[];
    const names=(definition.executableNames||[]).filter(name=>this.platform==='win32'?!/^codex$|^claude$|^cursor$|^qwen$|^gemini$|^opencode$/i.test(name):!/\.exe$|\.cmd$/i.test(name));
    for(const directory of (e.PATH||'').split(this.platform==='win32'?';':':').filter(Boolean))for(const name of names)candidates.push(p.join(directory,name));
    if(definition.id==='codex'){
      if(e.AGENTROOM_CODEX_PATH&&/^codex(?:\.exe)?$/i.test(p.basename(e.AGENTROOM_CODEX_PATH)))candidates.unshift(e.AGENTROOM_CODEX_PATH);
      candidates.push(p.join(home,'.local','bin',this.platform==='win32'?'codex.exe':'codex'));
      if(this.platform==='win32'&&local){const root=p.join(local,'OpenAI','Codex','bin');let versions=[];try{if(this.safeExists(root))versions=this.listFiles(root)||[];}catch{}
        for(const version of versions.filter(v=>typeof v==='string'&&!/[\\/]/.test(v)).sort().reverse())candidates.push(p.join(root,version,'codex.exe'));}
    }else if(definition.id==='claude-code'){
      const cached=e.AGENTROOM_CLAUDE_CODE_PATH||e.AGENTROOM_CLAUDE_PATH;
      if(cached&&p.isAbsolute(cached)&&/^claude(?:\.exe)?$/i.test(p.basename(cached)))candidates.unshift(cached);
      candidates.push(p.join(home,'.local','bin',this.platform==='win32'?'claude.exe':'claude'));if(this.platform==='win32'&&app)candidates.push(p.join(app,'npm','claude.cmd'));
    }
    else if(definition.id==='qwen-code'){
      if(e.AGENTROOM_QWEN_CODE_PATH&&p.isAbsolute(e.AGENTROOM_QWEN_CODE_PATH)&&/^qwen(?:\.exe)?$|^node(?:\.exe)?$/i.test(p.basename(e.AGENTROOM_QWEN_CODE_PATH))){
        const native=/^qwen(?:\.exe)?$/i.test(p.basename(e.AGENTROOM_QWEN_CODE_PATH));
        if(native&&!e.AGENTROOM_QWEN_CODE_SCRIPT||!native&&typeof e.AGENTROOM_QWEN_CODE_SCRIPT==='string'&&p.isAbsolute(e.AGENTROOM_QWEN_CODE_SCRIPT)&&qwenVendorScript(e.AGENTROOM_QWEN_CODE_SCRIPT)&&this.safeExists(e.AGENTROOM_QWEN_CODE_SCRIPT))candidates.unshift(e.AGENTROOM_QWEN_CODE_PATH);
      }
      candidates.push(p.join(home,'.qwen','bin',this.platform==='win32'?'qwen.exe':'qwen'),p.join(home,'.local','bin',this.platform==='win32'?'qwen.exe':'qwen'));
      if(this.platform==='win32'&&app)candidates.push(p.join(app,'npm','qwen.cmd'));
    }
    else if(definition.id==='gemini-cli'){
      const configured=e.AGENTROOM_GEMINI_PATH||e.AGENTROOM_GEMINI_CLI_PATH;
      if(typeof configured==='string'&&p.isAbsolute(configured)&&/^node(?:\.exe)?$/i.test(p.basename(configured))&&geminiVendorScript(e.AGENTROOM_GEMINI_SCRIPT)&&this.safeExists(e.AGENTROOM_GEMINI_SCRIPT))candidates.unshift(configured);
      if(this.platform==='win32'&&app)candidates.push(p.join(app,'npm','gemini.cmd'));
    }
    else if(definition.id==='cursor'&&this.platform==='win32'){if(local)candidates.push(p.join(local,'Programs','cursor','Cursor.exe'));if(e.ProgramFiles)candidates.push(p.join(e.ProgramFiles,'Cursor','Cursor.exe'));}
    else if(definition.id==='grok-cli')candidates.push(p.join(home,'.grok','bin',this.platform==='win32'?'grok.exe':'grok'));
    else if(definition.id==='grok-bot'&&this.platform==='win32'){if(local)candidates.push(p.join(local,'Programs','Grok Bot','Grok Bot.exe'));if(e.ProgramFiles)candidates.push(p.join(e.ProgramFiles,'Grok Bot','Grok Bot.exe'));}
    else if(definition.id==='doubao'&&this.platform==='win32'){if(local)candidates.push(p.join(local,'Doubao','application','Doubao.exe'),p.join(local,'Programs','Doubao','Doubao.exe'));if(e.ProgramData)candidates.push(p.join(e.ProgramData,'Doubao','app','Doubao.exe'));}
    else if(definition.id==='cherry-studio'&&this.platform==='win32'){if(local)candidates.push(p.join(local,'Programs','Cherry Studio','Cherry Studio.exe'));if(e.ProgramFiles)candidates.push(p.join(e.ProgramFiles,'Cherry Studio','Cherry Studio.exe'));}
    else if(definition.id==='qwen-desktop'&&this.platform==='win32'){if(local)candidates.push(p.join(local,'Programs','Qwen','Qwen.exe'));if(e.ProgramFiles)candidates.push(p.join(e.ProgramFiles,'Qwen','Qwen.exe'));for(const drive of 'DEFGHW')candidates.push(`${drive}:\\Program Files\\Qwen\\Qwen.exe`);}
    let custom=definition.executables||[];if(typeof custom==='function')try{custom=custom({platform:this.platform,env:this.env,path:this.path});}catch{custom=[];}
    candidates.push(...(Array.isArray(custom)?custom:[]));return [...new Set(candidates.filter(v=>typeof v==='string'&&v&&!/[\r\n\u0000]/.test(v)))].filter(v=>this.safeExists(v)&&(definition.id!=='claude-code'||!claudeDesktop(v))&&(definition.id!=='qwen-code'||!qwenDesktop(v)));
  }
  close(){this.closed=true;this.inventoryController?.abort();return this.pendingInventory;}
  async scan(options={}){
    if(this.closed)throw new Error('客户端扫描已停止。');
    let result=options.processes;
    if(result===undefined){
      if(!this.pendingInventory){
        const controller=this.inventoryController=new AbortController();
        const pending=Promise.resolve().then(()=>this.inventory({signal:controller.signal})).catch(()=>({processes:[],available:false})).finally(()=>{if(this.pendingInventory===pending){this.pendingInventory=null;this.inventoryController=null;}});
        this.pendingInventory=pending;
      }
      result=await this.pendingInventory;
      if(this.closed)throw new Error('客户端扫描已停止。');
    }
    const rows=Array.isArray(result)?result:result?.processes||[];const available=Array.isArray(result)||result?.available!==false;
    const processes=rows.filter(p=>p&&typeof p==='object').map(p=>({name:clean(p.Name??p.name,120),pid:positive(p.ProcessId??p.pid),parentPid:positive(p.ParentProcessId??p.parentPid),executable:clean(p.ExecutablePath??p.executable,2048),commandLine:String(p.CommandLine??p.commandLine??'')}));
    const processById=new Map(processes.filter(p=>p.pid).map(p=>[p.pid,p]));
    const candidates=this.catalog.map(definition=>{
      let matches=[];for(const process of processes){if(genericWorker(process))continue;let match;try{match=definition.matchProcess?.(process,{platform:this.platform,path:this.path,env:this.env});}catch{continue;}if(!match)continue;
        if(match===true)match={role:'unknown',confidence:'process_name'};if(match.role==='worker'||match.is_worker)continue;
        const parent=processById.get(process.parentPid);if(parent&&match.role==='desktop'&&pathEqual(parent.executable,process.executable,this.platform)&&parent.executable&&parent.name===process.name)continue;
        matches.push({pid:process.pid,parent_pid:process.parentPid,executable:process.executable||null,role:['cli','desktop','unknown'].includes(match.role)?match.role:'unknown',confidence:['process_name','script_path','verified_path'].includes(match.confidence)?match.confidence:'process_name'});
      }
      const paths=this.installedPaths(definition),extension=this.extensionInstalled(definition),installed=!!paths.length||extension||this.installMarkers(definition)||matches.some(m=>m.executable&&this.safeExists(m.executable)),running=matches.length>0;
      // Codex's desktop binary cannot be used as its CLI merely because the name
      // matches. Only separately discovered executable entrypoints are launchable.
      let executable=paths[0]||matches.find(m=>m.executable)?.executable||null,executableArgs=[];
      if(definition.id==='codex'&&!paths.length)executable=matches.find(m=>m.role==='cli'&&m.executable&&/[\\/](?:@openai[\\/]codex[\\/]vendor|OpenAI[\\/]Codex[\\/]bin|resources[\\/]bin)[\\/]/i.test(m.executable))?.executable||null;
      if(definition.id==='claude-code'){const resolved=this.claudeLaunch(paths,processes);executable=resolved.executable;executableArgs=resolved.args;}
      if(definition.id==='qwen-code'){const resolved=this.qwenLaunch(paths,processes);executable=resolved.executable;executableArgs=resolved.args;}
      if(definition.id==='gemini-cli'){const resolved=this.geminiLaunch(paths,processes);executable=resolved.executable;executableArgs=resolved.args;}
      const requested=definition.capabilities||{},caps={automatic_launch:!!requested.automatic_launch&&!!executable,mcp_install:!!requested.mcp_install,mcp_prepare:!!requested.mcp_prepare,runtime_install:!!requested.runtime_install,manual_connect:!!requested.manual_connect,attach_existing:!!requested.attach_existing,native_group_proxy:!!requested.native_group_proxy};
      const support=definition.kind==='unsupported'?'unsupported':caps.automatic_launch?'ready':'needs_setup';
      const reason=['codex','claude-code','qwen-code','gemini-cli'].includes(definition.id)&&!caps.automatic_launch?definition.missingReason:definition.reason||'需通过适配器完成真实通信握手。';
      let state=null;try{const raw=this.queryState(definition.provider||definition.id);if(raw&&typeof raw==='object'){const count=value=>Number.isFinite(Number(value))?Math.max(0,Math.floor(Number(value))):0;state={connected_count:count(raw.connected_count),online_count:count(raw.online_count),status:['connected','offline','unknown','needs_setup'].includes(raw.status)?raw.status:'unknown'};}}catch{}
      return {id:definition.id,provider:clean(definition.provider||definition.id,80),name:clean(definition.name||definition.id,120),adapter:clean(definition.adapter||'mailbox',100),installed,running,instances:matches,pids:matches.map(m=>m.pid).filter(Boolean),executable,...executableArgs.length?{executable_args:executableArgs}:{},capabilities:caps,support,reason:clean(reason,700),setup_note:clean(reason,700),can_connect:support!=='unsupported'&&(!!definition.alwaysAvailable||installed||running||definition.kind==='bridge'||caps.runtime_install),identity:{confidence:paths.length?'installation_path':extension?'extension_manifest':running?'process_metadata':'unavailable',handshake_verified:false},actions:[...(caps.automatic_launch?[{id:'launch-managed',label:'创建专用协作会话'}]:[]),...(caps.runtime_install&&!caps.automatic_launch?[{id:'install-runtime',label:'安装并接入后台入口'}]:[]),...(caps.mcp_install?[{id:'install-mcp',label:'安装 MCP 通信配置'}]:[]),...(caps.mcp_prepare?[{id:'prepare-mcp',label:definition.id==='doubao'?'准备个人连接器':'准备 MCP 接入配置'}]:[]),...(definition.kind==='bridge'?[{id:'setup-bridge',label:'配置原生桥接 Bot'}]:[]),...(!caps.automatic_launch&&support!=='unsupported'?[{id:'copy-entry',label:'提供持久协作入口'}]:[])],...(definition.source?{source:definition.source}:{}),...(definition.minimumVersion?{minimum_version:definition.minimumVersion}:{}),...(state?{connection:state}:{})};
    });
    return {scanned_at:this.clock(),process_scan:{available,...!available?{reason:'暂时无法读取本机进程清单；已安装的入口仍可使用。'}:{}},candidates};
  }
}
module.exports={DiscoveryCatalog,defaultCatalog,windowsProcessInventory,qwenVendorScript,geminiVendorScript};
