'use strict';

/**
 * 桌面诊断日志（diag-log）
 *
 * 把 DSH Desktop 启动与更新流程中的全部行为数据和错误数据实时写入用户桌面：
 *   - 启动序列每一步（seed / 应用暂存 / Node 门槛 / 插件隔离 / 后端拉起）
 *   - 更新流程每一次检查、确认、下载、暂存、应用、重启
 *   - 后端进程的 stdout/stderr、退出码
 *   - 未捕获异常与未处理的 Promise 拒绝（含堆栈）
 *
 * 日志文件：桌面\DSH-Desktop-日志.txt（单文件；超过 10MB 自动轮转为 -旧.txt）
 * 写日志失败绝不影响主流程。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

let electronApp = null;
try { electronApp = require('electron').app; } catch (_) { /* 非 Electron 环境（单测） */ }

const MAX_BYTES = 10 * 1024 * 1024;
let sessionHeaderWritten = false;

function logFile() {
  let desktop = null;
  try { desktop = electronApp && electronApp.getPath('desktop'); } catch (_) {}
  if (!desktop || typeof desktop !== 'string') desktop = path.join(os.homedir(), 'Desktop');
  return path.join(desktop, 'DSH-Desktop-日志.txt');
}

function fmt(part) {
  if (part instanceof Error) return part.stack || part.message || String(part);
  if (typeof part === 'object' && part !== null) {
    try { return JSON.stringify(part); } catch (_) { return String(part); }
  }
  return String(part);
}

function write(...parts) {
  try {
    const file = logFile();
    if (!sessionHeaderWritten) {
      sessionHeaderWritten = true;
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_BYTES) fs.renameSync(file, file.replace(/\.txt$/, '-旧.txt'));
      } catch (_) { /* 文件尚不存在 */ }
      let ver = 'unknown';
      try { ver = (electronApp && electronApp.getVersion()) || 'unknown'; } catch (_) {}
      fs.appendFileSync(file, `\n===== 会话开始 PID=${process.pid} 版本=${ver} ${new Date().toISOString()} =====\n`, 'utf8');
    }
    const line = `[${new Date().toISOString()}] ${parts.map(fmt).join(' ')}\n`;
    fs.appendFileSync(file, line, 'utf8');
    process.stdout.write('[diag] ' + line);
  } catch (_) {
    /* 诊断日志绝不抛错 */
  }
}

module.exports = { write, logFile };
