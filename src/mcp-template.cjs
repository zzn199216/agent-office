'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite, RoomError } = require('./util.cjs');
const { createQwenMcpConfig } = require('./mcp-http.cjs');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function createMcpTemplates({ command, args = [], entryFile, localUrl, card }) {
  if (!card || !UUID.test(card.member_id || '')) throw new RoomError('模板需要有效的成员身份。', 400, 'mcp_template_invalid');
  if (typeof command !== 'string' || !path.isAbsolute(command) || /[\0\r\n]/.test(command) || typeof entryFile !== 'string' || !path.isAbsolute(entryFile) || /[\0\r\n]/.test(entryFile) || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) throw new RoomError('模板的本机启动参数无效。', 400, 'mcp_template_invalid');
  const templates = {
    stdio: { mcpServers: { agentroom: { command, args: [...args, 'mcp', '--entry', entryFile] } } }
  };
  if (localUrl) {
    templates.streamable_http = createQwenMcpConfig(localUrl, card);
  }
  return templates;
}

function writeMcpTemplates(dataDirectory, memberId, templates) {
  if (!UUID.test(memberId || '') || !templates?.stdio?.mcpServers?.agentroom) throw new RoomError('连接模板无效。', 400, 'mcp_template_invalid');
  const root = fs.realpathSync.native(dataDirectory);
  let directory = path.resolve(dataDirectory);
  for (const part of ['client-config', 'templates']) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    const relative = path.relative(root, fs.realpathSync.native(directory));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new RoomError('模板目录超出 AO 数据目录。', 403, 'mcp_template_scope');
  }
  const files = {};
  for (const [kind, suffix] of [['stdio', 'stdio'], ['streamable_http', 'http']]) {
    if (!templates[kind]) continue;
    const file = path.join(directory, `${memberId}-${suffix}.json`);
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new RoomError('模板文件不能指向其他位置。', 403, 'mcp_template_scope');
    const text = JSON.stringify(templates[kind], null, 2) + '\n';
    if (!stat || fs.readFileSync(file, 'utf8') !== text) atomicWrite(file, text);
    try { fs.chmodSync(file, 0o600); } catch {}
    files[kind] = file;
  }
  return files;
}

module.exports = { createMcpTemplates, writeMcpTemplates };
