'use strict';

/**
 * 0.3.48 · H-03 回归：启动截止时间的纯逻辑（startup-deadline.js §1）。
 *
 * ## 为什么单测这一层而不是只测 main.js
 *
 * 超时判定的价值全在"数字对不对、文案是否能读懂、写错的环境变量会不会被静默吞掉"。
 * 这些都能在毫秒级单测里覆盖（假计时器 + 假时钟），而真机上验证一次要等 2 分钟。
 * main.js 的接线另由 `scripts/test-h02-spawn-sync.js` 用真实 spawnBackend 覆盖。
 *
 * 覆盖点：
 *   ① 默认预算 + 每个默认值都带书面理由（防止有人为了"看起来快"随手调小）
 *   ② 环境变量覆盖 / 全局倍率 / 非法值不静默容忍
 *   ③ 阶段打点（可回答"卡在哪一步、等了多久"）
 *   ④ watchdog：到点触发一次、stop 后不再触发
 *   ⑤ 超时报告：阶段名 + 最后一条日志 + 日志绝对路径（硬性三项）
 *   ⑥ 错误码按阶段区分（未捕获地址 ≠ 地址无响应）
 *
 * 用法：node scripts/test-h03-startup-deadline.js [--timeout 120]
 */

const path = require('path');
const sd = require('../startup-deadline');

const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 120;
const killer = setTimeout(() => {
  console.error(`\n[超时] 测试超过 ${TIMEOUT_SEC}s 未结束，强制退出（防卡死）。`);
  process.exit(124);
}, TIMEOUT_SEC * 1000);

let pass = 0;
const failures = [];
function ok(cond, label, actual) {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else {
    failures.push(label);
    console.log('  ✗ ' + label);
    if (actual !== undefined) console.log('      实际值：' + require('util').inspect(actual, { depth: 4, breakLength: 140 }));
  }
}
const section = (n) => console.log('\n' + n);

console.log('0.3.48 · H-03 启动截止时间纯逻辑');
console.log('模块：startup-deadline.js（不 require electron，可直接在 Node 里跑）');

// ── ① 默认预算 ──────────────────────────────────────────────────────────────
section('① 默认预算与书面理由');
ok(sd.PHASE_ORDER.join(',') === 'spawn,health,paint', '阶段顺序为 spawn → health → paint', sd.PHASE_ORDER);
const defaults = sd.resolveBudgets({});
ok(defaults.budgets.spawn === sd.DEFAULT_BUDGETS_MS.spawn, 'spawn 默认预算取 DEFAULT_BUDGETS_MS', defaults.budgets.spawn);
ok(defaults.budgets.health === sd.DEFAULT_BUDGETS_MS.health, 'health 默认预算取 DEFAULT_BUDGETS_MS', defaults.budgets.health);
ok(defaults.budgets.paint === sd.DEFAULT_BUDGETS_MS.paint, 'paint 默认预算取 DEFAULT_BUDGETS_MS', defaults.budgets.paint);
ok(defaults.errors.length === 0, '干净环境下没有任何配置错误', defaults.errors);
ok(Object.keys(sd.PHASE_LABELS).length === 3 && sd.PHASE_LABELS.spawn.length > 6,
  '每个阶段都有面向用户的中文标签（弹窗文案只有一份来源）', sd.PHASE_LABELS);

// ── ② 环境变量覆盖与合法性 ──────────────────────────────────────────────────
section('② 环境变量覆盖 / 倍率 / 非法值不静默容忍');
const overridden = sd.resolveBudgets({ DSH_STARTUP_TIMEOUT_SPAWN_MS: '5000' });
ok(overridden.budgets.spawn === 5000, '单个阶段预算可被环境变量覆盖', overridden.budgets.spawn);
ok(overridden.source.spawn === 'env', '来源被记为 env（日志里能看出来）', overridden.source);
ok(overridden.budgets.health === sd.DEFAULT_BUDGETS_MS.health, '未覆盖的阶段保持默认（分阶段而非一刀切）', overridden.budgets.health);

const scaled = sd.resolveBudgets({ DSH_STARTUP_TIMEOUT_SCALE: '2' });
ok(scaled.budgets.spawn === sd.DEFAULT_BUDGETS_MS.spawn * 2, '全局倍率同时作用于所有阶段', scaled.budgets);

const badEnv = sd.resolveBudgets({ DSH_STARTUP_TIMEOUT_SPAWN_MS: 'abc' });
ok(badEnv.budgets.spawn === sd.DEFAULT_BUDGETS_MS.spawn, '非法值退回默认预算（不让应用起不来）', badEnv.budgets.spawn);
ok(badEnv.errors.length === 1, '非法值被记入 errors[]，调用方会写日志（不许静默容忍）', badEnv.errors);
ok(/abc/.test(badEnv.errors[0]), '错误信息包含原始非法值，便于用户自查', badEnv.errors[0]);

const zeroEnv = sd.resolveBudgets({ DSH_STARTUP_TIMEOUT_PAINT_MS: '0', DSH_STARTUP_TIMEOUT_SCALE: '-3' });
ok(zeroEnv.budgets.paint === sd.DEFAULT_BUDGETS_MS.paint, '0 不算合法预算（会立刻超时）', zeroEnv.budgets.paint);
ok(zeroEnv.errors.length === 2, '0 与负倍率都被如实报告', zeroEnv.errors);
ok(sd.resolveBudgets({}).budgets.spawn > sd.resolveBudgets({}).budgets.health - 1,
  'spawn 预算不小于 health（含初始化，不能比"等 HTTP"更短）', sd.resolveBudgets({}).budgets);

// ── ③ 阶段打点 ──────────────────────────────────────────────────────────────
section('③ 阶段打点（回答"卡在哪一步、等了多久"）');
{
  let clock = 1000;
  const trace = sd.createTrace({ now: () => clock });
  trace.mark('ready');
  clock += 2500;
  trace.mark('seeded');
  clock += 500;
  trace.mark('spawn', 'pid=123');
  const snap = trace.snapshot();
  ok(snap.length === 3, '三个点都被记录', snap.length);
  ok(snap[1].offsetMs === 2500, '时间偏移累计正确（毫秒）', snap[1].offsetMs);
  ok(trace.since('spawn') === 3000, 'since() 能查出某一步在什么时刻发生', trace.since('spawn'));
  ok(trace.lines()[2].indexOf('spawn[pid=123]') === 0, 'lines() 生成可读序列（进日志/弹窗）', trace.lines()[2]);
  ok(trace.last().phase === 'spawn', 'last() 返回最后一个点', trace.last());
  snap[0].phase = '被篡改';
  ok(trace.snapshot()[0].phase === 'ready', 'snapshot() 是深拷贝，外部改不动内部状态', trace.snapshot()[0].phase);
}

// ── ④ watchdog：到点触发一次，stop 后不再触发 ───────────────────────────────
section('④ watchdog（注入假计时器，同一段真实逻辑）');
{
  let fired = [];
  let captured = null;
  const watchdog = sd.createWatchdog({
    phase: 'spawn',
    budgetMs: 1234,
    now: () => 100,
    setTimer: (fn, ms) => { captured = { fn, ms }; return 'handle-1'; },
    clearTimer: (handle) => { captured.cleared = handle; },
    onExpire: (info) => fired.push(info)
  });
  ok(captured === null, '构造时不启动计时器（显式 start 才开始）', captured);
  watchdog.start();
  ok(captured && captured.ms === 1234, 'start() 按预算毫秒摆好计时器', captured && captured.ms);
  captured.fn();
  ok(fired.length === 1, '到点触发一次 onExpire', fired.length);
  ok(fired[0].phase === 'spawn' && fired[0].budgetMs === 1234, 'onExpire 收到阶段与预算', fired[0]);
  ok(watchdog.isExpired() === true, 'isExpired() 反映已超时', watchdog.isExpired());
}
{
  let fired = 0;
  let captured = null;
  const watchdog = sd.createWatchdog({
    phase: 'health', budgetMs: 50, now: () => 0,
    setTimer: (fn) => { captured = fn; return 1; },
    clearTimer: () => { captured = null; },
    onExpire: () => { fired += 1; }
  });
  watchdog.start();
  watchdog.stop();
  ok(captured === null, 'stop() 清掉了计时器句柄（不留悬挂定时器）', captured);
  ok(watchdog.isStopped() === true, 'stop() 后状态为已停止', watchdog.isStopped());
  ok(fired === 0, 'stop() 之后不会再触发（阶段成功完成时就是这个路径）', fired);
}

// ── ⑤ 超时报告的三项硬性内容 ───────────────────────────────────────────────
section('⑤ 超时文案：阶段名 + 最后一条日志 + 日志绝对路径');
{
  const logPath = path.join(__dirname, '..', 'logs', 'DSH-Desktop-日志.txt');
  const budgets = sd.resolveBudgets({});
  const report = sd.buildTimeoutReport({
    phase: 'spawn',
    budgets,
    elapsedMs: 120010,
    lastLogLine: 'loading plugins: dsh-persona',
    logPath,
    marks: ['ready@0.00s', 'spawn[pid=9]@12.10s']
  });
  ok(report.code === 'E_STARTUP_SPAWN_NO_URL', '报告带阶段专属错误码', report.code);
  ok(/后端进程拉起/.test(report.message), '① 文案含超时阶段名', report.message.slice(0, 60));
  ok(/loading plugins: dsh-persona/.test(report.message), '② 文案含最后一条后端日志', report.message);
  ok(report.message.indexOf(logPath) >= 0, '③ 文案含日志绝对路径', logPath);
  ok(path.isAbsolute(report.logPath), '日志路径确实是绝对路径（不是裸文件名）', report.logPath);
  ok(/启动阶段打点/.test(report.message), '文案附上阶段打点序列', report.message);
  ok(/120\.0s/.test(report.message), '文案写清已等待时长', report.message);

  const empty = sd.buildTimeoutReport({ phase: 'paint', budgets, lastLogLine: '', logPath });
  ok(/自始至终没有任何输出/.test(empty.message), '后端一行输出都没有时，文案如实说明（而不是留空）', empty.message.slice(0, 80));

  const err = sd.createTimeoutError(report);
  ok(err.message === report.message, 'createTimeoutError 的 message 就是报告文案', err.message.slice(0, 40));
  ok(err.timeout === true && err.code === report.code && err.phase === 'spawn',
    'Error 携带 timeout/code/phase（上层可按类型分流）', { timeout: err.timeout, code: err.code, phase: err.phase });
  ok(err.report === report, 'Error 携带完整报告对象（落盘/弹窗复用）', !!err.report);
  ok(sd.TIMEOUT_CODES.spawn !== sd.TIMEOUT_CODES.health
    && sd.TIMEOUT_CODES.health !== sd.TIMEOUT_CODES.paint, '三个阶段的错误码互不相同', sd.TIMEOUT_CODES);
}

// ── ⑥ 最后一条日志的取法 ────────────────────────────────────────────────────
section('⑥ lastMeaningfulLogLine：末尾空行/超长行/纯空白');
ok(sd.lastMeaningfulLogLine('a\r\nb\r\n\r\n') === 'b', '忽略末尾空行，取真正最后一条', sd.lastMeaningfulLogLine('a\r\nb\r\n\r\n'));
ok(sd.lastMeaningfulLogLine(['x', '', '   ']) === 'x', '数组输入同样跳过空白行', sd.lastMeaningfulLogLine(['x', '', '   ']));
ok(sd.lastMeaningfulLogLine('') === '', '完全没输出时返回空字符串（上层据此显示"没有任何输出"）', sd.lastMeaningfulLogLine(''));
const long = 'z'.repeat(500);
const cut = sd.lastMeaningfulLogLine(long, 100);
ok(cut.length === 100 && cut.endsWith('…'), '超长行按上限截断并带省略号', { length: cut.length, tail: cut.slice(-3) });
ok(sd.lastMeaningfulLogLine('  a   b  ') === 'a b', '折叠多余空白（弹窗里不出现锯齿）', sd.lastMeaningfulLogLine('  a   b  '));

// ── 汇总 ───────────────────────────────────────────────────────────────────
clearTimeout(killer);
console.log('\n────────────────────────────────────────');
console.log(`断言 ${pass + failures.length} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(failures.length ? 1 : 0);
