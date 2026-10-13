'use strict';
// This opens only the new AgentRoom window against a fresh temporary instance.
// CapturePreviewAsync captures our own WebView; no Computer Use or other windows.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const{buildDesktop,REQUIRED_FILES,ASSETS}=require('./build-desktop.cjs');
const ROOT=path.resolve(__dirname,'..');
function child(command,args,{cwd,timeout=60000,windowsHide=true,gui=false}={}){return new Promise((resolve,reject)=>{
  const process=spawn(command,args,{cwd,windowsHide,shell:false,stdio:gui?'ignore':['ignore','pipe','pipe']});let out='',err='';
  process.stdout?.on('data',chunk=>out+=chunk);process.stderr?.on('data',chunk=>err+=chunk);
  const timer=setTimeout(()=>{process.kill();reject(new Error('Desktop validation child timed out.'));},timeout);
  process.on('error',error=>{clearTimeout(timer);reject(error);});process.on(gui?'exit':'close',code=>{clearTimeout(timer);if(code!==0)reject(new Error((err||out||'Desktop validation failed.').slice(0,1200)));else resolve(out.trim());});
});}
async function main(){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Desktop validation requires Windows x64.');
  const args=process.argv.slice(2),runtimeIndex=args.indexOf('--runtime'),runtime=path.resolve(runtimeIndex<0?path.join(ROOT,'dist','AgentRoom.exe'):args[runtimeIndex+1]);
  if(!fs.existsSync(runtime))throw new Error('Build the current AgentRoom.exe before desktop validation.');
  const validation=path.join(ROOT,'output','validation','desktop-native-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(validation,{recursive:true});
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-desktop-test-')),bin=path.join(fixture,'bin'),data=path.join(fixture,'.agentroom');fs.mkdirSync(bin);
  const manifest=args.includes('--use-built-desktop')?{...require('../src/desktop-launch.cjs').desktopManifest(path.join(path.dirname(runtime),'desktop')),directory:path.join(path.dirname(runtime),'desktop'),requiredFiles:REQUIRED_FILES.slice(),assets:ASSETS.slice()}:await buildDesktop();
  for(const name of [...manifest.requiredFiles,...manifest.assets]){const target=path.join(bin,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(manifest.directory,name),target);}
  fs.copyFileSync(runtime,path.join(bin,'AgentRoom.exe'));
  const cli=path.join(bin,'AgentRoom.exe');
  let initial;
  try{
    // Persist two public fixture rooms through the real store, without starting
    // workers or requesting any model output. The actual window must display
    // these same histories before and after its service toggle.
    const{RoomService}=require('../src/service.cjs'),{FakeCodex,FakeVault}=require('../tests/helpers.cjs');
    const projectDir=path.join(fixture,'project');fs.mkdirSync(projectDir);
    const seed=new RoomService(data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw new Error('Native desktop fixture must not call upstream services.');}});
    const project=seed.addProject({name:'桌面窗口验证',path:projectDir}),first=seed.chat.addRoom({project_id:project.id,title:'本机关联群聊'}),second=seed.chat.addRoom({project_id:project.id,title:'另一间已保存的群聊'});
    const member=seed.chat.addMember({name:'测试信箱成员',adapter:'mailbox'});
    const imageResult=await child('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.Drawing; $bitmap=New-Object Drawing.Bitmap 32,32; $graphics=[Drawing.Graphics]::FromImage($bitmap); $graphics.Clear([Drawing.Color]::CornflowerBlue); $stream=New-Object IO.MemoryStream; $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png); [Console]::Write([Convert]::ToBase64String($stream.ToArray())); $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()"]);
    const customRaster='data:image/png;base64,'+imageResult;seed.appearance.set({member_id:member.id,preset:'robot',color:'#4289c5',furniture:'beanbag',avatar_data:customRaster,character_data:customRaster});
    for(const room of [first,second])seed.office.set({room_id:room.id,time_zone:'Asia/Taipei',time_mode:'night'});
    for(const name of ['Codex','Claude Code','Qwen','Grok','Cursor','豆包']){const agent=seed.chat.addMember({name:name+' 头像验证',adapter:'mailbox'});for(const room of[first,second])seed.chat.join(room.id,agent.id);}
    for(const room of[first,second]){seed.chat.join(room.id,member.id);seed.chat.store.post({room_id:room.id,sender_id:'user',text:'桌面验证：这条群聊保存在本机。',idempotency_key:'native-desktop-persisted-'+room.id});}
    seed.secretary.set({room_id:first.id,member_id:member.id});
    await seed.close();
    initial=JSON.parse(await child(cli,['desktop-state','--data-dir',data]));
    if(initial.running)throw new Error('Fresh validation instance must be offline.');
    if(initial.snapshot?.chat?.rooms?.length!==2||initial.history?.messages?.[0]?.text!=='桌面验证：这条群聊保存在本机。')throw new Error('Fixture offline history is missing.');
    const desktop=path.join(bin,'AgentRoom.Desktop.exe');
    await child(desktop,['--data-dir',data,'--diagnostics',validation,'--smoke'],{cwd:bin,timeout:120000,windowsHide:false,gui:true});
    const result=JSON.parse(fs.readFileSync(path.join(validation,'result.json'),'utf8'));
    if(!result.ok)throw new Error('Native window validation: '+result.error);
    const window=result.window,area=window?.working_area,bounds=window?.bounds;
    if(!bounds||!area||bounds.width<=0||bounds.height<=0||bounds.width>area.width||bounds.height>area.height||bounds.x<area.x||bounds.y<area.y||bounds.x+bounds.width>area.x+area.width||bounds.y+bounds.height>area.y+area.height)throw new Error('Default native window must fit its actual monitor working area.');
    const smoke=JSON.parse(fs.readFileSync(path.join(validation,'smoke.json'),'utf8'));
    if(smoke.steps?.length!==2||smoke.steps[0].running!==true||smoke.steps[1].running!==false||smoke.rejected_navigation<1||smoke.rejected_messages<1||smoke.bridge_commands<2)throw new Error('Native bridge smoke assertions did not pass.');
    const after=JSON.parse(await child(cli,['desktop-state','--data-dir',data]));
    if(after.running)throw new Error('Native stop operation left its service running.');
    if(after.snapshot.instance_id!==initial.snapshot.instance_id||after.snapshot.chat.rooms.length!==2||after.history.messages[0].text!==initial.history.messages[0].text)throw new Error('Native service toggles changed the saved instance or room history.');
    // Opening and closing a second real window while service is online must keep it online.
    const started=JSON.parse(await child(cli,['desktop-start','--data-dir',data]));if(!started.running)throw new Error('Window-close test start failed.');
    const savedWindow={version:1,x:area.x+24,y:area.y+24,width:Math.min(area.width-48,Math.max(window.minimum_width,1000)),height:Math.min(area.height-48,Math.max(window.minimum_height,680)),state:'normal'};
    fs.writeFileSync(path.join(data,'desktop-window.json'),JSON.stringify(savedWindow));
    const closeEvidence=path.join(validation,'close-preserves-service');fs.mkdirSync(closeEvidence);
    await child(desktop,['--data-dir',data,'--diagnostics',closeEvidence,'--check'],{cwd:bin,windowsHide:false,gui:true});
    const closeResult=JSON.parse(fs.readFileSync(path.join(closeEvidence,'result.json'),'utf8'));
    const retained=JSON.parse(await child(cli,['desktop-state','--data-dir',data]));
    if(!closeResult.ok||!retained.running)throw new Error('Closing desktop window stopped the service.');
    if(closeResult.window?.restored!==true||closeResult.window.bounds.width!==savedWindow.width||closeResult.window.bounds.height!==savedWindow.height)throw new Error('Native window did not restore the saved user dimensions.');
    if(initial.snapshot.secretaries[first.id]?.member_id!==member.id||after.snapshot.secretaries[first.id]?.member_id!==member.id||after.snapshot.secretaries[first.id]?.can_wake!==false)throw new Error('Saved secretary role was not preserved in offline native state.');
    const officeOnline=JSON.parse(fs.readFileSync(path.join(validation,'office-online.json'),'utf8')),officeOffline=JSON.parse(fs.readFileSync(path.join(validation,'office-offline.json'),'utf8'));
    if(officeOnline.unloaded||officeOffline.unloaded||officeOnline.customLoaded!==2||officeOffline.customLoaded!==0||officeOnline.seats!==7||officeOffline.seats!==7||officeOffline.occupied!==0||officeOffline.vacant!==7)throw new Error('Native office must load online images and preserve seven empty workstations while offline.');
    for(const view of [officeOnline,officeOffline])if(view.phase!=='night'||view.timeZone!=='Asia/Taipei'||view.beanbags!==1||!/^\d{2}:\d{2}$/.test(view.clock||''))throw new Error('Saved room lighting, time zone, clock or beanbag was not retained in the native window.');
    const proof={ok:true,fixture,validation,version:manifest.version,sdk_version:manifest.sdk_version,native_webview:true,bridge_start_stop:true,invalid_navigation_rejected:true,invalid_bridge_rejected:true,close_preserves_service:true,persisted_history:true,same_instance:true,office_online:true,office_offline:true,offline_empty_workstations:true,custom_raster_images_loaded:true,natural_window_on_monitor:true,saved_window_restored:true,secretary_offline_preserved:true,window:result.window,restored_window:closeResult.window,png_files:['offline-before.png','online.png','office-online.png','offline-after.png','office-offline.png','close-preserves-service/window.png'],initial_rooms:initial.snapshot?.chat?.rooms?.length??0};
    fs.writeFileSync(path.join(validation,'validation.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
  }finally{
    // Only this explicit unique fixture instance may be stopped. Leave public
    // screenshot evidence and fixture data for diagnosis rather than broad delete.
    try{await child(cli,['desktop-stop','--data-dir',data],{timeout:30000});}catch(error){console.error('Fixture cleanup: '+error.message);}
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
