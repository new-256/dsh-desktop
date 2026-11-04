'use strict';

// @launcher node —— 本文件是「父模式编排」：用 node 跑父模式，再由它 spawnSync 起
// Electron 子进程（子模式）。整份文件若用 electron.exe 启动，父模式会拿不到 exe 路径。
// 见 scripts/sweep-tests.js 的启动器策略。

/**
 * H-10 真机验收（Electron）：退出刷盘 + 关键产物 durability 两层都要在真运行时成立。
 *
 * 为什么存在：H-10 的单元测试在纯 Node 里跑，`process.exit()` 会触发 Node 的 `exit` 事件，
 * 所以"退出前 flush"看起来永远是对的。但 `main.js` 的更新重启是
 * `app.relaunch(...) + app.exit(0)`，而 Electron 的 `app.exit()` **既不触发
 * `before-quit`/`will-quit`，也不走 Node 的 `exit` 事件** —— 只挂 `process.once('exit')`
 * 时一次 `app.exit(0)` 会把队列里的日志全部丢掉（首轮实测：磁盘 0 行）。
 *
 * 本脚本用「一个文件多模式」把两条真机契约固化：
 *   父模式（普通 node）起 Electron 子进程当被测对象，子进程退出/写完后，父进程断言磁盘。
 *   子模式 1（批量层 + 退出钩子）：只写高频行（不命中错误关键字）→ 退出前磁盘应为空，
 *                                 `app.exit(0)` 后必须全部落盘。
 *   子模式 2（durability 层）：写「高频行 + 一条错误行」→ 退出前就必须已经全部落盘
 *                             （错误记录进错误清单 + 桌面错误报告，属关键产物）。
 *
 * 用法：node scripts/test-h10-electron-exit-flush.js
 * 超时：默认 120s（DSH_TEST_TIMEOUT_MS 可调）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TIMEOUT_MS = parseInt(process.env.DSH_TEST_TIMEOUT_MS || '120000', 10) || 120000;
const ROOT = path.join(__dirname, '..');
const DIAG_PATH = path.join(ROOT, 'diag-log.js');
const CHILD_MODE = process.env.DSH_EXIT_FLUSH_CHILD || '';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const show = detail && (!ok || detail.startsWith('实际'));
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${show ? ' — ' + detail : ''}\n`);
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;   // 文件还没创建 == 0 行（批量层的期望态）
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).length;
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** 子进程共用的三份产物路径（都基于 DSH_DIAG_BASE）。 */
function artifactPaths(base) {
  return {
    log: path.join(base, 'logs', 'DSH-Desktop-日志.txt'),
    err: path.join(base, 'logs', 'DSH-Desktop-错误清单.txt'),
    report: path.join(base, 'desktop', 'DSH-Desktop-错误报告.txt')
  };
}

// ── 子模式：真实 Electron 主进程 ────────────────────────────────────────────
if (CHILD_MODE) {
  const { app } = require('electron');
  const diag = require(DIAG_PATH);
  app.disableHardwareAcceleration();
  app.whenReady().then(() => {
    const paths = artifactPaths(process.env.DSH_DIAG_BASE);
    if (CHILD_MODE === '2') {
      // durability 层：高频行 + 一条错误行（错误行自动 durable）
      diag.write('耐久冒烟 高频行 A');
      diag.write('耐久冒烟 高频行 B');
      diag.write('耐久冒烟 错误行 error simulated');
    } else {
      // 批量层：只有高频行（不命中 ERROR_LINE_RE）
      diag.write('退出冒烟 高频行 A');
      diag.write('退出冒烟 高频行 B');
      diag.write('退出冒烟 高频行 C');
    }
    const snapshot = {
      mode: CHILD_MODE,
      queuedBeforeExit: diag.status().queuedLines,
      logLines: countLines(paths.log),
      errorLines: countLines(paths.err),
      reportLines: countLines(paths.report),
      electronVersion: process.versions.electron
    };
    process.stdout.write('SNAPSHOT ' + JSON.stringify(snapshot) + '\n');
    app.exit(0);   // 关键：不手动 flush，靠模块的退出钩子 / durability 层
  }).catch((err) => {
    process.stderr.write('子模式失败：' + ((err && err.stack) || err) + '\n');
    app.exit(1);
  });
} else {
  // ── 父模式：普通 node 起 Electron 子进程并断言落盘 ──────────────────────
  const watchdog = setTimeout(() => {
    process.stderr.write(`[test-h10-electron] 超时 ${TIMEOUT_MS}ms，强制退出\n`);
    process.exit(3);
  }, TIMEOUT_MS);

  let electronExe = null;
  try { electronExe = require('electron'); } catch (_) { electronExe = null; }
  if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) {
    process.stderr.write('[test-h10-electron] 找不到 electron 可执行文件（require("electron") 返回：' + electronExe + '）\n');
    process.exit(2);
  }

  /** 起一个 Electron 子进程跑指定模式，返回 {base, paths, state, run}。 */
  function runChild(mode) {
    const base = path.join(os.tmpdir(), `dsh-h10-electron-${mode}-${process.pid}`);
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    const env = { ...process.env, DSH_EXIT_FLUSH_CHILD: mode, DSH_DIAG_BASE: base };
    delete env.DSH_DIAG_FLUSH_MS;
    delete env.DSH_DIAG_QUEUE_MAX_LINES;
    const run = spawnSync(electronExe, [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS - 5000, encoding: 'utf8' });
    const out = (run.stdout || '') + (run.stderr || '');
    let state = null;
    const line = out.split('\n').find((l) => l.trim().startsWith('SNAPSHOT '));
    if (line) { try { state = JSON.parse(line.trim().slice('SNAPSHOT '.length)); } catch (_) { state = null; } }
    return { base, paths: artifactPaths(base), state, run, out };
  }

  // ── ① 批量层：纯高频行，disk 空 → app.exit 钩子补齐 ─────────────────────
  const batch = runChild('1');
  check('① Electron 子进程正常退出（批量层）', batch.run.status === 0, '实际 status=' + batch.run.status + ' signal=' + batch.run.signal);
  check('① 退出前队列确有 4 条未落盘行（会话头 + 3 条，证明被测的是退出 flush）', !!batch.state && batch.state.queuedBeforeExit === 4,
    '实际：' + JSON.stringify(batch.state && batch.state.queuedBeforeExit));
  check('① 高频行在退出前**不在**磁盘上（批量语义未被 durable 破坏）', !!batch.state && batch.state.logLines === 0,
    '实际 logLines=' + (batch.state && batch.state.logLines));
  check('① app.exit 后主日志落盘 4 行（会话头 + 3 条）', countLines(batch.paths.log) === 4, '实际：' + countLines(batch.paths.log));
  check('① 高频行不产生错误清单/桌面报告', countLines(batch.paths.err) === 0 && countLines(batch.paths.report) === 0,
    '实际：错误清单 ' + countLines(batch.paths.err) + ' 行 / 桌面报告 ' + countLines(batch.paths.report) + ' 行');
  check('① 未触发「退出刷盘超预算」', !readIfExists(batch.paths.log).includes('退出刷盘超预算'),
    readIfExists(batch.paths.log).includes('退出刷盘超预算') ? '出现了超预算说明行' : '正文干净');

  // ── ② durability 层：错误行在**退出前**就必须全部落盘 ──────────────────
  const durable = runChild('2');
  check('② Electron 子进程正常退出（durability 层）', durable.run.status === 0, '实际 status=' + durable.run.status + ' signal=' + durable.run.signal);
  check('② 错误行不在队列里（durable 记录直写，不排队）', !!durable.state && durable.state.queuedBeforeExit === 0,
    '实际 queuedBeforeExit=' + (durable.state && durable.state.queuedBeforeExit));
  check('② 退出前主日志已落盘 4 行（会话头 + 3 条，含 durable 屏障刷出的高频行）',
    !!durable.state && durable.state.logLines === 4, '实际 logLines=' + (durable.state && durable.state.logLines));
  check('② 退出前错误清单已落盘 1 行', !!durable.state && durable.state.errorLines === 1,
    '实际 errorLines=' + (durable.state && durable.state.errorLines));
  check('② 退出前桌面报告（固定名）已落盘 2 行（头 + 1 条）', !!durable.state && durable.state.reportLines === 2,
    '实际 reportLines=' + (durable.state && durable.state.reportLines));
  check('② 主日志含 electron 真实版本号（electron.app.getVersion 路径可用）',
    /版本=\d+\.\d+\.\d+/.test(readIfExists(durable.paths.log)), '实际：' + (readIfExists(durable.paths.log).match(/版本=[\d.]+/) || ['(无)'])[0]);

  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n[test-h10-electron] 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAIL ${f.name} — ${f.detail}\n`);
    process.exit(1);
  }
  process.stdout.write('[test-h10-electron] 全部通过\n');
  process.exit(0);
}
