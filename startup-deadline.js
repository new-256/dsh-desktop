'use strict';

/**
 * startup-deadline —— 启动「有信息地失败」的纯逻辑（0.3.48 · H-01 / H-03）。
 *
 * ## 为什么存在
 *
 * 0.3.47 及之前，主进程的启动链**没有任何截止时间**（H-03）：后端既不打印监听
 * 地址也不退出时（插件安装锁 / 镜像请求无响应 / 上游把 `dsh web: <url>` 的日志
 * 格式改掉），`spawnBackend()` 的 Promise 永不 settle，用户看到的是**启动画面
 * 永久旋转**、托盘永远是「正在启动后端…」、日志里没有任何失败记录。
 *
 * 同一时间段里，回滚能力（`rollbackDsh()`）写着、`dsh.previous` 留着、journal
 * 也记着，但全仓**零调用点**（H-01）：用户从"能用的旧版"变成"打不开"，而素材
 * 就在磁盘上拿不到。
 *
 * 本模块把两件事的**判断逻辑**从这个 2700 行的主进程里搬出来，做成不依赖
 * Electron 的纯函数，于是它们能在 Node 里被直接单测（参照 quit-guard /
 * ladder-policy 的既有纪律）：
 *
 *   §1 启动截止时间：预算解析 → 阶段打点 → watchdog → 超时报告文案
 *   §2 启动恢复决策：失败计数落盘规则 → 自动回滚的准入判定（防循环）
 *
 * ## 纪律（用户硬规则）
 *
 * · **超时不是吞错误**：它只负责把「静默挂起」变成「带阶段名 + 最后一条日志 +
 *   日志绝对路径的有信息失败」，真正的错误照样沿既有 `showFatal()` 路径抛出。
 * · **禁止降级兜底**：预算环境变量写错时**不静默容忍** —— 返回 `errors[]`，由
 *   调用方写进诊断日志与后端日志，让配置错误第一时间暴露。
 * · **不做硬编码对答案**：所有判定都基于入参（预算、计数、journal 证据），
 *   没有任何与测试样例耦合的分支。
 */

// ═══════════════════════════════════════════════════════════════════════════
// §1 启动截止时间
// ═══════════════════════════════════════════════════════════════════════════

/** 三个阶段的稳定标识（写进日志/错误码，改名等于改协议，不要动）。 */
const PHASES = Object.freeze({ SPAWN: 'spawn', HEALTH: 'health', PAINT: 'paint' });

/** 阶段顺序：超时报告里用它还原"走到哪一步了"。 */
const PHASE_ORDER = Object.freeze(['spawn', 'health', 'paint']);

/** 面向用户的中文阶段名（弹窗/日志只用这一份，避免多处文案分叉）。 */
const PHASE_LABELS = Object.freeze({
  spawn: '后端进程拉起（等待 dsh web 打印监听地址）',
  health: '后端健康检查（地址已打印，等待 HTTP 响应）',
  paint: '主窗口首帧加载（页面 HTML 与子资源加载完成）'
});

/**
 * 默认预算（毫秒）与**给这个数字的理由**。
 *
 * 刻意不做"一刀切总预算"：三个阶段的故障含义完全不同 ——
 *   · 没打印地址  ⇒ 后端卡在初始化/引导/插件加载（拿不到 URL，重试才有意义）
 *   · 打印了地址  ⇒ 进程活着但 HTTP 不通（端口绑定失败/事件循环被占死）
 *   · 页面加载    ⇒ 后端没事、渲染层或 URL 竞态有问题
 * 合成一个总数就再也没法回答"到底哪一步挂了"，而这正是 H-03 要修的东西。
 */
const DEFAULT_BUDGETS_MS = Object.freeze({
  // 冷启动含 node 24 引导 + dsh web 初始化 + 插件激活；本机正常 6~12s，慢盘/杀软
  // 全盘扫描时可到 40s+。给到 120s（≈10 倍余量）—— 超过这个量级就不是"慢"，
  // 而是在"等"（等文件锁 / 等网络 / 等 stdin），继续等下去只是让用户更晚知道。
  spawn: 120000,
  // 沿用 0.3.x 既有的 waitForServer 60000ms（不是新造的数字）：地址打印后 HTTP
  // 通常 <1s 就可用，60s 已覆盖极端冷启动。
  health: 60000,
  // 主窗口只加载本机 127.0.0.1，正常 <2s；did-fail-load 另自带 5 次指数重试
  //（合计 ≈15s）。60s 只用来兜住"既不完成也不报错"的静默白窗。
  paint: 60000
});

/** 每个阶段的预算可被同名环境变量覆盖（排查/慢机器/CI 用）。 */
const BUDGET_ENV = Object.freeze({
  spawn: 'DSH_STARTUP_TIMEOUT_SPAWN_MS',
  health: 'DSH_STARTUP_TIMEOUT_HEALTH_MS',
  paint: 'DSH_STARTUP_TIMEOUT_PAINT_MS'
});

/** 全局倍率（同时作用于默认值与显式值；写错按 1 处理并报错）。 */
const SCALE_ENV = 'DSH_STARTUP_TIMEOUT_SCALE';

/**
 * 每个阶段一个**不同**的错误码 —— H-03 明确要求区分「未捕获到后端地址」与
 * 「地址已打印但无响应」：前者多半是后端初始化失败，后者是活着但不可用，
 * 处置方式（重试 vs 回滚 vs 看端口）完全不同。
 */
const TIMEOUT_CODES = Object.freeze({
  spawn: 'E_STARTUP_SPAWN_NO_URL',
  health: 'E_STARTUP_HEALTH_UNRESPONSIVE',
  paint: 'E_STARTUP_PAINT_STALLED'
});

function isPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function secs(ms) {
  if (!Number.isFinite(ms)) return '未知';
  return (ms / 1000).toFixed(ms < 1000 ? 2 : 1) + 's';
}

/**
 * 为什么存在：H-03 要求"超时阈值可被环境变量覆盖"，但同时**不允许**把写错的
 * 环境变量静默当成默认值 —— 那会让"我明明设了 300s 怎么还 120s 就超时"变成
 * 一个查不出来的谜。所以这里把每一处非法输入都收进 `errors[]` 交给调用方落日志。
 *
 * @param {Record<string, string|undefined>} [env] 通常是 process.env
 * @returns {{budgets: Record<string, number>, scale: number, source: Record<string, string>, errors: string[]}}
 */
function resolveBudgets(env) {
  const e = env || {};
  const errors = [];
  const source = {};

  let scale = 1;
  const scaleRaw = e[SCALE_ENV];
  if (scaleRaw != null && String(scaleRaw).trim() !== '') {
    if (isPositiveNumber(scaleRaw)) scale = Number(scaleRaw);
    else errors.push(`${SCALE_ENV}=${JSON.stringify(String(scaleRaw))} 不是正数，已按 1 处理`);
  }

  const budgets = {};
  for (const phase of PHASE_ORDER) {
    const def = DEFAULT_BUDGETS_MS[phase];
    const name = BUDGET_ENV[phase];
    const raw = e[name];
    let base = def;
    if (raw != null && String(raw).trim() !== '') {
      if (isPositiveNumber(raw)) {
        base = Number(raw);
        source[phase] = 'env';
      } else {
        // 不静默：默认值照用，但把这件事记下来（调用方会写进诊断日志）。
        source[phase] = 'default(非法环境变量已忽略: ' + name + ')';
        errors.push(`${name}=${JSON.stringify(String(raw))} 不是正数，已用默认 ${def}ms`);
      }
    } else {
      source[phase] = 'default';
    }
    budgets[phase] = Math.max(1, Math.round(base * scale));
  }
  return { budgets, scale, source, errors };
}

/**
 * 为什么存在：超时弹窗必须回答"最后一条日志是什么"。后端日志是**逐块**追加的
 * （含 `\r\n`、空行、超长 JSON 行），直接取数组最后一项经常是空字符串或半行，
 * 于是弹窗里写着"最后一条日志：（空）"等于没说。这里统一取"最后一条非空行"，
 * 压掉多余空白并截断，保证任何输入都能得到一句人能读的话。
 *
 * @param {string|string[]} input 文本块或行数组
 * @param {number} [maxLen] 截断长度（默认 200 码元）
 * @returns {string} 空字符串表示"确实没有任何输出"
 */
function lastMeaningfulLogLine(input, maxLen) {
  const limit = isPositiveNumber(maxLen) ? Number(maxLen) : 200;
  let lines;
  if (Array.isArray(input)) lines = input.map((l) => (l == null ? '' : String(l)));
  else lines = String(input == null ? '' : input).split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  }
  return '';
}

/**
 * 为什么存在：仅凭"超时了"无法判断是慢还是死。阶段打点把启动链拆成可读的
 * 时间序列（ready → seeded → applied → spawn → url-ready → health-ok → loaded），
 * 超时报告里附上它，排查者一眼就看到"卡在 spawn 之后、url 之前"。
 *
 * @param {{now?: () => number}} [opts]
 */
function createTrace(opts) {
  const now = (opts && typeof opts.now === 'function') ? opts.now : () => Date.now();
  const t0 = now();
  const marks = [];
  return {
    /** 打一个点（phase 用短标签，例如 'seeded' / 'spawn'）。 */
    mark(phase, detail) {
      const at = now();
      marks.push({
        phase: String(phase == null ? 'mark' : phase),
        detail: detail == null ? '' : String(detail),
        at,
        offsetMs: at - t0,
        atIso: new Date(at).toISOString()
      });
      return marks.length;
    },
    /** 深拷贝，避免调用方拿到内部数组后改坏打点。 */
    snapshot() { return marks.map((m) => ({ ...m })); },
    /** 一行式的可读序列（进日志/报告）。 */
    lines() {
      return marks.map((m) => `${m.phase}${m.detail ? '[' + m.detail + ']' : ''}@${(m.offsetMs / 1000).toFixed(2)}s`);
    },
    /** 某个点第一次出现的时间偏移（没有则 null）。 */
    since(phase) {
      const hit = marks.find((m) => m.phase === phase);
      return hit ? hit.offsetMs : null;
    },
    last() { return marks.length ? { ...marks[marks.length - 1] } : null; },
    elapsed() { return now() - t0; }
  };
}

/**
 * 为什么存在：超时判定必须是**可注入时间与计时器**的 —— 否则它只能在真机上等
 * 两分钟才验证一次，等于没有测试。生产接线传 `setTimeout/clearTimeout`，
 * 测试传一个手动触发的假计时器，走的是同一段真实逻辑。
 *
 * @param {{
 *   phase: string, budgetMs: number, now?: () => number,
 *   setTimer: (fn: Function, ms: number) => any, clearTimer: (h: any) => void,
 *   onExpire: (info: {phase: string, budgetMs: number, startedAt: number, elapsedMs: number}) => void
 * }} opts
 */
function createWatchdog(opts) {
  const o = opts || {};
  if (!o.phase) throw new Error('startup-deadline.createWatchdog：缺少 phase');
  if (!isPositiveNumber(o.budgetMs)) throw new Error('startup-deadline.createWatchdog：budgetMs 必须是正数，收到 ' + JSON.stringify(o.budgetMs));
  if (typeof o.setTimer !== 'function' || typeof o.clearTimer !== 'function') {
    throw new Error('startup-deadline.createWatchdog：必须注入 setTimer/clearTimer（不许隐式用全局计时器）');
  }
  if (typeof o.onExpire !== 'function') throw new Error('startup-deadline.createWatchdog：缺少 onExpire');

  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const startedAt = now();
  const budgetMs = Number(o.budgetMs);
  let handle = null;
  let fired = false;
  let stopped = false;

  return {
    phase: o.phase,
    budgetMs,
    startedAt,
    /** 启动计时（重复调用无副作用）。 */
    start() {
      if (handle !== null || stopped || fired) return false;
      handle = o.setTimer(() => {
        handle = null;
        if (stopped) return;
        fired = true;
        o.onExpire({ phase: o.phase, budgetMs, startedAt, elapsedMs: now() - startedAt });
      }, budgetMs);
      return true;
    },
    /** 停表（阶段完成 / 已被其它路径接管时调用；幂等）。 */
    stop() {
      stopped = true;
      if (handle !== null) {
        o.clearTimer(handle);
        handle = null;
      }
    },
    isExpired() { return fired; },
    isStopped() { return stopped; },
    elapsed() { return now() - startedAt; }
  };
}

/**
 * 为什么存在：超时文案是用户唯一能看到的东西，必须自己就能被支持者读懂 ——
 * 所以**阶段名、最后一条日志、日志绝对路径**是硬性三项（缺一项就等于又把用户
 * 丢回"启动画面一直转"的处境）。这个函数只做拼装，不做 IO，因此可单测。
 *
 * @param {{phase: string, budgets?: Record<string, number>, budgetMs?: number,
 *          elapsedMs?: number, lastLogLine?: string, marks?: string[],
 *          logPath?: string, hint?: string, source?: string}} input
 * @returns {string}
 */
function formatTimeoutMessage(input) {
  const i = input || {};
  const phase = i.phase;
  const label = PHASE_LABELS[phase] || String(phase || '未知阶段');
  const code = TIMEOUT_CODES[phase] || 'E_STARTUP_TIMEOUT';
  const budgetMs = Number.isFinite(i.budgetMs) ? i.budgetMs
    : (i.budgets && Number.isFinite(i.budgets[phase]) ? i.budgets[phase] : null);
  const elapsedMs = Number.isFinite(i.elapsedMs) ? i.elapsedMs : budgetMs;
  const marks = Array.isArray(i.marks) ? i.marks.filter(Boolean) : [];
  const logPath = i.logPath || '（日志路径不可用）';
  const lastLog = i.lastLogLine ? i.lastLogLine : '（后端自始至终没有任何输出）';

  const lines = [];
  lines.push(`启动超时：${label}`);
  lines.push(`  超时阶段：${phase}（${code}）`);
  lines.push(`  已经等过：${secs(elapsedMs)}；该阶段预算 ${secs(budgetMs)}${i.source ? `（${i.source}）` : ''}`);
  lines.push(`  最后一条后端日志：${lastLog}`);
  if (marks.length) lines.push(`  启动阶段打点：${marks.join(' → ')}`);
  lines.push(`  完整日志（绝对路径）：${logPath}`);
  lines.push('  这意味着：这一步没有在预期时间内给出结果。超时本身不代表后端一定坏了，');
  lines.push('  但它确实卡住了 —— 下面可以重试启动、回滚到上一个版本，或先查看日志。');
  if (i.hint) lines.push(`  提示：${i.hint}`);
  return lines.join('\n');
}

/**
 * 为什么存在：把"现场证据"（阶段/耗时/打点/最后一条日志/日志路径）一次组装成
 * 结构化对象，供 Error 携带、诊断日志落盘、弹窗渲染三处复用 —— 避免三处各自
 * 拼一半导致文案分叉。
 *
 * @param {{phase: string, budgets?: Record<string, number>, elapsedMs?: number,
 *          lastLogLine?: string, logPath?: string, trace?: object,
 *          source?: string, hint?: string}} opts
 * @returns {{code: string, phase: string, label: string, budgetMs: number|null,
 *            elapsedMs: number|null, lastLogLine: string, marks: string[],
 *            logPath: string, message: string}}
 */
function buildTimeoutReport(opts) {
  const o = opts || {};
  const phase = o.phase;
  const budgetMs = (o.budgets && Number.isFinite(o.budgets[phase])) ? o.budgets[phase] : null;
  const elapsedMs = Number.isFinite(o.elapsedMs) ? o.elapsedMs : null;
  const lastLogLine = o.lastLogLine == null ? '' : String(o.lastLogLine);
  let marks = [];
  if (Array.isArray(o.marks)) marks = o.marks.filter(Boolean).map(String);
  else if (o.trace && typeof o.trace.lines === 'function') {
    try { marks = o.trace.lines(); } catch (_) { marks = []; }
  }
  const logPath = o.logPath ? String(o.logPath) : '';
  const report = {
    code: TIMEOUT_CODES[phase] || 'E_STARTUP_TIMEOUT',
    phase: String(phase || 'unknown'),
    label: PHASE_LABELS[phase] || String(phase || '未知阶段'),
    budgetMs,
    elapsedMs,
    lastLogLine,
    marks,
    logPath,
    message: ''
  };
  report.message = formatTimeoutMessage({
    phase: report.phase, budgetMs, elapsedMs, lastLogLine, marks, logPath,
    source: o.source, hint: o.hint
  });
  return report;
}

/**
 * 为什么存在：超时要沿着既有的错误通道走到 `showFatal()`，而不是新开一条路径。
 * 携带 `code/phase/report` 后，上层既能按类型判定（例如"地址没打印 vs 没响应"），
 * 也能直接把 message 原样放进弹窗。
 *
 * @param {ReturnType<typeof buildTimeoutReport>} report
 * @returns {Error & {timeout: true, code: string, phase: string, report: object}}
 */
function createTimeoutError(report) {
  const r = report || buildTimeoutReport({ phase: 'spawn' });
  const err = new Error(r.message);
  err.name = 'StartupTimeoutError';
  err.timeout = true;
  err.code = r.code;
  err.phase = r.phase;
  err.report = r;
  return err;
}

// ═══════════════════════════════════════════════════════════════════════════
// §2 启动恢复决策（H-01：让回滚真正接电，同时不许无限回滚）
// ═══════════════════════════════════════════════════════════════════════════

/** 连续多少次启动失败才自动回滚（H-01 的要求：2 次，不是 1 次）。 */
const FAILURE_THRESHOLD = 2;

/**
 * 「本轮」允许自动回滚的次数上限。
 * 为什么是 1：自动回滚本身就等于"换一个版本再试一次"；如果回滚后的版本也起不来，
 * 再回滚只会把磁盘上唯一的可救素材（dsh.previous）也消费掉，并把用户送进
 * 重启-回滚-重启的死循环。第二次必须由人决定（弹窗里有手动回滚按钮）。
 */
const AUTO_ROLLBACK_LIMIT = 1;

/** 失败计数台账的初始形态（落盘为 JSON；字段名是跨版本协议，不要随意改名）。 */
function createGuardState() {
  return {
    schema: 1,
    consecutiveFailures: 0,
    rollbacksInChain: 0,
    autoRollbacksTotal: 0,
    lastFailureAt: null,
    lastFailureSummary: null,
    lastHealthyBootAt: null,
    lastRollback: null,
    pendingNotice: null,
    lastNoticeShownAt: null
  };
}

function nonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function asStringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 为什么存在：台账是磁盘上的 JSON，可能被旧版本写过、可能被用户手动编辑、
 * 也可能只写了一半（断电）。判定逻辑绝不能因为一个坏字段就抛错（那会把
 * "启动失败"升级成"启动崩溃"），但也**不能**把非法值当合法用 —— 统一归一为
 * 安全默认值，并由调用方在日志里留下"读了什么"。
 *
 * @param {any} raw JSON.parse 的结果
 * @returns {ReturnType<typeof createGuardState>}
 */
function normalizeGuardState(raw) {
  const base = createGuardState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const state = {
    schema: 1,
    consecutiveFailures: nonNegativeInt(raw.consecutiveFailures),
    rollbacksInChain: nonNegativeInt(raw.rollbacksInChain),
    autoRollbacksTotal: nonNegativeInt(raw.autoRollbacksTotal),
    lastFailureAt: asStringOrNull(raw.lastFailureAt),
    lastFailureSummary: asStringOrNull(raw.lastFailureSummary),
    lastHealthyBootAt: asStringOrNull(raw.lastHealthyBootAt),
    lastRollback: (raw.lastRollback && typeof raw.lastRollback === 'object' && !Array.isArray(raw.lastRollback))
      ? { ...raw.lastRollback } : null,
    pendingNotice: (raw.pendingNotice && typeof raw.pendingNotice === 'object' && !Array.isArray(raw.pendingNotice))
      ? { ...raw.pendingNotice } : null,
    lastNoticeShownAt: asStringOrNull(raw.lastNoticeShownAt)
  };
  return state;
}

/**
 * 为什么存在：H-01(2) 的触发条件是「连续 2 次启动失败」，而两次失败之间必然
 * 经过一次进程重启 —— 内存计数在重启后归零，等于永远不会触发。所以计数必须
 * 落盘，并由这个纯函数负责"加一"这件事（便于单测边界）。
 */
function bumpFailure(state, info) {
  const s = normalizeGuardState(state);
  const i = info || {};
  return {
    ...s,
    consecutiveFailures: s.consecutiveFailures + 1,
    lastFailureAt: asStringOrNull(i.at) || s.lastFailureAt,
    lastFailureSummary: i.summary == null ? s.lastFailureSummary : String(i.summary).slice(0, 300)
  };
}

/**
 * 为什么存在：只有"连续"失败才该触发自动回滚。一旦某次启动真的成功（后端就绪 +
 * 主窗口加载完成），失败链就断了 —— 必须清零，否则几个月后一次偶发失败会莫名
 * 触发回滚，还会把自动回滚额度永久占掉。
 *
 * 注意：`pendingNotice` 必须保留 —— 它是"已自动回滚，下次启动告诉用户"的信使，
 * 而清零正好发生在"下次启动成功"这一刻。
 */
function resetOnHealthyBoot(state, info) {
  const s = normalizeGuardState(state);
  const i = info || {};
  return {
    ...s,
    consecutiveFailures: 0,
    rollbacksInChain: 0,
    lastHealthyBootAt: asStringOrNull(i.at) || s.lastHealthyBootAt
  };
}

/**
 * 为什么存在：回滚是**不可逆**动作（`rollbackDsh()` 会把当前 dsh 目录改名为
 * dsh.failed 再删除，只保留 dsh.previous 换回来的那份），必须留下可追溯记录：
 * 谁触发的、从哪个版本换到哪个版本、属于"自动还是手动"。
 *
 * 触发条件：由 `decideRecovery()` 的 auto-rollback 或用户点弹窗按钮。
 * 可逆性：不可逆（被替换掉的失败版本会被删除）；补偿手段是重新下载/暂存该版本。
 * 证据要求：`dsh.previous` 里 bin.js 存在（调用方用 rollbackTargetExists 判定）。
 */
function recordRollback(state, info) {
  const s = normalizeGuardState(state);
  const i = info || {};
  const auto = !!i.auto;
  return {
    ...s,
    // 手动回滚是用户主动换一个版本重试 —— 失败链从 0 重新计；自动回滚则记进"本轮链"，
    // 它就是 AUTO_ROLLBACK_LIMIT 的计量单元（防死循环）。
    consecutiveFailures: auto ? s.consecutiveFailures : 0,
    rollbacksInChain: s.rollbacksInChain + (auto ? 1 : 0),
    autoRollbacksTotal: s.autoRollbacksTotal + (auto ? 1 : 0),
    lastRollback: {
      at: asStringOrNull(i.at),
      from: i.from == null ? null : String(i.from),
      to: i.to == null ? null : String(i.to),
      auto,
      reason: i.reason == null ? null : String(i.reason)
    }
  };
}

/**
 * 为什么存在：自动回滚发生在"本次进程马上就要重启"的时刻，此时弹出的任何
 * 提示都活不过重启。所以把提示**暂存**进台账，由下一次启动读出来显示一次
 * （非阻塞、只显示一次），用户才知道"刚才那一下不是我眼花，它自己回滚了"。
 */
function stashNotice(state, info) {
  const s = normalizeGuardState(state);
  const i = info || {};
  return {
    ...s,
    pendingNotice: {
      kind: i.kind == null ? 'auto-rollback' : String(i.kind),
      at: asStringOrNull(i.at),
      from: i.from == null ? null : String(i.from),
      to: i.to == null ? null : String(i.to),
      reason: i.reason == null ? null : String(i.reason)
    }
  };
}

/** 显示过就清掉暂存（一次性的语义）。 */
function clearNotice(state, info) {
  const s = normalizeGuardState(state);
  const i = info || {};
  return {
    ...s,
    pendingNotice: null,
    lastNoticeShownAt: asStringOrNull(i.at) || s.lastNoticeShownAt
  };
}

/**
 * 为什么存在：H-01(3) 要求把 `journalUnverified()` 从「只写日志」升级为
 * 「决定是否提示用户」的输入之一。它证明的是"上次更新在验证前被打断"，
 * 也就是**当前版本本身可疑** —— 这恰好是"要不要建议回滚"的直接证据。
 *
 * @param {Array<object>} evidence journal 里 applied 但未 verified 的记录
 * @param {number} [maxItems]
 */
function formatJournalEvidence(evidence, maxItems) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return '';
  const limit = isPositiveNumber(maxItems) ? Number(maxItems) : 3;
  const shown = list.slice(-limit).map((e) => {
    const kind = (e && e.kind) || '未知组件';
    const to = (e && e.to) || '未知版本';
    const at = (e && e.at) || '时间未知';
    return `${kind} → ${to}（${at}）`;
  });
  const more = list.length > limit ? `，另有 ${list.length - limit} 条更早记录` : '';
  return `共 ${list.length} 条"已应用但未验证"的更新记录：${shown.join('；')}${more}。`;
}

/**
 * 为什么存在：这是整条自动回滚链的**唯一准入判定**。放在纯函数里，是因为它
 * 由 5 个互相影响的输入决定（失败计数、本轮已回滚次数、是否有可回滚版本、
 * journal 证据、致命失败类型），任何一处写错都会变成"回滚死循环"或"该回滚时
 * 不回滚"，必须有覆盖全部组合的单元测试。
 *
 * 判定顺序（先否决、后准入）：
 *   1. 端口被占（EADDRINUSE）      → 另一个实例还在跑，回滚完全无效，禁止
 *   2. 没有 dsh.previous 可用     → 无米下锅
 *   3. 本轮已自动回滚过一次        → 防死循环，改为只提供手动按钮
 *   4. 连续失败 ≥ 2               → **自动回滚**
 *   5. journal 有未验证记录        → 人工咨询（把回滚设为推荐项）
 *   6. 其它                       → 什么都不做，走既有恢复弹窗
 *
 * @param {{state?: object, previousAvailable?: boolean, journalEvidence?: Array<object>,
 *          fatalKind?: string}} input fatalKind: 'startup' | 'address-in-use'
 * @returns {{action: 'none'|'advisory'|'auto-rollback', reason: string,
 *            recommendRollback: boolean, detailExtra: string, message: string}}
 */
function decideRecovery(input) {
  const i = input || {};
  const state = normalizeGuardState(i.state);
  const previousAvailable = !!i.previousAvailable;
  const journalEvidence = Array.isArray(i.journalEvidence) ? i.journalEvidence : [];
  const fatalKind = i.fatalKind === 'address-in-use' ? 'address-in-use' : 'startup';
  const journalText = formatJournalEvidence(journalEvidence);

  if (fatalKind === 'address-in-use') {
    return {
      action: 'none', reason: 'address-in-use', recommendRollback: false,
      detailExtra: '', message: '端口被其他 DSH 实例占用'
    };
  }
  if (!previousAvailable) {
    return {
      action: 'none', reason: 'no-previous-version', recommendRollback: false,
      detailExtra: journalText ? journalText + '\n' : '',
      message: '后端没能启动 —— 自救入口已就绪'
    };
  }
  if (state.rollbacksInChain >= AUTO_ROLLBACK_LIMIT) {
    return {
      action: 'none', reason: 'auto-rollback-limit-reached', recommendRollback: true,
      detailExtra:
        (journalText ? journalText + '\n\n' : '') +
        '本轮已经自动回滚过一次：为避免把仅剩的旧版本也消费掉（进而变成重启—回滚的死循环），' +
        '这里不再自动回滚。你可以手动选择「回滚到上一个版本」，或先以安全模式启动排查。\n',
      message: '后端仍然没能启动（已自动回滚过一次）'
    };
  }
  if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
    return {
      action: 'auto-rollback', reason: 'consecutive-failures', recommendRollback: true,
      detailExtra:
        (journalText ? journalText + '\n\n' : '') +
        `已连续 ${state.consecutiveFailures} 次启动失败，正在自动回滚到上一个版本。\n`,
      message: '连续启动失败，正在自动回滚'
    };
  }
  if (journalEvidence.length) {
    return {
      action: 'advisory', reason: 'journal-unverified', recommendRollback: true,
      detailExtra:
        journalText + '\n' +
        '这通常意味着上次更新在验证前被打断（断电、强杀或启动失败），当前版本可能本身不可用 ——' +
        '「回滚到上一个版本」通常能立刻恢复可用。\n',
      message: '后端没能启动 —— 上次更新未验证通过'
    };
  }
  return {
    action: 'none', reason: 'below-threshold', recommendRollback: false,
    detailExtra: '',
    message: '后端没能启动 —— 自救入口已就绪'
  };
}

/**
 * 为什么存在：自动回滚的提示必须是"用户能看懂且能行动"的一句话 —— 说明发生了什么、
 * 现在是哪个版本、下次还出问题该怎么办、日志在哪。纯拼装，可单测。
 *
 * @param {{from?: string|null, to?: string|null, auto?: boolean, reason?: string|null,
 *          logPath?: string|null}} input
 * @returns {string}
 */
function formatRollbackNotice(input) {
  const i = input || {};
  const from = i.from || '故障版本';
  const to = i.to || '上一个版本';
  const lines = [];
  lines.push(`DSH 后端已${i.auto ? '自动' : ''}回滚：${from} → ${to}`);
  lines.push('');
  lines.push('为什么：新版本连续启动失败，继续停在这里只会让你一直打不开应用。');
  lines.push('改了什么：只把 backend 里的 dsh 程序目录换回上一个版本（故障版本已被删除）；');
  lines.push('          你的会话、密钥、插件与设置都在独立数据目录里，一行也没动。');
  lines.push('接下来：如果还要用新版本，可在托盘「设置…」里重新选择版本后重启；');
  lines.push('        若现在仍然起不来，请右键托盘图标 →「查看启动日志」。');
  if (i.logPath) lines.push('', `完整日志（绝对路径）：${i.logPath}`);
  return lines.join('\n');
}

module.exports = {
  // §1 启动截止时间
  PHASES,
  PHASE_ORDER,
  PHASE_LABELS,
  DEFAULT_BUDGETS_MS,
  BUDGET_ENV,
  SCALE_ENV,
  TIMEOUT_CODES,
  resolveBudgets,
  lastMeaningfulLogLine,
  createTrace,
  createWatchdog,
  formatTimeoutMessage,
  buildTimeoutReport,
  createTimeoutError,
  // §2 启动恢复决策
  FAILURE_THRESHOLD,
  AUTO_ROLLBACK_LIMIT,
  createGuardState,
  normalizeGuardState,
  bumpFailure,
  resetOnHealthyBoot,
  recordRollback,
  stashNotice,
  clearNotice,
  formatJournalEvidence,
  decideRecovery,
  formatRollbackNotice
};
