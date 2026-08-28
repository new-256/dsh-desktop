'use strict';

/**
 * 鲸鱼娘应用图标生成器（纯 Node，无第三方依赖）。
 *
 * 在一张高分辨率(超采样)画布上用几何图元程序化绘制一个可爱的“鲸鱼娘”：
 * 圆角深海渐变底 + 鲸鱼尾 + 鲸鱼身体 + 白肚皮 + 笑脸 + 腮红 + 蝴蝶结 + 气泡/水滴。
 * 然后均值降采样到多个尺寸，写出 assets/icon.png（256）并打包成多分辨率 build/icon.ico。
 *
 * 运行: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SS = 4;                 // supersampling factor
const W = 256 * SS;
const H = 256 * SS;

// RGBA float buffer (straight alpha, 0..255)
const buf = new Float64Array(W * H * 4);

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  if (a <= 0) return;
  if (a >= 1) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; return; }
  const ia = buf[i + 3] / 255;
  const na = a + ia * (1 - a);
  if (na <= 0) return;
  buf[i]     = (r * a + buf[i]     * ia * (1 - a)) / na;
  buf[i + 1] = (g * a + buf[i + 1] * ia * (1 - a)) / na;
  buf[i + 2] = (b * a + buf[i + 2] * ia * (1 - a)) / na;
  buf[i + 3] = na * 255;
}

// A color is [r,g,b]. alpha 0..1
function fill(fn) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = fn(x, y);
      if (v) setPx(x, y, v[0], v[1], v[2], v[3]);
    }
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
function gradient(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// Signed distance helpers (coords in 256-space; scaled by SS internally)
function circleSDF(x, y, cx, cy, rad) {
  const dx = x - cx * SS, dy = y - cy * SS;
  return Math.hypot(dx, dy) / SS - rad;
}

function ellipseSDF(x, y, cx, cy, rx, ry) {
  const dx = (x - cx * SS) / SS, dy = (y - cy * SS) / SS;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) - 1; // <0 inside
}

// Rounded box SDF (256-space)
function roundRectSDF(x, y, x0, y0, x1, y1, rad) {
  const px = x / SS, py = y / SS;
  const qx = Math.max(Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - rad), 0);
  const qy = Math.max(Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - rad), 0);
  return Math.hypot(qx, qy) - rad; // <0 inside
}

function soft(d, edge) {
  // 1 inside, 0 outside, soft band of width `edge` (256-space)
  const t = -d / (edge * SS);
  return Math.max(0, Math.min(1, t + 0.5));
}

// Rotate point around center (256-space), returns 256-space coords
function rot(px, py, cx, cy, deg) {
  const a = (deg * Math.PI) / 180;
  const dx = px - cx, dy = py - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

// Draw an ellipse with optional rotation (in 256-space center/size)
function drawEllipse(cx, cy, rx, ry, rotDeg, color, alpha, edge = 1.2) {
  fill((x, y) => {
    let px = x / SS, py = y / SS;
    if (rotDeg) { [px, py] = rot(px, py, cx, cy, -rotDeg); }
    // Approximate signed distance to the ellipse boundary (256-space).
    const nx = (px - cx) / rx, ny = (py - cy) / ry;
    const d = (Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
    const a = alpha * clamp01(0.5 - d / edge);
    return a > 0.002 ? [color[0], color[1], color[2], a] : null;
  });
}

function drawCircle(cx, cy, rad, color, alpha, edge = 1.0) {
  fill((x, y) => {
    const d = circleSDF(x, y, cx, cy, rad);
    const aa = alpha * clamp01(0.5 - d / edge);
    return aa > 0.002 ? [color[0], color[1], color[2], aa] : null;
  });
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Rotated rounded rect (used for tail flukes / bow)
function drawPill(cx, cy, len, thick, rotDeg, color, alpha, edge = 1.2) {
  fill((x, y) => {
    let px = x / SS, py = y / SS;
    if (rotDeg) { [px, py] = rot(px, py, cx, cy, -rotDeg); }
    // capsule: distance to segment along x axis of length len
    const hx = len / 2;
    const dx = Math.max(Math.abs(px - cx) - (hx - thick / 2), 0);
    const dy = Math.abs(py - cy);
    const d = Math.hypot(dx, dy) - thick / 2;
    const aa = alpha * clamp01(0.5 - d / edge);
    return aa > 0.002 ? [color[0], color[1], color[2], aa] : null;
  });
}

function drawPolygon(points, color, alpha, edge = 1.2) {
  // point-in-polygon with slight softening via distance to edges
  fill((x, y) => {
    const px = x / SS, py = y / SS;
    let inside = false;
    let minD = Infinity;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi);
      if (intersect) inside = !inside;
      // distance to segment
      minD = Math.min(minD, segDist(px, py, xi, yi, xj, yj));
    }
    let a = inside ? alpha : alpha * clamp01(0.5 - minD / edge);
    return a > 0.002 ? [color[0], color[1], color[2], a] : null;
  });
}
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = clamp01(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy + 1e-9));
  const qx = x1 + t * dx, qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

// ----------------------------- Artwork ----------------------------------
const C = {
  bgTop: [38, 78, 168],
  bgBot: [10, 18, 46],
  body: [108, 178, 240],
  bodyDark: [74, 132, 210],
  belly: [236, 244, 255],
  tail: [96, 168, 236],
  outline: [30, 58, 110],
  eye: [24, 34, 58],
  blush: [255, 138, 170],
  bow: [255, 122, 166],
  bowDark: [226, 86, 138],
  bubble: [200, 228, 255],
  hi: [255, 255, 255]
};

// 1) Rounded-square background with vertical gradient
fill((x, y) => {
  const d = roundRectSDF(x, y, 0, 0, 256, 256, 56);
  const cover = clamp01(0.5 - d / (1.5 * SS));
  if (cover <= 0) return null;
  const t = y / H;
  const g = gradient(C.bgTop, C.bgBot, clamp01(t * 1.15 - 0.05));
  return [g[0], g[1], g[2], cover];
});

// soft radial glow top-center
fill((x, y) => {
  const d = circleSDF(x, y, 128, 60, 150);
  const a = 0.20 * clamp01(0.5 - d / (40 * SS));
  return a > 0.003 ? [150, 200, 255, a * 0] : null; // (subtle; mostly skip)
});

// 2) Bubbles
drawCircle(58, 70, 12, C.bubble, 0.5, 1.5);
drawCircle(44, 104, 7, C.bubble, 0.4, 1.2);
drawCircle(72, 120, 5, C.bubble, 0.35, 1.0);
drawCircle(206, 64, 9, C.bubble, 0.45, 1.3);
drawCircle(214, 100, 5, C.bubble, 0.35, 1.0);
// bubble highlights
drawCircle(54, 65, 3.5, C.hi, 0.8, 0.8);
drawCircle(203, 60, 2.6, C.hi, 0.8, 0.7);

// 3) Tail flukes (behind body), whale-girl whale tail rising at bottom
drawPill(104, 214, 78, 26, -38, C.tail, 1.0, 2.0);
drawPill(152, 214, 78, 26, 38, C.tail, 1.0, 2.0);
// tail notch center
drawCircle(128, 232, 20, C.bgBot, 0.9, 2.0);

// 4) Body — big rounded whale head/body
drawEllipse(128, 140, 74, 66, 0, C.body, 1.0, 2.0);
// body shading bottom
drawEllipse(128, 172, 66, 40, 0, C.bodyDark, 0.55, 2.0);
// belly patch
drawEllipse(128, 158, 46, 40, 0, C.belly, 0.95, 2.0);

// 5) Pectoral fin
drawPill(88, 176, 46, 18, 28, C.bodyDark, 0.95, 1.6);

// 6) Face: eyes
drawEllipse(104, 132, 9, 12, 0, C.eye, 1.0, 1.0);
drawEllipse(152, 132, 9, 12, 0, C.eye, 1.0, 1.0);
// eye sparkles
drawCircle(107, 127, 3.2, C.hi, 1.0, 0.7);
drawCircle(155, 127, 3.2, C.hi, 1.0, 0.7);
drawCircle(101, 136, 1.8, C.hi, 0.8, 0.5);
drawCircle(149, 136, 1.8, C.hi, 0.8, 0.5);

// blush
drawEllipse(86, 150, 11, 7, 0, C.blush, 0.75, 1.4);
drawEllipse(170, 150, 11, 7, 0, C.blush, 0.75, 1.4);

// smile (arc approximated by small dark capsules)
drawPill(128, 156, 20, 4.5, 0, C.eye, 0.0, 0.8); // (hidden; arc below)
for (let i = 0; i <= 8; i++) {
  const t = i / 8;
  const ang = Math.PI * (0.15 + 0.7 * t);
  const sx = 128 - Math.cos(ang) * 16;
  const sy = 152 + Math.sin(ang) * 12;
  drawCircle(sx, sy, 2.4, C.eye, 0.9, 0.7);
}

// 7) Bow on top (whale-chan accessory)
drawPill(116, 76, 30, 20, -24, C.bow, 1.0, 1.6);
drawPill(140, 76, 30, 20, 24, C.bow, 1.0, 1.6);
drawCircle(128, 78, 9, C.bowDark, 1.0, 1.2);
drawCircle(125, 75, 2.6, C.hi, 0.7, 0.6);

// 8) Water droplet accent near bow
drawPolygon([[196, 96], [206, 112], [196, 124], [186, 112]], C.bubble, 0.7, 1.4);
drawCircle(194, 108, 2.4, C.hi, 0.7, 0.6);

// --------------------------- Downsample & encode ------------------------
function downsample(size) {
  const out = Buffer.alloc(size * size * 4);
  const step = W / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(x * step), y0 = Math.floor(y * step);
      const x1 = Math.floor((x + 1) * step), y1 = Math.floor((y + 1) * step);
      let n = 0;
      // Average every supersampled texel in the block (proper SSAA).
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * W + sx) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3]; n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_T = crcTable();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // raw scanlines with filter 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeICO(entries) {
  // entries: [{ size, png:Buffer }]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  const images = [];
  entries.forEach((e, idx) => {
    const b = 16 * idx;
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir[b + 2] = 0; dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4);    // planes
    dir.writeUInt16LE(32, b + 6);   // bpp
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
    images.push(e.png);
  });
  return Buffer.concat([header, dir, ...images]);
}

// ------------------------------- Output ---------------------------------
const sizes = [16, 24, 32, 48, 64, 128, 256];
const assetsDir = path.join(__dirname, '..', 'assets');
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

const pngs = sizes.map((s) => ({ size: s, png: encodePNG(downsample(s), s) }));

// Main PNG used by the app window/splash
fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngs.find((p) => p.size === 256).png);
// Multi-resolution .ico for the executable / installer
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeICO(pngs));
// Also keep a 512 source png for convenience
fs.writeFileSync(path.join(buildDir, 'icon-256.png'), pngs.find((p) => p.size === 256).png);

console.log('[make-icon] wrote assets/icon.png and build/icon.ico (' + sizes.join(', ') + ' px)');
