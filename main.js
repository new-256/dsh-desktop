'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const mgr = require('./updater-backend');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); }
catch (err) { console.warn('[dsh-desktop] electron-updater unavailable:', err && err.message); }

const APP_NAME = 'DSH Desktop';
const isPackaged = app.isPackaged;

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

function pushLog(line) {
  const text = line == null ? '' : line.toString();
  backendLogs.push(text);
  if (backendLogs.length > 300) backendLogs.shift();
  process.stdout.write(`[dsh-backend] ${text}`);
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

function activePaths() { return mgr.P(); }

/**
 * Spawn the bundled backend from the active user-writable dir, with an isolated
 * DSH_HOME so it never collides with the user's CLI `~/.dsh` (and its symlink
 * state is fully owned by this app). Returns a promise resolving to the URL.
 */
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
        // Backend died after boot.
        pushLog(`backend exited after boot code=${code} signal=${signal}\n`);
        if (!isQuitting) handleBackendCrashed();
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
  if (backend) { killProcessTree(backend); backend = null; }
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
  if (backend) { killProcessTree(backend); backend = null; }
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
  if (backend) { killProcessTree(backend); backend = null; }

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

let crashNotified = false;
function handleBackendCrashed() {
  if (crashNotified) return; crashNotified = true;
  dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['重启应用', '关闭'], defaultId: 0, cancelId: 1,
    title: APP_NAME,
    message: '后端服务已停止',
    detail: 'DSH 后端意外退出。重启应用可恢复；你的会话与配置保存在独立数据目录中，不会丢失。'
  }).then((r) => {
    crashNotified = false;
    if (r.response === 0) restartApp(); else app.quit();
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
  win.once('ready-to-show', () => { win.show(); closeSplash(); });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    pushLog(`chromium did-fail-load ${code} ${desc}\n`);
    if (code === -3) return; // aborted (normal on redirect)
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
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
  dialog.showErrorBox(`${APP_NAME} 启动失败`,
    (err && err.stack ? err.stack : String(err)) +
    '\n\n--- 后端日志（末尾）---\n' + backendLogs.join('').split(/\r?\n/).slice(-40).join('\n'));
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (e) => console.warn('[shell-updater]', e && e.message));
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
async function silentStageUpdates(options = {}) {
  if (silentBusy) return;
  silentBusy = true;
  try {
    const info = await mgr.checkForUpdates(options);
    if (info.pending && info.pending.length) {
      pushLog('已暂存 ' + info.pending.map((p) => `${p.component}->${p.staged}`).join(', ') + '，将在下次启动时自动应用（跳过重复下载）\n');
    }
    if (!info.updates || !info.updates.length) {
      if (!info.pending || !info.pending.length) {
        pushLog('backend components up to date\n');
      }
      return;
    }
    pushLog('silent update available: ' + info.updates.map((u) => `${u.component}->${u.latest}`).join(', ') + '\n');
    const cbs = { onLog: (m) => pushLog('[update] ' + m + '\n'), onProgress: () => {} };
    for (const u of info.updates) {
      try {
        if (u.component === 'dsh') await mgr.stageDsh(cbs);
        else if (u.component === 'node') await mgr.stageNode(cbs);
      } catch (e) { pushLog('[update] stage failed ' + u.component + ': ' + e.message + '\n'); }
    }
    pushLog('更新已下载完成，将在下次启动时自动应用。\n');
    // Non-blocking toast-like notice in the title (no modal interrupt).
    if (mainWindow && !mainWindow.isDestroyed && !mainWindow.isDestroyed()) {
      try { mainWindow.flashFrame(false); } catch {}
    }
  } catch (e) {
    pushLog('[update] check failed: ' + (e && e.message) + '\n');
  } finally {
    silentBusy = false;
  }
}

function scheduleSilentUpdates() {
  setTimeout(() => silentStageUpdates(), 20000);
  setInterval(() => silentStageUpdates(), 6 * 3600 * 1000);
}

function restartApp() {
  isQuitting = true;
  killProcessTree(backend);
  app.relaunch();
  app.exit(0);
}

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('backend:versions', () => { try { return mgr.currentVersions(); } catch { return null; } });
ipcMain.handle('env:isolation', () => { try { return mgr.describeEnvIsolation(); } catch { return null; } });
ipcMain.handle('backend:check-updates', () => silentStageUpdates({ includeNode: true }));
ipcMain.handle('app:restart', () => restartApp());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

  app.whenReady().then(async () => {
    createSplash();
    try {
      // 1) Seed writable active dir from factory resources (first run).
      mgr.ensureSeeded();
      // 2) Apply any update staged on the previous launch (backend NOT running yet → no locks).
      mgr.applyStaged();
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
      const url = await startBackendWithHealing();
      // 6) Show UI.
      await createMainWindow(url);
      // 7) Background: shell updater + silent backend updates.
      setupShellUpdater();
      scheduleSilentUpdates();
    } catch (err) {
      showFatal(err);
    }
  });

  app.on('window-all-closed', () => { isQuitting = true; killProcessTree(backend); app.quit(); });
  app.on('before-quit', () => { isQuitting = true; killProcessTree(backend); });
  process.on('exit', () => { isQuitting = true; killProcessTree(backend); });
}
