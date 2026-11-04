'use strict';

/**
 * H-10 durability 分层门禁：高频行批量、关键产物落盘即返回。
 *
 * 为什么存在：0.3.48 的 H-10 批量化曾把「桌面错误报告」也一起延后 200ms，导致
 * `scripts/test-047-desktop-report.js` 4 项回归（报告在断言/对话框之前还不存在）。
 * 修法是**分层**而不是回退：高频行继续批量，关键产物在调用返回前必须落盘。
 *
 * 本脚本把「分层」本身钉成断言，防止将来有人把某一层悄悄放宽：
 *   A. 高频行（不命中 ERROR_LINE_RE）→ 返回后磁盘上**没有**新内容（批量语义）；
 *   B. 命中错误关键字 → 返回后主日志 + 错误清单 + 桌面报告**都已落盘**（durability）；
 *   C. 显式 writeDurable()（不含错误关键字）→ 主日志落盘，但不伪造进错误清单；
 *   D. durable 是**屏障**：先把更早的高频行刷出去，关键记录不会插队；
 *   E. 高频路径仍然零同步文件系统调用（H-10 的收益不退化为回归）；
 *   F. durability 判据是机制（去向/显式声明），代码里不存在测试文件名白名单。
 *
 * 用法：node scripts/test-h10-durability-layering.js
 * 超时：默认 120s（DSH_TEST_TIMEOUT_MS 可调）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = parseInt(process.env.DSH_TEST_TIMEOUT_MS || '120000', 10) || 120000;
const watchdog = setTimeout(() => {
  process.stderr.write(`[test-h10-durability] 超时 ${TIMEOUT_MS}ms，强制退出\n`);
  process.exit(3);
}, TIMEOUT_MS);

process.setMaxListeners(0);

const ROOT = path.join(__dirname, '..');
const DIAG_PATH = path.join(ROOT, 'diag-log.js');
const BASE = path.join(os.tmpdir(), `dsh-h10-durability-${process.pid}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const show = detail && (!ok || detail.startsWith('实际'));
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${show ? ' — ' + detail : ''}\n`);
}

// fs 打点：证明高频路径仍然零同步调用
const io = { appendFileSync: 0, statSync: 0, renameSync: 0, writeFileSync: 0 };
const raw = {
  appendFileSync: fs.appendFileSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  renameSync: fs.renameSync.bind(fs),
  writeFileSync: fs.writeFileSync.bind(fs)
};
fs.appendFileSync = function countedAppend(...args) { io.appendFileSync += 1; return raw.appendFileSync(...args); };
fs.statSync = function countedStat(...args) { io.statSync += 1; return raw.statSync(...args); };
fs.renameSync = function countedRename(...args) { io.renameSync += 1; return raw.renameSync(...args); };
fs.writeFileSync = function countedWrite(...args) { io.writeFileSync += 1; return raw.writeFileSync(...args); };
const ioTotal = () => Object.values(io).reduce((a, b) => a + b, 0);
const resetIo = () => { for (const k of Object.keys(io)) io[k] = 0; };

const ENV_KEYS = ['DSH_DIAG_BASE', 'DSH_DIAG_FLUSH_MS', 'DSH_DIAG_QUEUE_MAX_LINES', 'DSH_DIAG_MAX_BYTES'];
function makeDiag(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(DIAG_PATH)];
  return require(DIAG_PATH);
}

function paths(b, sub) {
  const root = path.join(BASE, b);
  return {
    log: path.join(root, 'logs', 'DSH-Desktop-日志.txt'),
    err: path.join(root, 'logs', 'DSH-Desktop-错误清单.txt'),
    report: path.join(root, 'desktop', 'DSH-Desktop-错误报告.txt'),
    logsDir: path.join(root, 'logs'),
    desktopDir: path.join(root, 'desktop')
  };
}
function readIfExists(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function lines(file) { const t = readIfExists(file); return t ? t.split('\n').filter((l) => l.length > 0).length : 0; }

/**
 * 去掉注释（// 与 /* *\/），只留可执行代码。
 * 为什么需要：diag-log.js 的文件头注释里写着这次回归的事故编号（test-047…），那是给
 * 维护者看的历史，不是分类逻辑；断言必须只看代码，否则会误报。
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'") { state = 'single'; out += ch; i += 1; continue; }
      if (ch === '"') { state = 'double'; out += ch; i += 1; continue; }
      if (ch === '`') { state = 'template'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') { if (ch === '\n') { state = 'code'; out += ch; } i += 1; continue; }
    if (state === 'block') { if (ch === '*' && next === '/') { state = 'code'; i += 2; } else { i += 1; } continue; }
    out += ch;
    if (ch === '\\') { out += source[i + 1] || ''; i += 2; continue; }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
      state = 'code';
    }
    i += 1;
  }
  return out;
}

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });

// ── A. 高频行：批量（返回后磁盘无新内容）────────────────────────────────────
const aPaths = paths('a');
const aDiag = makeDiag({ DSH_DIAG_BASE: path.join(BASE, 'a'), DSH_DIAG_FLUSH_MS: '60000' });
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;   // 抑制 [diag] 回显（只影响观测）
try {
  resetIo();
  for (let i = 0; i < 50; i += 1) aDiag.write('后端输出', 'high-freq-' + i);
  var aIoDuringWrite = { ...io };
  var aQueued = aDiag.status().queuedLines;
} finally {
  process.stdout.write = stdoutWrite;
}
check('A1 50 条高频行期间零同步文件系统调用（H-10 收益保持）', ioTotal() === 0, '实际：' + JSON.stringify(aIoDuringWrite));
check('A2 高频行全部留在队列（51 = 会话头 + 50 行）', aQueued === 51, '实际：' + aQueued);
check('A3 返回后主日志尚未创建（批量语义）', !fs.existsSync(aPaths.log), '实际存在：' + fs.existsSync(aPaths.log));
check('A4 高频行不产生错误清单/桌面报告', !fs.existsSync(aPaths.err) && !fs.existsSync(aPaths.report),
  '实际：错误清单 ' + fs.existsSync(aPaths.err) + ' / 桌面报告 ' + fs.existsSync(aPaths.report));

// ── B. 错误关键字行：durability（返回即落盘）────────────────────────────────
const bDiag = makeDiag({ DSH_DIAG_BASE: path.join(BASE, 'b'), DSH_DIAG_FLUSH_MS: '60000' });
const bPaths = paths('b');
process.stdout.write = () => true;
try {
  bDiag.write('普通行 1');
  bDiag.write('模拟故障 error something failed');   // 命中 ERROR_LINE_RE → 关键产物
} finally {
  process.stdout.write = stdoutWrite;
}
const bLog = readIfExists(bPaths.log);
const bErr = readIfExists(bPaths.err);
const bReport = readIfExists(bPaths.report);
check('B1 错误行返回后主日志已落盘（含普通行，共 3 行：头 + 2）', lines(bPaths.log) === 3, '实际：' + lines(bPaths.log));
check('B2 错误行返回后错误清单已落盘 1 行', lines(bPaths.err) === 1, '实际：' + lines(bPaths.err));
check('B3 错误行返回后桌面报告已落盘 2 行（头 + 1）', lines(bPaths.report) === 2, '实际：' + lines(bPaths.report));
check('B4 三个产物内容都含错误文本', bLog.includes('模拟故障 error something failed')
  && bErr.includes('模拟故障 error something failed') && bReport.includes('模拟故障 error something failed'),
  '实际：' + JSON.stringify({ log: bLog.includes('模拟故障'), err: bErr.includes('模拟故障'), report: bReport.includes('模拟故障') }));
check('B5 错误行不入队列（durable 直写，队列清零）', bDiag.status().queuedLines === 0, '实际：' + bDiag.status().queuedLines);

// ── C. writeDurable 显式声明（不含错误关键字）───────────────────────────────
const cDiag = makeDiag({ DSH_DIAG_BASE: path.join(BASE, 'c'), DSH_DIAG_FLUSH_MS: '60000' });
const cPaths = paths('c');
process.stdout.write = () => true;
try {
  cDiag.writeDurable('迁移记录：已导入 3 个插件');
} finally {
  process.stdout.write = stdoutWrite;
}
check('C1 writeDurable 返回后主日志已落盘（含 1 条记录 + 会话头）', lines(cPaths.log) === 2, '实际：' + lines(cPaths.log));
check('C2 writeDurable 不会把普通文本伪造进错误清单', !fs.existsSync(cPaths.err), '实际：' + fs.existsSync(cPaths.err));
check('C3 writeDurable 返回后队列为空', cDiag.status().queuedLines === 0, '实际：' + cDiag.status().queuedLines);

// ── D. durable 是屏障：先刷掉更早的高频行，不插队 ─────────────────────────
const dDiag = makeDiag({ DSH_DIAG_BASE: path.join(BASE, 'd'), DSH_DIAG_FLUSH_MS: '60000' });
const dPaths = paths('d');
process.stdout.write = () => true;
try {
  for (let i = 0; i < 200; i += 1) dDiag.write('后端输出', 'queued-' + i);
  dDiag.writeDurable('关键产物：更新决策已记录');
} finally {
  process.stdout.write = stdoutWrite;
}
const dLines = readIfExists(dPaths.log).split('\n').filter((l) => l.length > 0);
const lastLine = dLines[dLines.length - 1] || '';
check('D1 屏障后 201 条记录全部落盘（头 + 200 高频 + 1 关键）', dLines.length === 202, '实际：' + dLines.length);
check('D2 关键记录排在最后（未插队到更早的行前面）', lastLine.includes('关键产物：更新决策已记录'), '实际末行：' + lastLine.slice(0, 80));
check('D3 高频行顺序保持（第 2 行是 queued-0）', (dLines[1] || '').includes('queued-0') && (dLines[200] || '').includes('queued-199'),
  '实际：第2行=' + (dLines[1] || '').slice(0, 60) + ' 第201行=' + (dLines[200] || '').slice(0, 60));

// ── E. 判据是机制而非文件名白名单 ──────────────────────────────────────────
const src = fs.readFileSync(DIAG_PATH, 'utf8');
// 只看可执行代码：注释（含历史事故记录里的测试名）不算分类逻辑
const codeOnly = stripComments(src);
check('E1 判定函数 feedsCriticalSink 存在且以 isError（去向）为判据',
  /function feedsCriticalSink\(record\) \{ return record\.isError === true; \}/.test(codeOnly), '未找到机制化判定');
const durableDecision = /if \(forceDurable \|\| feedsCriticalSink\(record\)\)/.exec(codeOnly);
check('E2 durable 判定是「显式声明 ∨ 去向判定」，不含测试名或文本匹配（机制化，不是名单）',
  !!durableDecision && !/test-\d{3}/.test(codeOnly) && !/\b(includes|test|match|exec)\s*\(/.test(durableDecision[0]),
  '实际判据：' + (durableDecision ? durableDecision[0] : '(未找到分层判定)'));
check('E3 关键产物走 durability 层、高频行走批量层（两条路径均存在）',
  /writeDurable/.test(codeOnly) && /flushSync\(FLUSH_BUDGET_MS\);[\s\S]{0,80}writeBatch\(\[record\]\);/.test(codeOnly), '未找到分层实现');

clearTimeout(watchdog);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n[test-h10-durability] 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAIL ${f.name} — ${f.detail}\n`);
  process.exit(1);
}
fs.rmSync(BASE, { recursive: true, force: true });
process.stdout.write('[test-h10-durability] 全部通过\n');
process.exit(0);
