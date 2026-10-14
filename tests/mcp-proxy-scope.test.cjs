'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { RoomService } = require('../src/service.cjs');
const { createServer } = require('../src/http.cjs');
const { readEntry, openDisk, assertEntryScope } = require('../src/entry.cjs');
const { memberConnection, proxyFor } = require('../src/member-policy.cjs');
const { id, now, VERSION } = require('../src/util.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');

async function setup(t) {
  const files = fixture(), codex = new FakeCodex();
  const service = new RoomService(files.data, {
    codex, vault: new FakeVault(),
    fetch: async () => { throw new Error('External HTTP is prohibited in this fixture'); }
  });
  const project = service.addProject({ name: 'fixed proxy scope fixture', path: files.project });
  const a = service.chat.addRoom({ title: 'Original proxy room A', project_id: project.id });
  const b = service.chat.addRoom({ title: 'Other joined room B', project_id: project.id });
  const normal = service.chat.addMember({ name: 'Ordinary fixture member', adapter: 'mailbox' });
  const proxy = service.chat.addMember({ name: 'Fixed fixture proxy', adapter: 'mailbox' });
  const backend = service.chat.addMember({ name: 'Fixed fixture backend', adapter: 'mailbox' });
  for (const room of [a, b]) for (const member of [normal, proxy, backend]) service.chat.join(room.id, member.id);
  service.store.db.prepare('INSERT INTO launch_proxies(id,room_id,provider,name,backend_member_id,proxy_member_id,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run(id(), a.id, 'fixture-proxy', proxy.name, backend.id, proxy.id, now(), now());
  const messages = {};
  for (const member of [normal, proxy]) {
    messages[member.id] = [a, b].map(room => service.chat.store.post({
      room_id: room.id, sender_id: 'user', to_member_id: member.id,
      text: `${room.id === a.id ? 'A' : 'B'} addressed question for ${member.name}`,
      idempotency_key: `${member.id}:${room.id}`
    }));
  }
  const token = id(), server = createServer(service, { port: 0, token });
  const port = await server.listen();
  fs.writeFileSync(path.join(files.data, 'control.json'), JSON.stringify({
    pid: process.pid, url: `http://127.0.0.1:${port}`, token, version: VERSION, instance_id: service.runtime.instanceId
  }));
  t.after(async () => {
    await server.close(); await service.close();
    const fixtureRoot = path.resolve(files.root);
    assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
    assert.match(path.basename(fixtureRoot), /^agentroom-test-/);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const entry = member => service.entry.issue(member.id, a.id);
  const withDisk = (entry, action) => {
    const current = readEntry(entry.file), disk = openDisk(files.data, { readOnly: true });
    try { return action(disk, current.card); } finally { disk.close(); }
  };
  return { files, service, codex, a, b, normal, proxy, backend, messages, entry, withDisk };
}

async function stdio(t, entry, dataDirectory) {
  const env = { ...process.env, AGENTROOM_DATA_DIR: dataDirectory };
  for (const name of ['AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_INSTANCE_ID', 'AGENTROOM_SETUP_MODE', 'AGENTROOM_CALLER']) delete env[name];
  const child = spawn(process.execPath, [path.resolve(__dirname, '../src/main.cjs'), 'mcp', '--entry', entry.file], {
    cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let sequence = 0, stderr = '', protocolFailure;
  const pending = new Map(), lines = readline.createInterface({ input: child.stdout });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const fail = error => { protocolFailure = error; for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); } pending.clear(); };
  child.on('error', fail);
  child.on('exit', (code, signal) => { if (pending.size) fail(new Error(`Fixture MCP exited (${code ?? signal}): ${stderr}`)); });
  lines.on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { fail(new Error('Fixture MCP stdout must contain only JSON-RPC')); return; }
    const wait = pending.get(value.id);
    if (wait) { pending.delete(value.id); clearTimeout(wait.timer); wait.resolve(value); }
  });
  t.after(async () => {
    lines.close(); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill(), 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  });
  const request = (method, params) => {
    if (protocolFailure) return Promise.reject(protocolFailure);
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Fixture MCP timed out for ${method}: ${stderr}`)); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  };
  const initialized = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { request, inbox: (args = {}) => request('tools/call', { name: 'agentroom_chat_inbox', arguments: args }) };
}

function inboxItems(value) {
  assert.equal(value.result?.isError, undefined, JSON.stringify(value));
  assert.ok(Array.isArray(value.result?.structuredContent?.items));
  const items = value.result.structuredContent.items;
  assert.deepEqual(JSON.parse(value.result.content[0].text), items, 'stdio keeps its first-block array contract');
  return items;
}
const sortedIds = messages => messages.map(message => message.id).sort();

test('ordinary stdio member inbox without room_id still reads every current seat', async t => {
  const h = await setup(t), entry = h.entry(h.normal), client = await stdio(t, entry, h.files.data);
  h.withDisk(entry, (disk, card) => assert.doesNotThrow(() => assertEntryScope(disk, card, `/api/chat/inbox?member_id=${h.normal.id}`)));
  assert.deepEqual(sortedIds(inboxItems(await client.inbox())), sortedIds(h.messages[h.normal.id]));
  assert.deepEqual(sortedIds(inboxItems(await client.inbox({ room_id: h.b.id }))), [h.messages[h.normal.id][1].id]);
  assert.equal(h.codex.calls.length, 0);
});

test('fixed proxy seated in A and B defaults its stdio inbox to A and shared policy denies B', async t => {
  const h = await setup(t), entry = h.entry(h.proxy), client = await stdio(t, entry, h.files.data);
  h.withDisk(entry, (disk, card) => {
    assert.equal(proxyFor(disk, card).room_id, h.a.id);
    assert.deepEqual(memberConnection(disk, card).rooms.map(room => room.id), [h.a.id]);
    for (const route of [`/api/chat/inbox?member_id=${h.proxy.id}`, `/api/chat/inbox?member_id=${h.proxy.id}&room_id=${h.b.id}`]) {
      assert.throws(() => assertEntryScope(disk, card, route), { status: 403, code: 'resume_scope_mismatch' });
    }
  });
  assert.deepEqual(sortedIds(inboxItems(await client.inbox())), [h.messages[h.proxy.id][0].id]);
  const denied = await client.inbox({ room_id: h.b.id });
  assert.equal(denied.result.isError, true);
  assert.ok(!JSON.stringify(denied).includes(h.messages[h.proxy.id][1].text));
  assert.equal(h.codex.calls.length, 0);
});

test('same proxy credential and live stdio context stay fixed to A after rehome to B and recover when A is rejoined', async t => {
  const h = await setup(t), entry = h.entry(h.proxy), originalFile = fs.readFileSync(entry.file, 'utf8');
  const originalCard = JSON.parse(originalFile), client = await stdio(t, entry, h.files.data);
  assert.deepEqual(sortedIds(inboxItems(await client.inbox())), [h.messages[h.proxy.id][0].id]);
  h.service.chat.leave(h.a.id, h.proxy.id);
  assert.equal(h.service.resume.credential(originalCard.credential_id).room_id, h.b.id);
  h.withDisk(entry, (disk, card) => {
    assert.equal(card.room_id, h.b.id);
    assert.equal(proxyFor(disk, card).room_id, h.a.id, 'proxy origin survives credential rehoming');
    assert.throws(() => memberConnection(disk, card), { status: 403, code: 'proxy_not_bound' });
    assert.throws(() => assertEntryScope(disk, card, `/api/chat/inbox?member_id=${h.proxy.id}&room_id=${h.b.id}`), { status: 403, code: 'resume_scope_mismatch' });
  });
  assert.equal((await client.inbox()).result.isError, true);
  assert.equal((await client.inbox({ room_id: h.b.id })).result.isError, true);
  h.service.chat.join(h.a.id, h.proxy.id);
  assert.equal(h.service.resume.credential(originalCard.credential_id).room_id, h.b.id, 'a working credential remains rehomed, so context must use persisted proxy origin');
  const resumed = await client.inbox();
  assert.deepEqual(sortedIds(inboxItems(resumed)), [h.messages[h.proxy.id][0].id]);
  assert.equal(resumed.result.structuredContent.connection.default_room_id, h.a.id);
  assert.equal(resumed.result.structuredContent.connection.room_scope, 'fixed_proxy');
  assert.deepEqual(resumed.result.structuredContent.connection.rooms.map(room => room.id), [h.a.id]);
  assert.equal(readEntry(entry.file).card.credential_id, originalCard.credential_id);
  assert.equal(fs.readFileSync(entry.file, 'utf8'), originalFile);
  assert.equal(h.codex.calls.length, 0);
});

test('deleted proxy origin stays authoritative after credential rehome and cannot become room B access', async t => {
  const h = await setup(t), entry = h.entry(h.proxy), originalFile = fs.readFileSync(entry.file, 'utf8');
  const originalCard = JSON.parse(originalFile), client = await stdio(t, entry, h.files.data);
  assert.deepEqual(sortedIds(inboxItems(await client.inbox())), [h.messages[h.proxy.id][0].id]);
  h.service.chat.store.deleteRoom(h.a.id, () => {}, { force: true });
  assert.equal(h.service.resume.credential(originalCard.credential_id).room_id, h.b.id);
  h.withDisk(entry, (disk, card) => {
    assert.equal(proxyFor(disk, card).room_id, h.a.id);
    assert.throws(() => memberConnection(disk, card), { status: 403, code: 'proxy_not_bound' });
    assert.throws(() => assertEntryScope(disk, card, `/api/chat/inbox?member_id=${h.proxy.id}&room_id=${h.b.id}`), { status: 403, code: 'resume_scope_mismatch' });
  });
  for (const args of [{}, { room_id: h.b.id }]) {
    const denied = await client.inbox(args);
    assert.equal(denied.result.isError, true);
    assert.ok(!JSON.stringify(denied).includes(h.messages[h.proxy.id][1].text));
  }
  assert.deepEqual(h.service.chat.store.rooms().map(room => room.id), [h.b.id]);
  assert.equal(fs.readFileSync(entry.file, 'utf8'), originalFile);
  assert.equal(h.codex.calls.length, 0);
});
