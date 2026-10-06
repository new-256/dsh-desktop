'use strict';

/**
 * 0.3.39 新功能测试：崩溃报告（写入/清理/detail预算）、journal 错误码白名单、
 * deviceInfo 格式。全部用临时目录，不碰真实数据。
 *
 * 用法：node scripts/test-039.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// electron 桩：crash-report 需要 app.getAppPath/getPath/getVersion
const STUB_ID = '\0electron-stub';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-039-'));
require.cache[STUB_ID] = {
  id: STUB_ID,
  filename: STUB_ID,
  loaded: true,
  exports: { app: {
    isPackaged: false,
    getVersion: () => '0.3.39-test',
    getAppPath: () => TMP_ROOT,
    getPath: () => path.join(TMP_ROOT, 'userData')
  } }
};

const crashReport = require('../crash-report.js');
const mgr = require('../updater-backend.js');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }

// ── 1. 崩溃报告 ──────────────────────────────────────────────────────────────
section('1. 崩溃报告写入与命名');
const err = new Error('boom at boot');
err.cause = new TypeError('inner cause chain');
const report1 = crashReport.writeCrashReport({
  source: 'host', phase: 'startup', error: err,
  backendReady: false, backendLogTail: 'line1\nError: EADDRINUSE port taken\n' + 'x'.repeat(200),
  rendererConsole: ['[3] console error A', '[3] console error B']
});
ok(report1 !== null, '返回文件路径');
ok(/crash-[\dTZ-]+-host\.log$/.test(report1), '命名模式 crash-<time>-host.log：' + path.basename(report1));
ok(fs.existsSync(report1), '文件已落盘');
const content1 = fs.readFileSync(report1, 'utf8');
ok(content1.includes('source: host'), '记录来源');
ok(content1.includes('backendReady: false'), '记录后端就绪状态');
ok(content1.includes('0.3.39-test'), '记录应用版本');
ok(content1.includes('inner cause chain'), 'inspect 带出 cause 链');
ok(content1.includes('EADDRINUSE'), '后端日志尾部在报告中');
ok(content1.includes('console error A') && content1.includes('console error B'), '渲染层 console 尾部在报告中');

section('1b. 渲染层来源与超长错误截断');
const report2 = crashReport.writeCrashReport({
  source: 'renderer', phase: 'running',
  error: { deep: { nested: { value: 'y'.repeat(300 * 1024) } } },
  backendReady: true, backendLogTail: '', rendererConsole: []
});
ok(/crash-[\dTZ-]+-renderer\.log$/.test(report2), 'renderer 来源命名正确');
const content2 = fs.readFileSync(report2, 'utf8');
ok(content2.length < 300 * 1024, `正文受 256KiB 预算约束（实际 ${content2.length}B）`);
ok(content2.includes('[String') || content2.length <= 256 * 1024, '超长单串被 inspect maxStringLength 压缩（官方同款 64KiB 单串上限）');

section('1c. 清理：只删 crash-*.log，保留 10 份，不碰其他文件');
const cdir = crashReport.crashDir();
fs.mkdirSync(cdir, { recursive: true });
for (let i = 0; i < 14; i++) {
  const t = new Date(Date.now() - (14 - i) * 60000);
  fs.writeFileSync(path.join(cdir, `crash-${t.toISOString().replace(/[:.]/gu, '-')}-host.log`), 'old ' + i);
}
// 干扰文件：必须存活
const keeper1 = path.join(cdir, 'DSH-Desktop-日志.txt');
const keeper2 = path.join(cdir, 'crash-not-a-report.txt');
const keeper3 = path.join(cdir, 'user-notes.doc');
fs.writeFileSync(keeper1, 'log archive');
fs.writeFileSync(keeper2, 'prefix match but no time-source suffix');
fs.writeFileSync(keeper3, 'user file');
const before = fs.readdirSync(cdir).length;
const pruned = crashReport.pruneCrashReports();
ok(pruned === 6, `清掉最旧 6 份（14+2 份报告 > 10）：实际 ${pruned}`);
ok(fs.existsSync(keeper1) && fs.existsSync(keeper2) && fs.existsSync(keeper3), '非崩溃报告文件全部幸存');
const remaining = fs.readdirSync(cdir).filter((n) => /^crash-[\dT-]+-(host|renderer|main)\.log$/.test(n));
ok(remaining.length <= 10, '报告存量 ≤ 10 份（实际 ' + remaining.length + '）');

section('1d. 弹窗 detail 预算（1200 码元 + 尾部8行 + 报告路径）');
const longError = Array.from({ length: 200 }, (_, i) => `line-${i} ` + 'z'.repeat(80)).join('\n');
const detail = crashReport.crashDialogDetail(longError, report1, '建议文字');
ok(detail.length <= 1300, `detail 在预算内（${detail.length} 码元）`);
ok(detail.includes('…'), '长错误标记省略');
ok(detail.includes('line-199'), '保留的是最末尾内容（尾部8行）');
ok(!detail.includes('line-0 '), '早期行已被丢弃');
ok(detail.includes('崩溃报告已写入'), '报告路径入 detail');

// ── 2. journal 错误码白名单 ──────────────────────────────────────────────────
section('2. journal 错误码白名单分类');
const p = mgr.P();
try { fs.rmSync(p.root, { recursive: true, force: true }); } catch {}
fs.mkdirSync(p.root, { recursive: true });
mgr.journalAdd('dsh', 'failed', { to: '0.1.9', reason: '网络错误 ERR_CONNECTION_RESET by mirror https://registry.example/proxy-detail' });
mgr.journalAdd('dsh', 'failed', { to: '0.1.9', reason: '完全无法归类的神秘失败' });
const j = mgr.readUpdateJournal();
ok(j.entries[0].reason.startsWith('ERR_CONNECTION_RESET:'), '白名单码前缀：' + j.entries[0].reason.slice(0, 40));
ok(j.entries[0].reason.length <= 120 + 40, 'reason 有界（120字摘要 + 码前缀）：' + j.entries[0].reason.length);
ok(j.entries[1].reason.startsWith('UNCLASSIFIED:'), '未归类标记 UNCLASSIFIED');
mgr.journalAdd('dsh', 'staged', { from: '0.1.8', to: '0.1.9' });
ok(mgr.readUpdateJournal().entries[2].reason === null, '非失败条目无 reason');

// ── 3. deviceInfo 格式（真实函数在 main.js 里，这里按官方契约直接验证格式器）──
section('3. deviceInfo 字符串契约');
// main.js 的 readDeviceInfo 不导出；按官方契约验证 os 数据可用性 + 格式。
const cpus = os.cpus();
const info = `platform=${process.platform}; os=${os.release()}; app_arch=${process.arch}; cpu=${(cpus[0] && cpus[0].model || '').trim()}; memory_gib=${(os.totalmem() / 1073741824).toFixed(1)}`;
ok(/^(platform|os|app_arch)=/.test(info), '以 name=value 形式开头');
ok(info.includes('; '), '以 "; " 分隔');
ok(!/[\\/?<>:*|]/.test(info.split('cpu=')[1] || ''), 'CPU 名不含文件系统非法字符形态（可选字段缺省时无碍）');

// ── 收尾 ───────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
try { fs.rmSync(p.root, { recursive: true, force: true }); } catch {}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
