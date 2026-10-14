'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { listenLocal, savedPort } = require('../src/http-listener.cjs');
const { fixture } = require('./helpers.cjs');

function setup(t) {
  const files = fixture(), settings = new Map(); fs.mkdirSync(files.data);
  t.after(() => fs.rmSync(files.root, { recursive: true, force: true }));
  return { ...files, runtime: { instanceId: 'saved-listener-instance' }, store: { dir: files.data, setting(key, value) { if (value === undefined) return settings.get(key); settings.set(key, value); return value; } } };
}
function createServer(_service, { port }) {
  const server = http.createServer((_req, res) => res.end('fixture'));
  return {
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); return server.address().port; },
    async close() { await new Promise(resolve => server.close(resolve)); }
  };
}
test('restart uses the saved address even when the first listener selected an ephemeral port', async t => {
  const h = setup(t), first = await listenLocal(h, { port: 0 }, { createServer });
  await first.server.close();
  const second = await listenLocal(h, {}, { createServer }); t.after(() => second.server.close());
  assert.equal(second.port, first.port); assert.equal(savedPort(h), first.port);
});
test('an occupied saved port fails visibly instead of invalidating imported MCP addresses', async t => {
  const h = setup(t), first = await listenLocal(h, { port: 0 }, { createServer }); await first.server.close();
  const blocker = createServer(h, { port: first.port }); await blocker.listen(); t.after(() => blocker.close());
  await assert.rejects(listenLocal(h, {}, { createServer }), { code: 'mcp_port_in_use' });
  assert.equal(savedPort(h), first.port);
});
test('an older control file migrates its address only when it belongs to the same instance', t => {
  const h = setup(t), file = path.join(h.data, 'control.json');
  fs.writeFileSync(file, JSON.stringify({ instance_id: h.runtime.instanceId, url: 'http://127.0.0.1:49203', pid: 2147483647 }));
  assert.equal(savedPort(h), 49203);
  for (const value of [{ instance_id: 'another-instance', url: 'http://127.0.0.1:49203' }, { instance_id: h.runtime.instanceId, url: 'http://example.com:49203' }]) { fs.writeFileSync(file, JSON.stringify(value)); assert.equal(savedPort(h), null); }
});
