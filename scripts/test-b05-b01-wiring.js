'use strict';

/**
 * 0.3.49 · B-05/B-01 接线回归：**真实 main.js** 里 sandbox / 导航白名单 / 开窗策略 /
 * cookie 清理 / 窗口通道分权 是否真的接上了（不是只有模块存在）。
 *
 * 为什么需要这一层：`url-policy.js` 单测只能证明"判定对"，证明不了"main.js 用了它"。
 * 0.3.44 的事故就是"模块与注册都对，唯独回调没接上" —— 所以这里用
 * `scripts/lib/stage1-main-harness.js` 把 main.js 编译进桩环境，直接调用
 * `createChromiumWindow` / `createSettingsWindow` / `assertOwnedSender`，检查：
 *   · 两个窗口构造参数里 sandbox:true（并读回 "实际生效" 的 webPreferences 日志）
 *   · 窗口上确实注册了 will-navigate 与 setWindowOpenHandler
 *   · 开窗策略在白名单外 → deny，白名单外链 → openExternal（且不产生新窗口）
 *   · 导航越权 → preventDefault 被调用
 *   · 每个已注册 IPC 通道都被"某个窗口"认领（否则运行期会被拒 → 静默功能丢失）
 *   · 设置窗清单与 settings-preload.js 的 ALLOWED_CHANNELS 完全一致（防漂移）
 *   · cookie 清理在"启动后端"之前被调用
 *
 * 用法：node scripts/test-b05-b01-wiring.js [--timeout 120]
 */

const fs = require('fs');
const path = require('path');
const h = require('./lib/stage1-main-harness');

const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 120;
const t = h.createAsserts();
const BASE = h.makeBase('b05w');
process.env.DSH_DIAG_BASE = BASE;
process.chdir(BASE);

const LOG_FILE = path.join(BASE, 'logs', 'DSH-Desktop-日志.txt');
const killer = setTimeout(() => {
  console.error(`\n[超时] 测试超过 ${TIMEOUT_SEC}s 未结束，强制退出（防卡死）。`);
  h.printLogHead(LOG_FILE, 20);
  process.exit(124);
}, TIMEOUT_SEC * 1000);

const waitFlush = (ms) => new Promise((r) => setTimeout(r, ms == null ? 600 : ms));

/** 带窗口/导航探针的 Electron 桩（在通用桩之上记录构造参数与事件注册）。 */
function createProbeElectron(opts) {
  const base = h.createElectronStub(opts);
  const state = base.state;
  state.windowOptions = [];
  state.windows = [];
  state.navListeners = [];
  state.openHandlers = [];
  state.shownWindows = 0;

  class ProbeWindow extends base.electron.BrowserWindow {
    constructor(options) {
      super(options);
      state.windowOptions.push(options);
      state.windows.push(this);
      this.options = options;
      this.webContents.id = state.windowOptions.length;
      this.webContents.getLastWebPreferences = () => ({
        sandbox: options && options.webPreferences ? options.webPreferences.sandbox : undefined,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      });
      const origOn = this.webContents.on.bind(this.webContents);
      this.webContents.on = (event, listener) => {
        if (event === 'will-navigate') state.navListeners.push(listener);
        return origOn(event, listener);
      };
      this.webContents.setWindowOpenHandler = (fn) => { state.openHandlers.push(fn); };
      this.loadURL = (url) => { this.loadedUrl = url; };
      this.loadFile = (file) => { this.loadedFile = file; };
    }
  }

  return {
    electron: Object.assign({}, base.electron, { BrowserWindow: ProbeWindow }),
    state
  };
}

function boot(cfg) {
  const o = cfg || {};
  const probe = createProbeElectron({ userData: BASE, balloonShow: false, notificationSupported: false });
  const childProcessStub = h.createChildProcessStub({});
  const backendStub = h.createUpdaterBackendStub({ root: path.join(BASE, 'backend') });
  const mod = h.loadMain({
    base: BASE,
    electronStub: probe.electron,
    childProcessStub: childProcessStub.module,
    backendStub,
    packageJsonStub: { name: 'dsh-desktop', version: '0.3.49' },
    exports: [
      'createChromiumWindow', 'createMainWindow', 'createSettingsWindow', 'createSplash', 'createTray',
      'assertOwnedSender', 'channelAllowedForWindow', 'cleanLegacyBackendCookies',
      'applyWindowHandlers', 'SETTINGS_WINDOW_CHANNELS', 'MAIN_WINDOW_CHANNELS',
      'showDeferredNotices', 'queueNotice', 'resolveRollbackTarget', 'logEffectiveWebPreferences'
    ]
  });
  return { mod, es: probe.state, backend: backendStub, cp: childProcessStub };
}

(async () => {
  console.log('0.3.49 · B-05/B-01 接线回归（真实 main.js + 桩 Electron）');
  console.log('沙箱：' + BASE);

  const mainSrc = fs.readFileSync(path.join(h.ROOT, 'main.js'), 'utf8');
  const codeOnly = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // ── ① 窗口安全配置：sandbox:true 且不再有 sandbox:false ─────────────────────
  t.section('① 窗口安全配置');
  t.ok(!/sandbox:\s*false/.test(codeOnly), 'main.js 里不再有任何 sandbox:false', false);
  const sandboxTrue = (codeOnly.match(/sandbox:\s*true/g) || []).length;
  t.ok(sandboxTrue >= 3, '主窗/设置窗/splash 三处都显式 sandbox:true', sandboxTrue);
  {
    const { mod, es } = boot({});
    mod.createChromiumWindow('http://127.0.0.1:51001/');
    mod.createSplash();
    mod.createSettingsWindow();
    const prefs = es.windowOptions.map((o) => (o.webPreferences || {}));
    t.ok(prefs.length === 3, '构造了三个窗口（主窗 + splash + 设置窗）', prefs.length);
    t.ok(prefs.every((p) => p.sandbox === true), '三个窗口的 webPreferences.sandbox 均为 true', prefs.map((p) => p.sandbox));
    t.ok(prefs.every((p) => p.contextIsolation === true), '三个窗口都保持 contextIsolation:true', prefs.map((p) => p.contextIsolation));
    t.ok(prefs.every((p) => p.nodeIntegration === false || p.nodeIntegration === undefined),
      '没有任何窗口打开 nodeIntegration', prefs.map((p) => p.nodeIntegration));
    t.ok(prefs.filter((p) => p.preload).length === 2, '两个窗口各有自己的 preload（主窗/设置窗）', prefs.filter((p) => p.preload).length);
    await waitFlush(600);
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    t.ok(/窗口安全配置（读回 Electron 实际生效值）/.test(text), '落盘了"读回实际生效值"的自证日志（真机证据来源）', false);
    t.ok(/"sandbox":true/.test(text), '自证日志里 sandbox 为 true（读回值，不是我们写的字面量）', false);
  }

  // ── ② 两个窗口都装了导航白名单 + 开窗处理器 ────────────────────────────────
  t.section('② 导航白名单与开窗处理器');
  {
    const { mod, es } = boot({});
    mod.createChromiumWindow('http://127.0.0.1:52002/');
    mod.createSettingsWindow();
    t.ok(es.navListeners.length === 2, '**两个**窗口都注册了 will-navigate（0.3.48 只有主窗，且没有导航处理器）', es.navListeners.length);
    t.ok(es.openHandlers.length === 2, '**两个**窗口都装了 setWindowOpenHandler', es.openHandlers.length);
    t.ok(/require\('\.\/url-policy'\)/.test(codeOnly), 'main.js 通过 url-policy 模块判定（不在原地写正则）', false);
    t.ok(/applyWindowHandlers\(settingsWindow/.test(codeOnly), '设置窗确实调用了 applyWindowHandlers', false);
  }

  // ── ③ 导航拦截真的会 preventDefault ────────────────────────────────────────
  t.section('③ 导航拦截行为');
  {
    const { mod, es } = boot({});
    mod.createChromiumWindow('http://127.0.0.1:53003/');
    const nav = es.navListeners[0];
    const fakeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

    const cross = fakeEvent();
    nav(cross, 'https://evil.example/phish');
    t.ok(cross.prevented === true, '跨源导航被 preventDefault（不是只记日志）', cross.prevented);

    const otherPort = fakeEvent();
    nav(otherPort, 'http://127.0.0.1:59999/admin');
    t.ok(otherPort.prevented === true, '同机不同端口的导航也被拦（避免跳到别的本地服务继续带我们的 preload）', otherPort.prevented);

    const same = fakeEvent();
    nav(same, 'http://127.0.0.1:53003/#/session/1');
    t.ok(same.prevented === false, '同源页面内跳转放行', same.prevented);

    const file = fakeEvent();
    nav(file, 'file:///C:/Windows/System32/calc.exe');
    t.ok(file.prevented === true, '应用目录外的 file:// 导航被拦', file.prevented);

    await waitFlush(600);
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    t.ok(/will-navigate\(main\) allow=false/.test(text) && /reason=cross-origin-navigation/.test(text),
      '被拦的导航写进诊断日志（含 reason，可归因）', false);
  }

  // ── ④ 开窗策略：默认 deny，白名单外链走 openExternal ───────────────────────
  t.section('④ 开窗策略行为');
  {
    const { mod, es } = boot({});
    mod.createChromiumWindow('http://127.0.0.1:54004/');
    const handler = es.openHandlers[0];

    const external = handler({ url: 'https://github.com/deepseek-ai/deepseek-harness' });
    t.ok(external.action === 'deny', '外链也只 deny（不在应用内开窗）', external);
    await waitFlush(400);
    t.ok(es.externalOpens.some((u) => /^https:\/\/github\.com\//.test(u)), '外链交给系统浏览器打开', es.externalOpens);

    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'vscode://x', 'data:text/html,x']) {
      const d = handler({ url: bad });
      t.ok(d.action === 'deny', `拒绝开窗：${bad}`, d);
      const leaked = es.externalOpens.filter((u) => u && u.indexOf(bad.slice(0, 10)) >= 0);
      t.ok(leaked.length === 0, `拒绝 ${bad} 时没有偷偷 openExternal`, leaked);
    }

    const loop = handler({ url: 'http://127.0.0.1:59999/x' });
    t.ok(loop.action === 'deny', '回环地址不作为外链打开', loop);
  }

  // ── ⑤ 窗口通道分权：清单与 preload / 注册表三方一致 ────────────────────────
  t.section('⑤ IPC 通道按窗口身份分权');
  {
    const { mod } = boot({});
    const settingsChannels = Array.from(mod.SETTINGS_WINDOW_CHANNELS);
    const mainChannels = Array.from(mod.MAIN_WINDOW_CHANNELS);

    // (a) 与 settings-preload.js 的白名单完全一致（防两份清单漂移）
    const preloadSrc = fs.readFileSync(path.join(h.ROOT, 'settings-preload.js'), 'utf8');
    const block = /ALLOWED_CHANNELS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(preloadSrc);
    const preloadChannels = block ? (block[1].match(/'([^']+)'/g) || []).map((s) => s.replace(/'/g, '')) : [];
    const a = settingsChannels.slice().sort().join(',');
    const b = preloadChannels.slice().sort().join(',');
    t.ok(preloadChannels.length === 22, 'settings-preload 白名单解析出 22 个通道（与 task-7 收敛结果一致）', preloadChannels.length);
    t.ok(a === b, 'main.js 的设置窗清单与 settings-preload.js **逐项一致**', { mainJs: settingsChannels, preload: preloadChannels });

    // (b) 所有已注册通道都必须被某个窗口认领（否则运行期被拒 = 静默功能丢失）
    const registered = Array.from(new Set((mainSrc.match(/handleIpc\('([^']+)'/g) || []).map((s) => s.replace(/handleIpc\('/, '').replace(/'$/, ''))));
    const unclassified = registered.filter((c) => !settingsChannels.includes(c) && !mainChannels.includes(c));
    t.ok(registered.length >= 28, '解析出全部已注册通道', registered.length);
    t.ok(unclassified.length === 0, '每个已注册通道都被某个窗口认领（没有"注册了但谁也调不到"的通道）', unclassified);

    // (c) 两份清单不重叠（同一通道不能既属主窗又属设置窗）
    const overlap = settingsChannels.filter((c) => mainChannels.includes(c));
    t.ok(overlap.length === 0, '主窗与设置窗的通道清单没有交集', overlap);

    // (d) 高危通道只属设置窗
    for (const high of ['plugins:install', 'plugins:set-path-entry', 'backend:rollback-to', 'plugins:import-legacy']) {
      t.ok(mod.channelAllowedForWindow('settings', high) === true && mod.channelAllowedForWindow('main', high) === false,
        `${high} 仅设置窗可调（主窗里的插件前端代码碰不到）`, { settings: mod.channelAllowedForWindow('settings', high), main: mod.channelAllowedForWindow('main', high) });
    }
  }

  // ── ⑥ assertOwnedSender：跨窗越权会被拒 ────────────────────────────────────
  t.section('⑥ assertOwnedSender 按窗口身份拒绝越权');
  {
    const { mod, es } = boot({});
    await mod.createMainWindow('http://127.0.0.1:55005/');
    mod.createSettingsWindow();
    const mainWin = es.windowOptions.length ? null : null; // 占位，说明用的是模块内窗口
    void mainWin;
    const senderOf = (winIndex) => ({ id: winIndex + 1 });
    const event = (winIndex, url) => ({ sender: senderOf(winIndex), senderFrame: { url } });

    // 主窗（第 1 个创建的窗口）调设置窗专属通道 → 必须抛错
    let err1 = null;
    try { mod.assertOwnedSender(event(0, 'http://127.0.0.1:55005/'), 'plugins:install'); } catch (e) { err1 = e; }
    t.ok(!!err1 && /不得调用 plugins:install/.test(err1.message), '主窗调用 plugins:install → 拒绝（越权 IPC）', err1 && err1.message);

    // 设置窗（第 2 个）调主窗专属通道 → 必须抛错
    let err2 = null;
    try { mod.assertOwnedSender(event(1, 'file:///' + path.join(h.ROOT, 'settings.html').replace(/\\/g, '/')), 'app:device-info'); } catch (e) { err2 = e; }
    t.ok(!!err2 && /不得调用 app:device-info/.test(err2.message), '设置窗调用 app:device-info → 拒绝', err2 && err2.message);

    // 各自合法通道 → 放行
    let okMain = true; let okSettings = true;
    try { mod.assertOwnedSender(event(0, 'http://127.0.0.1:55005/'), 'app:get-version'); } catch { okMain = false; }
    try { mod.assertOwnedSender(event(1, 'file:///' + path.join(h.ROOT, 'settings.html').replace(/\\/g, '/')), 'settings:get'); } catch { okSettings = false; }
    t.ok(okMain, '主窗调用自己的通道放行', okMain);
    t.ok(okSettings, '设置窗调用自己的通道放行', okSettings);

    // 陌生 sender → 拒绝
    let err3 = null;
    try { mod.assertOwnedSender({ sender: { id: 999 }, senderFrame: { url: 'http://127.0.0.1:55005/' } }, 'app:get-version'); } catch (e) { err3 = e; }
    t.ok(!!err3 && /非本应用窗口/.test(err3.message), '非本应用窗口的 IPC 仍被拒（原校验未退化）', err3 && err3.message);

    await waitFlush(600);
    t.ok(/已拒绝越权 IPC/.test(fs.readFileSync(LOG_FILE, 'utf8')), '越权尝试写进诊断日志（可归因到注入链）', false);
  }

  // ── ⑦ cookie 清理：在"启动后端"之前执行 ────────────────────────────────────
  t.section('⑦ B-01 cookie 清理接线');
  {
    const idxClean = codeOnly.indexOf('await cleanLegacyBackendCookies()');
    const idxStart = codeOnly.indexOf('const url = await startBackendWithPluginIsolation');
    t.ok(idxClean > 0, 'main.js 调用了 cleanLegacyBackendCookies()', idxClean);
    t.ok(idxStart > 0 && idxClean < idxStart, '清理发生在「启动后端」之前（否则旧 cookie 已随首个请求发出）', { idxClean, idxStart });
    t.ok(/require\('\.\/session-hygiene'\)/.test(codeOnly), 'main.js 通过 session-hygiene 模块清理（不在原地写逻辑）', false);

    // 真实执行一次（假 session）：确认它真的会去清 cookie 并写日志
    const removed = [];
    const store = [
      { name: 'dsh-auth-old', domain: '127.0.0.1', path: '/', secure: false },
      { name: 'other-tool', domain: '127.0.0.1', path: '/', secure: false },
      { name: 'sessionid', domain: 'npmjs.com', path: '/', secure: true }
    ];
    const probe = createProbeElectron({ userData: BASE, balloonShow: false, notificationSupported: false });
    probe.electron.session = {
      defaultSession: {
        cookies: {
          async get() { return store.map((c) => ({ ...c })); },
          async remove(url, name) {
            removed.push({ url, name });
            const i = store.findIndex((c) => c.name === name);
            if (i >= 0) store.splice(i, 1);
            return true;
          }
        }
      }
    };
    const mod2 = h.loadMain({
      base: BASE,
      electronStub: probe.electron,
      childProcessStub: h.createChildProcessStub({}).module,
      backendStub: h.createUpdaterBackendStub({ root: path.join(BASE, 'backend') }),
      packageJsonStub: { name: 'dsh-desktop', version: '0.3.49' },
      exports: ['cleanLegacyBackendCookies']
    });
    const result = await mod2.cleanLegacyBackendCookies();
    t.ok(result && result.removed.length === 1 && result.removed[0].name === 'dsh-auth-old',
      '真实清理只删本产品旧 cookie', result && result.removed.map((c) => c.name));
    t.ok(store.some((c) => c.name === 'other-tool'), '**回环上其它工具的 cookie 未被误删**', store.map((c) => c.name));
    t.ok(store.some((c) => c.name === 'sessionid'), '**外网站点登录态未被误删**', store.map((c) => c.name));
    await waitFlush(600);
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    t.ok(/旧后端 cookie 清理：扫描 3 条，清除 1 条/.test(text), '清理结果写进后端日志（条数 + 按源）', false);
  }

  // ── ⑧ 启动提示队列（隔离结果 / 上次更新未完成）─────────────────────────────
  t.section('⑧ 延后通知队列（阶段一审计遗留接线）');
  {
    t.ok(/recordIsolationOutcome\(qRes\)/.test(codeOnly), 'profile 隔离结果接入 recordIsolationOutcome（不再只写日志）', false);
    t.ok(/queueNotice\(\{/.test(codeOnly), '隔离/更新中断使用延后队列（启动早期不阻塞）', false);
    t.ok(/showDeferredNotices\(\);/.test(codeOnly), '主窗口就绪后统一展示延后通知', false);
    t.ok(/interruptedApplyState\(\)/.test(codeOnly), 'H-05 中断态在启动早期读取（mgr.interruptedApplyState）', false);

    const { mod, es } = boot({});
    mod.queueNotice({ kind: 'isolation-abandoned', title: '插件隔离已放弃', message: '已放弃，数据原样', detail: 'detail' });
    mod.queueNotice({ kind: 'isolation-abandoned', title: '重复', message: '重复', detail: '' }); // 同 kind 幂等
    const shown = mod.showDeferredNotices();
    await waitFlush(400);
    t.ok(shown === 1, '同 kind 通知幂等（只保留一条，避免阶梯重试刷屏）', shown);
    t.ok(es.messageBoxes.length === 1, '只有一条提示弹窗', es.messageBoxes.length);
    t.ok(/插件隔离已放弃/.test(es.messageBoxes[0].title), '提示标题点明"隔离已放弃"', es.messageBoxes[0].title);
    t.ok(es.messageBoxes[0].buttons.length === 1 && es.messageBoxes[0].buttons[0] === '知道了',
      '非阻塞单按钮提示（不需要用户操作）', es.messageBoxes[0].buttons);
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
