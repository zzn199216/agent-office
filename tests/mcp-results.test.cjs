'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{PassThrough}=require('node:stream'),{runMcp}=require('../src/mcp.cjs');
test('stdio MCP list results have object structuredContent and preserve the text array',async t=>{
  const input=new PassThrough(),output=new PassThrough(),rows=[{id:'fixture-message',text:'actual inbox result'}],messages=[];
  const api=async()=>rows;api.mcpContext=async()=>({env:{AGENTROOM_MEMBER_ID:'fixture-member',AGENTROOM_ROOM_ID:'fixture-room'}});
  const rl=runMcp(api,input,output);t.after(()=>{rl.close();input.destroy();output.destroy();});
  let received;const answer=new Promise(resolve=>received=resolve);let buffer='';output.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))!==-1){const response=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);messages.push(response);if(response.id===2)received(response);}});
  const send=message=>input.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
  send({id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});send({method:'notifications/initialized'});send({id:2,method:'tools/call',params:{name:'agentroom_chat_inbox',arguments:{}}});
  const response=await answer;assert.equal(response.result.isError,undefined);assert.equal(Array.isArray(response.result.structuredContent),false);assert.deepEqual(response.result.structuredContent,{items:rows});assert.deepEqual(JSON.parse(response.result.content[0].text),rows);
});
