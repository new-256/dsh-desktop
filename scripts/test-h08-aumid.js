'use strict';

/**
 * 0.3.48 · H-08 回归（含「打包后失效」复修）：AUMID 必须来自**随包常量**，且通知可取证。
 *
 * ## 两段缺陷史（本测试要同时锁死）
 *
 * ① 0.3.48 A 版：全仓 0 处 `app.setAppUserModelId()`，而托盘气泡是唯一主动通知
 *    通道；Win10/11 对没有 AUMID 的进程会**静默丢弃**气泡（不报错、不进日志）。
 * ② 0.3.48 A 版修复后仍错：身份取自 `require('./package.json')` 的构建字段，而
 *    electron-builder 打包时会**重写 app 的 package.json 并剥离 `build` 段**
 *    （实测成品 asar 内 package.json 仅 503 字节、无 `build`）→ 开发态正常、
 *    **shipped 包里 `setAppUserModelId` 从未执行**，AUMID 保护整体空转。
 *
 * 现在的契约：身份是随包模块 `app-identity.js` 的常量（`*.js` 已被 build.files
 * 覆盖），且由 `scripts/app-identity-gate.js` 机械保证它 === 构建侧 appId。
 *
 * ## 覆盖点
 *
 *   ① 身份常量存在、格式合法、与构建侧 appId 逐字符相等（漂移门禁的测试侧镜像）
 *   ② **模拟打包环境**（package.json 无 `build` 段）仍能取到 appId 并调用
 *      `setAppUserModelId` —— 直接锁死本次缺陷类型
 *   ③ main.js 不再访问 package.json（require 记录 + 源码静态双证）
 *   ④ `app-identity.js` 的自检是 fail-closed（非法值直接 throw，不返回 undefined）
 *   ⑤ 设置成功/失败都有可见日志（`aumidApplied:true/false` + 具体 appId）
 *   ⑥ 通知统一出口：气泡取证（balloon-show 确认 / 未确认改走 Notification）
 *   ⑦ 通道不可用时不假装发过；托盘入口保留
 *
 * 用法：node scripts/test-h08-aumid.js [--timeout 120]
 */

const fs = require('fs');
const path = require('path');
const h = require('./lib/stage1-main-harness');

const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 120;
const t = h.createAsserts();
const BASE = h.makeBase('h08');
process.env.DSH_DIAG_BASE = BASE;
process.chdir(BASE);

const LOG_FILE = path.join(BASE, 'logs', 'DSH-Desktop-日志.txt');
const killer = setTimeout(() => {
  console.error(`\n[超时] 测试超过 ${TIMEOUT_SEC}s 未结束，强制退出（防卡死）。`);
  h.printLogHead(LOG_FILE, 20);
  process.exit(124);
}, TIMEOUT_SEC * 1000);

/** 等 diag-log 的批量 flush（0.3.48 起写日志是内存队列 + 定时刷盘）。 */
const waitFlush = (ms) => new Promise((r) => setTimeout(r, ms == null ? 600 : ms));
function logText() {
  try { return fs.readFileSync(LOG_FILE, 'utf8'); }
  catch (e) { console.log('（读日志失败：' + e.message + '）'); return ''; }
}

/**
 * 模拟 electron-builder 打包后的 package.json：**没有 `build` 段**（实测形态）。
 * 字段集合照抄成品 asar 内的 503 字节版本，避免"模拟得比现实宽松"。
 */
const PACKAGED_PACKAGE_JSON = {
  name: 'dsh-desktop',
  productName: 'DSH Desktop',
  version: '0.3.48',
  description: 'DeepSeek Harness desktop shell',
  author: { name: 'lcl' },
  license: 'MIT',
  private: true,
  repository: { type: 'git', url: 'https://example.invalid/dsh-desktop.git' },
  main: 'main.js',
  dependencies: { 'electron-updater': '^6.6.2' }
};

/**
 * @param {{balloonShow?: boolean, balloonThrows?: boolean, notificationSupported?: boolean,
 *          packageJsonStub?: object}} cfg
 */
function boot(cfg) {
  const o = cfg || {};
  const { electron, state } = h.createElectronStub({
    userData: BASE,
    balloonShow: o.balloonShow,
    balloonThrows: o.balloonThrows,
    notificationSupported: o.notificationSupported
  });
  const mod = h.loadMain({
    base: BASE,
    electronStub: electron,
    childProcessStub: h.createChildProcessStub({}).module,
    backendStub: h.createUpdaterBackendStub({ root: path.join(BASE, 'backend') }),
    packageJsonStub: o.packageJsonStub,
    exports: ['createTray', 'notifyUser', 'deliverFallbackNotification', 'notificationSupported', 'showFatal']
  });
  return { mod, es: state };
}

(async () => {
  console.log('0.3.48 · H-08 回归：随包身份常量 + 打包后仍生效 + 通知通道取证');
  console.log('沙箱：' + BASE);

  const pkg = JSON.parse(fs.readFileSync(path.join(h.ROOT, 'package.json'), 'utf8'));
  const buildAppId = pkg.build && pkg.build.appId;
  const mainSrc = fs.readFileSync(path.join(h.ROOT, 'main.js'), 'utf8');
  const codeOnly = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const identitySrc = fs.readFileSync(path.join(h.ROOT, 'app-identity.js'), 'utf8');
  // 只检查可执行代码：身份模块的注释里需要引用"旧写法长什么样"，不能算依赖。
  const identityCodeOnly = identitySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const identity = require(path.join(h.ROOT, 'app-identity.js'));

  // ── ① 身份常量：存在、格式合法、与构建侧 appId 逐字符相等 ──────────────────
  t.section('① 随包身份常量（单一运行期事实源）');
  t.ok(typeof identity.DSH_APP_ID === 'string' && identity.DSH_APP_ID.length > 0,
    'app-identity.js 导出非空字符串常量 DSH_APP_ID', identity.DSH_APP_ID);
  t.ok(identity.DSH_APP_ID === buildAppId,
    '常量与构建侧 appId 逐字符相等（漂移会让安装器身份与进程 AUMID 分叉）',
    { constant: identity.DSH_APP_ID, buildAppId });
  t.ok(identity.APP_ID === identity.DSH_APP_ID && identity.appId === identity.DSH_APP_ID,
    '别名字段指向同一个值（不存在第二处字面量）', { APP_ID: identity.APP_ID, appId: identity.appId });
  t.ok(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(identity.DSH_APP_ID),
    '常量符合反向域名字面量格式（小写、点分、至少两段）', identity.DSH_APP_ID);
  t.ok(!/require\s*\(\s*['"]\.\/package\.json['"]\s*\)/.test(identityCodeOnly),
    'app-identity.js 自己（可执行代码）不依赖 package.json（否则打包后同样是 undefined）', false);

  // ── ② 打包环境回归：package.json 没有 build 段也必须生效 ───────────────────
  t.section('② 模拟打包环境（package.json 无 build 段）—— 本次缺陷的直接回归用例');
  {
    t.ok(!Object.prototype.hasOwnProperty.call(PACKAGED_PACKAGE_JSON, 'build'),
      '（测试前提）注入的 package.json 确实没有 build 段', Object.keys(PACKAGED_PACKAGE_JSON));
    const { mod, es } = boot({ balloonShow: true, packageJsonStub: PACKAGED_PACKAGE_JSON });
    t.ok(es.aumid.length === 1, '打包环境下 setAppUserModelId 仍被调用（0.3.48 A 版这里是 0 次）', es.aumid);
    t.ok(es.aumid[0] === buildAppId, '打包环境下设置的 AUMID 与构建侧一致', es.aumid[0]);
    const reqs = mod.__requireLog || [];
    t.ok(reqs.indexOf('./package.json') === -1,
      'main.js 运行期**没有** require package.json（require 记录为证）', reqs.filter((r) => r.indexOf('package') >= 0));
    t.ok(reqs.indexOf('./app-identity') >= 0, 'main.js 确实 require 了 app-identity（身份来源可见）', reqs);
    await waitFlush(600);
    t.ok(/aumidApplied:true/.test(logText()), '成功日志里有 aumidApplied:true（B 版复验口径）', false);
    t.ok(/AppUserModelID 已设置 aumidApplied:true appId=com\.deepseek\.dshdesktop/.test(logText()),
      '成功日志带具体 appId 与来源', false);
  }

  // ── ③ 静态证据：main.js 不再读会被剥离的字段 ───────────────────────────────
  t.section('③ 静态证据：不再读会被打包剥离的字段');
  t.ok(!/require\s*\(\s*['"]\.\/package\.json['"]\s*\)/.test(codeOnly),
    'main.js 可执行代码中没有任何 require(./package.json)', false);
  t.ok(!/(?:^|[^A-Za-z0-9_$])pkg\s*\.\s*build\b/.test(codeOnly),
    'main.js 不再访问 pkg.build.*（打包后该字段被剥离）', false);
  t.ok(!/\.\s*(?:devDependencies|devDeps)\b/.test(codeOnly), 'main.js 不读 devDependencies', false);
  t.ok(/require\s*\(\s*['"]\.\/app-identity['"]\s*\)/.test(codeOnly), 'main.js 从 ./app-identity 取身份常量', false);
  t.ok(/app\.setAppUserModelId\s*\(\s*DSH_APP_ID\s*\)/.test(codeOnly),
    '常量被直接喂给 app.setAppUserModelId(DSH_APP_ID)', false);

  // ── ④ 自检 fail-closed：非法身份必须抛，不许返回 undefined ─────────────────
  t.section('④ app-identity 自检（fail-closed）');
  {
    const cases = [
      { label: '非字符串（undefined）', value: undefined },
      { label: '空字符串', value: '' },
      { label: '单段（没有点）', value: 'dshdesktop' },
      { label: '含大写', value: 'com.DeepSeek.DSHDesktop' },
      { label: '前后有空白', value: ' com.deepseek.dshdesktop ' },
      { label: '超长（>128）', value: 'com.' + 'a'.repeat(130) }
    ];
    let thrown = 0;
    for (const c of cases) {
      let err = null;
      try { identity.assertAppId(c.value); } catch (e) { err = e; }
      if (err) thrown += 1;
      t.ok(!!err, `非法值被拒绝并抛错：${c.label}`, err ? 'ok' : '未抛错');
    }
    t.ok(thrown === cases.length, '全部非法输入都被拒绝（没有静默返回 undefined）', { thrown, total: cases.length });
    t.ok(identity.assertAppId('com.deepseek.dshdesktop') === 'com.deepseek.dshdesktop',
      '合法值原样返回（便于链式使用）', identity.assertAppId('com.deepseek.dshdesktop'));
  }

  // ── ⑤ 设置时机：模块加载期（早于 whenReady）────────────────────────────────
  t.section('⑤ 设置时机（早于 whenReady / 早于任何气泡）');
  {
    const { es } = boot({ balloonShow: true });
    t.ok(es.aumid.length === 1, '模块加载阶段即完成设置（桩的 whenReady 永不 settle）', es.aumid);
    const setAt = codeOnly.indexOf('app.setAppUserModelId');
    const readyAt = codeOnly.indexOf('app.whenReady()');
    t.ok(setAt > 0 && readyAt > 0 && setAt < readyAt, '源码顺序上 setAppUserModelId 在 whenReady 之前', { setAt, readyAt });
  }

  // ── ⑥ 通知统一出口 + 取证日志 ──────────────────────────────────────────────
  t.section('⑥ 通知统一出口：气泡发出即留证');
  {
    const rawCalls = (codeOnly.match(/tray\.displayBalloon\s*\(/g) || []).length;
    t.ok(rawCalls === 1, 'main.js 里只有 notifyUser 内部一处 displayBalloon（三处调用点已收口）', rawCalls);
    t.ok((codeOnly.match(/notifyUser\s*\(/g) || []).length >= 4, '启动失败/后端更新/外壳更新都走 notifyUser',
      (codeOnly.match(/notifyUser\s*\(/g) || []).length);
    t.ok(/通知通道自检（H-08）/.test(codeOnly), '启动期有通知通道自检日志（托盘/AUMID/Notification 能力一次写清）', false);

    const { mod, es } = boot({ balloonShow: true });
    mod.createTray();
    await mod.notifyUser('DSH 有可用更新', 'dsh → 1.2.3', { iconType: 'info' });
    const trayStub = es.trays[0];
    t.ok(trayStub.balloons.length === 1, '气泡确实发给了托盘（保留原有通道）', trayStub.balloons.length);
    t.ok(trayStub.balloons[0].title === 'DSH 有可用更新', '标题原样透传', trayStub.balloons[0].title);
    await waitFlush(600);
    const text = logText();
    t.ok(/托盘气泡已发出/.test(text), '诊断日志记录了"气泡已发出"', false);
    t.ok(/"aumid":"com\.deepseek\.dshdesktop"/.test(text), '日志里的 AUMID 是具体值（不再是 null）', false);
    t.ok(/silentDropRisk/.test(text), '日志里带上了"被系统静默丢弃"的风险判定', false);
  }

  // ── ⑦ 观察到 balloon-show：确认显示，不补发 ────────────────────────────────
  t.section('⑦ 收到 balloon-show：认定已显示，不重复打扰');
  {
    const { mod, es } = boot({ balloonShow: true });
    mod.createTray();
    await mod.notifyUser('DSH Desktop 启动失败', '右键托盘图标可查看日志。', { iconType: 'error' });
    await waitFlush(2200);
    t.ok(/托盘气泡已由系统确认显示/.test(logText()), '日志记录了"系统确认显示"（可观测的成功证据）', false);
    t.ok(es.notifications.length === 0, '已确认显示时不再补发 Notification（不重复打扰）', es.notifications.length);
  }

  // ── ⑧ 等不到 balloon-show：记录疑似被吞 + 替代通道 ─────────────────────────
  t.section('⑧ 等不到 balloon-show：如实记录 + 改走可验证通道');
  {
    const { mod, es } = boot({ balloonShow: false, notificationSupported: true });
    mod.createTray();
    await mod.notifyUser('DSH 有可用更新', 'dsh → 1.2.3', { iconType: 'info' });
    t.ok(es.notifications.length === 0, '1.5s 观察窗内不抢跑（先等确认）', es.notifications.length);
    await waitFlush(2200);
    const text = logText();
    t.ok(/未收到 balloon-show 确认/.test(text), '日志如实记录"未收到显示确认（疑似被系统丢弃）"', false);
    t.ok(es.notifications.length === 1, '改用 Notification 通道补发一次（同语义、无二次确认）', es.notifications.length);
    t.ok(es.notifications[0].shown === true, 'Notification 确实调用了 show()', es.notifications[0] && es.notifications[0].shown);
    t.ok(/已改用 Notification 通道发送通知/.test(text), '替代通道的使用被写进日志（不许静默换通道）', false);
    t.ok(es.trays.length === 1 && !es.trays[0].destroyed, '托盘入口保留（没有被通知改造拆掉）', es.trays[0] && es.trays[0].destroyed);
  }

  // ── ⑨ 通道不可用时不假装发过 ───────────────────────────────────────────────
  t.section('⑨ 通道不可用时不假装发过');
  {
    const throwing = boot({ balloonThrows: true, notificationSupported: true });
    throwing.mod.createTray();
    await throwing.mod.notifyUser('测试', '气泡抛错场景');
    t.ok(throwing.es.notifications.length === 1, '抛错时立刻补发 Notification', throwing.es.notifications.length);
    await waitFlush(600);
    t.ok(/托盘气泡发送抛错/.test(logText()), '气泡抛错时记录"通道不可用"（不是静默失败）', false);
  }
  {
    const noTray = boot({ notificationSupported: true });
    await noTray.mod.notifyUser('测试', '没有托盘场景');
    t.ok(noTray.es.notifications.length === 1, '没有托盘时直接走替代通道', noTray.es.notifications.length);
    await waitFlush(600);
    t.ok(/托盘气泡未发出（托盘不存在）/.test(logText()), '日志说明"没有托盘"，而不是假装发过', false);
  }
  {
    const unsupported = boot({ notificationSupported: false });
    const sent = unsupported.mod.deliverFallbackNotification('测试', '不支持 Notification', 'unit');
    t.ok(sent === false, 'Notification 不可用时返回 false（调用方能知道没发出去）', sent);
    t.ok(unsupported.mod.notificationSupported() === false, 'notificationSupported() 如实反映能力', unsupported.mod.notificationSupported());
    await waitFlush(600);
    t.ok(/替代通知通道不可用/.test(logText()), '不可用的事实被写进日志', false);
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
