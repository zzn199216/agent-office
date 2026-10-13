'use strict';
// Public office art shipped with every build. All character art is original pixel work
// generated from web/pixel-art.js by scripts/generate-pixel-art.cjs; no third-party
// product logos, avatars or mascots are distributed.
const PIXEL_IDS = Object.freeze(['deepseek', 'doubao', 'claude', 'codex', 'grok', 'gemini', 'kimi', 'qwen', 'cursor', 'generic']);
// Same-model colleagues get accessory colour variants 1..4 (variant 0 is the plain file).
const PIXEL_VARIANTS = 4, VARIANT_NUMBERS = Object.freeze([1, 2, 3, 4]);
const OFFICE_FILES = Object.freeze([
  ...['desk', 'plant', 'door', 'logo-generic'].map(name => `assets/office/${name}.svg`),
  ...PIXEL_IDS.map(id => `assets/office/pixel-${id}.png`),
  ...PIXEL_IDS.map(id => `assets/office/pixel-avatar-${id}.png`),
  ...PIXEL_IDS.flatMap(id => VARIANT_NUMBERS.flatMap(v => [`assets/office/pixel-${id}-v${v}.png`, `assets/office/pixel-avatar-${id}-v${v}.png`])),
  'assets/office/pixel-desk.png',
  ...['furniture-desk', 'furniture-beanbag', 'character-robot', 'prop-plant'].map(name => `assets/office/${name}.png`),
  'assets/office/AVATAR_SOURCES.json'
]);
module.exports = { PIXEL_IDS, PIXEL_VARIANTS, OFFICE_FILES };
