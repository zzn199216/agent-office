'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {RoomError,shellCommand,livePid}=require('./util.cjs');
const {qwenVendorScript,geminiVendorScript}=require('./discovery.cjs');
class OnboardingActions{
  constructor(service,options={}){this.service=service;this.options=options;this.terminals=new Map();}
  cli(job){
    if(!['codex','claude-code','qwen-code','gemini-cli'].includes(job.provider))throw new RoomError('这个桌面客户端没有正式的后台登录入口。',409,'client_login_unavailable');
    const runtime=this.service.store.setting(`runtime.${job.provider}`),member=job.member_id?this.service.chat.store.member(job.member_id):null;
    let executable=member?.config.executable||runtime?.executable,args=member?.config.executable_args||runtime?.executable_args||[];
    if(!executable){const candidate=this.service.chat.discover().candidates.find(c=>c.provider===job.provider);executable=candidate?.executable;args=candidate?.executable_args||[];}
    const native=args.length===0&&(job.provider==='claude-code'?/[/\\]claude\.exe$/i.test(executable||''):job.provider==='codex'?/[/\\]codex\.exe$/i.test(executable||''):job.provider==='qwen-code'&&/[/\\]qwen\.exe$/i.test(executable||''));
    const node=/[/\\]node\.exe$/i.test(executable||'')&&args.length===1&&(job.provider==='qwen-code'?qwenVendorScript(args[0]):job.provider==='gemini-cli'?geminiVendorScript(args[0]):job.provider==='claude-code'&&/[/\\]@anthropic-ai[/\\]claude-code[/\\](?:cli|bin[/\\]claude)\.(?:js|mjs|cjs)$/i.test(args[0]));
    if(!path.isAbsolute(executable||'')||!fs.existsSync(executable)||!Array.isArray(args)||args.some(a=>typeof a!=='string'||!path.isAbsolute(a)||!fs.existsSync(a))||!native&&!node)throw new RoomError('先安装该成员的正式命令入口，再打开首次配置。',409,'client_runtime_missing');
    return {executable,args};
  }
  async perform(input={}){
    const job=this.service.onboarding.state({run_id:input.run_id});
    if(typeof input.operation!=='string'||!job.next_actions.some(a=>a.operation===input.operation))throw new RoomError('这个动作不属于当前成员的接入阶段，请检查进度。',409,'onboarding_action_unavailable');
    if(input.operation==='retry'||input.operation==='install_runtime')return {job:this.service.onboarding.retry({run_id:job.id,install_runtime:input.operation==='install_runtime'?true:undefined}),action:{kind:'retry'}};
    if(input.operation==='native_group_handoff'){this.service.launch.handoff(job.launch_session_id);const state=this.service.launch.state({session_id:job.launch_session_id});return {job,action:{kind:'native_group_handoff',instruction:state.grok_prompt}};}
    if(input.operation==='reload_client')return {job,action:{kind:'reload_client',instruction:'请在客户端重新加载 AgentRoom 工具，完成后点击检查进度。当前版本没有正式的外部重载接口；现有聊天继续保留。'}};
    if(input.operation!=='login_client')throw new RoomError('请使用这个动作对应的本机配置或本人握手按钮。',409,'onboarding_action_unavailable');
    const prior=this.terminals.get(job.id);if(prior&&livePid(prior.pid))return {job,action:{kind:'login_client',launched:true,reused:true,instruction:'首次配置窗口已打开。完成自己的账号设置后，点击登录后继续接入。'}};
    const cli=this.cli(job),project=this.service.store.project(this.service.chat.store.room(job.room_id).project_id);
    // This interactive terminal opens only after the user clicks its action.
    // The program and argv come from a known adapter, not browser command text.
    const command=shellCommand(cli.executable,[...cli.args,...(job.provider==='claude-code'?['auth','login']:job.provider==='codex'?['login']:[])]);
    const script=`$Host.UI.RawUI.WindowTitle='AgentRoom - ${job.provider} 首次配置'; Write-Host '完成自己的模型服务登录或配置后，返回 AgentRoom 点击继续接入。'; ${command}`;
    let environment=process.env;
    if(job.provider==='codex'){const client=memberClient(this.service,job);await client.ready();environment=client.workspace.environment();}
    const request={command:'powershell.exe',args:['-NoProfile','-NoExit','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],options:{env:environment,cwd:fs.existsSync(project.path)?project.path:path.dirname(cli.executable),windowsHide:false,detached:true,shell:false,stdio:'ignore'}};
    const launched=this.options.launcher?await this.options.launcher(request):await new Promise((resolve,reject)=>{const child=spawn(request.command,request.args,request.options);child.once('error',reject);child.once('spawn',()=>{child.unref();resolve({pid:child.pid});});});
    if(launched?.pid)this.terminals.set(job.id,{pid:launched.pid});return {job,action:{kind:'login_client',launched:true,instruction:'首次配置窗口已打开。请在该工具自己的入口完成登录或模型配置；完成后点击继续接入。'}};
  }
}
function memberClient(service,job){return job.member_id?service.chat.nativeClient(service.chat.store.member(job.member_id)):service.codex;}
module.exports={OnboardingActions};
