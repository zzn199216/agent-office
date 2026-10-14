'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { RoomService } = require('../src/service.cjs');
const { createServer } = require('../src/http.cjs');
const { createQwenMcpConfig } = require('../src/mcp-http.cjs');
const { VERSION, id, now } = require('../src/util.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');

async function setup(t) {
  const files = fixture(), codex = new FakeCodex();
  const serviceOptions = { codex, vault: new FakeVault(), fetch: async () => { throw new Error('External HTTP is prohibited in this fixture'); } };
  let service = new RoomService(files.data, serviceOptions);
  const project = service.addProject({ name: 'MCP HTTP fixture', path: files.project });
  const room = service.chat.addRoom({ title: 'Qwen MCP fixture', project_id: project.id });
  function member(name) {
    const person = service.chat.addMember({ name, adapter: 'mailbox' });
    service.chat.join(room.id, person.id);
    return { person, card: service.resume.issue(person.id, room.id).card };
  }
  const first = member('Qwen fixture'), second = member('Peer fixture');
  let server = createServer(service, { port: 0, token: 'fixture-control-token' });
  const port = await server.listen(), base = `http://127.0.0.1:${port}`;
  t.after(async () => { await server.close(); await service.close(); fs.rmSync(files.root, { recursive: true, force: true }); });
  function endpoint(card) { return createQwenMcpConfig(base, card).mcpServers.agentroom.url; }
  async function send(card, message, session, extra = {}) {
    const response = await fetch(endpoint(card), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close', ...session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' } : {}, ...extra.headers }, body: typeof message === 'string' ? message : JSON.stringify(message), ...extra });
    const raw = await response.text();
    return { response, raw, data: raw ? JSON.parse(raw) : null };
  }
  async function initialize(card) {
    const result = await send(card, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Qwen-compatible HTTP fixture', version: '1.0.0' } } });
    assert.equal(result.response.status, 200);
    const session = result.response.headers.get('mcp-session-id');
    assert.match(session, /^[A-Za-z0-9_-]{32}$/);
    const notified = await send(card, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    assert.equal(notified.response.status, 202); assert.equal(notified.raw, '');
    return session;
  }
  function invoke(card, session, name, args = {}) { return send(card, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, session); }
  async function restart() {
    await server.close(); await service.close();
    service = new RoomService(files.data, serviceOptions);
    server = createServer(service, { port, token: 'new-controller-token-after-upgrade' });
    assert.equal(await server.listen(), port);
  }
  return { files, get service() { return service; }, codex, room, project, first, second, base, endpoint, send, initialize, invoke, restart };
}

test('Streamable HTTP discovery stays unverified until an actual permitted member tool call', async t => {
  const h = await setup(t), card = h.first.card;
  const initial = await h.send(card, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initial.data.result.serverInfo, { name: 'agentroom-local', version: VERSION });
  const session = initial.response.headers.get('mcp-session-id');
  await h.send(card, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } });
  const listed = await h.send(card, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } });
  assert.ok(listed.data.result.tools.some(tool => tool.name === 'agentroom_room_ensure'));
  for (const name of ['agentroom_discover_agents', 'agentroom_group_prepare', 'agentroom_ask', 'agentroom_join', 'agentroom_delegate']) assert.ok(!listed.data.result.tools.some(tool => tool.name === name));
  assert.ok(listed.data.result.tools.some(tool => tool.name === 'agentroom_chat_rooms'));
  assert.equal(h.service.resume.credential(card.credential_id).status, 'pending');
  assert.equal(h.service.chat.store.member(card.member_id).verified_at, null);
  const entered = await h.send(card, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agentroom_room_ensure', arguments: {} } }, session, { headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } });
  assert.equal(entered.data.result.isError, undefined);
  assert.equal(entered.data.result.structuredContent.caller_member_id, card.member_id);
  assert.deepEqual(entered.data.result.structuredContent.rooms.map(room => room.id), [card.room_id]);
  assert.equal(h.service.resume.credential(card.credential_id).status, 'active');
  assert.ok(h.service.chat.store.member(card.member_id).verified_at);
  assert.equal(h.service.runtime.memberState(card.member_id).can_wake, false);
  assert.equal(h.codex.calls.length, 0);
  assert.ok(!initial.raw.includes(card.secret) && !listed.raw.includes(card.secret));
});

test('HTTP MCP rejects missing, swapped and invalid protocol sessions without accepting identities', async t => {
  const h = await setup(t), first = await h.initialize(h.first.card), second = await h.initialize(h.second.card);
  const missing = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(missing.response.status, 400);
  const swapped = await h.send(h.second.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, first);
  assert.equal(swapped.response.status, 403);
  const invalid = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'ping' }, first, { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': first, 'MCP-Protocol-Version': 'unsupported' } });
  assert.equal(invalid.response.status, 400);
  const ended = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'invalid-session');
  assert.equal(ended.response.status, 404);
  assert.notEqual(first, second);
  assert.equal(h.service.resume.credential(h.first.card.credential_id).status, 'pending');
  assert.equal(h.service.resume.credential(h.second.card.credential_id).status, 'pending');
});

test('HTTP MCP rechecks secrets, revocation, leave and origin on every request', async t => {
  const h = await setup(t), session = await h.initialize(h.first.card);
  const wrong = { ...h.first.card, secret: 'a'.repeat(43) };
  const failed = await h.send(wrong, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session);
  assert.equal(failed.response.status, 403); assert.ok(!failed.raw.includes(wrong.secret));
  const hostile = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session, { headers: { 'Content-Type': 'application/json', Origin: 'https://chat.qwen.ai', 'Mcp-Session-Id': session } });
  assert.equal(hostile.response.status, 403);
  assert.equal(hostile.response.headers.get('access-control-allow-origin'), null);
  h.service.resume.revoke(h.first.card.credential_id);
  const revoked = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session);
  assert.equal(revoked.response.status, 410);
  const other = await h.initialize(h.second.card);
  h.service.chat.leave(h.room.id, h.second.person.id);
  const left = await h.send(h.second.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, other);
  assert.equal(left.response.status, 200);
  const forbidden = await h.invoke(h.second.card, other, 'agentroom_chat_history', { room_id: h.room.id });
  assert.equal(forbidden.data.result.isError, true);
});

test('HTTP MCP denies administrative, cross-room and spoofed member tool calls', async t => {
  const h = await setup(t), session = await h.initialize(h.first.card);
  const other = h.service.chat.addRoom({ title: 'Other room', project_id: h.project.id });
  const message = h.service.chat.store.post({ room_id: other.id, text: 'private-other-room', idempotency_key: 'other-room' });
  for (const [name, args] of [
    ['agentroom_group_prepare', { user_requested_setup: true, providers: ['codex'] }],
    ['agentroom_chat_history', { room_id: other.id }],
    ['agentroom_chat_wait', { message_id: message.id, seconds: 0 }],
    ['agentroom_chat_post', { room_id: h.room.id, text: 'spoof', idempotency_key: 'spoof', sender_id: h.second.person.id }]
  ]) {
    const denied = await h.invoke(h.first.card, session, name, args);
    assert.equal(denied.response.status, 200); assert.equal(denied.data.result.isError, true);
    assert.ok(!denied.raw.includes('private-other-room'));
  }
  assert.equal(h.service.resume.credential(h.first.card.credential_id).status, 'pending');
  assert.equal(h.service.chat.store.messages(h.room.id).length, 0);
});

test('two simultaneous HTTP MCP members retain their own identity without process environment mutation', async t => {
  const h = await setup(t), first = await h.initialize(h.first.card), second = await h.initialize(h.second.card);
  const keys = ['AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_CALLER', 'AGENTROOM_SETUP_MODE'];
  const previous = keys.map(key => [key, process.env[key]]);
  const replies = await Promise.all([
    h.invoke(h.first.card, first, 'agentroom_room_ensure'), h.invoke(h.second.card, second, 'agentroom_room_ensure')
  ]);
  assert.deepEqual(replies.map(reply => reply.data.result.structuredContent.caller_member_id), [h.first.person.id, h.second.person.id]);
  assert.deepEqual(keys.map(key => [key, process.env[key]]), previous);
});

test('real HTTP MCP tools complete an addressed mailbox question and reply without starting a model', async t => {
  const h = await setup(t), first = await h.initialize(h.first.card), second = await h.initialize(h.second.card);
  const posted = await h.invoke(h.first.card, first, 'agentroom_chat_post', { room_id: h.room.id, to_member_id: h.second.person.id, text: 'Qwen native tool fixture question', idempotency_key: 'one-question' });
  assert.notEqual(posted.data.result.isError, true);
  const message = posted.data.result.structuredContent;
  const inbox = await h.invoke(h.second.card, second, 'agentroom_chat_inbox');
  assert.equal(Array.isArray(inbox.data.result.structuredContent), false);
  assert.deepEqual(inbox.data.result.structuredContent.items, JSON.parse(inbox.data.result.content[0].text));
  assert.equal(inbox.data.result.structuredContent.items[0].id, message.id);
  const replied = await h.invoke(h.second.card, second, 'agentroom_chat_reply', { message_id: message.id, text: 'Actual fixture answer', idempotency_key: 'one-answer' });
  assert.notEqual(replied.data.result.isError, true);
  const waited = await h.invoke(h.first.card, first, 'agentroom_chat_wait', { message_id: message.id, seconds: 0 });
  assert.ok(JSON.stringify(waited.data.result.structuredContent).includes('Actual fixture answer'));
  assert.equal(h.service.chat.store.messages(h.room.id).length, 2);
  assert.equal(h.codex.calls.length, 0);
});

test('proxy HTTP MCP tools only expose and address the stored fixed backend', async t => {
  const h = await setup(t), session = await h.initialize(h.first.card);
  h.service.store.db.prepare('INSERT INTO launch_proxies(id,room_id,provider,name,backend_member_id,proxy_member_id,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id(), h.room.id, 'fixture-provider', 'Fixed fixture proxy', h.second.person.id, h.first.person.id, now(), now());
  const list = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session);
  assert.ok(list.data.result.tools.some(tool => tool.name === 'agentroom_delegate'));
  const third = h.service.chat.addMember({ name: 'Unrelated fixture', adapter: 'mailbox' }); h.service.chat.join(h.room.id, third.id);
  const denied = await h.invoke(h.first.card, session, 'agentroom_chat_post', { room_id: h.room.id, to_member_id: third.id, text: 'must not route', idempotency_key: 'wrong-backend' });
  assert.equal(denied.data.result.isError, true);
  assert.equal(h.service.chat.store.messages(h.room.id).length, 0);
});

test('HTTP MCP handles bounded JSON errors, rejects batches and does not offer a GET event stream', async t => {
  const h = await setup(t), session = await h.initialize(h.first.card);
  const invalid = await h.send(h.first.card, '{', session); assert.equal(invalid.response.status, 400); assert.equal(invalid.data.error.code, -32700);
  const batch = await h.send(h.first.card, [{ jsonrpc: '2.0', id: 1, method: 'ping' }], session); assert.equal(batch.response.status, 400); assert.equal(batch.data.error.code, -32600);
  const large = await h.send(h.first.card, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', padding: 'x'.repeat(64 * 1024) }), session); assert.equal(large.response.status, 413);
  const get = await fetch(h.endpoint(h.first.card), { headers: { Accept: 'text/event-stream' } }); assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
  assert.equal(h.service.resume.credential(h.first.card.credential_id).status, 'pending');
});

test('Qwen import configuration is local Streamable HTTP and refuses external credential destinations', async t => {
  const h = await setup(t), config = createQwenMcpConfig(h.base, h.first.card);
  assert.equal(config.mcpServers.agentroom.type, 'streamable-http');
  assert.ok(config.mcpServers.agentroom.url.startsWith(`${h.base}/mcp/${h.first.card.credential_id}/`));
  for (const destination of ['https://127.0.0.1:9999', 'http://example.com:9999', `${h.base}/other`, `${h.base}?q=1`]) assert.throws(() => createQwenMcpConfig(destination, h.first.card), { code: 'invalid_mcp_address' });
});

test('an imported HTTP MCP address survives deleting its room and keeps working in the next room', async t => {
  const h = await setup(t), url = h.endpoint(h.first.card);
  await h.initialize(h.first.card);
  // The user deletes the only room, makes a new one and adds the same colleague.
  h.service.chat.store.deleteRoom(h.room.id, () => {}, { force: true });
  const fresh = h.service.chat.addRoom({ title: '1', project_id: h.project.id });
  h.service.chat.join(fresh.id, h.first.person.id); h.service.chat.join(fresh.id, h.second.person.id);
  assert.equal(h.endpoint(h.first.card), url);
  const session = await h.initialize(h.first.card);
  const peer = await h.initialize(h.second.card);
  const posted = await h.invoke(h.second.card, peer, 'agentroom_chat_post', { room_id: fresh.id, to_member_id: h.first.person.id, text: '你好', idempotency_key: 'after-delete' });
  assert.notEqual(posted.data.result.isError, true, posted.raw);
  const inbox = await h.invoke(h.first.card, session, 'agentroom_chat_inbox');
  assert.notEqual(inbox.data.result.isError, true, inbox.raw);
  assert.deepEqual(inbox.data.result.structuredContent.items.map(item => item.text), ['你好']);
});

test('credentials earlier versions revoked with a deleted room come back when the colleague is seated again', async t => {
  const h = await setup(t), store = h.service.chat.store, db = h.service.store.db;
  const fresh = h.service.chat.addRoom({ title: '1', project_id: h.project.id });
  // Reproduce the old behaviour: deletion revoked the room's credentials.
  store.deleteRoom(h.room.id, () => {}, { force: true });
  const stamp = db.prepare('SELECT deleted_at FROM chat_room_tombstones WHERE room_id=?').get(h.room.id).deleted_at;
  db.prepare("UPDATE chat_resume_credentials SET status='revoked',revoked_at=? WHERE room_id=?").run(stamp, h.room.id);
  h.service.chat.join(fresh.id, h.first.person.id);
  assert.equal(h.service.resume.credential(h.first.card.credential_id).status, 'pending');
  assert.equal(h.service.resume.credential(h.first.card.credential_id).room_id, fresh.id);
  // An explicit revocation is never undone.
  h.service.resume.revoke(h.first.card.credential_id);
  store.leave(fresh.id, h.first.person.id); h.service.chat.join(fresh.id, h.first.person.id);
  assert.equal(h.service.resume.credential(h.first.card.credential_id).status, 'revoked');
});

test('every imported address resumes, even if the member already has a working credential', async t => {
  const h = await setup(t), store = h.service.chat.store;
  const extra = h.service.resume.issue(h.first.person.id, h.room.id).card;
  const firstSession = await h.initialize(h.first.card), extraSession = await h.initialize(extra);
  store.deleteRoom(h.room.id, () => {}, { force: true });
  const fresh = h.service.chat.addRoom({ title: '新房间', project_id: h.project.id });
  h.service.chat.join(fresh.id, h.first.person.id);
  for (const [card, session] of [[h.first.card, firstSession], [extra, extraSession]]) {
    const result = await h.invoke(card, session, 'agentroom_chat_rooms');
    assert.equal(result.data.result?.isError, undefined, result.raw);
    assert.equal(result.data.result?.structuredContent.current_room_id, fresh.id, result.raw);
  }
});

test('an imported HTTP client keeps its session and reads pending messages after a backend restart', async t => {
  const h = await setup(t), session = await h.initialize(h.first.card), originalUrl = h.endpoint(h.first.card);
  const message = h.service.chat.store.post({ room_id: h.room.id, to_member_id: h.first.person.id, text: '更新后仍可领取', idempotency_key: 'survives-upgrade' });
  await h.restart();
  assert.equal(h.endpoint(h.first.card), originalUrl);
  const listed = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session);
  assert.equal(listed.response.status, 200, listed.raw);
  assert.equal(h.service.resume.credential(h.first.card.credential_id).status, 'pending', 'restoring protocol state is not a member handshake');
  const inbox = await h.invoke(h.first.card, session, 'agentroom_chat_inbox');
  assert.deepEqual(inbox.data.result?.structuredContent.items.map(item => item.id), [message.id]);
  const swapped = await h.send(h.second.card, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, session);
  assert.equal(swapped.response.status, 403);
  h.service.resume.revoke(h.first.card.credential_id); await h.restart();
  assert.equal((await h.send(h.first.card, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, session)).response.status, 410);
});

test('HTTP session persistence stores only a hash and retains initialization ordering after restart', async t => {
  const h = await setup(t);
  const initial = await h.send(h.first.card, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const session = initial.response.headers.get('mcp-session-id');
  await h.restart();
  const uninitialized = await h.send(h.first.card, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(uninitialized.response.status, 400);
  const notified = await h.send(h.first.card, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  assert.equal(notified.response.status, 202);
  const rows = JSON.stringify(h.service.store.db.prepare('SELECT * FROM mcp_http_sessions').all());
  assert.equal(rows.includes(session), false); assert.equal(rows.includes(h.first.card.secret), false);
  assert.equal((await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session)).response.status, 200);
});

test('one imported connection receives messages in newly joined rooms and reports current seats', async t => {
  const h = await setup(t), session = await h.initialize(h.first.card), url = h.endpoint(h.first.card);
  const fresh = h.service.chat.addRoom({ title: '新房间', project_id: h.project.id }); h.service.chat.join(fresh.id, h.first.person.id);
  const old = h.service.chat.store.post({ room_id: h.room.id, to_member_id: h.first.person.id, text: '原房间', idempotency_key: 'old-room' });
  const current = h.service.chat.store.post({ room_id: fresh.id, to_member_id: h.first.person.id, text: '新房间', idempotency_key: 'new-room' });
  const inbox = await h.invoke(h.first.card, session, 'agentroom_chat_inbox');
  assert.equal(h.endpoint(h.first.card), url);
  assert.deepEqual(inbox.data.result.structuredContent.items.map(item => item.id), [old.id, current.id]);
  assert.equal(inbox.data.result.structuredContent.connection.member_id, h.first.person.id);
  assert.equal(inbox.data.result.structuredContent.connection.room_scope, 'joined_rooms');
  assert.deepEqual(new Set(inbox.data.result.structuredContent.connection.rooms.map(room => room.id)), new Set([h.room.id, fresh.id]));
  assert.ok(inbox.data.result.content[1].text.includes(fresh.id));
  const history = await h.invoke(h.first.card, session, 'agentroom_chat_history', { room_id: fresh.id });
  assert.equal(history.data.result.isError, undefined);
  h.service.chat.store.deleteRoom(h.room.id, () => {}, { force: true });
  const moved = await h.invoke(h.first.card, session, 'agentroom_chat_inbox');
  assert.equal(moved.data.result.structuredContent.connection.default_room_id, fresh.id);
  assert.deepEqual(moved.data.result.structuredContent.connection.rooms.map(room => room.id), [fresh.id]);
  h.service.chat.join(fresh.id, h.second.person.id);
  const automaticHistory = await h.invoke(h.first.card, session, 'agentroom_chat_history');
  assert.equal(automaticHistory.data.result.structuredContent.room.id, fresh.id);
  const automaticPost = await h.invoke(h.first.card, session, 'agentroom_chat_post', { to_member_id: h.second.person.id, text: '无需用户给出房间 ID', idempotency_key: 'implicit-room' });
  assert.equal(automaticPost.data.result.isError, undefined);
  assert.equal(automaticPost.data.result.structuredContent.room_id, fresh.id);
});

test('having no room keeps the identity connection alive without exposing deleted room data', async t => {
  const h = await setup(t), session = await h.initialize(h.first.card);
  h.service.chat.store.deleteRoom(h.room.id, () => {}, { force: true });
  const paused = await h.send(h.first.card, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, session);
  assert.equal(paused.response.status, 200);
  const rooms = await h.invoke(h.first.card, session, 'agentroom_chat_rooms');
  assert.deepEqual(rooms.data.result.structuredContent.rooms, []);
  const inbox = await h.invoke(h.first.card, session, 'agentroom_chat_inbox');
  assert.deepEqual(inbox.data.result.structuredContent.items, []);
  assert.equal(inbox.data.result.structuredContent.connection.default_room_id, null);
  const forbidden = await h.invoke(h.first.card, session, 'agentroom_chat_history', { room_id: h.room.id });
  assert.equal(forbidden.data.result.isError, true);
  assert.notEqual(h.service.resume.credential(h.first.card.credential_id).status, 'revoked');
  const fresh = h.service.chat.addRoom({ title: '重新入座', project_id: h.project.id }); h.service.chat.join(fresh.id, h.first.person.id);
  assert.equal((await h.send(h.first.card, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, session)).response.status, 200);
});
