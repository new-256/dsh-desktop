'use strict';

/**
 * 桌面诊断日志（diag-log v2 · 0.3.29）
 *
 * 集中管理：日志从桌面移到应用自己的目录（优先安装目录 \logs，不可写则回退
 * 到用户数据目录 \logs），桌面只在"疑似故障"出现时才生成错误报告文件。
 *   - 主日志　DSH-Desktop-日志.txt（超过 10MB 自动按时间戳切分存档）
 *   - 错误清单 DSH-Desktop-错误清单.txt（单独列出疑似故障条目；超过 2MB 同样切分）
 *   - 桌面报告 DSH-Desktop-错误报告-<时间>.txt（仅在捕获到疑似故障时写入桌面）
 *   - 定时清除：存档按份数（主日志 14 份 / 错误清单 7 份）与天数（30 天）双上限清理
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
let sessionHeaderWritten = false;
let desktopReportPath = null;                // 本次启动的桌面错误报告文件

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
      let ageMs = Infinity;
      if (m) {
        const date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
        ageMs = now - Date.parse(date);
      }
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
  } catch (_) {}
}

function captureError(line) {
  try {
    const errFile = errorLogFile();
    rotateIfNeeded(errFile, MAX_ERROR_BYTES);
    fs.appendFileSync(errFile, line, 'utf8');
    // 桌面报告：本启动会话最多一个文件，超出大小上限即停止追加。
    if (!desktopReportPath) {
      const ddir = desktopDir();
      try { fs.mkdirSync(ddir, { recursive: true }); } catch (_) {}
      desktopReportPath = path.join(ddir, `DSH-Desktop-错误报告-${stampFile(timestamp())}.txt`);
      const hdr = `===== DSH Desktop 错误报告 ${timestamp()} PID=${process.pid} 版本=${((electronApp && electronApp.getVersion()) || 'unknown')} =====\n`;
      fs.appendFileSync(desktopReportPath, hdr, 'utf8');
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

module.exports = { write, logFile, errorLogFile, logsDir, desktopDir, housekeep };