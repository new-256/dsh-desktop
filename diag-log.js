'use strict';

/**
 * 桌面诊断日志（diag-log v3 · 0.3.48 · H-10：内存队列 + 定时批量刷盘）
 *
 * 集中管理：日志从桌面移到应用自己的目录（优先安装目录 \logs，不可写则回退
 * 到用户数据目录 \logs），桌面只在"疑似故障"出现时才生成错误报告文件。
 *   - 主日志　DSH-Desktop-日志.txt（超过 10MB 自动按时间戳切分存档）
 *   - 错误清单 DSH-Desktop-错误清单.txt（单独列出疑似故障条目；超过 2MB 同样切分）
 *   - 桌面报告 DSH-Desktop-错误报告.txt（**固定名**：桌面永远只有「当前这一份」）
 *   - 定时清除：存档按份数（主日志 14 份 / 错误清单 7 份 / 桌面报告 10 份）与
 *     天数（30 天）双上限清理
 *
 * 0.3.48 · H-10 之前：后端 stdout/stderr **每一行**都付一次 `statSync` + `appendFileSync`
 * （命中错误行再 ×2），全部发生在 Electron 主进程 —— 长会话/高频输出直接把事件
 * 循环堵在同步 IO 上。现在**分两层**（durability 分层，详见 feedsCriticalSink / writeDurable）：
 *
 *   ┌ 高频行（后端 stdout/stderr、普通 diag）→ 批量层
 *   │   ① `write()` 只做「格式化 + 正则判定 + 入内存队列 + 排一次定时器」，零文件系统调用；
 *   │   ② 定时器（默认 200ms）把队列按 ≤256KB 的块批量 `appendFileSync`，每块之前做一次
 *   │      滚动检查 —— 10MB 滚动语义与原来一致（超阈值即按时间戳切分），但系统调用从
 *   │      「每行 N 次」降到「每秒 N 次」；
 *   │   ③ 单次刷盘有时间预算（默认 12ms），预算内刷不完就留到下一拍继续，事件循环不被长占；
 *   │   ④ 队列有行数/字节双上限，触顶时**丢弃新到达的行并计数**，下一次刷盘把计数写进
 *   │      日志正文（用户硬规则：禁止静默丢弃）；
 *   └
 *   ┌ 关键产物（错误清单 / 桌面错误报告 / 显式 writeDurable 的产物）→ durability 层
 *   │   ⑤ **调用返回前必须已落盘**：命中 ERROR_LINE_RE 的记录自动 durable（它必然进错误
 *   │      清单 + 桌面报告，而这两个产物在 1s 内就会被对话框/用户引用），其他关键产物由
 *   │      调用点用 `writeDurable()` 显式声明；实现是「先同步刷干净队列（保顺序）→ 再直写」，
 *   │      因此关键记录不受队列上限影响，也不会插到更早的行前面；
 *   │   ⑥ 进程退出前同步清空队列：**四个口子**都要挂 —— `process 'exit'`、包装 `app.exit`、
 *   │      `app 'will-quit'`、包装 `process.exit`（实测 Electron 的 `app.exit()` 既不触发
 *   │      quit 事件也不走 Node 的 `exit`，只挂一个是会丢光队列的真缺陷，详见 installExitHooks）；
 *   │      预算对齐 crash-report.js 的 1s 上限；超预算未落盘的行数同样写进正文 + stderr，绝不静默。
 *   └
 *
 * 为什么不能"一律批量"（0.3.48 回归，test-047-desktop-report 4 项红）：批量化会让
 * 「桌面错误报告」这类关键产物在断言/对话框之前还不存在 —— 高频行可以晚 200ms，
 * 关键产物不行。分层判据是**去向**（进不进关键产物），不是文件名白名单。
 *
 * 语义保证：队列里的行**一定**落盘（除非触顶计数、退出超预算计数，二者都有记录）；
 * 磁盘故障时保留在队列重试并把错误打到 stderr 与 `status()`，不会假装成功。
 * 唯一可能的副作用是「故障重试可能重复写少量行」—— 重试优先保「不丢」。
 *
 * 写日志失败绝不影响主流程（本模块对外永不抛错；内部失败一律 stderr + 状态计数）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

let electronApp = null;
try { electronApp = require('electron').app; } catch (_) { /* 非 Electron 环境（单测） */ }

const MAX_BYTES = parseInt(process.env.DSH_DIAG_MAX_BYTES || '10485760', 10) || 10485760;          // 主日志滚动阈值
const MAX_ERROR_BYTES = parseInt(process.env.DSH_DIAG_MAX_ERROR_BYTES || '2097152', 10) || 2097152; // 错误清单滚动阈值
const MAX_ARCHIVES = parseInt(process.env.DSH_DIAG_MAX_ARCHIVES || '14', 10) || 14;                 // 主日志保留存档份数
const MAX_ERROR_ARCHIVES = parseInt(process.env.DSH_DIAG_MAX_ERROR_ARCHIVES || '7', 10) || 7;       // 错误清单保留存档份数
const MAX_ARCHIVE_DAYS = parseInt(process.env.DSH_DIAG_MAX_ARCHIVE_DAYS || '30', 10) || 30;         // 存档最长保留天数
const MAX_DESKTOP_REPORT_BYTES = parseInt(process.env.DSH_DIAG_REPORT_MAX || '262144', 10) || 262144; // 桌面错误报告大小上限（超出停止追加）
const MAX_DESKTOP_REPORT_ARCHIVES = parseInt(process.env.DSH_DIAG_MAX_DESKTOP_REPORT_ARCHIVES || '10', 10) || 10; // 桌面报告归档保留份数
const MAX_DESKTOP_REPORT_ARCHIVE_DAYS = parseInt(process.env.DSH_DIAG_MAX_DESKTOP_REPORT_ARCHIVE_DAYS || '30', 10) || 30;

// ── 0.3.48 · H-10：批量刷盘参数（可用环境变量收紧，供压力测试；不改语义） ──────
const FLUSH_INTERVAL_MS = parseInt(process.env.DSH_DIAG_FLUSH_MS || '200', 10) || 200;              // 定时刷盘周期
const FOLLOW_UP_DELAY_MS = 25;               // 预算内没刷完时的下一拍间隔
const FLUSH_TICK_BUDGET_MS = parseInt(process.env.DSH_DIAG_FLUSH_TICK_BUDGET_MS || '12', 10) || 12; // 单次刷盘时间预算
const QUEUE_MAX_LINES = parseInt(process.env.DSH_DIAG_QUEUE_MAX_LINES || '100000', 10) || 100000;   // 队列行数上限（背压）
const QUEUE_MAX_BYTES = parseInt(process.env.DSH_DIAG_QUEUE_MAX_BYTES || String(32 * 1024 * 1024), 10) || 32 * 1024 * 1024; // 队列字节上限
const CHUNK_MAX_BYTES = parseInt(process.env.DSH_DIAG_CHUNK_BYTES || String(256 * 1024), 10) || 256 * 1024; // 单块上限（也是滚动检查粒度）
const FLUSH_BUDGET_MS = parseInt(process.env.DSH_DIAG_FLUSH_BUDGET_MS || '1000', 10) || 1000;       // 退出刷盘预算（对齐 crash-report 1s）
const CHUNK_MAX_LINES = 2000;                // 单块行数上限（防止极小行把块数放大）

let sessionHeaderWritten = false;
let desktopReportPath = null;                // 本次启动的桌面错误报告文件（固定名）
let desktopArchiveDone = false;              // 本次启动是否已归档过桌面历史报告

// ── 队列表（不变量：queueHead 之前的元素均已出队） ────────────────────────────
let queue = [];
let queueHead = 0;
let queueBytes = 0;
let flushTimer = null;
let droppedLines = 0;                        // 已丢弃、尚未写进日志正文的行数
let droppedTotal = 0;                        // 累计丢弃行数
let writeErrors = 0;                         // 刷盘失败次数（stderr 每次都打）
let lastError = null;
let flushCount = 0;
let lastFlushMs = 0;

/**
 * 桌面报告的**固定名**（0.3.47）。
 *
 * 0.3.46 之前桌面报告文件名带时间戳（`DSH-Desktop-错误报告-<时间戳>.txt`），
 * 每次启动新建一个、**从不清理** —— 桌面上因此堆了 7 份历史报告（实测
 * 2026-10-19 一天就 5 份），排查时根本分不清哪份是当前的。
 *
 * 现在：桌面只留 `DSH-Desktop-错误报告.txt` 一份（当前这次启动的），
 * 上一轮的以及 0.3.46 之前遗留的时间戳名报告，全部归档到安装目录 logs/，
 * 并按份数 + 天数定期清除。
 */
const DESKTOP_REPORT_NAME = 'DSH-Desktop-错误报告.txt';
/** 归档名（也用于识别 0.3.46 之前遗留在桌面上的历史报告）。 */
const DESKTOP_REPORT_ARCHIVE_RE = /^DSH-Desktop-错误报告-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.txt$/;

/** 疑似故障行匹配：捕获进错误清单的关键字（英文错误关键字 + 中文提示）。 */
const ERROR_LINE_RE = /error|fail|crash|fatal|exception|uncaught|unhandled|cannot |unable |refused|timeout|abort|denied|enoent|eacces|eperm|eaddr|etimedout|econnrefused|ERR_[A-Z0-9_]+|SyntaxError|TypeError|ReferenceError|RangeError|is not a function|is not defined|exit code|code=\d|non-zero|失败|错误|异常|崩溃|找不到|无法|拒绝|超时|出错|异常退出/i;

function fmt(part) {
  if (part instanceof Error) return part.stack || part.message || String(part);
  if (typeof part === 'object' && part !== null) {
    try { return JSON.stringify(part); } catch (_) { return String(part); }
  }
  return String(part);
}

function timestamp() { return new Date().toISOString(); }
/** 2026-09-09T02:15:30.123Z → 2026-09-09-021530 */
function stampFile(ts) { return ts.replace(/[:.]/g, '').replace('T', '-').slice(0, 17); }

/** 测试注入：DSH_DIAG_BASE 设置后日志落在 <base>\logs、桌面报告落在 <base>\desktop，跳过目录探测。 */
function envBase() { return process.env.DSH_DIAG_BASE || null; }

/** 安装目录候选（打包后 exe 所在目录 \logs）；开发/测试态（node/electron 解释器）不参与。 */
function installLogsDirCandidate() {
  try {
    const name = path.basename(process.execPath).toLowerCase();
    if (name === 'node.exe' || name === 'electron.exe') return null;
    const dir = path.dirname(process.execPath);
    return dir ? path.join(dir, 'logs') : null;
  } catch (_) { return null; }
}

function userDataDir() {
  try {
    const d = electronApp && electronApp.getPath('userData');
    if (d) return d;
  } catch (_) {}
  return path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop');
}

function logsDir() {
  const base = envBase();
  if (base) {
    const dir = path.join(base, 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
  }
  for (const dir of [installLogsDirCandidate(), path.join(userDataDir(), 'logs')]) {
    if (!dir) continue;
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch (_) {}
  }
  return path.join(userDataDir(), 'logs');
}

function desktopDir() {
  const base = envBase();
  if (base) return path.join(base, 'desktop');
  try { return electronApp && electronApp.getPath('desktop'); } catch (_) {}
  return path.join(os.homedir(), 'Desktop');
}

function logFile() { return path.join(logsDir(), 'DSH-Desktop-日志.txt'); }
function errorLogFile() { return path.join(logsDir(), 'DSH-Desktop-错误清单.txt'); }

/**
 * 超阈值 → 按时间戳切分存档（取代旧的固定 -旧.txt 覆盖）；同秒多次触发加序号后缀防覆盖。
 * 0.3.48 · H-10：调用点从「每行一次」改为「每块一次」，语义不变。
 */
function rotateIfNeeded(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return false;
    const stamp = stampFile(timestamp());
    let arch = file.replace(/\.txt$/, `-${stamp}.txt`);
    let n = 1;
    while (fs.existsSync(arch)) arch = file.replace(/\.txt$/, `-${stamp}-${n++}.txt`);
    fs.renameSync(file, arch);
    return true;
  } catch (_) { return false; }
}

/** 存档清理：按名称排序保留最新 keep 份，并删除超过 days 天的存档（定时清除）。 */
function pruneArchives(dir, nameRe, keep, days) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => nameRe.test(f))
      .map((f) => path.join(dir, f))
      .sort((a, b) => b.localeCompare(a));
    const now = Date.now();
    const S = 24 * 3600 * 1000;
    files.forEach((f, idx) => {
      const m = /-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.txt$/.exec(f);
      // P2-2 纪律：只删除「文件名带可解析时间戳」的我方存档。匹配了前缀却解析
      // 不出日期的文件可能是改名/外部文件 —— 永不因排序位置而误删。
      if (!m) return;
      const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
      if (Number.isNaN(t)) return;
      const ageMs = now - t;
      if (idx >= keep || ageMs > days * S) { try { fs.unlinkSync(f); } catch (_) {} }
    });
  } catch (_) {}
}

/** 保留期整理：在每个会话首次写日志时 + 主进程每日定时调用。 */
function housekeep() {
  try {
    const dir = logsDir();
    pruneArchives(dir, /^DSH-Desktop-日志-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.txt$/, MAX_ARCHIVES, MAX_ARCHIVE_DAYS);
    pruneArchives(dir, /^DSH-Desktop-错误清单-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.txt$/, MAX_ERROR_ARCHIVES, MAX_ARCHIVE_DAYS);
    // 桌面报告的归档（历史上都堆在桌面上，0.3.47 起归档到安装目录并定期清除）
    pruneArchives(dir, /^DSH-Desktop-错误报告-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.txt$/, MAX_DESKTOP_REPORT_ARCHIVES, MAX_DESKTOP_REPORT_ARCHIVE_DAYS);
  } catch (_) {}
}

/**
 * 把桌面上的历史报告归档到安装目录 logs，让桌面**只留当前这一份**。
 *
 * 做两件事：
 *   ① 上一轮留下的固定名报告 `DSH-Desktop-错误报告.txt` → 改名为带时间戳的
 *      归档名搬进 logs/（同盘用 rename，跨盘退化为 copy + unlink）；
 *   ② 0.3.46 之前遗留在桌面上的时间戳名报告（每次启动新建一份、从不清理）
 *      → 同样搬进 logs/；归档里已有同名则丢弃桌面那份（内容已在归档里）。
 *
 * 每次启动只做一次（在第一次写日志时触发）。归档失败不致命 —— 只是桌面
 * 多留一份文件，不影响主流程。
 */
function archiveDesktopReports() {
  if (desktopArchiveDone) return;
  desktopArchiveDone = true;
  const ddir = desktopDir();
  const ldir = logsDir();

  // ① 上一轮的固定名报告 → 归档
  try {
    const current = path.join(ddir, DESKTOP_REPORT_NAME);
    if (fs.existsSync(current)) {
      const stamp = stampFile(timestamp());
      let dest = path.join(ldir, `DSH-Desktop-错误报告-${stamp}.txt`);
      let n = 1;
      while (fs.existsSync(dest)) dest = path.join(ldir, `DSH-Desktop-错误报告-${stamp}-${n++}.txt`);
      try { fs.mkdirSync(ldir, { recursive: true }); } catch (_) {}
      try { fs.renameSync(current, dest); }
      catch (_) { try { fs.copyFileSync(current, dest); fs.unlinkSync(current); } catch (_) {} }
    }
  } catch (_) { /* 归档失败不影响主流程 */ }

  // ② 历史遗留的时间戳名报告 → 归档
  try {
    for (const name of fs.readdirSync(ddir)) {
      if (name === DESKTOP_REPORT_NAME) continue;
      if (!DESKTOP_REPORT_ARCHIVE_RE.test(name)) continue;
      const from = path.join(ddir, name);
      const to = path.join(ldir, name);
      try {
        if (fs.existsSync(to)) { fs.unlinkSync(from); continue; }
        fs.renameSync(from, to);
      } catch (_) {
        try { fs.copyFileSync(from, to); fs.unlinkSync(from); } catch (_) {}
      }
    }
  } catch (_) { /* 归档失败不影响主流程 */ }
}

// ══════════════════════════════════════════════════════════════════════════
// 0.3.48 · H-10：内存队列 + 批量刷盘
// ══════════════════════════════════════════════════════════════════════════

/** 队列里还剩多少行（queueHead 之前已出队）。 */
function queueLength() { return queue.length - queueHead; }

/** 队列搬移回收：head 前面已出队的槽位攒够了就整体截断，避免数组无限增长。 */
function compactQueue() {
  if (queueHead > 8192 && queueHead * 2 > queue.length) {
    queue = queue.slice(queueHead);
    queueHead = 0;
  }
}

/**
 * 入队。触顶时**丢弃新到达的行并计数**（已入队的行一定落盘），
 * 计数在下一次刷盘时写进日志正文 —— 不允许静默丢弃。
 */
function queuePush(record) {
  if (queueLength() >= QUEUE_MAX_LINES || queueBytes + record.bytes > QUEUE_MAX_BYTES) {
    droppedLines += 1;
    droppedTotal += 1;
    return false;
  }
  queue.push(record);
  queueBytes += record.bytes;
  return true;
}

/** 从队头取一批（受字节/行数上限约束），返回记录数组。 */
function takeBatch(maxBytes, maxLines) {
  const batch = [];
  let bytes = 0;
  while (queueHead < queue.length && batch.length < maxLines && (batch.length === 0 || bytes < maxBytes)) {
    const record = queue[queueHead++];
    batch.push(record);
    bytes += record.bytes;
  }
  queueBytes = Math.max(0, queueBytes - bytes);
  compactQueue();
  return batch;
}

/** 刷盘失败时把整批塞回队头（保「不丢」；故障重试可能重复少量行）。 */
function requeueFront(batch) {
  if (!batch.length) return;
  const rest = queue.slice(queueHead);
  queue = batch.concat(rest);
  queueHead = 0;
  for (const record of batch) queueBytes += record.bytes;
}

/** 记录一次刷盘故障：stderr 每次都打（禁止静默），并进状态供 UI/审计读取。 */
function reportWriteError(err) {
  writeErrors += 1;
  lastError = (err && (err.message || err.code)) || String(err);
  try { process.stderr.write(`[diag] 刷盘失败（第 ${writeErrors} 次）：${lastError}\n`); } catch (_) { /* stderr 也没了只能放弃 */ }
}

/** 队列触顶说明行：丢弃计数必须进日志正文（用户硬规则：禁止静默丢弃）。 */
function dropNoticeLine(count) {
  return `[${timestamp()}] ⚠ 诊断日志队列触顶（上限 ${QUEUE_MAX_LINES} 行 / ${QUEUE_MAX_BYTES} 字节）：本次丢弃 ${count} 行，累计丢弃 ${droppedTotal} 行；被丢弃的行仍完整打印在 [dsh-backend] 标准输出，可用控制台日志补齐\n`;
}

/** 追加一段文本到日志文件：追加前按原语义做滚动检查（超阈值即切分）。 */
function appendChunk(file, text, maxBytes) {
  rotateIfNeeded(file, maxBytes);
  fs.appendFileSync(file, text, 'utf8');
}

/**
 * 写一批错误行：错误清单（关键路径，失败交给上层重试）+ 桌面报告（副本，失败只登记）。
 * 桌面报告是「给用户看的副本」，它不可用不该阻断错误清单落盘，但也不能假装成功 ——
 * 失败会进 writeErrors/stderr，并在状态里可见。
 */
function writeErrorRecords(records) {
  if (!records.length) return;
  const text = records.map((r) => r.line).join('');
  appendChunk(errorLogFile(), text, MAX_ERROR_BYTES);
  try {
    if (!desktopReportPath) {
      const ddir = desktopDir();
      fs.mkdirSync(ddir, { recursive: true });
      desktopReportPath = path.join(ddir, DESKTOP_REPORT_NAME);
      const ver = (electronApp && electronApp.getVersion()) || 'unknown';
      const hdr = `===== DSH Desktop 错误报告 ${timestamp()} PID=${process.pid} 版本=${ver} =====\n`;
      // 写头用覆盖语义：本次启动从头开始（上一轮的那份已在启动时归档）
      fs.writeFileSync(desktopReportPath, hdr, 'utf8');
      housekeep();
    }
    if (fs.statSync(desktopReportPath).size < MAX_DESKTOP_REPORT_BYTES) {
      fs.appendFileSync(desktopReportPath, text, 'utf8');
    }
  } catch (err) {
    reportWriteError(err);
  }
}

/** 落一批记录：主日志（全部）+ 错误清单/桌面报告（疑似故障行）。 */
function writeBatch(batch) {
  const mainText = batch.map((r) => r.line).join('');
  appendChunk(logFile(), mainText, MAX_BYTES);
  const errors = batch.filter((r) => r.isError);
  writeErrorRecords(errors);
}

/**
 * 刷一次队列（定时器回调 / 测试直接调用）。
 *
 * 单次受 FLUSH_TICK_BUDGET_MS 约束：预算内刷不完就留到下一拍，事件循环不被长占；
 * 队列清空前一直排下一拍，因此入队的行最终一定落盘。
 */
function flushPending() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!queueLength() && !droppedLines) return;
  const startedAt = Date.now();

  // ① 逐块落盘；超预算即停，剩余留给下一拍
  while (queueLength() > 0) {
    if (Date.now() - startedAt >= FLUSH_TICK_BUDGET_MS) break;
    const batch = takeBatch(CHUNK_MAX_BYTES, CHUNK_MAX_LINES);
    try {
      writeBatch(batch);
    } catch (err) {
      reportWriteError(err);
      requeueFront(batch);
      break;
    }
  }

  // ② 丢弃计数写进日志正文 + stderr（即使这一拍又触顶，计数也先落出去）
  if (droppedLines > 0) {
    const count = droppedLines;
    droppedLines = 0;
    const notice = dropNoticeLine(count);
    try {
      appendChunk(logFile(), notice, MAX_BYTES);
      try { process.stderr.write(`[diag] ${notice}`); } catch (_) { /* stderr 不可用 */ }
    } catch (err) {
      droppedLines += count;   // 没写成就留着，下一拍再试（绝不静默丢计数）
      reportWriteError(err);
    }
  }

  flushCount += 1;
  lastFlushMs = Date.now() - startedAt;
  if (queueLength() > 0) scheduleFlush(FOLLOW_UP_DELAY_MS);
}

/** 排一次刷盘；已有待执行任务时不重复排（节流，避免高频输出把定时器刷爆）。 */
function scheduleFlush(delayMs) {
  if (flushTimer) return;
  const delay = Number.isFinite(delayMs) ? delayMs : FLUSH_INTERVAL_MS;
  flushTimer = setTimeout(() => { flushTimer = null; flushPending(); }, delay);
  // 定时器不得拖住进程退出：unref 后只要没有别的事件循环任务，进程可以正常结束
  if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * 退出/崩溃前同步清空队列（0.3.48 · H-10）。
 *
 * 预算默认 1s，对齐 crash-report.js 的落盘上限：不让 flush 拖长退出。
 * 预算内清不完全部队列时，剩余行数**写进日志正文**（写不进去就打 stderr）并把
 * 行数计入 droppedTotal —— 不接受静默丢弃。
 */
function flushSync(budgetMs) {
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : FLUSH_BUDGET_MS;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const deadline = Date.now() + budget;
  try {
    if (droppedLines > 0) {
      const count = droppedLines;
      droppedLines = 0;
      try {
        appendChunk(logFile(), dropNoticeLine(count), MAX_BYTES);
      } catch (err) {
        droppedLines += count;
        reportWriteError(err);
      }
    }
    while (queueLength() > 0) {
      if (Date.now() >= deadline) break;
      const batch = takeBatch(CHUNK_MAX_BYTES, CHUNK_MAX_LINES);
      try {
        writeBatch(batch);
      } catch (err) {
        reportWriteError(err);
        requeueFront(batch);
        break;
      }
    }
    if (queueLength() > 0) {
      const remaining = queueLength();
      droppedTotal += remaining;
      // 整表丢弃剩余（已落盘的前缀槽位一并清掉，避免 head 复位后把旧行当待写）
      queue = [];
      queueHead = 0;
      queueBytes = 0;
      const notice = `[${timestamp()}] ⚠ 退出刷盘超预算（${budget}ms）：剩余 ${remaining} 行未能落盘，累计丢弃 ${droppedTotal} 行\n`;
      try { appendChunk(logFile(), notice, MAX_BYTES); } catch (err) { reportWriteError(err); }
      try { process.stderr.write(`[diag] ${notice}`); } catch (_) { /* stderr 不可用 */ }
    }
  } catch (err) {
    reportWriteError(err);
  }
}

/**
 * 这条记录会不会进「关键产物」？—— 判据是**去向（sinks）**，不是文件名，也不是调用方。
 *
 * 关键产物 = 人类或后续进程在「写入返回后立刻」就要读的产物：
 *   · 错误清单 `DSH-Desktop-错误清单.txt`
 *   · 桌面错误报告 `DSH-Desktop-错误报告.txt`
 *   （crash-report.js 的契约：报告文件名要在 1s 内被对话框/用户引用；0.3.47 的
 *     桌面报告纪律也要求「本次启动出错后桌面上立刻就有这一份」）
 *
 * 一条记录只要命中 ERROR_LINE_RE，就**必然**同时写进上面两个产物 —— 因此它必须在
 * `write()` 返回前落盘。反之只进主日志的高频行（后端 stdout/stderr、普通 diag）没有
 * 「立刻被读」的契约，继续走 200ms 批量化，这才是 H-10 要省的那部分开销。
 *
 * 将来新增的关键产物（迁移记录、隔离记录、更新决策…）：由调用点显式用
 * `writeDurable()` 声明，而不是往本函数里堆文件名。
 */
function feedsCriticalSink(record) { return record.isError === true; }

/** 首次写入的会话初始化（会话头入队 + 桌面历史报告归档 + 存档清理，一次性）。 */
function ensureSessionStart() {
  if (sessionHeaderWritten) return;
  sessionHeaderWritten = true;
  const file = logFile();
  const ver = (electronApp && electronApp.getVersion()) || 'unknown';
  const header = `\n===== 会话开始 PID=${process.pid} 版本=${ver} 日志目录=${path.dirname(file)} ${timestamp()} =====\n`;
  queuePush({ line: header, bytes: Buffer.byteLength(header, 'utf8'), isError: false });
  scheduleFlush(0);
  // 0.3.47 · 桌面只留当前这一份：上一轮的报告与历史遗留的时间戳名报告
  // 全部归档到安装目录 logs/（归档再按份数 + 天数定期清除）。每次启动一次。
  archiveDesktopReports();
  housekeep();
}

/**
 * 写一条诊断日志（默认按 durability 分层自动判定是否 durable）。
 *
 * 0.3.48 · H-10：高频路径**不做任何文件系统调用** —— 只格式化、判定是否疑似故障、
 * 入队、排一次定时刷盘。后端高频输出时主线程开销从「每行两次同步 IO」降到「每行一次
 * Buffer.byteLength + 一次正则」。
 *
 * 但「批量」不能套到关键产物上（0.3.48 回归教训：桌面错误报告曾因此在断言/对话框
 * 之前还不存在）。所以这里分两层：见 feedsCriticalSink 与 writeDurable 的注释。
 */
function write(...parts) {
  writeRecord(parts, false);
}

/**
 * 关键产物写：**返回前必须已落盘**（durability 语义）。
 *
 * 给「调用点明确知道自己在写关键产物」的场景用 —— 迁移/隔离记录、更新决策、任何
 * 后续会被人类或另一个进程立刻读取的产物。实现是「屏障 + 直写」：
 *   ① 先把高频队列同步刷干净（保证顺序：关键记录不会插到更早的行前面）；
 *   ② 再把本条记录直接同步落盘（不进队列，因此也不受队列上限/丢弃计数影响）。
 * 预算复用退出刷盘的 1s 上限；超预算会按既有纪律把未落盘行数写进正文 + stderr，绝不静默。
 *
 * 注意：如果调用点写的内容同时命中 ERROR_LINE_RE，它会**同时**进错误清单与桌面报告
 * （与该记录走普通 write() 完全一致），这里只是把落盘时机提前到返回前。
 */
function writeDurable(...parts) {
  writeRecord(parts, true);
}

/** write / writeDurable 的共同实现。 */
function writeRecord(parts, forceDurable) {
  try {
    const line = `[${timestamp()}] ${parts.map(fmt).join(' ')}\n`;
    const record = { line, bytes: Buffer.byteLength(line, 'utf8'), isError: ERROR_LINE_RE.test(line) };
    ensureSessionStart();
    if (forceDurable || feedsCriticalSink(record)) {
      // 屏障：先把队列里的高频行落盘（保持时间顺序），再直写关键记录
      flushSync(FLUSH_BUDGET_MS);
      writeBatch([record]);
    } else {
      queuePush(record);
      scheduleFlush();
    }
    process.stdout.write('[diag] ' + line);
  } catch (err) {
    // 对外契约：诊断日志绝不抛错（这里是唯一兜底，且必须可见 —— 打 stderr）
    try { process.stderr.write(`[diag] 写日志异常：${(err && err.message) || err}\n`); } catch (_) { /* stderr 不可用 */ }
  }
}

/** 日志队列/刷盘状态（审计与测试依据：丢弃与失败计数都在这里，不藏在闭包里）。 */
function status() {
  return {
    queuedLines: queueLength(),
    queuedBytes: queueBytes,
    droppedPending: droppedLines,
    droppedTotal,
    writeErrors,
    lastError,
    flushCount,
    lastFlushMs,
    flushIntervalMs: FLUSH_INTERVAL_MS,
    queueMaxLines: QUEUE_MAX_LINES,
    queueMaxBytes: QUEUE_MAX_BYTES,
    tickBudgetMs: FLUSH_TICK_BUDGET_MS,
    exitFlushBudgetMs: FLUSH_BUDGET_MS
  };
}

/**
 * 退出钩子：把"进程要没了"这件事变成确定性的 flush。
 *
 * 0.3.48 · H-10 实测结论（必须保留记录）：**Electron 的 `app.exit(code)` 不会触发 Node 的
 * `process 'exit'` 事件**，也不会触发 `before-quit`/`will-quit` —— 只用 `process.once('exit')`
 * 时，一次 `app.exit(0)` 会让队列里全部行凭空消失（冒烟实测：写入 3 行 → `app.exit(0)` →
 * 磁盘上 0 行）。而 `main.js` 的「更新后重启」正是 `app.relaunch + app.exit(0)`，那恰好是
 * 最需要日志的时刻。
 *
 * 因此这里装四个口子（缺一不可）：
 *   ① `process 'exit'`   —— 纯 Node（测试子进程）与部分正常退出；
 *   ② `app.exit(code)` 包装 —— Electron 立即退出（app.exit 的文档明确不触发 quit 事件）；
 *   ③ `app 'will-quit'` —— 正常 `app.quit()` 路径；
 *   ④ `process.exit(code)` 包装 —— 其他模块直接调 process.exit 的情况。
 *
 * 多实例安全：钩子集合挂在 `Symbol.for('dsh.diag.flushHooks')` 上，重复 require（测试里
 * 每个阶段一套干净模块）只安装一次包装器，各实例把「自己的 flushSync」注册进同一个集合。
 */
const FLUSH_HOOKS_KEY = Symbol.for('dsh.diag.flushHooks');

function installExitHooks(flushFn) {
  let hooks = globalThis[FLUSH_HOOKS_KEY];
  if (hooks) { hooks.push(flushFn); return; }

  hooks = [flushFn];
  Object.defineProperty(globalThis, FLUSH_HOOKS_KEY, { value: hooks, enumerable: false });

  const reportHookError = (err) => {
    try { process.stderr.write(`[diag] 退出刷盘异常：${(err && err.message) || err}\n`); } catch (_) { /* stderr 不可用 */ }
  };
  const runAll = () => {
    for (const fn of hooks.slice()) {
      try { fn(); } catch (err) { reportHookError(err); }
    }
  };

  process.on('exit', runAll);

  if (electronApp && typeof electronApp.exit === 'function') {
    const rawAppExit = electronApp.exit.bind(electronApp);
    electronApp.exit = function diagPatchedAppExit(code) { runAll(); return rawAppExit(code); };
  }
  if (electronApp && typeof electronApp.on === 'function') {
    electronApp.on('will-quit', runAll);
  }

  const rawProcessExit = process.exit.bind(process);
  process.exit = function diagPatchedProcessExit(code) { runAll(); return rawProcessExit(code); };
}

installExitHooks(() => flushSync(FLUSH_BUDGET_MS));

module.exports = {
  write, writeDurable, logFile, errorLogFile, logsDir, desktopDir, housekeep,
  // 0.3.47 · 桌面报告纪律（固定名 + 归档 + 定期清除）
  DESKTOP_REPORT_NAME, archiveDesktopReports,
  desktopReportPath: () => desktopReportPath,
  // 0.3.48 · H-10：队列 / 批量刷盘 / 关键产物 durability 对外接口
  flush: flushPending, flushSync, status
};
