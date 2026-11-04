'use strict';

/**
 * 更新检查节拍器（0.3.49 · B-03）。
 *
 * ## 它为什么存在
 *
 * 旧实现是 `setTimeout(check, 5000)` + `setInterval(check, 6h)`（main.js 原 1963-1964）：
 *  - **固定节拍**：弱网/代理环境下失败也照 6 小时重来，用户要么永远等不到提示，要么
 *    一出现就已经过期；
 *  - **`Date.now()` 语义**：系统时间被校时/NTP 拉回、用户手动改时区，间隔会算错；
 *  - **无单飞**：`setInterval` 不关心上一次是否还在跑，慢请求会叠起来连发（镜像站最先
 *    感受到的就是这种"同一台机器并发几份"的流量）；
 *  - **无抖动**：所有机器同时装好、同时检查，镜像侧是整齐的尖峰。
 *
 * 因此这里把「何时检查」抽成**纯逻辑 + 依赖注入**：时钟（单调 / 墙钟）、随机源、
 * 定时器、检查函数全部可替换，测试用假时钟推进就能断言精确退避序列，不需要真的等
 * 600 秒。
 *
 * ## 语义（逐条对应官方 update-schedule.ts）
 *
 * 1. **单调时钟**：默认 `process.hrtime.bigint()`（纳秒 BigInt）。本模块**从不**读
 *    `Date.now()`——系统时间跳变影响不到间隔（官方 `:44-48` 用 `performance.now()`）。
 * 2. **完成起算**：下一次到期时刻 = **上一次检查结束**的单调时刻 + 延迟，不是从发起
 *    起算。慢请求（比如 30s 才回来）不会让下一次立刻又到期（官方 `:87` 注释）。
 * 3. **指数退避**：初始延迟 = base（默认 600s）；连续失败一次 = `min(max, delay*2)`，
 *    即 1200s → 2400s → 3600s（上限封顶）；成功立刻回到 base（官方 `:93`）。
 * 4. **±20% 抖动**：`lower = max(1000, delay*(1-j))`、`upper = min(max, delay*(1+j))`，
 *    取 `round(lower + (upper-lower)*random())`（官方 `:94-96`，上限处抖动是单边的，
 *    这是官方原本的行为，不做"改良"）。
 * 5. **单飞**：检查进行中再次触发 → 复用同一个在途 promise，只记 joined 次数与日志，
 *    **绝不**并发第二次。
 * 6. **配置显式校验**：非法值（非整数 / ≤0 / max<base / jitter 越界 / 环境变量不是纯数字）
 *    一律抛 `RangeError`，不做静默修正（PROJECT_RULES §4）。
 *
 * ## 不用它做的事情
 *
 * 它只决定**何时**检查，不改「检查到更新后要不要下载」（通知制语义不变）。
 */

/** 官方默认值：intervalMs = 600_000、maxBackoffMs ≥ 3_600_000、jitter = 0.2。 */
const DEFAULT_BASE_MS = 600000;
const DEFAULT_MAX_MS = 3600000;
const DEFAULT_JITTER = 0.2;
/** 抖动下界的绝对地板：防止 base 被环境变量调极小后算出非正延迟。 */
const MIN_FLOOR_MS = 1000;

/** 把「必须是正的有限整数毫秒」这件事收紧成一条可复用的校验。 */
function requirePositiveIntMs(name, value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new RangeError(`${name} 必须是正整数毫秒（实际 ${JSON.stringify(value)}）`);
  }
  return n;
}

/**
 * 归一化并校验配置。**非法即抛**（官方 update-schedule.ts:23-25 同样直接抛错）：
 * 静默纠正会让"我明明配了 30 分钟"在实际运行时变成别的值，比直接失败更难排查。
 *
 * @param {{baseMs?: number, maxBackoffMs?: number, jitter?: number}} input
 * @returns {{baseMs: number, maxBackoffMs: number, jitter: number}}
 */
function normalizeConfig(input = {}) {
  const baseMs = requirePositiveIntMs('baseMs', input.baseMs === undefined ? DEFAULT_BASE_MS : input.baseMs);
  const maxRaw = input.maxBackoffMs === undefined ? Math.max(baseMs, DEFAULT_MAX_MS) : input.maxBackoffMs;
  const maxBackoffMs = requirePositiveIntMs('maxBackoffMs', maxRaw);
  if (maxBackoffMs < baseMs) throw new RangeError(`maxBackoffMs (${maxBackoffMs}) 不得小于 baseMs (${baseMs})`);
  const jitter = input.jitter === undefined ? DEFAULT_JITTER : Number(input.jitter);
  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
    throw new RangeError(`jitter 必须落在 [0, 1)（实际 ${JSON.stringify(input.jitter)}）`);
  }
  return { baseMs, maxBackoffMs, jitter };
}

/**
 * 从环境变量读节拍配置。
 *
 * 非法值**显式报错**（不是回落到默认）：用户设了 `DSH_UPDATE_BASE_MS=60s` 却以为生效，
 * 这种"配了等于没配"在排障时最费时间。只接受纯数字（十进制整数毫秒）。
 *
 * @param {Record<string,string|undefined>} env
 * @param {{baseMs?: number, maxBackoffMs?: number, jitter?: number}} [defaults]
 */
function configFromEnv(env = process.env, defaults = {}) {
  const pick = (name) => {
    const raw = env && env[name];
    if (raw === undefined || raw === null || raw === '') return defaults[name === 'DSH_UPDATE_BASE_MS' ? 'baseMs' : 'maxBackoffMs'];
    if (!/^\d+$/.test(String(raw).trim())) {
      throw new RangeError(`${name} 必须是十进制整数毫秒（实际 ${JSON.stringify(raw)}）`);
    }
    return Number(String(raw).trim());
  };
  return normalizeConfig({
    baseMs: pick('DSH_UPDATE_BASE_MS'),
    maxBackoffMs: pick('DSH_UPDATE_MAX_MS'),
    jitter: defaults.jitter
  });
}

/**
 * 对一个"未抖动的延迟"施加抖动。
 * 口径与官方 `:94-96` 完全一致：lower 有 1s 地板、upper 受 maxBackoffMs 封顶，
 * 因此 **在封顶处抖动是单边的**（只能变短）—— 这是刻意的，不"改良"。
 */
function applyJitter(delayMs, jitter, maxBackoffMs, random) {
  const floor = Math.min(MIN_FLOOR_MS, delayMs);
  const lower = Math.max(floor, delayMs * (1 - jitter));
  const upper = Math.min(maxBackoffMs, delayMs * (1 + jitter));
  const span = Math.max(0, upper - lower);
  return Math.round(lower + span * random());
}

/**
 * 创建一个更新检查节拍器。
 *
 * @param {object} opts
 * @param {() => Promise<any>} opts.check            真正执行一次检查（抛错 = 失败）
 * @param {() => bigint} [opts.hrtime]               单调时钟（默认 process.hrtime.bigint）
 * @param {() => number} [opts.random]               随机源，返回 [0,1)（默认 Math.random）
 * @param {number} [opts.baseMs]                     基础间隔（默认 600_000）
 * @param {number} [opts.maxBackoffMs]               退避上限（默认 max(base, 3_600_000)）
 * @param {number} [opts.jitter]                     抖动幅度（默认 0.2）
 * @param {(msg: string, detail?: any) => void} [opts.log]
 * @param {(fn: Function, ms: number) => any} [opts.setTimeoutFn]   默认 setTimeout
 * @param {(handle: any) => void} [opts.clearTimeoutFn]             默认 clearTimeout
 */
function createUpdateScheduler(opts = {}) {
  const cfg = normalizeConfig(opts);
  const hrtime = opts.hrtime || (() => process.hrtime.bigint());
  const random = opts.random || Math.random;
  const log = opts.log || ((msg, detail) => console.log('[update-schedule]', msg, detail === undefined ? '' : detail));
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  if (typeof opts.check !== 'function') throw new TypeError('createUpdateScheduler: 必须提供 check 函数');

  /** 衰减后的「未抖动」延迟（指数退避的结果），单位 ms。 */
  let delayMs = cfg.baseMs;
  let failures = 0;
  let lastError = null;
  /** 上一次检查**结束**的单调时刻（ns）。null = 还没跑过（视为立刻到期）。 */
  let lastCompletedNs = null;
  /** 下一次到期时刻（ns）= lastCompletedNs + 抖动后的延迟。 */
  let dueAtNs = null;
  let inFlight = null;
  let timer = null;
  let started = false;
  const counters = { ok: 0, failed: 0, joined: 0, skipped: 0 };

  const nowNs = () => BigInt(hrtime());

  /** 失败：`min(max, delay*2)`；成功：回到 base（官方 :93 同一行三元式）。 */
  function advanceDelay(failed) {
    delayMs = failed ? Math.min(cfg.maxBackoffMs, delayMs * 2) : cfg.baseMs;
  }

  function scheduleDeadline(completedNs) {
    const delay = applyJitter(delayMs, cfg.jitter, cfg.maxBackoffMs, random);
    dueAtNs = completedNs + BigInt(Math.round(delay * 1e6));
    return delay;
  }

  async function executeCheck(reason) {
    let ok = true;
    let error = null;
    try {
      await opts.check(reason);
      counters.ok++;
    } catch (e) {
      ok = false;
      counters.failed++;
      error = e;
      lastError = (e && e.message) || String(e);
      log('检查失败（进入退避）', { reason, error: lastError, failures: failures + 1 });
    } finally {
      advanceDelay(!ok);
      failures = ok ? 0 : failures + 1;
      // 完成起算：以**结束时刻**为基准，慢请求不会导致连发。
      lastCompletedNs = nowNs();
      const delay = scheduleDeadline(lastCompletedNs);
      log('本次检查结束', { reason, ok, nextBaseMs: delayMs, nextDelayMs: delay });
    }
    return { ok, error, joined: false, baseDelayMs: delayMs };
  }

  /**
   * 跑一次检查。单飞：进行中再次触发 → 复用同一个在途 promise（只记 joined）。
   * 返回值里的 `joined=true` 让调用方知道"这次不是我发起的网络请求"。
   */
  async function runCheck(reason = 'scheduled') {
    if (inFlight) {
      counters.joined++;
      log('检查正在进行中，本次并入（单飞）', { reason });
      const r = await inFlight;
      return { ...r, joined: true };
    }
    inFlight = executeCheck(reason);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  /** 距离下一次到期还有多少毫秒（≥0，向上取整）。时钟回拨/乱序时按 0 处理 —— 绝不"立即重查"。 */
  function msUntilDue(now = null) {
    if (dueAtNs === null) return 0;
    const cur = now === null ? nowNs() : BigInt(now);
    const remainNs = dueAtNs - cur;
    if (remainNs <= 0n) return 0;
    // 向上取整：4000001ns 应等 5ms 而不是 4ms，否则定时器可能早醒 1ms 变成忙转。
    return Number((remainNs + 999999n) / 1000000n);
  }

  function isDue(now = null) {
    if (dueAtNs === null) return true;
    const cur = now === null ? nowNs() : BigInt(now);
    return cur >= dueAtNs;
  }

  /** 启动常驻节拍（生产路径）。到期 → runCheck → 完成后再排下一次。 */
  function start() {
    if (started) return status();
    started = true;
    log('节拍器启动', { baseMs: cfg.baseMs, maxBackoffMs: cfg.maxBackoffMs, jitter: cfg.jitter });
    arm();
    return status();
  }

  function arm() {
    if (timer) { clearTimeoutFn(timer); timer = null; }
    if (!started) return;
    const wait = Math.max(1, msUntilDue());
    timer = setTimeoutFn(async () => {
      timer = null;
      await runCheck('scheduled');
      arm();
    }, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) { try { clearTimeoutFn(timer); } catch (e) { log('清理定时器失败', { error: (e && e.message) || String(e) }); } timer = null; }
    started = false;
    return status();
  }

  function status() {
    return {
      started,
      baseMs: cfg.baseMs,
      maxBackoffMs: cfg.maxBackoffMs,
      jitter: cfg.jitter,
      /** 指数退避后的未抖动延迟（测试断言精确序列用这个值）。 */
      currentBaseDelayMs: delayMs,
      failures,
      lastError,
      inFlight: !!inFlight,
      /** 单调时刻（ns，字符串，避免 BigInt 序列化问题）。null = 还没跑过。 */
      lastCompletedTick: lastCompletedNs === null ? null : lastCompletedNs.toString(),
      dueAtTick: dueAtNs === null ? null : dueAtNs.toString(),
      msUntilDue: msUntilDue(),
      counters: { ...counters }
    };
  }

  return { start, stop, runCheck, isDue, msUntilDue, status, config: cfg, nextDelayMs: () => applyJitter(delayMs, cfg.jitter, cfg.maxBackoffMs, random) };
}

module.exports = {
  DEFAULT_BASE_MS, DEFAULT_MAX_MS, DEFAULT_JITTER, MIN_FLOOR_MS,
  normalizeConfig, configFromEnv, applyJitter, createUpdateScheduler
};
