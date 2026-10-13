'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {prepareManualClient,planClient}=require('../src/install-clients.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-manual-import-')),data=path.join(root,'owned'),entries=path.join(data,'entries');fs.mkdirSync(entries,{recursive:true});
  const card={schema:'agentroom.resume',version:1,room_id:crypto.randomUUID(),member_id:crypto.randomUUID(),credential_id:crypto.randomUUID(),secret:crypto.randomBytes(32).toString('base64url')};
  const file=path.join(entries,`${card.member_id}-${card.room_id}.json`),command=path.join(root,'AgentRoom.exe');fs.writeFileSync(file,JSON.stringify(card));fs.writeFileSync(command,'metadata only; never executed');
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentoffice-manual-import-/);fs.rmSync(root,{recursive:true,force:true});});
  return {root,data,card,file,command,input:{provider:'doubao',data_dir:data,entry_file:file,command,args:[],local_url:'http://127.0.0.1:47831'}};
}

test('Doubao prepares private native form fields while public progress cannot expose credential URL or entry command',t=>{
  const f=fixture(t),native=path.join(f.root,'unrelated-native.json');fs.writeFileSync(native,'{"private":"keep"}');
  const result=prepareManualClient(f.input),material=JSON.parse(fs.readFileSync(result.configuration_file,'utf8'));
  assert.equal(result.status,'awaiting_import');assert.equal(result.import_kind,'form');assert.equal(result.installed,false);assert.equal(result.connected,false);assert.equal(result.can_wake,false);assert.equal(result.needs_import,true);
  assert.deepEqual(material.manual_fields,{name:'Agent Office',transport:'HTTP',url:`http://127.0.0.1:47831/mcp/${f.card.credential_id}/${f.card.secret}`,headers:{}});assert.equal(material.config,undefined);
  assert.deepEqual(material.conditional_stdio.args,['mcp','--entry',f.file]);assert.match(material.conditional_stdio.condition,/确实提供 STDIO/);assert.match(material.instructions,/不是豆包 JSON/);
  assert.equal(JSON.stringify(result).includes(f.card.secret),false);assert.equal(JSON.stringify(result).includes('/mcp/'),false);assert.equal(JSON.stringify(result).includes(f.command.replace(/\\/g,'\\\\')),false);assert.equal(fs.readFileSync(native,'utf8'),'{"private":"keep"}');
  const before=fs.statSync(result.configuration_file).mtimeMs,cardBefore=fs.readFileSync(f.file,'utf8');
  const repeated=prepareManualClient(f.input);assert.equal(repeated.configuration_file,result.configuration_file);assert.equal(fs.statSync(result.configuration_file).mtimeMs,before);assert.equal(fs.readFileSync(f.file,'utf8'),cardBefore);
});

test('manual STDIO import uses each official schema without changing native profiles or enabling broad approvals',t=>{
  const f=fixture(t);
  for(const provider of ['opencode','cherry-studio','cline','roo-code']){
    const result=prepareManualClient({...f.input,provider}),material=JSON.parse(fs.readFileSync(result.configuration_file,'utf8'));
    assert.equal(result.import_kind,'json');assert.equal(result.installed,false);assert.equal(result.can_wake,false);assert.equal(result.needs_import,true);
    assert.equal(JSON.stringify(result).includes(f.card.secret),false);assert.equal(material.manual_fields,undefined);
    if(provider==='opencode'){assert.equal(material.config.mcp.agentroom.type,'local');assert.deepEqual(material.config.mcp.agentroom.command,[f.command,'mcp','--entry',f.file]);assert.equal(material.config.mcpServers,undefined);}
    else{const server=material.config.mcpServers.agentroom;assert.equal(server.command,f.command);assert.deepEqual(server.args,['mcp','--entry',f.file]);assert.deepEqual(server.env,{});if(provider==='cline')assert.deepEqual(server.autoApprove,[]);if(provider==='roo-code')assert.deepEqual(server.alwaysAllow,[]);}
    if(provider==='cherry-studio')assert.match(material.instructions,/绑定/);
  }
});

test('form preparation rejects non-local URLs, another member path and malformed cards before publication',t=>{
  const f=fixture(t);
  for(const local_url of ['https://example.com/','http://127.0.0.1:47831/not-root','http://localhost:47831/?secret=bad'])assert.throws(()=>prepareManualClient({...f.input,local_url}),error=>error.code==='invalid_mcp_address');
  const alien=path.join(f.root,'alien-entry.json');fs.copyFileSync(f.file,alien);assert.throws(()=>prepareManualClient({...f.input,entry_file:alien}),error=>error.code==='client_config_scope_mismatch');
  const card={...f.card,secret:'invalid'};fs.writeFileSync(f.file,JSON.stringify(card));assert.throws(()=>prepareManualClient(f.input),error=>error.code==='invalid_resume_card');assert.equal(fs.existsSync(path.join(f.data,'client-config')),false);
});

test('stopped HTTP service stays needs_setup and never claims the consumer client was automatically installed',t=>{
  const f=fixture(t),result=prepareManualClient({...f.input,local_url:null});assert.equal(result.status,'needs_setup');assert.equal(result.reason,'local_transport_not_started');assert.equal(result.installed,false);assert.equal(result.connected,false);assert.equal(fs.existsSync(path.join(f.data,'client-config')),false);
  const plan=planClient({provider:'doubao'});assert.equal(plan.reason,'manual_import_required');assert.equal(plan.needs_import,true);assert.equal(plan.import_kind,'form');assert.equal(plan.installed,false);
});

test('linked material directories cannot publish outside the owned data root',t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
  try{fs.symlinkSync(outside,path.join(f.data,'client-config'),'junction');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('test host cannot create a directory link');return;}throw error;}
  assert.throws(()=>prepareManualClient(f.input),error=>error.code==='client_config_scope_mismatch');assert.deepEqual(fs.readdirSync(outside),[]);
});
