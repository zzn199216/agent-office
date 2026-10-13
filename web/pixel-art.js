/* Agent Office pixel art: original chibi characters, avatars and furniture generated at runtime. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentPixelArt = Object.freeze({ character: api.characterDataUrl, avatar: api.avatarDataUrl, desk: api.deskDataUrl, providers: api.PROVIDERS, grid: api.characterGrid });
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const W = 24, H = 30;
  const SHARED = { s: '#FFE4D3', S: '#F2C2AC', e: '#2A1E3A', w: '#FFFFFF', b: '#FF9AA6', m: '#8A3E3A', r: '#F0767C', y: '#F6CF5A', x: '#BFE3FF' };
  const FRINGE = {
    soft: [9, 9, 8, 9, 8, 7, 7, 8, 9, 8, 9, 9],
    straight: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9],
    spiky: [9, 8, 9, 7, 9, 8, 7, 9, 8, 9, 8, 9],
    parted: [9, 9, 8, 8, 7, 6, 6, 7, 8, 8, 9, 9],
    swept: [9, 9, 9, 9, 8, 8, 8, 7, 7, 7, 8, 9]
  };
  const FACE = { 7: [7, 16], 15: [7, 16], 16: [8, 15] };
  function blank() { return Array.from({ length: H }, () => Array(W).fill('.')); }
  function inside(r, c) { return r >= 0 && r < H && c >= 0 && c < W; }
  function put(g, r, c, text) { for (let i = 0; i < text.length; i++) if (text[i] !== '.' && inside(r, c + i)) g[r][c + i] = text[i]; }
  function row(g, r, c0, c1, key) { for (let c = c0; c <= c1; c++) if (inside(r, c)) g[r][c] = key; }
  function col(g, c, r0, r1, key) { for (let r = r0; r <= r1; r++) if (inside(r, c)) g[r][c] = key; }
  function backHair(g, end, long) {
    row(g, 5, 7, 16, 'h'); row(g, 6, 5, 18, 'h');
    for (let r = 7; r <= end; r++) row(g, r, long && r > 9 ? 3 : 4, long && r > 9 ? 20 : 19, r > end - 2 ? 'H' : 'h');
  }
  function body(g, cut) {
    row(g, 17, 10, 13, 'S'); row(g, 18, 7, 16, 'c');
    for (let r = 19; r < H; r++) { row(g, r, 5, 18, 'c'); g[r][5] = 'C'; g[r][18] = 'C'; }
    row(g, H - 1, 5, 18, 'C');
    if (cut !== false) { col(g, 4, 21, 27, 'c'); col(g, 19, 21, 27, 'c'); }
  }
  function face(g) { for (let r = 7; r <= 16; r++) { const span = FACE[r] || [6, 17]; row(g, r, span[0], span[1], 's'); } }
  function frontHair(g, fringe, side, long) {
    row(g, 4, 8, 15, 'h'); row(g, 5, 6, 17, 'h'); row(g, 6, 5, 18, 'h'); row(g, 7, 5, 18, 'h');
    for (let c = 6; c <= 17; c++) { const end = fringe[c - 6]; for (let r = 8; r <= end; r++) g[r][c] = r === end ? 'H' : 'h'; }
    col(g, 5, 8, side, 'h'); col(g, 18, 8, side, 'h'); g[side][5] = 'H'; g[side][18] = 'H';
    if (long) { col(g, 4, 8, side + 2, 'h'); col(g, 19, 8, side + 2, 'h'); }
    put(g, 5, 8, 'lll'); put(g, 6, 7, 'l');
  }
  const EYES = {
    normal: [[10, 'ee'], [11, 'wi'], [12, 'ii']],
    sparkle: [[10, 'ee'], [11, 'ww'], [12, 'ii']],
    sleepy: [[11, 'ee']],
    none: []
  };
  function eyes(g, kind) {
    if (kind === 'happy') { put(g, 10, 8, 'e'); put(g, 11, 7, 'e.e'); put(g, 10, 15, 'e'); put(g, 11, 14, 'e.e'); }
    else if (kind === 'wink') { put(g, 10, 7, 'ee'); put(g, 11, 9, 'e'); put(g, 12, 7, 'ee'); for (const [r, t] of EYES.normal) put(g, r, 14, t); }
    else { for (const [r, t] of EYES[kind]) { put(g, r, 8, t); put(g, r, 14, t); } if (kind === 'normal' || kind === 'sparkle') { g[10][7] = 'e'; g[10][16] = 'e'; } }
    put(g, 13, 7, 'b'); put(g, 13, 16, 'b');
  }
  const MOUTH = { small: [[14, 11, 'mm']], open: [[14, 10, 'mmmm'], [15, 11, 'rr']], yawn: [[13, 11, 'mm'], [14, 11, 'mm']], smirk: [[14, 10, 'mmm'], [13, 13, 'm']], flat: [[14, 10, 'mmmm']] };
  function mouth(g, kind) { for (const [r, c, t] of MOUTH[kind]) put(g, r, c, t); }
  const CHARACTERS = {
    deepseek: {
      label: 'DeepSeek', trait: '鲸鱼帽 · 服务器繁忙', back: 15, side: 13, fringe: 'soft', eyes: 'sleepy', mouth: 'yawn',
      pal: { h: '#1F2A55', H: '#141C3D', l: '#3B4E95', k: '#4D6BFE', K: '#DDE6FF', c: '#4D6BFE', C: '#3A55D6', a: '#FFFFFF' },
      accent: { k: 'main' },
      over(g) {
        row(g, 1, 8, 17, 'k'); row(g, 2, 6, 19, 'k'); row(g, 3, 5, 20, 'k'); for (let r = 4; r <= 6; r++) row(g, r, 4, 20, 'k'); row(g, 7, 4, 20, 'K');
        put(g, 3, 17, 'w'); put(g, 4, 17, 'e'); put(g, 5, 19, 'b');
        put(g, 0, 1, 'kk'); put(g, 1, 2, 'kkk'); put(g, 2, 3, 'kk'); put(g, 3, 4, 'k');
        put(g, 0, 10, 'x.x'); put(g, 1, 11, 'x');
        [19, 20, 21].forEach(r => { g[r][10] = 'a'; g[r][13] = 'a'; }); put(g, 9, 18, 'x'); put(g, 10, 18, 'x');
      }
    },
    doubao: {
      label: '豆包', trait: '包子帽 + 红围巾 · 这个我熟', back: 22, side: 15, fringe: 'parted', eyes: 'sparkle', mouth: 'open', long: true,
      pal: { h: '#7A4A33', H: '#5A3424', l: '#A86E50', k: '#FFF6E8', K: '#D4B88A', c: '#FF8A3D', C: '#E06A20', a: '#FFF4E4', f: '#E5484D', F: '#B8323A' },
      accent: { f: 'main', F: 'dark' },
      over(g) {
        row(g, 0, 9, 14, 'k'); row(g, 1, 7, 16, 'k'); row(g, 2, 6, 17, 'k'); for (let r = 3; r <= 5; r++) row(g, r, 5, 18, 'k'); row(g, 6, 6, 17, 'K');
        put(g, 0, 11, 'KK'); put(g, 1, 10, 'K..K'); put(g, 2, 9, 'K....K'); put(g, 3, 8, 'K......K'); put(g, 1, 8, 'w'); put(g, 2, 7, 'w');
        row(g, 17, 8, 15, 'f'); row(g, 18, 7, 16, 'f'); row(g, 19, 8, 15, 'F'); put(g, 20, 13, 'ff'); put(g, 21, 13, 'fF'); put(g, 22, 14, 'F'); put(g, 13, 7, 'bb'); put(g, 13, 15, 'bb');
      }
    },
    claude: {
      label: 'Claude', trait: '陶土色贝雷帽 · 先确认需求', back: 22, side: 15, fringe: 'swept', eyes: 'happy', mouth: 'small', long: true,
      pal: { h: '#8E4A30', H: '#6A3420', l: '#B86A4A', k: '#D97757', K: '#B85E40', c: '#D97757', C: '#B85E40', a: '#F3E3C3', A: '#D9C49C' },
      accent: { a: 'light', A: 'main' },
      over(g) {
        row(g, 2, 9, 16, 'k'); row(g, 3, 7, 18, 'k'); row(g, 4, 6, 19, 'k'); row(g, 5, 6, 18, 'K'); put(g, 1, 13, 'k'); put(g, 3, 9, 'w');
        row(g, 18, 7, 16, 'a'); row(g, 19, 7, 16, 'A'); put(g, 20, 8, 'aa'); put(g, 21, 8, 'aa');
        for (let r = 14; r <= 26; r++) put(g, r, 19, r % 2 ? 'hH' : 'Hh'); put(g, 27, 19, 'aa');
      }
    },
    codex: {
      label: 'Codex', trait: '终端护目镜 · 测试又跑了一遍', back: 12, side: 12, fringe: 'spiky', eyes: 'none', mouth: 'flat',
      pal: { h: '#1E2126', H: '#111317', l: '#3A3F47', q: '#0E1014', G: '#1FB878', z: '#B6FFD9', c: '#2A2E35', C: '#1C1F24', a: '#9AA3AE' },
      accent: { G: 'main', z: 'light' },
      over(g) {
        row(g, 10, 6, 17, 'q'); row(g, 11, 6, 17, 'q'); row(g, 12, 6, 17, 'q'); row(g, 11, 7, 16, 'G');
        put(g, 11, 8, 'zz'); put(g, 11, 14, 'zz'); put(g, 10, 7, 'w');
        put(g, 22, 8, 'z'); put(g, 23, 9, 'z'); put(g, 24, 8, 'z.zzz'); [19, 20].forEach(r => { g[r][10] = 'a'; g[r][13] = 'a'; });
        put(g, 3, 14, 'h'); put(g, 2, 15, 'h');
      }
    },
    grok: {
      label: 'Grok', trait: '墨镜坏笑 · 就这题？', back: 12, side: 12, fringe: 'spiky', eyes: 'none', mouth: 'smirk',
      pal: { h: '#E4E7EC', H: '#A9B0BC', l: '#FFFFFF', q: '#141519', n: '#5B6472', c: '#1C1E22', C: '#0E0F12', a: '#F08A4B' },
      accent: { a: 'main', n: 'dark' },
      over(g) {
        row(g, 10, 6, 17, 'q'); put(g, 11, 7, 'qqqq'); put(g, 11, 13, 'qqqq'); put(g, 12, 8, 'qq'); put(g, 12, 14, 'qq'); put(g, 11, 8, 'n'); put(g, 11, 14, 'n');
        col(g, 9, 4, 7, 'q'); put(g, 3, 8, 'h'); put(g, 2, 9, 'h'); put(g, 3, 15, 'h');
        row(g, 18, 10, 13, 'a'); put(g, 19, 11, 'aa');
      }
    },
    gemini: {
      label: 'Gemini', trait: '双子双马尾 · 图文视频都懂', back: 15, side: 14, fringe: 'soft', eyes: 'sparkle', mouth: 'small', hetero: true,
      pal: { h: '#5B7CF0', H: '#4258C8', l: '#A9BBFA', p: '#A06BE8', P: '#7C4CC4', i: '#3B6CF0', v: '#9B5CE6', c: '#FAFAFC', C: '#DADAE6', a: '#5B7CF0', t: '#A06BE8' },
      accent: { a: 'main', t: 'dark', y: 'light' },
      under(g) { for (let r = 5; r <= 24; r++) { const k = r > 13 ? (r > 22 ? 'P' : 'p') : 'h'; row(g, r, r < 7 || r > 22 ? 1 : 0, 3, k); row(g, r, 20, r < 7 || r > 22 ? 22 : 23, k); } },
      over(g) {
        put(g, 3, 4, '.w.'); put(g, 4, 4, 'wyw'); put(g, 5, 4, '.w.'); put(g, 3, 17, '.w.'); put(g, 4, 17, 'wyw'); put(g, 5, 17, '.w.');
        row(g, 18, 7, 9, 'a'); row(g, 18, 14, 16, 'a'); put(g, 19, 7, 'aa'); put(g, 19, 15, 'aa'); put(g, 19, 10, 'tttt'); put(g, 20, 11, 'tt');
      }
    },
    kimi: {
      label: 'Kimi', trait: '弯月发饰 · 二十万字读完了', back: 22, side: 17, fringe: 'straight', eyes: 'normal', mouth: 'small', long: true,
      pal: { h: '#2E3266', H: '#1E2148', l: '#4F56A0', i: '#E0A93B', c: '#2B2F5E', C: '#1E2148', a: '#FFFFFF' },
      accent: { y: 'main' },
      over(g) {
        put(g, 0, 16, 'yy'); put(g, 1, 17, 'yy'); put(g, 2, 18, 'yy'); put(g, 3, 18, 'yy'); put(g, 4, 18, 'yy'); put(g, 5, 17, 'yy'); put(g, 6, 16, 'yy'); put(g, 1, 13, 'y');
        put(g, 18, 9, 'a....a'); put(g, 19, 10, 'a..a'); put(g, 21, 15, 'y');
      }
    },
    qwen: {
      label: '千问', trait: '问号呆毛 · 再问一个', back: 15, side: 14, fringe: 'straight', eyes: 'normal', mouth: 'small',
      pal: { h: '#7B5CE0', H: '#5A3EC0', l: '#A890F5', i: '#6A4FD0', c: '#C9B8FF', C: '#A58FEA', a: '#FFFFFF', Q: '#7B5CE0' },
      accent: { Q: 'main', a: 'light' },
      over(g) { put(g, 0, 14, 'QQQ'); put(g, 1, 13, 'Q'); put(g, 1, 17, 'Q'); put(g, 2, 17, 'Q'); put(g, 3, 16, 'Q'); put(g, 4, 16, 'Q'); put(g, 18, 9, 'aa..aa'); col(g, 11, 20, 26, 'C'); }
    },
    cursor: {
      label: 'Cursor', trait: '光标发卡 · 按 Tab 补全', back: 15, side: 14, fringe: 'straight', eyes: 'normal', mouth: 'small',
      pal: { h: '#26282C', H: '#16171A', l: '#4A4E56', i: '#2EC4B6', c: '#F2F3F5', C: '#D6D9DE', a: '#26282C', P: '#FFFFFF' },
      accent: { P: 'light' },
      over(g) { put(g, 1, 16, 'P'); put(g, 2, 16, 'PP'); put(g, 3, 16, 'PPP'); put(g, 4, 16, 'PPPP'); put(g, 5, 16, 'PPPPP'); put(g, 6, 16, 'PP.P'); put(g, 7, 16, 'P'); put(g, 7, 18, 'PP'); [19, 20, 21].forEach(r => { g[r][10] = 'a'; g[r][13] = 'a'; }); }
    },
    generic: {
      label: 'Agent', trait: '通用小机器人', robot: true,
      pal: { k: '#E8ECF2', K: '#C3CBD6', q: '#2B2F3A', z: '#6FE3FF', c: '#C9D1DC', C: '#A9B3C2' },
      accent: { z: 'light', y: 'main' }
    }
  };
  const PROVIDERS = Object.freeze(Object.keys(CHARACTERS));
  // Same-model colleagues share a character and differ by the colour of its signature accessory.
  // Variant 0 is the original; 1-4 cycle through red, blue, yellow and green, skipping a colour
  // that would look like the original accessory.
  const ACCENTS = Object.freeze([
    { name: '红', main: '#E5484D', dark: '#B8323A', light: '#FFB3B5' },
    { name: '蓝', main: '#3B82F6', dark: '#2459C2', light: '#B5D3FF' },
    { name: '黄', main: '#F5C542', dark: '#C9971C', light: '#FFF0B3' },
    { name: '绿', main: '#34B36B', dark: '#1F8549', light: '#B8F0CF' },
    { name: '粉', main: '#EC6FB0', dark: '#BF4787', light: '#FFC9E6' },
    { name: '紫', main: '#8B5CF6', dark: '#6440C9', light: '#D6C6FF' }
  ]);
  const VARIANTS = 4;
  function hue(hex) { const [r, g, b] = hexToRgb(hex).map(v => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; if (!d) return null; const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; }
  function accentChoices(id) {
    const ch = CHARACTERS[id] || CHARACTERS.generic, roles = ch.accent || {}, pal = Object.assign({}, SHARED, ch.pal);
    const mainKey = Object.keys(roles).find(key => roles[key] === 'main') || Object.keys(roles)[0], own = mainKey && hue(pal[mainKey]);
    const far = ACCENTS.filter(a => own === null || own === undefined || Math.min(Math.abs(hue(a.main) - own), 360 - Math.abs(hue(a.main) - own)) > 28);
    return far.slice(0, VARIANTS);
  }
  function accentName(id, variant) { const v = Number(variant) || 0; return v ? accentChoices(id)[(v - 1) % VARIANTS].name : '原色'; }
  function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function shade(hex, f) { const [r, g, b] = hexToRgb(hex); return '#' + ((1 << 24) | (Math.round(r * f) << 16) | (Math.round(g * f) << 8) | Math.round(b * f)).toString(16).slice(1); }
  function robot(g) {
    put(g, 0, 11, 'yy'); col(g, 11, 1, 3, 'K'); col(g, 12, 1, 3, 'K');
    for (let r = 4; r <= 15; r++) row(g, r, 5, 18, r === 15 ? 'K' : 'k');
    for (let r = 7; r <= 12; r++) row(g, r, 7, 16, 'q');
    put(g, 9, 9, 'z'); put(g, 9, 14, 'z'); put(g, 10, 9, 'z'); put(g, 10, 14, 'z'); put(g, 11, 11, 'zz');
    row(g, 16, 10, 13, 'K'); body(g); for (let r = 20; r <= 23; r++) row(g, r, 10, 13, 'K');
  }
  function characterGrid(id, variant) {
    const ch = CHARACTERS[id] || CHARACTERS.generic, g = blank();
    if (ch.robot) robot(g);
    else {
      if (ch.under) ch.under(g);
      backHair(g, ch.back, ch.long); body(g); face(g); frontHair(g, FRINGE[ch.fringe], ch.side, ch.long);
      eyes(g, ch.eyes); mouth(g, ch.mouth);
      if (ch.hetero) { g[11][15] = 'v'; g[12][14] = 'v'; g[12][15] = 'v'; }
      if (ch.over) ch.over(g);
      for (let r = H - 1; r > 0; r--) for (let c = 0; c < W; c++) if (g[r][c] === 's' && 'hHlkK'.includes(g[r - 1][c])) g[r][c] = 'S';
    }
    const pal = Object.assign({ i: '#5A6B8C' }, SHARED, ch.pal), v = Number(variant) || 0;
    if (v > 0) { const accent = accentChoices(CHARACTERS[id] ? id : 'generic')[(v - 1) % VARIANTS]; for (const [key, role] of Object.entries(ch.accent || {})) pal[key] = accent[role]; }
    const colors = g.map(line => line.map(key => (key === '.' ? null : pal[key] || null)));
    const out = colors.map(line => line.slice());
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (!colors[r][c]) {
      const near = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].find(([a, b]) => inside(a, b) && colors[a][b]);
      if (near) out[r][c] = shade(colors[near[0]][near[1]], 0.4);
    }
    return out;
  }
  const DESK_W = 44, DESK_H = 22;
  function deskGrid() {
    const g = Array.from({ length: DESK_H }, () => Array(DESK_W).fill(null));
    const rect = (r0, c0, h, w, f) => { for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && r < DESK_H && c >= 0 && c < DESK_W) g[r][c] = f; };
    rect(0, 29, 9, 13, '#2A1E3A'); rect(1, 30, 7, 11, '#C9CED6'); rect(1, 30, 1, 11, '#E4E8EC'); rect(9, 34, 2, 3, '#8E949C');
    rect(10, 0, 12, 44, '#2A1E3A'); rect(11, 1, 3, 42, '#E2B07A'); rect(11, 1, 1, 42, '#F2CC98'); rect(14, 1, 7, 42, '#B57A45'); rect(20, 1, 1, 42, '#93602F');
    rect(16, 19, 1, 6, '#2A1E3A'); rect(11, 10, 2, 14, '#F4F5F7'); rect(13, 10, 1, 14, '#C9CED6');
    return g;
  }
  const cache = new Map();
  function toDataUrl(grid, scale) {
    if (typeof document === 'undefined') return '';
    const canvas = document.createElement('canvas'); canvas.width = grid[0].length * scale; canvas.height = grid.length * scale;
    const ctx = canvas.getContext('2d'); if (!ctx) return '';
    grid.forEach((line, r) => line.forEach((f, c) => { if (f) { ctx.fillStyle = f; ctx.fillRect(c * scale, r * scale, scale, scale); } }));
    return canvas.toDataURL('image/png');
  }
  function memo(key, make) { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); }
  function characterDataUrl(id) { const key = CHARACTERS[id] ? id : 'generic'; return memo(`c:${key}`, () => toDataUrl(characterGrid(key), 6)); }
  function avatarDataUrl(id) { const key = CHARACTERS[id] ? id : 'generic'; return memo(`a:${key}`, () => toDataUrl(characterGrid(key).slice(0, 19).map(line => line.slice(1, 23)), 4)); }
  function deskDataUrl() { return memo('desk', () => toDataUrl(deskGrid(), 6)); }
  function describeCharacter(id) { const ch = CHARACTERS[id] || CHARACTERS.generic; return { label: ch.label, trait: ch.trait }; }
  return { PROVIDERS, VARIANTS, accentChoices, accentName, characterGrid, deskGrid, characterDataUrl, avatarDataUrl, deskDataUrl, describeCharacter, W, H };
});
