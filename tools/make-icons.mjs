/**
 * Icon generator: writes assets/icons/icon{16,32,48,128}.png with zero
 * dependencies (own PNG encoder + tiny rasteriser).
 *
 * Run: npm run icons
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor for anti-aliasing

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Encodes raw RGBA pixels (Uint8Array, w*h*4) into a PNG buffer. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- rasteriser -- */

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

function insideTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const ACCENT_A = [109, 94, 252];
const ACCENT_B = [155, 140, 255];
const WHITE = [255, 255, 255];

/** Renders one icon at the given size, returns an RGBA buffer. */
function renderIcon(size) {
  const W = size * SS;
  const H = size * SS;
  const r = new Float32Array(W * H * 4); // premultiplied colour accumulation

  const pad = W * 0.06;
  const x0 = pad;
  const y0 = pad;
  const x1 = W - pad;
  const y1 = H - pad;
  const radius = Math.max(2, W * 0.22);

  // Background: rounded square with a diagonal gradient.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!insideRoundedRect(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)) continue;
      const t = ((x - x0) / Math.max(1, x1 - x0) + (y - y0) / Math.max(1, y1 - y0)) / 2;
      const [cr, cg, cb] = mix(ACCENT_A, ACCENT_B, Math.min(1, Math.max(0, t)));
      const idx = (y * W + x) * 4;
      r[idx] = cr;
      r[idx + 1] = cg;
      r[idx + 2] = cb;
      r[idx + 3] = 1;
    }
  }

  // Glyph: play triangle + three "text" bars (a video becoming a summary).
  const triTop = H * 0.3;
  const triBottom = H * 0.7;
  const triLeft = W * 0.26;
  const triRight = W * 0.46;
  const a = [triLeft, triTop];
  const b = [triLeft, triBottom];
  const c = [triRight, (triTop + triBottom) / 2];

  const barX0 = W * 0.56;
  const barX1 = W * 0.79;
  const barH = Math.max(1.5, H * 0.075);
  const bars = [
    [H * 0.3, H * 0.3 + barH],
    [H * 0.4625, H * 0.4625 + barH],
    [H * 0.625, H * 0.625 + barH],
  ];
  const barRadius = barH / 2;
  const bar3X1 = W * 0.68;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let covered = insideTriangle(px, py, a, b, c);
      if (!covered) {
        bars.forEach((bar, i) => {
          if (!covered && insideRoundedRect(px, py, barX0, bar[0], i === 2 ? bar3X1 : barX1, bar[1], barRadius)) covered = true;
        });
      }
      if (!covered) continue;
      const idx = (y * W + x) * 4;
      const alpha = 1;
      // White glyph composited over whatever is underneath.
      const bgA = r[idx + 3];
      const out = [WHITE[0] * alpha + r[idx] * (1 - alpha), WHITE[1] * alpha + r[idx + 1] * (1 - alpha), WHITE[2] * alpha + r[idx + 2] * (1 - alpha)];
      void bgA;
      r[idx] = out[0];
      r[idx + 1] = out[1];
      r[idx + 2] = out[2];
      r[idx + 3] = Math.min(1, Math.max(r[idx + 3], alpha));
    }
  }

  // Downsample (box filter) into 8-bit RGBA.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          rSum += r[idx];
          gSum += r[idx + 1];
          bSum += r[idx + 2];
          aSum += r[idx + 3];
        }
      }
      const n = SS * SS;
      const alpha = aSum / n;
      const idx = (y * size + x) * 4;
      // Un-premultiply so transparent corners stay clean.
      out[idx] = alpha > 0 ? Math.round(Math.min(255, rSum / n / Math.max(alpha, 1e-6))) : 0;
      out[idx + 1] = alpha > 0 ? Math.round(Math.min(255, gSum / n / Math.max(alpha, 1e-6))) : 0;
      out[idx + 2] = alpha > 0 ? Math.round(Math.min(255, bSum / n / Math.max(alpha, 1e-6))) : 0;
      out[idx + 3] = Math.round(Math.min(255, alpha * 255));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ main --- */

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const rgba = renderIcon(size);
  const png = encodePng(size, size, rgba);
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, png);
  console.log(`icon${size}.png — ${png.length} bytes`);
}
console.log(`Icons written to ${OUT_DIR}`);
