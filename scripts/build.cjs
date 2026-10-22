'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),expectedVersion=require('../package.json').version;
const {sourceState,sha,atomicJson,acquireLock,regularFile}=require('./release-common.cjs');
function parseArgs(args){
  const options={dev:false,localOnly:false,outputRoot:root};
  for(let index=0;index<args.length;index++){
    const flag=args[index];
    if(flag==='--dev')options.dev=true;
    else if(flag==='--local-only')options.localOnly=true;
    else if(flag==='--output-root'){
      if(!args[index+1]||args[index+1].startsWith('--'))throw new Error('--output-root requires a directory');
      options.outputRoot=path.resolve(args[++index]);
    }else throw new Error('Unknown build option: '+flag);
  }
  return options;
}
function developmentDirectory(directory){
  if(!fs.existsSync(directory))return false;
  if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw new Error('Development output must be a regular directory: '+directory);
  const manifest=JSON.parse(fs.readFileSync(regularFile(directory,'release-manifest.json'),'utf8'));
  if(manifest.schema!=='agentoffice.release'||typeof manifest.version!=='string'||!Array.isArray(manifest.files))throw new Error('Refusing to replace an unrecognized development directory: '+directory);
  regularFile(directory,'AgentOffice.exe');return true;
}
function publishDevelopment(outputRoot,directory,{rename=fs.renameSync}={}){
  outputRoot=path.resolve(outputRoot);directory=path.resolve(directory);
  const stageRoot=path.dirname(path.dirname(directory)),stageParent=path.join(outputRoot,'output');
  if(path.dirname(stageRoot)!==stageParent||!path.basename(stageRoot).startsWith('dev-build-')||path.basename(path.dirname(directory))!=='release')throw new Error('Development package is outside its owned build stage.');
  const manifest=JSON.parse(fs.readFileSync(regularFile(directory,'release-manifest.json'),'utf8'));
  require('./release-artifacts.cjs').readManifest(directory,manifest.version,manifest.source);
  const destination=path.join(outputRoot,'dev'),previous=path.join(outputRoot,'dev.previous'),retired=path.join(stageRoot,'previous-retired');
  const currentExists=developmentDirectory(destination),previousExists=developmentDirectory(previous);
  let retiredPrevious=false,movedCurrent=false;
  try{
    if(currentExists&&previousExists){rename(previous,retired);retiredPrevious=true;}
    if(currentExists){rename(destination,previous);movedCurrent=true;}
    rename(directory,destination);
  }catch(error){
    try{
      if(movedCurrent)rename(previous,destination);
      if(retiredPrevious)rename(retired,previous);
    }catch(rollback){
      error.preserveStage=true;error.message+='; recovery files were kept in '+stageRoot+': '+rollback.message;
    }
    error.message='Development update failed; close Agent Office and retry. '+error.message;throw error;
  }
  return {executable:path.join(destination,'AgentOffice.exe'),release:destination,previous:fs.existsSync(previous)?previous:null,version:manifest.version,bytes:fs.statSync(path.join(destination,'AgentOffice.exe')).size};
}
async function buildDevelopment({outputRoot=root,build=buildPackage}={}){
  outputRoot=path.resolve(outputRoot);const stageParent=path.join(outputRoot,'output');fs.mkdirSync(stageParent,{recursive:true});
  const unlock=acquireLock(path.join(stageParent,'dev-build.lock'));let stage,preserveStage=false;
  try{
    stage=fs.mkdtempSync(path.join(stageParent,'dev-build-'));
    const result=await build({outputRoot:stage,localOnly:true});
    return publishDevelopment(outputRoot,result.release);
  }catch(error){preserveStage=!!error.preserveStage;throw error;}
  finally{
    try{if(stage&&!preserveStage){const cleanup=path.resolve(stage);if(path.dirname(cleanup)!==stageParent||!path.basename(cleanup).startsWith('dev-build-'))throw new Error('Refusing to remove a development stage outside output.');fs.rmSync(cleanup,{recursive:true,force:true});}}finally{unlock();}
  }
}
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
async function buildPackage({outputRoot=root,localOnly=false}={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Windows x64 release must be built on Windows x64.');
  const {buildSync}=require('esbuild'),{inject}=require('postject'),dist=path.join(outputRoot,'dist');
  const source=sourceState(root);
  fs.mkdirSync(dist,{recursive:true});const bundle=path.join(dist,'bundle.cjs');
  buildSync({entryPoints:[path.join(root,'src/main.cjs')],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:bundle,minify:false});
  const blob=path.join(dist,'sea-prep.blob');const config={main:bundle,output:blob,disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false,assets:{'index.html':path.join(root,'web/index.html'),'app.js':path.join(root,'web/app.js'),'desktop.js':path.join(root,'web/desktop.js'),'style.css':path.join(root,'web/style.css'),'skill/SKILL.md':path.join(root,'integrations/agentroom/SKILL.md'),'skill/GROK_SKILL.md':path.join(root,'integrations/agentroom/GROK_SKILL.md')}};
  config.assets['office.js']=path.join(root,'web/office.js');config.assets['office.css']=path.join(root,'web/office.css');config.assets['page-activity.js']=path.join(root,'web/page-activity.js');
  for(const name of require('../src/office-assets.cjs').OFFICE_FILES)config.assets[name]=path.join(root,'web',name);
  const configPath=path.join(dist,'sea-config.json');fs.writeFileSync(configPath,JSON.stringify(config));run(process.execPath,['--experimental-sea-config',configPath]);
  const executable=path.join(dist,'AgentRoom.exe');let image=fs.readFileSync(process.execPath);
  const pe=image.readUInt32LE(0x3c),opt=pe+24,dir=opt+(image.readUInt16LE(opt)===0x20b?112:96)+4*8;
  const certOffset=image.readUInt32LE(dir),certSize=image.readUInt32LE(dir+4);image.writeUInt32LE(0,dir);image.writeUInt32LE(0,dir+4);if(certOffset&&certOffset+certSize===image.length)image=image.subarray(0,certOffset);
  fs.writeFileSync(executable,image);await inject(executable,'NODE_SEA_BLOB',fs.readFileSync(blob),{sentinelFuse:'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'});
  image=fs.readFileSync(executable);const optional=image.readUInt32LE(0x3c)+24;image.writeUInt16LE(2,optional+68);image.writeUInt32LE(0,optional+64);fs.writeFileSync(executable,image);
  const version=run(executable,['--version']).trim();if(version!==expectedVersion)throw new Error('Packaged executable version check failed: '+version);
  fs.copyFileSync(executable,path.join(dist,'AgentOffice.exe'));
  const release=path.join(outputRoot,'release',`AgentOffice-${expectedVersion}-windows-x64`);fs.mkdirSync(release,{recursive:true});fs.copyFileSync(executable,path.join(release,'AgentOffice.exe'));fs.copyFileSync(path.join(root,'LICENSE'),path.join(release,'LICENSE'));
  const desktop=await require('./build-desktop.cjs').buildDesktop({outputDir:path.join(dist,'desktop'),version:expectedVersion}),desktopPublic={schema:'agentroom.desktop-bundle',version:desktop.version,sdk_version:desktop.sdk_version,sdk_sha256:desktop.sdk_sha256,files:desktop.files};
  fs.writeFileSync(path.join(desktop.directory,'desktop-manifest.json'),JSON.stringify(desktopPublic,null,2));
  for(const item of [...desktop.files.map(file=>file.path),'desktop-manifest.json']){const target=path.join(release,'desktop',...item.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(desktop.directory,...item.split('/')),target);}
  fs.copyFileSync(path.join(root,'docs','USER_GUIDE.md'),path.join(release,'USER_GUIDE.md'));fs.copyFileSync(path.join(root,'docs','GROK_GROUP_BRIDGE.md'),path.join(release,'GROK_GROUP_BRIDGE.md'));
  fs.copyFileSync(path.join(root,'docs','BRIDGE_SETUP.md'),path.join(release,'BRIDGE_SETUP.md'));fs.copyFileSync(path.join(root,'docs','DURABLE_ROOM.md'),path.join(release,'DURABLE_ROOM.md'));
  fs.copyFileSync(path.join(root,'docs','ZERO_TOUCH_RESEARCH.md'),path.join(release,'ZERO_TOUCH_RESEARCH.md'));
  fs.copyFileSync(path.join(root,'docs','AGENT_INSTALLATION.md'),path.join(release,'AGENT_INSTALLATION.md'));
  fs.copyFileSync(path.join(root,'docs','QWEN_DESKTOP_RESEARCH.md'),path.join(release,'QWEN_DESKTOP_RESEARCH.md'));
  fs.copyFileSync(path.join(root,'docs','NATIVE_DESKTOP.md'),path.join(release,'NATIVE_DESKTOP.md'));
  fs.copyFileSync(path.join(root,'docs','OPERATION_POLICY.md'),path.join(release,'OPERATION_POLICY.md'));
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

保留整个安装包，双击 AgentOffice.exe 打开独立桌面窗口。文字聊天和办公室画面可切换；角色、头像、颜色可在右侧外观页替换。成员、资料与连接详情在右侧抽屉。打开软件自动启动本机服务，关闭软件停止服务；最小化时服务继续运行，页面暂停刷新与动画，恢复后同步最新进度。无需 Node/Python、管理员权限或自己的服务器；模型使用各工具原有服务和计费方式。桌面窗口需要微软 WebView2 Runtime，缺失时会显示官方安装入口。

接入时 AO 自动核对这位同事的真实回复，验证通过后进入办公室。重复检查沿用同一条验证记录；结果不明时保留原请求核对。已有自动连接断线后会逐步恢复原人物对话，版本或授权需要处理时显示具体原因。已授权的日常读取和办公室协作自动处理，需要本人决定的操作在对应成员最新对话中选择；无需回到聊天顶部。详见 OPERATION_POLICY.md。

升级直接打开此文件夹的 AgentOffice.exe，沿用本机已有数据、人物、原生对话与 MCP 配置，无需重新导入。旧 MCP 程序被客户端占用时保留原进程，核对文件后更新原命令路径；原地址和凭据继续使用。稳定入口更新后，原 MCP 进程也能启动新版后台。其他文件锁阻止替换时会保留连接并使用并排安装，稍后打开新版继续更新稳定入口。用户主动撤销的入口仍保持撤销。

在 AO 对话说「把 Grok Bot 拉进来」或「拉个豆包进来」，已有适配器可直接连接；需要本人窗口配合时，对话会给出接入文档和复制句。按真实握手更新状态，不把文档生成当成接通。顶部显示实际后台版本，与软件版本不同时分别列出。

连接 Grok Bot 时，主界面按三步引导：复制连接说明，发给要接入的 Grok Bot，并在 Grok 中完成它提出的电脑工具授权；AO 自动检查真实连接，确认后进入办公室。无需先创建群聊或手填房间 ID。只有用户另外要求群聊时才处理原生群；Grok 的本人本机入口接通与后台自动唤醒分别报告。

空办公室从 AI 秘书教程开始：先接入并选择一位成员，交代目标，在协作面板填写各窗口信息卡，由秘书按能力派工、验收交付并主持会议。会议保存纪要、关联任务和共同简报，参会窗口确认已读；例会按变化触发且可关闭。新增成员仍由用户点选。选择秘书不派任务，点击开始才实际发送；已接通的原生对话自动处理，手动信箱成员需本人窗口领取。当前 Qwen 与豆包原生自动收发已通过真实验收；豆包原生 MCP 工具调用及 Grok 原生收发仍待单独验收，详见 NATIVE_DESKTOP.md。桌面窗口记住尺寸，办公室背景自动铺成矩形，工位保持自然比例，随着窗口和成员数调整网格。多出的工位向右、向下延伸，滚动查看，无需手动缩放。详见 SECRETARY_GUIDE.md 和 TEAM_COLLABORATION.md。

聊天室列表旁的 ⋯ 打开房间管理，可归档、恢复或删除。归档收起列表并保留历史与已有协作；删除会先确认并列出本房间工作。删除后成员连接转到仍在的房间，没有房间时暂停，重新入座后恢复，旧配置无需重新导入。其他房间、共享成员和原生 Grok 群保留。Grok Bot 在添加成员页显示为本人窗口桥接，复用已有桥接成员的长期命令入口，真实进入后才显示接通；不安装 Grok CLI 来替代桌面窗口。

打开“接入一位 AI”时扫描本机，默认展示运行中的成员；未运行的已安装/可安装候选可展开查看。选择项目后，点目标旁的“一键接入”。只准备这个成员；首次账号配置、桌面启用或导入需要本人完成时，页面显示明确下一步。未安装的受支持后台入口可“安装并接入”，不修改系统 PATH 或全局 npm。

Codex、Claude Code、Qwen Code、Gemini CLI 有专用后台协作入口，使用各自正式账号或 API。首次安装和实际模型握手分别确认。Qwen、豆包桌面原生对话在已核对版本可由 AO 自动派发并回写实际回答，沿用同一人物与对话；首次本机连接方式与验收范围见 NATIVE_DESKTOP.md。Claude 桌面、其他尚未接通原生执行器的客户端保留本人处理的 MCP 信箱。豆包基础自动聊天无需先配置 MCP；原生 MCP 工具在高级个人连接器路径单独配置和验收，其他新成员使用正式 MCP JSON。保存配置不等于启用或后台唤醒。

离线或心跳过期的成员保留空工位，机器人离场，消息与名称仍可查看。右侧连接页可只读诊断本机服务、当前房间、成员长期入口和通知配置。Grok 的 Windows 宿主连接、目标群引用和原生加群工具仍需在 Grok 内核对，本机服务在线不代表它们已接通。

Grok 可先连接一个 Bot，直接在当前对话桥接外部成员；群聊不是接入前提。需要多人协作时再让 Bot 使用可用原生工具创建或加入群聊，桥接用户选定的成员。保存或更新 GROK_SKILL.md 为 /AgentRoom 后，可直接说“扫描本机 agents”或“把 Codex 加入这个群”。扫描只在要求时执行，没有定期扫描或自动拉人；旧 Grok 同步例程仍须真正暂停并回报。

详见 USER_GUIDE.md；Grok 流程在 GROK_SKILL.md，通用流程在 SKILL.md，旧命令在 references/legacy-communication.md。新增接入见 GEMINI_CLI_RESEARCH.md、DOUBAO_CONNECTOR_GUIDE.md、ADDITIONAL_AGENTS_RESEARCH.md；连接问题见 GROK_CONNECTION_TROUBLESHOOTING.md。

默认数据仍位于当前用户主目录的 .agentroom 文件夹；已有房间、MCP 命令与会话身份保留。成员凭据、图片和 MCP 导入配置留在本机，不公开共享。AgentOffice.exe help 查看命令，AgentOffice.exe stop 停止后台。原 AgentRoom.exe 和 agentroom MCP 命名作为兼容入口保留。外观配置详见 OFFICE_APPEARANCE.md。

这是未签名的本地预览版，尚未公开发布。
`);
  const licenseCandidates=[path.join(path.dirname(process.execPath),'LICENSE'),path.join(path.dirname(process.execPath),'LICENSE.txt')];const license=licenseCandidates.find(p=>fs.existsSync(p));if(!license)throw new Error('Node.js license file is required for the runtime package.');fs.copyFileSync(license,path.join(release,'NODE_LICENSE.txt'));
  const zip=path.join(outputRoot,'release',`AgentOffice-${expectedVersion}-windows-x64.zip`);
  // ZIP uses a fresh stage and this explicit public-file manifest. Runtime DBs,
  // entry cards, provider configuration, .local and validation outputs never
  // enter it, even if an older release directory contains additional files.
  const names=['AgentOffice.exe','README.md','USER_GUIDE.md','OPERATION_POLICY.md','GROK_GROUP_BRIDGE.md','BRIDGE_SETUP.md','DURABLE_ROOM.md','ZERO_TOUCH_RESEARCH.md','QWEN_DESKTOP_RESEARCH.md','DOUBAO_DESKTOP_RESEARCH.md','NATIVE_DESKTOP.md','GEMINI_CLI_RESEARCH.md','DOUBAO_CONNECTOR_GUIDE.md','ADDITIONAL_AGENTS_RESEARCH.md','GROK_CONNECTION_TROUBLESHOOTING.md','OFFICE_APPEARANCE.md','OFFICE_RESEARCH.md','OFFICE_MASCOT_SOURCES.md','SECRETARY_GUIDE.md','TEAM_COLLABORATION.md','SKILL.md','GROK_SKILL.md','LICENSE','NODE_LICENSE.txt'],stage=fs.mkdtempSync(path.join(dist,'zip-stage-'));
  names.push('AGENT_INSTALLATION.md');
  const publicFiles=[...names,...referenceFiles.map(name=>'references/'+name.replaceAll('\\','/')),...desktop.files.map(file=>'desktop/'+file.path.replaceAll('\\','/')),'desktop/desktop-manifest.json'];
  if(sourceState(root).fingerprint!==source.fingerprint)throw new Error('Source changed during the build; the package was not accepted.');
  atomicJson(path.join(release,'release-manifest.json'),{schema:'agentoffice.release',version:expectedVersion,source,files:publicFiles.map(name=>({path:name,sha256:sha(path.join(release,...name.split('/'))),bytes:fs.statSync(path.join(release,...name.split('/'))).size}))});names.push('release-manifest.json');
  try{
    if(localOnly)return {executable:path.join(release,'AgentOffice.exe'),release,version,bytes:fs.statSync(executable).size};
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
  return {executable,release,zip,version,bytes:fs.statSync(executable).size};
}
async function main(args=process.argv.slice(2)){
  const options=parseArgs(args),result=await(options.dev?buildDevelopment(options):buildPackage(options));
  console.log(JSON.stringify(result,null,2));return result;
}
module.exports={parseArgs,buildPackage,buildDevelopment,publishDevelopment};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
