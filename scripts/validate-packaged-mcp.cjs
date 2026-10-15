'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
async function main(){
  const option=name=>{const index=process.argv.indexOf(name);if(index<0)return null;if(!process.argv[index+1]||process.argv[index+1].startsWith('--'))throw new Error(name+' needs a value');return path.resolve(process.argv[index+1]);};
  const executable=option('--executable')||path.resolve(__dirname,'../dist/AgentRoom.exe'),output=option('--output')||path.resolve(__dirname,'../output/validation/packaged-mcp.json');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-packaged-mcp-'));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(executable,['mcp','--setup','--data-dir',dir],{windowsHide:true,env:{...process.env,AGENTROOM_MEMBER_ID:'',AGENTROOM_ROOM_ID:'',AGENTROOM_CALLER:'',AGENTROOM_SETUP_MODE:'1'},stdio:['pipe','pipe','pipe']});
    let pending='',errorText='',settled=false;
    const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>done(new Error('Packaged MCP metadata timed out')),10000);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.on('error',error=>done(error));child.on('exit',code=>{if(!settled)done(new Error('MCP exited '+code+' '+errorText.slice(-300)));});child.stderr.on('data',part=>errorText+=part);
    child.stdout.on('data',part=>{
      pending+=part;let newline;
      while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);let value;try{value=JSON.parse(line);}catch{continue;}
        if(value.error){done(new Error(value.error.message));return;}
        if(value.id===1){if(!value.result.instructions?.includes(require('../src/operation-policy.cjs').COMMON_OPERATION_INSTRUCTIONS)){done(new Error('Shared operation guidance missing from packaged MCP'));return;}send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});}
        if(value.id===2){const names=value.result.tools.map(tool=>tool.name);if(!['agentroom_connect','agentroom_connect_state','agentroom_connect_retry'].every(name=>names.includes(name))){done(new Error('New setup tools missing'));return;}
          done(null,{packaged_mcp:true,new_connect_tools:true,shared_operation_instructions:true,daemon_started:fs.existsSync(path.join(dir,'control.json')),model_calls:0,version:require('../package.json').version});}
      }
    });
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'isolated-package-metadata',version:'1'}}});
  });
  if(result.daemon_started)throw new Error('Listing tools unexpectedly started a daemon');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
