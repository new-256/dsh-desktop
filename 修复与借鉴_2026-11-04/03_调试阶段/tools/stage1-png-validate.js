'use strict';

/**
 * stage1-png-validate —— 截图「读回校验」：证明这张图真的存在、真的是 PNG、真的不是白板。
 *
 * 为什么需要：本仓库出过两次证据问题 ——
 *   ① 用全桌面截屏，抓到的是前台别人的窗口（文件名却叫"首帧"）；
 *   ② 只落了 .json、PNG 在失败分支被删掉，等于"有元数据没图"，同样不能当证据。
 * 所以"图存在"这件事必须被机械验证，而不是靠人 `Get-ChildItem` 看一眼。
 *
 * 校验项（任一条不过即 exit 1，并打印实际值）：
 *   1) 文件存在且字节数 > minBytes（默认 10 KB；稀疏首屏 30–40 KB 是正常的，50 KB 这个阈值会误杀）；
 *   2) PNG magic = 89 50 4E 47 0D 0A 1A 0A；
 *   3) 解析 IHDR 得到宽高，必须与期望尺寸一致（允许 --expect-w / --expect-h 显式给出，
 *      否则从同名 .json 的 viewport 推，并按整数倍 DPR 容错）；
 *   4) 解码像素（zlib inflate + unfilter，支持 8 位 RGB/RGBA/灰度、非隔行），统计
 *      唯一颜色数与灰度标准差 —— **接近单色即判定为空白图**（白屏/黑屏）。
 *
 * 用法：
 *   node stage1-png-validate.js <png> [--json <元数据 json>] [--min-bytes 10240]
 *        [--expect-w N --expect-h N] [--min-unique 50] [--out <结果 json>]
 *   退出码：0=通过；1=不通过；2=用法/读取错误。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function main() {
  const args = process.argv.slice(2);
  const o = { png: null, json: null, minBytes: 10240, expectW: null, expectH: null, minUnique: 50, out: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = args[++i];
    else if (a === '--min-bytes') o.minBytes = Number(args[++i]);
    else if (a === '--expect-w') o.expectW = Number(args[++i]);
    else if (a === '--expect-h') o.expectH = Number(args[++i]);
    else if (a === '--min-unique') o.minUnique = Number(args[++i]);
    else if (a === '--out') o.out = args[++i];
    else if (!a.startsWith('--')) o.png = a;
  }
  if (!o.png) { console.error('用法：node stage1-png-validate.js <png> [--json <meta>]'); process.exit(2); }

  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); console.log(`  ${ok ? '✔' : '✖'} ${name}${detail !== undefined && detail !== '' ? '  —— ' + detail : ''}`); };

  console.log('');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('  截图读回校验（存在 / magic / 尺寸 / 非空白）');
  console.log(`  文件：${path.resolve(o.png)}`);
  console.log('════════════════════════════════════════════════════════════════════');

  const exists = fs.existsSync(o.png);
  check('文件存在', exists, exists ? null : '文件不存在（"有 json 没图"不得当证据）');
  if (!exists) return finish(o, checks);

  const buf = fs.readFileSync(o.png);
  check('字节数 > ' + o.minBytes, buf.length > o.minBytes, `${buf.length} 字节`);
  const magicOk = buf.length >= 8 && buf.slice(0, 8).equals(PNG_MAGIC);
  check('PNG magic 正确', magicOk, magicOk ? '89 50 4E 47 0D 0A 1A 0A' : '前 8 字节不是 PNG 签名');
  if (!magicOk) return finish(o, checks);

  // IHDR
  if (buf.length < 33 || buf.toString('ascii', 12, 16) !== 'IHDR') { check('存在 IHDR 块', false); return finish(o, checks); }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  check('IHDR 可解析', width > 0 && height > 0, `${width}×${height} bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);

  // 尺寸对账
  let meta = null;
  if (o.json && fs.existsSync(o.json)) {
    try { meta = JSON.parse(fs.readFileSync(o.json, 'utf8')); } catch { meta = null; }
  }
  const vpW = o.expectW || (meta && meta.viewport && meta.viewport.width) || null;
  const vpH = o.expectH || (meta && meta.viewport && meta.viewport.height) || null;
  if (vpW && vpH) {
    // 允许 DPR 缩放：本机 DPR=1.5 时 viewport 1426×884 会截成 2139×1326。
    // 所以判定不能用整除（2139 % 1426 ≠ 0），而要比**缩放比一致**。
    const rw = width / vpW;
    const rh = height / vpH;
    const ratioOk = Math.abs(rw - rh) <= 0.02 && rw >= 0.99 && rw <= 3.01;
    check('尺寸与元数据 viewport 成等比缩放（DPR）', ratioOk,
      `图 ${width}×${height} vs viewport ${vpW}×${vpH} → 缩放 ${rw.toFixed(3)}×/${rh.toFixed(3)}×`);
  } else {
    check('尺寸对账（未提供期望尺寸，跳过）', true, `${width}×${height}`);
  }

  // 像素解码 + 空白判定
  let stats = null;
  try {
    stats = decodeAndStats(buf, width, height, bitDepth, colorType, interlace);
    check('像素可解码（非隔行 8 位）', true, `${stats.channels} 通道，采样 ${stats.sampled} 像素`);
  } catch (err) {
    check('像素可解码（非隔行 8 位）', false, err.message);
  }
  if (stats) {
    check(`唯一颜色数 >= ${o.minUnique}（排除白板/黑板）`, stats.uniqueColors >= o.minUnique, `${stats.uniqueColors} 种`);
    check('灰度标准差 > 3（有实际内容）', stats.stddev > 3, `stddev=${stats.stddev.toFixed(2)}，均值=${stats.mean.toFixed(1)}`);
    check('非近纯色背景（最频色占比 < 99%）', stats.topColorShare < 0.99, `最频色占比 ${(stats.topColorShare * 100).toFixed(1)}%`);
  }

  return finish(o, checks, { width, height, bytes: buf.length, stats });
}

function finish(o, checks, extra = {}) {
  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log('────────────────────────────────────────────────────────────────────');
  console.log(`  结论：${failed.length ? `✖ ${failed.length} 项不通过` : '✔ 全部通过'}（共 ${checks.length} 项）`);
  console.log('────────────────────────────────────────────────────────────────────');
  console.log('');
  if (o.out) {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(path.resolve(o.out), JSON.stringify({
      checkedAt: new Date().toISOString(), png: path.resolve(o.png), ...extra, checks,
      passed: failed.length === 0
    }, null, 2) + '\n');
  }
  process.exit(failed.length ? 1 : 0);
}

/** 解码 PNG 像素并统计唯一颜色/标准差。只支持 8 位、非隔行（本项目的截图都满足）。 */
function decodeAndStats(buf, width, height, bitDepth, colorType, interlace) {
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`不支持的格式（bitDepth=${bitDepth} interlace=${interlace}）`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 colorType=' + colorType);

  // 收集 IDAT
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (type === 'IDAT') idat.push(buf.slice(dataStart, dataStart + len));
    if (type === 'IEND') break;
    off = dataStart + len + 4;
  }
  if (idat.length === 0) throw new Error('没有 IDAT 数据块');
  const raw = zlib.inflateSync(Buffer.concat(idat));

  const bpp = channels;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.slice(pos, pos + stride); pos += stride;
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = v + a; break;
        case 2: v = v + b; break;
        case 3: v = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error('非法 filter 类型 ' + filter);
      }
      cur[x] = v & 0xff;
    }
  }

  // 抽样统计（最多 200k 像素，控制耗时）
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 200000));
  const colorSet = new Set();
  const colorCount = new Map();
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < total; i += step) {
    const base = i * bpp;
    const r = out[base], g = channels >= 3 ? out[base + 1] : r, b = channels >= 3 ? out[base + 2] : r;
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2); // 量化到 6bit/通道，避免抗锯齿噪声抬高唯一色数
    colorSet.add(key);
    colorCount.set(key, (colorCount.get(key) || 0) + 1);
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += gray; sum2 += gray * gray; n++;
  }
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  let top = 0;
  for (const v of colorCount.values()) if (v > top) top = v;
  return { channels: bpp, sampled: n, uniqueColors: colorSet.size, mean, stddev: Math.sqrt(variance), topColorShare: top / n };
}

main();
