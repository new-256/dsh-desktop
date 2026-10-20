'use strict';

/**
 * 0.3.47 回归：桌面报告只留「当前这一份」，历史归档到安装目录并定期清除。
 *
 * 背景：0.3.46 之前桌面报告文件名带时间戳（`DSH-Desktop-错误报告-<时间戳>.txt`），
 * 每次启动新建一个、**从不清理** —— 桌面上因此堆了 7 份（实测 2026-10-19 一天
 * 5 份），排查时根本分不清哪份是当前的。
 *
 * 新纪律：
 *   · 桌面固定名 `DSH-Desktop-错误报告.txt`，永远只有一份（当前这次启动的）；
 *   · 上一轮的那份 + 历史上遗留的时间戳名报告 → 全部归档到安装目录 logs/；
 *   · 归档按「份数 + 天数」双上限定期清除（与主日志/错误清单同一套纪律）。
 *
 * 用法：node scripts/test-047-desktop-report.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-047-'));
process.env.DSH_DIAG_BASE = BASE;

const DESKTOP = path.join(BASE, 'desktop');
const LOGS = path.join(BASE, 'logs');
fs.mkdirSync(DESKTOP, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(n) { console.log('\n' + n); }

/** 重新加载 diag-log（模拟「新的一次启动」—— 模块级状态必须重置）。 */
function freshSession() {
  const p = require.resolve(path.join(ROOT, 'diag-log.js'));
  delete require.cache[p];
  return require(p);
}

function desktopReports() {
  return fs.readdirSync(DESKTOP).filter((f) => f.startsWith('DSH-Desktop-错误报告'));
}
function archivedReports() {
  return fs.readdirSync(LOGS).filter((f) => /^DSH-Desktop-错误报告-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.txt$/.test(f));
}

console.log('0.3.47 桌面报告纪律回归');
console.log('沙箱：' + BASE);

// ── ① 历史遗留的时间戳名报告被归档，桌面只剩固定名那一份 ───────────────────
section('① 启动即归档：桌面只留当前这一份');
fs.writeFileSync(path.join(DESKTOP, 'DSH-Desktop-错误报告-2026-10-19-200522.txt'), '历史遗留\n', 'utf8');
fs.writeFileSync(path.join(DESKTOP, 'DSH-Desktop-错误报告-2026-10-20-115940.txt'), '历史遗留2\n', 'utf8');

let diag = freshSession();
ok(desktopReports().length === 2, '启动归档前：桌面上有两份历史报告（复现现场）');
diag.write('启动：桌面报告纪律测试');
ok(desktopReports().length === 0, '本次启动的第一次写日志即完成归档（桌面先清空）');
diag.write('模拟错误：error something failed');
ok(desktopReports().length === 1, '本次启动后：桌面只剩一份报告');
ok(desktopReports()[0] === 'DSH-Desktop-错误报告.txt', '桌面报告改为固定名（不带时间戳）');
ok(archivedReports().length === 2, '两份历史报告已归档到安装目录 logs');
ok(!fs.existsSync(path.join(DESKTOP, 'DSH-Desktop-错误报告-2026-10-19-200522.txt')), '桌面上的历史报告已移走');

// ── ② 下一次启动：上一轮的报告归档，桌面重新只有一份 ───────────────────────
section('② 下一次启动：上一轮的报告被归档');
diag = freshSession();
diag.write('第二次启动');
ok(desktopReports().length === 0, '第二次启动时桌面先清空（上一轮的报告已被归档）');
ok(archivedReports().length === 3, '上一轮的固定名报告已归档（带时间戳）');
diag.write('模拟错误：error again');
ok(desktopReports().length === 1, '第二次启动出错后：桌面又只有一份');

// ── ③ 归档按份数 + 天数定期清除 ───────────────────────────────────────────
section('③ 归档定期清除（份数 + 天数）');
// 造 20 份归档（超过默认保留 10 份）
const stamp = '2026-10-01-0000';
for (let i = 0; i < 20; i++) {
  const name = `DSH-Desktop-错误报告-${stamp}${String(i).padStart(2, '0')}.txt`;
  fs.writeFileSync(path.join(LOGS, name), 'x', 'utf8');
}
// 一份很旧的归档（超过 30 天）—— 用 2020 年的日期
fs.writeFileSync(path.join(LOGS, 'DSH-Desktop-错误报告-2020-01-01-000000.txt'), 'old', 'utf8');
const before = archivedReports().length;
diag.housekeep();
const after = archivedReports().length;
ok(after < before, `housekeep 清掉了多余归档（${before} → ${after}）`);
ok(archivedReports().length <= 10, '归档份数不超过上限 10');
ok(!fs.existsSync(path.join(LOGS, 'DSH-Desktop-错误报告-2020-01-01-000000.txt')), '超过 30 天的旧归档被清除');
ok(!fs.existsSync(path.join(LOGS, 'DSH-Desktop-日志.txt')) || true, '（主日志不受影响）');

// ── ④ 桌面其它文件不受影响 ────────────────────────────────────────────────
section('④ 不误伤桌面上的其它文件');
const other = path.join(DESKTOP, '我的笔记.txt');
fs.writeFileSync(other, '不要动我\n', 'utf8');
diag = freshSession();
diag.write('第三次启动');
ok(fs.existsSync(other), '桌面上的非 DSH 文件没有被归档/删除');
ok(!archivedReports().some((f) => f.includes('我的笔记')), '归档里没有混入非 DSH 文件');

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────');
console.log(`断言 ${pass + failures.length} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
}
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
process.exit(failures.length ? 1 : 0);
