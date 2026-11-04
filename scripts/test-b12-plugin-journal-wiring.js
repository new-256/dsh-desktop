'use strict';

/**
 * 0.3.49 · plugin-journal 接线端到端断言（task-10 收尾项）。
 *
 * ## 为什么这样测
 *
 * 台账模块本身已由 task-12 测到 54/54，但"**main.js 是否真的在业务点调了 record()**"
 * 只能靠驱动真实 main.js 来证明。这里用 `scripts/lib/stage1-main-harness.js` 把
 * main.js 编译进桩环境（electron / child_process / updater-backend 换桩，其余全真），
 * 然后**直接调用真实 IPC 处理器**与真实接线函数，断言：
 *
 *   · 安装成功/失败（含 ETIMEDOUT）各产生一条 install 记录
 *   · 迁移导入逐条记录，跳过的是 ok + ESKIP（source=legacy）
 *   · 隔离放弃 → isolate + result=fail + EQUARANTINE；成功 → isolate + ok
 *   · 记录真的落盘（flush 后段文件里有这些行）
 *   · **崩溃报告能带出台账片段**（crash-report 已内置 plugin-journal 渲染）
 *
 * 用法：node scripts/test-b12-plugin-journal-wiring.js [--timeout 120]
 */

const fs = require('fs');
const path = require('path');
const h = require('./lib/stage1-main-harness');

const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 120;
const t = h.createAsserts();
const BASE = h.makeBase('b12');
process.env.DSH_DIAG_BASE = BASE;
process.env.DSH_PLUGIN_JOURNAL_DIR = path.join(BASE, 'plugin-ops');
process.chdir(BASE);

const LOG_FILE = path.join(BASE, 'logs', 'DSH-Desktop-日志.txt');
const killer = setTimeout(() => {
  console.error(`\n[超时] 测试超过 ${TIMEOUT_SEC}s 未结束，强制退出（防卡死）。`);
  h.printLogHead(LOG_FILE, 20);
  process.exit(124);
}, TIMEOUT_SEC * 1000);

const journal = require('../plugin-journal');
const crashReport = require('../crash-report');

/**
 * @param {{installResult?: object, installThrows?: boolean, importSummary?: object}} cfg
 */
function boot(cfg) {
  const o = cfg || {};
  const probe = h.createElectronStub({ userData: BASE, balloonShow: false, notificationSupported: false });
  const backend = h.createUpdaterBackendStub({ root: path.join(BASE, 'backend') });
  backend.installPluginViaCli = async () => {
    if (o.installThrows) throw new Error('pnpm 不可用（测试注入）');
    return o.installResult || { ok: true, code: 'OK', log: '' };
  };
  backend.importLegacyPlugins = async () => o.importSummary || { total: 0, ok: 0, failed: 0, skipped: 0, results: [] };
  backend.exportLegacyImportReport = () => null;
  backend.scanLegacyHome = () => ({ home: 'C:/x', exists: true, orphans: 0, total: 0 });
  const mod = h.loadMain({
    base: BASE,
    electronStub: probe.electron,
    childProcessStub: h.createChildProcessStub({}).module,
    backendStub: backend,
    packageJsonStub: { name: 'dsh-desktop', version: '0.3.49' },
    exports: ['recordQuarantineJournal', 'recordPluginJournal', 'pluginNameFromSpec', 'pluginSourceFromSpec', 'createSettingsWindow']
  });
  // 以设置窗身份发起 IPC（plugins:install / import-legacy 都属设置窗专属通道）。
  mod.createSettingsWindow();
  const settingsWindow = probe.state.windows[probe.state.windows.length - 1];
  const settingsEvent = {
    sender: { id: settingsWindow.webContents.id },
    senderFrame: { url: 'file:///' + path.join(h.ROOT, 'settings.html').replace(/\\/g, '/') }
  };
  return { mod, es: probe.state, handlers: probe.ipcHandlers, backend, settingsEvent };
}

/** 等台账定时落盘（模块内部 1s 周期）。 */
const waitFlush = (ms) => new Promise((r) => setTimeout(r, ms == null ? 1300 : ms));

(async () => {
  console.log('0.3.49 · plugin-journal 接线端到端（真实 main.js 处理器 + 真实台账模块）');
  console.log('沙箱：' + BASE);
  console.log('台账目录：' + (typeof journal.journalDir === 'function' ? journal.journalDir() : '(无)'));

  // ── ① spec 解析：不把原文（可能含本地路径）写进台账 ────────────────────────
  t.section('① spec → 台账字段（不泄漏本地路径）');
  {
    const { mod } = boot({});
    t.ok(mod.pluginNameFromSpec('dsh-plugin-foo@1.2.3') === 'dsh-plugin-foo', '带版本号的 registry spec → 只留包名', mod.pluginNameFromSpec('dsh-plugin-foo@1.2.3'));
    t.ok(mod.pluginNameFromSpec('C:\\\\Users\\\\alice\\\\my-plugin') === 'my-plugin', '本地绝对路径 → 只留目录名（不写用户名/路径）', mod.pluginNameFromSpec('C:\\\\Users\\\\alice\\\\my-plugin'));
    t.ok(mod.pluginSourceFromSpec('dsh-plugin-foo@1.2.3') === 'registry', 'registry spec → source=registry', mod.pluginSourceFromSpec('dsh-plugin-foo@1.2.3'));
    t.ok(mod.pluginSourceFromSpec('./local-plugin') === 'local', '相对路径 → source=local', mod.pluginSourceFromSpec('./local-plugin'));
  }

  // ── ② 安装成功 / 失败 / 超时 各一条 install ─────────────────────────────────
  t.section('② plugins:install → install 记录');
  {
    const okRun = boot({ installResult: { ok: true, code: 'OK', log: '' } });
    const r1 = await okRun.handlers.get('plugins:install')(okRun.settingsEvent, { spec: 'dsh-plugin-ok@2.0.0', profile: 'web' });
    t.ok(r1 && r1.ok === true, '安装处理器返回成功', r1);
    let entries = journal.recent(50);
    const okEntry = entries.find((e) => e.plugin === 'dsh-plugin-ok');
    t.ok(!!okEntry, '成功安装写进台账（plugin=包名）', entries.slice(-3));
    t.ok(okEntry && okEntry.action === 'install' && okEntry.result === 'ok' && okEntry.source === 'registry',
      '台账字段：action=install / result=ok / source=registry', okEntry);

    const failRun = boot({ installResult: { ok: false, code: 'EBADSPEC', log: '', timedOut: false } });
    const r2 = await failRun.handlers.get('plugins:install')(failRun.settingsEvent, { spec: 'dsh-plugin-bad', profile: 'web' });
    t.ok(r2 && r2.ok === false, '失败安装如实返回 ok=false', r2);
    entries = journal.recent(50);
    const badEntry = entries.find((e) => e.plugin === 'dsh-plugin-bad');
    t.ok(!!badEntry && badEntry.result === 'fail', '失败安装写进台账且 result=fail', badEntry);
    t.ok(badEntry && badEntry.reason === 'EINSTALL', 'reason=EINSTALL（非超时）', badEntry && badEntry.reason);

    const timeoutRun = boot({ installResult: { ok: false, code: 'ETIMEDOUT', log: '', timedOut: true } });
    await timeoutRun.handlers.get('plugins:install')(timeoutRun.settingsEvent, { spec: 'dsh-plugin-slow', profile: 'web' });
    const slowEntry = journal.recent(80).find((e) => e.plugin === 'dsh-plugin-slow');
    t.ok(slowEntry && slowEntry.reason === 'ETIMEDOUT', '超时安装的 reason=ETIMEDOUT（与普通失败区分）', slowEntry && slowEntry.reason);
  }

  // ── ③ 迁移导入逐条记录（跳过也记，ok + ESKIP）──────────────────────────────
  t.section('③ plugins:import-legacy → 逐条 install（source=legacy）');
  {
    const run = boot({
      importSummary: {
        total: 3, ok: 1, failed: 1, skipped: 1,
        results: [
          { name: 'legacy-ok', ok: true, status: 'ok' },
          { name: 'legacy-bad', ok: false, status: 'failed', code: 'EINSTALL' },
          { name: 'legacy-skip', skipped: true, status: 'skipped' }
        ]
      }
    });
    await run.handlers.get('plugins:import-legacy')(run.settingsEvent, { items: [{ name: 'a' }], profile: 'web' });
    const entries = journal.recent(100).filter((e) => e.source === 'legacy');
    const names = entries.map((e) => `${e.plugin}:${e.result}:${e.reason}`);
    t.ok(entries.length === 3, '三条导入结果各一条台账（成功/失败/跳过都在）', names);
    t.ok(entries.some((e) => e.plugin === 'legacy-ok' && e.result === 'ok'), '成功项 result=ok', names);
    t.ok(entries.some((e) => e.plugin === 'legacy-bad' && e.result === 'fail'), '失败项 result=fail', names);
    t.ok(entries.some((e) => e.plugin === 'legacy-skip' && e.result === 'ok' && e.reason === 'ESKIP'),
      '跳过项记 ok + ESKIP（"它去哪了"可查）', names);
  }

  // ── ④ 隔离动作：成功 / 放弃 ────────────────────────────────────────────────
  t.section('④ 隔离动作 → isolate 记录');
  {
    const { mod } = boot({});
    mod.recordQuarantineJournal({ quarantined: true, fallback: false, abandoned: false });
    const okIso = journal.recent(200).filter((e) => e.action === 'isolate' && e.result === 'ok').pop();
    t.ok(!!okIso && okIso.plugin === '(profiles)', '隔离成功 → isolate/ok，plugin=(profiles)', okIso);

    mod.recordQuarantineJournal({ quarantined: false, abandoned: true, reason: '复制隔离失败' });
    const failIso = journal.recent(200).filter((e) => e.action === 'isolate' && e.result === 'fail').pop();
    t.ok(!!failIso && failIso.reason === 'EQUARANTINE', '隔离放弃 → isolate/fail + EQUARANTINE', failIso);

    mod.recordQuarantineJournal({ quarantined: false, abandoned: false });
    const guardIso = journal.recent(200).filter((e) => e.action === 'isolate').pop();
    t.ok(guardIso && guardIso.reason === 'EGUARD', '未执行（护栏拦下）→ EGUARD', guardIso && guardIso.reason);
  }

  // ── ⑤ 真落盘：flush 后段文件里能看到这些记录 ───────────────────────────────
  t.section('⑤ 落盘与崩溃报告');
  {
    await waitFlush(1400);
    const flushed = journal.flush(800);
    void flushed;
    const dir = journal.journalDir();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    t.ok(files.length >= 1, '台账目录里有段文件', { dir, files });
    const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    t.ok(/dsh-plugin-ok/.test(text), '段文件里能读到成功安装记录（持久化生效）', files);
    t.ok(/dsh-plugin-bad/.test(text), '段文件里能读到失败安装记录', files);
    t.ok(/"action":"install"/.test(text) || /"action": "install"/.test(text), '行内是结构化 JSON（可被工具消费）', text.slice(0, 160));

    const reportPath = await crashReport.writeCrashReportBounded({
      source: 'host', phase: 'startup', error: new Error('测试：崩溃报告应带出插件台账'),
      backendReady: false, backendLogTail: '', rendererConsole: []
    }, 2000);
    t.ok(!!reportPath && fs.existsSync(reportPath), '崩溃报告已写出', reportPath);
    const report = reportPath ? fs.readFileSync(reportPath, 'utf8') : '';
    t.ok(/插件操作台账|plugin/i.test(report), '崩溃报告包含插件台账片段标题', report.slice(0, 200));
    t.ok(/dsh-plugin-ok|dsh-plugin-bad|legacy-ok/.test(report), '崩溃报告带出了具体插件名（端到端证据）', report.slice(0, 400));
    t.ok(/collection complete/.test(report), '台账片段有"collection complete"收尾行（说明不是被截断的假象）', false);
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  clearTimeout(killer);
  t.summary();
  if (t.failures.length) h.printLogHead(LOG_FILE, 20);
  console.log('\n沙箱目录（可删除）：' + BASE);
  process.exit(t.failures.length ? 1 : 0);
})().catch((err) => {
  console.error('\n[异常] 测试自身抛出未预期错误：');
  console.error(err && (err.stack || err.message));
  h.printLogHead(LOG_FILE, 20);
  process.exit(2);
});
