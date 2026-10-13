'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RoomService } = require('../src/service.cjs');
const { createServer } = require('../src/http.cjs');
const { toolCall } = require('../src/mcp.cjs');
const { assertEntryScope } = require('../src/entry.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');
const { id, sleep } = require('../src/util.cjs');

// These fixtures exercise the real persistent protocol and actual HTTP routes.
// No provider subprocess, model request, global profile or Grok operation runs.
class NativeFixture extends EventEmitter {
  constructor(member, service, log, gates) { super(); this.member = member; this.service = service; this.log = log; this.gates = gates; }
  async status() { return { connected: true, signedIn: true, fixture: true }; }
  async run(input) {
    const thread = input.discussion.thread_id || id();
    if (!input.discussion.thread_id) input.onBinding('bound', thread);
    input.onTurn(id());
    const handshake = input.request.prompt.startsWith('请完成聊天室成员的真实接入握手');
    this.log.push({ member_id: this.member.id, adapter: this.member.adapter, handshake });
    if (this.gates.has(this.member.adapter)) await this.gates.get(this.member.adapter).promise;
    if (handshake) {
      const invitation = input.request.prompt.match(/invite_id=([a-z0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i);
      assert.ok(invitation); this.service.chat.completeInvite(invitation[1], invitation[2], this.member.id);
    }
    return { threadId: thread, turnId: id(), answer: 'fixture actual completion' };
  }
  async close() {}
}
function setup(t) {
  const f = fixture(), log = [], gates = new Map(), installations = [], servers = [];
  let service, scan, scans = 0;
  const codex = path.join(f.root, 'codex.exe'), cli = path.join(f.root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.writeFileSync(codex, 'fixture, never executed'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'fixture, never executed');
  function candidate(provider) {
    return { id: provider, provider, name: provider === 'codex' ? 'Codex' : 'Claude Code', adapter: provider,
      installed: true, running: true, executable: provider === 'codex' ? codex : process.execPath,
      executable_args: provider === 'codex' ? [] : [cli], capabilities: { automatic_launch: true, mcp_install: true }, support: 'ready' };
  }
  scan = { candidates: [candidate('codex')] };
  const options = { codex: new FakeCodex(), vault: new FakeVault(), chat: { clientFactory(member) { return new NativeFixture(member, service, log, gates); } },
    launch: { discover: () => { scans++; return scan; }, installer: async input => { installations.push({ provider: input.provider }); return { status: 'installed', installed: true, connected: false, needs_reload: true }; } } };
  service = new RoomService(f.data, options);
  const project = service.addProject({ name: '持续同步协议fixture', path: f.project });
  const room = service.chat.addRoom({ title: '持续同步群', project_id: project.id });
  t.after(async () => { for (const gate of gates.values()) gate.release(); for (const server of servers) await server.close(); await service.close(); });
  return { ...f, room, project, log, gates, installations, candidate,
    get service() { return service; }, get scans() { return scans; }, get scan() { return scan; }, set scan(value) { scan = value; },
    hold(adapter) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(adapter, { promise, release }); },
    async restart() { await service.close(); service = new RoomService(f.data, options); },
    async api(scope) {
      const token = id(), server = createServer(service, { token, port: 0 }), port = await server.listen(); servers.push(server);
      const base = `http://127.0.0.1:${port}`;
      const api = async (route, input) => {
        if (scope) assertEntryScope({ store: service.store, chat: service.chat.store, runtime: service.runtime, resume: service.resume }, scope, route, input);
        const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        const value = await response.json(); if (!response.ok) { const error = new Error(value.error); error.status = response.status; error.code = value.code; throw error; } return value;
      };
      api.base = base; return api;
    } };
}
async function settle(v) {
  await Promise.all([...v.service.launch.jobs.values()]);
  const limit = Date.now() + 3000; while (v.service.chat.active.size && Date.now() < limit) await sleep(5);
  assert.equal(v.service.chat.active.size, 0);
  return v.service.launch.state({ room_id: v.room.id });
}
async function prepare(v) { v.service.launch.prepare({ room_id: v.room.id, providers: ['codex'], install_clients: true }); return settle(v); }
function env(t, values = {}) {
  const keys = ['AGENTROOM_SETUP_MODE', 'AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_CALLER'], prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function syncInput(v, fields = {}) { return { room_id: v.room.id, routine_ref: 'fixture-native-routine', group_ref: 'fixture-native-group', paused: true, ...fields }; }

test('HTTP legacy sync is control-plane only and returns a pause instruction without scanning', async t => {
  const v = setup(t), state = await prepare(v), proxy = state.proxies[0], scans = v.scans, calls = v.log.length;
  const card = JSON.parse(fs.readFileSync(v.service.entry.issue(proxy.proxy_member_id, v.room.id).file, 'utf8')); v.service.entry.accept(card);
  const scoped = await v.api(card), controller = await v.api();
  await assert.rejects(scoped('/api/launch/sync', { room_id: v.room.id, changes_only: true }), error => error.status === 403 && error.code === 'resume_scope_mismatch');
  await assert.rejects(scoped('/api/launch/sync-report', syncInput(v)), error => error.status === 403);
  const denied = await fetch(controller.base + '/api/launch/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + card.secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ room_id: v.room.id }) });
  assert.equal(denied.status, 401);
  const allowed = await controller('/api/launch/sync', { room_id: v.room.id, changes_only: true });
  assert.equal(allowed.status, 'automatic_sync_disabled'); assert.equal(allowed.changed, false); assert.deepEqual(allowed.actions, []);
  assert.match(allowed.instruction, /暂停/); assert.equal(allowed.pause_routine.verified, false);
  assert.equal(v.scans, scans); assert.equal(v.log.length, calls);
});

test('setup MCP requires a real user scan request and keeps inventory separate from selected preparation', async t => {
  const v = setup(t); env(t); let dispatched = false;
  const noApi = async () => { dispatched = true; throw new Error('must not reach control API'); };
  await assert.rejects(toolCall('agentroom_discover_agents', { user_requested_scan: true, room_id: v.room.id }, noApi), /接入 MCP|普通成员/);
  process.env.AGENTROOM_SETUP_MODE = '1';
  await assert.rejects(toolCall('agentroom_discover_agents', { user_requested_scan: false, room_id: v.room.id }, noApi), /格式无效/);
  assert.equal(dispatched, false);
  const api = await v.api(), scanned = await toolCall('agentroom_discover_agents', { user_requested_scan: true, room_id: v.room.id }, api);
  assert.equal(scanned.status, 'scanned'); assert.equal(v.scans, 1); assert.equal(v.log.length, 0); assert.equal(v.installations.length, 0);
  assert.equal(v.service.chat.store.members().length, 0); assert.deepEqual(scanned.actions, []);
  await assert.rejects(toolCall('agentroom_group_prepare', { user_requested_setup: true, room_id: v.room.id }, api), /缺少 providers/);
  const start = await toolCall('agentroom_group_prepare', { user_requested_setup: true, providers: ['codex'], room_id: v.room.id, install_clients: true }, api);
  await settle(v); assert.equal(v.service.launch.state({ session_id: start.id }).proxies.length, 1);
  assert.equal(v.installations.length, 1); assert.equal(v.log.length, 1);
  process.env.AGENTROOM_MEMBER_ID = v.service.launch.state({ room_id: v.room.id }).proxies[0].proxy_member_id;
  await assert.rejects(toolCall('agentroom_discover_agents', { user_requested_scan: true, room_id: v.room.id }, noApi), /普通成员/);
  await assert.rejects(toolCall('agentroom_group_sync', { room_id: v.room.id }, noApi), /普通成员/);
  assert.equal(dispatched, false);
});

test('legacy native schedules require a real pause report and preserve scope and historical schedule', async t => {
  const v = setup(t), state = await prepare(v), proxy = state.proxies[0];
  v.service.launch.report({ session_id: state.id, proxy_id: proxy.id, name: proxy.name, joined: true, bot_ref: 'fixture-native-bot', group_ref: 'fixture-native-group' });
  v.service.store.db.prepare("INSERT INTO launch_sync_routes VALUES(?,?,?,?,?,'host_reported',?)").run(v.room.id, 'fixture-native-routine', 'fixture-native-group', 10, '2026-10-12T06:00:00.000Z', '2026-10-12T05:50:00.000Z');
  await v.restart();
  const before = v.service.launch.state({ room_id: v.room.id });
  assert.equal(before.native_sync.status, 'pause_requested'); assert.equal(before.native_sync.verified, false);
  const scans = v.scans, calls = v.log.length, disabled = v.service.launch.sync({ room_id: v.room.id });
  assert.equal(disabled.pause_routine.routine_ref, 'fixture-native-routine'); assert.equal(disabled.pause_routine.group_ref, 'fixture-native-group');
  assert.equal(disabled.pause_routine.host_reported, false); assert.equal(v.scans, scans); assert.equal(v.log.length, calls);
  assert.equal(disabled.pause_routine.requires_pause, true); assert.match(disabled.report_command, /fixture-native-routine/); assert.match(disabled.report_command, /--paused/);
  const api = await v.api();
  await assert.rejects(api('/api/launch/sync-report', syncInput(v, { paused: false, interval_minutes: 10, next_run: '2026-10-13T06:00:00.000Z' })), error => error.status === 403 && error.code === 'automatic_sync_disabled');
  await assert.rejects(api('/api/launch/sync-report', syncInput(v, { group_ref: 'different-native-group' })), error => error.status === 409);
  await assert.rejects(api('/api/launch/sync-report', syncInput(v, { routine_ref: 'different-native-routine' })), error => error.status === 409);
  const result = await api('/api/launch/sync-report', syncInput(v));
  assert.equal(result.native_sync.status, 'host_reported_paused'); assert.equal(result.native_sync.verified, false);
  assert.equal(result.native_sync.next_run, '2026-10-12T06:00:00.000Z'); assert.equal(result.native_sync.interval_minutes, 10);
  assert.equal(v.service.launch.sync({ room_id: v.room.id }).pause_routine.host_reported, true);
  assert.equal(v.service.launch.sync({ room_id: v.room.id }).pause_routine.requires_pause, false); assert.equal(v.service.launch.sync({ room_id: v.room.id }).report_command, null);
  await v.restart(); assert.equal(v.service.launch.state({ room_id: v.room.id }).native_sync.status, 'host_reported_paused');
  assert.equal(v.service.chat.store.member(proxy.proxy_member_id).verified_at, null);
});

test('MCP compatibility calls refuse scheduling while allowing actual native pause receipts', async t => {
  const v = setup(t); await prepare(v); env(t, { AGENTROOM_SETUP_MODE: '1' });
  const api = await v.api(), first = await toolCall('agentroom_group_sync', { room_id: v.room.id, changes_only: true }, api);
  assert.equal(first.status, 'automatic_sync_disabled'); assert.equal(first.changed, false); assert.deepEqual(first.actions, []);
  await assert.rejects(toolCall('agentroom_sync_report', syncInput(v, { paused: false }), api), /格式无效/);
  const reported = await toolCall('agentroom_sync_report', syncInput(v), api);
  assert.equal(reported.native_sync.status, 'host_reported_paused'); assert.equal(reported.native_sync.verified, false);
});

test('new providers are inventory only until separately selected, with original threads preserved across restart', async t => {
  const v = setup(t), first = await prepare(v), original = first.proxies[0];
  v.scan = { candidates: [v.candidate('codex'), v.candidate('claude-code')] };
  const scans = v.scans, calls = v.log.length;
  v.service.launch.watch.start(); await v.service.launch.watch.tick({ force: true }); v.service.launch.sync({ room_id: v.room.id });
  assert.equal(v.scans, scans); assert.equal(v.log.length, calls); assert.equal(v.service.launch.state({ room_id: v.room.id }).proxies.length, 1);
  const scanned = v.service.launch.scan({ room_id: v.room.id });
  assert.equal(scanned.candidates.length, 2); assert.equal(v.log.length, calls); assert.equal(v.installations.length, 1);
  const originalThread = v.service.chat.store.binding(v.room.id, original.backend_member_id).thread_id;
  v.service.launch.prepare({ room_id: v.room.id, providers: ['claude-code'], install_clients: true }); const changed = await settle(v);
  assert.equal(changed.proxies.length, 2); assert.deepEqual(changed.actions.map(action => action.name), ['Claude Code']);
  assert.equal(v.log.filter(call => call.adapter === 'codex' && call.handshake).length, 1);
  assert.equal(v.log.filter(call => call.adapter === 'claude-code' && call.handshake).length, 1);
  assert.deepEqual(v.installations.map(call => call.provider), ['codex', 'claude-code']);
  const ids = changed.proxies.map(proxy => proxy.id).sort(), afterScans = v.scans, afterCalls = v.log.length;
  await v.restart(); await v.service.launch.watch.tick({ force: true }); v.service.launch.sync({ room_id: v.room.id });
  assert.equal(v.scans, afterScans); assert.equal(v.log.length, afterCalls);
  assert.deepEqual(v.service.launch.state({ room_id: v.room.id }).proxies.map(proxy => proxy.id).sort(), ids);
  assert.equal(v.service.chat.store.binding(v.room.id, original.backend_member_id).thread_id, originalThread);
  assert.equal(v.service.store.db.prepare('SELECT COUNT(*) AS n FROM launch_watches WHERE enabled=1').get().n, 0);
});

test('manual inventory updates cannot add unsupported desktops or persist arbitrary scanner secrets', async t => {
  const v = setup(t), before = await prepare(v), calls = v.log.length;
  v.scan.candidates.push({ provider: 'doubao', id: 'doubao', name: '豆包', adapter: 'mailbox', installed: true, running: true, executable: path.join(v.root, 'Doubao.exe'), capabilities: { automatic_launch: false }, support: 'unsupported', pids: [1234],
    commandLine: 'Bearer crsr_fake_provider_secret', env: { KEY: 'do-not-persist-me' }, instances: [{ pid: 1234, role: 'desktop', commandLine: 'Bearer crsr_fake_provider_secret' }] });
  const scan = v.service.launch.scan({ room_id: v.room.id }), current = v.service.launch.state({ room_id: v.room.id });
  assert.equal(scan.status, 'scanned'); assert.ok(current.candidates.some(candidate => candidate.provider === 'doubao' && candidate.running));
  assert.equal(current.updated, before.updated); assert.equal(current.proxies.length, 1); assert.equal(v.log.length, calls);
  const persisted = v.service.store.db.prepare('SELECT candidates FROM launch_sessions WHERE id=?').get(before.id).candidates;
  assert.equal(persisted.includes('crsr_fake_provider_secret'), false); assert.equal(persisted.includes('do-not-persist-me'), false); assert.equal(persisted.includes('commandLine'), false);
  await v.restart(); assert.ok(v.service.launch.state({ room_id: v.room.id }).candidates.some(candidate => candidate.provider === 'doubao'));
});
