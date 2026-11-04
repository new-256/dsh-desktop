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
 *   - 0.3.49 · B-04：**基础报告写完之后**再追加一段「最近 N 条插件操作」
 *     （`plugin-journal.js`），标题照抄官方：
 *         recent plugin operations (context, not proof of cause)
 *     即：它只是**上下文**，不是根因证据 —— 不得据此宣称某个插件导致了崩溃，
 *     也不得喂给自愈阶梯的 needs-proof 判定。附加段是 best-effort：失败时基础
 *     报告仍然完整可用，且基础报告的字节**从不重写**（只追加）。
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
/** 0.3.42 · 崩溃报告落盘等待上限（对齐官方 fatal-recovery.ts:20）：超时照常弹窗。 */
const CRASH_REPORT_WAIT_MS = 1000;
/**
 * 0.3.49 · B-04：插件操作段标题 —— 逐字照抄官方（`operation-report.ts`）。
 * 这句话是这个段的**契约**：它是上下文，不是因果证据。
 */
const PLUGIN_OP_SECTION_TITLE = 'recent plugin operations (context, not proof of cause)';
/** 附进崩溃报告的插件操作条数上限（再多也不值当，报告要给人读）。 */
const PLUGIN_OP_MAX = 40;
/** 取台账快照前的排空预算（基础报告写入 + 台账排空 + 追加，总预算仍 ≤ 1s）。 */
const PLUGIN_OP_FLUSH_DEADLINE_MS = 300;

let electronApp = null;
try { electronApp = require('electron').app; } catch (_) { /* 单测环境 */ }

function crashDir() {
  // 测试/运维覆盖（与 diag-log 的 DSH_DIAG_BASE 同思路）：显式指定报告目录，
  // 避免单测把报告写进真实安装目录/仓库根。
  const override = process.env.DSH_CRASH_DIR;
  if (override) return override;
  // 与 diag-log 同目录策略：优先安装目录 logs，回退 userData logs。
  try { return path.join(electronApp.getAppPath(), 'logs'); } catch (_) {}
  try { return path.join(electronApp.getPath('userData'), 'logs'); } catch (_) {}
  return path.join(process.cwd(), 'logs');
}

/**
 * 2026-09-23T12-34-56-789Z-host.log（按时间排序，来源在尾）
 *
 * 0.3.44：`source` 此前是被**未校验地拼进文件名**的。目前唯一的调用点传的是
 * 字面量 'host'，所以没有活的漏洞；但 `source` 的文档类型是
 * `'host'|'renderer'|'main'`，将来接入 renderer 崩溃（其值可能来自渲染进程
 * 上报）时，一个含 `..` 或路径分隔符的值就能把报告写到 logs 目录之外 ——
 * 崩溃报告路径会进诊断日志，也可能被"复制路径"按钮暴露给用户。
 *
 * 按"永不信任会被拼进路径的字段"处理：只保留白名单字符，并兜底为 'unknown'。
 * 时间是 Date，由我们构造，保持不变但同样收敛字符集。
 */
function sanitizeToken(value, fallback) {
  const cleaned = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]/gu, '-')  // 去掉路径分隔符、冒号、通配符等
    .replace(/\.{2,}/gu, '-')            // 杜绝 ".." 穿越
    .replace(/^[.-]+/u, '')              // 不以 . 或 - 开头（隐藏文件/命令行参数歧义）
    .slice(0, 64);
  return cleaned || fallback;
}

function crashFileName(time, source) {
  const stamp = time.toISOString().replace(/[:.]/gu, '-');
  return `${CRASH_REPORT_PREFIX}${sanitizeToken(stamp, 'unknown-time')}-${sanitizeToken(source, 'unknown')}.log`;
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
 * 组装基础报告的段（**不含**插件操作段）。
 * 单独抽出来是为了让「基础报告字节从不重写」这条纪律可被测试直接验证：
 * `buildBaseReport()` 的输出必须与磁盘上基础部分的字节完全一致。
 */
function buildBaseSections(input) {
  const time = new Date();
  const header = [
    `===== DSH Desktop 崩溃报告 ${time.toISOString()} =====`,
    `source: ${input.source}   phase: ${input.phase}`,
    `backendReady: ${!!input.backendReady}`,
    `version: ${appVersion()}`,
    `platform: ${process.platform} ${process.arch}`,
    `electron: ${process.versions.electron}   node: ${process.versions.node}`,
    `pid: ${process.pid}`
  ].join('\n');
  return {
    time,
    sections: [
      header,
      '\n----- error -----',
      renderErrorSection(input.error),
      '\n----- backend log tail -----',
      boundedTail(input.backendLogTail || ''),
      '\n----- renderer console (error level, oldest first) -----',
      (input.rendererConsole || []).join('\n')
    ]
  };
}

/** 基础报告全文（写盘用的就是这份字节；插件操作段在其后**追加**）。 */
function buildBaseReport(input) {
  return buildBaseSections(input).sections.join('\n') + '\n';
}

/**
 * 0.3.49 · B-04：崩溃报告附加段 —— 最近 N 条插件操作。
 *
 * 为什么追加而不是并列进正文：基础报告是"错误现场"（不可变的证据），插件操作是
 * **上下文**（官方标题里就写着 context, not proof of cause）。分开写有三个好处：
 *   ① 基础报告字节可被独立校验（sha256 不变 = 证据没被改动）；
 *   ② 台账不可用时基础报告完全不受伤（best-effort）；
 *   ③ 读者一眼看出"这不是因果证明"。
 *
 * 台账取快照前先 `flush(300ms)` 把排队记录同步落盘（崩溃路径是同步的，必须能等），
 * 再把内存环渲染成可读行；即使磁盘已停用，内存环照样能给出上下文。
 */
function buildPluginOpsSection() {
  const lines = [`\n----- ${PLUGIN_OP_SECTION_TITLE} -----`];
  let journal = null;
  try {
    journal = require('./plugin-journal');
  } catch (err) {
    lines.push(`（插件台账不可用：${(err && err.message) || err}）`);
    lines.push('[collection failed]');
    return lines.join('\n') + '\n';
  }
  try {
    const flushed = journal.flush(PLUGIN_OP_FLUSH_DEADLINE_MS);
    const snap = journal.renderRecent(PLUGIN_OP_MAX);
    if (snap.lines.length === 0) {
      lines.push('（本次进程内没有插件操作记录）');
    } else {
      for (const line of snap.lines) lines.push(line);
      if (snap.omitted > 0) lines.push(`…（省略 ${snap.omitted} 条更早记录，完整台账见 ${journal.journalDir()}）`);
    }
    const deferred = flushed && flushed.deferred ? ` deferred=${flushed.deferred}` : '';
    const st = journal.status();
    // 收集完成标记：永远出现（0 条也标），否则读报告的人无法区分"没有操作"与"没收集到"
    lines.push(`[collection complete] records=${snap.total} dropped=${st.dropped}${deferred} ledger=${journal.journalDir()}`);
    // 磁盘停用/写失败要在报告里如实说明，不能让读者以为台账是全的
    if (st.disabled) lines.push(`[ledger degraded] 台账落盘已停用：${st.lastError || 'unknown'}（以上内容来自内存环形缓冲）`);
  } catch (err) {
    lines.push(`（插件台账快照失败：${(err && err.message) || err}）`);
    lines.push('[collection failed]');
  }
  return lines.join('\n') + '\n';
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
    const dir = crashDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const base = buildBaseSections(input);
    const file = path.join(dir, crashFileName(base.time, input.source));
    // 0.3.42 · flag:'wx'（对齐官方 crash-report.ts:151）：绝不覆盖已存在的报告。
    // 同一秒内两次崩溃、或时间戳碰撞时，宁可这次不写，也不毁掉前一份证据。
    try {
      fs.writeFileSync(file, base.sections.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
    } catch (writeErr) {
      // 0.3.42 · 写入失败不再静默吞掉（对齐官方 :153-156）：留一行诊断，
      // 否则"没有崩溃报告"与"崩溃报告写失败"对用户和排查者无法区分。
      try { console.error('crash report write failed:', writeErr && writeErr.message, file); } catch (_) {}
      return null;
    }
    // 0.3.49 · B-04：基础报告已落盘 → 再追加插件操作段（best-effort，绝不重写基础字节）
    try {
      fs.appendFileSync(file, buildPluginOpsSection(), 'utf8');
    } catch (appendErr) {
      try { console.error('crash report: plugin operations section failed:', appendErr && appendErr.message); } catch (_) {}
    }
    return file;
  } catch (err) {
    try { console.error('crash report failed:', err && err.message); } catch (_) {}
    return null;
  }
}

/**
 * 0.3.42 · 带上限的崩溃报告落盘（对齐官方 fatal-recovery.ts 的 CRASH_REPORT_WAIT_MS）。
 *
 * 旧调用方在弹窗**之前**同步调用 writeCrashReport()：磁盘慢、被占用或被杀软扫描时，
 * 主进程会卡在写入里，恢复弹窗被无限期推迟——用户看到的是"点了图标没反应"，
 * 而真正该出现的自救入口迟迟不来。官方对此设 1 秒上限：超时就用「没有报告路径」
 * 的文案照常弹窗（报告顶多晚到或缺失，弹窗绝不缺席）。
 *
 * 注意：写入本身是同步的，无法真正中断。这里把它挪到 setImmediate 之后并加竞速，
 * 保证**弹窗逻辑不再被写入阻塞**；写入若最终失败/丢失，由 writeCrashReport 内部
 * 的日志兜底。返回 Promise<string|null>。
 */
function writeCrashReportBounded(input, waitMs = CRASH_REPORT_WAIT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    if (timer.unref) timer.unref();
  });
  const write = new Promise((resolve) => {
    setImmediate(() => {
      let result = null;
      try { result = writeCrashReport(input); } catch (_) { result = null; }
      resolve(result);
    });
  });
  return Promise.race([write, timeout]).finally(() => { if (timer) clearTimeout(timer); });
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
  writeCrashReportBounded,
  pruneCrashReports,
  crashDialogDetail,
  crashDir,
  CRASH_REPORTS_RETAINED,
  CRASH_REPORT_WAIT_MS,
  DETAIL_BUDGET,
  // 0.3.49 · B-04：插件操作段（契约字符串 + 条数上限，测试与文档共用）
  PLUGIN_OP_SECTION_TITLE,
  PLUGIN_OP_MAX,
  // 测试钩子
  _internal: {
    renderErrorSection,
    boundedTail,
    crashFileName,
    CRASH_REPORT_NAME,
    DETAIL_TAIL_LINES,
    buildBaseSections,
    buildBaseReport,
    buildPluginOpsSection
  }
};
