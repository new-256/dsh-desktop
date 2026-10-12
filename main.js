'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, Tray, nativeImage, clipboard } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const mgr = require('./updater-backend');
const diagLog = require('./diag-log');
const crashReport = require('./crash-report');
const { createQuitGuard } = require('./quit-guard');
const ladderPolicy = require('./ladder-policy');
const diag = diagLog.write;

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
let backendLogsBytes = 0;
let mainWindow = null;
let splashWindow = null;
let pendingShowMainWindow = false;
// 0.3.44 · 关闭确认框的并发闸门（同一时刻只允许一个确认框存在）。
let closeConfirmPending = false;
let activeUrl = null;
let safeMode = false;
let isQuitting = false;
let tray = null;
let trayHintShown = false;
let crashNotified = false;
// Boot phase drives the tray's disaster-recovery menu. The tray is armed
// BEFORE the backend is spawned, so 'starting' / 'failed' are real states the
// user can act on — previously the tray only appeared after a successful boot,
// which meant a failed start left no recovery entry point at all.
let bootPhase = 'starting'; // 'starting' | 'running' | 'failed'
let lastBootError = null;
// 渲染层 error 级 console 的有界尾部缓冲（0.3.39 · 对齐官方 RendererConsoleTail）：
// 崩溃报告需要「最近的渲染层错误」，但绝不能为长会话无限累积。
let rendererConsoleTail = [];
let rendererConsoleBytes = 0;
const RENDERER_CONSOLE_MAX_BYTES = 64 * 1024;
// 后端日志字节上限（对齐官方 MAX_HOST_DIAGNOSTIC_CHARS=64KiB）：行数上限挡不住
// 超长单行，长期运行下错误信息可能整段塞进一个 push。
const BACKEND_LOGS_MAX_BYTES = 64 * 1024;
// 退出前向 Host 查询「会中断什么」的截止时间（对齐官方 2s）——超时按有任务处理。
const QUIT_INSPECT_DEADLINE_MS = 2000;

// ---------------------------------------------------------------------------
// IPC 来源校验（0.3.42 · 对齐官方 ipc.ts:97-104 的 assertDesktopSender）
//
// 官方规约：任何 IPC 处理器都必须先确认调用方是「自己拥有的文档」。我们此前
// 28 个 ipcMain.handle **零校验** —— 主窗口加载的是后端 Web UI（127.0.0.1 随机
// 端口），理论上页面里任何脚本（含被注入/供应链污染的插件前端代码）都能直接
// 调用 backend:rollback-to、plugins:install、app:restart、plugins:set-path-entry
// 这类高权限通道，绕过 UI 确认。
//
// 与官方的差异（不能照抄）：官方文档走 `dsh-app://` 固定 scheme + 固定 hostname；
// 我们是 http://127.0.0.1:<随机端口>（端口每次启动都变），另有 settings.html 走
// file://。所以这里按「实际拥有的窗口」判定：sender 必须来自 mainWindow 或
// settingsWindow 的 webContents；其次才做 origin 兜底校验。
// ---------------------------------------------------------------------------

/** 当前允许发起 IPC 的 webContents id 集合（窗口创建/销毁时维护）。 */
function ownedWebContentsIds() {
  const ids = new Set();
  for (const w of [mainWindow, settingsWindow]) {
    try { if (w && !w.isDestroyed()) ids.add(w.webContents.id); } catch {}
  }
  return ids;
}

/**
 * 校验一次 IPC 调用是否来自我们拥有的文档，不是则抛错。
 * @param {Electron.IpcMainInvokeEvent|Electron.IpcMainEvent} event
 * @param {string} channel 仅用于错误信息
 */
function assertOwnedSender(event, channel) {
  const frame = event && event.senderFrame;
  if (!frame) throw new Error(`已拒绝来自未知来源的 IPC（${channel}：无 sender frame）`);
  const ids = ownedWebContentsIds();
  const senderId = event.sender ? event.sender.id : -1;
  if (!ids.has(senderId)) {
    throw new Error(`已拒绝来自非本应用窗口的 IPC（${channel}）`);
  }
  // origin 兜底：主窗口只允许后端地址，设置窗口只允许本地文件。
  let url;
  try { url = new URL(frame.url); } catch { throw new Error(`已拒绝来源不可解析的 IPC（${channel}）`); }
  const isSettingsDoc = url.protocol === 'file:';
  const isBackendDoc = (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
  if (!isSettingsDoc && !isBackendDoc) {
    throw new Error(`已拒绝来源不属于本应用的 IPC（${channel}：${url.protocol}//${url.hostname}）`);
  }
}

/** 包装 ipcMain.handle：先校验来源，再执行处理器。 */
function handleIpc(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    assertOwnedSender(event, channel);
    return listener(event, ...args);
  });
}

// 退出前确认（0.3.42 · 对齐官方 quit-confirmation.ts）。
// 我们的后端（标准 dsh web CLI）没有任务状态接口，因此采用保守语义：
// 后端活着且曾就绪 ⇒ 视为「可能有任务」，问一次再退。
const quitGuard = createQuitGuard({
  hasInterruptibleWork: () => !!(backend && backend.exitCode === null && activeUrl),
  confirm: async () => {
    const { response } = await dialog.showMessageBox(
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
      {
        type: 'question',
        buttons: ['仍然退出', '取消'],
        defaultId: 1, cancelId: 1, noLink: true,
        title: `${APP_NAME} 退出`,
        message: '退出将中断后端正在运行的任务',
        detail: '如果有 agent 正在执行或消息正在排队，它们会被中断。\n\n' +
          '选择「取消」可让它继续跑完；关闭窗口不会退出应用，' +
          'DSH 会留在系统托盘里继续工作。'
      }
    );
    return response === 0;
  },
  now: () => {
    isQuitting = true;
    if (tray) { try { tray.destroy(); } catch {} tray = null; }
    killProcessTree(backend);
    app.quit();
  },
  log: (msg) => diag(msg)
});

function pushLog(line) {
  const text = line == null ? '' : line.toString();
  backendLogs.push(text);
  backendLogsBytes += Buffer.byteLength(text, 'utf8');
  if (backendLogs.length > 300) backendLogs.shift();
  // 字节封顶：从最旧开始丢弃，保证长期会话内存有界（官方同纪律）。
  while (backendLogsBytes > BACKEND_LOGS_MAX_BYTES && backendLogs.length > 1) {
    backendLogsBytes -= Buffer.byteLength(backendLogs.shift(), 'utf8');
  }
  process.stdout.write(`[dsh-backend] ${text}`);
  diag('后端输出', text);
}

/** 记录一条渲染层 error 级 console（进崩溃报告用，有界尾部缓冲）。 */
function pushRendererConsoleError(text) {
  const line = String(text || '');
  if (!line) return;
  rendererConsoleTail.push(line);
  rendererConsoleBytes += Buffer.byteLength(line, 'utf8');
  while (rendererConsoleBytes > RENDERER_CONSOLE_MAX_BYTES && rendererConsoleTail.length > 1) {
    rendererConsoleBytes -= Buffer.byteLength(rendererConsoleTail.shift(), 'utf8');
  }
}

// ── 0.3.39 · 关窗确认标记（对齐官方 background-close-confirmed）─────────────
// 确认一次写进 Electron userData，更新保留、卸载随目录消失；autoStartHidden
// 的隐藏启动不算「用户关窗」，不写标记。
function closeConfirmMarkerPath() {
  try { return path.join(app.getPath('userData'), 'background-close-confirmed'); } catch { return null; }
}
function closeConfirmRecorded() {
  const p = closeConfirmMarkerPath();
  if (!p) return false;
  try { fs.accessSync(p); return true; } catch { return false; }
}
function recordCloseConfirm() {
  const p = closeConfirmMarkerPath();
  if (!p) return;
  try { fs.writeFileSync(p, new Date().toISOString() + '\n', 'utf8'); } catch {}
}

// ── 0.3.39 · 设备信息（对齐官方 dshDesktop.deviceInfo()）────────────────────
// `name=value` 以 `; ` 分隔：platform / os / app_arch / cpu / memory_gib。
// 不含主机名、用户名、序列号 —— 与官方同一隐私口径。
function readDeviceInfo() {
  const cpus = (() => { try { return os.cpus(); } catch { return []; } })();
  const parts = [];
  parts.push(`platform=${process.platform}`);
  parts.push(`os=${os.release()}`);
  parts.push(`app_arch=${process.arch}`);
  const cpuModel = cpus.length && cpus[0] && cpus[0].model ? cpus[0].model.trim() : '';
  if (cpuModel) parts.push(`cpu=${cpuModel}`);
  try {
    const gib = os.totalmem() / (1024 * 1024 * 1024);
    if (gib > 0) parts.push(`memory_gib=${gib.toFixed(1)}`);
  } catch {}
  return parts.join('; ');
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

/**
 * 有界、可验证地停止后端（0.3.44）。
 *
 * ## 为什么不是官方的三段式
 *
 * 官方 host-process.ts:288-308 的 stop() 是：
 *   shutdown IPC → 等 10s → SIGTERM → 等 5s → SIGKILL → 等 5s
 *
 * 我们**实测**（Windows 11 / node 24 / Electron 44）确认这套阶梯在本平台
 * 结构上不适用，三段里有两点无法成立：
 *
 *   1. **没有 shutdown IPC**：官方拥有子进程的 stdio（`stdio: [...,'ipc']`），
 *      能发自定义消息；我们启动的是标准 `dsh web` CLI，协议里没有关闭通道。
 *   2. **Windows 没有可捕获的信号**：Node 的 `child.kill('SIGTERM')` 在该平台
 *      走 TerminateProcess，**子进程的 SIGTERM handler 不会执行**。实测四种
 *      投递方式（child.kill SIGTERM / 进程组 SIGBREAK / 进程组 SIGINT /
 *      taskkill /T 不带 /F）**全部未能触发**子进程里注册的 handler。
 *      ⇒ 官方的 SIGTERM→SIGKILL 两段在 Windows 上**是同一个动作**。
 *
 * 我们也验证了替代路径同样不存在：`dsh web` 无 --graceful 类开关、无 HTTP
 * 关闭端点（实测 /api/shutdown、/shutdown、/api/quit、/api/exit、/quit 全 404）。
 *
 * 所以这里不做"假装优雅"的阶梯，而是做**真正能在本平台兑现的保证**：
 *
 *   a) **先请求后等待、且验证真的停了**——旧实现 fire-and-forget 调用 taskkill
 *      就立刻返回，紧接着的重启/更新动作会与被杀进程竞争（端口、文件锁）。
 *   b) **有界**——绝不无限等待，超时升级为强制，升级本身也有界。
 *   c) **如实记录**——把"本平台无法优雅收尾"写进诊断日志，而不是让日志看起来
 *      像做过优雅收尾。
 *
 * @param {import('child_process').ChildProcess} proc
 * @param {{timeoutMs?: number, forceTimeoutMs?: number}} [opts]
 * @returns {Promise<{stopped: boolean, forced: boolean, ms: number, how: string}>}
 */
async function stopBackendBounded(proc, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 6000;
  const forceTimeoutMs = opts.forceTimeoutMs != null ? opts.forceTimeoutMs : 5000;
  const started = Date.now();
  if (!proc || proc.exitCode !== null) {
    return { stopped: true, forced: false, ms: 0, how: 'already-exited' };
  }

  const pid = proc.pid;
  const waitExit = (ms) => new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(true);
    let done = false;
    const onExit = () => { if (!done) { done = true; clearTimeout(t); resolve(true); } };
    const t = setTimeout(() => { if (!done) { done = true; try { proc.removeListener('exit', onExit); } catch {} resolve(false); } }, ms);
    try { proc.once('exit', onExit); } catch { clearTimeout(t); resolve(false); }
  });

  // 阶段一：温和请求（不带 /F，给 GUI 型子进程响应 WM_CLOSE 的机会）。
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { proc.kill('SIGTERM'); } catch {}
    }
  } catch (e) { diag('温和停止请求失败（继续等待）:', e && e.message); }

  if (await waitExit(timeoutMs)) {
    return { stopped: true, forced: false, ms: Date.now() - started, how: process.platform === 'win32' ? 'taskkill-gentle' : 'SIGTERM' };
  }

  // 阶段二：强制。这是 Windows 上唯一真正生效的手段。
  diag(`后端未在 ${timeoutMs}ms 内退出，升级为强制终止（pid=${pid}）`);
  try { killProcessTree(proc); } catch (e) { diag('强制终止失败:', e && e.message); }

  if (await waitExit(forceTimeoutMs)) {
    return { stopped: true, forced: true, ms: Date.now() - started, how: 'forced' };
  }

  const ms = Date.now() - started;
  diag(`后端在强制终止后仍未退出（pid=${pid}，已等待 ${ms}ms）；继续后续流程，但可能出现端口/文件锁竞争`);
  return { stopped: false, forced: true, ms, how: 'still-running' };
}

/** Controlled stop: detach listeners first so a deliberate kill is never misread as a crash. */
function stopBackend() {
  if (!backend) return;
  const proc = backend;
  backend = null;
  activeUrl = null;
  try { proc.removeAllListeners('exit'); } catch {}
  killProcessTree(proc);
}

/**
 * 停止后端并**等待它真的退出**（0.3.44）。
 * 用于重启/更新/自愈重试等"停完马上还要用它"的场景 —— 旧实现在这些地方
 * fire-and-forget 杀完就继续，会与被杀进程竞争端口与文件锁。
 */
async function stopBackendAndWait(opts = {}) {
  const proc = backend;
  if (!proc) return { stopped: true, forced: false, ms: 0, how: 'no-backend' };
  backend = null;
  activeUrl = null;
  try { proc.removeAllListeners('exit'); } catch {}
  return stopBackendBounded(proc, opts);
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
  return new Promise(async (resolve, reject) => {
    const p = activePaths();
    if (!fs.existsSync(p.nodeExe)) return reject(new Error('缺少 Node 运行时：未找到活跃 node.exe（seed 失败）。'));
    if (!fs.existsSync(p.dshBin)) return reject(new Error('缺少 DSH 后端：未找到活跃 dsh（seed 失败）。'));

    // Dedicated, fully-isolated environment: node prefix first on PATH,
    // isolated npm/pnpm/corepack homes, isolated DSH_HOME. Never inherits user's
    // global node/npm environment -> "dsh 专用 node 环境".
    const env = mgr.buildDedicatedEnv();
    env.DSH_HOME = p.dshHome;
    delete env.ELECTRON_RUN_AS_NODE; // we spawn a real standalone node

    // 后端只监听回环地址。--max-http-header-size 是必需的：Web 端把所有插件
    // client.js 拼成一个组合脚本 URL，插件一多就超过 Node 默认 16KB 请求头上限，
    // 后端会以 HTTP 431 拒绝，表现为「插件全部加载失败」。与手机功能无关，勿删。
    const args = ['--max-http-header-size=1048576', p.dshBin, 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'];

    const child = spawn(p.nodeExe, args, {
      cwd: path.dirname(p.dshBin), env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    backend = child;
    pushLog(`starting backend: node=${p.nodeExe} DSH_HOME=${p.dshHome} host=127.0.0.1 port=0\n`);

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

/** 把本轮阶梯裁决写入诊断日志（事故复盘用：能回答"为什么烧了 profile"）。 */
function logLadderTrail(trail) {
  if (!Array.isArray(trail) || !trail.length) return;
  const lines = trail.map((t) => `  ${t.allowed ? '执行' : '跳过'} ${t.stage} [${t.damage}] ${t.reason}`);
  diag('自愈阶梯裁决轨迹:\n' + lines.join('\n'));
}

/** Attempt to start the backend, self-healing common failure modes with escalations. */
async function startBackendWithHealing(opts = {}) {
  const isolationRound = !!(opts && opts.isolationRound);
  const p = activePaths();
  // 0.3.43 阶梯纪律：记录本轮每一步的裁决结果，事后可回答"那一夜它为什么烧了三次"。
  const ladderTrail = [];
  // 供 Escalation 2 的证据判定复用（1c 在这里赋值，隔离决策在后面读取）。
  // 日志点名过"失败的第三方 bundle"是"根因在 profiles 内"的正面证据之一。
  let failingBundles = [];
  let firstErr;
  try {
    return await spawnBackend();
  } catch (err) {
    firstErr = err;
    pushLog('first backend start failed; attempting self-heal (junction repair + profile quarantine)\n');
  }

  // Isolation round-tests: the isolation flow owns the home patch (each round
  // rewrites it from the pre-isolation snapshot). Patch-editing escalations
  // (conflict disable / broken-source disable) would be overwritten by the
  // next round anyway, and their dialogs would interrupt the round loop —
  // the round will simply be marked failed. Do junction repair + one retry,
  // then surface the error.
  if (isolationRound) {
    pushLog('隔离轮测中：跳过补丁编辑类自愈，仅做 junction 修复后重试。\n');
    const fixedRound = mgr.repairProfileJunctions(p.dshHome);
    if (fixedRound > 0) {
      await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
      try {
        return await spawnBackend();
      } catch (retryErrRound) {
        pushLog('backend start failed after junction repair (isolation round)\n');
      }
    }
    throw firstErr;
  }

  // R0: transient-failure check — right after an update apply, freshly written
  // files may not be fully settled yet; one raw retry self-heals those races
  // (the 0.1.5 first-boot case) without any escalation or dialogs.
  await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 1200ms sleep
  try {
    pushLog('retrying backend once (transient check)…\n');
    return await spawnBackend();
  } catch (retryTransient) {
    pushLog('backend start failed again; entering self-heal escalations\n');
  }

  // Escalation 0a: the patch file is not a top-level YAML array at all. The
  // loader rejects it before ANY plugin logic runs, so every later escalation
  // (entry disable / junction repair / quarantine / Node repair) is guaranteed
  // to spin uselessly — exactly what happened on 2026-09-09, where safe mode
  // itself had left a comment-only patch file behind and the whole ladder ran
  // dry into a fatal dialog. Fix the structure first, then retry.
  try {
    const logText = backendLogs.join('');
    const structural = /must be a top-level YAML array|patches .* must be a top-level/i.test(logText);
    const repairs = mgr.validateAndRepairPatchLayers();
    if (repairs.length) {
      const lines = repairs.map((r) => {
        const how = r.strategy === 'append-empty-array' ? '已补回空数组标记（注释内容全部保留）'
          : r.strategy === 'restore-backup' ? `已回退到最近的可用备份（${r.restoredFrom}）`
          : r.strategy === 'reset-empty' ? '已重置为空补丁层（原内容已备份）' : '未能修复';
        return `${r.file}\n原因：${r.reason}\n处理：${how}`;
      });
      pushLog(`自愈：插件配置文件结构损坏，已修复 ${repairs.length} 处。\n${lines.join('\n')}\n`);
      diag('自愈 Escalation 0a 补丁结构修复:', repairs);
      await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 600ms sleep
      try {
        const urlFixed = await spawnBackend();
        if (!autoStartHidden) {
          dialog.showMessageBox(null, {
            type: 'info', buttons: ['好'], defaultId: 0, title: APP_NAME,
            message: '已修复损坏的插件配置文件并正常启动',
            detail: lines.join('\n\n') + '\n\n修复前的文件已按 .broken-*.bak 备份；你的会话、密钥、设置均未受影响。'
          }).catch(() => {});
        }
        return urlFixed;
      } catch (afterStructural) {
        pushLog('backend start failed after patch structure repair\n');
      }
    } else if (structural) {
      // The loader complained about structure but every layer validates now —
      // someone/something already repaired it; a plain retry is the right move.
      pushLog('自愈：日志报告补丁结构错误，但当前各补丁层校验均通过，直接重试。\n');
      await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 600ms sleep
      try {
        return await spawnBackend();
      } catch (afterRecheck) {
        pushLog('backend start failed after structure re-check retry\n');
      }
    }
  } catch (e) {
    pushLog('补丁结构自愈失败（继续后续自愈）: ' + (e && e.message) + '\n');
  }

  // Escalation 0: home-level patch entries that CONFLICT at the Cordis loader
  // level (duplicate loader id / multi-source client package). These are config
  // problems — profile quarantine and Node repair can never fix them, so
  // handle them FIRST: back up the patch, comment out just the conflicting
  // entries, tell the user, and retry immediately.
  try {
    const conflicts = mgr.analyzeConfigEntryConflicts(p.dshHome, backendLogs.join(''));
    if (conflicts.length) {
      const res = mgr.disableBrokenPatchPlugins(p.dshHome, conflicts);
      const disabledConflicts = (res && res.disabled) || [];
      if (disabledConflicts.length) {
        pushLog(`禁用冲突的插件配置条目：${conflicts.map((c) => `${c.id}（${c.reason}）`).join('；')}，原配置已备份：${res.backup}。\n`);
        try {
          const r0 = await dialog.showMessageBox(null, {
            type: 'warning', buttons: ['继续启动', '退出'], defaultId: 0, cancelId: 1,
            title: APP_NAME,
            message: '已禁用冲突的插件配置条目',
            detail: '以下插件配置与内置组件冲突，已临时禁用，应用将继续启动：\n\n' +
              conflicts.map((c) => `${c.id}：${c.reason}`).join('\n') +
              `\n\n原配置已备份到：\n${res.backup}\n\n如需恢复，请对照备份文件修改 cordis.patch.yml。`
          });
          if (r0.response === 1) { isQuitting = true; app.exit(0); return; }
        } catch {}
        await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
        try {
          pushLog('retrying backend after disabling conflicting patch entries…\n');
          return await spawnBackend();
        } catch (retryErr0) {
          pushLog('backend start failed after conflict disable\n');
        }
      }
    }
  } catch (e) {
    pushLog('conflict analysis failed: ' + (e && e.message) + '\n');
  }

  // Escalation 1a: repair/rebuild custom plugin junctions (a bare-name plugin
  // whose junction or real-dir was lost/misnamed). Cheap and non-destructive —
  // try it before any attribution or quarantine.
  // 0.3.43: 通过阶梯纪律登记（可逆级，无条件允许，但仍留审计轨迹）。
  const v1a = ladderPolicy.attemptStage('1a-junction-repair', { log: (m) => diag(m) });
  ladderPolicy.recordAttempt(ladderTrail, '1a-junction-repair', v1a);
  const fixed = mgr.repairProfileJunctions(p.dshHome);
  if (fixed > 0) {
    pushLog(`自定义插件 junction 修复/重建：${fixed} 项。\n`);
    await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
    try {
      pushLog('retrying backend after junction repair…\n');
      return await spawnBackend();
    } catch (retryErr1a) {
      pushLog('backend start failed after junction repair\n');
    }
  }

  // Escalation 1b: attribute the failure to home-patch plugin entries and
  // disable JUST those — missing source, or a module whose load CRASHES the
  // plugin tree (SyntaxError / missing export: the pet-0.3.1 class that used
  // to fall through to whole-profiles quarantine). Entry-level surgery with
  // backup + dialog, then retry. Runs BEFORE any quarantine so a single
  // broken plugin can never wipe innocent third-party registrations.
  let failingSpecs = [];
  let disabled = [];
  try {
    const analysis = mgr.analyzeBackendFailure(p.dshHome, backendLogs.join(''));
    if (analysis) {
      failingSpecs = analysis.failing || [];
      if (analysis.broken && analysis.broken.length) {
        // 0.3.43: 需点名级 —— 证据就是"日志把这个条目点了出来"。
        const v1b = ladderPolicy.attemptStage('1b-disable-patch-entries', {
          evidence: true, log: (m) => diag(m)
        });
        ladderPolicy.recordAttempt(ladderTrail, '1b-disable-patch-entries', v1b);
        const res = mgr.disableBrokenPatchPlugins(p.dshHome, analysis.broken);
        disabled = (res && res.disabled) || [];
        if (disabled.length) {
          pushLog(`临时禁用无法加载的插件条目：${disabled.join(', ')}（原配置已备份：${res.backup}）。\n`);
          try {
            const r = await dialog.showMessageBox(null, {
              type: 'warning', buttons: ['继续启动', '退出'], defaultId: 0, cancelId: 1,
              title: APP_NAME,
              message: '已临时禁用无法加载的插件条目',
              detail: '检测到以下插件条目导致插件树加载失败，已仅禁用这些条目，其余插件不受影响：\n\n' +
                analysis.broken.map((b) => `${b.id}（${b.reason}）`).join('\n') +
                `\n\n原配置已备份到：\n${res.backup}\n\n修复插件后，用备份文件恢复即可重新启用。`
            });
            if (r.response === 1) { isQuitting = true; app.exit(0); return; }
          } catch {}
        }
      }
    }
  } catch (e) {
    pushLog('plugin disable analysis failed: ' + (e && e.message) + '\n');
  }
  await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep

  if (disabled.length) {
    try {
      pushLog('retrying backend after disabling broken plugin entries…\n');
      return await spawnBackend();
    } catch (retryErr1b) {
      pushLog('backend start failed after plugin entry disable\n');
    }
  }

  // Escalation 1c: PROFILE BUNDLE the log names as failing — the
  // codebuddy-first-bridge@1.1.7 class (client registers a wrong loader id;
  // the combo import fails server-side). These are NOT home-patch entries, so
  // 1b cannot see them, and quarantine would nuke innocent registrations.
  // Remove just the named bundle(s) from dsh.profile.bundles (dependencies
  // stay installed), then retry — never the whole-tree safe mode.
  try {
    failingBundles = mgr.analyzeFailingBundles(p.dshHome, backendLogs.join(''));
    if (failingBundles.length) {
      // 0.3.43: 需点名级 —— 证据是"日志点名了具体 bundle 包"。
      const v1c = ladderPolicy.attemptStage('1c-disable-bundles', {
        evidence: true, log: (m) => diag(m)
      });
      ladderPolicy.recordAttempt(ladderTrail, '1c-disable-bundles', v1c);
      const res1c = mgr.disableFailingBundles(p.dshHome, failingBundles.map((b) => b.name));
      if (res1c.disabled.length) {
        pushLog(`临时禁用加载失败的插件包（仅从加载清单移除，依赖保留）：${res1c.disabled.join(', ')}（备份：${res1c.backup}）。\n`);
        try {
          const r1c = await dialog.showMessageBox(null, {
            type: 'warning', buttons: ['继续启动', '退出'], defaultId: 0, cancelId: 1,
            title: APP_NAME,
            message: '已临时禁用加载失败的插件包',
            detail: '以下插件包导致插件树加载失败，已仅从加载清单移除，其余插件、会话与设置均不受影响：\n\n' +
              failingBundles.map((b) => `${b.name}（${b.reason}）`).join('\n') +
              `\n\n原配置已备份到：\n${res1c.backup}\n\n修复或更新该插件后，把备份中对应的条目加回 profiles/web/package.json 的 dsh.profile.bundles 即可重新启用。`
          });
          if (r1c.response === 1) { isQuitting = true; app.exit(0); return; }
        } catch {}
        await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
        try {
          pushLog('retrying backend after disabling failing bundles…\n');
          return await spawnBackend();
        } catch (retryErr1c) {
          pushLog('backend start failed after bundle disable\n');
        }
      }
    }
  } catch (e) {
    pushLog('bundle disable analysis failed: ' + (e && e.message) + '\n');
  }

  // Escalation 1d (0.3.41): HOME-LEVEL credential document check — the guard that
  // stops the profile-quarantine nuke from firing on a failure it cannot fix.
  // 2026-10-11 incident: `.credentials.yaml` carried `repo-push-access:github.com`
  // where dsh demands `<scope>/<id>`; the credentials plugin threw a TypeError at
  // load, taking 9 dependent plugins with it. The log said only "1 required plugin
  // did not activate" — no package NAME — so 1b/1c attributed nothing and the
  // ladder fell straight through to quarantineProfiles: three profiles burned in
  // one night while the real defect sat outside `profiles/` the whole time.
  // Once the log names a credential key, the failure is provably NOT profile-local:
  // repair the key (backup + atomic write) and retry the backend. Never quarantine.
  //
  // 0.3.42 · 护栏原因集合：任何"已证明根因不在 profiles"的归因都登记在此。
  // 只要集合非空，就绝不允许继续下坠到不可逆的 profile 隔离。
  const guardReasons = new Set();
  let credentialHandled = false;
  try {
    const credDiag = mgr.analyzeCredentialFailure(backendLogs.join(''));
    if (credDiag.credentials) {
      credentialHandled = true;
      // 0.3.42 · 把"守卫原因"从单一布尔升级为集合。护栏的意义是：一旦能证明
      // 根因不在 profiles，就绝不允许阶梯继续下坠到不可逆的 profile 隔离。
      // 集合形态让未来每一种可归因的 home 级故障都能登记自己的理由，而不是
      // 各自发明一个布尔量、彼此覆盖。
      guardReasons.add(`凭据文档故障（键：${credDiag.keys.join('、') || '见日志'}）`);
      // 关键服务包归因：告诉用户"倒下的不只是这一个包，而是它承载的 N 项能力"。
      const attrib = mgr.attributeCriticalFailure(backendLogs.join(''));
      pushLog(`后端启动失败根因：home 级 .credentials.yaml 的凭证键非法（${credDiag.keys.join('、') || '见日志'}）。这不是 profiles 的问题——跳过 profile 隔离，直接修复凭据键。\n`);
      if (attrib.package) {
        pushLog(`受影响面：${attrib.role}（${attrib.package}）加载失败，连带 ${attrib.affectedCount} 项依赖它的能力一起不可用：${attrib.dependents.join('、')}。\n`);
      }
      diag('凭据文档故障归因（护栏触发，阻止 profile 隔离）:', credDiag);
      const pre = mgr.validateCredentialsDocument(p.dshHome);
      const repair = mgr.repairCredentialKeys(p.dshHome, pre.problems);
      if (repair.changed.length) {
        const list = repair.changed.map((c) => `${c.from} → ${c.to}`).join('；');
        pushLog(`已规范化 ${repair.changed.length} 条凭证键：${list}（原文件已备份：${repair.backup}）。\n`);
        try {
          await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
            type: 'warning',
            buttons: ['继续启动'], defaultId: 0, noLink: true,
            title: APP_NAME,
            message: '发现并修复了损坏的凭据配置',
            detail: `凭证文件 .credentials.yaml 里 ${repair.changed.length} 条记录的键不符合 dsh 要求的“<scope>/<id>”格式，正是它导致后端启动失败（与插件、profiles 无关）。\n\n` +
              (attrib.package ? `${attrib.role}是 ${attrib.affectedCount} 项能力的共用依赖，所以它一倒，这些功能会同时不可用；修好键之后它们会一起恢复。\n\n` : '') +
              `已规范化：\n${list}\n\n原文件已备份为：\n${repair.backup}\n\n若你的密钥值本身无误，修复后即可正常启动；无需重装任何插件。`
          });
        } catch {}
        await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
        try {
          pushLog('凭据键修复后重试后端…\n');
          const credUrl = await spawnBackend();
          if (credUrl) return credUrl;
        } catch (credErr) {
          pushLog('凭据键修复后仍启动失败（继续安全的自愈路径，但仍不做 profile 隔离）：' + (credErr && credErr.message) + '\n');
        }
      } else {
        // 日志点名了非法键，但文件里已看不到（可能被 dsh 自己修过）——不要隔离。
        pushLog('日志显示凭据键非法，但当前文件中未发现同类问题（可能已被上游修复）；跳过 profile 隔离以免误伤。\n');
      }
    }
  } catch (e) {
    pushLog('凭据预校验失败（跳过，不影响启动）: ' + (e && e.message) + '\n');
  }

  // Escalation 2 (LAST resort): quarantine the broken profiles dir — dsh
  // rebuilds a fresh tree — but FIRST preserve third-party registrations
  // (bundles / dependencies / profile patches) so a successful rebuild can
  // AUTO-RESTORE them instead of leaving the user to reinstall everything by
  // hand. If the re-merged boot fails, the restore is rolled back and the
  // failure falls through to Node repair.
  // 0.3.41: a credential failure is never profile-local — 1d above already
  // proved it, so quarantine is skipped entirely rather than burning profiles.
  // 0.3.42: 判定改为"护栏原因集合非空"。profile 隔离是**不可逆**操作（会重建
  // 整棵配置树），因此只要有任何一项归因证明根因在 profiles 之外，就必须跳过。
  // 0.3.43: 交给阶梯纪律统一裁决（ladder-policy.js）。不可逆级必须拿到
  // "根因确在此处"的**正面证据**；只有"没找到别的原因"这种消极证据时禁止执行
  // —— 这正是 2026-10-11 直坠并连烧 3 份 profile 的成因。
  //
  // 什么算"根因确在 profiles 内"的正面证据（任一即可）：
  //   a) 日志点名了 profile 内部的包/路径（profiles/ 出现在错误里）
  //   b) profiles 树自身结构性损坏（存在但我们读不了 / 必需的 profile 目录缺失）
  //   c) 日志点名了已知属于第三方 bundle 的失败
  // 反例（**不**构成证据）：只知道"某个必需插件没激活"这类无名失败 —— 10-11 就是
  // 这种情形，根因在 home 层的凭据文档，隔离 profiles 纯属白烧。
  let profileLooksBroken = false;
  let profileEvidenceWhy = '';
  try {
    const joined = backendLogs.join('');
    if (/profiles[\\/]/i.test(joined)) {
      profileLooksBroken = true;
      profileEvidenceWhy = '日志点名了 profiles 内部路径';
    }
    const profilesDir = path.join(p.dshHome, 'profiles');
    if (!profileLooksBroken && fs.existsSync(profilesDir)) {
      try { fs.readdirSync(profilesDir); }
      catch (e) { profileLooksBroken = true; profileEvidenceWhy = 'profiles 目录存在但无法读取（' + e.code + '）'; }
    }
    if (!profileLooksBroken && failingBundles && failingBundles.length) {
      profileLooksBroken = true;
      profileEvidenceWhy = '日志点名了失败的第三方 bundle';
    }
  } catch (e) {
    diag('profile 证据判定异常（按无证据处理）:', e && e.message);
  }
  if (profileLooksBroken) {
    pushLog(`profile 隔离证据：${profileEvidenceWhy}。\n`);
  } else {
    pushLog('profile 隔离证据：无正面证据表明根因在 profiles 内（本轮不会隔离 profile）。\n');
  }
  if (guardReasons.size) {
    pushLog(`已跳过 profile 隔离：${Array.from(guardReasons).join('；')} —— 根因不在 profiles 内，隔离只会白白重建配置。\n`);
    diag('profile 隔离被护栏阻止，原因:', Array.from(guardReasons));
  }
  const quarantineVerdict = ladderPolicy.attemptStage('2-quarantine-profiles', {
    evidence: profileLooksBroken,
    guardReasons: Array.from(guardReasons),
    log: (m) => diag(m)
  });
  ladderPolicy.recordAttempt(ladderTrail, '2-quarantine-profiles', quarantineVerdict);
  if (!quarantineVerdict.allowed) {
    pushLog(`跳过 profile 隔离（${quarantineVerdict.reason}）。\n`);
  }
  const qRes = quarantineVerdict.allowed ? mgr.quarantineProfiles(p.dshHome) : null;
  let booted = false;
  if (qRes && qRes.quarantined) {
    if (!qRes.fallback) {
      pushLog(`旧 profiles 已备份为 ${qRes.name}（未删除），dsh 将重建配置。\n`);
    } else {
      pushLog('旧 profiles 清理完成，dsh 将重建配置。\n');
    }
    await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
    try {
      pushLog('retrying backend after profile quarantine…\n');
      booted = await spawnBackend();
    } catch (retryErr) {
      pushLog('backend start failed after profile quarantine\n');
    }
  }

  if (booted) {
    if (qRes && qRes.registryFile) {
      const restored = mgr.restoreProfileRegistrations(p.dshHome, qRes.registryFile, failingSpecs);
      if (restored.restored.length) {
        pushLog(`自动还原第三方注册：${restored.restored.join(', ')}${restored.skipped.length ? `；跳过失败日志点名的条目（${restored.skipped.join(', ')}）` : ''}，重启验证…\n`);
        await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
        try {
          return await spawnBackend();
        } catch (restoreBootErr) {
          pushLog('还原第三方注册后启动失败，回滚还原。第三方注册仍保存在备份中，可稍后手动恢复。\n');
          mgr.rollbackProfileRestore(p.dshHome, qRes.registryFile);
          await stopBackendAndWait(); // 0.3.44: 原来是 stopBackend() + 固定 800ms sleep
          try {
            pushLog('retrying backend after restore rollback…\n');
            return await spawnBackend();
          } catch (rollbackErr) {
            pushLog('backend start failed after restore rollback\n');
          }
        }
      }
    }
    return booted;
  }

  // Escalation 3: repair Node runtime if spawn still fails — but never for
  // plugin-tree/config load failures: reinstalling Node cannot fix a config
  // error, it would just waste a download of the very same runtime.
  if (/plugin tree failed to load/.test(backendLogs.join(''))) {
    pushLog('跳过 Node 运行时修复：失败源于插件配置加载，与 Node 运行时无关。\n');
    throw firstErr;
  }
  // 0.3.43: 同为不可逆级，交给阶梯纪律裁决。正面证据 = node.exe 缺失/不可执行。
  const nodeEvidence = (() => {
    try { return !fs.existsSync(p.nodeExe); } catch { return false; }
  })();
  const nodeVerdict = ladderPolicy.attemptStage('3-node-repair', {
    evidence: nodeEvidence,
    guardReasons: Array.from(guardReasons),
    log: (m) => diag(m)
  });
  ladderPolicy.recordAttempt(ladderTrail, '3-node-repair', nodeVerdict);
  if (!nodeVerdict.allowed) {
    pushLog(`跳过 Node 运行时修复（${nodeVerdict.reason}）。\n`);
    logLadderTrail(ladderTrail);
    throw firstErr;
  }
  pushLog('attempting Node runtime repair escalation…\n');
  const nodeChanged = await mgr.repairNodeForBackendFailure({
    onLog: (m) => pushLog('[node-repair] ' + m + '\n')
  });
  await stopBackendAndWait(); // 0.3.44: 停稳后再重启（原来 fire-and-forget + 800ms sleep）

  if (nodeChanged) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      pushLog('retrying backend after Node runtime repair…\n');
      return await spawnBackend();
    } catch (retryErr3) {
      pushLog('backend start failed after Node runtime repair\n');
    }
  }

  logLadderTrail(ladderTrail);
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
    mgr.finishPluginIsolation((isolation.entries || []).map((e) => ({ index: e.index, status: 'not-tested' })));
    throw error;
  }
  await stopBackendAndWait(); // 0.3.44: 隔离轮马上要逐个启动后端，必须先停稳
  const statuses = [];
  const entries = isolation.entries || [];
  const total = entries.length;
  let done = 0;
  for (const entry of entries) {
    done++;
    updateSplash(`正在逐个检查插件（${done}/${total}）：${entry.id || '未知插件'}`);
    mgr.enablePluginIsolationEntry(entry.index);
    backendLogs = [];
    try {
      await startBackendWithHealing({ isolationRound: true });
      const pluginText = backendLogs.join('');
      const id = String(entry.id || '').replace(/[^a-z0-9_-]+/gi, (m) => '\\' + m);
      const failed = !!id && new RegExp(`(?:failed|error|cannot|without registering).*${id}`, 'i').test(pluginText);
      statuses.push({ index: entry.index, status: failed ? 'failed' : 'ok' });
      if (failed) pushLog(`插件 ${entry.id} 启动检查失败，将保持禁用（仅此条目，同组插件不受影响）。\n`);
    } catch (error) {
      statuses.push({ index: entry.index, status: 'failed', error: error.message });
      pushLog(`插件 ${entry.id} 启动失败，将保持禁用（仅此条目）：${error.message}\n`);
    }
    await stopBackendAndWait(); // 0.3.44: 原来是 fire-and-forget + 固定 500ms sleep
  }
  const report = mgr.finishPluginIsolation(statuses);
  backendLogs = [];
  updateSplash('正在以兼容插件集启动 DSH…');
  const url = await startBackendWithHealing();
  const failedEntries = (report && report.entries ? report.entries : []).filter((e) => e.status === 'failed');
  if (failedEntries.length) {
    const names = failedEntries.map((e) => e.id || e.name).filter(Boolean);
    setTimeout(() => dialog.showMessageBox(mainWindow, {
      type: 'warning', title: APP_NAME, buttons: ['知道了'],
      message: '部分插件与当前后端不兼容',
      detail: `DSH 已正常启动，但以下插件已保持禁用（逐条检测，仅影响这些条目）：\n\n${names.join('\n')}\n\n插件源码和原配置已保留，可在修复插件后重新启用。`
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
/** Recovery entries that work WITHOUT a running backend. */
function recoveryMenuItems() {
  const diagMod = require('./diag-log');
  const openPath = (p, what) => {
    try { shell.openPath(p); } catch (e) { pushLog(`打开${what}失败: ${e && e.message}\n`); }
  };
  return [
    { label: '查看启动日志', click: () => openPath(diagMod.logFile(), '日志') },
    { label: '查看错误清单', click: () => openPath(diagMod.errorLogFile(), '错误清单') },
    { label: '打开日志目录', click: () => openPath(diagMod.logsDir(), '日志目录') },
    { type: 'separator' },
    { label: '重试启动', click: () => restartApp() },
    {
      label: mgr.safeModeActive() ? '退出安全模式并重启' : '以安全模式重启（仅核心组件）',
      click: () => (mgr.safeModeActive() ? requestExitSafeMode() : requestEnterSafeMode())
    },
    { label: '修复插件配置文件…', click: () => requestPatchRepair() },
    { type: 'separator' },
    {
      label: '打开数据目录（会话/密钥/设置）',
      click: () => { try { openPath(mgr.dshHome(), '数据目录'); } catch {} }
    }
  ];
}

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

  // Backend not up: the tray IS the disaster-recovery console.
  if (bootPhase !== 'running') {
    const failed = bootPhase === 'failed';
    const head = failed
      ? [{ label: '⚠ 后端启动失败 — 可在此自救', enabled: false },
         { label: lastBootError ? `原因：${String(lastBootError).slice(0, 60)}` : '原因见启动日志', enabled: false }]
      : [{ label: '● 正在启动后端…', enabled: false }];
    return [
      ...head,
      { type: 'separator' },
      ...recoveryMenuItems(),
      { type: 'separator' },
      { label: '设置…', click: () => createSettingsWindow(), enabled: failed },
      { label: '打开 DSH Desktop', click: () => showMainWindow() },
      { type: 'separator' },
      autoStartItem,
      { type: 'separator' },
      { label: '退出', click: () => quitApp() }
    ];
  }

  return [
    { label: '设置…', click: () => createSettingsWindow() },
    { type: 'separator' },
    {
      label: mgr.safeModeActive() ? '退出安全模式并重启' : '以安全模式重启（维修）',
      click: () => (mgr.safeModeActive() ? requestExitSafeMode() : requestEnterSafeMode())
    },
    { label: '诊断与自救…', submenu: recoveryMenuItems() },
    { type: 'separator' },
    { label: '打开 DSH Desktop', click: () => showMainWindow() },
    { type: 'separator' },
    autoStartItem,
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ];
}

/** Reflect a new boot phase in the tray (icon tooltip + menu + balloon). */
function setBootPhase(phase, err) {
  bootPhase = phase;
  if (err) lastBootError = err && err.message ? err.message : String(err);
  refreshTray();
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
    const tip = bootPhase === 'running' ? APP_NAME
      : bootPhase === 'failed' ? `${APP_NAME} — 启动失败（右键自救）`
      : `${APP_NAME} — 正在启动…`;
    tray.setToolTip(tip);
  } catch {}
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
  // Refresh the context menu on every right-click so the 开机自启 checkbox and
  // the boot-phase recovery entries always reflect the current state.
  tray.on('right-click', () => refreshTray());
  refreshTray();
  return tray;
}

function showMainWindow() {
  diag('调用 showMainWindow（唤醒主窗口）');
  pendingShowMainWindow = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
    return;
  }
  // Window was actually closed (should not happen while tray is alive); rebuild it.
  if (activeUrl) {
    createMainWindow(activeUrl);
  } else if (splashWindow && !splashWindow.isDestroyed()) {
    if (splashWindow.isMinimized()) splashWindow.restore();
    splashWindow.show();
    splashWindow.setAlwaysOnTop(true);
    splashWindow.focus();
    splashWindow.setAlwaysOnTop(false);
  } else if (bootPhase === 'failed') {
    // Boot never produced a window — re-open the recovery dialog instead of
    // silently doing nothing (the user clicked the tray expecting a response).
    showFatal(lastBootError || new Error('后端启动失败'));
  }
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

/**
 * 主窗口的权限闸门（0.3.44 · 借鉴官方 browser-guests.ts:142-145 的思路，
 * 但**判定依据不同**）。
 *
 * ## 为什么不能照抄官方
 *
 * 官方的写法是全盘拒绝：
 *   setPermissionRequestHandler((_c, _p, cb) => cb(false))
 *   setPermissionCheckHandler(() => false)
 *   setDevicePermissionHandler(() => false)
 *   setDisplayMediaRequestHandler((_r, cb) => cb({}))
 *
 * 但那三段作用在 **browser-guests**（用户打开的任意第三方网页的 webview）上。
 * 我们的主窗口加载的是**自己的后端 Web UI**（127.0.0.1 随机端口）——把全盘
 * 拒绝照搬到主窗口，会**永久废掉所有需要浏览器权限的功能**（麦克风听写、
 * 摄像头、屏幕共享），而且症状是"静默失败、无任何提示"，极难排查。
 *
 * ## 所以按"权限敏感度"分级
 *
 *   · **危险级**（屏幕共享 / display-capture / 剪贴板读取 / 地理位置 / 传感器 /
 *     串口 / USB / HID / MIDI / 空闲检测）：**一律拒绝**并记日志。这些权限要么
 *     等于把用户屏幕内容交给页面，要么在桌面壳里毫无正当用途。
 *   · **可询问级**（麦克风 / 摄像头）：**弹原生确认框**，由用户决定。这类权限
 *     有正当用例（听写、拍照），但**绝不静默授予**——默认拒绝会在用户毫不知情
 *     的情况下被页面反复请求。
 *   · 其余一律拒绝并记日志（默认拒绝，而非默认允许）。
 *
 * @param {Electron.Session} session
 * @param {Electron.WebContents} owner 拥有该 session 的窗口 webContents。
 *   必须由调用方传入 —— 0.3.44 初版在这里直接引用 `win`，而 `win` 只是
 *   createChromiumWindow 的**局部参数**，函数作用域里根本不存在。结果是：
 *   注册阶段一切正常（try/catch 包得住），但页面一旦真的申请任意权限，
 *   Electron 从回调栈上调用它 → ReferenceError: win is not defined →
 *   这是**注册之后**才发生的异常，外层 try/catch 包不住 → 未捕获异常 → 崩溃。
 *   用户表现为「点复制就崩」。教训：**回调里引用的变量必须来自参数或闭包捕获，
 *   不能依赖调用点的局部名**；且"注册成功"不等于"回调可用"。
 */
function applyPermissionGates(session, owner) {
  // 屏幕共享：直接拒绝（回调空对象 = 不提供任何源）。
  // 注意这与"拒绝权限"是两条独立通道，Electron 里必须都设。
  try {
    session.setDisplayMediaRequestHandler((_request, callback) => {
      diag('[权限] 拒绝屏幕共享请求（桌面壳不提供屏幕捕获）');
      callback({});
    });
  } catch (e) { diag('setDisplayMediaRequestHandler 注册失败:', e && e.message); }

  // 设备级权限（USB/串口/HID 等）：一律拒绝。
  try {
    session.setDevicePermissionHandler(() => false);
  } catch (e) { diag('setDevicePermissionHandler 注册失败:', e && e.message); }

  const DANGEROUS = new Set([
    'media', 'display-capture', 'geolocation', 'midi', 'midiSysex',
    'idle-detection', 'hid', 'serial', 'usb',
    'window-management', 'speaker-selection', 'top-level-storage-access'
  ]);

  // 剪贴板权限：**实测**确认 Electron 在 `navigator.clipboard.writeText()` 时
  // 投递的权限名是 `clipboard-read`（不是文档里那个 clipboard-sanitized-write，
  // 实测 readText 与 writeText 都走 clipboard-read，靠权限名无法区分读/写）。
  // 因此把它放进"危险级拒绝"会连**复制按钮**一起废掉——这正是 0.3.44 初版的
  // 第二个缺陷（第一个是 win 未定义导致崩溃）。
  // 正确策略：剪贴板按**来源**判定。本应用自己的回环页面有正当的复制/粘贴需求，
  // 放行；其它来源一律拒绝（非本应用来源在 request 通道已被整体拒绝）。
  const CLIPBOARD = new Set(['clipboard-read', 'clipboard-sanitized-write', 'clipboard-write']);

  function isLoopbackOrigin(u) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(u || ''));
  }

  // 同步检查通道。**必须同步返回**，所以这里只做"是否可能被允许"的粗筛，
  // 真正的授权一律发生在 request 通道（那里才能弹框）。
  try {
    session.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      const p = String(permission || '');
      if (p === 'media' || p === 'audioCapture' || p === 'videoCapture') return true; // 交给 request 通道弹框
      if (CLIPBOARD.has(p)) {
        const origin = requestingOrigin || (wc && wc.getURL && wc.getURL()) || '';
        if (isLoopbackOrigin(origin)) return true;
        diag(`[权限] 同步拒绝非本应用来源的剪贴板访问（${String(origin).slice(0, 80)}）`);
        return false;
      }
      if (DANGEROUS.has(p)) { diag(`[权限] 同步拒绝 ${p}`); return false; }
      diag(`[权限] 同步拒绝未列入白名单的权限 ${p}`);
      return false;
    });
  } catch (e) { diag('setPermissionCheckHandler 注册失败:', e && e.message); }

  // 整个回调体包在 try/catch 内：任何意外都只影响这一次权限判定（拒绝），
  // 绝不允许它把异常抛回 Electron 的回调栈上去 —— 那会直接崩掉主进程。
  try {
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      try {
        const p = String(permission || '');
        const isOurs = !owner || webContents === owner;
        const requestingUrl = (details && details.requestingUrl) ||
          (webContents && webContents.getURL && webContents.getURL()) || '';
        const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(requestingUrl);

        if (!isOurs || !isLoopback) {
          diag(`[权限] 拒绝非本应用来源的 ${p}（${String(requestingUrl).slice(0, 80)}）`);
          return callback(false);
        }

        // 剪贴板：仅本应用回环来源放行（含 writeText 实际投递的 clipboard-read）。
        if (CLIPBOARD.has(p)) {
          if (isLoopbackOrigin(requestingUrl)) return callback(true);
          diag(`[权限] 拒绝非本应用来源的剪贴板访问（${String(requestingUrl).slice(0, 80)}）`);
          return callback(false);
        }

        // 麦克风/摄像头：弹原生确认框，绝不静默授予。
        const isMic = p === 'media' || p === 'audioCapture' || p === 'videoCapture';
        if (isMic) {
          const mediaTypes = (details && details.mediaTypes) || [];
          const label = mediaTypes.includes('video') ? '摄像头' : '麦克风';
          dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
            type: 'question',
            buttons: ['允许', '拒绝'],
            defaultId: 1,
            cancelId: 1,
            title: APP_NAME,
            message: `网页请求使用你的${label}`,
            detail: `来源：${requestingUrl.slice(0, 120)}\n\n` +
            '这是 DSH 的本地后端页面。仅当你要使用语音输入/听写等需要该设备的功能时才允许。\n' +
            '拒绝不会影响其它功能。'
        }).then((r) => {
          const granted = r.response === 0;
          diag(`[权限] 用户${granted ? '允许' : '拒绝'}了${label}请求`);
          callback(granted);
        }).catch((err) => {
          diag('权限确认框失败，按拒绝处理:', err && err.message);
          callback(false);
        });
        return;
      }

      diag(`[权限] 拒绝 ${p}（不在允许列表内）`);
      callback(false);
      } catch (err) {
        // 回调体内部任何异常都只降级为"拒绝本次权限"，绝不抛回 Electron 回调栈
        //（抛回去 = 未捕获异常 = 主进程崩溃，正是 0.3.44 初版「点复制就崩」的原因）。
        diag('权限请求处理异常，按拒绝处理:', err && err.message);
        try { callback(false); } catch {}
      }
    });
  } catch (e) { diag('setPermissionRequestHandler 注册失败:', e && e.message); }
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
  // 显式传入 webContents —— 见 applyPermissionGates 的注释（回调不能依赖调用点局部名）。
  applyPermissionGates(win.webContents.session, win.webContents);

  win.webContents.session.webRequest.onErrorOccurred((details) => {
    diag(`[NET ERROR] ${details.url.slice(0, 120)} -> ${details.error}`);
  });
  win.webContents.session.webRequest.onResponseStarted((details) => {
    if (details.url.includes('/plugins/')) {
      diag(`[NET RESPONSE] ${details.statusCode} ${details.url.slice(0, 120)}`);
    }
  });
  win.webContents.on('console-message', (_e, level, msg, line, src) => {
    diag(`[RENDERER CONSOLE ${level}] ${msg} (${src}:${line})`);
    // 0.3.39 · error 级 console 进有界尾部缓冲 —— 崩溃报告需要「最近的渲染层
    // 错误」，官方 RendererConsoleTail 同款纪律（64KiB 封顶，最旧先丢）。
    if (String(level) === '3') pushRendererConsoleError(`${msg} (${src}:${line})`);
    // Client-module registration failures arrive here while the backend
    // process itself stays healthy — the web UI bricks on its fatal
    // "Failed to load plugins" page and no boot-ladder escalation fires
    // (the codebuddy-first-bridge@1.1.7 incident: backend up, UI dead, and
    // the only escape hatch left was whole-tree safe mode). Triage
    // surgically: disable ONLY the named bundle and relaunch.
    const text = String(msg || '');
    const regFail = /loaded without registering\s+["']?([A-Za-z0-9@_.\/-]+)["']?/i.exec(text)
      || /failed to import loader entry\s+\S+\s*\(\s*([^)\s]+)\s*\)/i.exec(text);
    if (regFail) handleClientBundleFailure(regFail[1]).catch(() => {});
  });

  // 0.3.39 · F12 / Ctrl+Shift+I 切换 DevTools（对齐官方：打包版同样可用，调试
  // 分发的黑盒问题不再需要 --remote-debugging-port）。在输入事件层拦截，
  // 不抢占页面自身的键盘处理。
  //
  // 0.3.44 · 输入法守卫：中文输入法用 **Ctrl+Shift** 切换中英/切换输入法，而这
  // 恰好是 Ctrl+Shift+I 的前缀。用户按 Ctrl+Shift 切输入法时若顺手碰到 I 键，
  // 就会弹出 DevTools —— 表现为"打字打着打着冒出一个开发者窗口"，而且因为
  // 我们拦截在 before-input-event 层，页面拿不到这个键，用户无法从页面侧察觉
  // 原因。官方有专门的 IME 处理路径；我们这里做三件事：
  //   1) 只在**无输入法组合态**时响应（isComposing）
  //   2) 忽略自动重复（长按不该连续开合）
  //   3) 要求事件确实落在页面上（主窗口且未销毁）
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.isAutoRepeat) return;
    if (input.isComposing) return; // 输入法组合中，绝不当作快捷键
    if (win.isDestroyed()) return;
    const key = (input.key || '').toLowerCase();
    const devToolsChord = key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i');
    if (devToolsChord) {
      // 中文输入法下 Ctrl+Shift 是切换键：若此刻正处于中文输入状态，用户按
      // Ctrl+Shift+I 的更可能是"切输入法 + 打了个 i"，而不是要开 DevTools。
      // 用渲染进程报告的组合态再确认一次，避免误触。
      win.webContents.executeJavaScript('!!(window.__dshImeActive || (document.activeElement && document.activeElement.isComposing))')
        .then((composing) => {
          if (composing) { diag('忽略 DevTools 快捷键：输入法组合进行中（防中文输入法误触）'); return; }
          try { win.webContents.toggleDevTools(); } catch {}
        })
        .catch(() => { try { win.webContents.toggleDevTools(); } catch {} });
    }
  });

  win.loadURL(url);

  let displayed = false;
  const doDisplay = () => {
    if (displayed || win.isDestroyed()) return;
    displayed = true;
    closeSplash();
    if (autoStartHidden && !pendingShowMainWindow) {
      pushLog('开机自启动隐藏模式：主窗口已就绪并留在托盘\n');
      return;
    }
    win.show();
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
    pushLog('主窗口已显示并获取焦点\n');
  };

  win.once('ready-to-show', () => {
    diag('窗口 ready-to-show 触发');
    doDisplay();
  });
  // 保底定时器：即使前端渲染滞后或未触发 ready-to-show，2.5秒后强制显示主窗口
  setTimeout(() => {
    if (!displayed && !win.isDestroyed()) {
      diag('ready-to-show 超时，执行保底显示主窗口');
      doDisplay();
    }
  }, 2500);
  // Window-load resilience: the backend binds a fresh random port on every
  // boot (--port 0), so a load that raced a restart just needs to follow the
  // CURRENT address. Auto-retry bounded, main frame only (9/8 17:xx incident:
  // the user's workaround was a manual Ctrl+R — this does it for them).
  let loadRetries = 0;
  win.webContents.on('did-finish-load', () => { loadRetries = 0; });
  win.webContents.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    pushLog(`chromium did-fail-load ${code} ${desc} ${validatedURL || ''}\n`);
    if (code === -3) return; // aborted (normal on redirect/replaced navigation)
    if (!isMainFrame || isQuitting) return;
    if (loadRetries >= 5) return;
    const wait = 1000 * (loadRetries + 1);
    loadRetries++;
    pushLog(`window load failed; retrying with current backend URL in ${wait}ms (attempt ${loadRetries}/5)\n`);
    setTimeout(() => {
      try { if (!win.isDestroyed() && activeUrl) win.loadURL(activeUrl); } catch {}
    }, wait);
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  // Close button (X) hides to tray instead of quitting — DSH is keep-alive.
  // 0.3.39 · 对齐官方 background-close-confirmed：首次隐藏前弹一次**确认**（不
  // 是无声气泡——用户必须知道点 X ≠ 退出），确认一次写 userData 标记，以后
  // 直接隐藏永不再扰；Esc/关弹窗 = 取消，窗口保持可见。
  win.on('close', (e) => {
    if (isQuitting || !tray) return;
    e.preventDefault();
    const doHide = () => {
      win.hide();
      trayHintShown = true;
    };
    if (trayHintShown || closeConfirmRecorded()) { doHide(); return; }
    // 0.3.44 · C1：并发合并。用户连着点两次关闭（或系统连发 close）会弹两个
    // 一模一样的确认框；先弹的那个被回答后，后弹的仍在屏幕上，用户不知道
    // 该点哪个，且两次回答可能互相矛盾（一次确认 + 一次取消）。
    // 与 quit-guard 同样的纪律：确认框同一时刻只允许存在一个。
    if (closeConfirmPending) return;
    closeConfirmPending = true;
    dialog.showMessageBox(win, {
      type: 'info', buttons: ['确认最小化到托盘', '取消'], defaultId: 0, cancelId: 1, noLink: true,
      title: APP_NAME,
      message: '关闭窗口将最小化到系统托盘',
      detail: '正在运行的任务不会中断，会话、草稿与滚动位置都会保留。\n下次可从系统托盘图标重新打开窗口。\n\n确认一次后不再重复询问。'
    }).then((r) => {
      closeConfirmPending = false;
      if (r.response === 0) { recordCloseConfirm(); doHide(); }
      // 取消：窗口保持可见，什么都不做
    }).catch((err) => {
      closeConfirmPending = false;
      // 0.3.44 · C3：弹窗失败时**不再偷偷隐藏窗口**。旧实现在这里 doHide()，
      // 结果是：用户点了关闭 → 确认框因异常没出现 → 窗口却消失了 → 用户
      // 以为程序崩了。窗口消失必须始终是"用户明确确认"的结果。
      diag('关闭确认框显示失败；保留窗口可见（不代替用户做决定）:', err && err.message);
    });
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

async function showFatal(err) {
  diag('启动失败（fatal）:', err);
  setBootPhase('failed', err);
  closeSplash();
  const tail = backendLogs.join('').split(/\r?\n/).filter(Boolean).slice(-30).join('\n');
  let logPath = 'DSH-Desktop-日志.txt';
  try { logPath = diagLog.logFile(); } catch {}

  // 0.3.39 · 对齐官方 crash-report：写独立崩溃报告文件（完整错误+日志尾部+
  // 渲染层错误尾部），启动时清理旧的（只删 crash-*.log，保留 10 份）。
  // 0.3.42 · 落盘加上限（对齐官方 fatal-recovery.ts 的 CRASH_REPORT_WAIT_MS）：
  // 旧实现同步写在弹窗之前，磁盘慢时主进程卡在写入里，恢复弹窗被无限期推迟。
  // 现在超时（1s）就按"没有报告路径"照常弹窗 —— 报告可以缺席，自救入口不行。
  let reportPath = null;
  try {
    reportPath = await crashReport.writeCrashReportBounded({
      source: 'host', phase: 'startup', error: err,
      backendReady: false, backendLogTail: tail,
      rendererConsole: rendererConsoleTail
    });
    if (reportPath) diag('崩溃报告已写入:', reportPath);
    else diag('崩溃报告未在时限内写入（弹窗照常）');
    const pruned = crashReport.pruneCrashReports();
    if (pruned) diag(`已清理 ${pruned} 份旧崩溃报告（保留最新 10 份）`);
  } catch (e) { diag('崩溃报告写入失败（弹窗照常）:', e && e.message); }

  // 0.3.39 · EADDRINUSE 专属恢复（对齐官方）：端口被占意味着另一个 DSH 实例
  // 还在跑 —— 修插件/安全模式都没用，只给「退出其他实例后重启」两个动作。
  const addressInUse = /\blisten EADDRINUSE\b/u.test(String((err && err.message) || err) + tail);

  // Without a tray there is no recovery console at all — keep the old terminal
  // behaviour rather than leaving an invisible, unusable process behind.
  if (!tray || tray.isDestroyed()) {
    dialog.showErrorBox(`${APP_NAME} 启动失败`,
      (addressInUse ? '端口被占用：请先退出其他正在运行的 DSH 实例，再重启本应用。\n\n' : '') +
      crashReport.crashDialogDetail(err && err.stack ? err.stack : String(err), reportPath,
        `完整日志：${logPath}`));
    app.quit();
    return;
  }

  // Tray is alive: stay resident as a recovery console. Exiting here is what
  // used to strand the user — no tray icon, no safe mode, no way back in.
  try {
    tray.displayBalloon({
      iconType: 'error', title: `${APP_NAME} 启动失败`,
      content: '右键托盘图标可查看日志、修复配置或以安全模式重启。'
    });
  } catch {}
  pushLog('启动失败：已保留托盘自救入口（查看日志 / 修复配置 / 安全模式 / 重试启动）。\n');

  // 0.3.39 · 弹窗 detail 有 1200 码元预算（尾部 8 行 + 崩溃报告路径 + 建议），
  // 完整诊断在崩溃报告文件里——不再让长栈撑爆原生弹窗。
  const detail = addressInUse
    ? '端口被占用（listen EADDRINUSE）：很可能是另一个 DSH 实例还在运行。\n' +
      '请先退出它（托盘图标右键 → 退出），再重启本应用。' +
      (reportPath ? `\n\n崩溃报告已写入：${reportPath}` : '')
    : crashReport.crashDialogDetail(
        (err && err.message ? err.message : String(err)) + '\n\n--- 后端日志（末尾）---\n' + tail,
        reportPath,
        '你的会话、密钥、设置都在独立数据目录里，不受影响。\n' +
        `完整滚动日志：${logPath}\n` +
        '关闭此窗口后，右键系统托盘的 DSH 图标随时可以再进这些操作。');

  // 0.3.42 · 恢复动作失败必须被看见（对齐官方 fatal-recovery.ts:93-102 的 for(;;) 重弹）。
  // 旧实现在此处吞掉了所有异常：用户点了"修复插件配置"/"安全模式重启"/"重试"，
  // 若对应动作抛错，弹窗消失、屏幕没有任何变化、也没有新弹窗 —— 用户完全不知道
  // 发生了什么（这是我们自愈体系里最伤信任的一处）。现在把失败原因回灌到
  // message/detail 并重新弹窗，让"失败"本身成为一个可操作的状态。
  let fatalMessage = addressInUse ? '端口被其他 DSH 实例占用' : '后端没能启动 —— 自救入口已就绪';
  let fatalDetail = detail;
  for (;;) {
    let r;
    try {
      r = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
        type: 'error',
        buttons: addressInUse
          ? ['重试启动', '退出']
          : ['查看启动日志', '修复插件配置', '以安全模式重启', '重试启动', '留在托盘稍后处理', '退出'],
        defaultId: 0, cancelId: addressInUse ? 1 : 4, noLink: true,
        title: `${APP_NAME} 启动失败`,
        message: fatalMessage,
        detail: fatalDetail
      });
    } catch (dialogErr) {
      // 连弹窗都开不了（无显示环境等）：记日志后按"留在托盘"处理，不静默退出。
      diag('恢复弹窗无法显示:', dialogErr && dialogErr.message);
      return;
    }
    try {
      if (addressInUse) {
        if (r.response === 1) quitApp(); else await restartApp();
        return;
      }
      switch (r.response) {
        case 0: try { await shell.openPath(logPath); } catch (e) { diag('打开日志失败:', e && e.message); } break;
        case 1: await requestPatchRepair(); break;
        case 2: await requestEnterSafeMode(); break;
        case 3: await restartApp(); break;
        case 4: return; // stay resident; tray remains the recovery console
        case 5: quitApp(); return;
        default: return;
      }
      return;
    } catch (actionErr) {
      // 动作失败：把原因显示给用户并重弹，而不是让弹窗无声消失。
      diag('恢复动作失败:', actionErr);
      fatalMessage = '恢复操作失败';
      fatalDetail = `${(actionErr && actionErr.message) ? actionErr.message : String(actionErr)}\n\n` +
        '你可以重试，或先「查看启动日志」了解细节。你的会话、密钥、设置都在独立数据目录里，不受影响。\n' +
        `完整滚动日志：${logPath}`;
    }
  }
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
          content: `桌面版 ${shellUpdateVersion || '新版本'} 可用。打开托盘菜单中的「设置」可确认下载。`
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
/** 插件安装互斥锁，防止批量导入重复执行。 */
let pluginBusy = false;
let updateStatus = { state: 'idle', percent: 0, message: '未检查更新', detail: '', current: '读取中', latest: '未检查' };
function setUpdateStatus(state, message, percent = updateStatus.percent, detail = updateStatus.detail, versions = {}) {
  updateStatus = { ...updateStatus, ...versions, state, percent: Math.max(0, Math.min(100, percent)), message, detail };
  if (tray && !tray.isDestroyed()) {
    try { tray.setToolTip(`${APP_NAME} · ${message}`); tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate())); } catch {}
  }
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
          content: info.updates.map((u) => `${u.component} → ${u.latest}`).join('；') + '\n打开托盘菜单中的「设置」可确认下载。'
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

// ---------------------------------------------------------------------------
// Settings window — tray「设置…」: update route (official/mirror) + shell/backend config
// ---------------------------------------------------------------------------
let settingsWindow = null;
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 560, height: 720, show: false, resizable: false, maximizable: false, fullscreenable: false,
    title: `${APP_NAME} 设置`, icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#0b1020', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function settingsSnapshot() {
  let versions = null; try { versions = mgr.currentVersions(); } catch {}
  let settings = {}; try { settings = mgr.readSettings(); } catch {}
  let registry = null; try { registry = mgr.registryInfo(); } catch {}
  let nodeDist = null; try { nodeDist = mgr.nodeDistInfo(); } catch {}
  let autoStart = false; try { autoStart = app.getLoginItemSettings().openAtLogin; } catch {}
  let safeMode = false; try { safeMode = mgr.safeModeActive(); } catch {}
  let shellVersion = null; try { shellVersion = app.getVersion(); } catch {}
  return { settings, versions, updateStatus, shellUpdateVersion, shellVersion, registry, nodeDist, autoStart, safeMode };
}

handleIpc('settings:get', () => settingsSnapshot());
handleIpc('settings:set-route', (_e, route) => {
  if (route !== 'official' && route !== 'mirror') return null;
  mgr.writeSettings({ npmRegistry: route });
  const info = mgr.registryInfo();
  pushLog(`更新路线已切换：${info.label}（${info.url}）\n`);
  diag('更新路线设置变更:', info);
  return info;
});
handleIpc('settings:check-updates', async () => {
  if (silentBusy) return { busy: true };
  const info = await checkBackendUpdates({ includeNode: true });
  let registry = null; try { registry = mgr.registryInfo(); } catch {}
  let nodeGate = null;
  try {
    const target = info && info.latest && info.latest.dsh;
    if (target) nodeGate = await mgr.backendEnginesFor(target);
  } catch {}
  return { busy: false, info, status: updateStatus, registry, nodeGate };
});
handleIpc('settings:download-updates', async () => {
  if (silentBusy) return { busy: true };
  const parent = settingsWindow || mainWindow;
  if (updateStatus.state === 'ready') {
    const r = await dialog.showMessageBox(parent, {
      type: 'info', buttons: ['立即重启并更新', '稍后'], defaultId: 0, cancelId: 1,
      title: APP_NAME, message: '更新已就绪',
      detail: (updateStatus.detail || '新版本已下载完成。') + '\n\n重启应用后生效。'
    });
    if (r.response === 0) restartApp();
    return { ok: true };
  }
  const info = await checkBackendUpdates({ includeNode: false });
  if (!info) return { ok: false, msg: '检查更新失败' };
  if (!info.updates || !info.updates.length) {
    if (info.pending && info.pending.length) {
      setUpdateStatus('ready', '更新待重启应用', 100, info.pending.map((p) => `${p.component} ${p.staged}`).join('；'), { current: info.current?.dsh || '未知', latest: info.latest?.dsh || '未知' });
      const r = await dialog.showMessageBox(parent, {
        type: 'info', buttons: ['立即重启并更新', '稍后'], defaultId: 0, cancelId: 1,
        title: APP_NAME, message: '更新已就绪',
        detail: info.pending.map((p) => `${p.component} → ${p.staged}`).join('\n') + '\n\n重启应用后生效。'
      });
      if (r.response === 0) restartApp();
      return { ok: true };
    }
    return { ok: false, msg: '已是最新版本' };
  }
  const lines = info.updates.map((u) => `${u.component === 'dsh' ? 'DSH 后端' : u.component} ${u.current || '无'} → ${u.latest}`);
  if (shellUpdateVersion) lines.push(`DSH Desktop 桌面版 → ${shellUpdateVersion}`);
  const changes = info.updates.flatMap((u) => (u.changes || []).slice(0, 3).map((c) => `· ${c}`));
  const r = await dialog.showMessageBox(parent, {
    type: 'question', buttons: ['下载并更新', '取消'], defaultId: 0, cancelId: 1,
    title: APP_NAME, message: '发现新版本',
    detail: lines.join('\n') + (changes.length ? '\n\n更新内容：\n' + changes.join('\n') : '') + '\n\n是否现在下载更新？下载完成后需要重启应用生效。'
  });
  if (r.response === 0) await stageConfirmedUpdates(info.updates, info);
  return { ok: true };
});
handleIpc('settings:set-autostart', (_e, on) => {
  try { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); pushLog(`auto-start ${on ? 'enabled' : 'disabled'}（设置窗）\n`); return true; } catch { return false; }
});
handleIpc('settings:open-log', () => {
  try { return shell.openPath(require('./diag-log').logFile()); } catch { return 'failed'; }
});
handleIpc('settings:restart-app', () => restartApp());
handleIpc('settings:set-node-dist', (_e, dist) => {
  if (dist !== 'official' && dist !== 'mirror') return null;
  mgr.writeSettings({ nodeDist: dist });
  const info = mgr.nodeDistInfo();
  pushLog(`Node 下载源已切换：${info.label}（${info.url}）\n`);
  return info;
});
handleIpc('settings:check-node', async () => {
  let latest = null, err = null;
  try { latest = await mgr.latestNodeVersion(); } catch (e) { err = (e && e.message) || '网络错误'; }
  const cur = mgr.currentVersions()?.node || null;
  const staged = mgr.stagedVersions()?.node || null;
  const req = mgr.nodeRequirement();
  let dist = null; try { dist = mgr.nodeDistInfo(); } catch {}
  let available = null;
  try { available = await mgr.listNodeVersions(); } catch {}
  let pinnedMajor = null; try { pinnedMajor = parseInt(process.env.DSH_NODE_MAJOR || '24', 10); } catch {}
  return { latest, current: cur, staged, required: req.required, reqOk: req.ok, available, pinnedMajor, err, dist };
});
handleIpc('settings:download-node', async (_e, version) => {
  if (silentBusy) return { busy: true };
  try {
    const res = await mgr.stageNode({ onLog: (m) => pushLog('[node-stage] ' + m + '\n') }, version || null);
    const parent = settingsWindow || mainWindow;
    const r = await dialog.showMessageBox(parent, {
      type: 'info', buttons: ['立即重启并更新', '稍后'], defaultId: 0, cancelId: 1,
      title: APP_NAME, message: 'Node 运行时已暂存',
      detail: `Node v${res.version} 已下载并暂存（当前 ${mgr.currentVersions()?.node || '未知'}），重启应用后生效。`
    });
    if (r.response === 0) restartApp();
    return { ok: true, version: res.version, reused: !!res.reused };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || 'Node 下载失败' };
  }
});

// ---------------------------------------------------------------------------
// 通用剪贴板（供设置窗「插件安装与终端」区复制命令用）
// ---------------------------------------------------------------------------
handleIpc('shell:copy-text', (_e, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return true;
  } catch {
    return false;
  }
});
handleIpc('settings:open', () => {
  createSettingsWindow();
  return true;
});

function scheduleSilentUpdates() {
  // Check-only cadence: announces new versions via the tray, never downloads.
  // First check is early (5s) so the tray shows fresh version data right after
  // a restart that applied an update.
  setTimeout(() => checkBackendUpdates(), 5000);
  setInterval(() => checkBackendUpdates(), 6 * 3600 * 1000);
  // Daily log retention cleanup (archives pruned by count + age).
  setInterval(() => { try { diagLog.housekeep(); } catch (_) {} }, 24 * 3600 * 1000);
}

/**
 * Renderer-side single-bundle triage. The backend process is healthy, but the
 * web UI's combo loader just named a bundle whose client module failed to
 * register — the window is bricked on the "Failed to load plugins" fatal page
 * and no boot-ladder escalation will fire. Disable ONLY that bundle
 * (dependencies stay installed), then relaunch. Guarded once per package per
 * app run so a mis-attribution can never reboot-loop.
 */
const clientDisabledBundles = new Set();
async function handleClientBundleFailure(name) {
  if (!name || clientDisabledBundles.has(name)) return;
  let isBundle = false;
  let paths = null;
  try {
    paths = activePaths();
    const reg = mgr.readProfileRegistry(paths.dshHome, 'web');
    const base = mgr.BASE_BUNDLES || [];
    isBundle = (reg.bundles || []).indexOf(name) !== -1 && base.indexOf(name) === -1;
  } catch { return; }
  if (!isBundle) return; // not a profile bundle — log-only, nothing to triage
  clientDisabledBundles.add(name);
  const res = mgr.disableFailingBundles(paths.dshHome, [name]);
  if (!res || !res.disabled || !res.disabled.length) return;
  pushLog(`插件包 ${name} 客户端注册失败（后端进程正常）。已仅从加载清单移除该插件（依赖保留，其余插件、会话与设置不受影响），备份：${res.backup}。\n`);
  diag('client bundle registration failure — surgically disabled one bundle', { name, backup: res.backup });
  let restart = true;
  if (!autoStartHidden) {
    try {
      const r = await dialog.showMessageBox(null, {
        type: 'warning', buttons: ['立即重启', '稍后手动重启'], defaultId: 0, cancelId: 1,
        title: APP_NAME,
        message: `已临时禁用加载失败的插件包：${name}`,
        detail: '该插件的客户端模块未按加载器约定注册（注册 id 必须与包名一致），已仅从加载清单移除这一个插件，其余插件、会话与设置均不受影响。\n\n' +
          `原配置已备份到：\n${res.backup}\n\n修复或更新该插件后，把备份中对应的条目加回 profiles/web/package.json 的 dsh.profile.bundles 即可重新启用。`
      });
      restart = r.response === 0;
    } catch {}
  }
  if (restart) await restartApp();
}

async function requestEnterSafeMode() {
  const res = mgr.enterSafeMode();
  if (!res || !res.ok) {
    try { dialog.showErrorBox(APP_NAME, '进入安全模式失败：' + ((res && res.msg) || '未知错误')); } catch {}
    return;
  }
  pushLog('进入安全模式：仅核心组件，家级补丁已注释。点击托盘「退出安全模式并重启」可恢复。\n');
  await restartApp(['--safe-mode']);
}

async function requestExitSafeMode() {
  const res = mgr.exitSafeMode();
  pushLog(`退出安全模式，已还原：${((res && res.restored) || []).join('、') || '（无还原项）'}\n`);
  await restartApp();
}

/**
 * Tray-driven repair of the patch layers — the recovery path for a patch file
 * that no longer parses as a top-level YAML array. Reports what it found even
 * when nothing needed fixing, so the user is never left guessing.
 */
async function requestPatchRepair() {
  let repairs = [];
  let err = null;
  try { repairs = mgr.validateAndRepairPatchLayers() || []; }
  catch (e) { err = e; }
  if (err) {
    try { dialog.showErrorBox(APP_NAME, '检查插件配置文件失败：' + (err && err.message)); } catch {}
    return;
  }
  if (!repairs.length) {
    const r = await dialog.showMessageBox(null, {
      type: 'info', buttons: ['好', '仍要重启'], defaultId: 0, cancelId: 0,
      title: APP_NAME,
      message: '插件配置文件结构正常',
      detail: '各补丁层都是合法的顶层数组，没有需要修复的地方。\n\n如果启动仍然失败，问题不在配置结构上，请在托盘菜单选「查看启动日志」查看具体原因。'
    });
    if (r.response === 1) await restartApp();
    return;
  }
  const lines = repairs.map((x) => {
    const how = x.strategy === 'append-empty-array' ? '已补回空数组标记（注释内容全部保留）'
      : x.strategy === 'restore-backup' ? `已回退到最近的可用备份（${x.restoredFrom}）`
      : x.strategy === 'reset-empty' ? '已重置为空补丁层（原内容已备份）' : '未能修复';
    return `${x.file}\n原因：${x.reason}\n处理：${how}`;
  });
  pushLog(`托盘修复：插件配置文件结构已修复 ${repairs.length} 处。\n`);
  const r = await dialog.showMessageBox(null, {
    type: 'info', buttons: ['立即重启', '稍后'], defaultId: 0, cancelId: 1,
    title: APP_NAME,
    message: `已修复 ${repairs.length} 处配置文件结构问题`,
    detail: lines.join('\n\n') + '\n\n修复前的文件已按 .broken-*.bak 备份；会话、密钥、设置均未受影响。建议立即重启以生效。'
  });
  if (r.response === 0) await restartApp();
}

async function restartApp(extraArgs = []) {
  diag('restartApp：准备重启（更新应用流程）');
  isQuitting = true;
  const proc = backend;
  backend = null;
  activeUrl = null;
  if (proc) {
    try { proc.removeAllListeners('exit'); } catch {}
    // 0.3.44: 用统一的"有界停止"取代这里原有的手写等待。语义相同（必须等后端
    // 真的死掉，否则重启后的实例无法把 dsh.new 换名成 dsh —— 文件锁还在），
    // 但收敛到一处实现：温和请求 → 验证退出 → 超时强制 → 再验证。
    const res = await stopBackendBounded(proc, { timeoutMs: 6000, forceTimeoutMs: 5000 });
    diag(`restartApp：后端已停止（${res.how}，${res.ms}ms，forced=${res.forced}）`);
    // Windows 上进程退出与文件句柄真正释放之间有极短间隙，留一点余量。
    await new Promise((r) => setTimeout(r, 400));
  }
  diag('restartApp：app.relaunch + exit');
  // Strip any stale --safe-mode so a normal restart exits safe mode by default.
  const baseArgs = process.argv.slice(1).filter((a) => a !== '--safe-mode');
  app.relaunch({ args: baseArgs.concat(extraArgs || []) });
  app.exit(0);
}

handleIpc('app:get-version', () => app.getVersion());
// 0.3.39 · 设备信息（对齐官方 dshDesktop.deviceInfo()）：平台/OS/架构/CPU/内存，
// 无主机名用户名序列号。
handleIpc('app:device-info', () => { try { return readDeviceInfo(); } catch { return ''; } });
handleIpc('backend:versions', () => { try { return mgr.currentVersions(); } catch { return null; } });
handleIpc('env:isolation', () => { try { return mgr.describeEnvIsolation(); } catch { return null; } });
handleIpc('backend:check-updates', () => checkBackendUpdates({ includeNode: true }));
// 后端全版本列表（npm 已发布全部版本，倒序）+ 当前/暂存/最新。
handleIpc('backend:list-versions', async () => {
  try {
    const info = await mgr.npmDshVersionsAll();
    const cur = mgr.currentVersions()?.dsh || null;
    const staged = mgr.stagedVersions()?.dsh || null;
    return { all: info.all, latest: info.latest, current: cur, staged, engines: info.engines };
  } catch (e) { return { err: (e && e.message) || '获取版本列表失败' }; }
});
// 回退兼容性分析：对目标版本给出各插件可用性判定 + 导出桌面报告。
handleIpc('backend:compat-plan', async (_e, version) => {
  if (!version) return { err: '缺少目标版本' };
  try {
    const plan = await mgr.analyzeBackendRollback(String(version));
    let file = null;
    try { file = mgr.exportBackendCompatReport(plan); } catch (e) { diag('兼容报告导出失败:', e && e.message); }
    diag('回退兼容分析:', { target: version, summary: plan.summary, exported: !!file });
    return { plan, file };
  } catch (e) { return { err: (e && e.message) || '分析失败' }; }
});
// 回退到指定后端版本（暂存 + 重启生效）。
handleIpc('backend:rollback-to', async (_e, version) => {
  if (silentBusy) return { busy: true };
  if (!version) return { ok: false, msg: '缺少目标版本' };
  try {
    const res = await mgr.stageDsh({ onLog: (m) => pushLog('[backend-rollback] ' + m + '\n') }, String(version));
    const parent = settingsWindow || mainWindow;
    const r = await dialog.showMessageBox(parent, {
      type: 'info', buttons: ['立即重启并应用', '稍后'], defaultId: 0, cancelId: 1,
      title: APP_NAME, message: '后端版本已暂存',
      detail: `DSH 后端已暂存为 v${res.version}（当前 ${mgr.currentVersions()?.dsh || '未知'}）。\n\n回退前建议先执行「分析兼容性并导出报告」确认插件情况，重启应用后生效。`
    });
    if (r.response === 0) restartApp();
    return { ok: true, version: res.version, reused: !!res.reused };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || '回退暂存失败' };
  }
});
// ---------------------------------------------------------------------------
// 插件安装 / 终端接线 / 旧 Home 迁移（0.3.32）
//
// 根因：桌面版把后端隔离在 userData/dsh-home，而终端里 npm 全局装的 dsh 默认
// DSH_HOME 是 ~/.dsh —— 照 README 敲 `dsh plugin --profile web add X` 会装进旧
// home，桌面版永远加载不到。下面三条通道保证"命令装插件"这条路本身就正确。
// ---------------------------------------------------------------------------
/** 把安装日志实时推给设置窗（渲染层订阅 plugins:log）。 */
function pushPluginLog(line) {
  try {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('plugins:log', String(line));
  } catch {}
  pushLog('[plugin] ' + line + '\n');
}

// 终端接线总览：DSH_HOME 环境变量 + 包装器 + PATH + 可复制命令。
handleIpc('plugins:terminal-status', () => {
  try {
    const env = mgr.dshHomeEnvStatus();
    const pathSt = mgr.userPathStatus();
    const home = mgr.dshHome();
    return {
      env, path: pathSt, home,
      cmdPwsh: `$env:DSH_HOME='${home}'; dsh plugin --profile web add <插件名>`,
      cmdWrapper: 'dsh-desktop plugin --profile web add <插件名>'
    };
  } catch (e) { return { err: (e && e.message) || '读取终端状态失败' }; }
});

// 写入/移除用户级 DSH_HOME（让 README 原文命令也落到桌面 home）。
handleIpc('plugins:set-dsh-home-env', (_e, enabled) => {
  try {
    const st = mgr.setDshHomeEnv(!!enabled);
    diag('DSH_HOME 用户环境变量:', enabled ? '写入' : '移除', st.current);
    return { ok: true, env: st };
  } catch (e) { return { ok: false, msg: (e && e.message) || '写入环境变量失败' }; }
});

// 生成包装器脚本 + 加入/移出用户 PATH（追加在末尾，不抢占已有全局 dsh）。
handleIpc('plugins:set-path-entry', (_e, enabled) => {
  try {
    const st = mgr.setUserPathEntry(!!enabled);
    diag('包装器 PATH:', enabled ? '加入' : '移出', st.dir);
    return { ok: true, path: st };
  } catch (e) { return { ok: false, msg: (e && e.message) || '修改 PATH 失败' }; }
});

handleIpc('plugins:write-wrappers', () => {
  try { return { ok: true, ...mgr.writeWrapperScripts() }; }
  catch (e) { return { ok: false, msg: (e && e.message) || '生成包装器失败' }; }
});

// 应用内安装插件 —— 唯一保证 DSH_HOME 正确的通道（分发用户无需碰终端）。
handleIpc('plugins:install', async (_e, payload) => {
  const spec = payload && payload.spec;
  const profile = (payload && payload.profile) || 'web';
  if (!spec) return { ok: false, msg: '请填写插件名' };
  if (pluginBusy) return { busy: true };
  pluginBusy = true;
  try {
    pushPluginLog(`开始安装 ${spec}（profile=${profile}，DSH_HOME=${mgr.dshHome()}）`);
    const r = await mgr.installPluginViaCli(spec, { profile, onLog: pushPluginLog });
    diag('插件安装结果:', { spec, profile, ok: r.ok, code: r.code });
    if (r.ok) {
      const parent = settingsWindow || mainWindow;
      const box = await dialog.showMessageBox(parent, {
        type: 'info', buttons: ['立即重启并加载', '稍后'], defaultId: 0, cancelId: 1,
        title: APP_NAME, message: `插件 ${spec} 安装成功`,
        detail: '插件已装入桌面版 DSH_HOME，重启应用后加载生效。'
      });
      if (box.response === 0) restartApp();
    }
    return { ok: r.ok, code: r.code, log: r.log, timedOut: !!r.timedOut };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || '安装失败' };
  } finally { pluginBusy = false; }
});

// 扫描旧 CLI home（~/.dsh）里桌面版看不见的插件。
handleIpc('plugins:scan-legacy', () => {
  try {
    const scan = mgr.scanLegacyHome();
    diag('旧 Home 扫描:', { home: scan.home, exists: scan.exists, orphans: scan.total });
    return { ok: true, scan };
  } catch (e) { return { ok: false, msg: (e && e.message) || '扫描失败' }; }
});

// 勾选导入：逐个走应用内安装流程装进桌面 home，并把报告导出到桌面。
handleIpc('plugins:import-legacy', async (_e, payload) => {
  const items = (payload && payload.items) || [];
  const profile = (payload && payload.profile) || 'web';
  if (!items.length) return { ok: false, msg: '未选择要导入的插件' };
  if (pluginBusy) return { busy: true };
  pluginBusy = true;
  try {
    pushPluginLog(`开始导入 ${items.length} 个插件到桌面 Home…`);
    const summary = await mgr.importLegacyPlugins(items, { profile, onLog: pushPluginLog });
    let file = null;
    try { file = mgr.exportLegacyImportReport(mgr.scanLegacyHome(), summary); } catch (e) { diag('迁移报告导出失败:', e && e.message); }
    diag('旧 Home 导入结果:', { total: summary.total, ok: summary.ok, failed: summary.failed, skipped: summary.skipped });
    if (summary.ok > 0) {
      const parent = settingsWindow || mainWindow;
      const box = await dialog.showMessageBox(parent, {
        type: 'info', buttons: ['立即重启并加载', '稍后'], defaultId: 0, cancelId: 1,
        title: APP_NAME, message: `已导入 ${summary.ok} 个插件`,
        detail: `成功 ${summary.ok} / 失败 ${summary.failed} / 跳过 ${summary.skipped}。\n重启应用后加载生效。${file ? '\n\n报告已导出到桌面。' : ''}`
      });
      if (box.response === 0) restartApp();
    }
    return { ok: true, summary, file };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || '导入失败' };
  } finally { pluginBusy = false; }
});

handleIpc('app:restart', () => restartApp());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    diag('收到 second-instance 多实例唤醒通知', { argv });
    showMainWindow();
  });

  app.whenReady().then(async () => {
    diag('启动流程开始', { hidden: autoStartHidden, packaged: isPackaged, versions: (() => { try { return mgr.currentVersions(); } catch { return null; } })() });
    // 0) Log housekeeping: retention cleanup on every boot (runs again daily via
    //    scheduleSilentUpdates). Logs live in the app logs dir, not the Desktop.
    try { diagLog.housekeep(); } catch (_) {}
    diag('日志目录:', diagLog.logsDir(), '| 错误清单:', diagLog.errorLogFile());
    if (!autoStartHidden) createSplash();
    // 0b) Arm the tray IMMEDIATELY — before anything that can fail. The tray is
    // the disaster-recovery console (logs / retry / safe mode / config repair),
    // so it must exist exactly when boot goes wrong. Previously it was created
    // only after a successful backend start, which is why a failed boot left
    // the user with a fatal dialog and no tray icon at all.
    bootPhase = 'starting';
    try {
      createTray();
      diag('步骤0b 托盘已提前创建（灾备入口就绪）', { hasTray: !!tray });
    } catch (e) {
      diag('步骤0b 托盘提前创建失败:', e && e.message);
    }
    try {
      // 1) Seed writable active dir from factory resources (first run).
      diag('步骤1 初始化活跃目录 ensureSeeded');
      mgr.ensureSeeded();
      // 1b) 终端接线（0.3.32）：始终刷新 dsh-desktop/dsh 包装器脚本（内含固定
      //     DSH_HOME + 桌面版 node），并在"干净机器"（没有在用的 ~/.dsh）上
      //     首次启动写入用户级 DSH_HOME —— 让分发用户照 README 敲命令也落到
      //     桌面 home，不会再装进旧 home 后加载不到。已有旧 home 的机器不擅自
      //     改动，只在设置窗提供开关。
      try {
        mgr.writeWrapperScripts();
        const pre = mgr.preseedDshHomeEnv();
        diag('步骤1b 终端接线:', pre.applied ? `已写入 DSH_HOME=${pre.value}` : `未写入（${pre.reason}）`);
      } catch (e) { diag('步骤1b 终端接线失败（不影响启动）:', e && e.message); }
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
      // 3.2) Safe-mode resolution: --safe-mode keeps the reduced (core-only)
      // profile; a NORMAL launch while a safe-mode marker exists restores the
      // saved originals — a crash inside safe mode can never strand the
      // machine in a stripped state.
      try {
        const sm = mgr.applySafeModeBoot(process.argv);
        safeMode = !!sm.active;
        if (sm.active) { updateSplash('正在以安全模式启动（仅核心组件）…'); pushLog('安全模式：仅加载核心组件，第三方插件已临时停用。\n'); }
        if (sm.exited) pushLog(`已退出安全模式并还原第三方插件：${(sm.restored || []).join('、') || '（无还原项）'}\n`);
      } catch (e) {
        pushLog('安全模式处理失败（按正常启动继续）: ' + (e && e.message) + '\n');
      }
      const shouldIsolatePlugins = !!(applied && applied.dsh) && !safeMode;
      diag('插件隔离流程:', shouldIsolatePlugins ? '本次启动应用了新后端，将执行隔离轮测' : '跳过');
      // 3.5) Recover an INTERRUPTED plugin isolation from a previous run: if
      // the app died mid round-test, the home patch is left "everything
      // commented" and every third-party plugin silently disappears until a
      // manual restore. Complete the old isolation from its saved state —
      // entries proven failed stay disabled, everything else comes back.
      try {
        const rec = mgr.recoverInterruptedIsolation();
        if (rec && rec.recovered) {
          pushLog(`恢复上次未完成的插件隔离：还原 ${(rec.restored || []).length} 条，保持禁用 ${(rec.failed || []).length} 条。\n`);
          updateSplash('已恢复上次未完成的插件隔离…');
        }
      } catch (e) {
        pushLog('恢复未完成插件隔离失败（跳过）: ' + (e && e.message) + '\n');
      }
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
      // 4.4) Agent-preset schema migration: upstream breaking changes (e.g.
      // dsh-persona 0.1.3 renamed text→prefix) would otherwise break session
      // resume with "$.prefix missing required value" until the preset files
      // are edited by hand. Migrate BEFORE the backend serves any session.
      try {
        const mig = mgr.migrateAgentPresetPersonaText();
        if (mig.migrated.length) {
          diag('预设兼容性迁移完成:', mig);
          updateSplash('已自动迁移自定义 Agent 预设格式…');
          pushLog(`预设兼容性迁移：${mig.migrated.length} 个预设的 persona 字段已从旧版 text 迁移为 prefix（原文件已备份）。\n`);
          if (!autoStartHidden) {
            dialog.showMessageBox(null, {
              type: 'info', buttons: ['继续启动'], defaultId: 0, title: APP_NAME,
              message: '已自动迁移自定义 Agent 预设',
              detail: '上游组件 dsh-persona 升级后配置格式变更（text → prefix），你的自定义预设已自动迁移到新格式，会话可正常恢复。\n\n原文件已按 .persona-migrate-*.bak 后缀备份，详情见桌面日志：DSH-Desktop-日志.txt'
            }).catch(() => {});
          }
        }
      } catch (e) {
        pushLog('预设兼容性迁移失败（跳过，不影响启动）: ' + (e && e.message) + '\n');
        diag('预设迁移异常:', e);
      }
      // 4.4) Pre-flight STRUCTURE check: every patch layer must still be a
      // top-level YAML array or the loader refuses to boot at all ("must be a
      // top-level YAML array of loader patch entries"). A comment-only file —
      // what safe mode used to leave behind — parses as null and crashed the
      // backend before any plugin logic ran, which no self-heal escalation
      // could fix. Repair first, then the id-conflict scan below can run.
      try {
        const repairs = mgr.validateAndRepairPatchLayers();
        if (repairs.length) {
          diag('启动预检：补丁文件结构修复', repairs);
          updateSplash('已修复损坏的插件配置文件…');
          for (const r of repairs) {
            const how = r.strategy === 'append-empty-array' ? '补回空数组标记（注释内容全部保留）'
              : r.strategy === 'restore-backup' ? `已回退到最近的可用备份（${r.restoredFrom}）`
              : r.strategy === 'reset-empty' ? '已重置为空补丁层（原内容已备份）' : '未修复';
            pushLog(`启动预检：插件配置文件 ${r.file} 结构损坏（${r.reason}），${how}。\n`);
          }
          if (!autoStartHidden) {
            await dialog.showMessageBox(null, {
              type: 'warning', buttons: ['继续启动'], defaultId: 0,
              title: APP_NAME,
              message: '已修复损坏的插件配置文件',
              detail: repairs.map((r) => {
                const how = r.strategy === 'append-empty-array' ? '已补回空数组标记，注释掉的配置一行没动'
                  : r.strategy === 'restore-backup' ? `已回退到最近的可用备份：${r.restoredFrom}`
                  : r.strategy === 'reset-empty' ? '已重置为空补丁层，原内容完整备份' : '未能修复';
                return `${r.file}\n原因：${r.reason}\n处理：${how}`;
              }).join('\n\n') +
                '\n\n修复前的文件已按 .broken-*.bak 备份，你的会话、密钥、设置均未受影响。'
            }).catch(() => {});
          }
        }
      } catch (e) {
        pushLog('补丁结构预检失败（跳过，不影响启动）: ' + (e && e.message) + '\n');
        diag('补丁结构预检异常:', e);
      }
      // 4.5) Pre-flight: ONE-PASS scan for problems that would crash the cold
      // start. The Cordis loader reports only the FIRST issue it meets, so
      // crash-retry healing surfaces one problem per boot; this scan catches
      // them all up front and fixes them surgically (only the conflicting
      // entry is disabled — sibling entries stay active).
      try {
        const preConflicts = mgr.findLoaderIdConflicts();
        const preResolve = mgr.preflightBareNameResolution() || { repaired: [], broken: [] };
        const repaired = preResolve.repaired || [];
        const allConflicts = preConflicts.concat(preResolve.broken || []);
        if (allConflicts.length || repaired.length) {
          diag('启动预检发现待处理项:', { conflicts: allConflicts, repaired });
          if (repaired.length) {
            updateSplash('已自动修复插件的解析链接…');
            for (const r of repaired) {
              pushLog(`启动预检：插件包 ${r.name} 的安装目录名与包名不一致，已自动建立解析链接（${r.junction}），插件可正常加载。\n`);
            }
          }
          let fix = { fixed: [] };
          if (allConflicts.length) {
            pushLog(`启动预检：发现 ${allConflicts.length} 个问题条目，正在自动处理…\n`);
            fix = mgr.applyLoaderConflictFixes(allConflicts);
            if (fix.fixed.length) {
              updateSplash('已自动禁用冲突的插件配置条目…');
              const total = fix.fixed.reduce((n, f) => n + f.ids.length, 0);
              pushLog(`启动预检：已禁用 ${total} 个问题条目（各文件已备份）。\n`);
            }
          }
          if (!autoStartHidden && (repaired.length || fix.fixed.length)) {
            const repairPart = repaired.length
              ? '已自动修复（插件继续正常加载，无需操作）：\n\n' + repaired.map((r) => `${r.name}：安装目录名与包名不一致，已建好解析链接`).join('\n') + '\n\n'
              : '';
            const disablePart = fix.fixed.length
              ? '已禁用（与内置组件/官方安装重复，或包无法解析；原配置已备份，后缀 .bak）：\n\n' +
                allConflicts.map((c) => `${c.id}：${c.reason}`).join('\n')
              : '';
            const r5 = await dialog.showMessageBox(null, {
              type: fix.fixed.length ? 'warning' : 'info',
              buttons: ['继续启动', '退出'], defaultId: 0, cancelId: 1,
              title: APP_NAME,
              message: fix.fixed.length ? '已处理冲突的插件配置条目' : '已自动修复插件解析',
              detail: repairPart + disablePart +
                '\n\n其余插件不受影响。详情见桌面日志：DSH-Desktop-日志.txt'
            });
            if (r5.response === 1) { isQuitting = true; app.exit(0); return; }
          }
        } else {
          diag('启动预检：无冲突条目');
        }
      } catch (e) {
        pushLog('启动预检失败（跳过，不影响启动）: ' + (e && e.message) + '\n');
        diag('启动预检异常:', e);
      }
      // 4.6) 版本耦合软闸门（0.3.38 / P1-1）：不硬耦合官方的 release.version
      // 强校验。当前 shell × dsh 组合不在「已验证组合」清单时，普通启动一次性
      // 提示（可继续、可不再提醒）；autoStartHidden 只记录，不弹窗。
      try {
        const gate = mgr.comboGateCheck(app.getVersion());
        diag('版本耦合软闸门:', { combo: gate.combo, validated: gate.validated });
        if (!gate.validated && gate.shouldPrompt && !autoStartHidden) {
          const rGate = await dialog.showMessageBox(null, {
            type: 'warning', buttons: ['继续启动', '本次不再提醒该组合'], defaultId: 0, cancelId: 0,
            title: APP_NAME,
            message: '当前外壳与后端组合未经验证',
            detail: `外壳 ${app.getVersion()} × DSH 后端 ${gate.dshVersion || '未知'}\n\n` +
              '该组合不在已验证清单中，可能出现插件不兼容等问题（仍可正常启动）。\n' +
              '如遇异常，可在设置中回退到已验证的后端版本。'
          });
          if (rGate.response === 1) mgr.dismissComboPrompt(gate.combo);
        }
      } catch (e) {
        pushLog('版本耦合软闸门失败（跳过，不影响启动）: ' + (e && e.message) + '\n');
      }

      // 4.7) Python 运行时检测引导（0.3.38 / P0-2）：dsh-skill-office 的 Office
      // 技能需要 Python 3.9+（结构检查仅标准库，生成/编辑需编写库）。后端环境
      // 拿不到时一次性引导，绝不静默；autoStartHidden 只记录。
      try {
        const py = mgr.pythonBootCheck();
        diag('Python 检测:', { available: py.info.available, version: py.info.version, reason: py.info.reason });
        if (py.shouldPrompt && !autoStartHidden) {
          const missing = (py.info.missingAuthoring || []).join('、');
          const detailLines = [];
          if (!py.info.available || !py.info.meetsMinimum) {
            detailLines.push('Office 文档技能（Word/Excel/PowerPoint 的结构检查与生成）需要 Python 3.9 或更高版本。');
            detailLines.push('当前状态：' + py.info.reason);
            detailLines.push('', '安装方式：', '  1) 前往 https://www.python.org/downloads/ 下载 Windows 版；', '  2) 安装时勾选「Add python.exe to PATH」；', '  3) 重启 DSH Desktop。');
          } else {
            detailLines.push(`已检测到 Python ${py.info.version}（${py.info.executable || ''}），但缺少以下编写库：`);
            detailLines.push('  ' + missing);
            detailLines.push('', '在命令行执行：', '  python -m pip install python-docx python-pptx openpyxl Pillow lxml pandas');
          }
          const rPy = await dialog.showMessageBox(null, {
            type: 'warning', buttons: ['知道了', '不再提醒'], defaultId: 0, cancelId: 0,
            title: APP_NAME,
            message: 'Office 技能所需的 Python 环境未就绪',
            detail: detailLines.join('\n')
          });
          if (rPy.response === 1) mgr.dismissPythonPrompt(py.dismissKey);
        }
        if (py.info.available) pushLog(`python gate: ${py.info.version} ${py.info.reason}\n`);
      } catch (e) {
        pushLog('Python 检测失败（跳过，不影响启动）: ' + (e && e.message) + '\n');
      }

      // 4.8) 凭据文档预校验（0.3.41）：home 级 .credentials.yaml 的键格式错误会
      // 让 credentials 插件加载即抛 TypeError，拖垮 9 个依赖插件、整个后端起不来；
      // 而报错文案只有 "N required plugin did not activate"，归因式自愈找不到名字，
      // 会一路升级到 profile 隔离——完全无效且会烧掉用户的插件注册（10-11 事故连烧
      // 三份）。所以在后端启动之前就把这类结构错误摁掉：只做结构扫描，绝不读取或
      // 回显密钥值。
      try {
        const credHome = activePaths().dshHome;
        const credCheck = mgr.validateCredentialsDocument(credHome);
        if (credCheck.present && !credCheck.ok) {
          const items = credCheck.problems.map((p) => `第 ${p.line} 行：${p.key}`).join('\n');
          diag('步骤4.8 凭据预校验发现问题:', credCheck.problems);
          let proceed = true;
          if (!autoStartHidden) {
            const rCred = await dialog.showMessageBox(null, {
              type: 'warning',
              buttons: ['自动修复并继续', '暂时跳过（后端可能无法启动）'],
              defaultId: 0, cancelId: 1, noLink: true,
              title: APP_NAME,
              message: '凭据配置存在格式问题，会导致后端无法启动',
              detail: `文件：${credCheck.file}\n\n不符合 dsh 要求的“<scope>/<id>”格式：\n${items}\n\n` +
                '为什么值得现在处理：这类错误会让 credentials 插件加载失败，连带 9 个依赖插件，' +
                '后端会反复启动失败——而自愈流程看不到插件名，最终会误判为 profiles 损坏并隔离整个 ' +
                'profiles 目录（你的插件注册会一起被搬走）。\n\n' +
                '选择「自动修复」会把这些键的冒号改为斜杠、非法字符改为短横线，并在改动前备份原文件。' +
                '你的密钥值不会被读取、修改或上传。'
            });
            proceed = rCred.response === 0;
          }
          if (proceed) {
            const fix = mgr.repairCredentialKeys(credHome, credCheck.problems);
            if (fix.changed.length) {
              pushLog(`凭据预校验：已规范化 ${fix.changed.length} 条键（${fix.changed.map((c) => `${c.from} → ${c.to}`).join('；')}），备份：${fix.backup}\n`);
              diag('步骤4.8 凭据键已修复:', { count: fix.changed.length, backup: fix.backup });
            } else if (fix.failed.length) {
              // 自动修复失败时给出可执行的手动指引——不要只留一句"后端可能启动失败"。
              const manual = credCheck.problems.map((p) => `  第 ${p.line} 行  ${p.key}  →  ${p.key.split(':').join('/').replace(/\./g, '-')}`).join('\n');
              pushLog('凭据预校验：自动修复失败（' + fix.failed.join('；') + '）。\n');
              if (!autoStartHidden) {
                try {
                  await dialog.showMessageBox(null, {
                    type: 'warning', buttons: ['知道了'], defaultId: 0, noLink: true,
                    title: APP_NAME,
                    message: '凭据配置需要手动修正',
                    detail: `自动修复未能写入文件（${fix.failed.join('；')}）。\n\n` +
                      `请用编辑器打开：\n${credCheck.file}\n\n把下面这些键改成 "斜杠分隔、只含字母数字和短横线" 的写法：\n\n${manual}\n\n` +
                      '改完保存并重启即可。密钥值不需要改动。'
                  });
                } catch {}
              }
            }
          } else {
            pushLog('凭据预校验：用户选择跳过修复，后端可能无法启动。\n');
          }
        } else if (credCheck.present) {
          pushLog('凭据预校验：.credentials.yaml 结构正常。\n');
        }
      } catch (e) {
        pushLog('凭据预校验失败（跳过，不影响启动）: ' + (e && e.message) + '\n');
      }

      // 5) Start backend (self-heals and retries on profile/symlink errors).
      diag('步骤5 启动后端');
      const url = await startBackendWithPluginIsolation(shouldIsolatePlugins);
      diag('步骤5 后端已启动:', url);
      // 6) Show UI + promote the tray to its normal (running) menu.
      await createMainWindow(url);
      createTray();
      setBootPhase('running');
      diag('步骤6 主窗口与托盘就绪');
      // 更新 journal：后端已启动且主窗口加载成功，把 applied 记录推进到
      // verified。一条 applied 却从未 verified 的记录意味着上次更新在验证前
      // 崩溃 —— 这里闭环。
      //
      // 0.3.42 · 补上读取端。此前只写不读：journalUnverified() 全仓唯一引用是
      // 单元测试，0.3.38 建的"崩溃归因证据链"断在最后一步 —— 我们记录了
      // "上次更新没验证通过"，却从来没有人在启动时看过它。现在在推进前先读：
      // 若存在上一轮的 applied 记录，说明**本次启动之前**的更新曾中途失败，
      // 这是导致"版本看起来更新了但行为没变"的一类隐蔽故障，必须留下痕迹。
      try {
        const stale = mgr.journalUnverified();
        if (stale.length) {
          const brief = stale.slice(-3).map((e) => `${e.kind}→${e.to || '?'}(${e.at})`).join('; ');
          diag(`journal：检测到 ${stale.length} 条上次更新未验证的记录（更新可能未真正生效）：${brief}`);
          pushLog(`[journal] ${stale.length} 条 applied 记录在验证前中断：${brief}\n`);
        }
        const nV = mgr.journalMarkVerified();
        if (nV) diag(`journal：${nV} 条 applied 记录已标记 verified`);
      } catch (e) { diag('journal 检查失败:', e && e.message); }
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

  // 0.3.42 · 退出前确认（对齐官方 quit-confirmation.ts）。
  //
  // before-quit 是所有退出路径的唯一汇聚点（托盘「退出」、启动失败弹窗的
  // 「退出」、窗口全关、系统关机）。此前这里无条件杀后端：用户跑着长任务点
  // 退出，任务无声消失、连一句提示都没有（main.js:94 那个
  // QUIT_INSPECT_DEADLINE_MS 常量从未被任何代码读取，就是这段缺失的化石）。
  //
  // 这里拦截第一次 before-quit，问一次；用户确认或选择不再询问后放行。
  // 防重入由 quitGuard 内部处理（合并重复请求，不叠弹窗）。
  app.on('before-quit', (e) => {
    if (isQuitting) { killProcessTree(backend); return; }
    if (quitGuard.settled) { isQuitting = true; killProcessTree(backend); return; }
    // 后端没起来过 / 已不在 ⇒ 没有任何会被中断的东西，不打扰用户。
    if (!backend || backend.exitCode !== null || !activeUrl) {
      isQuitting = true; killProcessTree(backend); return;
    }
    e.preventDefault();
    quitGuard.requestQuit('before-quit').then(() => {
      if (isQuitting) killProcessTree(backend);
    }).catch((err) => {
      diag('退出确认异常，直接退出:', err && err.message);
      isQuitting = true; killProcessTree(backend); app.quit();
    });
  });
  process.on('exit', () => { isQuitting = true; killProcessTree(backend); });
}
