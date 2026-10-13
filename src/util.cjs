'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { isSea, getAsset } = require('node:sea');
const VERSION = require('../package.json').version;

class RoomError extends Error {
  constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function dataDirectory() {
  // AppData is virtualized for packaged Windows clients. The home directory is
  // shared by every local agent, including clients outside the originating app.
  return resolveDataDirectory(process.env.AGENTROOM_DATA_DIR || path.join(process.env.USERPROFILE || os.homedir(), '.agentroom'));
}
function resolveDataDirectory(value){
  let dir=path.resolve(value);const seen=new Set();for(let i=0;i<5;i++){
    const key=dir.toLowerCase();if(seen.has(key))throw new RoomError('聊天室迁移路径循环，请核对原实例。',409,'migration_redirect_invalid');seen.add(key);
    const file=path.join(dir,'migrated-to.json');if(!fs.existsSync(file))return dir;
    let record;try{record=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new RoomError('聊天室迁移指向记录无效。',409,'migration_redirect_invalid');}
    if(record.schema!=='agentroom.migration'||typeof record.target!=='string'||typeof record.instance_id!=='string')throw new RoomError('聊天室迁移指向记录无效。',409,'migration_redirect_invalid');
    const target=path.resolve(record.target),dbfile=path.join(target,'room.sqlite');if(!fs.existsSync(dbfile))throw new RoomError('迁移后的原实例暂不可访问，没有创建替代聊天室。',404,'instance_missing');
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(dbfile,{readOnly:true});try{const row=db.prepare("SELECT value FROM settings WHERE key='instance_fingerprint'").get();if(!row||JSON.parse(row.value)!==record.instance_id)throw new RoomError('迁移指向的实例身份不匹配。',409,'migration_redirect_invalid');}finally{db.close();}dir=target;
  }throw new RoomError('聊天室迁移链过长，请核对原实例。',409,'migration_redirect_invalid');
}
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${id()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  try { fs.renameSync(temp, file); } catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
function asset(name) {
  if (isSea()) return getAsset(name, 'utf8');
  const base = name.startsWith('skill/') ? path.join(__dirname, '..', 'integrations', 'agentroom') : path.join(__dirname, '..', 'web');
  return fs.readFileSync(path.join(base, name.replace(/^skill\//, '')), 'utf8');
}
function assetBytes(name){
  if(isSea())return Buffer.from(getAsset(name));
  const base=name.startsWith('skill/')?path.join(__dirname,'..','integrations','agentroom'):path.join(__dirname,'..','web');
  return fs.readFileSync(path.join(base,name.replace(/^skill\//,'')));
}
function cleanText(value, max = 20000, field = 'message') {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new RoomError(`${field} 不能为空，且长度不能超过 ${max}。`);
  return value.trim();
}
function normalizePath(value) {
  const p = fs.realpathSync.native(path.resolve(value));
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
function projectPath(value) {
  const p = path.resolve(cleanText(value, 4096, '项目路径'));
  let stat;
  try { stat = fs.statSync(p); } catch { throw new RoomError('找不到项目目录，请选择现有文件夹。'); }
  if (!stat.isDirectory() || p === path.parse(p).root) throw new RoomError('请选择具体的项目文件夹。');
  return { display: p, canonical: normalizePath(p) };
}
function redact(value) {
  return String(value ?? '').replace(/crsr_[A-Za-z0-9_-]+/g, '[密钥已隐藏]').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [密钥已隐藏]');
}
function readableError(error) { return redact(error?.message || '操作失败，请重试。').slice(0, 1200); }
function ownCommand() {
  return isSea() ? { command: process.execPath, args: [] } : { command: process.execPath, args: [path.join(__dirname, 'main.cjs')] };
}
function quotedCommand(args = []) {
  const own = ownCommand();
  return shellCommand(own.command,[...own.args,...args]);
}
function shellCommand(command,args=[],platform=process.platform){
  const values=[command,...args];
  if(platform==='win32')return '& '+values.map(x=>`'${String(x).replace(/'/g,"''")}'`).join(' ');
  return values.map(x=>`'${String(x).replace(/'/g,"'\"'\"'")}'`).join(' ');
}
function livePid(pid) { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } }
module.exports = { RoomError, id, now, sleep, atomicWrite, asset,assetBytes, dataDirectory, resolveDataDirectory, cleanText, normalizePath, projectPath, redact, readableError, ownCommand, quotedCommand, shellCommand, livePid, VERSION };
