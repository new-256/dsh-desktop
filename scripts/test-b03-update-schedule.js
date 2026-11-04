'use strict';

/**
 * B-03 验证脚本：更新轮询的单调时钟 / 完成起算 / 指数退避 / ±20% 抖动 / 单飞 / 配置校验。
 *
 * 关键纪律：**绝不真的等 600 秒**。时钟（hrtime）、随机源、定时器、检查函数全部注入，
 * 用假时钟推进到点时再断言精确的退避序列（1200s / 2400s / 3600s / 封顶）与到期时刻。
 *
 * 运行：node scripts/test-b03-update-schedule.js   （自带 120s 防卡死超时）
 */

const { createHarness } = require('./test-h04-h05-harness');

const H = createHarness({ name: 'B-03-update-schedule', timeoutMs: 120000 });
H.startMonitor(require('path').join(H.repoRoot, '修复与借鉴_2026-11-04', '03_调试阶段'));

const sched = require('../update-schedule.js');

const MS = (n) => BigInt(Math.round(n * 1e6));   // ms → ns（BigInt）

/** 假单调时钟：只被测试推进，绝不读墙钟。 */
function makeClock(startNs = 5_000_000_000n) {
  let t = BigInt(startNs);
  return {
    hrtime: () => t,
    advance(ms) { t += MS(ms); return t; },
    now: () => t,
    set(ns) { t = BigInt(ns); }
  };
}

// ---------------------------------------------------------------------------
async function run() {
H.step('场景1 配置校验：非法值必须抛错（不静默修正）');
const bad = [
  [{ baseMs: 0 }, 'baseMs=0'],
  [{ baseMs: -1 }, 'baseMs=-1'],
  [{ baseMs: 1.5 }, 'baseMs=1.5'],
  [{ baseMs: 'abc' }, 'baseMs=abc'],
  [{ baseMs: 600000, maxBackoffMs: 1000 }, 'maxBackoffMs < baseMs'],
  [{ jitter: 1 }, 'jitter=1'],
  [{ jitter: 1.5 }, 'jitter=1.5'],
  [{ jitter: -0.1 }, 'jitter=-0.1']
];
for (const [input, label] of bad) {
  let err = null;
  try { sched.normalizeConfig(input); } catch (e) { err = e; }
  H.ok(err instanceof RangeError, `拒绝非法配置 ${label}`, err ? err.constructor.name + ': ' + err.message : '未抛错');
}
const def = sched.normalizeConfig({});
H.eq(def, { baseMs: 600000, maxBackoffMs: 3600000, jitter: 0.2 }, '默认配置 = 官方默认（600s / 3600s / 0.2）');

H.step('场景1b 环境变量覆盖：合法生效、非法显式报错');
H.eq(sched.configFromEnv({ DSH_UPDATE_BASE_MS: '5000' }).baseMs, 5000, 'DSH_UPDATE_BASE_MS 生效');
H.eq(sched.configFromEnv({ DSH_UPDATE_BASE_MS: '60000', DSH_UPDATE_MAX_MS: '120000' }), { baseMs: 60000, maxBackoffMs: 120000, jitter: 0.2 }, '两个变量同时生效');
let envErr = null;
try { sched.configFromEnv({ DSH_UPDATE_BASE_MS: '60s' }); } catch (e) { envErr = e; }
H.ok(envErr instanceof RangeError, 'DSH_UPDATE_BASE_MS=60s 显式报错', envErr && envErr.message);
let envErr2 = null;
try { sched.configFromEnv({ DSH_UPDATE_BASE_MS: '900000', DSH_UPDATE_MAX_MS: '1000' }); } catch (e) { envErr2 = e; }
H.ok(envErr2 instanceof RangeError, 'max < base 显式报错', envErr2 && envErr2.message);

// ---------------------------------------------------------------------------
H.step('场景2 指数退避：失败序列 1200s → 2400s → 3600s（封顶）→ 成功后回 600s');
const clock = makeClock();
let failMode = true;
let checkCount = 0;
const s2 = sched.createUpdateScheduler({
  baseMs: 600000,
  maxBackoffMs: 3600000,
  jitter: 0,                       // 关闭抖动，才能断言精确值
  hrtime: clock.hrtime,
  log: () => {},
  check: async () => { checkCount++; if (failMode) throw new Error('模拟网络失败'); }
});
H.eq(s2.status().currentBaseDelayMs, 600000, '初始延迟 = base 600s');
const seq = [];
for (let i = 0; i < 4; i++) {
  clock.advance(s2.msUntilDue() + 1);          // 推进到到期之后（假时钟，不真等）
  const r = await s2.runCheck('scheduled');
  H.eq(r.ok, false, `第 ${i + 1} 次失败（ok=false）`);
  seq.push(s2.status().currentBaseDelayMs);
}
H.eq(seq, [1200000, 2400000, 3600000, 3600000], '退避序列精确值（1200s→2400s→3600s→封顶 3600s）');
H.eq(s2.status().failures, 4, '连续失败计数 = 4');
failMode = false;
clock.advance(s2.msUntilDue() + 1);
await s2.runCheck('scheduled');
H.eq(s2.status().currentBaseDelayMs, 600000, '成功后立刻回到 base 600s');
H.eq(s2.status().failures, 0, '成功后失败计数清零');
H.eq(checkCount, 5, '实际检查调用次数 = 5（无重复）');

// ---------------------------------------------------------------------------
H.step('场景3 抖动：±20% 上下界 + 封顶处单边 + 不是常数');
const jitterOf = (delayMs, jitter, maxBackoffMs, random) => sched.applyJitter(delayMs, jitter, maxBackoffMs, random);
H.eq(jitterOf(1200000, 0.2, 3600000, () => 0), 960000, 'random=0 → 下界 1200s*0.8=960s');
H.eq(jitterOf(1200000, 0.2, 3600000, () => 0.9999999), 1440000, 'random→1 → 上界 1200s*1.2=1440s');
H.eq(jitterOf(3600000, 0.2, 3600000, () => 0.9999999), 3600000, '封顶处上界被 maxBackoff 夹住（单边抖动，官方语义）');
H.eq(jitterOf(3600000, 0.2, 3600000, () => 0), 2880000, '封顶处下界 3600s*0.8=2880s');
const samples = new Set();
for (let i = 0; i < 100; i++) samples.add(jitterOf(1200000, 0.2, 3600000, Math.random));
H.ok(samples.size > 1, `默认随机源下 100 次采样不是常数（实得 ${samples.size} 个不同值）`);
let outOfRange = 0;
for (let i = 0; i < 500; i++) {
  const d = jitterOf(1200000, 0.2, 3600000, Math.random);
  if (d < 960000 || d > 1440000) outOfRange++;
}
H.eq(outOfRange, 0, '500 次采样全部落在 [960s, 1440s] 内');

// ---------------------------------------------------------------------------
H.step('场景4 单飞：检查进行中再次触发只产生 1 次实际调用');
let release = null;
let invocations = 0;
const s4 = sched.createUpdateScheduler({
  jitter: 0, hrtime: makeClock().hrtime, log: () => {},
  check: () => { invocations++; return new Promise((res) => { release = res; }); }
});
const p1 = s4.runCheck('manual');
const p2 = s4.runCheck('scheduled');
await Promise.resolve();
H.eq(invocations, 1, '并发两次触发 → 实际检查调用 1 次');
H.eq(s4.status().inFlight, true, '进行中标记 inFlight=true');
release();
const [r1, r2] = await Promise.all([p1, p2]);
H.eq(r1.joined, false, '首个调用 joined=false（它是发起方）');
H.eq(r2.joined, true, '第二个调用 joined=true（并入在途请求）');
H.eq(s4.status().counters.joined, 1, 'joined 计数 = 1');
H.eq(s4.status().counters.ok, 1, '实际完成 1 次');

// ---------------------------------------------------------------------------
H.step('场景5 完成起算：慢请求不导致连发（下一次从"结束时刻"计时）');
const c5 = makeClock();
const s5 = sched.createUpdateScheduler({
  baseMs: 600000, maxBackoffMs: 3600000, jitter: 0, hrtime: c5.hrtime, log: () => {},
  check: async () => { c5.advance(30000); }     // 检查本身耗掉 30 秒
});
const startedAt = c5.now();
await s5.runCheck('scheduled');
const st5 = s5.status();
const spanMs = Number(BigInt(st5.dueAtTick) - BigInt(st5.lastCompletedTick)) / 1e6;
H.eq(spanMs, 600000, '到期时刻 = 完成时刻 + 600s（不是"发起时刻 + 600s"）');
const completedAfterStart = Number(BigInt(st5.lastCompletedTick) - startedAt) / 1e6;
H.eq(completedAfterStart, 30000, '完成时刻确实比发起晚 30s（慢请求已发生）');
H.ok(s5.isDue() === false, '完成瞬间尚未到期（慢请求不会立刻再查）');

// ---------------------------------------------------------------------------
H.step('场景6 时间回拨：不读墙钟，且单调时钟倒退也不立即重查');
const c6 = makeClock(9_000_000_000n);
const s6 = sched.createUpdateScheduler({
  baseMs: 600000, maxBackoffMs: 3600000, jitter: 0, hrtime: c6.hrtime, log: () => {},
  check: async () => {}
});
// 6a：把 Date.now 换成"被调用就爆炸"，证明节拍器完全不依赖墙钟
const realDateNow = Date.now;
let dateNowCalls = 0;
Date.now = () => { dateNowCalls++; throw new Error('调用了墙钟 Date.now()（违反 B-03 单调时钟要求）'); };
try {
  c6.advance(600001);
  const r6 = await s6.runCheck('scheduled');
  H.eq(r6.ok, true, '墙钟不可用时节拍器仍能正常运行');
} finally { Date.now = realDateNow; }
H.eq(dateNowCalls, 0, '节拍器从未调用 Date.now()');
// 6b：单调时钟被强行倒退 1 小时（模拟注入的坏时钟/乱序 tick）→ 不得立即重查
const beforeTick = s6.status().lastCompletedTick;
c6.set(BigInt(beforeTick) - MS(3600000));
H.eq(s6.isDue(), false, '时钟倒退后不得判定为"已到期"');
H.ok(s6.msUntilDue() > 0, '时钟倒退时剩余时间仍为正（不做立即重查）', s6.msUntilDue());
c6.set(BigInt(beforeTick));
H.eq(s6.isDue(), false, '回到正常时刻仍未到期（距完成不足 600s）');

// ---------------------------------------------------------------------------
H.step('场景7 start/stop：注入定时器，到期才触发且完成后再排下一次');
const c7 = makeClock();
let armed = [];
const s7 = sched.createUpdateScheduler({
  baseMs: 600000, maxBackoffMs: 3600000, jitter: 0, hrtime: c7.hrtime, log: () => {},
  setTimeoutFn: (fn, ms) => { armed.push({ fn, ms }); return { id: armed.length, unref() {} }; },
  clearTimeoutFn: () => {},
  check: async () => {}
});
s7.start();
H.eq(armed.length, 1, 'start() 立刻排了一次');
H.ok(armed[0].ms > 0 && armed[0].ms <= 600000, `首次排程等待落在 (0, 600s]（实际 ${armed[0].ms}ms）`);
const firstFn = armed[0].fn;
c7.advance(600001);
await firstFn();                       // 到期触发
H.eq(s7.status().counters.ok, 1, '到期触发了一次检查');
H.eq(armed.length, 2, '检查完成后重新排程（第二次）');
H.ok(armed[1].ms > 0 && armed[1].ms <= 600000, `第二次排程等待同样有界（实际 ${armed[1].ms}ms）`);
s7.stop();
H.eq(s7.status().started, false, 'stop() 后 started=false');

H.step('场景8 status 快照不含墙钟语义');
const st = s7.status();
H.ok(typeof st.lastCompletedTick === 'string', 'lastCompletedTick 为单调 tick 字符串（不是 ISO 时间）', st.lastCompletedTick);
H.ok(!/T\d\d:/.test(JSON.stringify(st)), 'status 中没有墙钟时间戳');



}

run().then(() => H.finish()).catch((e) => {
  console.error('脚本异常：', e && e.stack ? e.stack : e);
  H.finish();
});

