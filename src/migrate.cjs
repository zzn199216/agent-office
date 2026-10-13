'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {RoomError,atomicWrite,now,sleep,livePid}=require('./util.cjs');
function inspectLegacy(dir){
  const file=path.join(dir,'room.sqlite');if(!fs.existsSync(file))return null;let db;
  try{const physical=path.dirname(fs.realpathSync.native(file));db=new DatabaseSync(file,{readOnly:true});const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);if(!tables.includes('projects')||!tables.includes('settings')||!tables.includes('requests'))return null;const projects=Number(db.prepare('SELECT count(*) n FROM projects').get().n),rooms=tables.includes('chat_rooms')?Number(db.prepare('SELECT count(*) n FROM chat_rooms').get().n):0;return {dir:physical,projects,rooms,populated:projects>0||rooms>0};}catch{return null;}finally{db?.close();}
}
function legacyCandidates(){const home=process.env.USERPROFILE||os.homedir(),local=path.join(home,'AppData','Local');const dirs=[path.join(local,'AgentRoom')],packages=path.join(local,'Packages');if(fs.existsSync(packages))for(const name of fs.readdirSync(packages))if(/^OpenAI\.Codex_/.test(name))dirs.push(path.join(packages,name,'LocalCache','Local','AgentRoom'));const found=new Map();for(const dir of dirs){const r=inspectLegacy(dir);if(r)found.set(r.dir.toLowerCase(),r);}return [...found.values()];}
async function migrateLegacy(target,{from,stop}={}){
  if(fs.existsSync(path.join(target,'room.sqlite')))return {migrated:false,reason:'existing_shared_instance'};
  const candidates=from?[inspectLegacy(from)].filter(Boolean):legacyCandidates().filter(r=>r.populated);if(from&&!candidates.length)throw new RoomError('指定的原实例不存在或不属于 AgentRoom，没有创建替代实例。',404,'migration_source_missing');if(!candidates.length)return {migrated:false,reason:'new_install'};
  if(candidates.length!==1)throw new RoomError('发现多个有内容的旧实例，请明确选择迁移源；没有合并或创建替代聊天室。',409,'migration_source_ambiguous');
  const source=candidates[0];if(!source.populated)throw new RoomError('所选旧实例为空，没有迁移或覆盖。',409);
  if(path.resolve(target).toLowerCase()===source.dir.toLowerCase())return {migrated:false,reason:'same_directory'};
  if(stop)await stop(source.dir);
  let control;try{control=JSON.parse(fs.readFileSync(path.join(source.dir,'control.json'),'utf8'));}catch{}if(control&&livePid(control.pid))throw new RoomError('旧实例仍在运行，未复制活跃数据库。',409,'migration_busy');
  fs.mkdirSync(target,{recursive:true});const stage=path.join(target,'room.migration.sqlite');fs.copyFileSync(path.join(source.dir,'room.sqlite'),stage);
  if(fs.existsSync(path.join(source.dir,'room.sqlite-wal'))&&fs.statSync(path.join(source.dir,'room.sqlite-wal')).size)throw new RoomError('旧数据库仍有未合并日志，未完成迁移。',409,'migration_wal_pending');
  // Copy only owned persistent records and encrypted credentials. Keep the old
  // directory untouched; caches, process locks and executables are not migrated.
  for(const name of ['grok-vault.json','members','chatrooms','entries']){const p=path.join(source.dir,name);if(fs.existsSync(p))fs.cpSync(p,path.join(target,name),{recursive:true,errorOnExist:true,force:false});}
  fs.renameSync(stage,path.join(target,'room.sqlite'));
  const {Store}=require('./store.cjs'),{RuntimeState}=require('./runtime-state.cjs');const store=new Store(target);let instanceId;try{instanceId=new RuntimeState(store).instanceId;}finally{store.close();}
  atomicWrite(path.join(source.dir,'migrated-to.json'),JSON.stringify({schema:'agentroom.migration',target:fs.realpathSync.native(target),instance_id:instanceId,at:now()},null,2));
  const result={migrated:true,from:source.dir,to:target,instance_id:instanceId,projects:source.projects,rooms:source.rooms,at:now()};atomicWrite(path.join(target,'migration.json'),JSON.stringify(result,null,2));return result;
}
module.exports={inspectLegacy,legacyCandidates,migrateLegacy};
