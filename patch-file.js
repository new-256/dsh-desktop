'use strict';

/**
 * 补丁文件（cordis.patch.yml）解析原语 —— 0.3.46 抽出。
 *
 * 抽出来的原因不是「文件太短」，而是**同一套解析语义必须只有一份**：
 * 预检（判断裸包名能否解析）、冲突扫描、失败归因、隔离/恢复都要按同样
 * 的规则读补丁文件。两处一旦漂移，就会出现「预检认为是裸包名、归因
 * 认为是 file://」这类自相矛盾的结论 —— 2026-10-20 的误禁用正是
 * 「解析根模型」错在另一处（只看 profiles）造成的。
 *
 * 纯函数、无副作用、不依赖 Electron —— 可直接单测。
 */

const path = require('path');

/**
 * 解析补丁文件的 `- insert:` 块与其中的条目。
 *
 * 结构：{ start, end, entries: [{ id, name, lineStart, lineEnd }] }
 * lineStart/lineEnd 是**闭开区间**的行号（相对传入文本的行数组）。
 */
function parseHomePatchBlocks(yamlText) {
  const lines = String(yamlText || '').split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- insert:/.test(lines[i])) {
      if (cur) blocks.push(cur);
      cur = { start: i, end: lines.length, entries: [] };
      continue;
    }
    if (!cur) continue;
    const idm = /^\s*-\s+id:\s*(\S+)/.exec(lines[i]);
    if (idm) {
      // Close the previous entry's range at this entry's first line.
      if (cur.entries.length) cur.entries[cur.entries.length - 1].lineEnd = i;
      cur.entries.push({ id: idm[1], name: null, lineStart: i, lineEnd: lines.length });
    } else if (cur.entries.length) {
      const last = cur.entries[cur.entries.length - 1];
      if (last.name === null) {
        const nm = /^\s*name:\s*(.+)$/.exec(lines[i]);
        if (nm) last.name = nm[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  if (cur) blocks.push(cur);
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].end = i + 1 < blocks.length ? blocks[i + 1].start : lines.length;
  }
  // Trim each entry's range to its last meaningful line (drop trailing blank
  // lines and foreign comment banners so disabling never touches more than
  // the entry itself).
  const meaningful = (l) => l && l.trim() !== '' && !l.trimStart().startsWith('#');
  for (const block of blocks) {
    for (const entry of block.entries) {
      entry.lineEnd = Math.min(entry.lineEnd, block.end);
      while (entry.lineEnd > entry.lineStart + 1 && !meaningful(lines[entry.lineEnd - 1])) entry.lineEnd--;
    }
  }
  return blocks;
}

/**
 * 找出**被注释掉**的条目（`- id:` 已被前缀 '#'）。
 *
 * parseHomePatchBlocks 只认活跃条目；预检的「恢复」需要先定位被自己
 * 注释掉的块，故单独提供。返回 [{ id, lineStart, lineEnd, blockStart }]，
 * lineStart/lineEnd 同为闭开区间。
 */
function parseCommentedPatchEntries(yamlText) {
  const lines = String(yamlText || '').split(/\r?\n/);
  const out = [];
  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#\s*- insert:/.test(lines[i])) { blockStart = i; continue; }
    const idm = /^\s*#\s*-\s+id:\s*(\S+)/.exec(lines[i]);
    if (!idm) continue;
    // 条目范围 = 从本行到下一个「被注释的条目/块」或任何活跃块起始行
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*#\s*-\s+id:/.test(lines[j]) || /^\s*#\s*- insert:/.test(lines[j]) || /^\s*- insert:/.test(lines[j])) { end = j; break; }
    }
    out.push({ id: idm[1], lineStart: i, lineEnd: end, blockStart });
  }
  return out;
}

/** Convert a patch entry `name` to a filesystem path for file:// names (or null). */
function specToPath(name) {
  let s = String(name || '').trim();
  if (!/^file:/i.test(s)) return null;
  if (s.startsWith('file://')) {
    const rest = s.slice('file://'.length).replace(/^\/+/, ''); // file:///C:/... -> C:/...
    try { s = decodeURIComponent(rest); } catch { s = rest; }
  } else {
    try { s = decodeURIComponent(s.slice('file:'.length)); } catch {}
  }
  return s.split('?')[0];
}

/**
 * Normalize a module specifier for matching: file:// URLs -> decoded path,
 * strip ?v=N query, lowercase, forward slashes.
 */
function normalizeSpecifier(spec) {
  let s = String(spec || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    const rest = s.slice('file://'.length).replace(/^\/+/, ''); // file:///C:/... -> C:/...
    try { s = decodeURIComponent(rest); } catch { s = rest; }
  }
  s = s.split('?')[0];
  s = s.replace(/:\d+(?::\d+)?$/, ''); // strip :line[:col] suffixes from error URLs
  return s.replace(/\\/g, '/').toLowerCase();
}

/**
 * 是否是**裸包名**（bare package name）—— 即 Node 会走 node_modules 解析链的形式。
 *
 * 排除：file:// URL、任何带协议前缀的形式（npm: 等）、相对路径（./）、
 * 绝对路径（/ 与盘符）。带 `?v=N` 版本戳的裸包名**仍算裸包名**（版本戳
 * 只是缓存破坏参数），由 barePackageName() 剥掉。
 */
function isBarePackageName(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (n.includes(':')) return false;          // file://、npm:、C:\...
  if (n.startsWith('.') || n.startsWith('/') || n.startsWith('\\')) return false;
  return true;
}

/** 裸包名去掉 `?v=N` 版本戳与首尾引号。 */
function barePackageName(name) {
  return String(name || '').trim().split('?')[0].replace(/^['"]|['"]$/g, '');
}

module.exports = {
  parseHomePatchBlocks,
  parseCommentedPatchEntries,
  specToPath,
  normalizeSpecifier,
  isBarePackageName,
  barePackageName,
  path,
};
