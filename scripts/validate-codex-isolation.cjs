'use strict';
// Real installed CLI, owned stores, no inference turns. The personal store is
// inspected only to copy ONE already-bound, idle AgentRoom rollout into a fixture.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite'),{CodexClient}=require('../src/codex.cjs'),{fixture}=require('../tests/helpers.cjs'),{dataDirectory,normalizePath}=require('../src/util.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function main(){
  const f=fixture(),legacyHome=path.join(f.root,'personal-copy'),out=path.resolve('output/validation','codex-isolation-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(legacyHome);fs.mkdirSync(out,{recursive:true});
  const reader=new CodexClient(),client=new CodexClient({dataDir:f.data,legacyHome}),proof={ok:false,version:require('../package.json').version,isolated_data:f.data,output:out,model_turns_started:0,personal_threads_created:0,personal_threads_archived:0,checks:{}};
  let source,originalHash;
  try{
    const db=new DatabaseSync(path.join(dataDirectory(),'room.sqlite'),{readOnly:true});let rows;
    try{rows=db.prepare("SELECT b.thread_id,r.id AS discussion_id,r.title AS room_title,m.name AS member_name,p.id AS project_id,p.name AS project_name,p.path AS project_path,p.canonical,p.access FROM chat_bindings b JOIN chat_rooms r ON r.id=b.room_id JOIN chat_members m ON m.id=b.member_id JOIN projects p ON p.id=r.project_id WHERE m.adapter='codex' AND b.binding_state='bound' AND b.thread_id IS NOT NULL ORDER BY b.updated DESC LIMIT 8").all();}finally{db.close();}
    let selected,thread;
    for(const row of rows){const found=await reader.read(row.thread_id);if(found?.name===`AgentRoom · ${row.project_name} · ${row.room_title} · ${row.member_name}`&&found.status?.type!=='active'&&!(found.turns||[]).some(t=>t.status==='inProgress')){selected=row;thread=found;break;}}
    if(!selected)throw Error('No verified idle legacy AgentRoom binding available for native migration validation.');
    source=thread.path;originalHash=hash(fs.readFileSync(source));const copy=path.join(legacyHome,'sessions',path.basename(source));fs.mkdirSync(path.dirname(copy));fs.copyFileSync(source,copy);await reader.close();
    // Titles live in Codex's state database, separately from the rollout bytes.
    const fixtureLegacy=new CodexClient({legacyHome});try{await fixtureLegacy.ready();await fixtureLegacy.call('thread/resume',{threadId:thread.id,path:copy,excludeTurns:true});await fixtureLegacy.call('thread/name/set',{threadId:thread.id,name:thread.name});}finally{await fixtureLegacy.close();}
    const project={id:selected.project_id,name:selected.project_name,path:selected.project_path,canonical:normalizePath(selected.project_path),access:selected.access},discussion={id:selected.discussion_id,title:`${selected.room_title} · ${selected.member_name}`,thread_id:selected.thread_id,binding_state:'bound'};
    let started=0;const call=client.call.bind(client);client.call=(method,...args)=>{if(method==='turn/start'){started++;throw Error('Native isolation validation forbids inference');}return call(method,...args);};
    await client.bind(project,discussion,()=>{throw Error('Migration must preserve binding identity');});
    const migrated=await client.read(discussion.thread_id);assert.equal(migrated.id,thread.id);assert.deepEqual(migrated.turns,thread.turns);assert.ok(migrated.turns.length>0);
    proof.checks.real_cli_import_retains_full_history_and_id=true;proof.turn_count=migrated.turns.length;proof.history_sha256=hash(JSON.stringify(migrated.turns));proof.checks.workspace_path=path.relative(client.workspace.home,require('../src/codex-workspace.cjs').nativePath(migrated.path));assert.ok(!proof.checks.workspace_path.startsWith('..'));
    assert.equal(client.workspace.migrationState(thread.id).verified,true);proof.checks.fixture_source_archive=client.workspace.migrationState(thread.id).source_archived;
    await client.close();const restarted=new CodexClient({dataDir:f.data,legacyHome});try{const restored=await restarted.read(thread.id);assert.deepEqual(restored.turns,migrated.turns);proof.checks.real_cli_restart_retains_full_history=true;}finally{await restarted.close();}
    assert.equal(hash(fs.readFileSync(source)),originalHash);assert.equal(started,0);proof.checks.actual_personal_rollout_unchanged=true;proof.checks.no_model_execution=true;proof.ok=true;
  }catch(error){proof.error=error.message;process.exitCode=1;}finally{await reader.close();await client.close();if(source&&originalHash)proof.personal_source_unchanged=fs.existsSync(source)&&hash(fs.readFileSync(source))===originalHash;fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
