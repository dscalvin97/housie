// Generate PWA icons with zero dependencies: a tambola-ticket motif on a dark tile.
// Usage: node scripts/make-icons.js  (writes public/icons/*.png)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// ---- minimal PNG encoder (RGBA8) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- draw the motif ----
// Background: dark slate. Foreground: a cream ticket with a 3x3 grid, some cells gold.
function drawIcon(size, maskable = false) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const fill = (r, g, b) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, r, g, b); };
  const rect = (x0, y0, w, h, r, g, b) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, r, g, b);
  };

  fill(11, 17, 32); // #0b1120

  // maskable icons need the art inside a safe zone (~80%); scale the ticket accordingly
  const scale = maskable ? 0.62 : 0.78;
  const W = Math.round(size * scale);
  const H = Math.round(W * 0.62);
  const x0 = Math.round((size - W) / 2);
  const y0 = Math.round((size - H) / 2);

  // ticket body (cream)
  rect(x0, y0, W, H, 245, 237, 216);
  // 3x3 grid of cells with 3px-ish gutters
  const gut = Math.max(2, Math.round(size * 0.014));
  const cw = Math.floor((W - gut * 4) / 3);
  const ch = Math.floor((H - gut * 4) / 3);
  // gold cells forming a diagonal-ish "claimed" pattern
  const gold = [[0, 0], [1, 1], [2, 2], [2, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cx = x0 + gut + c * (cw + gut);
    const cy = y0 + gut + r * (ch + gut);
    if (gold.some(([gr, gc]) => gr === r && gc === c)) rect(cx, cy, cw, ch, 245, 184, 61);
    else rect(cx, cy, cw, ch, 226, 217, 192);
  }
  // gold accent bar along the bottom of the icon (brand stripe)
  if (!maskable) rect(0, Math.round(size * 0.88), size, Math.round(size * 0.12), 245, 184, 61);

  return encodePNG(size, px);
}

writeFileSync(new URL('icon-192.png', OUT), drawIcon(192));
writeFileSync(new URL('icon-512.png', OUT), drawIcon(512));
writeFileSync(new URL('maskable-512.png', OUT), drawIcon(512, true));
writeFileSync(new URL('apple-touch-icon.png', OUT), drawIcon(180));
console.log('icons written to public/icons/');
