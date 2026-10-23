'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {RoomError,shellCommand,livePid}=require('./util.cjs');
const {qwenVendorScript,geminiVendorScript}=require('./discovery.cjs');
const {configurationInfo}=require('./claude.cjs');
const {processIdentity}=require('./daemon-owner.cjs');
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const psLiteral=value=>"'"+String(value).replace(/'/g,"''")+"'";
function loginError(code='client_login_open_failed'){return new RoomError(code==='client_login_open_timeout'?'首次配置入口未在限定时间内确认打开。请检查是否已有配置窗口，再重试。':'首次配置入口没有确认打开，请检查配置窗口后重试；后台登录状态仍需核对。',503,code);}
async function bounded(work,timeout,code){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(loginError(code)),timeout);})]);}finally{clearTimeout(timer);}}
function readReceipt(file){
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw loginError();return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw loginError();}
}
function removeReceipt(file){try{fs.unlinkSync(file);}catch{}try{fs.rmdirSync(path.dirname(file));}catch{}}
function receiptMatches(receipt,nonce){return receipt?.nonce===nonce&&Number.isSafeInteger(receipt.pid)&&receipt.pid>0&&typeof receipt.process_identity==='string'&&!!receipt.process_identity&&(receipt.phase==='ready'&&receipt.exit_code===null||receipt.phase==='completed'&&receipt.exit_code===0||receipt.phase==='failed'&&Number.isInteger(receipt.exit_code)&&receipt.exit_code!==0);}
async function launchInteractive(request,options={}){
  // Node's detached Windows spawn uses DETACHED_PROCESS, not CREATE_NEW_CONSOLE.
  // A short hidden launcher asks Windows to create a separate visible console.
  const script="$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$p=Start-Process -FilePath $r.command -ArgumentList $r.args -WorkingDirectory $r.cwd -WindowStyle Normal -PassThru;[Console]::Write(($p.Id.ToString()))";
  let launchedPid;await new Promise((resolve,reject)=>{
    let child,done=false,output='';const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{child?.kill();finish(loginError('client_login_open_timeout'));},8000);
    try{child=(options.spawn||spawn)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:request.options.env,cwd:request.options.cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});}catch{finish(loginError());return;}
    child.stdout.on('data',part=>{output+=part;if(output.length>128){child.kill();finish(loginError());}});
    child.once('error',()=>finish(loginError()));child.stdin.on('error',()=>finish(loginError()));
    child.once('close',code=>{launchedPid=Number(output.trim());finish(code===0&&/^\d+$/.test(output.trim())&&Number.isSafeInteger(launchedPid)&&launchedPid>0?null:loginError());});
    child.stdin.end(JSON.stringify({command:request.command,args:request.args,cwd:request.options.cwd}));
  });
  const deadline=Date.now()+2500;
  do{const receipt=readReceipt(request.receipt_file);if(receiptMatches(receipt,request.nonce)&&receipt.pid===launchedPid)return receipt;await pause(50);}while(Date.now()<deadline);
  throw loginError('client_login_open_timeout');
}
class OnboardingActions{
  constructor(service,options={}){this.service=service;this.options=options;this.terminals=new Map();this.opening=new Map();}
  async cli(job){
    if(!['codex','claude-code','qwen-code','gemini-cli'].includes(job.provider))throw new RoomError('这个桌面客户端没有正式的后台登录入口。',409,'client_login_unavailable');
    const runtime=this.service.store.setting(`runtime.${job.provider}`),member=job.member_id?this.service.chat.store.member(job.member_id):null;
    let executable=member?.config.executable||runtime?.executable,args=member?.config.executable_args||runtime?.executable_args||[];
    if(!executable){const candidate=(await this.service.chat.discover()).candidates.find(c=>c.provider===job.provider);executable=candidate?.executable;args=candidate?.executable_args||[];}
    const native=args.length===0&&(job.provider==='claude-code'?/[/\\]claude\.exe$/i.test(executable||''):job.provider==='codex'?/[/\\]codex\.exe$/i.test(executable||''):job.provider==='qwen-code'&&/[/\\]qwen\.exe$/i.test(executable||''));
    const node=/[/\\]node\.exe$/i.test(executable||'')&&args.length===1&&(job.provider==='qwen-code'?qwenVendorScript(args[0]):job.provider==='gemini-cli'?geminiVendorScript(args[0]):job.provider==='claude-code'&&/[/\\]@anthropic-ai[/\\]claude-code[/\\](?:cli|bin[/\\]claude)\.(?:js|mjs|cjs)$/i.test(args[0]));
    if(!path.isAbsolute(executable||'')||!fs.existsSync(executable)||!Array.isArray(args)||args.some(a=>typeof a!=='string'||!path.isAbsolute(a)||!fs.existsSync(a))||!native&&!node)throw new RoomError('先安装该成员的正式命令入口，再打开首次配置。',409,'client_runtime_missing');
    return {executable,args};
  }
  async perform(input={}){
    const job=this.service.onboarding.state({run_id:input.run_id});
    if(typeof input.operation!=='string'||!job.next_actions.some(a=>a.operation===input.operation))throw new RoomError('这个动作不属于当前成员的接入阶段，请检查进度。',409,'onboarding_action_unavailable');
    if(input.operation==='retry'||input.operation==='install_runtime')return {job:this.service.onboarding.retry({run_id:job.id,install_runtime:input.operation==='install_runtime'?true:undefined}),action:{kind:'retry'}};
    if(input.operation==='open_native_client'){const reply=await require('./desktop-client-launcher.cjs').prepareNativeClient(this.service,job,this.options.nativeLauncher||{});return {job:this.service.onboarding.retry({run_id:job.id}),action:{kind:'open_native_client',...reply,instruction:'客户端连接已开启，正在恢复原人物并验证。'}};}
    if(input.operation==='native_group_handoff'){this.service.launch.handoff(job.launch_session_id);const state=this.service.launch.state({session_id:job.launch_session_id});return {job,action:{kind:'native_group_handoff',instruction:state.grok_prompt}};}
    if(input.operation==='reload_client')return {job,action:{kind:'reload_client',instruction:'请在客户端重新加载 AgentRoom 工具，完成后点击检查进度。当前版本没有正式的外部重载接口；现有聊天继续保留。'}};
    if(input.operation!=='login_client')throw new RoomError('请使用这个动作对应的本机配置或本人握手按钮。',409,'onboarding_action_unavailable');
    if(job.provider==='claude-code'){
      const config=configurationInfo(this.options.env||process.env);
      if(config.api_mode){
        if(!fs.existsSync(config.file))throw new RoomError('Claude API 配置文件尚未建立，请在用户目录创建 settings.json 后重试。',409,'claude_config_missing');
        const request={command:'notepad.exe',args:[config.file],options:{cwd:path.dirname(config.file),windowsHide:false,detached:true,shell:false,stdio:'ignore'}};
        if(this.options.launcher)await this.options.launcher(request);else await new Promise((resolve,reject)=>{const child=spawn(request.command,request.args,request.options);child.once('error',()=>reject(new RoomError('无法打开 API 配置编辑器，请从本机配置文件入口打开 settings.json。',503,'claude_config_open_failed')));child.once('spawn',()=>{child.unref();resolve();});});
        return {job,action:{kind:'open_api_config',launched:true,file:config.file,instruction:'已打开本机 Claude API 配置。密钥只需保存一次；保存后点击「保存后继续接入」。程序不会覆盖已保存的配置。'}};
      }
    }
    if(this.opening.has(job.id))return this.opening.get(job.id);
    const opening=this.openLogin(job);this.opening.set(job.id,opening);try{return await opening;}finally{this.opening.delete(job.id);}
  }
  async openLogin(job){
    // Reject unsupported authentication ownership before reusing a terminal,
    // probing its identity, creating receipts, or launching another login.
    let environment=process.env;
    if(job.provider==='codex'){const client=memberClient(this.service,job);environment=await bounded(client.authenticationEnvironment({purpose:'login'}),10000,'client_login_open_timeout');}
    const identity=this.options.processIdentity||processIdentity,prior=this.terminals.get(job.id);
    if(prior){
      const current=await bounded(identity(prior.pid),3000,'client_login_open_timeout'),receipt=prior.receipt_file?readReceipt(prior.receipt_file):null;
      if(receiptMatches(receipt,prior.nonce)&&receipt.pid===prior.pid&&receipt.process_identity===prior.process_identity&&['completed','failed'].includes(receipt.phase)){
        if(receipt.phase==='completed'&&(current?.identity===prior.process_identity||!current&&!livePid(prior.pid)))this.authenticationCompleted(job);removeReceipt(prior.receipt_file);
      }else{if(current?.identity===prior.process_identity)return {job,action:{kind:'login_client',launched:true,reused:true,instruction:'此成员的首次配置窗口仍在运行。完成 AO 后台的独立登录后，点击登录后继续接入。'}};if(!current&&livePid(prior.pid))throw loginError('client_login_open_timeout');}
      this.terminals.delete(job.id);
    }
    const cli=await this.cli(job),project=this.service.store.project(this.service.chat.store.room(job.room_id).project_id);
    // This interactive terminal opens only after the user clicks its action.
    // The program and argv come from a known adapter, not browser command text.
    const command=shellCommand(cli.executable,[...cli.args,...(job.provider==='claude-code'?['auth','login']:job.provider==='codex'?['login']:[])],'win32');
    const nonce=crypto.randomUUID(),receipt_file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-login-')),'receipt.json');
    const script=`$ErrorActionPreference='Stop';$receiptFile=${psLiteral(receipt_file)};$nonce=${psLiteral(nonce)};function Write-LoginReceipt($phase,$code){$p=Get-Process -Id $PID;$r=@{nonce=$nonce;pid=$PID;process_identity=$p.StartTime.ToUniversalTime().Ticks.ToString();phase=$phase;exit_code=$code};$tmp=$receiptFile+'.tmp';[IO.File]::WriteAllText($tmp,($r|ConvertTo-Json -Compress));if([IO.File]::Exists($receiptFile)){[IO.File]::Replace($tmp,$receiptFile,$null)}else{[IO.File]::Move($tmp,$receiptFile)}};try{if([Console]::IsInputRedirected -or [Console]::IsOutputRedirected){throw 'Interactive console unavailable'};$Host.UI.RawUI.WindowTitle='AgentRoom - ${job.provider} 首次配置';Write-Host '完成 AO 后台的独立登录或配置后，返回 AgentRoom 点击继续接入。';Write-LoginReceipt 'ready' $null;${command};$code=$LASTEXITCODE;if($null -eq $code){$code=0};if($code -eq 0){Write-LoginReceipt 'completed' 0}else{Write-LoginReceipt 'failed' $code}}catch{try{Write-LoginReceipt 'failed' -1}catch{};Write-Host '首次配置没有完成，请返回 AgentRoom 重试。'}`;
    try{
      const request={command:'powershell.exe',args:['-NoProfile','-NoExit','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],nonce,receipt_file,options:{env:environment,cwd:fs.existsSync(project.path)?project.path:path.dirname(cli.executable),windowsHide:false,detached:false,shell:false,stdio:'inherit'}};
      const launched=await bounded(this.options.launcher?this.options.launcher(request):launchInteractive(request,this.options),12000,'client_login_open_timeout');
      if(!receiptMatches(launched,nonce)||launched.phase==='failed')throw loginError();
      const current=await bounded(identity(launched.pid),3000,'client_login_open_timeout');if(current?.identity!==launched.process_identity)throw loginError();
      if(launched.phase==='completed'){this.authenticationCompleted(job);removeReceipt(receipt_file);}else{this.terminals.set(job.id,{...launched,receipt_file});this.watchLogin(job,launched,receipt_file);}
      return {job,action:{kind:'login_client',launched:true,instruction:'已确认首次配置窗口打开。请完成 AO 后台的独立登录；完成后点击登录后继续接入。'}};
    }catch(error){removeReceipt(receipt_file);this.loginNotice(job,'首次配置窗口没有确认打开，请检查已有窗口后重试。');if(error.code?.startsWith('client_'))throw error;throw loginError();}
  }
  loginNotice(job,message){
    try{
      const current=this.service.onboarding.state({run_id:job.id});
      if(current.id!==job.id||current.room_id!==job.room_id||current.provider!==job.provider||current.stage!=='awaiting_auth'||current.status!=='needs_action'||current.ready_for_office===true)return;
      const latest=this.service.onboarding.state({room_id:job.room_id,provider:job.provider});if(latest?.id!==job.id)return;
      this.service.onboarding.set(job.id,{error:message});
    }catch{} // Deleted rooms, cancelled runs and completed successors stay untouched.
  }
  authenticationCompleted(job){
    if(job.provider!=='codex')return;
    const selected=memberClient(this.service,job),home=selected.workspace?.home;
    for(const client of new Set([selected,this.service.codex,...(this.service.chat.clients?.values()||[])]))if(client===selected||home&&client?.workspace?.home===home)client?.invalidateAuthentication?.();
  }
  watchLogin(job,launched,file){
    const deadline=Date.now()+15*60*1000,check=async()=>{
      try{
        if(this.service.closing||this.terminals.get(job.id)?.nonce!==launched.nonce){removeReceipt(file);return;}
        if(Date.now()>deadline){this.terminals.delete(job.id);this.loginNotice(job,'首次配置等待已结束，尚未确认 AO 后台登录。请重新打开首次配置后继续。');removeReceipt(file);return;}
        const receipt=readReceipt(file);
        if(receiptMatches(receipt,launched.nonce)&&receipt.pid===launched.pid&&receipt.process_identity===launched.process_identity&&['completed','failed'].includes(receipt.phase)){
          const current=await bounded((this.options.processIdentity||processIdentity)(launched.pid),3000,'client_login_open_timeout');
          if(receipt.phase==='completed'&&(current?.identity===launched.process_identity||!current&&!livePid(launched.pid)))this.authenticationCompleted(job);
          else this.loginNotice(job,receipt.phase==='failed'?'首次配置命令未完成，请重新打开配置窗口，完成 AO 后台登录后再继续。':'首次配置结果的窗口身份未能核对，请检查后重试。');
          if(this.terminals.get(job.id)?.nonce===launched.nonce)this.terminals.delete(job.id);removeReceipt(file);return;
        }
        if(!livePid(launched.pid)){if(this.terminals.get(job.id)?.nonce===launched.nonce)this.terminals.delete(job.id);this.loginNotice(job,'首次配置窗口已关闭，尚未确认完成 AO 后台登录。请重新打开首次配置后继续。');removeReceipt(file);return;}
      }catch{if(this.terminals.get(job.id)?.nonce===launched.nonce)this.terminals.delete(job.id);this.loginNotice(job,'首次配置结果未能安全核对，请检查配置窗口后重试；没有自动继续接入。');removeReceipt(file);return;}
      const timer=setTimeout(check,500);timer.unref();
    };const timer=setTimeout(check,250);timer.unref();
  }
}
function memberClient(service,job){return job.member_id?service.chat.nativeClient(service.chat.store.member(job.member_id)):service.codex;}
module.exports={OnboardingActions,launchInteractive};
