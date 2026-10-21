'use strict';
// Isolated transport fixture. It never reads authentication bytes or calls a model.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const home=process.env.CODEX_HOME;if(!home||!path.isAbsolute(home)||!home.includes('agentroom-test-'))throw Error('An isolated fixture home is required');
// The sentinel models a transport cache change, never an OAuth credential.
fs.mkdirSync(home,{recursive:true});const signedIn=fs.existsSync(path.join(home,'fixture-account-ready'));
readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;fs.appendFileSync(path.join(home,'auth-rpc.jsonl'),JSON.stringify({method:message.method,pid:process.pid})+'\n');if(message.method==='hold')return;const result=message.method==='initialize'?{userAgent:'auth-cache-fixture'}:message.method==='account/read'?{account:signedIn?{type:'chatgpt'}:null,requiresOpenaiAuth:true}:message.method==='config/read'?{config:{model:'fixture-model'}}:{};process.stdout.write(JSON.stringify({id:message.id,result})+'\n');});
