'use strict';
// Public office art shipped with every build. All character art is original pixel work
// generated from web/pixel-art.js by scripts/generate-pixel-art.cjs; no third-party
// product logos, avatars or mascots are distributed.
const PIXEL_IDS = Object.freeze(['deepseek', 'doubao', 'claude', 'codex', 'grok', 'gemini', 'kimi', 'qwen', 'cursor', 'generic']);
const OFFICE_FILES = Object.freeze([
  ...['desk', 'plant', 'door', 'logo-generic'].map(name => `assets/office/${name}.svg`),
  ...PIXEL_IDS.map(id => `assets/office/pixel-${id}.png`),
  ...PIXEL_IDS.map(id => `assets/office/pixel-avatar-${id}.png`),
  'assets/office/pixel-desk.png',
  ...['furniture-desk', 'furniture-beanbag', 'character-robot', 'prop-plant'].map(name => `assets/office/${name}.png`),
  'assets/office/AVATAR_SOURCES.json'
]);
module.exports = { PIXEL_IDS, OFFICE_FILES };
