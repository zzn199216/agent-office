'use strict';
// One-shot native Grok acceptance test. The operator arms it and shuts down the
// idle daemon; only the real bot is instructed to enter/post/wait. The observer
// never calls ensureServer, acceptEntry, or any room-message mutation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {dataDirectory,atomicWrite,now,sleep,livePid,shellCommand,readableError,RoomError}=require('../src/util.cjs');
const {apiCall,readControl}=require('../src/main.cjs');
const root=path.resolve(__dirname,'..');
// An operator must choose the actual room and both members explicitly. No
// default identity may target a previous developer's local instance.
function testIdentities(){
 const fields={room:'AGENTROOM_TEST_ROOM',bridge:'AGENTROOM_TEST_BRIDGE',codex:'AGENTROOM_TEST_CODEX'},result={};
 for(const [key,name] of Object.entries(fields)){
  const value=process.env[name];
  if(!value)throw new RoomError(`请显式设置 ${name} 后再运行冷启动测试。`);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new RoomError(`${name} 必须是完整的 UUID。`);
  result[key]=value.toLowerCase();
 }
 if(result.bridge===result.codex)throw new RoomError('Grok 桥接成员与 Codex 目标成员必须不同。');
 return result;
}
function record(file,value){atomicWrite(file,JSON.stringify(value,null,2));}
function removeTriggers(db,test){for(const name of test.triggers){if(!/^grok_cold_[a-f0-9]+_(entry|service)$/.test(name))throw new Error('Invalid owned trigger');db.exec(`DROP TRIGGER IF EXISTS ${name}`);}}
async function prepare(){
 const {room:ROOM,bridge:BRIDGE,codex:CODEX}=testIdentities();
 const dir=dataDirectory(),control=readControl(dir);if(!control)throw new RoomError('请先让本机控制面可用以准备测试。');const s=await apiCall(dir,'/api/state');
 if(s.activeRequest||s.chat.activeMessages.length||s.approvals.length||s.chat.members.some(m=>m.status==='connecting'))throw new RoomError('有任务正在处理，没有关闭后台。',409);
 const bridge=s.chat.members.find(m=>m.id===BRIDGE),codex=s.chat.members.find(m=>m.id===CODEX);if(!bridge?.verified_at||!codex?.verified_at)throw new RoomError('现有桥接成员或 Codex 尚未完成接入。');
 const entryFile=path.join(dir,'entries',`${BRIDGE}-${ROOM}.json`);if(!fs.existsSync(entryFile))throw new RoomError('现有桥接 Bot 的长期入口文件不存在，没有替它生成新身份。');
 const card=JSON.parse(fs.readFileSync(entryFile,'utf8'));const nonce=crypto.randomBytes(8).toString('hex'),testId='grok-cold-'+nonce,marker='GROK-COLD-'+nonce.toUpperCase(),work=path.join(dir,'validation','grok-cold',testId),artifact=path.join(root,'output','validation','grok-cold',testId);
 const db=new DatabaseSync(path.join(dir,'room.sqlite'));db.exec('PRAGMA busy_timeout=5000;');let credential,seq;
 const triggers=[`grok_cold_${nonce}_entry`,`grok_cold_${nonce}_service`];
 try{
  credential=db.prepare('SELECT id,status,last_seen FROM chat_resume_credentials WHERE id=? AND instance_id=? AND member_id=? AND room_id=?').get(card.credential_id,s.instance_id,BRIDGE,ROOM);if(credential?.status!=='active')throw new RoomError('桥接 Bot 的现有长期入口未激活或已撤销。');
  seq=Number(db.prepare('SELECT COALESCE(max(seq),0) n FROM chat_messages WHERE room_id=?').get(ROOM).n);
  if(!/^[a-f0-9-]{36}$/.test(credential.id))throw new Error('Unexpected credential identity');
  db.exec(`CREATE TABLE IF NOT EXISTS validation_grok_cold_events(test_id TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,reference TEXT,detail TEXT);
   CREATE TRIGGER ${triggers[0]} AFTER UPDATE OF last_seen ON chat_resume_credentials WHEN NEW.id='${credential.id}' AND NEW.last_seen IS NOT OLD.last_seen
    BEGIN INSERT INTO validation_grok_cold_events VALUES('${testId}','entry_used',NEW.last_seen,NEW.id,NULL); END;
   CREATE TRIGGER ${triggers[1]} AFTER INSERT ON runtime_workers WHEN NEW.role='service'
    BEGIN INSERT INTO validation_grok_cold_events VALUES('${testId}','service_started',NEW.last_seen,NEW.worker_ref,CAST(NEW.pid AS TEXT)); END;`);
 }finally{db.close();}
 const exe=path.join(dir,'bin','AgentRoom.exe'),question=path.join(work,'question.md'),task=path.join(work,'TASK.md');
 atomicWrite(question,`这是用户授权的只读协作连通实测。请不要读取文件、执行命令或修改项目；直接回答“${marker}：Codex 已收到 Grok 桥接 Bot 的问题”。保留完整校验标识。`);
 const cli=args=>shellCommand(exe,args)+(process.platform==='win32'?' | Out-String -Width 4096':'');
 const command1=cli(['room-state','--entry',entryFile,'--offline']),command2=cli(['enter','--entry',entryFile]),command3=cli(['bridge-request','--entry',entryFile,'--to',CODEX,'--file',question,'--key',testId,'--wait','180']);
 const instruction=`这是用户授权的 AgentRoom 冷启动实测，请由你这个已经创建的「Grok 桥接 Bot」自己执行；不要让另一 Bot 或用户代跑本机入口。使用你已获授权的 Windows 本机命令工具，不操作桌面窗口，不使用云端 /workspace 冒充 Windows。\n\n1. 先实际执行离线检查：\n${command1}\n应看到 instance_id=${s.instance_id}，原房间=${ROOM}，service.online=false。若仍在线，请停止本次测试并报告，不能把热启动当作冷启动。\n\n2. 由你自己进入原聊天室并拉起后台：\n${command2}\n核对仍是同一实例和房间，不新建同名房间，不索取新邀请。\n\n3. 用自己的长期入口向「Codex 资料核实」提问：\n${command3}\n保存结果中的 id（bridge entry ID）。pending 时只用 bridge-wait 同一ID --entry '${entryFile.replace(/'/g,"''")}' --timeout 180 继续等待，不能重发或换key。中文文件已由测试准备程序以UTF-8保存。\n\n4. 得到 answered 后，将 native_return_text 原样贴回你现在自己的这个 Grok 对话窗口，包含来源和校验标识。没有真实原生会话/回复引用时，不编造 --origin 或 bridge-report 回执。不要替用户提交人工确认。\n\n本次唯一标识：${marker}。权限仅限已有入口、这条只读问题和等待其实际答案；不修改代码、发布、付费或读取其他凭据。`;
 atomicWrite(task,instruction);atomicWrite(path.join(root,'.local','GROK_COLD_TEST.md'),instruction);
 const test={id:testId,marker,directory:dir,artifact,work,task_file:task,entry_file:entryFile,instance_id:s.instance_id,room_id:ROOM,bridge_id:BRIDGE,target_id:CODEX,credential_id:credential.id,baseline_seq:seq,baseline_last_seen:credential.last_seen,old_pid:control.pid,old_url:control.url,prepared_at:now(),deadline_seconds:900,triggers,operator_entered_bridge:false,operator_posted_as_bridge:false,computer_use:false};
 const testFile=path.join(artifact,'test.json'),statusFile=path.join(artifact,'status.json');record(testFile,test);record(statusFile,{test_id:testId,status:'prepared',actual_grok:false});
 // Re-check idle state immediately before the actual shutdown.
 const before=await apiCall(dir,'/api/state');if(before.activeRequest||before.chat.activeMessages.length||before.approvals.length)throw new RoomError('测试准备期间出现活动任务，没有关闭后台。',409);
 await apiCall(dir,'/api/shutdown',{});for(let i=0;livePid(control.pid)&&i<100;i++)await sleep(100);if(livePid(control.pid)||readControl(dir))throw new RoomError('原后台尚未停止，未开始冷启动验收。');
 test.armed_at=now();record(testFile,test);record(statusFile,{test_id:testId,status:'waiting_for_grok',backend_stopped:true,old_pid:control.pid,armed_at:test.armed_at});
 const log=fs.openSync(path.join(artifact,'observer.log'),'a');const child=spawn(process.execPath,[__filename,'observe',testFile],{detached:true,windowsHide:true,stdio:['ignore',log,log]});child.unref();fs.closeSync(log);
 console.log(JSON.stringify({test_id:testId,status:'waiting_for_grok',backend_stopped:true,instruction_file:path.join(root,'.local','GROK_COLD_TEST.md'),bot_task_file:task,observer_pid:child.pid,status_file:statusFile}));
}
async function observe(testFile){
 const expected=testIdentities();
 const t=JSON.parse(fs.readFileSync(testFile,'utf8'));
 if(t.room_id!==expected.room||t.bridge_id!==expected.bridge||t.target_id!==expected.codex)throw new RoomError('观察记录与显式选择的房间或成员不一致。');
 const statusFile=path.join(t.artifact,'status.json'),deadline=Date.parse(t.armed_at)+t.deadline_seconds*1000;let last='';
 try{for(;;){
  let status;const db=new DatabaseSync(path.join(t.directory,'room.sqlite'),{readOnly:true});try{
   const events=db.prepare('SELECT kind,at,reference,detail FROM validation_grok_cold_events WHERE test_id=? ORDER BY rowid').all(t.id).filter(e=>e.at>=t.armed_at);
   const entryUse=events.find(e=>e.kind==='entry_used'),start=events.find(e=>e.kind==='service_started');
   const message=db.prepare("SELECT id,created,status,error FROM chat_messages WHERE room_id=? AND sender_id=? AND to_member_id=? AND seq>? AND instr(text,?)>0 AND kind='message' ORDER BY seq LIMIT 1").get(t.room_id,t.bridge_id,t.target_id,t.baseline_seq,t.marker);
   const answer=message?db.prepare("SELECT id,text,created,status FROM chat_messages WHERE room_id=? AND sender_id=? AND to_member_id=? AND reply_to=? AND kind='reply' ORDER BY seq LIMIT 1").get(t.room_id,t.target_id,t.bridge_id,message.id):null;
   const binding=db.prepare('SELECT thread_id,binding_state FROM chat_bindings WHERE room_id=? AND member_id=?').get(t.room_id,t.target_id);
   const identity=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='instance_fingerprint'").get().value),control=readControl(t.directory);
   const botStarted=!!(entryUse&&start&&entryUse.at<=start.at&&control&&control.pid!==t.old_pid&&Number(start.detail)===control.pid&&identity===t.instance_id);
   status={test_id:t.id,status:!entryUse?'waiting_for_grok':!start?'grok_entered_waiting_backend':!botStarted?'cold_start_inconclusive':!message?'backend_started_waiting_question':!answer?'question_waiting_codex':answer.status!=='consumed'?'codex_answered_waiting_grok':'passed',instance_id:identity,old_pid:t.old_pid,new_pid:control?.pid||null,entry_used_at:entryUse?.at||null,backend_started_at:start?.at||null,grok_started_backend:botStarted,question_id:message?.id||null,answer_id:answer?.id||null,answer_text:answer?.text||null,answer_consumed:answer?.status==='consumed',native_thread_id:binding?.thread_id||null,computer_use:false,operator_entered_bridge:false,operator_posted_as_bridge:false,native_grok_window_reply_verified:false,observed_at:now()};
   if(status.status==='passed'&&(!answer.text.includes(t.marker)||!binding?.thread_id))status.status='answer_mismatch';
   if(message&&['failed','uncertain','cancelled','waiting_input'].includes(message.status)){status.status='needs_action';status.error=message.error||message.status;}
  }finally{db.close();}
  const signature=JSON.stringify({...status,observed_at:undefined});if(signature!==last){record(statusFile,status);console.log(JSON.stringify({status:status.status,observed_at:status.observed_at}));last=signature;}
  if(['passed','answer_mismatch','cold_start_inconclusive','needs_action'].includes(status.status)){record(path.join(t.artifact,'result.json'),status);break;}
  if(Date.now()>=deadline){record(statusFile,{...status,status:'timed_out',reason:'未在等待期间收到完整的真实 Bot 冷启动问答证据。'});break;}await sleep(400);
 }}finally{const db=new DatabaseSync(path.join(t.directory,'room.sqlite'));db.exec('PRAGMA busy_timeout=5000;');try{removeTriggers(db,t);}finally{db.close();}}
}
const mode=process.argv[2];(mode==='prepare'?prepare():mode==='observe'?observe(process.argv[3]):Promise.reject(new Error('Usage: node scripts/grok-cold-test.cjs prepare | observe TEST.json'))).catch(e=>{console.error(readableError(e));process.exitCode=1;});
