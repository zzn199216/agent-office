'use strict';
// Official download/version validation only. No model calls, account login,
// global install, user config edit, or native application automation.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RuntimeInstaller}=require('../src/runtime-installer.cjs');
const {ClaudeClient}=require('../src/claude.cjs');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-official-claude-')),dir=path.join(root,'.agentroom'),settings=new Map();fs.mkdirSync(dir);
  const env={...process.env,HOME:root,USERPROFILE:root,CLAUDE_CONFIG_DIR:path.join(root,'.claude'),APPDATA:path.join(root,'AppData','Roaming'),LOCALAPPDATA:path.join(root,'AppData','Local')};
  for(const key of Object.keys(env))if(/^(?:ANTHROPIC|CLAUDE_CODE_OAUTH_TOKEN|OPENAI|GOOGLE|GEMINI|AWS|AZURE|VERTEX|FOUNDRY|BEDROCK|QWEN|BAILIAN)_/.test(key)||key==='CLAUDE_CODE_OAUTH_TOKEN')delete env[key];
  const service={store:{dir,setting(key,value){if(arguments.length>1)settings.set(key,value);return settings.get(key);}},chat:{discovery:{env:{}}},changed(){}};
  const installer=new RuntimeInstaller(service,{env});
  try{
    const result=await installer.install({provider:'claude-code'});
    if(!result.installed)throw new Error(result.detail||result.reason);
    const metadata=await new ClaudeClient({executable:result.executable,env}).status();
    const proof={provider:'claude-code',official_download:true,sha256_verified:true,version:result.version,metadata_version:metadata.version,signed_in:metadata.signedIn,executable:result.executable,isolated_home:root,real_model_called:false,user_config_changed:false,computer_use:false};
    const file=path.resolve(__dirname,'../output/validation/claude-runtime-official.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
  }finally{await installer.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
