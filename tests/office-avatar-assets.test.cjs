'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const web = path.join(__dirname, '..', 'web');
const manifest = JSON.parse(fs.readFileSync(path.join(web, 'assets', 'office', 'AVATAR_SOURCES.json'), 'utf8'));

test('offline official avatar files agree with their source and integrity manifest', () => {
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.runtime_network_required, false);
  assert.match(manifest.retrieved_on, /^\d{4}-\d{2}-\d{2}$/);
  const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const family of ['codex', 'claude', 'qwen', 'grok', 'cursor', 'doubao']) {
    const source = manifest.avatars[family];
    assert.equal(source.asset, `/assets/office/avatar-${family}.png`);
    assert.equal(source.fallback, `/assets/office/logo-${family}.svg`);
    assert.ok(source.owner && source.label);
    assert.match(source.source_page, /^https:\/\//);
    assert.match(source.source_url, /^https:\/\//);
    assert.ok(source.kind.startsWith('official_'));
    const bytes = fs.readFileSync(path.join(web, 'assets', 'office', `avatar-${family}.png`));
    assert.ok(bytes.subarray(0, 8).equals(pngMagic), `${family} must be actual PNG`);
    assert.equal(bytes.length, source.bytes, family);
    assert.ok(bytes.length < 128 * 1024, `${family} remains a small offline avatar`);
    assert.equal(bytes.readUInt32BE(16), source.width, family);
    assert.equal(bytes.readUInt32BE(20), source.height, family);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), source.sha256, family);
    assert.ok(fs.existsSync(path.join(web, 'assets', 'office', `logo-${family}.svg`)), `${family} fallback exists`);
  }
  assert.equal(manifest.avatars.doubao.kind, 'official_product_character_avatar');
  assert.equal(manifest.avatars.claude.kind, 'official_product_icon_fallback');
  assert.equal(manifest.avatars.generic.asset, '/assets/office/logo-generic.svg');
  assert.equal(manifest.avatars.generic.kind, 'project_original_fallback_icon');
});
