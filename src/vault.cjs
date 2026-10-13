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
  constructor(dir) { this.file = path.join(dir, 'grok-vault.json'); this.cached = undefined; }
  get() {
    if (this.cached !== undefined) return this.cached;
    if (!fs.existsSync(this.file)) return this.cached = null;
    const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (r.mode === 'dpapi') return this.cached = JSON.parse(dpapi(r.value, true));
    if (process.platform !== 'win32' && r.mode === 'user-file') return this.cached = r.value;
    throw new RoomError('凭据存储格式无效。', 500);
  }
  set(url, key) {
    const value = validateWebhook(url, key);
    const record = process.platform === 'win32' ? { mode: 'dpapi', value: dpapi(JSON.stringify(value)) } : { mode: 'user-file', value };
    atomicWrite(this.file, JSON.stringify(record)); this.cached = value;
    return this.status();
  }
  status() { const r = this.get(); return { configured: !!r, host: r ? new URL(r.url).hostname : null, protection: process.platform === 'win32' ? 'Windows DPAPI' : 'user-only file' }; }
  import(file) {
    if (this.get()) return false;
    const r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!r.webhook_url || !r.webhook_key) return false;
    this.set(r.webhook_url, r.webhook_key); return true;
  }
}
module.exports = { Vault, validateWebhook };
