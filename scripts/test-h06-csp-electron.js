'use strict';

/**
 * H-06 真机验收（Electron）：CSP 收紧后设置窗仍可用，且注入面确实失效。
 *
 * 为什么必须跑真机：`file://` 页面下 `script-src 'self'` 到底放不放行同目录脚本，
 * 以及 CSP 是否真的拦得住内联脚本，静态断言证明不了。本脚本用与 main.js 相同的
 * webPreferences（preload=settings-preload.js、contextIsolation=true、sandbox=false）
 * 打开 settings.html，然后：
 *   ① 断言外提脚本执行了（documentElement.dataset.rendererLoaded === '1'）；
 *   ② 阳性对照：运行时注入内联 <script> 必须被 CSP 拦掉、eval 必须被拦；
 *   ③ 把 XSS payload 塞进每个外部字符串（插件名 / reason / home / 版本号），
 *      触发「分析兼容性」「扫描旧 Home」，断言 DOM 里没有 img/script/svg 元素、
 *      window.__xss 未被置位、payload 只以纯文本出现；
 *   ④ 选择器注入：npmRegistry/nodeDist 传构造串，renderState 不得抛异常。
 *
 * 用法：node_modules\electron\dist\electron.exe scripts/test-h06-csp-electron.js
 * 超时：默认 120s（DSH_TEST_TIMEOUT_MS 可调）。
 */

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const TIMEOUT_MS = parseInt(process.env.DSH_TEST_TIMEOUT_MS || '120000', 10) || 120000;
const watchdog = setTimeout(() => {
  process.stderr.write(`[test-h06-electron] 超时 ${TIMEOUT_MS}ms，强制退出\n`);
  process.exit(3);
}, TIMEOUT_MS);
watchdog.unref();

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'settings.html');
const PRELOAD = path.join(ROOT, 'settings-preload.js');

const img = (tag) => `<img src=x onerror="window.__xss='${tag}'">`;
const inlineScript = (tag) => `<script>window.__xss='${tag}'<\/script>`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 主进程侧 stub：返回带 payload 的业务数据 ────────────────────────────────
const COMPAT_PLAN = {
  target: '0.1.9',
  current: img('compat-current'),
  summary: { total: 2, incompatible: 1, unverified: 0, compatible: 1 },
  targetEngines: { current: '24.21.0', required: '>=20', ok: true },
  rows: [
    {
      name: img('row-name'),
      reason: inlineScript('row-reason'),
      compatible: false,
      nodeEngine: '<svg onload="window.__xss=\'row-engine\'">',
      installed: { version: '<b>9.9</b>', installedAt: '2026-01-02T00:00:00.000Z' }
    },
    { name: '正常插件', reason: '正常原因', compatible: true, nodeEngine: null, installed: null }
  ]
};

const LEGACY_SCAN = {
  ok: true,
  scan: {
    sameAsDesktop: false,
    exists: true,
    total: 1,
    home: img('legacy-home'),
    orphans: [{ name: img('legacy-name'), version: '<b>1.0</b>', installable: true }]
  }
};

const STUBS = {
  'settings:get': () => ({
    shellVersion: img('shell'),
    shellUpdateVersion: '0.3.48',
    versions: { dsh: img('dsh'), node: '24.21.0' },
    updateStatus: { latest: inlineScript('latest'), message: '<b onmouseover="window.__xss=\'msg\'">x</b>' },
    registry: { label: img('label'), url: 'https://registry.npmmirror.com' },
    nodeDist: { label: img('ndist'), url: 'https://npmmirror.com/mirrors/node' },
    settings: { npmRegistry: 'mirror', nodeDist: 'official' },
    autoStart: false,
    safeMode: false
  }),
  'settings:set-route': () => ({ label: img('route') }),
  'settings:check-updates': () => ({ status: { message: img('status') }, info: { updates: [{ component: img('component'), current: '1', latest: '2' }] } }),
  'settings:download-updates': () => ({ ok: true }),
  'settings:set-autostart': () => true,
  'settings:set-node-dist': () => ({ label: img('ndist-label') }),
  'settings:check-node': () => ({ latest: img('node-latest'), staged: '24.21.0', current: '24.21.0', required: '>=20', pinnedMajor: 24, available: ['24.21.0', '24.20.0'] }),
  'settings:download-node': () => ({ ok: true }),
  'settings:open-log': () => 'ok',
  'settings:restart-app': () => 'ok',
  'settings:open': () => 'ok',
  'backend:list-versions': () => ({ all: ['0.1.9', '0.1.8'], current: '0.1.8', latest: '0.1.9', staged: null }),
  'backend:compat-plan': () => ({ plan: COMPAT_PLAN, file: null }),
  'backend:rollback-to': () => ({ ok: true }),
  'plugins:terminal-status': () => ({
    home: img('home'),
    env: { pointsHere: false, set: true, current: img('env-current'), legacyHome: img('legacy-home-env'), legacyInUse: true },
    path: { inPath: false, exists: true, dir: img('path-dir') },
    cmdWrapper: img('cmd-wrapper'),
    cmdPwsh: inlineScript('cmd-pwsh')
  }),
  'plugins:set-dsh-home-env': () => ({ ok: true }),
  'plugins:set-path-entry': () => ({ ok: true }),
  'plugins:write-wrappers': () => ({ ok: true }),
  'plugins:install': () => ({ ok: true }),
  'plugins:scan-legacy': () => LEGACY_SCAN,
  'plugins:import-legacy': () => ({ ok: true, summary: { ok: 1, failed: 0, skipped: 0, results: [{ name: img('import-name'), ok: true, skipped: false, reason: inlineScript('import-reason') }] } }),
  'shell:copy-text': () => 'ok'
};

for (const [channel, listener] of Object.entries(STUBS)) {
  ipcMain.handle(channel, () => listener());
}

const consoleErrors = [];

async function run() {
  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on('console-message', (...args) => {
    const msg = typeof args[2] === 'string' ? args[2] : (args[0] && args[0].message) || '';
    if (/Content Security Policy|Refused to|unsafe-eval|not allowed/i.test(msg)) consoleErrors.push(msg);
  });

  await win.loadFile(HTML);
  await sleep(700);

  const loaded = await win.webContents.executeJavaScript(`(() => {
    const r = {};
    r.rendererLoaded = document.documentElement.dataset.rendererLoaded || null;
    r.hasBridge = !!window.dshSettings && typeof window.dshSettings.get === 'function';
    r.styleApplied = getComputedStyle(document.body).backgroundColor;
    // 阳性对照①：运行时注入的内联 <script> 必须被 CSP 拦掉
    window.__inlineRan = false;
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = true;';
    document.body.appendChild(s);
    r.inlineRan = window.__inlineRan;
    // 阳性对照②：eval 必须被 CSP 拦掉（无 unsafe-eval）
    try { window.eval('window.__evalRan = 1'); r.evalRan = !!window.__evalRan; r.evalErr = null; }
    catch (e) { r.evalErr = String(e).slice(0, 80); }
    return r;
  })()`);

  check('真机：外提脚本在 file:// + script-src self 下执行', loaded.rendererLoaded === '1', '实际：' + loaded.rendererLoaded);
  check('真机：preload 桥可用', loaded.hasBridge === true, '实际：' + loaded.hasBridge);
  check('真机：style 仍生效（style-src 允许内联样式块）', loaded.styleApplied === 'rgb(11, 16, 32)', '实际：' + loaded.styleApplied);
  check('CSP 阳性对照：内联 <script> 被拦截', loaded.inlineRan === false, '实际 inlineRan=' + loaded.inlineRan);
  check('CSP 阳性对照：eval 被拦截', !!loaded.evalErr && loaded.evalRan !== true, '实际：' + loaded.evalErr);

  // 首屏渲染（settings:get 里塞了 payload）
  const shell = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('vShell');
    return { imgs: document.querySelectorAll('#vShell img').length, text: box.textContent };
  })()`);
  check('首屏：payload 只以文本出现（无 img 元素）', shell.imgs === 0 && shell.text.includes('<img'), '实际：' + JSON.stringify(shell));

  // 兼容性表（插件名 / reason / nodeEngine / installed.version 全是 payload）
  await win.webContents.executeJavaScript(`(() => {
    const sel = document.getElementById('bVersions');
    sel.value = '0.1.9';
    document.getElementById('btnBCompat').click();
    return true;
  })()`);
  await sleep(500);
  const compat = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('compatBox');
    return {
      imgs: box.querySelectorAll('img').length,
      scripts: box.querySelectorAll('script').length,
      svgs: box.querySelectorAll('svg').length,
      rows: box.querySelectorAll('tr').length,
      xss: window.__xss === undefined ? null : String(window.__xss),
      text: box.textContent
    };
  })()`);
  check('兼容表：无 img/script/svg 元素注入', compat.imgs === 0 && compat.scripts === 0 && compat.svgs === 0, '实际：' + JSON.stringify({ imgs: compat.imgs, scripts: compat.scripts, svgs: compat.svgs }));
  check('兼容表：window.__xss 未被置位', compat.xss === null, '实际：' + compat.xss);
  check('兼容表：payload 以纯文本呈现', compat.text.includes('<img') && compat.text.includes('<script>'), '实际文本片段：' + compat.text.slice(0, 160));
  check('兼容表：表格行数与数据一致（表头 + 2 行）', compat.rows === 3, '实际：' + compat.rows);

  // 旧 Home 扫描表（home / name / version 是 payload）
  await win.webContents.executeJavaScript(`(() => { document.getElementById('btnScanLegacy').click(); return true; })()`);
  await sleep(500);
  const legacy = await win.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('legacyBox');
    const cb = box.querySelector('input.lgk');
    return {
      imgs: box.querySelectorAll('img').length,
      scripts: box.querySelectorAll('script').length,
      svgs: box.querySelectorAll('svg').length,
      checkbox: cb ? { checked: cb.checked, disabled: cb.disabled, index: cb.dataset.i } : null,
      xss: window.__xss === undefined ? null : String(window.__xss),
      text: box.textContent
    };
  })()`);
  check('旧 Home 表：无 img/script/svg 元素注入', legacy.imgs === 0 && legacy.scripts === 0 && legacy.svgs === 0, '实际：' + JSON.stringify({ imgs: legacy.imgs, scripts: legacy.scripts, svgs: legacy.svgs }));
  check('旧 Home 表：window.__xss 未被置位', legacy.xss === null, '实际：' + legacy.xss);
  check('旧 Home 表：payload 以纯文本呈现', legacy.text.includes('<img'), '实际文本片段：' + legacy.text.slice(0, 160));
  check('旧 Home 表：勾选框按 installable 生成（data-i 索引正确）', !!legacy.checkbox && legacy.checkbox.checked === true && legacy.checkbox.index === '0', '实际：' + JSON.stringify(legacy.checkbox));

  // 选择器注入：外部值不得拼进 querySelector
  const selectorInject = await win.webContents.executeJavaScript(`(() => {
    const ids = ['r-mirror', 'r-official', 'nd-mirror', 'nd-official'];
    const uncheckAll = () => ids.forEach((id) => { document.getElementById(id).checked = false; });
    uncheckAll();
    try {
      window.renderState({ settings: { npmRegistry: 'mirror"] , body *:not(x)', nodeDist: 'official"]' }, versions: {}, updateStatus: {} });
    } catch (e) { return { ok: false, err: String(e).slice(0, 120) }; }
    const afterBogus = { routeMirror: document.getElementById('r-mirror').checked, ndistOfficial: document.getElementById('nd-official').checked };
    // 正向对照：合法值必须照常选中（证明白名单查表没把正常路径也挡掉）
    window.renderState({ settings: { npmRegistry: 'official', nodeDist: 'mirror' }, versions: {}, updateStatus: {} });
    const afterValid = { routeOfficial: document.getElementById('r-official').checked, ndistMirror: document.getElementById('nd-mirror').checked };
    return { ok: true, afterBogus, afterValid };
  })()`);
  check('选择器注入：伪造 registry 值不抛异常且不选中任何单选',
    selectorInject.ok === true && selectorInject.afterBogus.routeMirror === false && selectorInject.afterBogus.ndistOfficial === false,
    '实际：' + JSON.stringify(selectorInject));
  check('选择器注入正向对照：合法值仍正常选中',
    selectorInject.ok === true && selectorInject.afterValid.routeOfficial === true && selectorInject.afterValid.ndistMirror === true,
    '实际：' + JSON.stringify(selectorInject.afterValid));

  check('CSP 违规控制台输出（应只来自本测试的阳性对照）', consoleErrors.length <= 4, '捕获 ' + consoleErrors.length + ' 条：' + JSON.stringify(consoleErrors.slice(0, 6)));

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n[test-h06-electron] 共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}\n`);
  for (const f of failed) process.stdout.write(`  FAIL ${f.name} — ${f.detail}\n`);
  return failed.length === 0 ? 0 : 1;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    process.stderr.write('[test-h06-electron] 未捕获异常：' + ((err && err.stack) || err) + '\n');
    code = 1;
  }
  clearTimeout(watchdog);
  app.exit(code);
}).catch((err) => {
  process.stderr.write('[test-h06-electron] whenReady 失败：' + ((err && err.stack) || err) + '\n');
  app.exit(1);
});
