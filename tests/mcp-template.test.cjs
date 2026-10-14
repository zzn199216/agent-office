'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./helpers.cjs'),{id}=require('../src/util.cjs');
const {CARD_SCHEMA,CARD_VERSION}=require('../src/resume.cjs');
const {createMcpTemplates,writeMcpTemplates}=require('../src/mcp-template.cjs');

function setup(t){const f=fixture();fs.mkdirSync(f.data);t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));return f;}
function options(f){return {command:path.join(f.root,'Agent Office.exe'),args:[],entryFile:path.join(f.data,'entries','人物.json'),localUrl:'http://127.0.0.1:47831',card:{schema:CARD_SCHEMA,version:CARD_VERSION,member_id:id(),credential_id:id(),secret:'a'.repeat(43)}};}

test('a first installation with no existing MCP exports two directly usable JSON configs',t=>{
  const f=setup(t),input=options(f),configs=createMcpTemplates(input),files=writeMcpTemplates(f.data,input.card.member_id,configs);
  const stdio=JSON.parse(fs.readFileSync(files.stdio)),http=JSON.parse(fs.readFileSync(files.streamable_http));
  assert.deepEqual(Object.keys(stdio),['mcpServers']);assert.deepEqual(Object.keys(http),['mcpServers']);
  assert.deepEqual(stdio.mcpServers.agentroom,{command:input.command,args:['mcp','--entry',input.entryFile]});
  assert.equal(http.mcpServers.agentroom.type,'streamable-http');
  assert.equal(http.mcpServers.agentroom.url,`${input.localUrl}/mcp/${input.card.credential_id}/${input.card.secret}`);
  assert.equal(JSON.stringify(stdio).includes(input.card.secret),false);
  assert.equal(JSON.stringify(configs).includes('room_id'),false);
  assert.deepEqual(writeMcpTemplates(f.data,input.card.member_id,configs),files);
});

test('templates preserve launcher argument arrays and keep members in separate files',t=>{
  const f=setup(t),first=options(f);first.args=[path.join(f.root,'source folder','main.cjs')];
  const a=writeMcpTemplates(f.data,first.card.member_id,createMcpTemplates(first));
  const before=fs.readFileSync(a.stdio,'utf8'),second=options(f);delete second.localUrl;
  const b=writeMcpTemplates(f.data,second.card.member_id,createMcpTemplates(second));
  assert.notEqual(a.stdio,b.stdio);assert.equal(b.streamable_http,undefined);
  assert.equal(fs.readFileSync(a.stdio,'utf8'),before);
  assert.deepEqual(JSON.parse(before).mcpServers.agentroom.args,[...first.args,'mcp','--entry',first.entryFile]);
  assert.throws(()=>writeMcpTemplates(f.data,'../other',createMcpTemplates(first)),e=>e.code==='mcp_template_invalid');
});

test('a redirected template directory cannot write outside the AO data directory',t=>{
  const f=setup(t),input=options(f),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.mkdirSync(path.join(f.data,'client-config'));
  fs.symlinkSync(outside,path.join(f.data,'client-config','templates'),'junction');
  assert.throws(()=>writeMcpTemplates(f.data,input.card.member_id,createMcpTemplates(input)),e=>e.code==='mcp_template_scope');
  assert.deepEqual(fs.readdirSync(outside),[]);
});
