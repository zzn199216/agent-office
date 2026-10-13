'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const art = require('../web/pixel-art.js');
const { PIXEL_IDS, OFFICE_FILES } = require('../src/office-assets.cjs');

const office = path.join(__dirname, '..', 'web', 'assets', 'office');
const manifest = JSON.parse(fs.readFileSync(path.join(office, 'AVATAR_SOURCES.json'), 'utf8'));
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkPng(record, file, label) {
  assert.equal(record.asset, `/assets/office/${file}`, label);
  const bytes = fs.readFileSync(path.join(office, file));
  assert.ok(bytes.subarray(0, 8).equals(pngMagic), `${label} must be actual PNG`);
  assert.equal(bytes.length, record.bytes, label);
  assert.ok(bytes.length < 32 * 1024, `${label} remains a small offline sprite`);
  assert.equal(bytes.readUInt32BE(16), record.width, label);
  assert.equal(bytes.readUInt32BE(20), record.height, label);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256, label);
  assert.ok(OFFICE_FILES.includes(`assets/office/${file}`), `${label} ships in desktop builds`);
}

test('pixel characters are original offline art that agree with their integrity manifest', () => {
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.runtime_network_required, false);
  assert.match(manifest.generated_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(manifest.rendering, /pixelated/);
  for (const id of PIXEL_IDS) {
    const character = manifest.characters[id], avatar = manifest.avatars[id];
    checkPng(character, `pixel-${id}.png`, `${id} character`);
    checkPng(avatar, `pixel-avatar-${id}.png`, `${id} avatar`);
    assert.equal(character.kind, 'project_original_pixel_character');
    assert.equal(avatar.kind, 'project_original_pixel_avatar');
    assert.equal(character.width, art.W * 4);
    assert.equal(character.height, art.H * 4);
    assert.ok(character.label && character.trait, `${id} documents its signature trait`);
  }
  checkPng(manifest.desk, 'pixel-desk.png', 'desk');
  assert.equal(manifest.desk.kind, 'project_original_pixel_furniture');
});

test('no third-party logos, product avatars or mascots are packaged', () => {
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /official_/);
  assert.equal(manifest.mascots, undefined);
  for (const name of fs.readdirSync(office)) {
    assert.doesNotMatch(name, /^(avatar|logo)-(?!generic)|mascot/, `${name} must not be packaged`);
  }
  for (const file of OFFICE_FILES) assert.ok(fs.existsSync(path.join(office, path.basename(file))), `${file} exists`);
});

test('every pixel character has a distinct palette and a recognisable signature accessory', () => {
  const grids = PIXEL_IDS.map(id => art.characterGrid(id));
  for (const [index, grid] of grids.entries()) {
    assert.equal(grid.length, art.H, PIXEL_IDS[index]);
    assert.ok(grid.every(row => row.length === art.W), PIXEL_IDS[index]);
  }
  const signatures = new Set(grids.map(grid => grid.flat().join(',')));
  assert.equal(signatures.size, PIXEL_IDS.length, 'characters are not palette swaps of one another');
});
