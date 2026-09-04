'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, Tray, nativeImage } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const mgr = require('./updater-backend');
const diag = require('./diag-log').write;

// 任何主进程异常都先落到桌面日志，再向用户展示 —— 不再出现"无声崩溃"。
process.on('uncaughtException', (err) => {
  try { diag('未捕获异常:', err); } catch {}
  try {
    dialog.showErrorBox('DSH Desktop 主进程异常',
      ((err && (err.stack || err.message)) || String(err)) +
      '\n\n详情已写入桌面日志：DSH-Desktop-日志.txt');
  } catch {}
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { diag('未处理的 Promise 拒绝:', reason); } catch {}
});

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); }
catch (err) { console.warn('[dsh-desktop] electron-updater unavailable:', err && err.message); }

const APP_NAME = 'DSH Desktop';
const isPackaged = app.isPackaged;
// Auto-started at login (the tray toggle writes `--hidden` to the Windows Run
// key): boot fully but stay hidden in the tray — keep-alive by default.
const autoStartHidden = process.argv.includes('--hidden');

// Chromium renderer reliability/perf flags (Electron ships Chromium; we use it as
// the always-available window). A system WebView2 runtime is detected separately
// for diagnostics, but is not required.
try {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.disableHardwareAcceleration && process.env.DSH_SW_RASTER ? app.disableHardwareAcceleration() : null;
} catch {}

// Detect the system Edge WebView2 runtime (informational; Windows 11 ships it).
function detectWebView2() {
  try {
    const roots = [
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env.ProgramFiles || 'C:\\Program Files'
    ].map((r) => path.join(r, 'Microsoft', 'EdgeWebView', 'Application'));
    for (const r of roots) {
      if (fs.existsSync(r)) {
        const ver = fs.readdirSync(r).find((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
        if (ver) return { present: true, version: ver };
      }
    }
  } catch {}
  return { present: false, version: null };
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
let backend = null;
let backendLogs = [];
let mainWindow = null;
let splashWindow = null;
let activeUrl = null;
let isQuitting = false;
let tray = null;
let trayHintShown = false;
let crashNotified = false;

function pushLog(line) {
  const text = line == null ? '' : line.toString();
  backendLogs.push(text);
  if (backendLogs.length > 300) backendLogs.shift();
  process.stdout.write(`[dsh-backend] ${text}`);
  diag('后端输出', text);
}

function waitForServer(url, timeoutMs, cb) {
  const deadline = Date.now() + timeoutMs;
  const attempt = () => {
    const req = http.get(url, (res) => { res.destroy(); cb(true); });
    req.on('error', () => { if (Date.now() > deadline) return cb(false); setTimeout(attempt, 400); });
    req.setTimeout(2000, () => req.destroy());
  };
  attempt();
}

function killProcessTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; } catch {}
  }
  try { proc.kill(); } catch {}
}

/** Controlled stop: detach listeners first so a deliberate kill is never misread as a crash. */
function stopBackend() {
  if (!backend) return;
  const proc = backend;
  backend = null;
  try { proc.removeAllListeners('exit'); } catch {}
  killProcessTree(proc);
}

function activePaths() { return mgr.P(); }

/**
 * Spawn the bundled backend from the active user-writable dir, with an isolated
 * DSH_HOME so it never collides with the user's CLI `~/.dsh` (and its symlink
 * state is fully owned by this app). Returns a promise resolving to the URL.
 */
function updateSplash(message) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const text = String(message || '正在启动 DeepSeek Harness 后端…').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
  splashWindow.webContents.executeJavaScript(`(() => { const el = document.querySelector('.sub'); if (el) el.textContent = '${text}'; })()`).catch(() => {});
}

function spawnBackend() {
  return new Promise((resolve, reject) => {
    const p = activePaths();
    if (!fs.existsSync(p.nodeExe)) return reject(new Error('缺少 Node 运行时：未找到活跃 node.exe（seed 失败）。'));
    if (!fs.existsSync(p.dshBin)) return reject(new Error('缺少 DSH 后端：未找到活跃 dsh（seed 失败）。'));

    // Dedicated, fully-isolated environment: node prefix first on PATH,
    // isolated npm/pnpm/corepack homes, isolated DSH_HOME. Never inherits user's
    // global node/npm environment -> "dsh 专用 node 环境".
    const env = mgr.buildDedicatedEnv();
    env.DSH_HOME = p.dshHome;
    delete env.ELECTRON_RUN_AS_NODE; // we spawn a real standalone node

    const args = [p.dshBin, 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'];

    const child = spawn(p.nodeExe, args, {
      cwd: path.dirname(p.dshBin), env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    backend = child;
    pushLog(`starting backend: node=${p.nodeExe} DSH_HOME=${p.dshHome}\n`);

    let settled = false;
    const onUrl = (line) => {
      const m = /dsh web:\s*(https?:\/\/[^\s]+)/i.exec(line);
      if (!m) return;
      const url = m[1].trim();
      if (settled) return;
      settled = true;
      waitForServer(url, 60000, (ok) => {
        if (ok) { activeUrl = url; resolve(url); }
        else reject(new Error('后端已打印地址但未能在超时内响应 HTTP。'));
      });
    };
    child.stdout.on('data', (d) => { const t = d.toString(); pushLog(d); t.split(/\r?\n/).forEach(onUrl); });
    child.stderr.on('data', (d) => { pushLog(d); });
    child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`后端进程提前退出（code=${code} signal=${signal}）。\n\n` +
          backendLogs.join('').split(/\r?\n/).slice(-30).join('\n')));
      } else {
        // Backend died after boot. A controlled stop clears `backend` before
        // killing, so only an exit of the CURRENT active instance is a crash.
        pushLog(`backend exited after boot code=${code} signal=${signal}\n`);
        if (!isQuitting && backend === child) handleBackendCrashed();
      }
    });
  });
}

/** Attempt to start the backend, self-healing common failure modes with escalations. */
async function startBackendWithHealing() {
  const p = activePaths();
  let firstErr;
  try {
    return await spawnBackend();
  } catch (err) {
    firstErr = err;
    pushLog('first backend start failed; attempting self-heal (junction repair + profile quarantine)\n');
  }

  // Escalation 1: quarantine the broken profiles dir (dsh rebuilds a fresh
  // tree on retry) and repair/rebuild custom plugin junctions, so bare-name
  // plugins injected by the home-level patch keep resolving after the wipe.
  const qRes = mgr.quarantineProfiles(p.dshHome);
  if (qRes && qRes.quarantined) {
    if (!qRes.fallback) {
      pushLog(`旧 profiles 已备份为 ${qRes.name}（未删除），dsh 将重建配置。\n`);
    } else {
      pushLog('旧 profiles 清理完成，dsh 将重建配置。\n');
    }
  }
  const fixed = mgr.repairProfileJunctions(p.dshHome);
  if (fixed > 0) pushLog(`自定义插件 junction 修复/重建：${fixed} 项。\n`);
  stopBackend();
  await new Promise((r) => setTimeout(r, 800));

  if ((qRes && qRes.quarantined) || fixed > 0) {
    try {
      pushLog('retrying backend after profile quarantine…\n');
      return await spawnBackend();
    } catch (retryErr) {
      pushLog('backend start failed after profile quarantine\n');
    }
  }

  // Escalation 2: a home-level patch plugin may reference a source that no
  // longer exists (deleted file, gone junction target). Back up the patch
  // file, disable just those entries, tell the user, and retry once — instead
  // of looping forever through quarantine + Node repair.
  let disabled = [];
  try {
    const analysis = mgr.analyzeBackendFailure(p.dshHome, backendLogs.join(''));
    if (analysis && analysis.broken && analysis.broken.length) {
      const res = mgr.disableBrokenPatchPlugins(p.dshHome, analysis.broken);
      disabled = (res && res.disabled) || [];
      if (disabled.length) {
        pushLog(`临时禁用无法加载的插件：${disabled.join(', ')}（原配置已备份：${res.backup}）。\n`);
        try {
          const r = await dialog.showMessageBox(null, {
            type: 'warning', buttons: ['继续启动', '退出'], defaultId: 0, cancelId: 1,
            title: APP_NAME,
            message: '已临时禁用无法加载的插件',
            detail: `以下插件因文件缺失或损坏已被临时禁用，应用将正常启动：\n\n` +
              disabled.join('\n') +
              `\n\n原配置已备份到：\n${res.backup}\n\n修复插件后，用备份文件恢复即可重新启用。`
          });
          if (r.response === 1) { isQuitting = true; app.exit(0); return; }
        } catch {}
      }
    }
  } catch (e) {
    pushLog('plugin disable analysis failed: ' + (e && e.message) + '\n');
  }
  stopBackend();
  await new Promise((r) => setTimeout(r, 800));

  if (disabled.length) {
    try {
      pushLog('retrying backend after disabling broken plugins…\n');
      return await spawnBackend();
    } catch (retryErr2) {
      pushLog('backend start failed after plugin disable\n');
    }
  }

  // Escalation 3: repair Node runtime if spawn still fails.
  pushLog('attempting Node runtime repair escalation…\n');
  const nodeChanged = await mgr.repairNodeForBackendFailure({
    onLog: (m) => pushLog('[node-repair] ' + m + '\n')
  });
  stopBackend();

  if (nodeChanged) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      pushLog('retrying backend after Node runtime repair…\n');
      return await spawnBackend();
    } catch (retryErr3) {
      pushLog('backend start failed after Node runtime repair\n');
    }
  }

  throw firstErr;
}

async function startBackendWithPluginIsolation(shouldIsolate = false) {
  if (!shouldIsolate) return startBackendWithHealing();
  const isolation = mgr.preparePluginIsolation();
  if (!isolation.active || !isolation.plugins.length) return startBackendWithHealing();
  pushLog('检测到后端更新，先隔离全部第三方插件进行核心启动检查。\n');
  updateSplash('正在验证核心后端（已临时隔离插件）…');
  let coreUrl;
  try {
    coreUrl = await startBackendWithHealing();
  } catch (error) {
    // Core itself cannot boot: restore the FULL original plugin set before
    // surfacing the error, so no half-applied isolation state is left behind.
    mgr.finishPluginIsolation(isolation.plugins.map((p) => ({ index: p.index, status: 'not-tested' })));
    throw error;
  }
  stopBackend();
  const statuses = [];
  let done = 0;
  for (const plugin of isolation.plugins) {
    done++;
    updateSplash(`正在逐个检查插件（${done}/${isolation.plugins.length}）：${(plugin.ids || [])[0] || '未知插件'}`);
    mgr.enablePluginIsolationBlock(plugin.index);
    backendLogs = [];
    try {
      await startBackendWithHealing();
      const pluginText = backendLogs.join('');
      const failed = plugin.ids.some((id) => new RegExp(`(?:failed|error|cannot|without registering).*${String(id).replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}`, 'i').test(pluginText));
      statuses.push({ index: plugin.index, status: failed ? 'failed' : 'ok' });
      if (failed) pushLog(`插件 ${plugin.ids.join(', ')} 启动检查失败，将保持禁用。\n`);
    } catch (error) {
      statuses.push({ index: plugin.index, status: 'failed', error: error.message });
      pushLog(`插件 ${plugin.ids.join(', ')} 启动失败，将保持禁用：${error.message}\n`);
    }
    stopBackend();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const report = mgr.finishPluginIsolation(statuses);
  backendLogs = [];
  updateSplash('正在以兼容插件集启动 DSH…');
  const url = await startBackendWithHealing();
  const failed = (report?.plugins || []).filter((p) => p.status === 'failed');
  if (failed.length) {
    const names = failed.flatMap((p) => p.ids || p.names || []).filter(Boolean);
    setTimeout(() => dialog.showMessageBox(mainWindow, {
      type: 'warning', title: APP_NAME, buttons: ['知道了'],
      message: '部分插件与当前后端不兼容',
      detail: `DSH 已正常启动，但以下插件已保持禁用：\n\n${names.join('\n')}\n\n插件源码和原配置已保留，可在修复插件后重新启用。`
    }).catch(() => {}), 800);
  }
  return url;
}

function handleBackendCrashed() {
  if (crashNotified) return; crashNotified = true;
  // The window may be hidden in the tray — surface it before the dialog.
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['重启应用', '关闭'], defaultId: 0, cancelId: 1,
    title: APP_NAME,
    message: '后端服务已停止',
    detail: 'DSH 后端意外退出。重启应用可恢复；你的会话与配置保存在独立数据目录中，不会丢失。'
  }).then((r) => {
    crashNotified = false;
    if (r.response === 0) restartApp(); else { isQuitting = true; app.quit(); }
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480, height: 320, frame: false, resizable: false, center: true, show: true,
    backgroundColor: '#0b1020', icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash() { if (splashWindow) { try { splashWindow.close(); } catch {} splashWindow = null; } }

// ---------------------------------------------------------------------------
// System tray / close-to-tray — DSH is a keep-alive app by default
// ---------------------------------------------------------------------------
function trayMenuTemplate() {
  let autoStartItem;
  if (isPackaged) {
    autoStartItem = {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        const next = !!item.checked;
        try {
          app.setLoginItemSettings({ openAtLogin: next, args: ['--hidden'] });
          pushLog(`auto-start ${next ? 'enabled' : 'disabled'}\n`);
        } catch (e) {
          pushLog(`auto-start toggle failed: ${e && e.message}\n`);
          item.checked = !next; // revert the checkbox
        }
      }
    };
  } else {
    autoStartItem = { label: '开机自启（仅安装版可用）', enabled: false };
  }
  return [
    ...updateMenuItems(),
    { type: 'separator' },
    { label: '打开 DSH Desktop', click: () => showMainWindow() },
    { type: 'separator' },
    autoStartItem,
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ];
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  // Show the real backend version immediately instead of "读取中" — the first
  // scheduled check only lands later, which made a just-applied update look
  // like "version did not change".
  try { updateStatus.current = mgr.currentVersions()?.dsh || updateStatus.current; } catch {}
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  } catch {
    icon = path.join(__dirname, 'assets', 'icon.png');
  }
  try {
    tray = new Tray(icon);
  } catch (e) {
    pushLog(`tray creation failed: ${e && e.message}\n`);
    return null;
  }
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  // Refresh the context menu on every right-click so the 开机自启 checkbox
  // always reflects the current login-item state.
  tray.on('right-click', () => { try { tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate())); } catch {} });
  return tray;
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  // Window was actually closed (should not happen while tray is alive); rebuild it.
  if (activeUrl) createMainWindow(activeUrl);
}

function quitApp() {
  isQuitting = true;
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  killProcessTree(backend);
  app.quit();
}

function applyWindowHandlers(win) {
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target) && !/127\.0\.0\.1|localhost/i.test(target)) {
      shell.openExternal(target); return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function createChromiumWindow(url) {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#0b1020', title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  Menu.setApplicationMenu(null);
  applyWindowHandlers(win);
  win.loadURL(url);
  win.once('ready-to-show', () => {
    if (autoStartHidden) { closeSplash(); return; } // auto-started at login: stay in tray
    win.show(); closeSplash();
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    pushLog(`chromium did-fail-load ${code} ${desc}\n`);
    if (code === -3) return; // aborted (normal on redirect)
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // Close button (X) hides to tray instead of quitting — DSH is keep-alive.
  win.on('close', (e) => {
    if (isQuitting || !tray) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      try {
        tray.displayBalloon({ iconType: 'info', title: APP_NAME, content: '已最小化到系统托盘，DSH 仍在后台运行。右键托盘图标可退出。' });
      } catch {}
    }
  });
  return win;
}

async function createMainWindow(url) {
  // The Chromium window is always available and has no native-build/ABI risk.
  // (System WebView2 presence is recorded for diagnostics/future use.)
  const wv2 = detectWebView2();
  pushLog(`renderer=Chromium (Electron); system WebView2 present=${wv2.present}${wv2.version ? ' v' + wv2.version : ''}\n`);
  mainWindow = createChromiumWindow(url);
}

function showFatal(err) {
  diag('启动失败（fatal）:', err);
  dialog.showErrorBox(`${APP_NAME} 启动失败`,
    (err && err.stack ? err.stack : String(err)) +
    '\n\n--- 后端日志（末尾）---\n' + backendLogs.join('').split(/\r?\n/).slice(-40).join('\n') +
    '\n\n--- 详细诊断日志已写入桌面：DSH-Desktop-日志.txt ---');
  app.quit();
}

function isRealFeedUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!host || host === 'example.com' || host === 'localhost' || host === '127.0.0.1') return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shell auto-update (electron-updater) — silent download, prompt on ready
// ---------------------------------------------------------------------------
function setupShellUpdater() {
  if (!autoUpdater || !isPackaged) return;
  let feedUrl = process.env.DSH_SHELL_UPDATE_URL;
  if (feedUrl) {
    if (isRealFeedUrl(feedUrl)) {
      try { autoUpdater.setFeedURL(feedUrl); } catch (e) { console.warn('[shell-updater]', e && e.message); }
    } else {
      feedUrl = null;
    }
  }
  if (!feedUrl) {
    try {
      const ymlPath = path.join(process.resourcesPath, 'app-update.yml');
      if (fs.existsSync(ymlPath)) {
        const content = fs.readFileSync(ymlPath, 'utf8');
        const m = /url:\s*(\S+)/i.exec(content);
        if (m && isRealFeedUrl(m[1])) feedUrl = m[1];
      }
    } catch {}
    if (!feedUrl && typeof autoUpdater.getFeedURL === 'function') {
      try {
        const u = autoUpdater.getFeedURL();
        if (isRealFeedUrl(u)) feedUrl = u;
      } catch {}
    }
  }
  if (!feedUrl) {
    pushLog('shell updater disabled (no release feed configured)\n');
    return;
  }

  try {
    // No silent shell updates either: only announce; download happens after the
    // user confirms in the tray-driven dialog (see stageConfirmedUpdates).
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (e) => console.warn('[shell-updater]', e && e.message));
    autoUpdater.on('update-available', (info) => {
      shellUpdateVersion = (info && info.version) || null;
      pushLog(`shell update available: ${shellUpdateVersion || 'unknown'}（等待用户确认）\n`);
      try {
        tray && tray.displayBalloon({
          iconType: 'info', title: 'DSH Desktop 有新版本',
          content: `桌面版 ${shellUpdateVersion || '新版本'} 可用。点击托盘菜单中的版本/更新项确认下载。`
        });
      } catch {}
    });
    autoUpdater.on('update-downloaded', async () => {
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'info', buttons: ['重启更新', '稍后'], defaultId: 0, cancelId: 1,
        title: APP_NAME, message: '新版本已就绪', detail: '重启后将应用最新版本。'
      });
      if (r.response === 0) { isQuitting = true; killProcessTree(backend); autoUpdater.quitAndInstall(); }
    });
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10000);
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 24 * 3600 * 1000);
  } catch (e) { console.warn('[shell-updater] setup failed:', e && e.message); }
}

// ---------------------------------------------------------------------------
// Silent backend/environment updates — stage in background; apply on next launch
// ---------------------------------------------------------------------------
let silentBusy = false;
let updateStatus = { state: 'idle', percent: 0, message: '未检查更新', detail: '', current: '读取中', latest: '未检查' };
function setUpdateStatus(state, message, percent = updateStatus.percent, detail = updateStatus.detail, versions = {}) {
  updateStatus = { ...updateStatus, ...versions, state, percent: Math.max(0, Math.min(100, percent)), message, detail };
  if (tray && !tray.isDestroyed()) {
    try { tray.setToolTip(`${APP_NAME} · ${message}`); tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate())); } catch {}
  }
}
function updateMenuItems() {
  const p = updateStatus.percent;
  const suffix = updateStatus.state === 'downloading' ? ` ${p}%` : '';
  // Update items stay clickable so the user can open the confirmation dialog
  // from the tray; only transient states (checking / downloading) are locked.
  const interactive = ['idle', 'available', 'ready', 'error'].includes(updateStatus.state);
  const click = interactive ? () => { handleUpdateMenuClick(); } : null;
  return [
    { label: `当前版本：${updateStatus.current}`, enabled: interactive, click },
    { label: `最新版本：${updateStatus.latest}`, enabled: interactive, click },
    { label: `更新：${updateStatus.message}${suffix}`, enabled: interactive, click }
  ];
}
let shellUpdateVersion = null;

/** Check-only: never downloads. New versions are announced via the tray and wait for user confirmation. */
async function checkBackendUpdates(options = {}) {
  if (silentBusy) return null;
  silentBusy = true;
  setUpdateStatus('checking', '正在检查更新', 0, '', { current: mgr.currentVersions()?.dsh || '未知', latest: '检查中…' });
  try {
    const info = await mgr.checkForUpdates(options);
    diag('更新检查结果:', { current: info.current, latest: info.latest, updates: info.updates, pending: info.pending, errors: info.errors });
    if (info.updates && info.updates.length) {
      setUpdateStatus('available', '有新版本，点击此处确认', 0, info.updates.map((u) => `${u.component} → ${u.latest}`).join('；'), { current: info.current?.dsh || '未知', latest: info.latest?.dsh || '未知' });
      pushLog('发现新版本（等待用户确认后才下载）：' + info.updates.map((u) => `${u.component} ${u.current || '无'} → ${u.latest}`).join('；') + '\n');
      try {
        tray && tray.displayBalloon({
          iconType: 'info', title: 'DSH 有可用更新',
          content: info.updates.map((u) => `${u.component} → ${u.latest}`).join('；') + '\n点击托盘菜单中的版本/更新项确认下载。'
        });
      } catch {}
    } else if (info.pending && info.pending.length) {
      pushLog('已暂存 ' + info.pending.map((p) => `${p.component}->${p.staged}`).join(', ') + '，将在下次启动时自动应用（跳过重复下载）\n');
      setUpdateStatus('ready', '更新待重启应用', 100, info.pending.map((p) => `${p.component} ${p.staged}`).join('；'), { current: info.current?.dsh || '未知', latest: info.latest?.dsh || '未知' });
    } else {
      pushLog('backend components up to date\n');
      setUpdateStatus('idle', '已是最新版本', 100, '', { current: info.current?.dsh || '未知', latest: info.latest?.dsh || '未知' });
    }
    return info;
  } catch (e) {
    setUpdateStatus('error', '检查更新失败', 0, e && e.message ? e.message : '未知错误', { current: updateStatus.current, latest: updateStatus.latest || '未知' });
    pushLog('[update] check failed: ' + (e && e.message) + '\n');
    return null;
  } finally {
    silentBusy = false;
  }
}

/** Download updates — ONLY called after the user confirms in the dialog. */
async function stageConfirmedUpdates(updates, info) {
  if (silentBusy) return;
  silentBusy = true;
  setUpdateStatus('downloading', `开始下载 ${updates.length} 项更新`, 0, updates.map((u) => `${u.component} → ${u.latest}`).join('；'), { current: (info && info.current && info.current.dsh) || updateStatus.current, latest: (info && info.latest && info.latest.dsh) || updateStatus.latest });
  diag('用户已确认，开始下载更新:', updates.map((u) => `${u.component} ${u.current || '无'} → ${u.latest}`).join('；'));
  const cbs = { onLog: (m) => pushLog('[update] ' + m + '\n'), onProgress: (p) => setUpdateStatus('downloading', '正在下载更新', Math.round((p || 0) * 100), updateStatus.detail) };
  const summaries = [];
  const failures = [];
  for (const u of updates) {
    try {
      if (u.component === 'dsh') {
        const staged = await mgr.stageDsh(cbs, u.latest);
        summaries.push(`DSH 后端 ${u.current || '无'} → ${staged.version}`);
        if (u.changes && u.changes.length) summaries.push('上游更新：' + u.changes.slice(0, 3).join('；'));
      } else if (u.component === 'node') {
        await mgr.stageNode(cbs);
        summaries.push(`Node 运行时 ${u.current || '无'} → ${u.latest}`);
      }
    } catch (e) {
      const msg = `${u.component === 'dsh' ? 'DSH 后端' : u.component} ${u.latest}：${e && e.message ? e.message : e}`;
      failures.push(msg);
      diag('更新下载失败:', u.component, u.latest, e);
      pushLog('[update] stage failed ' + u.component + ': ' + (e && e.message) + '\n');
    }
  }
  if (shellUpdateVersion && autoUpdater) {
    try { await autoUpdater.downloadUpdate(); summaries.push(`DSH Desktop ${shellUpdateVersion}`); } catch (e) { failures.push(`DSH Desktop ${shellUpdateVersion}：${e && e.message}`); diag('外壳更新下载失败:', e); }
  }
  silentBusy = false;
  // Honest reporting: never claim success when nothing could be downloaded
  // (e.g. the GitHub version is not published on npm yet).
  if (!summaries.length) {
    const failText = failures.join('\n\n');
    setUpdateStatus('error', '更新下载失败', 0, failText, { current: updateStatus.current, latest: updateStatus.latest });
    diag('全部更新下载失败，版本未变化。', failText);
    dialog.showMessageBox(mainWindow, {
      type: 'error', buttons: ['知道了'], title: APP_NAME, message: '更新下载失败',
      detail: failText + '\n\n当前版本未受影响、未重启需求。\n可能原因：该版本尚未发布到 npm 镜像。\n\n详情已写入桌面日志：DSH-Desktop-日志.txt'
    }).catch(() => {});
    return;
  }
  const detail = summaries.join('\n') + (failures.length ? '\n\n以下组件下载失败（已跳过）：\n' + failures.join('\n') : '');
  setUpdateStatus('ready', '更新已下载，等待重启', 100, detail, { current: updateStatus.current, latest: updateStatus.latest });
  pushLog('更新内容：\n' + detail + '\n将在下次启动时自动应用。\n');
  diag('更新下载完成，等待重启:', detail);
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'info', buttons: ['立即重启并更新', '稍后'], defaultId: 0, cancelId: 1,
    title: APP_NAME, message: '更新已下载完成',
    detail: detail + '\n\n重启应用后生效。'
  });
  diag('更新完成对话框选择:', r.response === 0 ? '立即重启并更新' : '稍后');
  if (r.response === 0) restartApp();
}

/** Tray menu click on the version/update items — the single consent gate for updates. */
async function handleUpdateMenuClick() {
  diag('托盘更新项被点击，当前状态:', { state: updateStatus.state, current: updateStatus.current, latest: updateStatus.latest });
  if (silentBusy) {
    dialog.showMessageBox(mainWindow, { type: 'info', buttons: ['知道了'], title: APP_NAME, message: '正在检查或下载更新', detail: '请稍候，当前更新操作完成后即可继续。' }).catch(() => {});
    return;
  }
  showMainWindow();
  if (updateStatus.state === 'ready') {
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'info', buttons: ['立即重启并更新', '稍后'], defaultId: 0, cancelId: 1,
      title: APP_NAME, message: '更新已就绪',
      detail: (updateStatus.detail || '新版本已下载完成。') + '\n\n重启应用后生效。'
    });
    if (r.response === 0) restartApp();
    return;
  }
  const info = await checkBackendUpdates({ includeNode: false });
  if (!info) return;
  if (!info.updates || !info.updates.length) {
    if (info.pending && info.pending.length) {
      setUpdateStatus('ready', '更新待重启应用', 100, info.pending.map((p) => `${p.component} ${p.staged}`).join('；'), { current: info.current?.dsh || '未知', latest: info.latest?.dsh || '未知' });
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'info', buttons: ['立即重启并更新', '稍后'], defaultId: 0, cancelId: 1,
        title: APP_NAME, message: '更新已就绪',
        detail: info.pending.map((p) => `${p.component} → ${p.staged}`).join('\n') + '\n\n重启应用后生效。'
      });
      if (r.response === 0) restartApp();
    } else {
      dialog.showMessageBox(mainWindow, {
        type: 'info', buttons: ['知道了'], title: APP_NAME, message: '已是最新版本',
        detail: `当前 DSH 后端：${info.current?.dsh || '未知'}\n最新版本：${info.latest?.dsh || '未知'}`
      }).catch(() => {});
    }
    return;
  }
  const lines = info.updates.map((u) => `${u.component === 'dsh' ? 'DSH 后端' : u.component} ${u.current || '无'} → ${u.latest}`);
  if (shellUpdateVersion) lines.push(`DSH Desktop 桌面版 → ${shellUpdateVersion}`);
  const changes = info.updates.flatMap((u) => (u.changes || []).slice(0, 3).map((c) => `· ${c}`));
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['下载并更新', '取消'], defaultId: 0, cancelId: 1,
    title: APP_NAME, message: '发现新版本',
    detail: lines.join('\n') + (changes.length ? '\n\n更新内容：\n' + changes.join('\n') : '') + '\n\n是否现在下载更新？下载完成后需要重启应用生效。'
  });
  if (r.response === 0) await stageConfirmedUpdates(info.updates, info);
}

function scheduleSilentUpdates() {
  // Check-only cadence: announces new versions via the tray, never downloads.
  // First check is early (5s) so the tray shows fresh version data right after
  // a restart that applied an update.
  setTimeout(() => checkBackendUpdates(), 5000);
  setInterval(() => checkBackendUpdates(), 6 * 3600 * 1000);
}

async function restartApp() {
  diag('restartApp：准备重启（更新应用流程）');
  isQuitting = true;
  const proc = backend;
  backend = null;
  if (proc) {
    try { proc.removeAllListeners('exit'); } catch {}
    killProcessTree(proc);
    // Wait (bounded) for the backend tree to actually die, so the relaunched
    // instance can swap dsh.new → dsh without colliding with file locks still
    // held by this dying process. Without this the staged update is skipped.
    await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 6000);
      proc.once('exit', (code) => { clearTimeout(timer); resolve(); diag('restartApp：后端进程已退出 code=', code); });
    });
    await new Promise((r) => setTimeout(r, 400));
    diag('restartApp：后端已停止，等待句柄释放后拉起新实例');
  }
  diag('restartApp：app.relaunch + exit');
  app.relaunch();
  app.exit(0);
}

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('backend:versions', () => { try { return mgr.currentVersions(); } catch { return null; } });
ipcMain.handle('env:isolation', () => { try { return mgr.describeEnvIsolation(); } catch { return null; } });
ipcMain.handle('backend:check-updates', () => checkBackendUpdates({ includeNode: true }));
ipcMain.handle('app:restart', () => restartApp());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    diag('启动流程开始', { hidden: autoStartHidden, packaged: isPackaged, versions: (() => { try { return mgr.currentVersions(); } catch { return null; } })() });
    if (!autoStartHidden) createSplash();
    try {
      // 1) Seed writable active dir from factory resources (first run).
      diag('步骤1 初始化活跃目录 ensureSeeded');
      mgr.ensureSeeded();
      // 2) Honor the installer-selected backend ONCE (first launch after install).
      //    The marker file is consumed afterwards so later boots never force-stage
      //    an old version and never bypass the tray-confirmation update policy.
      const requestedBackend = mgr.requestedBackendVersion();
      diag('步骤2 安装选择标记:', requestedBackend || '（无）');
      if (requestedBackend) {
        try {
          if (requestedBackend === 'online') {
            pushLog('安装程序选择在线最新 DSH 版本，开始检查更新。\n');
            updateSplash('正在检查在线 DSH 最新版本…');
            const info = await mgr.checkForUpdates({ includeNode: false });
            const online = info.latest && info.latest.dsh;
            const current = info.current && info.current.dsh;
            diag('在线选择检查结果:', { online, current });
            if (online && (!current || mgr.compareSemver(online, current) > 0)) {
              updateSplash(`正在下载在线 DSH ${online}…`);
              await mgr.stageDsh({ onLog: (m) => { pushLog('[backend-online] ' + m + '\n'); updateSplash(m); }, onProgress: (p) => updateSplash(`正在下载在线 DSH ${online}：${Math.round((p || 0) * 100)}%`) }, online);
            }
            updateSplash('正在应用在线 DSH 后端…');
          } else if (mgr.currentVersions().dsh !== requestedBackend) {
            pushLog(`安装程序选择 DSH 后端 ${requestedBackend}，正在准备该版本。\n`);
            updateSplash(`正在准备 DSH 后端 ${requestedBackend}…`);
            await mgr.stageDsh({ onLog: (m) => pushLog('[backend-select] ' + m + '\n'), onProgress: () => {} }, requestedBackend);
          }
        } catch (e) {
          pushLog(`安装选择的后端准备失败，将使用现有后端启动：${e && e.message}\n`);
          diag('安装选择的后端准备失败:', e);
        } finally {
          mgr.clearRequestedBackendVersion();
          diag('步骤2 完成（安装选择标记已清除）');
        }
      }
      // 3) Apply any update staged on the previous launch (backend NOT running yet → no locks).
      diag('步骤3 应用暂存更新 applyStaged（前）:', (() => { try { return mgr.stagedVersions(); } catch { return null; } })());
      const applied = mgr.applyStaged();
      diag('步骤3 应用暂存更新 applyStaged（后）:', applied);
      const shouldIsolatePlugins = !!(applied && applied.dsh);
      diag('插件隔离流程:', shouldIsolatePlugins ? '本次启动应用了新后端，将执行隔离轮测' : '跳过');
      // 3) Node gate: fast local check without network requests.
      const req = mgr.nodeRequirement();
      pushLog(`node gate: ${req.current || 'none'} >= ${req.required} (${req.source}) -> ${req.ok ? 'ok' : 'unsatisfied'}\n`);
      if (!req.ok) {
        await mgr.ensureNodeMeetsRequirement({ onLog: (m) => pushLog('[node-check] ' + m + '\n'), onProgress: () => {} });
      }
      // 4) Repair isolated profile junctions before boot (dsh throws on real dirs here).
      mgr.repairProfileJunctions(mgr.dshHome());
      const iso = mgr.describeEnvIsolation();
      pushLog(`env isolation: stripped ${iso.strippedVars.length} var(s), dropped ${iso.droppedPathEntries.length} foreign PATH entr(ies), DSH_HOME=${iso.dshHome}\n`);
      // 5) Start backend (self-heals and retries on profile/symlink errors).
      diag('步骤5 启动后端');
      const url = await startBackendWithPluginIsolation(shouldIsolatePlugins);
      diag('步骤5 后端已启动:', url);
      // 6) Show UI + arm the keep-alive tray (close button hides to tray).
      await createMainWindow(url);
      createTray();
      diag('步骤6 主窗口与托盘就绪');
      // 7) Background: shell updater + silent backend updates.
      setupShellUpdater();
      scheduleSilentUpdates();
      diag('步骤7 启动流程完成');
    } catch (err) {
      showFatal(err);
    }
  });

  app.on('window-all-closed', () => {
    // With a live tray the app is keep-alive: closing the (hidden) window must
    // not quit. Only quit for a real exit or when the tray could not be created.
    if (isQuitting || !tray) { isQuitting = true; killProcessTree(backend); app.quit(); }
  });
  app.on('before-quit', () => { isQuitting = true; killProcessTree(backend); });
  process.on('exit', () => { isQuitting = true; killProcessTree(backend); });
}
