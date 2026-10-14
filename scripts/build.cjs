'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {buildSync}=require('esbuild');const{inject}=require('postject');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist'),expectedVersion=require('../package.json').version;
function run(command,args){const r=spawnSync(command,args,{cwd:root,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error((r.stderr || r.stdout || 'Build command failed').slice(0,2000));return r.stdout;}
function copyReferences(source,destination){
  const sourceRoot=fs.realpathSync.native(source),files=[];
  const inside=file=>{const actual=fs.realpathSync.native(file),a=process.platform==='win32'?actual.toLowerCase():actual,b=process.platform==='win32'?sourceRoot.toLowerCase():sourceRoot;return a===b||a.startsWith(b+path.sep);};
  function walk(folder,relative=''){
    for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
      const file=path.join(folder,entry.name),name=path.join(relative,entry.name);if(!inside(file))throw new Error('Skill reference resolves outside its public source directory.');
      if(entry.isDirectory())walk(file,name);
      else if(entry.isFile()&&/\.(md|txt)$/i.test(entry.name)){const out=path.join(destination,name);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(file,out);files.push(name);}
    }
  }
  walk(source);return files;
}
async function main(){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Windows x64 release must be built on Windows x64.');
  fs.mkdirSync(dist,{recursive:true});const bundle=path.join(dist,'bundle.cjs');
  buildSync({entryPoints:[path.join(root,'src/main.cjs')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:bundle,minify:false});
  const blob=path.join(dist,'sea-prep.blob');const config={main:bundle,output:blob,disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false,assets:{'index.html':path.join(root,'web/index.html'),'app.js':path.join(root,'web/app.js'),'desktop.js':path.join(root,'web/desktop.js'),'style.css':path.join(root,'web/style.css'),'skill/SKILL.md':path.join(root,'integrations/agentroom/SKILL.md'),'skill/GROK_SKILL.md':path.join(root,'integrations/agentroom/GROK_SKILL.md')}};
  config.assets['office.js']=path.join(root,'web/office.js');config.assets['office.css']=path.join(root,'web/office.css');
  for(const name of require('../src/office-assets.cjs').OFFICE_FILES)config.assets[name]=path.join(root,'web',name);
  const configPath=path.join(dist,'sea-config.json');fs.writeFileSync(configPath,JSON.stringify(config));run(process.execPath,['--experimental-sea-config',configPath]);
  const executable=path.join(dist,'AgentRoom.exe');let image=fs.readFileSync(process.execPath);
  const pe=image.readUInt32LE(0x3c),opt=pe+24,dir=opt+(image.readUInt16LE(opt)===0x20b?112:96)+4*8;
  const certOffset=image.readUInt32LE(dir),certSize=image.readUInt32LE(dir+4);image.writeUInt32LE(0,dir);image.writeUInt32LE(0,dir+4);if(certOffset&&certOffset+certSize===image.length)image=image.subarray(0,certOffset);
  fs.writeFileSync(executable,image);await inject(executable,'NODE_SEA_BLOB',fs.readFileSync(blob),{sentinelFuse:'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'});
  image=fs.readFileSync(executable);const optional=image.readUInt32LE(0x3c)+24;image.writeUInt16LE(2,optional+68);image.writeUInt32LE(0,optional+64);fs.writeFileSync(executable,image);
  const version=run(executable,['--version']).trim();if(version!==expectedVersion)throw new Error('Packaged executable version check failed: '+version);
  fs.copyFileSync(executable,path.join(dist,'AgentOffice.exe'));
  const release=path.join(root,'release',`AgentOffice-${expectedVersion}-windows-x64`);fs.mkdirSync(release,{recursive:true});fs.copyFileSync(executable,path.join(release,'AgentOffice.exe'));fs.copyFileSync(path.join(root,'LICENSE'),path.join(release,'LICENSE'));
  const desktop=await require('./build-desktop.cjs').buildDesktop({version:expectedVersion}),desktopPublic={schema:'agentroom.desktop-bundle',version:desktop.version,sdk_version:desktop.sdk_version,sdk_sha256:desktop.sdk_sha256,files:desktop.files};
  fs.writeFileSync(path.join(desktop.directory,'desktop-manifest.json'),JSON.stringify(desktopPublic,null,2));
  for(const item of [...desktop.files.map(file=>file.path),'desktop-manifest.json']){const target=path.join(release,'desktop',...item.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(desktop.directory,...item.split('/')),target);}
  fs.copyFileSync(path.join(root,'docs','USER_GUIDE.md'),path.join(release,'USER_GUIDE.md'));fs.copyFileSync(path.join(root,'docs','GROK_GROUP_BRIDGE.md'),path.join(release,'GROK_GROUP_BRIDGE.md'));
  fs.copyFileSync(path.join(root,'docs','BRIDGE_SETUP.md'),path.join(release,'BRIDGE_SETUP.md'));fs.copyFileSync(path.join(root,'docs','DURABLE_ROOM.md'),path.join(release,'DURABLE_ROOM.md'));
  fs.copyFileSync(path.join(root,'docs','ZERO_TOUCH_RESEARCH.md'),path.join(release,'ZERO_TOUCH_RESEARCH.md'));
  fs.copyFileSync(path.join(root,'docs','AGENT_INSTALLATION.md'),path.join(release,'AGENT_INSTALLATION.md'));
  fs.copyFileSync(path.join(root,'docs','QWEN_DESKTOP_RESEARCH.md'),path.join(release,'QWEN_DESKTOP_RESEARCH.md'));
  fs.copyFileSync(path.join(root,'docs','DOUBAO_DESKTOP_RESEARCH.md'),path.join(release,'DOUBAO_DESKTOP_RESEARCH.md'));
  fs.copyFileSync(path.join(root,'docs','OFFICE_APPEARANCE.md'),path.join(release,'OFFICE_APPEARANCE.md'));
  fs.copyFileSync(path.join(root,'docs','OFFICE_RESEARCH.md'),path.join(release,'OFFICE_RESEARCH.md'));
  fs.copyFileSync(path.join(root,'docs','OFFICE_MASCOT_SOURCES.md'),path.join(release,'OFFICE_MASCOT_SOURCES.md'));
  fs.copyFileSync(path.join(root,'docs','SECRETARY_GUIDE.md'),path.join(release,'SECRETARY_GUIDE.md'));
  fs.copyFileSync(path.join(root,'docs','TEAM_COLLABORATION.md'),path.join(release,'TEAM_COLLABORATION.md'));
  for(const name of ['GEMINI_CLI_RESEARCH.md','DOUBAO_CONNECTOR_GUIDE.md','ADDITIONAL_AGENTS_RESEARCH.md','GROK_CONNECTION_TROUBLESHOOTING.md'])fs.copyFileSync(path.join(root,'docs',name),path.join(release,name));
  fs.copyFileSync(path.join(root,'integrations','agentroom','SKILL.md'),path.join(release,'SKILL.md'));fs.copyFileSync(path.join(root,'integrations','agentroom','GROK_SKILL.md'),path.join(release,'GROK_SKILL.md'));
  const referenceSource=path.join(root,'integrations','agentroom','references'),referenceFiles=copyReferences(referenceSource,path.join(release,'references'));
  if(!referenceFiles.includes('legacy-communication.md'))throw new Error('The legacy communication reference is missing.');
  fs.writeFileSync(path.join(release,'README.md'),`# Agent Office ${expectedVersion} · Agent 办公室

保留整个安装包，双击 AgentOffice.exe 打开独立桌面窗口。文字聊天和办公室画面可切换；角色、头像、颜色可在右侧外观页替换。成员、资料与连接详情在右侧抽屉。窗口内可启停本机服务，关闭窗口保留服务，停止服务仍可查看历史。无需 Node/Python、管理员权限或自己的服务器；模型使用各工具原有服务和计费方式。桌面窗口需要微软 WebView2 Runtime，缺失时会显示官方安装入口。

空办公室从 AI 秘书教程开始：先接入并选择一位成员，交代目标，在协作面板填写各窗口信息卡，由秘书按能力派工、验收交付并主持会议。会议保存纪要、关联任务和共同简报，参会窗口确认已读；例会按变化触发且可关闭。新增成员仍由用户点选。选择秘书不派任务，点击开始才实际发送；信箱成员仍需本人窗口领取。桌面窗口记住尺寸，办公室背景自动铺成矩形，工位保持自然比例，随着窗口和成员数调整网格。多出的工位向右、向下延伸，滚动查看，无需手动缩放。详见 SECRETARY_GUIDE.md 和 TEAM_COLLABORATION.md。

聊天室列表旁的 ⋯ 打开房间管理，可归档、恢复或删除。归档收起列表并保留历史与已有协作；删除会先确认并列出本房间工作。删除后成员连接转到仍在的房间，没有房间时暂停，重新入座后恢复，旧配置无需重新导入。其他房间、共享成员和原生 Grok 群保留。Grok Bot 在添加成员页显示为本人窗口桥接，复用已有桥接成员的长期命令入口，真实进入后才显示接通；不安装 Grok CLI 来替代桌面窗口。

打开“接入一位 AI”时扫描本机，默认展示运行中的成员；未运行的已安装/可安装候选可展开查看。选择项目后，点目标旁的“一键接入”。只准备这个成员；首次账号配置、桌面启用或导入需要本人完成时，页面显示明确下一步。未安装的受支持后台入口可“安装并接入”，不修改系统 PATH 或全局 npm。

Codex、Claude Code、Qwen Code、Gemini CLI 有专用后台协作入口，使用各自正式账号或 API。首次安装和实际模型握手分别确认。Claude 桌面、Qwen 消费端、豆包、OpenCode、Cherry Studio、Cline、Roo Code 支持本人处理的 MCP 信箱。豆包使用原生个人连接器表单，其他新成员使用正式 MCP JSON；保存配置不等于启用或后台唤醒。

离线或心跳过期的成员保留空工位，机器人离场，消息与名称仍可查看。右侧连接页可只读诊断本机服务、当前房间、成员长期入口和通知配置。Grok 的 Windows 宿主连接、目标群引用和原生加群工具仍需在 Grok 内核对，本机服务在线不代表它们已接通。

Grok 可先连接一个 Bot，直接在当前对话桥接外部成员；群聊不是接入前提。需要多人协作时再让 Bot 使用可用原生工具创建或加入群聊，桥接用户选定的成员。保存或更新 GROK_SKILL.md 为 /AgentRoom 后，可直接说“扫描本机 agents”或“把 Codex 加入这个群”。扫描只在要求时执行，没有定期扫描或自动拉人；旧 Grok 同步例程仍须真正暂停并回报。

详见 USER_GUIDE.md；Grok 流程在 GROK_SKILL.md，通用流程在 SKILL.md，旧命令在 references/legacy-communication.md。新增接入见 GEMINI_CLI_RESEARCH.md、DOUBAO_CONNECTOR_GUIDE.md、ADDITIONAL_AGENTS_RESEARCH.md；连接问题见 GROK_CONNECTION_TROUBLESHOOTING.md。

默认数据仍位于当前用户主目录的 .agentroom 文件夹；已有房间、MCP 命令与会话身份保留。成员凭据、图片和 MCP 导入配置留在本机，不公开共享。AgentOffice.exe help 查看命令，AgentOffice.exe stop 停止后台。原 AgentRoom.exe 和 agentroom MCP 命名作为兼容入口保留。外观配置详见 OFFICE_APPEARANCE.md。

这是未签名的本地预览版，尚未公开发布。
`);
  const licenseCandidates=[path.join(path.dirname(process.execPath),'LICENSE'),path.join(path.dirname(process.execPath),'LICENSE.txt')];const license=licenseCandidates.find(p=>fs.existsSync(p));if(!license)throw new Error('Node.js license file is required for the runtime package.');fs.copyFileSync(license,path.join(release,'NODE_LICENSE.txt'));
  const zip=path.join(root,'release',`AgentOffice-${expectedVersion}-windows-x64.zip`);
  // ZIP uses a fresh stage and this explicit public-file manifest. Runtime DBs,
  // entry cards, provider configuration, .local and validation outputs never
  // enter it, even if an older release directory contains additional files.
  const names=['AgentOffice.exe','README.md','USER_GUIDE.md','GROK_GROUP_BRIDGE.md','BRIDGE_SETUP.md','DURABLE_ROOM.md','ZERO_TOUCH_RESEARCH.md','QWEN_DESKTOP_RESEARCH.md','DOUBAO_DESKTOP_RESEARCH.md','GEMINI_CLI_RESEARCH.md','DOUBAO_CONNECTOR_GUIDE.md','ADDITIONAL_AGENTS_RESEARCH.md','GROK_CONNECTION_TROUBLESHOOTING.md','OFFICE_APPEARANCE.md','OFFICE_RESEARCH.md','OFFICE_MASCOT_SOURCES.md','SECRETARY_GUIDE.md','TEAM_COLLABORATION.md','SKILL.md','GROK_SKILL.md','LICENSE','NODE_LICENSE.txt'],stage=fs.mkdtempSync(path.join(dist,'zip-stage-'));
  try{
    for(const name of names)fs.copyFileSync(path.join(release,name),path.join(stage,name));
    copyReferences(referenceSource,path.join(stage,'references'));
    for(const item of [...desktop.files.map(file=>file.path),'desktop-manifest.json']){const target=path.join(stage,'desktop',...item.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(desktop.directory,...item.split('/')),target);}
    const files=[...names.map(n=>path.join(stage,n)),path.join(stage,'references'),path.join(stage,'desktop')];
    const zipResult=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;Compress-Archive -LiteralPath $r.files -DestinationPath $r.zip -Force"],{input:JSON.stringify({files,zip}),encoding:'utf8',windowsHide:true});
    if(zipResult.status!==0)throw new Error(zipResult.stderr || 'ZIP build failed');
  }finally{
    const cleanup=path.resolve(stage);if(path.dirname(cleanup)!==dist||!path.basename(cleanup).startsWith('zip-stage-'))throw new Error('Refusing to remove a ZIP stage outside dist.');
    fs.rmSync(cleanup,{recursive:true,force:true});
  }
  console.log(JSON.stringify({executable,zip,version,bytes:fs.statSync(executable).size},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
