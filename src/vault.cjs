'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RoomError, atomicWrite } = require('./util.cjs');

function dpapi(value, decrypt = false) {
  const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();${decrypt ? '$b=[Convert]::FromBase64String($v);$o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Text.Encoding]::UTF8.GetString($o))' : '$b=[Text.Encoding]::UTF8.GetBytes($v);$o=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($o))'}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1000000 });
  if (r.status !== 0 || r.error) throw new RoomError('无法访问本机凭据存储，请检查当前用户权限。', 500, 'vault_unavailable');
  return r.stdout.trim();
}
function validateWebhook(url, key) {
  let u; try { u = new URL(String(url).trim()); } catch { throw new RoomError('请填写完整的 HTTPS Webhook URL。'); }
  if (u.protocol !== 'https:' || u.username || u.password || !/^(api2\.cursor\.sh|([a-z0-9-]+\.)*x\.ai)$/.test(u.hostname)) throw new RoomError('请使用 Grok 例程提供的官方 HTTPS Webhook 地址。');
  if (!u.pathname.toLowerCase().includes('/webhook/')) throw new RoomError('请从例程复制 Webhook URL，不是应用内导航或普通网页地址。');
  key = String(key || '').trim().replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '');
  if (!key || /[\r\n\s]/.test(key) || key.length > 4096) throw new RoomError('Webhook key 格式无效。');
  return { url: u.href, key };
}
class Vault {
  constructor(dir,options={}) { this.file = path.join(dir, 'grok-vault.json'); this.cached = undefined;this.stamp=undefined;this.record=null;this.failure=null;this.crypt=options.dpapi||dpapi;this.platform=options.platform||process.platform; }
  readRecord() {
    let stamp,stat;
    try{stat=fs.statSync(this.file,{bigint:true});stamp=`${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;}
    catch(error){stamp=error.code==='ENOENT'?'missing':`unavailable:${error.code||'unknown'}`;}
    if(stamp===this.stamp)return this.record;
    this.stamp=stamp;this.cached=undefined;this.record=null;this.failure=null;
    if(stamp==='missing'){this.cached=null;return null;}
    try{
      if(!stat?.isFile() || stat.size>65536n)throw Error('invalid record');
      const record=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(record.mode==='dpapi' && typeof record.value==='string' && record.value || record.mode==='user-file' && this.platform!=='win32' && record.value && typeof record.value==='object')this.record=record;
      else throw Error('invalid record');
    }catch{this.failure=new RoomError('本机凭据存储暂不可用，请核对已保存配置。',503,'vault_unavailable');}
    return this.record;
  }
  get({retry=false}={}) {
    const record=this.readRecord();
    if(retry && record)this.failure=null;
    if(this.failure)throw this.failure;
    if(this.cached!==undefined)return this.cached;
    if(!record)return null;
    try{
      const value=record.mode==='dpapi'?JSON.parse(this.crypt(record.value,true)):record.value;
      this.cached=validateWebhook(value.url,value.key);return this.cached;
    }catch{this.failure=new RoomError('无法访问本机凭据存储，请检查当前用户权限；没有发送通知。',503,'vault_unavailable');throw this.failure;}
  }
  set(url, key) {
    const value = validateWebhook(url, key);
    const record = this.platform === 'win32' ? { mode: 'dpapi', value: this.crypt(JSON.stringify(value)),host:new URL(value.url).hostname } : { mode: 'user-file', value,host:new URL(value.url).hostname };
    atomicWrite(this.file, JSON.stringify(record));this.readRecord();this.cached = value;this.failure=null;
    return this.status();
  }
  status() {
    const record=this.readRecord(),host=this.cached?new URL(this.cached.url).hostname:typeof record?.host==='string'&&/^(api2\.cursor\.sh|([a-z0-9-]+\.)*x\.ai)$/.test(record.host)?record.host:null;
    // Status is configuration metadata, never a credential-unlock operation.
    // A saved encrypted record remains unverified until an actual delivery.
    return {configured:!!record,host,protection:this.platform==='win32'?'Windows DPAPI':'user-only file',usable:this.failure?false:this.cached?true:record?null:false,...this.failure?{error:this.failure.message,code:this.failure.code}:{}};
  }
  import(file) {
    if (this.get()) return false;
    const r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!r.webhook_url || !r.webhook_key) return false;
    this.set(r.webhook_url, r.webhook_key); return true;
  }
}
module.exports = { Vault, validateWebhook };
