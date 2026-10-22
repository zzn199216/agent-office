'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {STATES,SHORT_NAMES,present}=require('../src/member-connection.cjs');

const PROVIDERS=Object.keys(SHORT_NAMES);
// Every stage literal the backend can emit, read from source so a new stage
// cannot be added without a presentation.
function backendStages(){
  const files=['onboarding.cjs','onboarding-verification.cjs','connection-assist.cjs','connection-target.cjs'].map(file=>fs.readFileSync(path.join(__dirname,'..','src',file),'utf8')).join('\n');
  const found=new Set();
  for(const match of files.matchAll(/stage\s*[:=]\s*'([a-z_]+)'/g))found.add(match[1]);
  for(const match of files.matchAll(/stage==='([a-z_]+)'/g))found.add(match[1]);
  return [...found].sort();
}
const STATUSES=['not_started','running','needs_action','ready','error','interrupted','cancelled'];
const width=text=>[...text].reduce((sum,ch)=>sum+(/[\u0000-\u00ff]/.test(ch)?1:2),0);
const BANNED=/保留|沿用|没有自动重试|未宣称|不会生成|原生会话|本人对话|握手|兼容 MCP|群桥接|协议/;

test('every backend stage and status maps to one of five states with a short headline',()=>{
  const stages=backendStages();
  assert.ok(stages.length>=15,`expected the backend stage catalogue, got ${stages.length}`);
  for(const provider of PROVIDERS)for(const stage of [...stages,null])for(const status of STATUSES){
    const view=present({provider,stage,status,next_actions:[]});
    const label=`${provider}/${stage}/${status}`;
    assert.ok(STATES.includes(view.state),label);
    assert.equal(typeof view.headline,'string',label);
    assert.ok(view.headline.length>0&&width(view.headline)<=48,`${label}: ${view.headline}`);
    assert.doesNotMatch(view.headline,BANNED,label);
    for(const action of [view.primary,view.secondary].filter(Boolean)){
      assert.equal(typeof action.operation,'string',label);
      assert.ok(action.label.length>0&&width(action.label)<=24,`${label}: ${action.label}`);
      assert.doesNotMatch(action.label,BANNED,label);
    }
    // Only finished or in-flight connections may lack a primary action.
    if(!['connected','auto'].includes(view.state)&&!view.busy)assert.ok(view.primary,`${label} has no way forward`);
  }
});

test('ready connections are connected or auto, and only wake-capable desktop clients offer automatic wake',()=>{
  assert.equal(present({provider:'codex',status:'ready',stage:'ready_automatic',ready_for_office:true,can_wake:true}).state,'auto');
  const doubao=present({provider:'doubao',status:'ready',stage:'ready_mailbox',local_verified:true,can_wake:false});
  assert.equal(doubao.state,'connected');assert.equal(doubao.primary,null);assert.equal(doubao.secondary.operation,'enable_wake');
  assert.equal(present({provider:'claude-desktop',status:'ready',stage:'ready_mailbox',local_verified:true}).secondary,null);
});

test('the four tested dead ends each get a direct action',()=>{
  // Qwen/Doubao not reachable: one button that opens and connects.
  const qwen=present({provider:'qwen-desktop',status:'needs_action',stage:'awaiting_native_desktop',next_actions:[{operation:'open_native_client'},{operation:'native_desktop_connect'},{operation:'manual_mcp',target_member_id:'m1'}]});
  assert.equal(qwen.primary.operation,'native_connect');assert.equal(qwen.secondary.operation,'manual_mcp');assert.equal(qwen.secondary.target_member_id,'m1');
  // Grok bound to another room: go there or create a new member.
  const grok=present({provider:'grok-bot',status:'needs_action',stage:'fixed_proxy_scope',next_actions:[{operation:'open_fixed_room',target_member_id:'g1'}]});
  assert.equal(grok.state,'attention');assert.equal(grok.primary.operation,'open_fixed_room');assert.equal(grok.secondary.operation,'new_member');
  // Revoked Claude: reauthorize directly.
  const claude=present({provider:'claude-desktop',status:'needs_action',stage:'awaiting_credential',next_actions:[{operation:'reauthorize',target_member_id:'c1'}]});
  assert.equal(claude.primary.operation,'reauthorize');assert.equal(claude.primary.target_member_id,'c1');
  // Client running without the debug port: restart offer.
  const running=present({provider:'doubao',status:'needs_action',stage:'awaiting_native_desktop',error_code:'desktop_client_restart_required',next_actions:[{operation:'open_native_client'}]});
  assert.equal(running.state,'attention');assert.equal(running.primary.operation,'open_native_client');assert.match(running.primary.label,/重启/);
});

test('Codex protection overrides readiness and never offers a login',()=>{
  const view=present({provider:'codex',status:'ready',stage:'connection_repair_required',ready_for_office:true,can_wake:true});
  assert.equal(view.state,'attention');assert.equal(view.primary.operation,'show_connection_repair');
  assert.equal(present({provider:'codex',status:'needs_action',stage:'awaiting_auth',next_actions:[{operation:'retry'}]}).primary.operation,'retry');
});

test('presentation is projection only: input snapshots are not mutated',()=>{
  const input={provider:'doubao',status:'needs_action',stage:'awaiting_handshake',next_actions:[{operation:'copy_handshake_prompt'}]};
  const before=JSON.stringify(input);present(input);assert.equal(JSON.stringify(input),before);
});
