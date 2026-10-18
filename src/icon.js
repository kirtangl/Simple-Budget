'use strict';

// The app icon (the pie logo in public/icon.svg) as a PNG in any colours, for phones' home
// screens: iPhones don't use SVG icons, and a theme's colours can only reach the icon this way.

const zlib = require('node:zlib');

const SIZES = [180, 192, 512];
const DEFAULT = { bg: '#1f9e8a', fg: '#effffc' };
const HEX = /^#?([0-9a-f]{6})$/i;

// The ring's three slices, as parts of 100 going clockwise from the top (as in icon.svg).
const SLICES = [[0, 44], [50, 75], [81, 94]];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const rgb = (hex) => { const n = parseInt(hex, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
// A colour from a query string, or the default when it isn't a #rrggbb hex.
const colour = (value, fallback) => (HEX.exec(String(value || '')) || HEX.exec(fallback))[1];

// A square PNG: the logo's background fills it edge to edge (phones round the corners themselves),
// with the ring in the middle, anti-aliased by sampling each pixel 4 × 4 times.
function renderIcon(size, bgHex, fgHex) {
  const bg = rgb(colour(bgHex, DEFAULT.bg));
  const fg = rgb(colour(fgHex, DEFAULT.fg));
  const scale = size / 24;
  const inner = 4.7 * scale;
  const outer = 8.3 * scale;
  const mid = size / 2;
  const N = 4;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // no filter
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const dx = x + (sx + 0.5) / N - mid;
          const dy = y + (sy + 0.5) / N - mid;
          const r = Math.hypot(dx, dy);
          if (r < inner || r > outer) continue;
          const t = (((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) / 3.6;
          if (SLICES.some(([a, b]) => t >= a && t < b)) hits += 1;
        }
      }
      const f = hits / (N * N);
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(bg[c] + (fg[c] - bg[c]) * f);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // bits per channel
  head[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Made once per size and colours, since a phone may ask more than once.
const cache = new Map();
function iconPng(size, bg, fg) {
  const key = `${size}/${colour(bg, DEFAULT.bg)}/${colour(fg, DEFAULT.fg)}`;
  if (!cache.has(key)) {
    if (cache.size > 200) cache.clear();
    cache.set(key, renderIcon(size, bg, fg));
  }
  return cache.get(key);
}

// GET /app-icon.png?size=180&bg=0f766e&fg=ffffff and the manifest that points at it. Neither
// needs a login: a phone fetches them when the page is added to its home screen.
function iconRoutes(app) {
  app.get('/app-icon.png', (req, res) => {
    const size = Number(req.query.size) || 180;
    if (!SIZES.includes(size)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400').type('png').send(iconPng(size, req.query.bg, req.query.fg));
  });
  app.get('/manifest.webmanifest', (req, res) => {
    const bg = colour(req.query.bg, DEFAULT.bg);
    const fg = colour(req.query.fg, DEFAULT.fg);
    const icon = (size) => ({ src: `app-icon.png?size=${size}&bg=${bg}&fg=${fg}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' });
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'Simple Budget',
      short_name: 'Budget',
      start_url: './#/overview',
      display: 'standalone',
      background_color: '#f6f7f9',
      theme_color: `#${bg}`,
      icons: [icon(192), icon(512)],
    }));
  });
}

module.exports = { iconRoutes, renderIcon };
