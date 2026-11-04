'use strict';

/**
 * B-04 验收：插件操作台账（环形 / 截断 / 背压计数 / 写失败降级 / recent 边界 / 崩溃报告拼装）。
 *
 * 为什么存在：插件故障三次卡在「归因不到具体条目」。台账的价值全在**出事那一刻**
 * 是否仍然可信 —— 所以这里逐条钉死那些只在故障态才暴露的性质：
 *   ① 环形滚动不丢「仍然装得下」的记录（2 段、总字节有界、序号连续无洞）；
 *   ② 单条超 4 KiB 被截断且带 `truncated:true`（声明"我不完整"，而不是假装完整）；
 *   ③ 排队触顶丢弃**必须计数**，且计数写进台账正文 + 诊断日志正文（禁止静默丢弃）；
 *   ④ 写失败 → 本次生命周期停用落盘，但内存环仍可供崩溃报告使用（降级可见）；
 *   ⑤ `recent(n)` 边界（0/负数/超量/缺省）；
 *   ⑥ 崩溃报告：基础报告字节**不被重写**、附加段标题逐字含
 *      `context, not proof of cause`、含省略计数与收集完成标记。
 *
 * 用法：node scripts/test-b04-plugin-journal.js
 * 超时：默认 120s（DSH_TEST_TIMEOUT_MS 可调）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = parseInt(process.env.DSH_TEST_TIMEOUT_MS || '120000', 10) || 120000;
const watchdog = setTimeout(() => {
  process.stderr.write(`[test-b04] 超时 ${TIMEOUT_MS}ms，强制退出\n`);
  process.exit(3);
}, TIMEOUT_MS);

process.setMaxListeners(0);

const ROOT = path.join(__dirname, '..');
const JOURNAL_PATH = path.join(ROOT, 'plugin-journal.js');
const CRASH_PATH = path.join(ROOT, 'crash-report.js');
const BASE = path.join(os.tmpdir(), `dsh-b04-${process.pid}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const show = detail && (!ok || detail.startsWith('实际'));
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${show ? ' — ' + detail : ''}\n`);
}

const ENV_KEYS = [
  'DSH_DIAG_BASE', 'DSH_PLUGIN_JOURNAL_DIR', 'DSH_PLUGIN_JOURNAL_SEGMENT_BYTES',
  'DSH_PLUGIN_JOURNAL_RECORD_BYTES', 'DSH_PLUGIN_JOURNAL_QUEUE_BYTES',
  'DSH_PLUGIN_JOURNAL_RECENT_LIMIT', 'DSH_PLUGIN_JOURNAL_RECENT_BYTES',
  'DSH_PLUGIN_JOURNAL_FLUSH_MS', 'DSH_PLUGIN_JOURNAL_EXIT_MS',
  'DSH_PLUGIN_JOURNAL_CRASH_MS', 'DSH_PLUGIN_JOURNAL_CHUNK_BYTES'
];

/** 清环境 + 清缓存，返回一套干净的模块实例（每个阶段都是"新的一次进程"）。 */
function freshModules(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  for (const p of [JOURNAL_PATH, CRASH_PATH]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) { /* 尚未加载 */ }
  }
  return {
    journal: require(JOURNAL_PATH),
    crash: require(CRASH_PATH)
  };
}

/** 读两段文件里的全部记录（旧段 → 新段，时间顺序）。 */
function readAllRecords(journal) {
  const out = [];
  for (const file of journal.segmentPaths()) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); } catch (err) { out.push({ parseError: String(err), raw: trimmed.slice(0, 120) }); }
    }
  }
  return out;
}

function dirOf(journal) { return journal.journalDir(); }
function segmentFiles(journal) {
  return fs.readdirSync(dirOf(journal)).filter((f) => /^plugin-operations-\d+\.log$/.test(f)).sort();
}
function totalBytes(files) {
  return files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
}

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
const stdoutWrite = process.stdout.write.bind(process.stdout);

// ═══════════════════════════════════════════════════════════════════════════
// ① 环形滚动：2 段、有界、序号连续（装得下的记录一条不丢）
// ═══════════════════════════════════════════════════════════════════════════
const SEG = 4096;
const CHUNK = 512;
const p1 = path.join(BASE, 'ring');
{
  const { journal } = freshModules({
    DSH_DIAG_BASE: p1,
    DSH_PLUGIN_JOURNAL_SEGMENT_BYTES: String(SEG),
    DSH_PLUGIN_JOURNAL_CHUNK_BYTES: String(CHUNK),
    DSH_PLUGIN_JOURNAL_QUEUE_BYTES: String(64 * 1024),
    DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000'
  });
  const N = 120;
  process.stdout.write = () => true;
  try {
    for (let i = 0; i < N; i += 1) {
      journal.record({ action: 'install', plugin: 'plug-' + i, version: '1.0.' + i, source: 'registry', result: 'ok', phase: 'running' });
    }
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const queued = journal.status().queued;
  const flushed = journal.flush(5000);
  const records = readAllRecords(journal);
  const files = segmentFiles(journal);
  const bytes = totalBytes(files.map((f) => path.join(dirOf(journal), f)));
  const seqs = records.filter((r) => !r.parseError && r.action !== 'journal-drop').map((r) => r.seq);

  check('① 入队 120 条（行级零 fs：队列里确实攒住了）', queued === N, '实际 queued=' + queued);
  check('① flush 报告排空条数与入队一致', flushed.flushed === N && flushed.deferred === 0,
    '实际：' + JSON.stringify({ flushed: flushed.flushed, deferred: flushed.deferred }));
  check('① 磁盘上仍然只有 2 段（环形，不无限增段）', files.length === 2, '实际：' + JSON.stringify(files));
  check('① 总字节 ≤ 2×段预算 + 一个块余量', bytes <= SEG * 2 + CHUNK * 2, `实际 ${bytes} ≤ ${SEG * 2 + CHUNK * 2}`);
  check('① 无解析错误（每行都是完整 JSON）', records.every((r) => !r.parseError),
    '实际：' + JSON.stringify(records.filter((r) => r.parseError).slice(0, 2)));
  // 序号连续：留下来的必须是"最近的一整段尾巴"，中间不能有洞
  const contiguous = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  check('① 保留记录序号连续无洞（装得下的一条不丢）', contiguous && seqs.length > 0,
    `实际：${seqs.length} 条，首=${seqs[0]} 末=${seqs[seqs.length - 1]}，连续=${contiguous}`);
  check('① 最后一条就是最后写入的那条', seqs[seqs.length - 1] === N,
    '实际最后 seq=' + seqs[seqs.length - 1]);
  check('① 记录字段齐全（墙钟+单调+动作+名+版本+来源+结果+阶段）', records.every((r) => r.action === 'journal-drop'
    || (typeof r.wall === 'string' && typeof r.monoMs === 'number' && r.action === 'install'
      && typeof r.plugin === 'string' && typeof r.version === 'string'
      && typeof r.source === 'string' && typeof r.result === 'string' && typeof r.phase === 'string')),
  '实际样例：' + JSON.stringify(records[records.length - 1]));
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 单条超长：截断 + truncated 标记 + 单行 ≤ 4 KiB
// ═══════════════════════════════════════════════════════════════════════════
const p2 = path.join(BASE, 'truncate');
{
  const { journal } = freshModules({
    DSH_DIAG_BASE: p2,
    DSH_PLUGIN_JOURNAL_SEGMENT_BYTES: String(256 * 1024),
    DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000'
  });
  const huge = 'x'.repeat(20000);
  process.stdout.write = () => true;
  try {
    journal.record({ action: 'isolate', plugin: huge, version: '9.9.9', source: 'profile', result: { status: 'fail', code: 'EISOLATED' }, phase: 'startup' });
    journal.record({ action: 'install', plugin: 'normal-plugin', version: '1.0.0', source: 'registry', result: 'ok', phase: 'running' });
  } finally {
    process.stdout.write = stdoutWrite;
  }
  journal.flush(5000);
  const raw = fs.readFileSync(path.join(dirOf(journal), 'plugin-operations-1.log'), 'utf8').split('\n').filter((l) => l.trim());
  const big = JSON.parse(raw[0]);
  check('② 超长记录被截断并标 truncated:true', big.truncated === true, '实际 truncated=' + big.truncated);
  check('② 记录了截断前字节数 originalBytes > 4096', big.originalBytes > 4096, '实际 originalBytes=' + big.originalBytes);
  check('② 单条（不含换行）≤ 4096 字节', Buffer.byteLength(raw[0], 'utf8') <= 4096, '实际=' + Buffer.byteLength(raw[0], 'utf8'));
  check('② 截断后仍保留归因要点（动作/结果/原因码/阶段）',
    big.action === 'isolate' && big.result === 'fail' && big.phase === 'startup' && /EISOLATED/.test(JSON.stringify(big)),
    '实际：' + JSON.stringify(Object.keys(big)));
  check('② 正常记录不被误标 truncated', JSON.parse(raw[1]).truncated === undefined, '实际：' + raw[1].slice(0, 120));
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 排队触顶：丢弃计数进台账正文 + 诊断日志正文（禁止静默丢弃）
// ═══════════════════════════════════════════════════════════════════════════
const p3 = path.join(BASE, 'overflow');
{
  const { journal } = freshModules({
    DSH_DIAG_BASE: p3,
    DSH_PLUGIN_JOURNAL_QUEUE_BYTES: '1024',
    DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000'
  });
  const diag = require(path.join(ROOT, 'diag-log.js'));
  let rejected = 0;
  process.stdout.write = () => true;
  try {
    for (let i = 0; i < 60; i += 1) {
      if (!journal.record({ action: 'enable', plugin: 'flood-' + i, version: '1.0.0', source: 'profile', result: 'ok', phase: 'running' })) rejected += 1;
    }
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const st = journal.status();
  check('③ 触顶后 record() 返回 false 且计数一致', st.dropped === rejected && rejected > 0,
    `实际 dropped=${st.dropped} rejected=${rejected}`);
  journal.flush(5000);
  diag.flushSync(5000);
  const records = readAllRecords(journal);
  const notice = records.find((r) => r.action === 'journal-drop');
  check('③ 台账正文有丢弃说明记录（含精确条数）', !!notice && notice.dropped === rejected,
    '实际：' + JSON.stringify(notice));
  check('③ 丢弃说明也写进了诊断日志正文（主日志可搜到）',
    fs.readFileSync(diag.logFile(), 'utf8').includes('插件台账：排队触顶丢弃'),
    '实际主日志片段：' + (fs.readFileSync(diag.logFile(), 'utf8').split('\n').filter((l) => l.includes('插件台账')).join(' | ') || '(无)'));
  check('③ 状态里 droppedWritten 已追上 dropped（不重复写说明）', journal.status().droppedWritten === rejected,
    '实际：' + JSON.stringify({ dropped: journal.status().dropped, droppedWritten: journal.status().droppedWritten }));
  check('③ 内存环仍保留被丢弃的记录（崩溃报告可用）',
    journal.recent(200).some((r) => r.persisted === false), '实际：未被丢弃标记的条数=' + journal.recent(200).filter((r) => r.persisted === false).length);
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 写失败降级：停用落盘 + 计数曝光 + 不再重试；内存环照常可用
// ═══════════════════════════════════════════════════════════════════════════
const p4 = path.join(BASE, 'fail');
{
  const blocked = path.join(p4, 'blocked-as-file');
  fs.mkdirSync(p4, { recursive: true });
  fs.writeFileSync(blocked, 'not a directory\n', 'utf8');
  const { journal } = freshModules({
    DSH_DIAG_BASE: p4,
    DSH_PLUGIN_JOURNAL_DIR: blocked,          // 目录位置上放了一个文件 → mkdir 必失败
    DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000'
  });
  process.stdout.write = () => true;
  try {
    journal.record({ action: 'disable', plugin: 'p-fail', version: '1.0.0', source: 'profile', result: { status: 'fail', code: 'EPERM' }, phase: 'startup' });
    var firstFlush = journal.flush(1000);
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const st = journal.status();
  check('④ 写失败后 status().disabled = true', st.disabled === true, '实际：' + JSON.stringify({ disabled: st.disabled, failed: st.failed, lastError: st.lastError }));
  check('④ 失败计数与错误信息都曝光（不静默）', st.failed >= 1 && !!st.lastError, '实际：' + JSON.stringify({ failed: st.failed, lastError: st.lastError }));

  // 计数断言：停用后不得再尝试任何写
  const rawAppend = fs.appendFileSync;
  let attempts = 0;
  fs.appendFileSync = function counted(...args) { attempts += 1; return rawAppend.apply(fs, args); };
  try {
    journal.flush(1000);
    journal.flush(1000);
  } finally {
    fs.appendFileSync = rawAppend;
  }
  check('④ 停用后不再尝试写入（调用计数 = 0）', attempts === 0, '实际 attempts=' + attempts);
  check('④ 停用后仍然能给出内存环快照（崩溃报告用它）', journal.recent(10).length >= 1,
    '实际 recent=' + journal.recent(10).length);
  check('④ 停用后 flush 返回 disabled 且不假装成功', journal.flush(100).disabled === true && journal.flush(100).flushed === 0,
    '实际：' + JSON.stringify(journal.flush(100)));
  check('④ 首次 flush 也未抛出（本模块对外永不抛错）', !!firstFlush && firstFlush.disabled === true,
    '实际：' + JSON.stringify(firstFlush));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ recent(n) 边界
// ═══════════════════════════════════════════════════════════════════════════
const p5 = path.join(BASE, 'recent');
{
  const { journal } = freshModules({ DSH_DIAG_BASE: p5, DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000' });
  process.stdout.write = () => true;
  try {
    for (let i = 0; i < 30; i += 1) {
      journal.record({ action: 'enable', plugin: 'r-' + i, source: 'profile', result: 'ok', phase: 'running' });
    }
  } finally {
    process.stdout.write = stdoutWrite;
  }
  check('⑤ recent(0) = []', Array.isArray(journal.recent(0)) && journal.recent(0).length === 0, '实际：' + JSON.stringify(journal.recent(0)));
  check('⑤ recent(-5) = []', journal.recent(-5).length === 0, '实际：' + journal.recent(-5).length);
  check('⑤ recent() 缺省 20 条', journal.recent().length === 20, '实际：' + journal.recent().length);
  check('⑤ recent(5) 返回最新 5 条且按时间升序', journal.recent(5).map((r) => r.plugin).join(',') === 'r-25,r-26,r-27,r-28,r-29',
    '实际：' + journal.recent(5).map((r) => r.plugin).join(','));
  check('⑤ recent(1e6) 返回全部（30 条）', journal.recent(1e6).length === 30, '实际：' + journal.recent(1e6).length);
  const snap = journal.renderRecent(10);
  check('⑤ renderRecent(10) 给出省略计数（30-10=20）', snap.omitted === 20 && snap.lines.length === 10,
    '实际：' + JSON.stringify({ omitted: snap.omitted, lines: snap.lines.length }));
  check('⑤ 渲染行包含动作/插件/结果/阶段', /enable r-29 source=profile ok phase=running/.test(snap.lines[9]),
    '实际末行：' + snap.lines[9]);
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 崩溃报告拼装：基础字节不重写 + 标题含 context, not proof of cause + 省略计数 + 完成标记
// ═══════════════════════════════════════════════════════════════════════════
const p6 = path.join(BASE, 'crash');
{
  const cwdBackup = process.cwd();
  fs.mkdirSync(p6, { recursive: true });
  process.chdir(p6);   // crashDir() 在单测环境退化为 <cwd>/logs
  const { journal, crash } = freshModules({ DSH_DIAG_BASE: p6, DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000' });
  process.stdout.write = () => true;
  try {
    // 超过 PLUGIN_OP_MAX（40）条，用来断言"省略计数"
    for (let i = 0; i < 55; i += 1) {
      journal.record({
        action: i % 7 === 0 ? 'isolate' : 'install',
        plugin: 'crashplug-' + i,
        version: '2.0.' + i,
        source: 'registry',
        result: i % 7 === 0 ? { status: 'fail', code: 'EISOLATE' } : 'ok',
        phase: 'startup',
        token: 'should-never-be-persisted',          // 非白名单字段：必须被丢弃
        reason: 'token=abc123supersecret'            // 凭据样式：必须脱敏
      });
    }
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const input = {
    source: 'main',
    phase: 'startup',
    error: new Error('boom from test'),
    backendReady: false,
    backendLogTail: 'tail line',
    rendererConsole: ['renderer error sample']
  };
  const expectedBase = crash._internal.buildBaseReport(input);
  const file = crash.writeCrashReport(input);
  const content = file ? fs.readFileSync(file, 'utf8') : '';
  process.chdir(cwdBackup);

  check('⑥ 崩溃报告已落盘', !!file && fs.existsSync(file), '实际：' + file);
  check('⑥ 附加段标题逐字含 context, not proof of cause',
    content.includes(crash.PLUGIN_OP_SECTION_TITLE) && crash.PLUGIN_OP_SECTION_TITLE === 'recent plugin operations (context, not proof of cause)',
    '实际标题行：' + (content.split('\n').find((l) => l.includes('recent plugin operations')) || '(无)'));
  // 基础报告头部带 new Date()，两次构造的时间戳必然不同 —— 比对时归一掉时间戳，
  // 其余字节必须逐字一致（即"只追加、没重写"，官方 operation-report.ts 的纪律）。
  const marker = '\n----- ' + crash.PLUGIN_OP_SECTION_TITLE + ' -----';
  const cut = content.indexOf(marker);
  const prefix = cut >= 0 ? content.slice(0, cut) : content;
  const normTs = (text) => text.replace(/崩溃报告 \d{4}-\d{2}-\d{2}T[\d:.\-]+Z/u, '崩溃报告 <TS>');
  check('⑥ 基础报告字节未被重写（除时间戳外与原文逐字节一致，附加段只追加）',
    normTs(prefix) === normTs(expectedBase),
    '实际：基础=' + Buffer.byteLength(expectedBase, 'utf8') + 'B 前缀=' + Buffer.byteLength(prefix, 'utf8') + 'B 完全一致=' + (prefix === expectedBase) + ' 归一后一致=' + (normTs(prefix) === normTs(expectedBase)));
  check('⑥ 附加段含我们的插件操作行', content.includes('crashplug-54'), '实际：' + (content.split('\n').find((l) => l.includes('crashplug')) || '(无)'));
  check('⑥ 超过 40 条时有省略计数', /省略 \d+ 条更早记录/.test(content),
    '实际：' + ((content.match(/省略 \d+ 条更早记录/) || ['(无)'])[0]));
  check('⑥ 有收集完成标记（含 records/dropped/ledger）', /\[collection complete\] records=\d+ dropped=\d+/.test(content),
    '实际：' + ((content.match(/\[collection complete\][^\n]*/) || ['(无)'])[0]));
  const sha256 = (text) => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  check('⑥ 基础报告字节未被重写（时间戳归一后 sha256 完全一致 = 逐字节只追加）',
    sha256(normTs(prefix)) === sha256(normTs(expectedBase)),
    '实际：前缀 sha256=' + sha256(normTs(prefix)) + ' 期望=' + sha256(normTs(expectedBase)));
  check('⑥ 非白名单字段未被持久化（token 值不出现）', !content.includes('should-never-be-persisted'),
    '实际：' + (content.includes('should-never-be-persisted') ? '泄漏了' : '已丢弃'));
  const credKeys = (content.match(/"(token|password|passwd|secret|authorization|api[_-]?key)"/giu) || []);
  check('⑥ 附加段不含凭据类键名（token/password/secret/authorization）', credKeys.length === 0,
    '实际命中：' + JSON.stringify(credKeys));
  check('⑥ 凭据样式已脱敏（abc123supersecret 不出现）', !content.includes('abc123supersecret'),
    '实际：' + (content.includes('abc123supersecret') ? '泄漏了' : '已脱敏'));
  check('⑥ 失败记录原因码在报告里可见（结果可归因）', content.includes('EISOLATE'), '实际：' + (content.includes('EISOLATE') ? '有' : '无'));
  check('⑥ 凭据被打码的记录带 redacted 标记（读者能看出内容被改写）', /"redacted":true/.test(fs.readFileSync(journal.segmentPath(1), 'utf8')),
    '实际台账里 redacted 标记数=' + (fs.readFileSync(journal.segmentPath(1), 'utf8').match(/"redacted":true/g) || []).length);
  check('⑥ 基础报告里仍保留错误与尾部（附加段没有挤掉原有内容）',
    content.includes('----- error -----') && content.includes('tail line') && content.includes('renderer error sample'),
    '实际：' + JSON.stringify({ error: content.includes('----- error -----'), tail: content.includes('tail line') }));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ 退出钩子覆盖（不假设钩子一定跑：显式 flush 也能排空）
// ═══════════════════════════════════════════════════════════════════════════
const p7 = path.join(BASE, 'exit');
{
  const { journal } = freshModules({ DSH_DIAG_BASE: p7, DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000' });
  process.stdout.write = () => true;
  try {
    journal.record({ action: 'uninstall', plugin: 'exit-plug', version: '3.0.0', source: 'registry', result: 'ok', phase: 'shutdown' });
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const flushed = journal.flush(journal.EXIT_FLUSH_DEADLINE_MS);
  check('⑦ 退出预算内可同步排空（≤500ms 预算可被崩溃/退出路径等待）',
    flushed.flushed === 1 && flushed.ms <= 500, '实际：' + JSON.stringify({ flushed: flushed.flushed, ms: flushed.ms }));
  check('⑦ 排空后磁盘上确实有这条记录', readAllRecords(journal).some((r) => r.plugin === 'exit-plug'),
    '实际条数=' + readAllRecords(journal).length);
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑧ 可量化验收①：写满 3 倍真实容量后，磁盘仍只有 2 段、总字节 ≤ 512KiB + 单段余量
// ═══════════════════════════════════════════════════════════════════════════
const p8 = path.join(BASE, 'three-x');
{
  // 用**真实默认尺寸**（256KiB/段、512KiB 总预算、16KiB 块），不缩放
  const { journal } = freshModules({
    DSH_DIAG_BASE: p8,
    DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000'
  });
  const N = 9000;   // 每条 ~200B → ≈1.8MB，超过 512KiB 总预算 3 倍
  process.stdout.write = () => true;
  try {
    // 现实形态：操作随时间到来，攒够一批就落盘（队列上限 64KiB 是**内存**边界，
    // 一次同步猛灌 1.8MB 必然触发背压丢弃 —— 那是 ③ 的语义，不是 ⑧ 要证明的东西）。
    for (let i = 0; i < N; i += 1) {
      journal.record({ action: 'enable', plugin: 'bulk-' + i, version: '1.0.' + i, source: 'profile', result: 'ok', phase: 'running' });
      if (i % 200 === 0) journal.flush(5000);
    }
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const queuedAtStart = journal.status().queued;
  const stMid = journal.status();
  const fl = journal.flush(30000);
  const stEnd = journal.status();
  const files = segmentFiles(journal);
  const bytes = totalBytes(files.map((f) => path.join(dirOf(journal), f)));
  const records = readAllRecords(journal);
  const seqs = records.filter((r) => !r.parseError && r.action !== 'journal-drop').map((r) => r.seq);
  const budget = 512 * 1024 + 16 * 1024 * 2;
  check('⑧ 边写边刷：9000 条全部记入（已落盘 + 排队 = 9000，零丢弃）',
    stMid.written + stMid.queued === N && stMid.dropped === 0,
    '实际：' + JSON.stringify({ written: stMid.written, queued: stMid.queued, dropped: stMid.dropped }));
  check('⑧ 磁盘仍只有 2 段文件', files.length === 2, '实际：' + JSON.stringify(files));
  check('⑧ 总字节 ≤ 512KiB + 一个块余量', bytes <= budget, '实际 ' + bytes + ' ≤ ' + budget);
  check('⑧ 排空后无积压、无丢弃、落盘总数 = 9000', fl.deferred === 0 && stEnd.dropped === 0 && stEnd.queued === 0 && stEnd.written === N,
    '实际：' + JSON.stringify({ flushed: fl.flushed, deferred: fl.deferred, dropped: stEnd.dropped, queued: stEnd.queued, written: stEnd.written }));
  check('⑧ 保留的是最近一段且有界（序号连续、末条是最新）',
    seqs.length > 0 && seqs[seqs.length - 1] === N && seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1),
    '实际保留 ' + seqs.length + ' 条，首=' + seqs[0] + ' 末=' + seqs[seqs.length - 1]);
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑨ 可量化验收③：慢磁盘下退出排空不超预算（预算是「不发起新块」，不切断进行中的写）
// ═══════════════════════════════════════════════════════════════════════════
const p9 = path.join(BASE, 'slow-disk');
{
  const { journal } = freshModules({
    DSH_DIAG_BASE: p9,
    DSH_PLUGIN_JOURNAL_FLUSH_MS: '60000',
    DSH_PLUGIN_JOURNAL_CHUNK_BYTES: '1024'
  });
  process.stdout.write = () => true;
  try {
    for (let i = 0; i < 200; i += 1) {
      journal.record({ action: 'disable', plugin: 'slow-' + i, version: '1.0.0', source: 'profile', result: 'ok', phase: 'startup' });
    }
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const rawAppend = fs.appendFileSync;
  const busyWait = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* 模拟慢磁盘的同步阻塞 */ } };
  fs.appendFileSync = function slow(...args) { busyWait(30); return rawAppend.apply(fs, args); };
  let out;
  try {
    out = journal.flush(journal.EXIT_FLUSH_DEADLINE_MS);   // 500ms 预算
  } finally {
    fs.appendFileSync = rawAppend;
  }
  check('⑨ 慢磁盘（每次 append 阻塞 30ms）下 500ms 预算不被拖爆',
    out.ms <= journal.EXIT_FLUSH_DEADLINE_MS + 60, '实际：' + JSON.stringify({ ms: out.ms, flushed: out.flushed, deferred: out.deferred }));
  check('⑨ 未排完的记录留在队列（不丢）+ 可继续排空', out.deferred === out.remaining,
    '实际：' + JSON.stringify({ deferred: out.deferred, remaining: out.remaining }));
  const rest = journal.flush(30000);
  check('⑨ 继承预算后最终全部落盘（两次调用合计 = 200 条）', out.flushed + rest.flushed === 200 && journal.status().queued === 0,
    '实际：' + JSON.stringify({ first: out.flushed, second: rest.flushed, queued: journal.status().queued }));
}

clearTimeout(watchdog);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n[test-b04] 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
process.stdout.write('[test-b04] 临时目录：' + BASE + '\n');
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAIL ${f.name} — ${f.detail}\n`);
  process.exit(1);
}
process.stdout.write('[test-b04] 全部通过\n');
process.exit(0);
