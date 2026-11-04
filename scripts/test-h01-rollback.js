'use strict';

/**
 * 0.3.48 · H-01 回归：回滚从「死代码」变成真正接电（按钮 + 自动回滚 + 防死循环）。
 *
 * ## 背景（要修的缺陷）
 *
 * `rollbackDsh()` 在 `updater-backend.js` 里实现完整、也导出了，但**全仓零调用点**；
 * `showFatal()` 的六个按钮里没有回滚。于是"更新装坏了"的用户只能自己翻设置窗，
 * 而 `dsh.previous` 就躺在磁盘上拿不到（H-01）。
 *
 * ## 本测试验证什么（全部用 main.js 的真实函数，桩只替换 electron / mgr / spawn）
 *
 *   ① 故障弹窗在 dsh.previous 存在且"值得回滚"时**出现回滚按钮**，点击 = 回滚 + 重启
 *   ② 连续第 2 次启动失败 → **自动回滚一次**，并把"已自动回滚到 vX"暂存给下次启动
 *   ③ 本轮已自动回滚过 → 不再自动回滚（只给手动按钮）—— 防"重启—回滚"死循环
 *   ④ 启动成功 → 失败计数与回滚链清零；一次性提示只显示一次
 *   ⑤ journal 未验证记录从"只写日志"升级为"提示用户并提供回滚"
 *   ⑥ 没有 dsh.previous 时不出现回滚按钮（不许点一个必然失败的动作）
 *   ⑦ 每次回滚都写诊断日志 + 生命周期台账，且回滚后的版本号在日志里
 *
 * 用法：node scripts/test-h01-rollback.js [--timeout 120]
 */

const fs = require('fs');
const path = require('path');
const h = require('./lib/stage1-main-harness');

const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 120;
const t = h.createAsserts();
const BASE = h.makeBase('h01');
process.env.DSH_DIAG_BASE = BASE;
process.chdir(BASE);

const LOG_DIR = path.join(BASE, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'DSH-Desktop-日志.txt');
const LEDGER_FILE = path.join(LOG_DIR, 'DSH-Desktop-生命周期.log');
const STATE_FILE = path.join(BASE, 'startup-recovery.json');
const BACKEND_ROOT = path.join(BASE, 'backend');

const killer = setTimeout(() => {
  console.error(`\n[超时] 测试超过 ${TIMEOUT_SEC}s 未结束，强制退出（防卡死）。`);
  h.printLogHead(LOG_FILE, 20);
  process.exit(124);
}, TIMEOUT_SEC * 1000);

/**
 * 读日志前先等一拍：0.3.48 起 diag-log 是「内存队列 + 批量 flush」（H-10 的修复），
 * 写完立刻读会读到还没刷盘的内容。等待而不是直接读，是为了让断言仍然验证"日志
 * 里确实写下了这句话"，而不是"碰巧在同一毫秒刷了盘"。
 */
const waitFlush = (ms) => new Promise((r) => setTimeout(r, ms == null ? 400 : ms));

/** 造出「dsh.previous 可用」的磁盘素材（判据与 rollbackDsh 一致）。 */
function makePrevious() {
  const prevBin = path.join(BACKEND_ROOT, 'dsh.previous', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(prevBin), { recursive: true });
  fs.writeFileSync(prevBin, '// previous dsh bin\n', 'utf8');
}

function removePrevious() {
  fs.rmSync(path.join(BACKEND_ROOT, 'dsh.previous'), { recursive: true, force: true });
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

/**
 * 载入一份全新的 main.js（= 一次新启动；模块级状态如 fatalCounted 全部重置）。
 * @param {{backend?: object, msgBoxResponses?: Array<{response:number}>, balloonShow?: boolean,
 *          notificationSupported?: boolean}} cfg
 */
function boot(cfg) {
  const o = cfg || {};
  const { electron, state } = h.createElectronStub({
    userData: BASE,
    msgBoxResponses: o.msgBoxResponses,
    balloonShow: o.balloonShow !== false,
    notificationSupported: o.notificationSupported !== false
  });
  const childProcessStub = h.createChildProcessStub({});
  const backendStub = h.createUpdaterBackendStub(Object.assign({ root: BACKEND_ROOT }, o.backend || {}));
  const mod = h.loadMain({
    base: BASE,
    electronStub: electron,
    childProcessStub: childProcessStub.module,
    backendStub,
    exports: [
      'showFatal', 'createTray', 'loadRecoveryState', 'saveRecoveryState', 'performRollback',
      'markStartupHealthy', 'showPendingRecoveryNotice', 'rollbackTargetExists',
      'manualRollbackAndRestart', 'journalUnverifiedSafe', 'startupBudgets', 'notifyUser'
    ]
  });
  return { mod, es: state, backend: backendStub };
}

const ROLLBACK_LABEL = '回滚到上一个版本';

(async () => {
  console.log('0.3.48 · H-01 回归：回滚接电 + 自动回滚防死循环');
  console.log('沙箱：' + BASE);

  fs.mkdirSync(BACKEND_ROOT, { recursive: true });

  // ── ① 首次失败：计数落盘、不越级自动回滚（阈值是 2 次）───────────────────
  t.section('① 首次启动失败：只计数、只弹窗（不越级自动回滚）');
  {
    makePrevious();
    fs.rmSync(STATE_FILE, { force: true });
    const { mod, es } = boot({ msgBoxResponses: [{ response: 4 }] }); // 4 = 留在托盘稍后处理
    mod.createTray();
    t.ok(mod.rollbackTargetExists() === true, '磁盘上的 dsh.previous 被识别为可用回滚目标', mod.rollbackTargetExists());
    const initial = mod.loadRecoveryState();
    t.ok(initial.consecutiveFailures === 0 && initial.rollbacksInChain === 0, '初始台账为零', initial);

    await mod.showFatal(new Error('后端进程提前退出（code=1 signal=null）。'));
    const state = readState();
    t.ok(es.messageBoxes.length === 1, '弹了且只弹了一次恢复弹窗', es.messageBoxes.length);
    const box = es.messageBoxes[0];
    t.ok(box.buttons.indexOf(ROLLBACK_LABEL) === -1, '只有 1 次失败时不提供回滚按钮（阈值是连续 2 次）', box.buttons);
    t.ok(box.buttons.length === 6, '非端口占用场景仍是 6 个动作（保持既有风格）', box.buttons);
    t.ok(state.consecutiveFailures === 1, '失败次数已落盘为 1', state.consecutiveFailures);
    t.ok(es.relaunches.length === 0, '这次没有任何重启（用户选了留在托盘）', es.relaunches);

    // 同一次启动里再次进入 showFatal（托盘点开恢复弹窗）不应重复计数。
    await mod.showFatal(new Error('后端进程提前退出（code=1 signal=null）。'));
    t.ok(readState().consecutiveFailures === 1, '同一次启动内重复进入 showFatal 不重复计数', readState().consecutiveFailures);
  }

  // ── ② 连续第 2 次失败：自动回滚一次 ────────────────────────────────────────
  t.section('② 连续第 2 次失败：自动回滚 + 暂存"已回滚"提示');
  {
    makePrevious();
    writeState(Object.assign(mod0State(), { consecutiveFailures: 1 }));
    const { mod, es, backend } = boot({ balloonShow: true });
    mod.createTray();
    await mod.showFatal(new Error('后端进程提前退出（code=1 signal=null）。'));
    const state = readState();
    t.ok(backend.calls.rollback === 1, '自动执行了一次 rollbackDsh()（此前全仓零调用点）', backend.calls);
    t.ok(state.rollbacksInChain === 1, '本轮自动回滚次数已落盘为 1（防死循环的计量单元）', state.rollbacksInChain);
    t.ok(state.consecutiveFailures === 2, '失败计数累加到 2（保留证据，不因回滚而抹掉）', state.consecutiveFailures);
    t.ok(state.lastRollback && state.lastRollback.auto === true, '台账记录了这是一次自动回滚', state.lastRollback);
    t.ok(state.lastRollback.from === '1.0.0-test' && state.lastRollback.to === '0.9.0-previous',
      '台账记录了回滚前后版本（from → to）', state.lastRollback);
    t.ok(state.pendingNotice && state.pendingNotice.to === '0.9.0-previous',
      '「已自动回滚到 vX」提示已暂存给下次启动', state.pendingNotice);
    t.ok(es.relaunches.length === 1, '回滚后自动重启应用', es.relaunches.length);
    t.ok(es.messageBoxes.length === 0, '自动回滚路径不弹阻塞弹窗（提示留给重启后）', es.messageBoxes.length);
    t.ok(es.trays.length >= 1 && es.trays[0].balloons.length >= 1, '回滚前仍先发了一次托盘气泡（托盘入口保留）', es.trays[0] && es.trays[0].balloons);

    await waitFlush();
    const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    t.ok(/回滚（auto）完成：1\.0\.0-test → 0\.9\.0-previous/.test(logText),
      '诊断日志写明回滚后的版本（0.3.48 · 回滚必须留痕）', logText.split(/\r?\n/).filter((l) => l.indexOf('回滚') >= 0).slice(-3));
    const ledger = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, 'utf8') : '';
    t.ok(/"auto-rollback"/.test(ledger), '生命周期台账写了 auto-rollback 事件', ledger.split(/\r?\n/).filter((l) => l.indexOf('rollback') >= 0).slice(-2));
  }

  // ── ③ 回滚后成功启动：清零 + 一次性提示只显示一次 ──────────────────────────
  t.section('③ 回滚后启动成功：清零计数 + 一次性提示');
  {
    makePrevious();
    writeState({
      schema: 1, consecutiveFailures: 2, rollbacksInChain: 1, autoRollbacksTotal: 1,
      lastFailureAt: '2026-11-04T00:00:00.000Z', lastFailureSummary: 'stub',
      lastRollback: { at: '2026-11-04T00:00:01.000Z', from: '1.0.0-test', to: '0.9.0-previous', auto: true, reason: 'consecutive-failures' },
      pendingNotice: { kind: 'auto-rollback', at: '2026-11-04T00:00:01.000Z', from: '1.0.0-test', to: '0.9.0-previous', reason: 'consecutive-failures' }
    });
    const { mod, es } = boot({ balloonShow: true });
    mod.createTray();
    mod.markStartupHealthy();
    await new Promise((r) => setTimeout(r, 50));
    const state = readState();
    t.ok(state.consecutiveFailures === 0, '启动成功 → 失败计数清零（否则几个月后偶发失败会误触发回滚）', state.consecutiveFailures);
    t.ok(state.rollbacksInChain === 0, '启动成功 → 自动回滚链清零（下一次真正需要时仍可自动救一次）', state.rollbacksInChain);
    t.ok(state.pendingNotice === null, '一次性提示已消费（不会每次启动都弹）', state.pendingNotice);
    t.ok(es.messageBoxes.length === 1, '回滚后的提示弹了一次', es.messageBoxes.length);
    t.ok(/已自动回滚到 v0\.9\.0-previous/.test(es.messageBoxes[0].message),
      '提示文案说明"已自动回滚到 vX"', es.messageBoxes[0] && es.messageBoxes[0].message);
    t.ok(/只把 backend 里的 dsh 程序目录换回上一个版本/.test(es.messageBoxes[0].detail || ''),
      '提示说明改了什么（不动会话/密钥/设置）', (es.messageBoxes[0].detail || '').slice(0, 80));
    t.ok(/DSH-Desktop-日志\.txt/.test(es.messageBoxes[0].detail || ''), '提示里给出日志绝对路径', es.messageBoxes[0].detail);

    // 再启动一次（新进程）不应该再看到这条提示。
    const second = boot({ balloonShow: false });
    second.mod.createTray();
    second.mod.showPendingRecoveryNotice();
    await new Promise((r) => setTimeout(r, 30));
    t.ok(second.es.messageBoxes.length === 0, '提示只显示一次（下一次启动不再打扰）', second.es.messageBoxes.length);
  }

  // ── ④ 防死循环：本轮已自动回滚过 → 只提供手动按钮 ──────────────────────────
  t.section('④ 防死循环：本轮已回滚过就不再自动回滚');
  {
    makePrevious();
    writeState({
      schema: 1, consecutiveFailures: 1, rollbacksInChain: 1, autoRollbacksTotal: 1,
      pendingNotice: null
    });
    // 用户点第 0 个按钮（回滚到上一个版本）
    const { mod, es, backend } = boot({ msgBoxResponses: [{ response: 0 }], balloonShow: true });
    mod.createTray();
    await mod.showFatal(new Error('又一次启动失败'));
    const box = es.messageBoxes[0];
    t.ok(box && box.buttons[0] === ROLLBACK_LABEL, '第 2 次自动回滚被拒绝，但手动回滚按钮排在第一位', box && box.buttons);
    t.ok(box && /已经自动回滚过一次/.test(box.detail || ''), '弹窗解释了为什么不再自动回滚（不许无声地不回滚）', (box.detail || '').slice(0, 120));
    const state = readState();
    t.ok(backend.calls.rollback === 1, '用户点按钮后才执行了这一次回滚（自动侧没有越权）', backend.calls.rollback);
    t.ok(state.rollbacksInChain === 1, '手动回滚不计入"本轮自动回滚"额度', state.rollbacksInChain);
    t.ok(es.relaunches.length === 1, '手动回滚后重启应用', es.relaunches.length);
  }

  // ── ⑤ journal 未验证记录：从"只写日志"升级为"提示用户" ────────────────────
  t.section('⑤ journal 未验证记录 → 提示用户 + 提供回滚');
  {
    makePrevious();
    fs.rmSync(STATE_FILE, { force: true });
    const { mod, es } = boot({
      balloonShow: true,
      backend: { journal: [{ kind: 'dsh', to: '1.2.3', at: '2026-11-03T12:00:00.000Z' }] }
    });
    mod.createTray();
    t.ok(mod.journalUnverifiedSafe().length === 1, 'journal 未验证记录可被安全读取', mod.journalUnverifiedSafe());
    await mod.showFatal(new Error('后端进程提前退出（code=9）'));
    const box = es.messageBoxes[0];
    t.ok(box && box.buttons[0] === ROLLBACK_LABEL, 'journal 证据存在时回滚按钮出现', box && box.buttons);
    t.ok(box && /上次更新未验证通过/.test(box.message), '弹窗标题点明"上次更新未验证通过"', box && box.message);
    t.ok(box && /已应用但未验证/.test(box.detail || ''), '弹窗列出 journal 证据（不是只写日志）', (box.detail || '').slice(0, 140));
  }

  // ── ⑥ 没有 dsh.previous：不给必然失败的动作 ───────────────────────────────
  t.section('⑥ 没有 dsh.previous：不提供回滚按钮');
  {
    removePrevious();
    fs.rmSync(STATE_FILE, { force: true });
    writeState({ schema: 1, consecutiveFailures: 1, rollbacksInChain: 0 });
    const { mod, es, backend } = boot({ msgBoxResponses: [{ response: 4 }], balloonShow: true });
    mod.createTray();
    t.ok(mod.rollbackTargetExists() === false, 'dsh.previous 不存在时判定为不可回滚', mod.rollbackTargetExists());
    await mod.showFatal(new Error('启动失败（没有上一个版本）'));
    const box = es.messageBoxes[0];
    t.ok(box && box.buttons.indexOf(ROLLBACK_LABEL) === -1, '没有回滚素材就不出现回滚按钮', box && box.buttons);
    t.ok(backend.calls.rollback === 0, '自动回滚也没有被触发（无米下锅）', backend.calls.rollback);

    // 直接调用回滚也必须如实失败，而不是静默成功。
    const rb = await mod.performRollback('manual');
    t.ok(rb.ok === false, 'performRollback 在没有素材时返回 ok=false', rb);
    t.ok(rb.error && /没有可用的上一个版本/.test(rb.error.message), '失败原因可读（不是一句"失败"）', rb.error && rb.error.message);
  }

  // ── ⑦ 端口被占：绝不回滚（那是"另一个实例还在跑"）──────────────────────────
  t.section('⑦ 端口被占（EADDRINUSE）时不回滚');
  {
    makePrevious();
    fs.rmSync(STATE_FILE, { force: true });
    writeState({ schema: 1, consecutiveFailures: 5, rollbacksInChain: 0 });
    const { mod, es, backend } = boot({ msgBoxResponses: [{ response: 1 }], balloonShow: true });
    mod.createTray();
    await mod.showFatal(new Error('listen EADDRINUSE: address already in use 127.0.0.1:1234'));
    t.ok(backend.calls.rollback === 0, '端口冲突即便连续失败 5 次也不自动回滚（回滚治不了端口冲突）', backend.calls.rollback);
    t.ok(es.messageBoxes.length === 1 && es.messageBoxes[0].buttons.length === 2,
      '端口冲突仍走既有的两按钮专用路径', es.messageBoxes[0] && es.messageBoxes[0].buttons);
    t.ok(es.quits >= 1, '用户选"退出"即退出', es.quits);
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

/** 空台账（写进 §2 的用例里，避免各用例手抄字段）。 */
function mod0State() {
  return {
    schema: 1, consecutiveFailures: 0, rollbacksInChain: 0, autoRollbacksTotal: 0,
    lastFailureAt: null, lastFailureSummary: null, lastHealthyBootAt: null,
    lastRollback: null, pendingNotice: null, lastNoticeShownAt: null
  };
}
