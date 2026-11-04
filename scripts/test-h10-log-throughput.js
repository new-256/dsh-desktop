'use strict';

/**
 * H-10 验收（写入吞吐 / 不丢行 / 滚动并发 / 背压计数 / 退出 flush）。
 *
 * 为什么存在：H-10 的核心指控是「每条后端输出都付一次同步 statSync + appendFileSync」。
 * 本脚本用可计数的 fs 打点证明修复后**行级零文件系统调用**，并逐条验证我们不肯退让的
 * 语义：日志不丢、10MB 滚动照旧、滚动瞬间写入不丢行、队列触顶丢弃必须进日志正文、
 * 进程退出前队列必须清空。
 *
 * 用法：node scripts/test-h10-log-throughput.js
 * 超时：默认 120s（DSH_TEST_TIMEOUT_MS 可调），超时打印当前阶段并强制退出。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TIMEOUT_MS = parseInt(process.env.DSH_TEST_TIMEOUT_MS || '120000', 10) || 120000;
const ROOT = path.join(__dirname, '..');
const DIAG_PATH = path.join(ROOT, 'diag-log.js');
const BASE_ROOT = path.join(os.tmpdir(), `dsh-h10-test-${process.pid}`);

let currentPhase = '启动';
const watchdog = setTimeout(() => {
  process.stderr.write(`[test-h10] 超时 ${TIMEOUT_MS}ms（阶段：${currentPhase}），强制退出\n`);
  process.exit(3);
}, TIMEOUT_MS);

// 多个模块实例各自注册 exit 钩子，测试进程里放开监听上限避免 MaxListenersExceededWarning
process.setMaxListeners(0);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}\n`);
}

// ── fs 打点：证明「行级零文件系统调用」 ─────────────────────────────────────
const io = { appendFileSync: 0, statSync: 0, renameSync: 0, writeFileSync: 0, existsSync: 0 };
const raw = {
  appendFileSync: fs.appendFileSync,
  statSync: fs.statSync,
  renameSync: fs.renameSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync
};
fs.appendFileSync = function countedAppend(...args) { io.appendFileSync += 1; return raw.appendFileSync.apply(fs, args); };
fs.statSync = function countedStat(...args) { io.statSync += 1; return raw.statSync.apply(fs, args); };
fs.renameSync = function countedRename(...args) { io.renameSync += 1; return raw.renameSync.apply(fs, args); };
fs.writeFileSync = function countedWrite(...args) { io.writeFileSync += 1; return raw.writeFileSync.apply(fs, args); };
fs.existsSync = function countedExists(...args) { io.existsSync += 1; return raw.existsSync.apply(fs, args); };
function resetIo() { for (const k of Object.keys(io)) io[k] = 0; }
function ioTotal() { return Object.values(io).reduce((a, b) => a + b, 0); }

// ── 模块实例工厂：每阶段一套干净环境变量 + 新鲜模块 ─────────────────────────
const ENV_KEYS = [
  'DSH_DIAG_BASE', 'DSH_DIAG_MAX_BYTES', 'DSH_DIAG_MAX_ERROR_BYTES', 'DSH_DIAG_FLUSH_MS',
  'DSH_DIAG_FLUSH_TICK_BUDGET_MS', 'DSH_DIAG_QUEUE_MAX_LINES', 'DSH_DIAG_QUEUE_MAX_BYTES',
  'DSH_DIAG_CHUNK_BYTES', 'DSH_DIAG_FLUSH_BUDGET_MS', 'DSH_DIAG_MAX_ARCHIVES',
  'DSH_DIAG_MAX_DESKTOP_REPORT_ARCHIVES', 'DSH_DIAG_MAX_ARCHIVE_DAYS', 'DSH_DIAG_MAX_DESKTOP_REPORT_ARCHIVE_DAYS'
];
function makeDiag(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(DIAG_PATH)];
  return require(DIAG_PATH);
}

function freshBase(name) {
  const dir = path.join(BASE_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 干净的子进程环境：先剥掉所有 DSH_DIAG_* 旋钮，避免上一阶段的收紧值（如队列上限）串味。 */
function cleanEnv(extra) {
  const env = { ...process.env };
  for (const key of ENV_KEYS) delete env[key];
  return Object.assign(env, extra);
}

const MAIN_LOG_RE = /^DSH-Desktop-日志(?:-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?)?\.txt$/;

/** 主日志 + 全部存档的行数合计（不含错误清单/桌面报告）。 */
function countAllLogLines(logsDir) {
  let total = 0;
  const files = [];
  for (const name of fs.readdirSync(logsDir)) {
    if (!MAIN_LOG_RE.test(name)) continue;
    const file = path.join(logsDir, name);
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0).length;
    total += lines;
    files.push({ name, lines, bytes: Buffer.byteLength(text, 'utf8') });
  }
  return { total, files };
}

function readMainLog(logsDir) {
  const file = path.join(logsDir, 'DSH-Desktop-日志.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

const fmtMs = (ns) => (Number(ns) / 1e6).toFixed(1) + 'ms';

async function phase1Throughput() {
  currentPhase = '阶段1 5 万行吞吐 + 行级零 IO';
  const base = freshBase('phase1');
  const diag = makeDiag({ DSH_DIAG_BASE: base });
  const logsDir = path.join(base, 'logs');
  const N = 50000;

  // 抑制 [diag] 控制台回显（只影响本测试观测，不改产品行为）
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    diag.write('阶段1 预热');       // 首次写入：header + 归档/清理（每个会话一次）
    resetIo();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) diag.write('后端输出', 'line-' + i);
    const t1 = process.hrtime.bigint();
    var enqueueNs = t1 - t0;
    var ioDuringEnqueue = { ...io };
    var queuedAfterEnqueue = diag.status();
  } finally {
    process.stdout.write = stdoutWrite;
  }

  const perLineUs = Number(enqueueNs) / N / 1000;
  check(`阶段1：注入 ${N} 行期间**零文件系统调用**`, ioTotal() === 0, '实际：' + JSON.stringify(ioDuringEnqueue));
  check(`阶段1：队列完整收下 ${N + 2} 条记录（无丢弃）`, queuedAfterEnqueue.queuedLines === N + 2 && queuedAfterEnqueue.droppedTotal === 0,
    '实际：' + JSON.stringify({ queuedLines: queuedAfterEnqueue.queuedLines, droppedTotal: queuedAfterEnqueue.droppedTotal }));
  check(`阶段1：单行入队耗时 < 200µs`, perLineUs < 200, `实际：${perLineUs.toFixed(2)}µs/行，总 ${fmtMs(enqueueNs)}`);

  // 同步基线对照：同样 5 万次 appendFileSync（0.3.47 的老路径形态）
  const baselineFile = path.join(base, 'baseline.txt');
  const BASE_N = 20000;
  const b0 = process.hrtime.bigint();
  for (let i = 0; i < BASE_N; i += 1) raw.appendFileSync(baselineFile, `[2026-11-04T00:00:00.000Z] 后端输出 line-${i}\n`, 'utf8');
  const b1 = process.hrtime.bigint();
  const baselinePerLineUs = Number(b1 - b0) / BASE_N / 1000;
  process.stdout.write(`[INFO] 同步基线（老路径形态）单行 ${baselinePerLineUs.toFixed(2)}µs；本次入队 ${perLineUs.toFixed(2)}µs（提速 ${(baselinePerLineUs / Math.max(perLineUs, 0.01)).toFixed(1)}×）\n`);

  resetIo();
  const f0 = process.hrtime.bigint();
  diag.flushSync(60000);
  const f1 = process.hrtime.bigint();
  const flushNs = f1 - f0;
  const flushed = diag.status();
  const counted = countAllLogLines(logsDir);

  check('阶段1：flush 后队列清空', flushed.queuedLines === 0, '实际：' + flushed.queuedLines);
  check('阶段1：flush 后零丢弃', flushed.droppedTotal === 0, '实际：' + flushed.droppedTotal);
  check(`阶段1：全部 ${N + 2} 行落盘（header + 预热 + ${N}）`, counted.total === N + 2, '实际：' + counted.total);
  check('阶段1：刷盘系统调用数远小于行数（批量证据）', ioTotal() > 0 && ioTotal() < N / 10, `实际：${ioTotal()} 次调用处理 ${N + 2} 行，耗时 ${fmtMs(flushNs)}`);
  check('阶段1：日志正文无「队列触顶」记录', !readMainLog(logsDir).includes('队列触顶'), readMainLog(logsDir).includes('队列触顶') ? '正文出现了丢弃说明行' : '正文干净');
  return { perLineUs, baselinePerLineUs, flushMs: Number(f1 - f0) / 1e6, io: { ...io } };
}

async function phase2Rotation() {
  currentPhase = '阶段2 10MB 滚动语义 + 滚动瞬间写入不丢行';
  const base = freshBase('phase2');
  const diag = makeDiag({
    DSH_DIAG_BASE: base,
    DSH_DIAG_MAX_BYTES: '65536',      // 把阈值缩到 64KB，等价验证 10MB 滚动语义
    DSH_DIAG_CHUNK_BYTES: '8192',     // 块更小 → 滚动检查更频繁
    DSH_DIAG_MAX_ARCHIVES: '50',
    DSH_DIAG_MAX_ARCHIVE_DAYS: '30',
    DSH_DIAG_MAX_DESKTOP_REPORT_ARCHIVES: '50'
  });
  const logsDir = path.join(base, 'logs');
  const N = 3000;
  const pad = 'x'.repeat(100);

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    // 关键场景：一边写一边刷（滚动发生在「队列里还有行」的瞬间）
    for (let i = 0; i < N; i += 1) {
      diag.write('后端输出', `rot-${i}-${pad}`);
      if (i % 200 === 0) diag.flush();      // 每 200 行刷一次：滚动检查与后续入队交错
    }
    var midStatus = diag.status();
  } finally {
    process.stdout.write = stdoutWrite;
  }
  diag.flushSync(60000);
  const counted = countAllLogLines(logsDir);
  const expected = N + 1;                    // header + N 行
  const archives = counted.files.filter((f) => f.name !== 'DSH-Desktop-日志.txt');

  check('阶段2：滚动确实发生过（产生存档）', archives.length >= 3, '存档数：' + archives.length + '，文件：' + JSON.stringify(counted.files.map((f) => f.name)));
  check(`阶段2：滚动 + 交错写入后行数守恒（${expected} 行）`, counted.total === expected, '实际：' + counted.total + '，明细 ' + JSON.stringify(counted.files));
  check('阶段2：零丢弃', midStatus.droppedTotal === 0 && diag.status().droppedTotal === 0,
    '实际：' + JSON.stringify({ mid: midStatus.droppedTotal, final: diag.status().droppedTotal }));
  check('阶段2：单文件不显著超阈值（块粒度 ≤ 块字节 + 阈值）',
    counted.files.every((f) => f.bytes <= 65536 + 8192 + 4096), '实际：' + JSON.stringify(counted.files.map((f) => f.bytes)));
  return { archives: archives.length, files: counted.files.length };
}

async function phase3Backpressure() {
  currentPhase = '阶段3 队列触顶丢弃计数必须进正文';
  const base = freshBase('phase3');
  const diag = makeDiag({
    DSH_DIAG_BASE: base,
    DSH_DIAG_FLUSH_MS: '60000',       // 定时器不参与：手动 flush，确保注入期间队列不被清空
    DSH_DIAG_QUEUE_MAX_LINES: '100'
  });
  const logsDir = path.join(base, 'logs');
  const N = 1000;

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    for (let i = 0; i < N; i += 1) diag.write('后端输出', 'cap-' + i);
    var statusBefore = diag.status();
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const expectedDropped = N + 1 - 100;       // 1 条 header + N 行，队列上限 100 行
  check('阶段3：触顶丢弃计数准确且未被静默吞掉',
    statusBefore.droppedTotal === expectedDropped && statusBefore.queuedLines === 100,
    '实际：' + JSON.stringify({ droppedTotal: statusBefore.droppedTotal, queuedLines: statusBefore.queuedLines, expectedDropped }));

  diag.flush();
  diag.flushSync(60000);
  const log = readMainLog(logsDir);
  const counted = countAllLogLines(logsDir);
  check('阶段3：丢弃计数写进了日志正文', /队列触顶[^\n]*丢弃 \d+ 行/.test(log), '正文片段：' + (log.match(/队列触顶[^\n]*/) || ['(无)'])[0]);
  check('阶段3：正文里记的丢弃数 == 实际丢弃数', log.includes(`本次丢弃 ${expectedDropped} 行`), log.includes(`本次丢弃 ${expectedDropped} 行`) ? `正文含「本次丢弃 ${expectedDropped} 行」` : '未找到「本次丢弃 ' + expectedDropped + ' 行」');
  check('阶段3：正文里的丢弃数之后不再重复计数（状态归零）', diag.status().droppedPending === 0, '实际：' + diag.status().droppedPending);
  check('阶段3：写入行数 = 队列上限（100 行）+ 1 条丢弃说明', counted.total === 101, '实际：' + counted.total);
  return { expectedDropped, lines: counted.total };
}

async function phase4ExitFlush() {
  currentPhase = '阶段4 进程退出前 flush';
  const base = freshBase('phase4');
  const childPath = path.join(base, 'child-exit.js');
  const N = 500;
  fs.writeFileSync(childPath, [
    "'use strict';",
    `const diag = require(${JSON.stringify(DIAG_PATH)});`,
    `const N = ${N};`,
    "for (let i = 0; i < N; i += 1) diag.write('后端输出', 'exit-line-' + i);",
    "process.stdout.write = () => true;",
    "process.exit(0);   // 故意不手动 flush：验证 exit 钩子",
    ''
  ].join('\n'), 'utf8');

  const run = spawnSync(process.execPath, [childPath], {
    env: cleanEnv({ DSH_DIAG_BASE: base, DSH_DIAG_FLUSH_MS: '60000' }),
    stdio: 'ignore',
    timeout: 60000
  });
  check('阶段4：子进程正常退出', run.status === 0, '实际 status=' + run.status + ' signal=' + run.signal);
  const logsDir = path.join(base, 'logs');
  const counted = countAllLogLines(logsDir);
  check(`阶段4：退出钩子把队列清空（${N + 1} 行）`, counted.total === N + 1, '实际：' + counted.total);
  check('阶段4：未触发「退出刷盘超预算」', !readMainLog(logsDir).includes('退出刷盘超预算'), readMainLog(logsDir).includes('退出刷盘超预算') ? '正文出现了超预算说明行' : '正文干净');
  return { lines: counted.total };
}

(async () => {
  const summary = {};
  try {
    summary.phase1 = await phase1Throughput();
    summary.phase2 = await phase2Rotation();
    summary.phase3 = await phase3Backpressure();
    summary.phase4 = await phase4ExitFlush();
  } catch (err) {
    clearTimeout(watchdog);
    process.stderr.write(`[test-h10] 阶段「${currentPhase}」抛异常：\n${(err && err.stack) || err}\n`);
    process.exit(1);
  }

  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n[test-h10] 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  process.stdout.write('[test-h10] 数据：' + JSON.stringify(summary) + '\n');
  process.stdout.write('[test-h10] 临时目录：' + BASE_ROOT + '\n');
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAIL ${f.name} — ${f.detail}\n`);
    process.exit(1);
  }
  process.stdout.write('[test-h10] 全部通过\n');
  process.exit(0);
})();
