'use strict';
const{spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');let failures=0;
for(const folder of ['src','scripts','web'])for(const name of fs.readdirSync(path.join(root,folder))){if(!/\.(cjs|js)$/.test(name))continue;const r=spawnSync(process.execPath,['--check',path.join(root,folder,name)],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr);failures++;}}
console.log(`${failures?'Failed':'Passed'}: JavaScript syntax checks`);process.exitCode=failures?1:0;
