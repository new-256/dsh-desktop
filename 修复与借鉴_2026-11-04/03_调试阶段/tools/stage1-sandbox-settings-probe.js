'use strict';

/**
 * stage1-sandbox-settings-probe —— 在 **sandbox:true** 下加载**成品 asar 里的**设置窗，验证桥是否还能用。
 *
 * 为什么必须单独做这件事：
 *   设置窗的唯一入口是托盘菜单「设置…」（`Menu.setApplicationMenu(null)` 已把应用菜单移除），
 *   而本机 Win11 托盘溢出区是 no-activate 浮层，合成输入打不开 Electron 托盘菜单
 *   （详细证据见 `03_调试阶段/真机验收_阶段一.md`）。于是"点开设置窗"这条路在自动化里是断的。
 *   但 sandbox:true 恰恰是**最可能在打包后失效**的一类改动（阶段一已吃过 dev 通过、打包失效的亏），
 *   所以不能因为"点不开"就不验。
 *
 * 做法：用工程自带的 electron 二进制，直接开一个与 main.js 同参数的 BrowserWindow
 *   （sandbox:true / contextIsolation:true / nodeIntegration:false），
 *   preload 与页面都**从成品 app.asar 里加载**（Electron 对 asar 透明），
 *   然后在页面里做真实读写往返：`window.dshSettings.get()` → `setRoute()` → 再 `get()` 核对。
 *
 * 诚实边界：本探针验证的是「设置窗页面 + 桥 + 主进程 IPC 往返」在 sandbox 下可用，
 *   **不是**主进程真实业务处理器（那些需要真实应用环境）。探针把这一点写进结论输出，
 *   避免被误读成"设置窗全功能已在成品里通过"。
 *
 * 用法：
 *   node_modules\electron\dist\electron.exe stage1-sandbox-settings-probe.js --asar=<app.asar 绝对路径>
 *   退出码：0=全通过；1=有断言失败；2=用法错误。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

function argOf(name) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
}

const ASAR = argOf('asar');
if (!ASAR || !fs.existsSync(ASAR)) {
  console.error('用法：electron stage1-sandbox-settings-probe.js --asar=<app.asar>');
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const consoleMsgs = [];
// 主进程侧的最小 IPC 桩：只为让"桥 → IPC → 主进程 → 回传"这条链有真实往返；
// 业务逻辑不在这里（见文件头「诚实边界」）。
// 版本号注入：真实设置窗里这些值由 main.js 的 settingsSnapshot()（app.getVersion()/currentVersions()）
// 提供；探针是独立加载 settings.html + 桩桥，本来拿不到，会显示"未知"——那不证明产品有问题，
// 只证明探针环境没有 IPC。为了不让截图停留在一屏"未知"，这里注入**本版真实版本号**，
// 用来验证"真实内容下的版式"；真实 IPC 另有静态接线核对（见验收文档）。
const injectedAppVersion = argOf('app-version') || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0-unknown'; }
})();
const store = {
  mock: true,
  settings: { npmRegistry: 'official', nodeDist: 'official' },
  versions: { shell: injectedAppVersion, dsh: '0.2.1-alpha.5', node: '24.4.0' },
  shellVersion: injectedAppVersion,
  shellUpdateVersion: null,
  updateStatus: { latest: null },
  registry: null,
  nodeDist: null,
  autoStart: false,
  safeMode: false
};

function registerStubs() {
  // 从成品 preload 里读出白名单，逐条注册通用桩 —— 避免因缺 handler 让页面噪点淹没真信号。
  let channels = [];
  try {
    const src = fs.readFileSync(path.join(ASAR, 'settings-preload.js'), 'utf8');
    const block = /ALLOWED_CHANNELS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
    if (block) channels = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  } catch (err) {
    console.log('[warn] 读取成品 preload 白名单失败：' + err.message);
  }
  for (const ch of channels) {
    try { ipcMain.handle(ch, () => ({ ok: true, stub: true, channel: ch })); } catch { /* 已注册 */ }
  }
  // 覆盖两条用于读写往返的通道为"有状态"桩
  try { ipcMain.removeHandler('settings:get'); } catch { /* 未注册 */ }
  ipcMain.handle('settings:get', () => store);
  try { ipcMain.removeHandler('settings:set-route'); } catch { /* 未注册 */ }
  ipcMain.handle('settings:set-route', (_e, route) => { store.route = route; return { ok: true, route }; });
  return channels.length;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  sandbox:true 下的设置窗探针（成品 asar + 真 Electron）');
  console.log('  asar      : ' + ASAR);
  console.log('  electron  : ' + process.versions.electron);
  console.log('══════════════════════════════════════════════════════════════════');

  const chCount = registerStubs();
  console.log(`[info] 已为 ${chCount} 条白名单通道注册桩 handler`);

  const win = new BrowserWindow({
    show: false,
    // 尺寸可调：窄窗口复验（900px）用来证明标签列不换行、不横向滚动。
    width: Number(argOf('width')) || 1080,
    height: Number(argOf('height')) || 800,
    webPreferences: {
      sandbox: true,                 // ← 与 0.3.49 的 main.js 目标一致
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(ASAR, 'settings-preload.js')
    }
  });

  win.webContents.on('console-message', (_e, level, message) => {
    consoleMsgs.push({ level, message: String(message || '') });
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    consoleMsgs.push({ level: 3, message: 'preload-error: ' + preloadPath + ' :: ' + (error && error.message) });
  });

  const timeout = setTimeout(() => {
    console.log('[FAIL] 探针超时（60s）：页面未完成加载');
    app.exit(1);
  }, 60000);

  try {
    await win.loadFile(path.join(ASAR, 'settings.html'));
    check('设置窗在 sandbox:true 下可加载（did-finish-load）', true);
    // 等渲染脚本跑完首屏
    await new Promise((r) => setTimeout(r, 1500));

    const probe = await win.webContents.executeJavaScript(`(async () => {
      const out = {};
      out.hasRequire = typeof require;
      out.hasProcess = typeof process;
      out.hasModule = typeof module;
      out.hasBridge = typeof window.dshSettings;
      out.bridgeKeys = window.dshSettings ? Object.keys(window.dshSettings).sort() : [];
      out.domNodes = document.querySelectorAll('*').length;
      out.title = document.title;
      try {
        out.getBefore = await window.dshSettings.get();
      } catch (e) { out.getError = String(e && e.message || e); }
      try {
        out.setResult = await window.dshSettings.setRoute('mirror');
      } catch (e) { out.setError = String(e && e.message || e); }
      try {
        out.getAfter = await window.dshSettings.get();
      } catch (e) { out.getAfterError = String(e && e.message || e); }
      return out;
    })()`);

    console.log('[info] 渲染侧探针输出: ' + JSON.stringify(probe));

    check('页面无 Node 全局（require 不可见）', probe.hasRequire === 'undefined', 'typeof require=' + probe.hasRequire);
    check('页面无 Node 全局（process 不可见）', probe.hasProcess === 'undefined', 'typeof process=' + probe.hasProcess);
    check('桥 window.dshSettings 存在', probe.hasBridge === 'object', 'typeof window.dshSettings=' + probe.hasBridge);
    check('桥方法数量 > 20', Array.isArray(probe.bridgeKeys) && probe.bridgeKeys.length > 20, '实际 ' + (probe.bridgeKeys || []).length + ' 个');
    check('DOM 已渲染（节点数 > 100）', probe.domNodes > 100, '实际 ' + probe.domNodes);
    check('读：settings:get 往返成功', !!probe.getBefore && !probe.getError, '实际 ' + JSON.stringify(probe.getBefore || probe.getError));
    check('写：settings:set-route 往返成功', !!probe.setResult && !probe.setError, '实际 ' + JSON.stringify(probe.setResult || probe.setError));
    check('写后再读：值已变更（真持久化往返）',
      !!probe.getAfter && probe.getAfter.route === 'mirror',
      '实际 route=' + (probe.getAfter && probe.getAfter.route) + (probe.getAfterError ? ' err=' + probe.getAfterError : ''));

    const bad = consoleMsgs.filter((m) => /Unable to load preload|preload-error|sandbox|not allowed|Failed to load|ReferenceError/i.test(m.message));
    check('无 preload/sandbox 相关报错', bad.length === 0, bad.length ? JSON.stringify(bad).slice(0, 400) : '控制台干净');
  } catch (err) {
    check('探针执行未抛异常', false, err && err.message);
  } finally {
    clearTimeout(timeout);
  }

  // ── 视觉验收截图（设置窗）──────────────────────────────────────────────────
  // 为什么用 webContents.capturePage() 而不是截桌面：capturePage 抓的是**这个窗口自己的
  // 页面内容**，物理上不可能抓到别的程序。本仓库曾被"全桌面截屏"坑过一次（抓到了游戏窗口），
  // 所以这里只允许 target 级手段，且必须落同名 .json 元数据供人复核。
  const shotPath = argOf('shot');
  let shotInfo = null;
  if (shotPath) {
    try {
      const img = await win.webContents.capturePage();
      const buf = img.toPNG();
      const size = img.getSize();
      const metaPath = shotPath.replace(/\.png$/i, '') + '.json';
      fs.mkdirSync(path.dirname(path.resolve(shotPath)), { recursive: true });
      fs.writeFileSync(path.resolve(shotPath), buf);
      const domStats = await win.webContents.executeJavaScript(`(() => {
        const q = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
        return JSON.stringify({
          title: document.title,
          nodes: document.querySelectorAll('*').length,
          inputs: q('input'), selects: q('select'), buttons: q('button'),
          bodyTextLen: ((document.body && document.body.innerText) || '').trim().length,
          bodyTextHead: ((document.body && document.body.innerText) || '').trim().slice(0, 160),
          errorish: (((document.body && document.body.innerText) || '').match(/Failed to fetch|Cannot read propert|Uncaught|TypeError/gi) || []).slice(0, 5)
        });
      })()`);
      const dom = JSON.parse(domStats);
      const anchors = ['更新', '节点', '插件', '设置'].filter((k) => (dom.bodyTextHead || '').includes(k));
      const meta = {
        capturedAt: new Date().toISOString(),
        captureMethod: 'electron-webContents-capturePage',
        windowTitle: win.getTitle(),
        targetUrl: win.webContents.getURL(),
        viewport: { width: size.width, height: size.height },
        assertions: {
          titleOk: /设置/.test(win.getTitle()),
          domNodes: dom.nodes,
          nodesOk: dom.nodes > 100,
          interactivePresent: dom.inputs + dom.selects + dom.buttons > 0,
          anchorsHit: anchors,
          anchorsOk: anchors.length >= 2,
          errorishEmpty: (dom.errorish || []).length === 0
        },
        domProbe: { inputs: dom.inputs, selects: dom.selects, buttons: dom.buttons, bodyTextLen: dom.bodyTextLen, bodyTextHead: dom.bodyTextHead },
        bytes: buf.length,
        note: '本图由 Electron webContents.capturePage() 采集（窗口自身页面），不可能是其它程序；无本 .json 的截图不得作为验收证据。'
      };
      fs.writeFileSync(path.resolve(metaPath), JSON.stringify(meta, null, 2) + '\n');
      shotInfo = { path: path.resolve(shotPath), metaPath: path.resolve(metaPath), bytes: buf.length, size };
      check('设置窗截图已落盘（capturePage，target 级）', buf.length > 10240 && /设置/.test(win.getTitle()), `${shotPath}（${buf.length} 字节，${size.width}×${size.height}）`);
      check('设置窗截图断言：标题/节点/可交互/锚点/无报错',
        meta.assertions.titleOk && meta.assertions.nodesOk && meta.assertions.interactivePresent && meta.assertions.anchorsOk && meta.assertions.errorishEmpty,
        JSON.stringify(meta.assertions));
    } catch (err) {
      check('设置窗截图已落盘（capturePage，target 级）', false, err && err.message);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  结论：${failed.length ? `✖ ${failed.length} 项失败` : '✔ 全部通过'}（共 ${results.length} 项断言）`);
  console.log('  边界：本探针验证「设置窗页面 + preload 桥 + IPC 往返」在 sandbox:true 下可用；');
  console.log('        主进程真实业务处理器未在此覆盖（需真实应用环境，且设置窗在本机无自动入口）。');
  if (consoleMsgs.length) {
    console.log('  控制台消息（前 8 条）：');
    for (const m of consoleMsgs.slice(0, 8)) console.log(`    · [${m.level}] ${m.message.slice(0, 200)}`);
  }
  console.log('══════════════════════════════════════════════════════════════════');
  app.exit(failed.length ? 1 : 0);
}).catch((err) => {
  console.error('探针启动失败：' + (err && err.stack || err));
  app.exit(2);
});
