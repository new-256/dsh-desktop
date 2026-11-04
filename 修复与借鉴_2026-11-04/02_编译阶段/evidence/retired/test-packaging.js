'use strict';

/**
 * 打包白名单完整性检查。
 *
 * ## 为什么需要
 *
 * electron-builder 的 `build.files` 是**显式白名单**：新增一个本地模块
 * （例如 0.3.42 的 quit-guard.js）却忘了加进去，它会被**静默漏打包** ——
 * 开发环境跑得好好的，装到用户机器上 require 直接失败、应用起不来，
 * 而构建过程不会报任何错。
 *
 * 这个检查把"白名单是否覆盖了所有真实被 require 的本地模块"变成可自动
 * 验证的断言，防止这类只在发布后才暴露的问题。
 *
 * 用法：node scripts/test-packaging.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}

console.log('打包白名单完整性');

const files = (pkg.build && pkg.build.files) || [];
const includes = files.filter((f) => !f.startsWith('!'));

// 从入口文件出发，递归收集所有被 require 的本地模块。
const entryPoints = ['main.js', 'updater-backend.js', 'crash-report.js', 'diag-log.js', 'quit-guard.js', 'preload.js', 'settings-preload.js'];
const needed = new Set();
const visited = new Set();

function scan(rel) {
  if (visited.has(rel)) return;
  visited.add(rel);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const text = fs.readFileSync(abs, 'utf8');
  // require('./x') 或 require('./x.js')；跳过 node_modules 与 electron
  const re = /require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let target = m[1];
    if (!target.endsWith('.js')) target += '.js';
    needed.add(target);
    scan(target);
  }
}

for (const e of entryPoints) scan(e);

console.log('  被 require 的本地模块: ' + Array.from(needed).sort().join(', '));

function covered(name) {
  if (includes.includes(name)) return true;
  // 目录通配（如 assets/**/*）
  for (const f of includes) {
    if (f.endsWith('/**/*')) {
      const prefix = f.slice(0, -5);
      if (name.startsWith(prefix)) return true;
    }
  }
  return false;
}

ok(needed.size > 0, '扫描到了本地模块依赖（检查器本身有效）');
for (const n of Array.from(needed).sort()) {
  ok(covered(n), `build.files 包含 ${n}`);
}

// 反向检查：白名单里不应出现磁盘上不存在的本地文件（除通配与排除项）。
for (const f of includes) {
  if (f.endsWith('/**/*')) continue;
  ok(fs.existsSync(path.join(ROOT, f)), `白名单条目存在: ${f}`);
}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
