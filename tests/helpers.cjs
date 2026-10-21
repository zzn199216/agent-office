'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {id,sleep}=require('../src/util.cjs');
function providerTestEnv(inherited=process.env){return Object.fromEntries(Object.entries(inherited).filter(([key])=>!/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_|GEMINI_|GOOGLE_|QWEN_)/i.test(key)));}
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-test-'));const project=path.join(root,'project');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'README.md'),'A local test project.');return {root,project,data:path.join(root,'data')};}
class FakeCodex{
  constructor(){this.executable='test-fixture-only';this.calls=[];this.concurrent=0;this.maxConcurrent=0;this.reads=new Map();}
  async status(){return{connected:true,signedIn:true,executable:this.executable};}
  async list(){return[];}
  async read(threadId){return this.reads.get(threadId)||{id:threadId,turns:[]};}
  async run(v){
    this.calls.push(v.request.id);this.concurrent++;this.maxConcurrent=Math.max(this.maxConcurrent,this.concurrent);
    let threadId=v.discussion.thread_id;
    if(!threadId){v.onBinding('creating');threadId=id();v.onBinding('bound',threadId);}
    const turnId=id();v.onTurn(turnId);v.onProgress('正在核查测试项目。');
    try{for(let i=0;i<3;i++){await sleep(12);if(v.signal.aborted){const e=new Error('cancelled');e.code='cancelled';throw e;}}
      this.reads.set(threadId,{id:threadId,turns:[{id:turnId,status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:`回答：${v.request.prompt}`}]}]});
      return{threadId,turnId,answer:`回答：${v.request.prompt}`};
    }finally{this.concurrent--;}
  }
  respond(){}
  async close(){}
}
class FakeVault{constructor(){this.value={url:'https://api2.cursor.sh/test-fixture',key:'crsr_test_fixture_only'};}get(){return this.value;}status(){return{configured:!!this.value,host:'api2.cursor.sh'};}}
module.exports={fixture,FakeCodex,FakeVault,providerTestEnv};
