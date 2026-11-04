'use strict';

/**
 * 回归扫描器（一次性工具，供本轮 H-10 durability 回归复验用）。
 *
 * 为什么存在：lead 要求确认「除 test-047 外还有没有别的红」，并把域内红直接修、域外红上报。
 * 逐个手跑容易漏、也可能被某个卡死的测试拖住 —— 这里统一加超时（默认 180s/个），
 * 串行跑完 `scripts/test-*.js` 与 `scripts/verify-*.js`，输出红/绿清单与每项的尾部输出。
 *
 * 用法：node scripts/sweep-tests.js [输出文件]
 * 退出码：0 = 全部绿（或只有已标注的跳过）；1 = 有红。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PER_TEST_TIMEOUT_MS = parseInt(process.env.DSH_SWEEP_TIMEOUT_MS || '180000', 10) || 180000;
const OUT = process.argv[2] || path.join(ROOT, '修复与借鉴_2026-11-04', '03_调试阶段', 'H10_回归_全量扫描.txt');

// 这些脚本不是回归测试（是构建/安装/打包工具），扫描时排除
const EXCLUDE = new Set([
  'install-backend.js', 'make-icon.js', 'pack-vendor.js', 'prepare-runtime.js',
  'write-vendor-manifest.js', 'build-files-gate.js', 'dryrun-migrate.js',
  'repair-046-preflight-restore.js', 'sweep-tests.js'
]);

function listTests() {
  const files = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => /^(test-|verify-).*\.js$/.test(n))
    .filter((n) => !EXCLUDE.has(n))
    .sort();
  return files;
}

function tail(text, n) {
  const lines = String(text || '').split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

const files = listTests();

/**
 * 有些测试必须在真实 Electron 里跑（源码用 app.whenReady()/BrowserWindow）。
 * 用 node 启动它们会得到假的红（require('electron') 只返回 exe 路径字符串）。
 * 这里按源码特征自动切换启动器，而不是维护一份"electron 测试名单"。
 */
function launcherFor(file) {
  const src = fs.readFileSync(file, 'utf8');
  // 显式声明优先（测试自己知道该用什么启动器）
  const explicit = /@launcher\s+(node|electron)/.exec(src);
  if (explicit) {
    return explicit[1] === 'electron'
      ? { exe: require('electron'), kind: 'electron' }
      : { exe: process.execPath, kind: 'node' };
  }
  // 启发式：真实 Electron 主进程脚本（app.whenReady）→ 用 electron 启动。
  // 但"父模式编排"脚本（自己 spawnSync 起 electron 子进程）必须继续用 node，
  // 否则 require('electron') 会拿到 API 对象而不是 exe 路径，测试直接判红。
  const coordinator = /require\('child_process'\)|require\("child_process"\)/.test(src) && /spawnSync/.test(src);
  const needsElectron = /require\('electron'\)/.test(src) && /app\.whenReady\(\)/.test(src);
  if (!needsElectron || coordinator) return { exe: process.execPath, kind: 'node' };
  return { exe: require('electron'), kind: 'electron' };
}
const rows = [];
const startedAt = new Date();

for (const name of files) {
  const file = path.join(ROOT, 'scripts', name);
  const begin = Date.now();
  const launcher = launcherFor(file);
  const run = spawnSync(launcher.exe, [file], {
    cwd: ROOT,
    timeout: PER_TEST_TIMEOUT_MS,
    encoding: 'utf8',
    env: { ...process.env, DSH_TEST_TIMEOUT_MS: String(PER_TEST_TIMEOUT_MS - 10000) }
  });
  const ms = Date.now() - begin;
  const output = (run.stdout || '') + (run.stderr || '');
  rows.push({
    name,
    launcher: launcher.kind,
    status: run.status,
    signal: run.signal,
    timedOut: run.signal === 'SIGTERM' || (run.status === null && run.signal !== null),
    ms,
    tail: tail(output, 6)
  });
  const tag = run.status === 0 ? 'GREEN' : 'RED';
  process.stdout.write(`[${tag}] ${name} [${launcher.kind}] (exit=${run.status}${run.signal ? ' signal=' + run.signal : ''}, ${(ms / 1000).toFixed(1)}s)\n`);
}

const red = rows.filter((r) => r.status !== 0);
const report = [];
report.push('回归扫描（' + startedAt.toISOString() + ' 起，单项超时 ' + PER_TEST_TIMEOUT_MS + 'ms）');
report.push('共 ' + rows.length + ' 项：绿 ' + (rows.length - red.length) + ' / 红 ' + red.length);
report.push('');
for (const r of rows) {
  report.push(`${r.status === 0 ? 'GREEN' : 'RED  '}  ${r.name}  [${r.launcher}]  exit=${r.status}${r.signal ? ' signal=' + r.signal : ''}  ${(r.ms / 1000).toFixed(1)}s`);
  if (r.status !== 0) for (const l of r.tail) report.push('       ' + l);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, report.join('\n') + '\n', 'utf8');
process.stdout.write('\n' + report.join('\n') + '\n');
process.stdout.write('\n输出已写入：' + OUT + '\n');
process.exit(red.length ? 1 : 0);
