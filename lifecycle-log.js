'use strict';

/**
 * 进程生命周期台账 —— 0.3.46 新增（取证盲区的直接修复点）。
 *
 * ── 为什么需要 ──
 *
 * 2026-10-20 19:59 的旧实例消失后，事后取证卡在同一个死角：
 * 「应用内静默退出（托盘退出等）」与「外部强杀（任务管理器 / 杀软 / 系统
 * 策略 / 断电）」在证据上**完全等价** —— 因为 DSH Desktop 的正常退出路径
 * 此前**一行日志都不写**，而本机 crashpad 未启用、4689 审计未开。
 * 于是「谁杀��了 68384」至今无法指认。
 *
 * 本模块补上这一层：每个进程实例在**启动时**写一条 start 记录，在**每条
 * 退出路径上**写一条带原因的 exit 记录。判读规则很简单：
 *
 *   有 start 无 exit  ⇒ 进程没走到任何退出路径 ⇒ 外部强杀 / 断电 / 内核崩溃
 *   有 exit           ⇒ 应用内退出，原因（reason 字段）写在案
 *
 * ── 落盘位置与格式 ──
 *
 *   <logs>/DSH-Desktop-生命周期.log    每行一条 JSON（append-only，可 grep）
 *   <logs>/session-<pid>.json          本次实例的状态快照（退出时补写 endedAt/reason）
 *
 * 写台账失败**绝不影响**主流程（与 diag-log 同一纪律）。
 */

const fs = require('fs');
const path = require('path');

let diagLog = null;
try { diagLog = require('./diag-log'); } catch (_) { /* 单测环境 */ }

const LEDGER_NAME = 'DSH-Desktop-生命周期.log';
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

/** 本进程是否已写入过 exit 记录（避免重复写）。 */
let exitRecorded = false;
/** 本次实例的 start 记录。 */
let startRecord = null;

function logsDir() {
  try {
    if (diagLog && typeof diagLog.logsDir === 'function') return diagLog.logsDir();
  } catch (_) {}
  try {
    const os = require('os');
    return path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'logs');
  } catch (_) {
    return path.join(process.cwd(), 'logs');
  }
}

function ledgerFile() { return path.join(logsDir(), LEDGER_NAME); }
function sessionFile(pid = process.pid) { return path.join(logsDir(), `session-${pid}.json`); }

/** 写台账一行（append-only）。失败静默 —— 台账绝不抛错。 */
function append(entry) {
  try {
    const file = ledgerFile();
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_) {}
    // 滚动：超阈值就按时间戳存档（只处理我方命名的文件）
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LEDGER_BYTES) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(file, file.replace(/\.log$/, `-${stamp}.log`));
      }
    } catch (_) {}
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) { /* 台账绝不抛错 */ }
}

/** 写本次实例的状态快照。 */
function writeSession(state) {
  try {
    const file = sessionFile();
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (_) { /* 台账绝不抛错 */ }
}

function baseEntry(event) {
  return {
    t: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    event,
  };
}

/**
 * 记录启动。reason 描述「这次是怎么起来的」：boot / auto-start-hidden / restart-update。
 */
function start(reason = 'boot', detail = {}) {
  const entry = baseEntry('start');
  entry.reason = String(reason || 'boot');
  let version = 'unknown';
  try {
    const electronApp = require('electron').app;
    version = (electronApp && electronApp.getVersion && electronApp.getVersion()) || 'unknown';
  } catch (_) {}
  entry.version = version;
  entry.electron = process.versions.electron || null;
  entry.node = process.versions.node;
  entry.argv = process.argv.slice(1);
  entry.detail = detail || {};
  startRecord = entry;
  append(entry);
  writeSession({
    pid: process.pid,
    startedAt: entry.t,
    reason: entry.reason,
    version: entry.version,
    endedAt: null,
    exitReason: null,
    state: 'running',
  });
  return entry;
}

/**
 * 记录退出（含原因）。同一个进程只记第一次。
 * @param {string} reason 机器可读的原因码（tray-quit / user-exit-dialog / …）
 * @param {string|object} detail 补充说明
 */
function exit(reason = 'unknown', detail = '') {
  if (exitRecorded) return null;
  exitRecorded = true;
  const entry = baseEntry('exit');
  entry.reason = String(reason || 'unknown');
  entry.detail = typeof detail === 'string' ? detail : safeJson(detail);
  entry.uptimeMs = startRecord ? Date.parse(entry.t) - Date.parse(startRecord.t) : null;
  append(entry);
  writeSession({
    pid: process.pid,
    startedAt: startRecord ? startRecord.t : null,
    reason: startRecord ? startRecord.reason : null,
    version: startRecord ? startRecord.version : 'unknown',
    endedAt: entry.t,
    exitReason: entry.reason,
    exitDetail: entry.detail,
    state: 'exited',
  });
  return entry;
}

/** 记录异常终止（未捕获异常 / 启动致命失败）。仍然算「应用内退出」，但原因显式。 */
function crash(reason = 'crash', detail = '') {
  return exit(reason, detail);
}

/** 任意事件备注（不改变退出状态）。 */
function note(event, detail = '') {
  const entry = baseEntry(String(event || 'note'));
  entry.detail = typeof detail === 'string' ? detail : safeJson(detail);
  append(entry);
  return entry;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

/**
 * 判读辅助：读出台账里「有 start 无 exit」的实例（= 非应用内退出）。
 * @returns {Array<{pid:number, startedAt:string, version:string}>}
 */
function readOrphanSessions() {
  const out = [];
  try {
    const dir = logsDir();
    for (const name of fs.readdirSync(dir)) {
      if (!/^session-\d+\.json$/.test(name)) continue;
      try {
        const st = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (st && st.state === 'running') out.push({ pid: st.pid, startedAt: st.startedAt, version: st.version });
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

module.exports = {
  LEDGER_NAME,
  ledgerFile,
  sessionFile,
  logsDir,
  start,
  exit,
  crash,
  note,
  readOrphanSessions,
  // 测试钩子
  _internal: { append, writeSession, exitRecorded: () => exitRecorded },
};
