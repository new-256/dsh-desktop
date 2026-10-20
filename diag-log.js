'use strict';

/**
 * 桌面诊断日志（diag-log v2 · 0.3.29）
 *
 * 集中管理：日志从桌面移到应用自己的目录（优先安装目录 \logs，不可写则回退
 * 到用户数据目录 \logs），桌面只在"疑似故障"出现时才生成错误报告文件。
 *   - 主日志　DSH-Desktop-日志.txt（超过 10MB 自动按时间戳切分存档）
 *   - 错误清单 DSH-Desktop-错误清单.txt（单独列出疑似故障条目；超过 2MB 同样切分）
 *   - 桌面报告 DSH-Desktop-错误报告.txt（**固定名**：桌面永远只有「当前这一份」）
 *   - 定时清除：存档按份数（主日志 14 份 / 错误清单 7 份 / 桌面报告 10 份）与
 *     天数（30 天）双上限清理
 *
 * 写日志失败绝不影响主流程。
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
let sessionHeaderWritten = false;
let desktopReportPath = null;                // 本次启动的桌面错误报告文件（固定名）
let desktopArchiveDone = false;              // 本次启动是否已归档过桌面历史报告

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

/** 超阈值 → 按时间戳切分存档（取代旧的固定 -旧.txt 覆盖）；同秒多次触发加序号后缀防覆盖。 */
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

function captureError(line) {
  try {
    const errFile = errorLogFile();
    rotateIfNeeded(errFile, MAX_ERROR_BYTES);
    fs.appendFileSync(errFile, line, 'utf8');
    // 桌面报告：**固定名** —— 桌面永远只有「当前这一次」一份。
    if (!desktopReportPath) {
      const ddir = desktopDir();
      try { fs.mkdirSync(ddir, { recursive: true }); } catch (_) {}
      desktopReportPath = path.join(ddir, DESKTOP_REPORT_NAME);
      const hdr = `===== DSH Desktop 错误报告 ${timestamp()} PID=${process.pid} 版本=${((electronApp && electronApp.getVersion()) || 'unknown')} =====\n`;
      // 写头用覆盖语义：本次启动从头开始（上一轮的那份已在启动时归档）
      fs.writeFileSync(desktopReportPath, hdr, 'utf8');
      housekeep();
    }
    if (fs.statSync(desktopReportPath).size < MAX_DESKTOP_REPORT_BYTES) {
      fs.appendFileSync(desktopReportPath, line, 'utf8');
    }
  } catch (_) { /* 诊断日志绝不抛错 */ }
}

function write(...parts) {
  try {
    const file = logFile();
    if (!sessionHeaderWritten) {
      sessionHeaderWritten = true;
      let ver = 'unknown';
      try { ver = (electronApp && electronApp.getVersion()) || 'unknown'; } catch (_) {}
      fs.appendFileSync(file, `\n===== 会话开始 PID=${process.pid} 版本=${ver} 日志目录=${path.dirname(file)} ${timestamp()} =====\n`, 'utf8');
      // 0.3.47 · 桌面只留当前这一份：上一轮的报告与历史遗留的时间戳名报告
      // 全部归档到安装目录 logs/（归档再按份数 + 天数定期清除）。
      archiveDesktopReports();
      housekeep();
    }
    // 每次写入都检查滚动阈值（长会话内同样会切分，而不是只在下一次启动时）。
    rotateIfNeeded(file, MAX_BYTES);
    const line = `[${timestamp()}] ${parts.map(fmt).join(' ')}\n`;
    fs.appendFileSync(file, line, 'utf8');
    process.stdout.write('[diag] ' + line);
    if (ERROR_LINE_RE.test(line)) captureError(line);
  } catch (_) {
    /* 诊断日志绝不抛错 */
  }
}

module.exports = {
  write, logFile, errorLogFile, logsDir, desktopDir, housekeep,
  // 0.3.47 · 桌面报告纪律（固定名 + 归档 + 定期清除）
  DESKTOP_REPORT_NAME, archiveDesktopReports,
  desktopReportPath: () => desktopReportPath,
};