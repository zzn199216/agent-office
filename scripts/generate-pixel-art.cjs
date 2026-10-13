#!/usr/bin/env node
'use strict';
// Renders the original pixel characters, avatars and desk from web/pixel-art.js into
// small PNG files and records their integrity in AVATAR_SOURCES.json.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const art = require('../web/pixel-art.js');
const { PIXEL_IDS } = require('../src/office-assets.cjs');
const OUT = path.join(__dirname, '..', 'web', 'assets', 'office');
const SCALE = 4;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, crc]); }
function png(grid, scale) {
  const h = grid.length * scale, w = grid[0].length * scale, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const color = grid[Math.floor(y / scale)][Math.floor(x / scale)], at = y * (w * 4 + 1) + 1 + x * 4;
      if (!color) continue;
      const n = parseInt(color.slice(1), 16); raw[at] = (n >> 16) & 255; raw[at + 1] = (n >> 8) & 255; raw[at + 2] = n & 255; raw[at + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function record(name, bytes) { return { asset: `/assets/office/${name}`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; }
function write(name, grid) { const bytes = png(grid, SCALE); fs.writeFileSync(path.join(OUT, name), bytes); return record(name, bytes); }
const avatarGrid = id => art.characterGrid(id).slice(0, 19).map(line => line.slice(1, 23));
const characters = {}, avatars = {};
for (const id of PIXEL_IDS) {
  const info = art.describeCharacter(id);
  characters[id] = { ...write(`pixel-${id}.png`, art.characterGrid(id)), label: info.label, trait: info.trait, kind: 'project_original_pixel_character' };
  avatars[id] = { ...write(`pixel-avatar-${id}.png`, avatarGrid(id)), label: info.label, kind: 'project_original_pixel_avatar' };
}
const desk = write('pixel-desk.png', art.deskGrid());
const manifestPath = path.join(OUT, 'AVATAR_SOURCES.json');
const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifest = {
  schema_version: 2,
  generated_on: new Date().toISOString().slice(0, 10),
  runtime_network_required: false,
  purpose: 'Original pixel characters that suggest each agent through color and a signature accessory. They are not product logos or official mascots and imply no endorsement.',
  rendering: 'Pixel art; display with image-rendering: pixelated. User-selected local images take priority.',
  license_note: 'All character, avatar and desk pixel art is original work of this project, generated from web/pixel-art.js. No third-party logos, avatars or mascots are distributed.',
  characters, avatars, desk: { ...desk, kind: 'project_original_pixel_furniture' },
  office_art: previous.office_art
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${PIXEL_IDS.length * 2 + 1} pixel assets.`);
