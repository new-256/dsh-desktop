'use strict';
/** 0.3.40 dry-run：精确复刻 migrateProjectionCache 判定，统计真实数据上每次启动会重写多少文件。 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'dsh-home', 'storages', 'session_projcache');
if (!fs.existsSync(dir)) { console.log('目录不存在: ' + dir); process.exit(1); }

const t0 = Date.now();
const files = [];
(function collect(root) {
  let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) collect(full);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) files.push(full);
  }
})(dir);
const t1 = Date.now();
console.log(`收集 ${files.length} 个 json（${t1 - t0}ms）`);

let changed = 0, parseFail = 0, totalBytesRead = 0;
let touchedBytes = 0;
const byDir = {};
for (const file of files) {
  let value;
  try { totalBytesRead += fs.statSync(file).size; value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { parseFail++; continue; }
  let touched = false;
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.identity && typeof node.identity === 'object' && !Array.isArray(node.identity)) {
      if (typeof node.identity.isSeeded !== 'boolean') { touched = true; }
      if (typeof node.identity.inheritedEventCount !== 'number' || !Number.isFinite(node.identity.inheritedEventCount)) { touched = true; }
    }
    for (const child of Object.values(node)) visit(child);
  })(value);
  if (touched) {
    changed++;
    touchedBytes += fs.statSync(file).size;
    const k = path.relative(dir, path.dirname(file));
    byDir[k] = (byDir[k] || 0) + 1;
  }
}
const t2 = Date.now();
console.log(`解析+遍历: ${t2 - t1}ms  读入 ${(totalBytesRead / 1048576).toFixed(1)}MB`);
console.log(`每次启动会重写 ${changed} 个文件（解析失败 ${parseFail}），重写量 ${(touchedBytes / 1048576).toFixed(1)}MB`);
for (const k of Object.keys(byDir).sort()) console.log(`  ${k}: ${byDir[k]}`);
