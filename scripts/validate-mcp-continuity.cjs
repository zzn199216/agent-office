'use strict';
// A packaged protocol check in a fresh temporary instance. No windows, native
// Qwen account, production data or model calls are involved.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { RoomService } = require('../src/service.cjs');
const { fixture, FakeCodex, FakeVault } = require('../tests/helpers.cjs');
const { createQwenMcpConfig } = require('../src/mcp-http.cjs');
const { sleep, VERSION } = require('../src/util.cjs');
let stage = 'seed';

async function main() {
  const files = fixture(), executable = path.resolve(process.argv[2] || path.join(__dirname, '../dist/AgentOffice.exe'));
  let child, control;
  const service = new RoomService(files.data, { codex: new FakeCodex(), vault: new FakeVault() });
  const project = service.addProject({ name: 'Packaged MCP continuity', path: files.project });
  const room = service.chat.addRoom({ title: 'Original room', project_id: project.id });
  const member = service.chat.addMember({ name: 'Protocol fixture mailbox', adapter: 'mailbox' }); service.chat.join(room.id, member.id);
  const entry = service.entry.issue(member.id, room.id);
  const card = JSON.parse(fs.readFileSync(entry.file, 'utf8')), instance = service.runtime.instanceId;
  service.store.setting('codex_path', path.join(files.root, 'no-provider-executable.exe')); await service.close();
  async function start(first = false) {
    child = spawn(executable, ['serve', '--data-dir', files.data, ...(first ? ['--port', '0'] : [])], { windowsHide: true, stdio: 'ignore' });
    const started = child; let failed = false; started.once('error', () => { failed = true; });
    for (let i = 0; i < 100; i++) {
      if (failed || started.exitCode !== null) throw Error('Isolated packaged backend exited before becoming ready');
      try { const current = JSON.parse(fs.readFileSync(path.join(files.data, 'control.json'), 'utf8')); if (current.pid === started.pid) { control = current; return; } } catch {}
      await sleep(100);
    }
    throw Error('Isolated packaged backend timed out');
  }
  async function api(route, input, method = input === undefined ? 'GET' : 'POST') {
    const response = await fetch(control.url + route, { method, headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': 'application/json', Connection: 'close' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, 'Controller operation failed with status ' + response.status); return response.json();
  }
  async function stop() {
    const stopped = child, exited = new Promise(resolve => stopped.once('exit', resolve));
    await api('/api/shutdown', { idle_only: true });
    await Promise.race([exited, sleep(5000)]); assert.notEqual(stopped.exitCode, null, 'Owned backend did not stop'); child = null;
  }
  try {
    stage = 'first-start'; await start(true); assert.equal(control.version, VERSION); assert.equal(control.instance_id, instance);
    const origin = control.url, url = createQwenMcpConfig(origin, card).mcpServers.agentroom.url;
    stage = 'generic-templates';
    const setup = await api(`/api/chat/members/${member.id}/setup?room_id=${room.id}`);
    assert.ok(setup.client.installation_prompt.includes('STDIO：'));
    for (const suffix of ['stdio', 'http']) {
      const template = JSON.parse(fs.readFileSync(path.join(files.data, 'client-config', 'templates', `${member.id}-${suffix}.json`), 'utf8'));
      assert.deepEqual(Object.keys(template), ['mcpServers']);
      if (suffix === 'stdio') { assert.ok(template.mcpServers.agentroom.args.includes('--entry')); assert.ok(fs.existsSync(template.mcpServers.agentroom.command)); }
      else assert.equal(template.mcpServers.agentroom.url, url);
    }
    async function rpc(message, session) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } : {}) }, body: JSON.stringify(message), redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, message.id === undefined ? 202 : 200, 'Packaged MCP operation failed');
      return { response, value: response.status === 202 ? null : await response.json() };
    }
    stage = 'initialize'; const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaged-continuity-fixture', version: '1' } } });
    const session = initialized.response.headers.get('mcp-session-id'); await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    stage = 'identity-without-room'; await api('/api/chat/rooms/' + room.id, {}, 'DELETE');
    const empty = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agentroom_chat_rooms', arguments: {} } }, session);
    assert.deepEqual(empty.value.result.structuredContent.rooms, []);
    await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, session);
    stage = 'new-room'; const fresh = await api('/api/chat/rooms', { title: 'New room', project_id: project.id });
    await api('/api/chat/rooms/' + fresh.id + '/join', { member_id: member.id });
    const message = await api('/api/chat/messages', { room_id: fresh.id, to_member_id: member.id, text: 'Original MCP reads the new room', idempotency_key: 'same-config-new-room' });
    stage = 'first-stop'; await stop(); stage = 'second-start'; await start(); assert.equal(control.url, origin); assert.equal(control.instance_id, instance);
    stage = 'resumed-inbox';
    const inbox = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agentroom_chat_inbox', arguments: {} } }, session);
    assert.equal(inbox.value.result.isError, undefined); assert.deepEqual(inbox.value.result.structuredContent.items.map(item => item.id), [message.id]);
    assert.equal(inbox.value.result.structuredContent.connection.default_room_id, fresh.id);
    assert.deepEqual(inbox.value.result.structuredContent.connection.rooms.map(item => item.id), [fresh.id]);
    const evidence = { version: VERSION, packaged_backend: true, generic_templates_generated: true, same_url: true, same_credential: true, same_http_session: true, identity_connected_without_rooms: true, new_room_message_received: true, deleted_home_recovered: true, same_instance: true, native_qwen_tested: false, user_windows_changed: false, model_calls: 0 };
    const output = path.resolve(__dirname, '../output/validation/mcp-continuity-' + VERSION + '.json'); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
    await stop();
  } finally {
    if (child?.exitCode === null) { const stopped = child; const exited = new Promise(resolve => stopped.once('exit', resolve)); stopped.kill(); await Promise.race([exited, sleep(3000)]); }
    const target = path.resolve(files.root); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('agentroom-test-')) throw Error('Unsafe validation cleanup path');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(JSON.stringify({ failed_stage: stage, error: String(error.message).replace(/https?:\/\/\S+/g, '[address]').slice(0,300) })); process.exitCode = 1; });
