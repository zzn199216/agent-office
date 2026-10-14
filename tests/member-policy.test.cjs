'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { RoomService } = require('../src/service.cjs');
const { createServer } = require('../src/http.cjs');
const { assertMemberRoute, memberTools, TEAM_TOOLS } = require('../src/member-policy.cjs');
const { toolCall, tools } = require('../src/mcp.cjs');
const { createQwenMcpConfig } = require('../src/mcp-http.cjs');
const { VERSION, id } = require('../src/util.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');

async function setup(t) {
  const files=fixture(),codex=new FakeCodex(),service=new RoomService(files.data,{codex,vault:new FakeVault(),fetch:async()=>{throw new Error('External traffic prohibited');}});
  const project=service.addProject({name:'Allowed project',path:files.project});
  const otherPath=path.join(files.root,'other-project');fs.mkdirSync(otherPath);
  const otherProject=service.addProject({name:'Private other project',path:otherPath});
  const room=service.chat.addRoom({title:'Allowed room',project_id:project.id}),otherRoom=service.chat.addRoom({title:'Private other room',project_id:otherProject.id});
  const member=service.chat.addMember({name:'Only in allowed room',adapter:'mailbox'}),outsider=service.chat.addMember({name:'Private outsider',adapter:'mailbox'});
  service.chat.join(room.id,member.id);service.chat.join(otherRoom.id,outsider.id);
  const discussion=service.store.addDiscussion(otherProject.id,'Private other discussion');
  service.store.submit({discussion_id:discussion.id,message:'Private other body',idempotency_key:'private-fixture'});
  const entry=service.entry.issue(member.id,room.id),card=JSON.parse(fs.readFileSync(entry.file,'utf8'));
  const token=id(),server=createServer(service,{port:0,token}),port=await server.listen(),url='http://127.0.0.1:'+port;
  fs.writeFileSync(path.join(files.data,'control.json'),JSON.stringify({pid:process.pid,url,token,version:VERSION,instance_id:service.runtime.instanceId}));
  const children=[];
  t.after(async()=>{for(const child of children)if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await server.close();await service.close();const root=path.resolve(files.root);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('agentroom-test-'));fs.rmSync(root,{recursive:true,force:true});});
  async function stdio(mode) {
    const env={...process.env};for(const key of ['AGENTROOM_MEMBER_ID','AGENTROOM_ROOM_ID','AGENTROOM_SETUP_MODE','AGENTROOM_INSTANCE_ID'])delete env[key];
    if(mode==='native'){env.AGENTROOM_MEMBER_ID=member.id;env.AGENTROOM_ROOM_ID=room.id;}
    const child=spawn(process.execPath,[path.resolve(__dirname,'../src/main.cjs'),'mcp',...(mode==='entry'?['--entry',entry.file]:['--data-dir',files.data])],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);
    let seq=0,stderr='';const pending=new Map();child.stderr.on('data',data=>stderr+=data);
    readline.createInterface({input:child.stdout}).on('line',line=>{const response=JSON.parse(line),handler=pending.get(response.id);if(handler){pending.delete(response.id);handler(response);}});
    function rpc(method,params){return new Promise((resolve,reject)=>{const requestId=++seq,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('MCP fixture timed out: '+stderr));},7000);pending.set(requestId,response=>{clearTimeout(timer);resolve(response);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');});}
    await rpc('initialize',{protocolVersion:'2025-06-18'});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    return {rpc,call:(name,args={})=>rpc('tools/call',{name,arguments:args})};
  }
  async function http() {
    const endpoint=createQwenMcpConfig(url,card).mcpServers.agentroom.url;let session,seq=0;
    async function rpc(method,params,notification=false){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',...notification?{}:{id:++seq},method,params})});session=response.headers.get('Mcp-Session-Id')||session;return response.status===202?null:response.json();}
    await rpc('initialize',{protocolVersion:'2025-06-18'});await rpc('notifications/initialized',{},true);
    return {rpc,call:(name,args={})=>rpc('tools/call',{name,arguments:args})};
  }
  return {files,service,codex,room,otherRoom,member,outsider,discussion,card,stdio,http};
}

test('real entry STDIO, native environment STDIO and HTTP share room-scoped discovery and deny legacy reads',async t=>{
  const h=await setup(t),clients=[await h.stdio('entry'),await h.stdio('native'),await h.http()];
  const listed=[];
  for(const client of clients){
    const names=(await client.rpc('tools/list')).result.tools.map(tool=>tool.name);listed.push(names.filter(name=>name!=='agentroom_join'));
    for(const forbidden of ['agentroom_list','agentroom_history','agentroom_ask','agentroom_group_prepare','agentroom_delegate'])assert.ok(!names.includes(forbidden),forbidden);
    const rooms=(await client.call('agentroom_chat_rooms')).result.structuredContent;
    assert.deepEqual(rooms.rooms.map(room=>room.id),[h.room.id]);assert.deepEqual(rooms.members.map(member=>member.id),[h.member.id]);
    for(const [name,args] of [['agentroom_list',{}],['agentroom_history',{discussion_id:h.discussion.id}],['agentroom_chat_history',{room_id:h.otherRoom.id}]]){
      const denied=await client.call(name,args);assert.equal(denied.result.isError,true);assert.ok(!JSON.stringify(denied).includes('Private other'));
    }
  }
  assert.deepEqual(listed[0],listed[1]);assert.deepEqual(listed[0],listed[2]);assert.equal(h.codex.calls.length,0);
});

test('native environment STDIO permits its own actual invitation but rejects swapped invitations and membership loss',async t=>{
  const h=await setup(t),client=await h.stdio('native');
  const own=h.service.chat.store.createInvite({room_id:h.room.id,member_id:h.member.id}),outside=h.service.chat.store.createInvite({room_id:h.otherRoom.id,member_id:h.outsider.id});
  assert.equal((await client.call('agentroom_join',{invite_id:outside.id,nonce:outside.nonce})).result.isError,true);
  const joined=await client.call('agentroom_join',{invite_id:own.id,nonce:own.nonce});assert.equal(joined.result.structuredContent.ok,true);
  h.service.chat.leave(h.room.id,h.member.id);
  assert.equal((await client.call('agentroom_chat_rooms')).result.isError,true);
});

test('member route policy denies aggregate legacy reads, missing scope and controller-only team routes',async t=>{
  const h=await setup(t),disk={store:h.service.store,chat:h.service.chat.store},scope=h.card;
  for(const route of ['/api/state','/api/chat/state','/api/inbox',`/api/discussions/${h.discussion.id}`,'/api/runtime','/api/team',`/api/team?room_id=${h.otherRoom.id}`])assert.throws(()=>assertMemberRoute(disk,scope,route),{code:'resume_scope_mismatch'},route);
  for(const route of ['/api/team/goals','/api/team/schedule'])assert.throws(()=>assertMemberRoute(disk,scope,route,{room_id:h.room.id,caller_member_id:h.member.id}),{code:'resume_scope_mismatch'});
  assert.throws(()=>assertMemberRoute(disk,scope,'/api/desktop/connect',{room_id:h.room.id,member_id:h.member.id,provider:'qwen-desktop'}),{code:'resume_scope_mismatch'});
  assert.doesNotThrow(()=>assertMemberRoute(disk,scope,`/api/team?room_id=${h.room.id}`));
  assert.throws(()=>assertMemberRoute(disk,scope,'/api/team/cards',{room_id:h.room.id,caller_member_id:h.member.id,member_id:h.outsider.id}),{code:'resume_scope_mismatch'});
  assert.throws(()=>assertMemberRoute(disk,scope,`/api/team/tasks/${id()}/update`,{room_id:h.room.id,caller_member_id:h.member.id,action:'reconcile'}),{code:'resume_scope_mismatch'});
});

test('team tools bind identity and enforce current secretary role without requiring native tool rediscovery',async t=>{
  const h=await setup(t),client=await h.stdio('entry');
  const env={AGENTROOM_MEMBER_ID:h.member.id,AGENTROOM_ROOM_ID:h.room.id},calls=[];
  const api=async(route,input)=>{calls.push({route,input});return {ok:true};};
  await toolCall('agentroom_member_card',{role:'Researcher',skills:['analysis'],information:'Public facts',sources:[{reference:'fixture:source',note:'self-reported'}]},api,{env});
  assert.equal(calls[0].input.caller_member_id,h.member.id);assert.equal(calls[0].input.member_id,h.member.id);assert.equal(calls[0].input.room_id,h.room.id);
  await assert.rejects(()=>toolCall('agentroom_brief_ack',{version:1,caller_member_id:h.outsider.id},api,{env}),/未知参数/);
  await assert.rejects(()=>toolCall('agentroom_member_card',{role:'Researcher',skills:[],information:'x',sources:[{reference:'fixture:source',verified:true}]},api,{env}),/未知参数/);
  await assert.rejects(()=>toolCall('agentroom_brief_ack',{version:1},api,{env:{}}),{code:'mcp_tool_forbidden'});
  const taskInput={goal_id:id(),title:'Fixture',description:'Fixture',assignee_id:h.member.id,deliverable:'Fixture',acceptance:'Fixture',depends_on:[],idempotency_key:'role-check'};
  const before=(await client.rpc('tools/list')).result.tools.map(tool=>tool.name);
  assert.ok(before.includes('agentroom_task_create'));
  assert.match((await client.call('agentroom_task_create',taskInput)).result.content[0].text,/只有本房间当前秘书/);
  h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});
  const assigned=(await client.rpc('tools/list')).result.tools.map(tool=>tool.name);for(const name of TEAM_TOOLS)assert.ok(assigned.includes(name));
  const goal=h.service.team.goal({room_id:h.room.id,title:'Role change fixture',idempotency_key:'role-goal'});
  assert.equal((await client.call('agentroom_task_create',{...taskInput,goal_id:goal.id})).result.isError,undefined);
  h.service.secretary.set({room_id:h.room.id,reset:true});
  const cleared=(await client.rpc('tools/list')).result.tools.map(tool=>tool.name);assert.deepEqual(cleared,before);
  assert.match((await client.call('agentroom_task_create',taskInput)).result.content[0].text,/只有本房间当前秘书/);
  assert.ok(memberTools(tools,{env:{AGENTROOM_SETUP_MODE:'1'}}).some(tool=>tool.name==='agentroom_group_prepare'));
  assert.ok(memberTools(tools,{env:{}}).some(tool=>tool.name==='agentroom_ask'));
});

test('real member MCP completes team task and meeting contracts while foreign record IDs remain inaccessible',async t=>{
  const h=await setup(t);h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});h.service.secretary.set({room_id:h.otherRoom.id,member_id:h.outsider.id});
  const goal=h.service.team.goal({room_id:h.room.id,title:'Fixture goal',description:'Prove the MCP contract',acceptance:'Recorded evidence',idempotency_key:'goal'});
  const foreignGoal=h.service.team.goal({room_id:h.otherRoom.id,title:'Private other goal',idempotency_key:'foreign-goal'});
  const foreignTask=h.service.team.createTask({room_id:h.otherRoom.id,goal_id:foreignGoal.id,title:'Private other task',assignee_id:h.outsider.id,deliverable:'Private',acceptance:'Private',idempotency_key:'foreign-task'});
  const client=await h.stdio('entry'),http=await h.http();
  const value=async(name,args)=>{const response=await client.call(name,args);assert.equal(response.result.isError,undefined,JSON.stringify(response));return response.result.structuredContent;};
  const card=await value('agentroom_member_card',{role:'Coordinator',skills:['review'],information:'Fixture only',sources:[{reference:'fixture:card'}]});assert.equal(card.sources[0].evidence_type,'reported_reference');
  await value('agentroom_brief_ack',{version:0});
  const input={goal_id:goal.id,title:'Verify output',description:'Inspect fixture output',assignee_id:h.member.id,deliverable:'Evidence',acceptance:'Reference supplied',depends_on:[],idempotency_key:'task'};
  for(const transport of [client,http]){
    const denied=await transport.call('agentroom_task_create',{...input,goal_id:foreignGoal.id});assert.equal(denied.result.isError,true);
    assert.equal((await transport.call('agentroom_task_update',{task_id:foreignTask.id,action:'accept'})).result.isError,true);
    assert.ok(!JSON.stringify((await transport.call('agentroom_team_state')).result.structuredContent).includes('Private other'));
  }
  const task=await value('agentroom_task_create',input);
  assert.equal((await value('agentroom_task_update',{task_id:task.id,action:'accept'})).status,'running');
  assert.equal((await value('agentroom_task_update',{task_id:task.id,action:'submit',result:'Fixture result',evidence:[{reference:'fixture:result'}]})).status,'review');
  assert.equal((await value('agentroom_task_update',{task_id:task.id,action:'approve',note:'Checked the reference'})).status,'completed');
  assert.equal((await value('agentroom_goal_complete',{goal_id:goal.id,result:'Contract verified',evidence:[{reference:'fixture:result'}]})).status,'completed');
  const meeting=await value('agentroom_meeting_start',{title:'Fixture meeting',agenda:'Summarize the result',participant_ids:[h.member.id],idempotency_key:'meeting'});
  await value('agentroom_meeting_report',{meeting_id:meeting.id,summary:'Evidence is ready',completed:'Fixture result',sources:[{reference:'fixture:result'}],idempotency_key:'report-0'});h.service.team.tick();
  await value('agentroom_meeting_discuss',{meeting_id:meeting.id,questions:[{member_id:h.member.id,question:'Any limitations?'}],idempotency_key:'discussion-1'});
  await value('agentroom_meeting_report',{meeting_id:meeting.id,summary:'Only local fixture evidence',sources:[],idempotency_key:'report-1'});h.service.team.tick();
  const closed=await value('agentroom_meeting_close',{meeting_id:meeting.id,summary:'Local contract verified',decisions:['Retain fixture evidence'],action_task_ids:[task.id],idempotency_key:'close'});assert.equal(closed.status,'completed');
  const state=await value('agentroom_team_state',{});assert.ok(state.brief.version>0);assert.equal((await value('agentroom_brief_ack',{version:state.brief.version})).ack_version,state.brief.version);
  assert.equal(h.codex.calls.length,0);
});
