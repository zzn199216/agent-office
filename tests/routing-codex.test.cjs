'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {lightweight,routingConfig}=require('../src/routing-codex.cjs');
test('lightweight Codex overrides disable project context, shell, images, apps and every existing MCP server',async()=>{
  const config=routingConfig({mcp_servers:{personal:{enabled:true},agentroom:{}}});
  for(const key of ['features.shell_tool','features.view_image','features.multi_agent','features.hooks','apps._default.enabled','mcp_servers.personal.enabled','mcp_servers.agentroom.enabled'])assert.equal(config[key],false);
  assert.equal(config.project_doc_max_bytes,0);assert.equal(config.web_search,'disabled');
  const client=new EventEmitter(),calls=[];client.ready=async()=>{};client.call=async(method,params)=>{calls.push({method,params});if(method==='config/read')return {config:{mcp_servers:{personal:{}}}};if(method==='thread/start')return {thread:{id:'routing-thread'}};if(method==='turn/start'){setImmediate(()=>{client.emit('notification',{method:'item/completed',params:{threadId:'routing-thread',item:{type:'agentMessage',id:'answer',text:'{"owner_id":"B"}'}}});client.emit('notification',{method:'turn/completed',params:{threadId:'routing-thread',turn:{id:'routing-turn',status:'completed'}}});});return {turn:{id:'routing-turn'}};}};
  let saved;const answer=await lightweight(client,{directory:process.cwd(),session:{},prompt:'bounded cards',instructions:'route only',onSession:s=>saved=s});assert.equal(answer,'{"owner_id":"B"}');assert.deepEqual(saved,{thread_id:'routing-thread'});const start=calls.find(c=>c.method==='thread/start').params;assert.deepEqual(start.environments,[]);assert.deepEqual(start.dynamicTools,[]);assert.equal(start.baseInstructions,'route only');assert.equal(client.listenerCount('notification'),0);
});
