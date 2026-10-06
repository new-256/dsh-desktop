'use strict';

/**
 * 崩溃报告（0.3.39 · 对齐官方 apps/desktop/src/crash-report.ts）
 *
 * 一次致命失败写一份**独立**的 crash-<UTC时间>-<来源>.log —— 弹窗只显示
 * 错误末尾几行，文件里保留完整诊断（inspect 深度受限 + 256KiB 截断）。
 * 没有它之前，长栈与后端 stderr 混进滚动日志，要么撑爆原生弹窗，要么
 * 在滚动中丢失关键头部。
 *
 *   - 来源：host（后端进程退出）/ renderer（主窗口加载失败/页面崩溃）
 *           / main（壳自身错误）
 *   - 头部：应用版本、平台/架构、Electron/Node 版本、后端是否已就绪
 *   - 正文：完整错误（inspect depth 6、单串 64KiB、总量 256KiB）、
 *           后端日志尾部（64KiB）、渲染层 error 级 console 尾部（64KiB）
 *   - 清理：只删匹配 crash-*.log 命名模式的文件，保留最新 10 份，
 *           目录里其他文件永不触碰（P2-2 纪律）
 *   - 写入失败/超时（1s）不影响弹窗 —— 弹窗无路径也照常出
 */

const fs = require('fs');
const path = require('path');
const { inspect } = require('util');

const CRASH_REPORT_PREFIX = 'crash-';
const CRASH_REPORTS_RETAINED = 10;
const CRASH_REPORT_NAME = /^crash-\d{4}-\d{2}-\d{2}T[\dZ-]+-(host|renderer|main)\.log$/;
const ERROR_SECTION_MAX_CHARS = 256 * 1024;
const MAX_STRING_LENGTH = 64 * 1024;
const TAIL_MAX_BYTES = 64 * 1024;
/** 弹窗 detail 总预算（UTF-16 码元）——对齐官方 DETAIL_BUDGET。 */
const DETAIL_BUDGET = 1200;
/** 弹窗保留的错误尾部行数。 */
const DETAIL_TAIL_LINES = 8;

let electronApp = null;
try { electronApp = require('electron').app; } catch (_) { /* 单测环境 */ }

function crashDir() {
  // 与 diag-log 同目录策略：优先安装目录 logs，回退 userData logs。
  try { return path.join(electronApp.getAppPath(), 'logs'); } catch (_) {}
  try { return path.join(electronApp.getPath('userData'), 'logs'); } catch (_) {}
  return path.join(process.cwd(), 'logs');
}

/** 2026-09-23T12-34-56-789Z-host.log（按时间排序，来源在尾） */
function crashFileName(time, source) {
  return `${CRASH_REPORT_PREFIX}${time.toISOString().replace(/[:.]/gu, '-')}-${source}.log`;
}

/**
 * 有界字节尾部：从头部开始保留 maxBytes。官方从最旧行起丢，这里更简单——
 * 超限时保留尾部（错误的关键信息几乎总在末尾）。
 */
function boundedTail(text, maxBytes = TAIL_MAX_BYTES) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const cut = s.slice(-Math.floor(maxBytes / 2)); // utf8 安全余量后重判
  return `…（前文超长已截断）\n` + (Buffer.byteLength(cut, 'utf8') > maxBytes ? cut.slice(-maxBytes) : cut);
}

/**
 * 渲染一个完整错误段：inspect 深度 6、单串 64KiB、总量 256KiB，超限标记截断。
 */
function renderErrorSection(error) {
  let rendered;
  try {
    rendered = inspect(error, { depth: 6, maxStringLength: MAX_STRING_LENGTH, maxArrayLength: 1024, breakLength: 120 });
  } catch (_) {
    rendered = String(error);
  }
  return rendered.length <= ERROR_SECTION_MAX_CHARS
    ? rendered
    : `${rendered.slice(0, ERROR_SECTION_MAX_CHARS)}\n… (error section cut at ${ERROR_SECTION_MAX_CHARS} chars)`;
}

/**
 * 写一份崩溃报告。返回文件路径；失败返回 null（弹窗照常出，只是不带路径）。
 * @param {object} input
 *   { source: 'host'|'renderer'|'main', phase: 'startup'|'running',
 *     error, backendReady: boolean, backendLogTail: string,
 *     rendererConsole: string[] }
 */
function writeCrashReport(input) {
  try {
    const time = new Date();
    const dir = crashDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const header = [
      `===== DSH Desktop 崩溃报告 ${time.toISOString()} =====`,
      `source: ${input.source}   phase: ${input.phase}`,
      `backendReady: ${!!input.backendReady}`,
      `version: ${appVersion()}`,
      `platform: ${process.platform} ${process.arch}`,
      `electron: ${process.versions.electron}   node: ${process.versions.node}`
    ].join('\n');
    const sections = [
      header,
      '\n----- error -----',
      renderErrorSection(input.error),
      '\n----- backend log tail -----',
      boundedTail(input.backendLogTail || ''),
      '\n----- renderer console (error level, oldest first) -----',
      (input.rendererConsole || []).join('\n')
    ];
    const file = path.join(dir, crashFileName(time, input.source));
    fs.writeFileSync(file, sections.join('\n') + '\n', 'utf8');
    return file;
  } catch (_) {
    return null;
  }
}

/**
 * 清理旧报告：只删匹配命名模式的 crash-*.log，保留最新 CRASH_REPORTS_RETAINED 份。
 * 目录里的其他文件（日志存档、用户文件）永不触碰。
 */
function pruneCrashReports() {
  try {
    const dir = crashDir();
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return 0; }
    const reports = names.filter((n) => CRASH_REPORT_NAME.test(n)).sort();
    const excess = reports.slice(0, Math.max(0, reports.length - CRASH_REPORTS_RETAINED));
    for (const name of excess) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (_) { /* 下次再清 */ }
    }
    return excess.length;
  } catch (_) {
    return 0;
  }
}

/**
 * 组装致命弹窗的 detail：预算 1200 码元内放「错误尾部 8 行 + 报告路径 + 重装
 * 建议」；完整内容在报告文件里。
 */
function crashDialogDetail(errorText, reportPath, advice) {
  const lines = String(errorText || '').split(/\r\n|[\n\r\u2028\u2029]/u);
  const tailLines = lines.slice(-DETAIL_TAIL_LINES);
  const truncated = tailLines.length < lines.length;
  const tail = tailLines.join('\n');
  const report = reportPath ? `\n\n崩溃报告已写入：${reportPath}` : '';
  const adviceText = advice ? `\n\n${advice}` : '';
  const budget = DETAIL_BUDGET - report.length - adviceText.length - 24;
  let body = (truncated ? `…（前文已省略，完整见崩溃报告）\n` : '') + tail;
  if (body.length > budget) body = `…\n` + body.slice(-budget);
  return body + report + adviceText;
}

function appVersion() {
  try { return electronApp && electronApp.getVersion ? electronApp.getVersion() : 'unknown'; } catch (_) { return 'unknown'; }
}

module.exports = {
  writeCrashReport,
  pruneCrashReports,
  crashDialogDetail,
  crashDir,
  CRASH_REPORTS_RETAINED,
  DETAIL_BUDGET,
  // 测试钩子
  _internal: { renderErrorSection, boundedTail, crashFileName, CRASH_REPORT_NAME, DETAIL_TAIL_LINES }
};
