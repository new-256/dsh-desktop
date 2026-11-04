'use strict';

/**
 * 插件操作台账（0.3.49 · B-04 · 对齐官方 operation-journal.ts / operation-history.ts）
 *
 * 为什么存在：插件类故障三次卡在同一处 —— **归因不到具体条目**（0.3.24「清扫只写数量」、
 * 0.3.26/0.3.37/0.3.41 三次事故），只能靠文件时间戳反推"当初谁装/禁/改了哪个插件"。
 * 这个模块把每次插件操作记成**一条结构化记录**，写进有界的 2 段环形文件；崩溃报告会
 * 附上「最近 N 条」作为**上下文**（context, not proof of cause —— 它不是因果证据，
 * 更不许喂给自愈阶梯的 needs-proof 判定）。
 *
 * 设计约束（照抄官方，逐条都是踩过的坑）：
 *   ① `record()` **同步入队、行级零文件系统调用** —— 插件操作发生在主进程里，绝不能在
 *      install/enable 的热路径上做同步 IO（H-10 的教训：逐行同步写会把长会话拖卡）；
 *   ② 磁盘有界：2 段 × 256 KiB = 512 KiB 总预算；单条 ≤ 4 KiB（超长截断并标 `truncated`）；
 *      内存排队 ≤ 64 KiB；
 *   ③ **不静默丢弃**（用户硬规则）：排队触顶/退出未排空的条数必须计数，并写进台账正文
 *      （`action:"journal-drop"` 的 notice 记录）+ 诊断日志正文；
 *   ④ 写失败 → 本次进程生命周期内**停用写入**（`status().disabled`），并把失败计数曝光；
 *      记录仍留在内存环里，崩溃报告照样能附上（降级可见，不是假装成功）；
 *   ⑤ `flush(deadlineMs)` 是**同步**排空，供崩溃路径直接调用（预算 ≤1s，官方退出/恢复/
 *      安装准备最多等 500ms）；退出钩子四路安装（`process 'exit'`、包装 `app.exit`、
 *      `will-quit`、包装 `process.exit`）—— 阶段一实测 `app.exit()` 既不触发 quit 事件也
 *      不走 Node 的 `exit`，只挂一个是会丢光队列的真缺陷；
 *   ⑥ 只记「动作 + 插件标识 + 结果码」：**不记命令行原文/spec**（可能含私有 registry 地址）、
 *      不记插件 stdout（可能含凭据）。传进来的非白名单字段一律丢弃，字符串再兜一层凭据样式
 *      脱敏（`token=/password:/bearer …`）。
 *
 * 本模块对外永不抛错：内部故障一律 `console.error` + 状态计数（诊断设施不能拖垮主流程）。
 */

const fs = require('fs');
const path = require('path');

let electronApp = null;
try { electronApp = require('electron').app; } catch (_) { /* 非 Electron 环境（单测） */ }

// ── 常量（全部可用环境变量收紧，供压力/故障注入测试；默认值对齐官方）────────────
function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** 单段上限（官方 segmentBytes: 256 KiB）。 */
const SEGMENT_BYTES = envInt('DSH_PLUGIN_JOURNAL_SEGMENT_BYTES', 256 * 1024);
/** 段数（官方两段环形）。 */
const SEGMENT_COUNT = 2;
/** 单条上限（官方 recordBytes: 4096）。 */
const RECORD_BYTES = envInt('DSH_PLUGIN_JOURNAL_RECORD_BYTES', 4096);
/** 内存排队上限（官方 queuedBytes: 64 KiB）。 */
const QUEUE_BYTES = envInt('DSH_PLUGIN_JOURNAL_QUEUE_BYTES', 64 * 1024);
/** 内存环形保留条数（崩溃报告附件的来源；与磁盘段无关，磁盘停用也能用）。 */
const RECENT_LIMIT = envInt('DSH_PLUGIN_JOURNAL_RECENT_LIMIT', 500);
/** 内存环形保留字节上限（防止超长记录把内存撑大）。 */
const RECENT_BYTES = envInt('DSH_PLUGIN_JOURNAL_RECENT_BYTES', 512 * 1024);
/** 定时落盘周期（台账记录稀疏，1s 足够；崩溃/退出走显式 flush）。 */
const FLUSH_INTERVAL_MS = envInt('DSH_PLUGIN_JOURNAL_FLUSH_MS', 1000);
/** 退出/恢复/安装准备前的排空预算（官方 ≤500ms）。 */
const EXIT_FLUSH_DEADLINE_MS = envInt('DSH_PLUGIN_JOURNAL_EXIT_MS', 500);
/** 崩溃报告取快照前的排空预算（留出余量给基础报告写入，总预算仍 ≤1s）。 */
const CRASH_FLUSH_DEADLINE_MS = envInt('DSH_PLUGIN_JOURNAL_CRASH_MS', 300);
/** 单次 append 的块上限（避免一次写几百 KiB 卡住事件循环）。 */
const CHUNK_BYTES = envInt('DSH_PLUGIN_JOURNAL_CHUNK_BYTES', 16 * 1024);

/** 允许的动作类型（其余归为 'unknown' 并计入 status().invalidActions，不静默丢）。 */
const ACTIONS = Object.freeze(['install', 'enable', 'disable', 'uninstall', 'isolate', 'restore', 'startup-skip']);
/** 插件来源（只记类别，不记完整路径/registry URL，避免泄漏私有源）。 */
const SOURCES = Object.freeze(['registry', 'local', 'profile', 'legacy', 'unknown']);
/** 进程阶段。 */
const PHASES = Object.freeze(['startup', 'running', 'shutdown', 'update', 'unknown']);
/** 关键失败要额外用 diag-log 的 durability 层留证（低频，且正是事故现场）。 */
const MIRROR_FAILURE_ACTIONS = Object.freeze(['isolate', 'restore']);

/** 凭据样式的键值对：reason 里可能夹带 error message，落盘前脱敏。 */
const CREDENTIAL_RE = /\b(token|password|passwd|secret|authorization|api[_-]?key|bearer)\b(\s*[:=]\s*)\S+/giu;

// ── 状态 ────────────────────────────────────────────────────────────────────
let queue = [];               // [{ line, bytes, entry }]
let queuedBytes = 0;
let recentEntries = [];       // 内存环形（崩溃报告 + recent() 的来源）
let recentBytes = 0;
let dropped = 0;              // 排队触顶丢弃条数（累计）
let droppedWritten = 0;       // 已写进台账正文的丢弃条数
let failed = 0;               // 落盘失败次数
let written = 0;              // 已成功落盘条数
let invalidActions = 0;       // 动作类型不认识（记录仍保留，标记 unknown）
let disabled = false;         // 写失败后本次生命周期停用落盘（官方语义）
let lastError = null;
let seq = 0;
let flushTimer = null;
const startedMono = process.hrtime.bigint();

/** 内部故障如实打到 stderr（诊断设施自身不能静默失败）。 */
function reportInternal(err) {
  const text = (err && (err.message || err.code)) || String(err);
  lastError = text;
  try { process.stderr.write(`[plugin-journal] ${text}\n`); } catch (_) { /* stderr 也不可用 */ }
}

/** 单调毫秒（相对模块加载时刻）—— 与墙上时间双记，规避系统改钟导致的时间跳变。 */
function monoMs() {
  return Number(process.hrtime.bigint() - startedMono) / 1e6;
}

/** 截断字符串；不切断代理对（emoji 插件名不会变成乱码）。 */
function clipText(value, maxLen) {
  const s = String(value == null ? '' : value);
  if (s.length <= maxLen) return s;
  let out = s.slice(0, Math.max(0, maxLen - 1));
  if (/[\ud800-\udbff]$/u.test(out)) out = out.slice(0, -1);
  return out + '…';
}

/**
 * 单行文本清洗（换行/控制字符换成空格 + 凭据脱敏 + 长度截断）。
 * 返回值带 `clipped`（被长度截断过）与 `redacted`（凭据被打码）两个标记 ——
 * 记录里必须能看出"这条不是调用方原样给的"，否则读台账的人会以为内容是完整的。
 */
function sanitizeField(value, maxLen) {
  const raw = value === undefined || value === null ? '' : String(value);
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  const masked = flat.replace(CREDENTIAL_RE, (_m, key, sep) => `${key}${sep}***`);
  const text = clipText(masked, maxLen);
  return { text, clipped: text !== masked, redacted: masked !== flat };
}

/** 类别字段收敛：不在白名单 → 'unknown'（可见降级，不猜）。 */
function pickCategory(value, allowed) {
  const s = String(value == null ? '' : value);
  return allowed.includes(s) ? s : 'unknown';
}

/**
 * 把调用方的 entry 归一成台账记录。
 * 只保留白名单字段 —— 这是「不记 spec/命令行/凭据」的机制化保障：
 * 接线方传什么额外字段都不会被持久化。
 *
 * 截断语义：任何字段被长度截断 → `truncated:true`；凭据被打码 → `redacted:true`；
 * 两者都附 `originalBytes`（未截断时的记录字节数），让读的人知道"这条不完整"，
 * 而不是把半截内容当成全部。
 */
function normalizeEntry(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const action = String(source.action == null ? '' : source.action);
  if (!ACTIONS.includes(action)) invalidActions += 1;
  seq += 1;
  const resultRaw = source.result;
  let result = 'ok';
  let reasonRaw = '';
  if (resultRaw === 'fail' || resultRaw === false) {
    result = 'fail';
  } else if (resultRaw && typeof resultRaw === 'object') {
    result = resultRaw.status === 'fail' || resultRaw.ok === false ? 'fail' : 'ok';
    reasonRaw = resultRaw.code != null ? resultRaw.code : (resultRaw.reason != null ? resultRaw.reason : '');
  } else if (resultRaw === 'ok' || resultRaw === true) {
    result = 'ok';
  }
  if (!reasonRaw && source.reason != null) reasonRaw = source.reason;
  if (!reasonRaw && source.code != null) reasonRaw = source.code;

  const pluginRaw = source.plugin != null ? source.plugin : source.name;
  const versionRaw = source.version;
  const plugin = sanitizeField(pluginRaw, 200);
  const version = sanitizeField(versionRaw, 64);
  const reason = sanitizeField(reasonRaw, 120);

  const entry = {
    seq,
    wall: new Date().toISOString(),
    monoMs: Math.round(monoMs() * 1000) / 1000,
    action: ACTIONS.includes(action) ? action : 'unknown',
    plugin: plugin.text,
    version: version.text,
    source: pickCategory(source.source, SOURCES),
    result,
    reason: reason.text,
    phase: pickCategory(source.phase, PHASES)
  };

  const clipped = plugin.clipped || version.clipped || reason.clipped;
  const redacted = plugin.redacted || version.redacted || reason.redacted;
  if (clipped || redacted) {
    const rawShape = Object.assign({}, entry, {
      plugin: pluginRaw == null ? '' : String(pluginRaw),
      version: versionRaw == null ? '' : String(versionRaw),
      reason: reasonRaw == null ? '' : String(reasonRaw)
    });
    entry.originalBytes = Buffer.byteLength(JSON.stringify(rawShape), 'utf8');
  }
  if (clipped) entry.truncated = true;
  if (redacted) entry.redacted = true;
  return entry;
}

/**
 * 序列化并压到单条上限内（超长 → 逐步降级 + `truncated:true` + `originalBytes`）。
 * 保证返回的 JSON **不含换行**（一行一条记录），字节数 ≤ RECORD_BYTES。
 */
function fitRecord(entry) {
  const byteLen = (text) => Buffer.byteLength(text, 'utf8');
  let line = JSON.stringify(entry);
  if (byteLen(line) <= RECORD_BYTES) return line;

  const originalBytes = byteLen(line);
  const slim = Object.assign({}, entry, { truncated: true, originalBytes });
  delete slim.reason;
  line = JSON.stringify(slim);
  if (byteLen(line) <= RECORD_BYTES) return line;

  slim.plugin = clipText(slim.plugin, 120);
  slim.version = clipText(slim.version, 32);
  line = JSON.stringify(slim);
  if (byteLen(line) <= RECORD_BYTES) return line;

  // 最后兜底：只留归因必需字段，插件名逐步截短直到装得下
  const base = {
    seq: entry.seq,
    wall: entry.wall,
    monoMs: entry.monoMs,
    action: entry.action,
    source: entry.source,
    result: entry.result,
    phase: entry.phase,
    truncated: true,
    originalBytes
  };
  const name = String(entry.plugin || '');
  for (let keep = Math.min(name.length, 200); keep >= 0; keep -= 20) {
    const candidate = JSON.stringify(Object.assign({}, base, { plugin: clipText(name, keep) }));
    if (byteLen(candidate) <= RECORD_BYTES) return candidate;
  }
  return JSON.stringify(Object.assign({}, base, { plugin: '' }));
}

// ── 路径与目录 ──────────────────────────────────────────────────────────────

/**
 * 台账目录：与其它诊断产物同域（`<logs>/plugin-operations`），便于用户一次交出。
 * `DSH_PLUGIN_JOURNAL_DIR` 供测试/运维覆盖（故障注入也走它：指到一个文件上 → 必然写失败）。
 */
function journalDir() {
  const override = process.env.DSH_PLUGIN_JOURNAL_DIR;
  if (override) return override;
  try {
    return path.join(require('./diag-log').logsDir(), 'plugin-operations');
  } catch (err) {
    // 退化到 cwd/logs：仍然可见地报错，不静默
    reportInternal(err);
    return path.join(process.cwd(), 'logs', 'plugin-operations');
  }
}

/** 段文件路径：1 = 当前写段，2 = 上一段（更旧）。 */
function segmentPath(index) {
  return path.join(journalDir(), `plugin-operations-${index}.log`);
}

/** 全部段路径（旧 → 新，读盘/测试用）。 */
function segmentPaths() {
  const out = [];
  for (let i = SEGMENT_COUNT; i >= 1; i -= 1) out.push(segmentPath(i));
  return out;
}

/** 确保目录存在；失败抛错（由调用方转成"停用落盘"）。 */
function ensureDir() {
  fs.mkdirSync(journalDir(), { recursive: true });
}

/** 段文件大小（不存在 = 0；其它错误抛出去，避免把权限问题当成"空文件"继续写）。 */
function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * 两段环形滚动：当前段超预算时，删掉最旧段、把当前段降级为旧段，后续 append 自动新建。
 * 语义：磁盘上永远只有 2 个段文件，总字节 ≤ 2 × SEGMENT_BYTES + 一个块余量。
 */
function rotateIfFull(file) {
  if (fileSize(file) <= SEGMENT_BYTES) return false;
  const older = segmentPath(SEGMENT_COUNT);
  try { fs.unlinkSync(older); } catch (err) { if (err && err.code !== 'ENOENT') throw err; }
  try { fs.renameSync(file, older); } catch (err) { if (err && err.code !== 'ENOENT') throw err; }
  return true;
}

// ── 内存环形（崩溃报告上下文）───────────────────────────────────────────────

/** 维护最近记录环形：按条数 + 字节双上限淘汰最旧的。 */
function pushRecent(entry) {
  recentEntries.push(entry);
  recentBytes += Buffer.byteLength(JSON.stringify(entry), 'utf8');
  while (recentEntries.length > RECENT_LIMIT || (recentBytes > RECENT_BYTES && recentEntries.length > 1)) {
    const removed = recentEntries.shift();
    recentBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
  }
  if (recentBytes < 0) recentBytes = 0;
}

/**
 * 最近 n 条记录（旧 → 新）。边界：n 缺省 20；n ≤ 0 返回空数组；n 超过存量返回全部。
 * 返回的是**副本数组**，调用方改动不会污染环形。
 */
function recent(n) {
  const limit = n === undefined || n === null ? 20 : Math.floor(Number(n));
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return recentEntries.slice(-limit);
}

/** 把一条记录渲染成崩溃报告里的一行（紧凑、单行）。 */
function formatEntryLine(entry) {
  const name = entry.plugin ? entry.plugin + (entry.version ? '@' + entry.version : '') : '(未命名插件)';
  const parts = [
    `#${entry.seq}`,
    entry.wall,
    `+${entry.monoMs}ms`,
    entry.action,
    name,
    `source=${entry.source}`,
    entry.result === 'fail' ? `fail${entry.reason ? ':' + entry.reason : ''}` : 'ok',
    `phase=${entry.phase}`
  ];
  if (entry.persisted === false) parts.push('(未落盘)');
  if (entry.truncated) parts.push('(truncated)');
  return parts.join(' ');
}

/**
 * 崩溃报告用快照：最近 limit 条 + 省略条数 + 状态。
 * 即使磁盘停用也照常返回（内存环不依赖落盘）。
 */
function renderRecent(limit) {
  const picked = recent(limit);
  return {
    lines: picked.map(formatEntryLine),
    omitted: Math.max(0, recentEntries.length - picked.length),
    total: recentEntries.length,
    status: status()
  };
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

/** 写失败 → 本次进程生命周期停用落盘（官方语义：不重复捶一个坏盘）。 */
function disableWrites(err) {
  failed += 1;
  disabled = true;
  reportInternal(err);
}

/**
 * 把「排队触顶丢弃」的计数写进台账正文（用户硬规则：禁止静默丢弃）。
 * 同时打一条诊断日志（批量层，不阻塞），让不翻台账的人也能在主日志里看到。
 */
function writeDropNotice() {
  const pending = dropped - droppedWritten;
  if (pending <= 0) return;
  const notice = {
    seq: seq + 1,
    wall: new Date().toISOString(),
    monoMs: Math.round(monoMs() * 1000) / 1000,
    action: 'journal-drop',
    reason: 'queue-overflow',
    dropped: pending,
    queuedBytes,
    phase: 'unknown'
  };
  const line = fitRecord(notice);
  fs.appendFileSync(segmentPath(1), line + '\n', 'utf8');
  droppedWritten = dropped;
  try {
    const diag = require('./diag-log');
    diag.write('插件台账：排队触顶丢弃', pending, '条（已写入台账正文，丢弃时排队字节=', queuedBytes, '）');
  } catch (err) { reportInternal(err); }
}

/** 从队列头取一块（≤ CHUNK_BYTES，至少 1 条），返回拼好的文本与条数。 */
function takeChunk() {
  const parts = [];
  let bytes = 0;
  let count = 0;
  while (queue.length > 0 && (count === 0 || bytes + queue[0].bytes <= CHUNK_BYTES)) {
    const item = queue.shift();
    parts.push(item.line);
    bytes += item.bytes;
    count += 1;
  }
  queuedBytes = Math.max(0, queuedBytes - bytes);
  return { text: parts.join('\n') + '\n', count };
}

/**
 * 同步排空队列（崩溃路径/退出钩子可直接等待）。
 *
 * @param {number} [deadlineMs] 预算，默认 500ms（官方退出/恢复/安装准备 ≤500ms）。
 * @returns {{flushed:number, dropped:number, failed:number, remaining:number, disabled:boolean, ms:number, deferred:number}}
 *   预算内没排完的记录**留在队列**（不丢），由 `deferred` 如实报告；退出钩子会再试一次。
 */
function flush(deadlineMs) {
  const budget = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : EXIT_FLUSH_DEADLINE_MS;
  const startedAt = Date.now();
  let flushed = 0;
  if (disabled) {
    return { flushed: 0, dropped, failed, remaining: queue.length, deferred: queue.length, disabled: true, ms: 0 };
  }
  try {
    ensureDir();
    if (dropped > droppedWritten) writeDropNotice();
    while (queue.length > 0) {
      if (Date.now() - startedAt >= budget) break;
      const chunk = takeChunk();
      const file = segmentPath(1);
      rotateIfFull(file);
      fs.appendFileSync(file, chunk.text, 'utf8');
      flushed += chunk.count;
      written += chunk.count;
    }
  } catch (err) {
    disableWrites(err);
  }
  return {
    flushed,
    dropped,
    failed,
    remaining: queue.length,
    deferred: queue.length,
    disabled,
    ms: Date.now() - startedAt
  };
}

/** 排一次定时器（已排则不重复；unref 掉，绝不拖住进程退出）。 */
function scheduleFlush() {
  if (flushTimer || disabled) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(EXIT_FLUSH_DEADLINE_MS); }, FLUSH_INTERVAL_MS);
  if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * 关键操作失败时，另用 diag-log 的 durability 层留一条「返回即可读」的证据。
 * 只对 isolate / restore 的**失败**生效（低频，且正是事故现场）；install/enable 这类
 * 高频动作绝不走同步写 —— 那会把 H-10 的性能收益吐回去。
 */
function mirrorCriticalFailure(entry) {
  if (entry.result !== 'fail' || !MIRROR_FAILURE_ACTIONS.includes(entry.action)) return;
  try {
    const diag = require('./diag-log');
    diag.writeDurable('插件台账 关键操作失败', `${entry.action} plugin=${entry.plugin || '-'} version=${entry.version || '-'} reason=${entry.reason || '-'} phase=${entry.phase}`);
  } catch (err) { reportInternal(err); }
}

/**
 * 记一条插件操作（同步入队，行级零文件系统调用）。
 * @param {object} entry 见 04_方案与审计/plugin-journal_main接线点清单.md
 * @returns {boolean} true = 已入队等待落盘；false = 排队触顶被丢弃（已计数，正文会记）
 */
function record(entry) {
  try {
    const normalized = normalizeEntry(entry);
    const line = fitRecord(normalized);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (queuedBytes + bytes > QUEUE_BYTES) {
      dropped += 1;
      normalized.persisted = false;
      pushRecent(normalized);
      return false;
    }
    normalized.persisted = true;
    queue.push({ line, bytes, entry: normalized });
    queuedBytes += bytes;
    pushRecent(normalized);
    mirrorCriticalFailure(normalized);
    scheduleFlush();
    return true;
  } catch (err) {
    reportInternal(err);
    return false;
  }
}

/** 台账状态（验收/排障依据：所有计数都曝光，不藏在闭包里）。 */
function status() {
  return {
    dropped,
    droppedWritten,
    failed,
    queuedBytes,
    disabled,
    queued: queue.length,
    written,
    invalidActions,
    recentCount: recentEntries.length,
    recentBytes,
    lastError,
    dir: journalDir(),
    limits: { segmentBytes: SEGMENT_BYTES, segments: SEGMENT_COUNT, recordBytes: RECORD_BYTES, queueBytes: QUEUE_BYTES }
  };
}

// ── 退出钩子（四路，缺一不可）──────────────────────────────────────────────
/**
 * 与 diag-log 同一套思路，但用**独立**的钩子注册表（`dsh.exitFlushHooks`）：
 * 两个模块各自包装 `app.exit`/`process.exit` 时形成链式调用（先装的先跑），
 * 谁都不会漏掉自己的 flush。阶段一实测：`app.exit()` 既不触发 `before-quit`/`will-quit`，
 * 也不走 Node 的 `exit` —— 只挂一个钩子会把整本台账丢掉。
 */
const EXIT_HOOKS_KEY = Symbol.for('dsh.exitFlushHooks');

function installExitHooks(flushFn) {
  let hooks = globalThis[EXIT_HOOKS_KEY];
  if (hooks) { hooks.push(flushFn); return; }
  hooks = [flushFn];
  Object.defineProperty(globalThis, EXIT_HOOKS_KEY, { value: hooks, enumerable: false });

  const runAll = () => {
    for (const fn of hooks.slice()) {
      try { fn(); } catch (err) { reportInternal(err); }
    }
  };

  process.on('exit', runAll);
  if (electronApp && typeof electronApp.exit === 'function') {
    const rawAppExit = electronApp.exit.bind(electronApp);
    electronApp.exit = function journalPatchedAppExit(code) { runAll(); return rawAppExit(code); };
  }
  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('will-quit', runAll);
  }
  const rawProcessExit = process.exit.bind(process);
  process.exit = function journalPatchedProcessExit(code) { runAll(); return rawProcessExit(code); };
}

installExitHooks(() => flush(EXIT_FLUSH_DEADLINE_MS));

module.exports = {
  record,
  recent,
  renderRecent,
  flush,
  status,
  journalDir,
  segmentPath,
  segmentPaths,
  formatEntryLine,
  // 常量（崩溃报告/测试/接线方共用，避免各自写死）
  SEGMENT_BYTES,
  SEGMENT_COUNT,
  RECORD_BYTES,
  QUEUE_BYTES,
  RECENT_LIMIT,
  EXIT_FLUSH_DEADLINE_MS,
  CRASH_FLUSH_DEADLINE_MS,
  ACTIONS,
  SOURCES,
  PHASES
};
