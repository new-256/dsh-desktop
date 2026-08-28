// 多帧 zstd 会话日志解压器：逐帧解析边界后解压拼接，打印事件摘要
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const [,, inPath] = process.argv;
const buf = readFileSync(inPath);

// 解析单个 zstd frame 的长度（不含 magic 之前的字节）
function frameLength(buf, start) {
  let p = start + 4; // skip magic
  const fhd = buf[p]; p += 1;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksumFlag = (fhd >> 2) & 1;
  const dictIdFlag = fhd & 3;
  if (!singleSegment) p += 1; // window descriptor
  const dictIdSizes = [0, 1, 2, 4];
  p += dictIdSizes[dictIdFlag];
  const fcsSizes = [0, 2, 4, 8];
  let fcsSize = fcsSizes[fcsFlag];
  if (fcsFlag === 0 && singleSegment) fcsSize = 1;
  p += fcsSize;
  // blocks
  for (;;) {
    const h = buf.readUIntLE(p, 3); p += 3;
    const last = h & 1;
    const size = h >>> 3;
    p += size;
    if (last) break;
  }
  if (checksumFlag) p += 4;
  return p - start;
}

let off = 0;
const frames = [];
while (off < buf.length) {
  if (buf[off] !== 0x28 || buf[off + 1] !== 0xB5 || buf[off + 2] !== 0x2F || buf[off + 3] !== 0xFD) {
    console.error(`offset ${off}: 非 zstd magic，停止`);
    break;
  }
  const len = frameLength(buf, off);
  frames.push(buf.subarray(off, off + len));
  off += len;
}

let all = '';
for (const f of frames) {
  try { all += zstdDecompressSync(f).toString('utf8'); } catch (e) { console.error('帧解压失败:', e.message); }
}

const lines = all.trim().split('\n').filter(Boolean);
console.log('帧数:', frames.length, '总事件行数:', lines.length);
const types = {};
for (const l of lines) { try { const e = JSON.parse(l); types[e.type] = (types[e.type] || 0) + 1; } catch {} }
console.log('事件统计:', JSON.stringify(types));
let i = 0;
const showAll = process.argv.includes('--all');
for (const l of lines) {
  i++;
  if (!showAll && i <= lines.length - 25) continue;
  try {
    const e = JSON.parse(l);
    const d = e.data ?? {};
    let p = '';
    if (e.type === 'user/message') p = (d.message?.content || []).map((c) => c.type === 'text' ? c.text.slice(0, 150) : '<' + c.type + '>').join(' | ');
    else if (e.type === 'assistant/message') p = JSON.stringify(d.message?.content || '').slice(0, 400);
    else if (e.type === 'assistant/chunk') continue;
    else p = JSON.stringify(d).slice(0, 200);
    console.log(`${i}. [${e.type}] ${p}`);
  } catch {}
}
