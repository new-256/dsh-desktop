'use strict';

// @launcher electron —— 本文件必须在**真实 Electron 主进程**里跑：
// 验证「真机 fatal → crash-report 真的落盘 → 报告里真的有插件操作段」这条端到端路径。

/**
 * B-04 真机证据：真实 Electron 里触发一次崩溃报告落盘，确认插件操作段（含
 * `context, not proof of cause` 标题、省略计数、收集完成标记）真的在文件里，
 * 且基础报告段完好、附加段在基础报告之后、台账段文件确实落在磁盘上。
 *
 * 为什么要真机：`crash-report.crashDir()` 走 `electron.app.getAppPath()/getPath('userData')`，
 * 纯 Node 环境下这条路径根本走不到；而"报告有没有插件操作段"必须发生在**真实的
 * 崩溃写盘路径**上才算证据（模拟浏览器环境或用 mock fs 都不算）。
 *
 * 用法：node_modules\electron\dist\electron.exe scripts/test-b04-crash-report-electron.js
 * 超时：默认 120s（DSH_TEST_TIMEOUT_MS 可调）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const TIMEOUT_MS = parseInt(process.env.DSH_TEST_TIMEOUT_MS || '120000', 10) || 120000;
const watchdog = setTimeout(() => {
  process.stderr.write(`[test-b04-electron] 超时 ${TIMEOUT_MS}ms，强制退出\n`);
  process.exit(3);
}, TIMEOUT_MS);
watchdog.unref();

const ROOT = path.join(__dirname, '..');
const BASE = path.join(os.tmpdir(), `dsh-b04-electron-${process.pid}`);
const DIAG_BASE = path.join(BASE, 'diag');
const CRASH_BASE = path.join(BASE, 'crash');
process.env.DSH_DIAG_BASE = DIAG_BASE;
process.env.DSH_CRASH_DIR = CRASH_BASE;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const show = detail && (!ok || detail.startsWith('实际'));
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${show ? ' — ' + detail : ''}\n`);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
    fs.mkdirSync(BASE, { recursive: true });

    const journal = require(path.join(ROOT, 'plugin-journal.js'));
    const crash = require(path.join(ROOT, 'crash-report.js'));

    // 造一段可归因的历史：装了两个、隔离失败一个（失败带原因码）
    journal.record({ action: 'install', plugin: 'dsh-chrome', version: '0.1.3', source: 'registry', result: 'ok', phase: 'startup' });
    journal.record({ action: 'enable', plugin: 'dsh-chrome', version: '0.1.3', source: 'profile', result: 'ok', phase: 'startup' });
    journal.record({ action: 'isolate', plugin: 'bad-plugin', version: '9.9.9', source: 'local', result: { status: 'fail', code: 'EISOLATE' }, phase: 'startup' });
    journal.record({ action: 'startup-skip', plugin: 'bad-plugin', version: '9.9.9', source: 'local', result: 'ok', phase: 'startup' });

    const error = new Error('simulated fatal for B-04 real-machine evidence');
    error.stack = 'Error: simulated fatal\n    at startBackendWithHealing (main.js:1:1)\n    at async bootstrap (main.js:2:2)';
    const file = crash.writeCrashReport({
      source: 'main',
      phase: 'startup',
      error,
      backendReady: false,
      backendLogTail: 'backend tail line for b04',
      rendererConsole: ['renderer error for b04']
    });

    check('真机：crash-report 在真实 Electron 里落盘成功', !!file && fs.existsSync(file), '实际：' + file);
    const content = file ? fs.readFileSync(file, 'utf8') : '';

    check('真机：报告目录来自 crashDir()（真实路径契约）', !!file && path.dirname(file) === path.resolve(CRASH_BASE),
      '实际目录=' + (file ? path.dirname(file) : '(无)'));
    check('真机：含 context, not proof of cause 标题（官方原话）',
      content.includes('recent plugin operations (context, not proof of cause)'),
      '实际：' + (content.split('\n').find((l) => l.includes('recent plugin operations')) || '(无)'));
    check('真机：四个动作都出现在报告里', ['install', 'enable', 'isolate', 'startup-skip'].every((a) => content.includes(' ' + a + ' ')),
      '实际：' + JSON.stringify(['install', 'enable', 'isolate', 'startup-skip'].filter((a) => !content.includes(' ' + a + ' '))));
    check('真机：失败原因码可见（可归因）', content.includes('EISOLATE'), '实际：' + (content.includes('EISOLATE') ? '有' : '无'));
    check('真机：含收集完成标记', /\[collection complete\]/.test(content),
      '实际：' + ((content.match(/\[collection complete\][^\n]*/) || ['(无)'])[0]));
    check('真机：基础报告段完好（error / backend tail / renderer console 都在）',
      content.includes('----- error -----') && content.includes('backend tail line for b04') && content.includes('renderer error for b04'),
      '实际：' + JSON.stringify({
        error: content.includes('----- error -----'),
        tail: content.includes('backend tail line for b04'),
        renderer: content.includes('renderer error for b04')
      }));
    check('真机：附加段在基础报告之后（追加而非插入）',
      content.indexOf('----- error -----') < content.indexOf('recent plugin operations'),
      '实际：error@' + content.indexOf('----- error -----') + ' ops@' + content.indexOf('recent plugin operations'));
    check('真机：报告里没有凭据样式内容', !/token\s*[:=]\s*[A-Za-z0-9]{6,}/iu.test(content) && !content.includes('abc123supersecret'),
      '实际：' + (/token\s*[:=]\s*[A-Za-z0-9]{6,}/iu.test(content) ? '发现疑似凭据' : '干净'));

    // 台账段文件确实落在磁盘上（2 段上限、目录在 diag logs 下）
    const ledgerDir = journal.journalDir();
    const segs = fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter((n) => /^plugin-operations-\d+\.log$/.test(n)) : [];
    check('真机：台账段文件已落盘（≤2 段）', segs.length >= 1 && segs.length <= 2, '实际：' + JSON.stringify(segs) + ' dir=' + ledgerDir);
    check('真机：台账目录与诊断日志同域（logs/plugin-operations）', ledgerDir.replace(/\\/gu, '/').endsWith('/logs/plugin-operations'),
      '实际：' + ledgerDir);

    // 1s 预算的 bounded 写路径仍然可用（基础报告 + 台账排空 + 追加都在预算内）
    const t0 = Date.now();
    const file2 = await crash.writeCrashReportBounded({
      source: 'main', phase: 'running', error: new Error('bounded path check'), backendReady: true,
      backendLogTail: '', rendererConsole: []
    }, crash.CRASH_REPORT_WAIT_MS);
    const ms = Date.now() - t0;
    check('真机：writeCrashReportBounded 在 1s 预算内返回路径', !!file2 && fs.existsSync(file2) && ms <= crash.CRASH_REPORT_WAIT_MS + 250,
      `实际：${ms}ms file=${file2}`);
    const content2 = file2 ? fs.readFileSync(file2, 'utf8') : '';
    check('真机：bounded 路径写出的报告同样带插件操作段', content2.includes('recent plugin operations (context, not proof of cause)'),
      '实际：' + (content2.includes('recent plugin operations') ? '有' : '无'));
  } catch (err) {
    process.stderr.write('[test-b04-electron] 未捕获异常：' + ((err && err.stack) || err) + '\n');
    results.push({ name: '未捕获异常', ok: false, detail: String((err && err.message) || err) });
  }

  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n[test-b04-electron] 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  process.stdout.write('[test-b04-electron] 临时目录：' + BASE + '\n');
  for (const f of failed) process.stdout.write(`  FAIL ${f.name} — ${f.detail}\n`);
  process.stdout.write(failed.length ? '[test-b04-electron] 存在失败\n' : '[test-b04-electron] 全部通过\n');
  app.exit(failed.length ? 1 : 0);
}).catch((err) => {
  process.stderr.write('[test-b04-electron] whenReady 失败：' + ((err && err.stack) || err) + '\n');
  app.exit(1);
});
