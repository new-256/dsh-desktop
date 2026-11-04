'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, Tray, nativeImage, clipboard, Notification, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const mgr = require('./updater-backend');
const diagLog = require('./diag-log');
const crashReport = require('./crash-report');
const lifecycle = require('./lifecycle-log');
const { createQuitGuard } = require('./quit-guard');
const ladderPolicy = require('./ladder-policy');
// 0.3.48 · H-01/H-03：启动超时与启动恢复的**判定逻辑**全在这个纯函数模块里
// （不 require electron，可在 Node 里直接单测），main.js 只做接线。
const startupDeadline = require('./startup-deadline');
// 0.3.49 · B-05/B-11：导航白名单 / 开窗默认拒 / 外链协议白名单（纯函数，可单测）。
const urlPolicy = require('./url-policy');
// 0.3.49 · B-01：旧后端源遗留 cookie 清理（cookie 忽略端口，端口每次启动都变）。
const sessionHygiene = require('./session-hygiene');
// 0.3.49 · 插件操作台账（task-12 交付）。main.js 只做接线：存储/落盘/崩溃钩子都在模块里，
// 它有 4 路钩子自己 flush，这里**不需要**额外 flush，也绝不在高频日志路径调用。
const pluginJournal = require('./plugin-journal');
const diag = diagLog.write;

/**
 * 桌面日志的**绝对路径**（用户可见文案统一用它）。
 *
 * 0.3.46：此前弹窗里写的是裸文件名「DSH-Desktop-日志.txt」。本机同时存在
 * 两个同名文件 —— 活的在 <安装目录>\logs\，9-10 起就停更的死文件在
 * %APPDATA%\DSH Desktop\logs\。裸文件名会把排查者引到死文件上（这正是
 * 2026-10-20 事故前期走偏的根源之一）。
 */
function desktopLogPath() {
  try { return diagLog.logFile(); } catch {}
  return 'DSH-Desktop-日志.txt';
}

// 0.3.46 · 生命周期台账：本次进程实例的「启动」记录。
//
// 存在的理由（2026-10-20 事故取证盲区）：此前**任何退出路径都不写日志**，
// 于是「应用内静默退出（托盘退出等）」与「外部强杀」在证据上完全等价，事后
// 无法指认是谁杀了旧实例。现在每次启动写一条 start、每次退出写一条带原因的
// exit；有 start 无 exit ⇒ 进程没走到退出路径 ⇒ 外部强杀/断电。
lifecycle.start(process.argv.includes('--hidden') ? 'boot-hidden' : 'boot', { cwd: process.cwd() });

// 任何主进程异常都先落到桌面日志，再向用户展示 —— 不再出现"无声崩溃"。
process.on('uncaughtException', (err) => {
  try { diag('未捕获异常:', err); } catch {}
  try { lifecycle.crash('uncaught-exception', (err && (err.stack || err.message)) || String(err)); } catch {}
  try {
    dialog.showErrorBox('DSH Desktop 主进程异常',
      ((err && (err.stack || err.message)) || String(err)) +
      '\n\n详情已写入桌面日志：' + desktopLogPath());
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

/**
 * 0.3.48 · H-08（含打包后失效的复修）：进程侧 AppUserModelID **必须**与安装器
 * 写进快捷方式的身份一致，否则系统会把托盘气泡当成"另一个应用"而**静默丢弃**
 * （不报错、不进日志，用户永远收不到"有新版本"/"启动失败"的提示）。
 *
 * 为什么身份来自 `./app-identity` 而不是 `package.json`：
 * electron-builder 打包时会重写 app 的 package.json，把 `build` 段整个剥掉
 * （实测成品 asar 内 package.json 仅 503 字节、无 `build`）。旧写法
 * `require('./package.json').<build 字段>` 因此在**开发态正确、成品里恒为
 * undefined** → `setAppUserModelId` 在 shipped 包里从未执行，AUMID 保护空转。
 * 现在身份是随包模块里的常量（`*.js` 已被 build.files 覆盖），且由
 * `scripts/app-identity-gate.js` 机械校验它与安装器身份逐字符相等（不等即
 * 禁止出包），所以"两处写死会漂移"变成构建失败而不是靠记忆。
 *
 * 非法常量会让本 require **直接抛错**（app-identity.js 加载即自检）——
 * 主进程已注册 uncaughtException 处理器，表现为"桌面日志 + 明确错误框 + exit(1)"，
 * 而不是无声崩溃，也不是悄悄变成"没有 AUMID"。
 */
const { DSH_APP_ID } = require('./app-identity');
/** 实际生效的 AUMID（设置抛错时保持 null，日志据此判定"气泡被吞"的风险）。 */
let appUserModelIdApplied = null;
try {
  app.setAppUserModelId(DSH_APP_ID);
  appUserModelIdApplied = DSH_APP_ID;
  // 自证日志：出包后只看这一行就能判断 AUMID 到底有没有生效（B 版复验口径）。
  diag('AppUserModelID 已设置 aumidApplied:true appId=' + DSH_APP_ID + ' 来源=app-identity.js');
} catch (e) {
  // 失败也要可见：这里不退化成"跳过设置"，而是明确记下 aumidApplied:false 与原因，
  // 让"气泡可能被吞"这件事在日志里可归因。
  diag('设置 AppUserModelID 失败 aumidApplied:false appId=' + DSH_APP_ID + ' 原因=' + (e && e.message));
}

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

// ---------------------------------------------------------------------------
// 0.3.49 · 每个窗口能调用哪些通道（阶段一审计遗留：两窗共用一套校验）
//
// 为什么必须按窗口身份分开：设置窗与主窗加载的是**完全不同的文档**，权限面也不同。
// 主窗里跑的是后端 Web UI（会加载第三方插件的前端代码），它**绝不该**能调到
// `plugins:install`（→ pnpm → postinstall = 代码执行）、`plugins:set-path-entry`
// （改用户 PATH）、`backend:rollback-to`（换后端版本）这类设置窗专属能力；反之设置窗
// 也不该调用主窗的通道。0.3.48 之前两边共用"是自家窗口就放行"，等于让插件的前端
// 代码有机会借主窗身份碰设置窗的高危通道（preload 白名单只限制"正常路径"，
// 不限制"页面里被注入的脚本调 ipcRenderer" —— 那正是 H-06 的注入链终点）。
//
// 清单来源必须与 preload 白名单一致：`SETTINGS_WINDOW_CHANNELS` 就是
// `settings-preload.js` 的 ALLOWED_CHANNELS（测试里会交叉核对两份清单，防止漂移）。
// ---------------------------------------------------------------------------
const SETTINGS_WINDOW_CHANNELS = Object.freeze([
  // 更新 / 外壳状态
  'settings:get', 'settings:set-route', 'settings:check-updates', 'settings:download-updates',
  'settings:set-autostart', 'settings:open-log', 'settings:restart-app', 'settings:open',
  // Node 基座
  'settings:set-node-dist', 'settings:check-node', 'settings:download-node',
  // 后端版本
  'backend:list-versions', 'backend:compat-plan', 'backend:rollback-to',
  // 插件安装与终端接线
  'plugins:terminal-status', 'plugins:set-dsh-home-env', 'plugins:set-path-entry',
  'plugins:write-wrappers', 'plugins:install', 'plugins:scan-legacy', 'plugins:import-legacy',
  // 通用剪贴板
  'shell:copy-text'
]);

/** 主窗（后端 Web UI）允许的通道 —— 与 `preload.js` 暴露的 3 个 API 对应，外加后端状态查询。 */
const MAIN_WINDOW_CHANNELS = Object.freeze([
  'app:get-version', 'app:device-info', 'app:restart',
  // 后端运行态查询（updateStatus / 版本 / 环境隔离快照）：主窗专属，设置窗用 settings:* 对应通道
  'backend:check-updates', 'backend:versions', 'env:isolation'
]);

/** 判定某个窗口身份是否允许该通道（纯查表，便于单测与日志）。 */
function channelAllowedForWindow(windowKind, channel) {
  if (windowKind === 'settings') return SETTINGS_WINDOW_CHANNELS.includes(channel);
  if (windowKind === 'main') return MAIN_WINDOW_CHANNELS.includes(channel);
  return false;
}

/**
 * 校验一次 IPC 调用是否来自我们拥有的文档，不是则抛错。
 * @param {Electron.IpcMainInvokeEvent|Electron.IpcMainEvent} event
 * @param {string} channel 仅用于错误信息
 */
function assertOwnedSender(event, channel) {
  const frame = event && event.senderFrame;
  if (!frame) throw new Error(`已拒绝来自未知来源的 IPC（${channel}：无 sender frame）`);
  const senderId = event.sender ? event.sender.id : -1;

  // 0.3.49：先按"究竟是哪个窗口"判定，再按窗口身份查通道权限。
  const fromMain = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId);
  const fromSettings = !!(settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents.id === senderId);
  if (!fromMain && !fromSettings) {
    throw new Error(`已拒绝来自非本应用窗口的 IPC（${channel}）`);
  }
  const windowKind = fromSettings ? 'settings' : 'main';
  if (!channelAllowedForWindow(windowKind, channel)) {
    // 这是一条**真实缺陷**信号（被注入的脚本试图越权），必须可见可归因。
    diag(`已拒绝越权 IPC：${windowKind} 窗不得调用 ${channel}`);
    throw new Error(`已拒绝越权 IPC：${windowKind === 'settings' ? '设置' : '主'}窗口不得调用 ${channel}`);
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
    try { lifecycle.exit('tray-quit', '用户从系统托盘选择「退出」'); } catch {}
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
// ── 0.3.48 · H-03 · 启动阶段打点与超时预算 ────────────────────────────────
// 为什么需要打点：0.3.47 的启动链没有任何时间信息，超时/失败时只能回答"没起来"，
// 回答不了"卡在哪一步、等了多久"。打点是纯内存的几十个字节，却能让事后复盘
// 一眼看到 ready → seeded → applied → spawn → url-ready → health-ok → loaded
// 这条时间线断在哪（超时弹窗里也会原样带上）。
const bootTrace = startupDeadline.createTrace({ now: () => Date.now() });

/** 启动超时预算（环境变量可覆盖；非法值不静默容忍，见 startup-deadline.js）。 */
let startupBudgetCache = null;
function startupBudgets() {
  if (startupBudgetCache) return startupBudgetCache;
  const resolved = startupDeadline.resolveBudgets(process.env);
  startupBudgetCache = resolved.budgets;
  diag('启动超时预算:', resolved.budgets, '| 来源:', resolved.source);
  if (resolved.errors.length) {
    // 配置错必须被看见：否则"我明明设了 300s"会变成查不出来的谜。
    diag('启动超时环境变量有误（已按默认值继续）:', resolved.errors);
    pushLog('启动超时环境变量有误（已按默认值继续）：' + resolved.errors.join('；') + '\n');
  }
  return startupBudgetCache;
}

let paintWatchdog = null;

/**
 * 0.3.48 · H-08：唯一主动通知通道（托盘气泡）的**统一出口**。
 *
 * 为什么需要一个出口：Win10/11 上未设置 AUMID（或 AUMID 与安装器身份不一致）的
 * 进程调用托盘气泡时，系统会**静默丢弃** —— 不抛错、不返回失败，代码无从得知。
 * 于是"用户没收到更新提示"这件事在事后完全无法判定是"没发"还是"被吞"。
 *
 * 这里的做法不是猜，而是**取证**：
 *   1) 每次发送都写一条诊断日志（含 AUMID 与实际生效状态）；
 *   2) 监听 Electron 的 `balloon-show`（气泡真的显示时才触发）——
 *      1.5s 内没等到，就如实记为"疑似被系统吞掉"；
 *   3) 只有在**观察到没显示**时才改用可验证的 Notification 通道补一次
 *      （同一语义、无二次确认，绝不引入新的确认流程）；托盘入口始终保留。
 */
function notificationSupported() {
  try {
    return typeof Notification !== 'undefined' && typeof Notification.isSupported === 'function'
      ? !!Notification.isSupported()
      : false;
  } catch (e) {
    diag('探测 Notification 支持性失败:', e && e.message);
    return false;
  }
}

/** 托盘气泡不可用时的替代通道（Windows Toast）；不可用时如实记录，不假装发过。 */
function deliverFallbackNotification(title, content, why) {
  if (!notificationSupported()) {
    diag('替代通知通道不可用（Notification.isSupported=false），本条通知仅落日志:', { title, why });
    return false;
  }
  try {
    new Notification({ title: String(title), body: String(content), silent: false }).show();
    diag('已改用 Notification 通道发送通知:', { title, why });
    return true;
  } catch (e) {
    diag('Notification 通道发送失败（本条通知仅落日志）:', { title, why, error: e && e.message });
    return false;
  }
}

function notifyUser(title, content, opts = {}) {
  const iconType = opts.iconType || 'info';
  const base = { title, content, aumid: appUserModelIdApplied, platform: process.platform };
  const silentDropRisk = process.platform === 'win32' && !appUserModelIdApplied;

  if (!tray || tray.isDestroyed()) {
    diag('托盘气泡未发出（托盘不存在），改用替代通道:', { ...base, silentDropRisk });
    const sent = deliverFallbackNotification(title, content, 'no-tray');
    return { channel: sent ? 'notification' : 'none', confirmed: false };
  }

  let shown = false;
  const onShown = () => { shown = true; };
  try { tray.once('balloon-show', onShown); } catch (e) { diag('监听 balloon-show 失败（无法确认气泡是否显示）:', e && e.message); }

  try {
    tray.displayBalloon({ iconType, title, content });
    diag('托盘气泡已发出:', { ...base, silentDropRisk: silentDropRisk ? '高（未设置 AUMID，系统可能静默丢弃）' : '低（AUMID 已设置）' });
  } catch (e) {
    // 气泡 API 直接抛出 = 通道确实不可用：这是可观测失败，必须补通道 + 记录。
    diag('托盘气泡发送抛错（通道不可用）:', { ...base, error: e && e.message });
    try { tray.removeListener('balloon-show', onShown); } catch (err) { diag('移除 balloon-show 监听失败:', err && err.message); }
    const sent = deliverFallbackNotification(title, content, 'balloon-threw');
    return { channel: sent ? 'notification' : 'balloon-failed', confirmed: false };
  }

  setTimeout(() => {
    try { if (tray && !tray.isDestroyed()) tray.removeListener('balloon-show', onShown); } catch (e) { diag('移除 balloon-show 监听失败:', e && e.message); }
    if (shown) {
      diag('托盘气泡已由系统确认显示（balloon-show 已触发）:', base);
      return;
    }
    // 观察结论：这次气泡没有显示。换成可验证的通道补发一次，并记录这次对照结果 ——
    // 这正是 H-08 说的"AUMID 设置前后的行为差异"，它是实测出来的，不是猜的。
    diag('托盘气泡未收到 balloon-show 确认（已设置 AUMID 的前提下仍疑似被系统丢弃）:', base);
    deliverFallbackNotification(title, content, 'balloon-unconfirmed');
  }, 1500);

  return { channel: 'balloon', confirmed: null };
}

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

/**
 * 0.3.48 · H-02：把 `spawnBackend()` 里**同步就可能抛错**的部分集中到这里。
 *
 * 为什么要抽出来：旧实现的 `new Promise(async (resolve, reject) => {...})` 让
 * executor 变成 async 函数 —— 函数体里同步抛出的异常只会 reject **那个被丢弃的
 * 内部 Promise**，外层 Promise 既不 resolve 也不 reject，于是整条启动链永久
 * pending、`showFatal` 永不执行。把同步准备收进一个普通（非 async）函数，
 * 外层就能用一个 try/catch 显式 reject，从结构上消灭这个反模式。
 *
 * 可能抛出（每条都实测过是同步抛出，不是 Promise 拒绝）：
 *   · `mgr.buildDedicatedEnv()` → 内部 `mkdirSync`（%APPDATA% 权限/磁盘满/杀软拦截）
 *   · `spawn()` → EACCES / EPERM（node.exe 被杀软锁住或被替换中断）
 */
function prepareBackendSpawn() {
  const p = activePaths();
  if (!fs.existsSync(p.nodeExe)) throw new Error('缺少 Node 运行时：未找到活跃 node.exe（seed 失败）。');
  if (!fs.existsSync(p.dshBin)) throw new Error('缺少 DSH 后端：未找到活跃 dsh（seed 失败）。');

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
  return { child, nodeExe: p.nodeExe, dshHome: p.dshHome };
}

/**
 * Spawn the bundled backend from the active user-writable dir, with an isolated
 * DSH_HOME so it never collides with the user's CLI `~/.dsh` (and its symlink
 * state is fully owned by this app). Returns a promise resolving to the URL.
 *
 * 0.3.48 · H-02/H-03 两条结构性修改：
 *   · executor 是**同步**函数，同步准备失败一律显式 `reject`（不再有哑掉的
 *     async executor）；监听器注册也包在 try 里，同步抛错同样 reject。
 *   · 两个阶段各有 deadline：等地址（spawn）与等 HTTP 响应（health）。
 *     超时不是吞错误，而是把"静默挂起"变成带阶段名 + 最后一条日志 + 日志
 *     绝对路径的失败，然后走既有的 `showFatal()` 路径。
 */
function spawnBackend() {
  return new Promise((resolve, reject) => {
    let prepared;
    try {
      prepared = prepareBackendSpawn();
    } catch (err) {
      diag('后端进程准备失败（同步阶段，已显式 reject 外层）:', err && (err.stack || err.message));
      reject(err);
      return;
    }

    const { child, nodeExe, dshHome } = prepared;
    backend = child;
    pushLog(`starting backend: node=${nodeExe} DSH_HOME=${dshHome} host=127.0.0.1 port=0\n`);
    bootTrace.mark(startupDeadline.PHASES.SPAWN, `pid=${child.pid}`);

    const budgets = startupBudgets();
    let settled = false;
    let urlSeen = false;
    let spawnWatchdog = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (spawnWatchdog) { spawnWatchdog.stop(); spawnWatchdog = null; }
      fn(value);
    };

    /** 采集一份超时现场（阶段/耗时/打点/最后一条日志/日志绝对路径）。 */
    const timeoutReport = (phase, elapsedMs) => startupDeadline.buildTimeoutReport({
      phase,
      budgets,
      elapsedMs,
      trace: bootTrace,
      lastLogLine: startupDeadline.lastMeaningfulLogLine(backendLogs),
      logPath: desktopLogPath()
    });

    try {
      // H-03 阶段一：等后端打印监听地址。0.3.47 在这里没有任何上限 —— 后端一旦
      // "既不打印也不退出"，启动链就永久停在启动画面。
      spawnWatchdog = startupDeadline.createWatchdog({
        phase: startupDeadline.PHASES.SPAWN,
        budgetMs: budgets.spawn,
        now: () => Date.now(),
        setTimer: setTimeout,
        clearTimer: clearTimeout,
        onExpire: (expired) => {
          const err = startupDeadline.createTimeoutError(timeoutReport(expired.phase, expired.elapsedMs));
          diag('启动超时（spawn 阶段）:', err.message);
          // 先把卡住的后端杀掉：它占着端口与文件锁，不清掉会让下一级自愈重试
          // 也一起失败（旧实现走不到这里，因为旧实现根本没有超时分支）。
          try { killProcessTree(child); } catch (e) { diag('超时清理后端进程失败:', e && e.message); }
          settle(reject, err);
        }
      });
      spawnWatchdog.start();

      const onUrl = (line) => {
        const m = /dsh web:\s*(https?:\/\/[^\s]+)/i.exec(line);
        if (!m) return;
        if (settled || urlSeen) return;
        urlSeen = true;
        const url = m[1].trim();
        if (spawnWatchdog) { spawnWatchdog.stop(); spawnWatchdog = null; }
        bootTrace.mark('url-ready', url);
        waitForServer(url, budgets.health, (ok) => {
          if (ok) {
            activeUrl = url;
            bootTrace.mark('health-ok', url);
            settle(resolve, url);
            return;
          }
          // H-03 阶段二：地址已打印但 HTTP 不响应 —— 与"没打印地址"是两个不同
          // 故障（进程活着但不可用），所以错误码也必须不同。
          const err = startupDeadline.createTimeoutError(timeoutReport(startupDeadline.PHASES.HEALTH, budgets.health));
          diag('启动超时（health 阶段）:', err.message);
          try { killProcessTree(child); } catch (e) { diag('超时清理后端进程失败:', e && e.message); }
          settle(reject, err);
        });
      };

      child.stdout.on('data', (d) => { const t = d.toString(); pushLog(d); t.split(/\r?\n/).forEach(onUrl); });
      child.stderr.on('data', (d) => { pushLog(d); });
      child.on('error', (err) => { settle(reject, err); });
      child.on('exit', (code, signal) => {
        if (!settled) {
          settle(reject, new Error(`后端进程提前退出（code=${code} signal=${signal}）。\n\n` +
            backendLogs.join('').split(/\r?\n/).slice(-30).join('\n')));
          return;
        }
        // Backend died after boot. A controlled stop clears `backend` before
        // killing, so only an exit of the CURRENT active instance is a crash.
        pushLog(`backend exited after boot code=${code} signal=${signal}\n`);
        if (!isQuitting && backend === child) handleBackendCrashed();
      });
    } catch (err) {
      // 注册监听本身失败（例如 stdio 管道已被销毁）：同样是同步错误，必须
      // reject 外层而不是让它冒泡成一个无人处理的异常。
      diag('后端监听器注册失败:', err && (err.stack || err.message));
      try { killProcessTree(child); } catch (e) { diag('清理后端进程失败:', e && e.message); }
      settle(reject, err);
    }
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
          if (r0.response === 1) { isQuitting = true; try { lifecycle.exit('user-exit-dialog', '启动预检冲突弹窗选择「退出」'); } catch {} app.exit(0); return; }
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
            if (r.response === 1) { isQuitting = true; try { lifecycle.exit('user-exit-dialog', '插件条目禁用弹窗选择「退出」'); } catch {} app.exit(0); return; }
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
      // 0.3.49 · 台账：自愈 1c 禁用了哪些包（启动期，reason=ELOADFAIL）
      for (const name of (res1c.disabled || [])) {
        recordPluginJournal({ action: 'disable', plugin: name, source: 'profile', phase: 'startup', result: 'ok', reason: 'ELOADFAIL' });
      }
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
          if (r1c.response === 1) { isQuitting = true; try { lifecycle.exit('user-exit-dialog', '插件包禁用弹窗选择「退出」'); } catch {} app.exit(0); return; }
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
  // 0.3.49 · 阶段一审计遗留：隔离结果不再只写日志。
  // `abandoned=true` 或发生过 `restore` 时，用户有权知道"这轮隔离被放弃了 / 已还原"，
  // 否则他们只会看到"插件好像还是不对劲"而完全不知道系统做过什么。
  recordIsolationOutcome(qRes);
  recordQuarantineJournal(qRes);
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
        // 0.3.49 · 台账：隔离后自动还原第三方注册（逐条；这是"隔离--重建--还原"闭环的还原段）
        for (const name of restored.restored) {
          recordPluginJournal({ action: 'restore', plugin: name, source: 'profile', phase: 'startup', result: 'ok', reason: 'EPROFILE-QUARANTINE' });
        }
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
    if (r.response === 0) restartApp(); else { isQuitting = true; try { lifecycle.exit('backend-crashed-close', '后端异常退出后用户选择关闭'); } catch {} app.quit(); }
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480, height: 320, frame: false, resizable: false, center: true, show: true,
    backgroundColor: '#0b1020', icon: path.join(__dirname, 'assets', 'icon.png'),
    // 0.3.49 · B-05：splash 也开 sandbox（它只显示静态 HTML，没有任何 IPC/Node 需求）。
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
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
  try { lifecycle.exit('quit-app', '应用退出'); } catch {}
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  killProcessTree(backend);
  app.quit();
}

/**
 * 0.3.49 · B-05/B-11：给窗口装上"导航白名单 + 开窗默认拒"。
 *
 * 为什么两个窗口都要调：0.3.48 只有主窗调过，设置窗**根本没有**这层处理器 ——
 * 而设置窗握着最高权限的一批通道，它才是最不该能被导航跑掉的那个窗口。
 *
 * 判定本身在 `url-policy.js`（纯函数、可单测）；这里只提供"当前窗口属于谁"的
 * 上下文并执行副作用：
 *   · 导航：不在白名单 → `preventDefault()` + 诊断日志（记录被拦的目标）。
 *   · 开窗：默认 deny；只有白名单协议的外链才交给系统（`shell.openExternal`）。
 *
 * @param {Electron.BrowserWindow} win
 * @param {{kind: 'main'|'settings', allowedFileRoots?: string[], ownUrl?: string}} options
 *   `ownUrl`：建窗时即将加载的地址。用它兜底"当前 origin"——建窗发生在
 *   `activeUrl` 赋值之前（或之后被清空）时，判定不能因此退化成"什么都不允许"。
 */
function applyWindowHandlers(win, options) {
  const o = options || {};
  const kind = o.kind || 'main';
  const allowedFileRoots = Array.isArray(o.allowedFileRoots) && o.allowedFileRoots.length
    ? o.allowedFileRoots
    : [__dirname];
  const currentOrigin = () => {
    if (kind !== 'main') return 'file://';
    return urlPolicy.originOf(activeUrl || '') || urlPolicy.originOf(o.ownUrl || '');
  };

  win.webContents.on('will-navigate', (event, target) => {
    const decision = urlPolicy.decideNavigation({ target, currentOrigin: currentOrigin(), allowedFileRoots });
    if (decision.allow) return;
    event.preventDefault();
    diag(urlPolicy.describeDecision(`will-navigate(${kind})`, target, decision));
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    const decision = urlPolicy.decideWindowOpen({
      target,
      currentOrigin: currentOrigin(),
      externalHostAllowlist: externalHostAllowlist()
    });
    diag(urlPolicy.describeDecision(`window-open(${kind})`, target, decision));
    if (decision.action !== 'open-external') return { action: 'deny' };
    // 交给系统浏览器/邮件客户端；openExternal 失败必须留痕，不许静默。
    Promise.resolve(shell.openExternal(decision.url))
      .catch((e) => diag('openExternal 失败:', { url: decision.url, error: e && e.message }));
    return { action: 'deny' };
  });
}

/**
 * 0.3.49 · B-05：读回 Electron **实际生效**的 webPreferences 并落盘。
 *
 * 为什么不用自己写进去的字面量做证据：`sandbox: true` 被忽略的情况（例如子窗口
 * 使用了 `nativeWindowOpen`、或将来有人把某处配置改成继承父窗）在源码里看不出来。
 * `getLastWebPreferences()` 拿的是渲染进程真正用到的那份配置，因此它是"真机证据"
 * 里最关键的一行。API 不可用时如实记录"读不到"，绝不假装成功。
 *
 * @param {Electron.BrowserWindow} win
 * @param {string} kind 'main' | 'settings' | 'splash'
 */
function logEffectiveWebPreferences(win, kind) {
  try {
    const wc = win && win.webContents;
    if (!wc || typeof wc.getLastWebPreferences !== 'function') {
      diag(`窗口安全配置（${kind}）：getLastWebPreferences 不可用（Electron 版本差异），无法读回实际生效值`);
      return null;
    }
    const used = wc.getLastWebPreferences() || {};
    const snapshot = {
      window: kind,
      sandbox: used.sandbox === undefined ? null : !!used.sandbox,
      contextIsolation: used.contextIsolation === undefined ? null : !!used.contextIsolation,
      nodeIntegration: !!used.nodeIntegration,
      webSecurity: used.webSecurity === undefined ? null : !!used.webSecurity
    };
    diag('窗口安全配置（读回 Electron 实际生效值）:', snapshot);
    return snapshot;
  } catch (e) {
    diag(`窗口安全配置（${kind}）读回失败:`, e && e.message);
    return null;
  }
}

/** 外链主机允许清单（可选收紧；未配置则按协议/凭据/ASCII 判定）。 */
let externalAllowlistCache = null;
function externalHostAllowlist() {
  if (!externalAllowlistCache) externalAllowlistCache = urlPolicy.resolveExternalHostAllowlist(process.env);
  return externalAllowlistCache;
}

/**
 * 0.3.49 · B-01：清理本应用 session 里属于旧后端源的 cookie。
 *
 * 为什么放在 main.js 而不是模块里：清理的**判定**（哪些算"我们的旧 cookie"）在
 * `session-hygiene.js` 里且可单测；这里只提供 Electron session、决定主机/前缀口径、
 * 并把结果写进两处日志。
 *
 * 失败策略（不做假动作）：清理失败**不阻断启动**（启动比 cookie 重要），但必须
 * 让失败可见 —— 诊断日志 + 后端日志各一条，写明扫描/清除/保留/失败条数。
 */
async function cleanLegacyBackendCookies() {
  const policy = {
    // 后端恒定监听回环；这三个主机名覆盖 127.0.0.1 / localhost / ::1 三种写法。
    hosts: sessionHygiene.LOOPBACK_HOSTS,
    namePrefixes: sessionHygiene.resolveNamePrefixes(process.env),
    purgeAllOnLoopback: sessionHygiene.shouldPurgeAllLoopback(process.env)
  };
  try {
    const hygiene = sessionHygiene.createCookieHygiene({
      session: session.defaultSession,
      log: (message, detail) => diag(message, detail)
    });
    const result = await hygiene.clean(policy);
    bootTrace.mark('cookies-cleaned', `removed=${result.removed.length}`);
    const line = sessionHygiene.summarizeResult(result);
    pushLog(line + '（cookie 忽略端口：旧端口的 cookie 会串到本次新端口）\n');
    if (result.failed.length || result.stillThere.length) {
      // 失败与"删了但还在"都要显式上报（不是静默跳过）。
      diag('旧后端 cookie 清理未完全成功:', {
        failed: result.failed,
        stillThere: result.stillThere.map((c) => `${c.domain}|${c.name}`),
        policy
      });
      pushLog('旧后端 cookie 清理未完全成功：见诊断日志（重启后首次加载可能仍带旧登录态）\n');
    }
    return result;
  } catch (e) {
    diag('旧后端 cookie 清理失败（不阻断启动，但可能残留旧登录态）:', e && e.stack ? e.stack : e);
    pushLog(`旧后端 cookie 清理失败：${e && e.message}（不阻断启动）\n`);
    return null;
  }
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
    // 0.3.49 · B-05：sandbox:true —— 渲染进程拿不到任何 Node/原生能力。
    // preload.js 只 require('electron') 的 contextBridge/ipcRenderer + 读 process.platform，
    // 两者在 sandbox 下都可用（实测见审计"功能清单"）。
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  Menu.setApplicationMenu(null);
  applyWindowHandlers(win, { kind: 'main', allowedFileRoots: [__dirname], ownUrl: url });
  logEffectiveWebPreferences(win, 'main');
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

  // 0.3.46 · 渲染层「非正常消失」的取证（对齐官方 main.ts:1110-1118 的
  // render-process-gone / preload-error 两个监听，我们此前完全缺失）。
  //
  // 意义：渲染进程被 OOM / 被系统杀掉 / 加载器崩了，**主进程毫发无损** ——
  // 此前这类事件不留任何痕迹，页面直接空白，用户看到的只是"窗口白了"，
  // 事后无法判断是渲染层崩了还是后端死了。现在：
  //   · 写进退出原因台账（可与「外部强杀」区分开）；
  //   · 写一份独立崩溃报告（保留 reason / exitCode 等字段）。
  win.webContents.on('render-process-gone', (_e, details) => {
    const info = {
      reason: details && details.reason,
      exitCode: details && details.exitCode,
      killed: !!(details && details.killed),
    };
    diag('[RENDERER GONE]', info);
    try { lifecycle.crash('renderer-gone', JSON.stringify(info)); } catch {}
    try {
      crashReport.writeCrashReport({
        source: 'renderer', phase: 'running',
        error: `渲染进程异常消失：${JSON.stringify(info)}`,
        backendReady: !!activeUrl, backendLogTail: backendLogs.join('').slice(-64 * 1024),
        rendererConsole: rendererConsoleTail.slice(-200),
      });
    } catch {}
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    diag('[PRELOAD ERROR]', preloadPath, error);
    try { lifecycle.note('preload-error', `${preloadPath}: ${(error && error.message) || error}`); } catch {}
  });
  win.webContents.on('unresponsive', () => {
    diag('[RENDERER UNRESPONSIVE] 主窗口无响应');
    try { lifecycle.note('renderer-unresponsive', '主窗口无响应（渲染层卡死）'); } catch {}
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
  win.webContents.on('did-finish-load', () => {
    loadRetries = 0;
    // 0.3.48 · H-03：首帧阶段到此结束（停掉 paint deadline，并打一个点）。
    markMainWindowLoaded();
  });
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

/**
 * 0.3.48 · H-03 阶段三：主窗口首帧的 deadline。
 *
 * 为什么"窗口起来了"还要有超时：页面既不完成也不报错时（白窗），用户看到的东西
 * 与"根本没启动"完全等价，而且 `did-fail-load` 只覆盖"明确失败"，覆盖不到
 * "永远在加载"。所以这里给它一个上限，超时同样走既有的 `showFatal()`。
 *
 * 不杀后端：paint 阶段超时说明后端是好的（HTTP 已就绪），杀掉它只会让用户
 * 连重试的机会都失去；`showFatal()` 本来就不动后端。
 */
function armPaintWatchdog() {
  const budgets = startupBudgets();
  if (paintWatchdog) paintWatchdog.stop();
  paintWatchdog = startupDeadline.createWatchdog({
    phase: startupDeadline.PHASES.PAINT,
    budgetMs: budgets.paint,
    now: () => Date.now(),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    onExpire: (expired) => {
      paintWatchdog = null;
      const err = startupDeadline.createTimeoutError(startupDeadline.buildTimeoutReport({
        phase: expired.phase,
        budgets,
        elapsedMs: expired.elapsedMs,
        trace: bootTrace,
        lastLogLine: startupDeadline.lastMeaningfulLogLine(backendLogs),
        logPath: desktopLogPath(),
        hint: '后端地址已经就绪，卡住的是主窗口的页面加载：可以重试启动，或先查看日志里的 did-fail-load 记录。'
      }));
      diag('启动超时（paint 阶段）:', err.message);
      showFatal(err).catch((e) => diag('paint 超时后展示恢复弹窗失败:', e && e.message));
    }
  });
  paintWatchdog.start();
}

/** 主窗口首帧就绪：停掉 paint deadline 并打点（幂等）。 */
function markMainWindowLoaded() {
  if (paintWatchdog) { paintWatchdog.stop(); paintWatchdog = null; }
  bootTrace.mark('window-loaded');
}

async function createMainWindow(url) {
  // The Chromium window is always available and has no native-build/ABI risk.
  // (System WebView2 presence is recorded for diagnostics/future use.)
  const wv2 = detectWebView2();
  pushLog(`renderer=Chromium (Electron); system WebView2 present=${wv2.present}${wv2.version ? ' v' + wv2.version : ''}\n`);
  mainWindow = createChromiumWindow(url);
}

// ── 0.3.48 · H-01 · 启动恢复台账（失败计数落盘 + 自动回滚防死循环）──────────────
//
// 为什么必须落盘：触发条件是「连续两次**启动**失败」，而两次失败之间必然经历
// 一次进程重启 —— 内存计数器在重启后归零，等于永远不会触发自动回滚。
// 台账位置：%APPDATA%\DSH Desktop\startup-recovery.json（userData 根，不随
// backend/ 重建而丢失，也不落进用户数据目录 dsh-home/）。
const RECOVERY_STATE_NAME = 'startup-recovery.json';
/** 一次启动只记一次失败（恢复弹窗的 for(;;) 重弹、托盘再次打开弹窗都不该重复计数）。 */
let fatalCounted = false;

// ── 0.3.49 · 延后通知队列（阶段一审计遗留的"只写日志"问题）────────────────────
//
// 为什么需要队列而不是当场弹窗：插件隔离的结果（abandoned / 已还原）与"上次更新
// 未完成"这两类事实，都是在**启动早期**（后端还没起来、窗口还没建）确定的。
// 此刻弹模态框会把启动卡住（用户看到的是"启动画面不动"），而只写日志又等于没告
// 诉用户。所以先入队，等主窗口就绪后**一次性、非阻塞**地告诉用户。
let deferredNotices = [];

/**
 * 0.3.49 · 插件操作台账接线（仅低频动作点）。
 *
 * 为什么自己包一层：台账模块的 record() 是"同步入队、零文件系统调用"，但它仍是
 * 外部模块 —— 一次抛错不该把插件安装/启用这种用户动作带崩。这里兜住异常并**留痕**，
 * 既不静默也不放大（不改变用户可见结果）。
 */
function recordPluginJournal(entry) {
  try { pluginJournal.record(entry); }
  catch (e) { diag('插件台账 record 失败（不影响插件操作本身）:', { entry, error: e && e.message }); }
}

/** spec → 台账里的插件名（不记 spec 原文：本地路径可能带用户名/私有源）。 */
function pluginNameFromSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return '(unknown)';
  if (/^(?:file:|\/{1,2}|\.{1,2}[\\/]|[a-zA-Z]:[\\/])/.test(raw)) {
    const base = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return base || '(local)';
  }
  const at = raw.lastIndexOf('@');
  return at > 0 ? raw.slice(0, at) : raw;
}

/** spec → 来源类别（只记类别，避免私有源/本地路径泄漏）。 */
function pluginSourceFromSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return 'unknown';
  if (/^(?:file:|\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/)/.test(raw)) return 'local';
  return 'registry';
}

/** 入队一条用户可见通知（幂等：同 kind 只保留一条，避免阶梯重试刷屏）。 */
function queueNotice(notice) {
  if (!notice || !notice.kind) return;
  if (deferredNotices.some((n) => n.kind === notice.kind)) return;
  deferredNotices.push(notice);
}

/** 启动成功后统一展示（非阻塞：不 await，不打断用户）。 */
function showDeferredNotices() {
  if (!deferredNotices.length) return 0;
  const items = deferredNotices;
  deferredNotices = [];
  for (const n of items) {
    diag(`展示启动提示（${n.kind}）:`, { title: n.title, message: n.message });
    try {
      notifyUser(n.title, n.message, { iconType: n.iconType || 'warning' });
    } catch (e) { diag('启动提示的托盘气泡发送失败:', e && e.message); }
    dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
      type: n.iconType === 'error' ? 'error' : 'warning',
      buttons: ['知道了'], defaultId: 0, noLink: true,
      title: `${APP_NAME} · ${n.title}`,
      message: n.message,
      detail: n.detail || ''
    }).catch((e) => diag(`启动提示弹窗显示失败（${n.kind}，不影响使用）:`, e && e.message));
  }
  return items.length;
}

/** 上次更新是否在交换阶段被打断（H-05；启动早期读取，见 whenReady 步骤 3.1）。 */
let interruptedApply = null;

/**
 * 「上次更新未完成」的人话摘要（故障弹窗 detail 与启动提示共用，避免两处文案分叉）。
 * 只陈述磁盘事实，不做推断 —— 因为推断错的代价是把用户唯一能用的旧树换掉。
 */
function interruptedApplyBrief() {
  const s = interruptedApply;
  if (!s || !s.active) return '';
  const v = (x) => (x && x.version) || '无';
  return `上次更新未完成（H-05）：中断发生在「${s.step}」步骤，目标版本 ${s.target || '未知'}。\n`
    + `磁盘现状：dsh=${s.live ? v(s.live) : '缺失'}；dsh.old=${v(s.old)}；dsh.previous=${v(s.previous)}；dsh.new=${v(s.staged)}。\n`
    + `可用的恢复动作：${s.recovery}（回滚按钮会使用磁盘上真正可用的那份旧版本）。`;
}

/**
 * 0.3.49 · profile 隔离结果的用户可见化（阶段一审计遗留：结果只进日志）。
 *
 * 隔离是**不可逆**动作（把整棵 profiles 搬走/删除后重建）。H-04 修复后，失败路径
 * 尽力保住用户数据，但"这一轮被放弃了"或"中途已用副本还原"这两个结论此前**只有
 * 日志知道** —— 用户看到的现象是"插件还是那副样子"，完全无从判断系统做过什么。
 *
 * 触发条件：`quarantineProfiles()` 返回 `abandoned=true`（本轮隔离放弃，原树保持/已还原）
 *   或 `restore` 非空（删除原树未完成，曾用校验过的副本还原）。
 * 可逆性：此处**只做提示**，不改变任何磁盘状态。
 * 证据要求：结果对象与归档目录名一并写日志；提示里给绝对路径方便自查。
 *
 * @param {{abandoned?: boolean, reason?: string|null, copied?: boolean, quarantined?: boolean,
 *          fallback?: boolean, name?: string|null, path?: string|null, restore?: object|null}|null} res
 */
function recordIsolationOutcome(res) {
  if (!res) return;
  const restore = res.restore || null;
  if (!res.abandoned && !restore) {
    if (res.quarantined) {
      diag('profile 隔离完成（未放弃，无需提示用户）:', { name: res.name, copied: !!res.copied, fallback: !!res.fallback });
    }
    return;
  }
  diag('profile 隔离结果（需要在启动后告知用户）:', {
    abandoned: !!res.abandoned,
    reason: res.reason || null,
    copied: !!res.copied,
    quarantined: !!res.quarantined,
    quarantineName: res.name || null,
    restore: restore ? {
      ok: !!restore.ok,
      restoredFiles: restore.restoredFiles,
      restoredLinks: restore.restoredLinks,
      reason: restore.reason || null
    } : null
  });
  pushLog(`profile 隔离：${res.abandoned ? '本轮已放弃' : '已还原'}${res.reason ? `（${res.reason}）` : ''}\n`);

  if (res.abandoned) {
    queueNotice({
      kind: 'isolation-abandoned',
      title: '插件隔离已放弃',
      message: '本轮插件隔离没能完成，已放弃 —— 你的插件目录保持原样',
      detail: `原因：${res.reason || '未知'}\n\n`
        + `系统做了什么：没有删除你的任何插件数据${res.name ? `（完整副本保留在 ${res.name}）` : ''}。\n`
        + '后果：导致启动失败的问题可能仍未解决，但你的插件注册与依赖实体都在。\n'
        + '下一步：可以「以安全模式重启」先进入界面，或查看日志定位真正的根因。\n'
        + `完整日志：${desktopLogPath()}`
    });
    return;
  }

  if (restore) {
    queueNotice({
      kind: 'isolation-restored',
      title: '插件目录已还原',
      message: restore.ok
        ? '隔离过程中删除原目录未完成，已用校验过的副本还原'
        : '隔离过程中删除原目录未完成，还原也未完全成功（完整副本仍在）',
      detail: (restore.ok
        ? `已补回 ${restore.restoredFiles || 0} 个文件 / ${restore.restoredLinks || 0} 个链接。`
        : `渲染未完成的原因：${restore.reason || '未知'}（这只是补回过程受阻，不代表数据丢失）。`)
        + `\n\n完整副本位置：${res.name || res.path || '（见日志）'}\n`
        + '如果插件仍不正常，可从该副本手动恢复，或在设置窗里重新安装插件。\n'
        + `完整日志：${desktopLogPath()}`
    });
  }
}

/**
 * 0.3.49 · 隔离动作的台账记录（plugin-journal 接线点 5）。
 *
 * 为什么单独一个函数：隔离结果有 4 种结局（quarantined / copied / abandoned / restore），
 * 而台账要求"一个动作一条 entry"。失败结局用 result:{status:'fail',code}，
 * reason 用 EQUARANTINE（执行了但没成）或 EGUARD（被阶梯护栏拦下，压根没执行）。
 *
 * 注意：isolate/restore 的失败**已由台账模块自动镜像到 diag-log 的 durability 层**
 * （作者明确交代），这里不重复记诊断日志，只记台账。
 */
function recordQuarantineJournal(res) {
  if (!res) return;
  if (res.quarantined) {
    recordPluginJournal({ action: 'isolate', plugin: '(profiles)', source: 'profile', phase: 'startup', result: 'ok', reason: res.fallback ? 'EQUARANTINE-COPY' : 'EQUARANTINE' });
    return;
  }
  if (res.abandoned) {
    recordPluginJournal({ action: 'isolate', plugin: '(profiles)', source: 'profile', phase: 'startup', result: { status: 'fail', code: 'EQUARANTINE' }, reason: 'EQUARANTINE' });
    return;
  }
  // 走到这里说明调用了 quarantineProfiles 但目录不存在/未被允许：如实记一条，不假装成功。
  recordPluginJournal({ action: 'isolate', plugin: '(profiles)', source: 'profile', phase: 'startup', result: { status: 'fail', code: 'EGUARD' }, reason: 'EGUARD' });
}

/**
 * 解析**真正可用**的回滚目标（0.3.49 · H-05）。
 *
 * 为什么不能只看 `dsh.previous`：更新在交换阶段被打断时，现场可能是
 *   ① `dsh` 缺失 + `dsh.old` 有旧树（交换进行到一半）→ 只有 dsh.old 能救；
 *   ② `dsh` 缺失 + 只有 `dsh.previous`     → rollbackDsh() 本身就能处理；
 *   ③ `dsh` 在 + 两个都在                  → 版本没坏，不需要回滚。
 * 猜错目标比不回滚更糟（会把唯一还能用的树换掉），所以这里**只读磁盘事实**。
 *
 * @returns {{available: boolean, source: 'previous'|'old'|null, dir: string|null, version: string|null}}
 */
function resolveRollbackTarget() {
  try {
    const p = mgr.P();
    const binOf = (dir) => path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const versionOf = (dir) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
        return pkg && pkg.version ? String(pkg.version) : null;
      } catch { return null; }
    };
    if (fs.existsSync(binOf(p.dshPrevious))) {
      return { available: true, source: 'previous', dir: p.dshPrevious, version: versionOf(p.dshPrevious) };
    }
    const oldDir = path.join(p.root, 'dsh.old');
    // 只有"当前 dsh 缺失"时 dsh.old 才是回滚目标：dsh 还在说明交换没发生，
    // 换掉它等于把一个能用的版本弄坏（这就是"不要猜测"的具体含义）。
    if (fs.existsSync(binOf(oldDir)) && !fs.existsSync(binOf(p.dshDir))) {
      return { available: true, source: 'old', dir: oldDir, version: versionOf(oldDir) };
    }
    return { available: false, source: null, dir: null, version: null };
  } catch (e) {
    diag('解析回滚目标失败:', e && e.message);
    return { available: false, source: null, dir: null, version: null };
  }
}

/**
 * 0.3.49 · H-05：把 `dsh.old`（交换时的旧树）换回 `dsh`。
 * 触发条件：`resolveRollbackTarget()` 判定 source==='old'（即 dsh 缺失 + dsh.old 可用）。
 * 可逆性：**不可逆**（旧树被移动）；因此保留任何残留的 dsh 目录并改名归档，绝不删除。
 * 证据要求：调用前必须已判定 dsh.old 内 bin.js 存在；全过程写诊断日志。
 */
function promoteDshOldToLive() {
  const p = mgr.P();
  const oldDir = path.join(p.root, 'dsh.old');
  const brokenDir = path.join(p.root, `dsh.broken-${Date.now()}`);
  try {
    if (fs.existsSync(p.dshDir)) {
      fs.renameSync(p.dshDir, brokenDir);
      diag('用 dsh.old 恢复前，先把现有 dsh 归档:', brokenDir);
    }
    fs.renameSync(oldDir, p.dshDir);
    diag('已用 dsh.old 恢复 dsh 目录:', { from: oldDir, to: p.dshDir });
    return true;
  } catch (e) {
    diag('用 dsh.old 恢复 dsh 目录失败:', e && e.message);
    return false;
  }
}

function recoveryStatePath() {
  try { return path.join(app.getPath('userData'), RECOVERY_STATE_NAME); }
  catch (e) {
    diag('读取 userData 路径失败（启动恢复台账不可用，自动回滚将失去防循环保障）:', e && e.message);
    return null;
  }
}

function loadRecoveryState() {
  const file = recoveryStatePath();
  if (!file) return startupDeadline.createGuardState();
  try {
    return startupDeadline.normalizeGuardState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    // 首启动 ENOENT 是正常情况；其它错误必须留痕（不许静默把台账当空的）。
    if (!e || e.code !== 'ENOENT') diag('启动恢复台账读取失败（按全新状态处理）:', e && e.message);
    return startupDeadline.createGuardState();
  }
}

function saveRecoveryState(state) {
  const file = recoveryStatePath();
  if (!file) return false;
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return true;
  } catch (e) {
    // 写不进去 ⇒ 自动回滚的防循环会失效。这是必须被看见的降级，不是可吞的错误。
    diag('启动恢复台账写入失败（自动回滚可能重复触发）:', e && e.message);
    pushLog(`启动恢复台账写入失败：${e && e.message}（自动回滚的防循环保障失效）\n`);
    return false;
  }
}

/** 是否存在**可用**的回滚目标（0.3.49 起包含 dsh.old 分支，判定见 resolveRollbackTarget）。 */
function rollbackTargetExists() {
  return resolveRollbackTarget().available;
}

/** 当前活跃后端版本（拿不到就返回 null，不编造）。 */
function currentDshVersion() {
  try {
    const v = mgr.currentVersions();
    return (v && v.dsh) ? String(v.dsh) : null;
  } catch (e) {
    diag('读取当前后端版本失败:', e && e.message);
    return null;
  }
}

/** journal 里"已应用但未验证"的记录（H-01(3) 的决策输入之一）。 */
function journalUnverifiedSafe() {
  try { return mgr.journalUnverified() || []; }
  catch (e) {
    diag('journal 未验证记录读取失败（不影响启动判断）:', e && e.message);
    return [];
  }
}

/**
 * 执行一次后端回滚（不可逆动作）。
 *
 * 触发条件：用户点「回滚到上一个版本」/ journal 提示里选回滚 / 连续失败 2 次自动回滚。
 * 可逆性：**不可逆** —— 目标树被移动/替换；`dsh.previous` 路径由 `rollbackDsh()`
 *   处理（当前 dsh 改名 dsh.failed 后删除），`dsh.old` 路径保留归档目录（dsh.broken-<ts>）。
 *   补偿手段是重新下载/暂存该版本（设置窗可用）。
 * 证据要求：目标由 `resolveRollbackTarget()` 从磁盘事实判定（**不猜**）；
 *   每次执行都写诊断日志 + 生命周期台账，回滚后版本号必须落在日志里。
 *
 * @param {'auto'|'manual'} kind auto = 连续失败触发的自动回滚
 */
async function performRollback(kind) {
  const from = currentDshVersion();
  const state = loadRecoveryState();
  const target = resolveRollbackTarget();
  // 先停后端：dsh 目录里的文件被进程占着时 rename 会失败（Windows 上必然）。
  const stopped = await stopBackendAndWait({ timeoutMs: 6000, forceTimeoutMs: 5000 });
  diag(`回滚（${kind}）：后端已停止`, stopped);
  diag(`回滚（${kind}）：目标来源`, target);

  let ok = false;
  let failure = null;
  try {
    // 0.3.49 · H-05：目标可能是 dsh.previous（正常回滚）或 dsh.old（更新被中断）。
    ok = target.source === 'old' ? promoteDshOldToLive() : mgr.rollbackDsh() === true;
  } catch (e) {
    failure = e;
  }
  if (!ok) {
    const reason = failure ? failure.message : '没有可用的上一个版本（dsh.previous / dsh.old 都不完整）';
    diag(`回滚（${kind}）未完成:`, reason);
    pushLog(`回滚失败：${reason}\n`);
    return { ok: false, from, to: null, error: failure || new Error(reason), source: target.source };
  }

  const to = currentDshVersion();
  diag(`回滚（${kind}）完成：${from || '未知'} → ${to || '未知'}（来源 ${target.source}）`);
  pushLog(`已回滚 DSH 后端：${from || '未知'} → ${to || '未知'}（来源 ${target.source === 'old' ? 'dsh.old' : 'dsh.previous'}；只替换 backend 里的 dsh 程序目录，插件与数据未改动）\n`);
  try {
    lifecycle.note(kind === 'auto' ? 'auto-rollback' : 'manual-rollback', {
      from, to, reason: kind, source: target.source, logFile: desktopLogPath()
    });
  } catch (e) { diag('生命周期台账写入回滚记录失败:', e && e.message); }

  saveRecoveryState(startupDeadline.recordRollback(state, {
    at: new Date().toISOString(), from, to, auto: kind === 'auto', reason: kind
  }));
  return { ok: true, from, to, error: null, source: target.source };
}

/** 手动回滚 → 重启；失败则如实告知（绝不静默地"点了没反应"）。 */
async function manualRollbackAndRestart(reasonTag) {
  diag('用户请求回滚到上一个版本:', reasonTag || 'manual');
  const rb = await performRollback('manual');
  if (!rb.ok) {
    await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
      type: 'error', buttons: ['知道了'], defaultId: 0, noLink: true,
      title: APP_NAME,
      message: '回滚没能执行',
      detail: `${(rb.error && rb.error.message) || '未知原因'}\n\n` +
        '这不影响你现在能做的事情：可以先「以安全模式重启」排查，或在托盘「设置…」里换一个后端版本。\n' +
        `完整日志：${desktopLogPath()}`
    }).catch((e) => diag('回滚失败提示窗显示失败:', e && e.message));
    return;
  }
  await restartApp();
}

/**
 * 0.3.48 · H-01(2)：连续失败达到阈值时**自动**回滚一次（有上限，防死循环）。
 * 回滚成功后立刻重启；"已自动回滚到 vX" 的提示无法活过重启，故暂存进台账，
 * 由下一次启动读出后**非阻塞**显示一次。
 */
async function maybeAutoRollback(decision) {
  if (!decision || decision.action !== 'auto-rollback') return false;
  diag('触发自动回滚:', { reason: decision.reason });
  pushLog('连续启动失败，正在自动回滚到上一个版本…\n');
  const rb = await performRollback('auto');
  if (!rb.ok) {
    pushLog('自动回滚没能完成：下面会提供手动回滚按钮。\n');
    return false;
  }
  saveRecoveryState(startupDeadline.stashNotice(loadRecoveryState(), {
    kind: 'auto-rollback', at: new Date().toISOString(), from: rb.from, to: rb.to, reason: decision.reason
  }));
  try { lifecycle.note('auto-rollback-relaunch', `${rb.from || '?'} → ${rb.to || '?'}`); } catch (e) { diag('生命周期台账写入失败:', e && e.message); }
  await restartApp();
  return true;
}

/** 启动真的成功了：失败链断掉，清零计数（pendingNotice 必须保留，见下）。 */
function markStartupHealthy() {
  const state = loadRecoveryState();
  if (state.consecutiveFailures > 0 || state.rollbacksInChain > 0) {
    diag('启动成功：清空失败计数与自动回滚链', {
      wasConsecutiveFailures: state.consecutiveFailures,
      wasRollbacksInChain: state.rollbacksInChain,
      pendingNotice: state.pendingNotice || null
    });
  }
  saveRecoveryState(startupDeadline.resetOnHealthyBoot(state, { at: new Date().toISOString() }));
  showPendingRecoveryNotice();
}

/**
 * 显示上一次启动留下的「已自动回滚」提示（一次性、非阻塞）。
 * 为什么非阻塞：启动已经成功了，这条提示只是告知，绝不能拦住用户去用应用。
 */
function showPendingRecoveryNotice() {
  const state = loadRecoveryState();
  const notice = state.pendingNotice;
  if (!notice) return;
  saveRecoveryState(startupDeadline.clearNotice(state, { at: new Date().toISOString() }));
  const detail = startupDeadline.formatRollbackNotice({
    from: notice.from, to: notice.to, auto: true, reason: notice.reason, logPath: desktopLogPath()
  });
  diag('显示自动回滚提示（一次性）:', notice);
  notifyUser('已自动回滚到上一个版本', `DSH 后端已回滚：${notice.from || '故障版本'} → ${notice.to || '上一个版本'}`, { iconType: 'warning' });
  dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
    type: 'warning', buttons: ['知道了'], defaultId: 0, noLink: true,
    title: `${APP_NAME} 已自动回滚`,
    message: `已自动回滚到 v${notice.to || '上一个版本'}`,
    detail
  }).catch((e) => diag('自动回滚提示弹窗显示失败（不影响使用）:', e && e.message));
}

/**
 * 0.3.48 · H-01(3)：journal 命中「已应用但未验证」时提示用户（原实现只写日志）。
 * 非阻塞 —— 启动此刻已经成功，提示不该拦住任何人。
 */
function promptJournalUnverified(stale) {
  const canRollback = rollbackTargetExists();
  const buttons = canRollback ? ['知道了', '回滚到上一个版本'] : ['知道了'];
  const evidence = startupDeadline.formatJournalEvidence(stale);
  dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
    type: 'warning', buttons, defaultId: 0, cancelId: 0, noLink: true,
    title: `${APP_NAME} 上次更新未完成验证`,
    message: '上次更新可能没有真正生效',
    detail: `${evidence}\n\n` +
      '这通常意味着上次更新在"验证"之前被打断（断电、强杀或那次启动失败），' +
      '所以这次跑的版本有可能不是你以为的那个。\n\n' +
      (canRollback
        ? '如果随后遇到行为异常，可以回滚到上一个版本（只换程序目录，不动会话与密钥）。'
        : '当前没有可用的上一个版本，暂时无法回滚。') +
      `\n\n完整日志：${desktopLogPath()}`
  }).then((r) => {
    if (canRollback && r.response === 1) manualRollbackAndRestart('journal-unverified');
  }).catch((e) => diag('journal 未验证提示窗显示失败（不影响启动）:', e && e.message));
}

async function showFatal(err) {
  diag('启动失败（fatal）:', err);
  setBootPhase('failed', err);
  closeSplash();
  // 首帧 deadline 到此失去意义（已经走失败路径），必须停掉，避免二次进入。
  if (paintWatchdog) { paintWatchdog.stop(); paintWatchdog = null; }
  // 0.3.48 · H-03：超时报告的阶段打点一并落诊断日志 —— 事后能回答"卡在哪一步"。
  diag('启动阶段打点:', bootTrace.lines());
  const tail = backendLogs.join('').split(/\r?\n/).filter(Boolean).slice(-30).join('\n');
  const logPath = desktopLogPath();

  // 0.3.48 · H-01(2)：失败计数落盘（一次启动只记一次）。
  if (!fatalCounted) {
    fatalCounted = true;
    const counted = startupDeadline.bumpFailure(loadRecoveryState(), {
      at: new Date().toISOString(),
      summary: String((err && err.message) || err)
    });
    saveRecoveryState(counted);
    diag('启动失败计数:', {
      consecutiveFailures: counted.consecutiveFailures,
      rollbacksInChain: counted.rollbacksInChain,
      threshold: startupDeadline.FAILURE_THRESHOLD,
      autoRollbackLimit: startupDeadline.AUTO_ROLLBACK_LIMIT
    });
  }

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
    try { lifecycle.crash('startup-fatal', (err && err.stack) || String(err)); } catch {}
    app.quit();
    return;
  }

  // Tray is alive: stay resident as a recovery console. Exiting here is what
  // used to strand the user — no tray icon, no safe mode, no way back in.
  // 0.3.48 · H-08：气泡统一走 notifyUser（带 AUMID 取证与 balloon-show 观测）。
  notifyUser(`${APP_NAME} 启动失败`, '右键托盘图标可查看日志、修复配置或以安全模式重启。', { iconType: 'error' });
  pushLog('启动失败：已保留托盘自救入口（查看日志 / 修复配置 / 安全模式 / 重试启动）。\n');

  // 0.3.48 · H-01：把"要不要回滚"交给纯函数判定（连续失败计数 / 本轮已回滚次数 /
  // 可用回滚目标 / journal 未验证证据 / 是否只是端口被占）。
  // 0.3.49 · H-05：可用目标由 `resolveRollbackTarget()` 从磁盘事实解析（可能是
  // dsh.previous，也可能是更新被中断后仅剩的 dsh.old）—— 这里只用事实，不猜。
  const rollbackTarget = resolveRollbackTarget();
  const recoveryDecision = startupDeadline.decideRecovery({
    state: loadRecoveryState(),
    previousAvailable: rollbackTarget.available,
    journalEvidence: journalUnverifiedSafe(),
    fatalKind: addressInUse ? 'address-in-use' : 'startup'
  });
  diag('启动恢复决策:', {
    action: recoveryDecision.action,
    reason: recoveryDecision.reason,
    recommendRollback: recoveryDecision.recommendRollback,
    rollbackTarget
  });
  // 0.3.49 · H-05：命中"上次更新未完成"时，把它作为**直接证据**参与决策 ——
  // 这种情况下"当前版本可疑"不再是推测，而是磁盘上就摆着未完成的交换现场。
  if (interruptedApply && interruptedApply.active && !addressInUse && rollbackTarget.available) {
    recoveryDecision.recommendRollback = true;
    recoveryDecision.detailExtra = interruptedApplyBrief() + '\n' + (recoveryDecision.detailExtra || '');
    diag('H-05 中断态参与回滚决策:', { recovery: interruptedApply.recovery, target: rollbackTarget.source });
  }
  let autoRollbackFailed = false;
  if (recoveryDecision.action === 'auto-rollback') {
    // 注意：这一支成功后进程会直接重启（本函数不再往下走）；失败则继续弹窗，
    // 由用户手动选择回滚 —— 不会出现"既不回滚也不告诉用户"的中间态。
    const rolledBack = await maybeAutoRollback(recoveryDecision);
    if (rolledBack) return;
    autoRollbackFailed = true;
  }
  const rollbackOffered = !addressInUse && recoveryDecision.recommendRollback && rollbackTarget.available;
  // 按钮文案要写清"会用哪份旧版本"：用户点之前就知道这个动作意味着什么。
  const rollbackLabel = rollbackTarget.source === 'old'
    ? `回滚到上一个版本（dsh.old${rollbackTarget.version ? ' ' + rollbackTarget.version : ''}）`
    : (rollbackTarget.source === 'previous' && rollbackTarget.version
      ? `回滚到上一个版本（${rollbackTarget.version}）`
      : '回滚到上一个版本');

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
  let fatalMessage = addressInUse
    ? '端口被其他 DSH 实例占用'
    : (autoRollbackFailed
      ? '连续启动失败（自动回滚没能完成）'
      : (interruptedApply && interruptedApply.active
        ? '上次更新未完成，后端没能启动'
        : recoveryDecision.message));
  let fatalDetail = addressInUse
    ? detail
    : (autoRollbackFailed
      ? '已经尝试自动回滚，但回滚没能完成（原因见下方日志与后台日志）。\n' +
        '可以在下方手动选择「回滚到上一个版本」，或先以安全模式重启排查。\n\n' + detail
      : (recoveryDecision.detailExtra ? recoveryDecision.detailExtra + '\n' + detail : detail));
  // 0.3.48 · H-01：按钮改为「动作表」而不是魔法下标 —— 旧代码用 switch(r.response)
  // 硬编码 0..5，加一个按钮就会把动作整体错位（0.3.44「注册与回调不一致」的同类风险）。
  const fatalActions = addressInUse
    ? [
        { label: '重试启动', run: () => restartApp() },
        { label: '退出', run: () => quitApp() }
      ]
    : [
        ...(rollbackOffered
          ? [{ label: rollbackLabel, run: () => manualRollbackAndRestart('fatal-dialog') }]
          : []),
        { label: '查看启动日志', run: async () => { try { await shell.openPath(logPath); } catch (e) { diag('打开日志失败:', e && e.message); } } },
        { label: '修复插件配置', run: () => requestPatchRepair() },
        { label: '以安全模式重启', run: () => requestEnterSafeMode() },
        { label: '重试启动', run: () => restartApp() },
        { label: '留在托盘稍后处理', run: async () => 'stay' },
        { label: '退出', run: () => quitApp() }
      ];
  const stayIndex = fatalActions.findIndex((a) => a.label === '留在托盘稍后处理');
  for (;;) {
    let r;
    try {
      r = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
        type: 'error',
        buttons: fatalActions.map((a) => a.label),
        defaultId: 0,
        cancelId: addressInUse ? 1 : (stayIndex >= 0 ? stayIndex : fatalActions.length - 1),
        noLink: true,
        title: `${APP_NAME} 启动失败`,
        message: fatalMessage,
        detail: fatalDetail
      });
    } catch (dialogErr) {
      // 连弹窗都开不了（无显示环境等）：记日志后按"留在托盘"处理，不静默退出。
      diag('恢复弹窗无法显示:', dialogErr && dialogErr.message);
      return;
    }
    const action = fatalActions[r.response] || fatalActions[fatalActions.length - 1];
    try {
      const outcome = await action.run();
      if (outcome === 'stay') return; // 留在托盘；托盘本身就是自救控制台
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
      notifyUser('DSH Desktop 有新版本',
        `桌面版 ${shellUpdateVersion || '新版本'} 可用。打开托盘菜单中的「设置」可确认下载。`,
        { iconType: 'info' });
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
      // 0.3.48 · H-08：唯一主动通知通道统一走 notifyUser（带 AUMID 取证）。
      notifyUser('DSH 有可用更新',
        info.updates.map((u) => `${u.component} → ${u.latest}`).join('；') + '\n打开托盘菜单中的「设置」可确认下载。',
        { iconType: 'info' });
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
  // 0.3.49 · B-06：在"用户点下确认"的这一刻签发确认令牌。
  // 令牌绑定的是**弹窗展示的那个候选**（revision + 版本 + 内容摘要），不是"最新版本"：
  // 用户确认 A 却装上 B（上游重发同版本号、或中途切了镜像/版本）必须被拒绝。
  let confirmation = null;
  try {
    confirmation = typeof mgr.issueUpdateConfirmation === 'function' ? mgr.issueUpdateConfirmation() : null;
    diag('已签发更新确认令牌（B-06）:', confirmation
      ? { revision: confirmation.revision, version: confirmation.version, digest: String(confirmation.digest || '').slice(0, 12) + '…' }
      : '（无候选快照：本次不带令牌，updater 会按 unbound 放行并记录）');
  } catch (e) {
    diag('签发更新确认令牌失败（本次不带令牌）:', e && e.message);
  }
  const summaries = [];
  const failures = [];
  for (const u of updates) {
    try {
      if (u.component === 'dsh') {
        // 0.3.49 · B-06：确认令牌一路带到下载路径 —— 过期令牌由 updater 在**网络之前**
        // 拒绝（并写 ERR_UPDATER_CONFIRMATION_STALE 到 journal），这里只把结论如实告诉用户。
        let staged;
        try {
          staged = await mgr.stageDsh(cbs, u.latest, { confirmation });
        } catch (e) {
          if (/CONFIRMATION_STALE/.test(String((e && e.message) || e))) {
            diag('更新确认已过期（B-06 拒绝安装）:', e && e.message);
            pushLog(`更新确认已过期：${e && e.message}（未下载任何内容）\n`);
            failures.push(`DSH 后端 ${u.latest}：确认已过期，需要重新检查更新后再确认`);
            continue;
          }
          throw e;
        }
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
      detail: failText + '\n\n当前版本未受影响、未重启需求。\n可能原因：该版本尚未发布到 npm 镜像。\n\n详情已写入桌面日志：' + desktopLogPath()
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
    // 0.3.49 · B-05：设置窗握最高权限（plugins:install / set-path-entry / rollback-to），
    // 因此它比主窗更需要 sandbox + 导航白名单（0.3.48 之前它连处理器都没装）。
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  applyWindowHandlers(settingsWindow, { kind: 'settings', allowedFileRoots: [__dirname] });
  logEffectiveWebPreferences(settingsWindow, 'settings');
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
  //
  // 0.3.49 · B-03：这两行旧的固定定时器（5s 一次 + 每 6h 一次）已删除，改由
  // updater 的常驻节拍器驱动（单调时钟 + 完成起算 + 指数退避 + 抖动 + 单飞）。
  // 为什么必须换：旧写法没有退避也没有单飞 —— 弱网下每 6 小时硬撞一次镜像，
  // 且用户手动点"检查更新"与定时器可能并发出两份网络请求。
  startBackendUpdateLoop();
  // Daily log retention cleanup (archives pruned by count + age).
  setInterval(() => { try { diagLog.housekeep(); } catch (_) {} }, 24 * 3600 * 1000);
}

/**
 * 0.3.49 · B-03：后端更新检查的常驻节拍（接线薄层）。
 *
 * 语义边界（不变）：节拍器只决定**何时**检查；发现新版本仍然只"通知"，不下载。
 * 下载永远等用户在设置窗确认（确认制）。
 *
 * 为什么首次检查仍延迟 5 秒：节拍器是"到期即跑"（首次 dueAt 为空 ⇒ 立刻到期），
 * 直接 start() 会和启动链抢网络与 CPU（解压/补丁预检正在跑）。这里保留旧的
 * 可感知节奏：启动 5 秒后开始第一次检查，之后完全交给节拍器的退避/单飞。
 */
let backendUpdateLoop = null;
let lastUpdateLoopKey = '';
let lastNotifiedCandidateKey = '';

function startBackendUpdateLoop() {
  if (backendUpdateLoop) return backendUpdateLoop;
  const loop = mgr.createBackendUpdateLoop({
    log: (msg, detail) => diag('[update-schedule] ' + msg, detail)
  });
  backendUpdateLoop = loop;
  diag('更新节拍器已就绪（B-03：单调时钟 + 完成起算 + 退避 + 抖动 + 单飞）:', loop.status());
  setTimeout(() => {
    try {
      const st = loop.start();
      diag('更新节拍器已启动（首次检查在启动后约 5 秒）:', st);
    } catch (e) {
      diag('启动更新节拍器失败:', e && e.stack ? e.stack : e);
      pushLog(`更新检查节拍器启动失败：${e && e.message}（自动更新检查不可用）\n`);
    }
  }, 5000);
  // 节拍器没有事件钩子（update-schedule 的 API 是 start/stop/runCheck/status），
  // 所以用 3 秒一次的内存轮询把"检查完成"映射到既有的通知制 UI —— 不产生任何网络请求。
  const watcher = setInterval(() => syncUpdateUiFromLoop(loop), 3000);
  if (watcher && typeof watcher.unref === 'function') watcher.unref();
  return loop;
}

/**
 * 把节拍器的一次"检查完成"翻译成托盘状态 + 通知（不下载、不发网络请求）。
 *
 * 判定依据是 updater 的**候选快照**：`checkForUpdates()` 发现新版本时会
 * `recordUpdateCandidate()`，`issueUpdateConfirmation()` 读到的就是它。因此这里
 * 不需要再查一次网络，也不会与节拍器的单飞机制打架。
 */
function syncUpdateUiFromLoop(loop) {
  let status;
  try { status = loop.status(); } catch (e) { diag('读取更新节拍器状态失败:', e && e.message); return; }
  const c = status.counters || {};
  const key = `${c.ok || 0}|${c.failed || 0}|${status.failures || 0}`;
  if (key === lastUpdateLoopKey) return; // 没发生新的检查 → 什么都不做
  lastUpdateLoopKey = key;

  const current = (() => { try { return mgr.currentVersions()?.dsh || updateStatus.current; } catch { return updateStatus.current; } })();
  let candidate = null;
  try { candidate = typeof mgr.issueUpdateConfirmation === 'function' ? mgr.issueUpdateConfirmation() : null; } catch (e) { diag('读取更新候选失败:', e && e.message); }

  if (candidate && candidate.version && String(candidate.version) !== String(current)) {
    const candKey = `${candidate.version}|${candidate.revision}`;
    setUpdateStatus('available', '有新版本，点击此处确认', 0,
      `DSH 后端 ${current || '未知'} → ${candidate.version}`,
      { current: current || '未知', latest: candidate.version });
    if (candKey !== lastNotifiedCandidateKey) {
      lastNotifiedCandidateKey = candKey;
      pushLog(`发现新版本（等待用户确认后才下载）：DSH 后端 ${current || '未知'} → ${candidate.version}\n`);
      notifyUser('DSH 有可用更新', `DSH 后端 ${current || '未知'} → ${candidate.version}\n打开托盘菜单中的「设置」可确认下载。`, { iconType: 'info' });
    }
    return;
  }
  if (status.failures) {
    setUpdateStatus('error', '检查更新失败', 0, status.lastError || '未知错误', { current: current || '未知', latest: updateStatus.latest });
    return;
  }
  setUpdateStatus('idle', '已是最新版本', 100, '', { current: current || '未知', latest: current || '未知' });
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
  // 0.3.49 · 台账：客户端注册失败后禁用（运行期，reason=ECLIENTREG）
  recordPluginJournal({ action: 'disable', plugin: name, source: 'profile', phase: 'running', result: 'ok', reason: 'ECLIENTREG' });
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
  try { lifecycle.exit('restart', '应用重启（更新/安全模式/手动重启）'); } catch {}
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
    // 0.3.49 · 台账：安装动作（plugin 记包名、source 记类别，绝不记 spec 原文）
    recordPluginJournal({
      action: 'install', plugin: pluginNameFromSpec(spec), source: pluginSourceFromSpec(spec),
      phase: 'running',
      // 台账的 reason 语义固定为 ETIMEDOUT/EINSTALL（原始 code 已在上一行 diag 里，
      // 这里不再塞进 result.code —— 台账模块会把 result.code 当 reason，反而盖掉语义）。
      result: r.ok ? 'ok' : 'fail',
      reason: r.ok ? '' : (r.timedOut ? 'ETIMEDOUT' : 'EINSTALL')
    });
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
    // 0.3.49 · 台账：迁移导入逐条记（跳过的记 ok + ESKIP，避免"看不出来它去哪了"）
    for (const item of (summary.results || [])) {
      const name = pluginNameFromSpec(item && (item.name || item.spec || item.package));
      const skipped = !!(item && (item.skipped || item.status === 'skipped'));
      const failed = !!(item && (item.ok === false || item.status === 'failed')) && !skipped;
      recordPluginJournal({
        action: 'install', plugin: name, source: 'legacy', phase: 'running',
        result: failed ? { status: 'fail', code: (item && item.code) || 'EINSTALL' } : 'ok',
        reason: skipped ? 'ESKIP' : (failed ? ((item && item.code) || 'EINSTALL') : '')
      });
    }
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
  try { lifecycle.exit('second-instance', '单实例锁被占用：本进程是第二实例，直接退出'); } catch {}
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    diag('收到 second-instance 多实例唤醒通知', { argv });
    showMainWindow();
  });

  app.whenReady().then(async () => {
    diag('启动流程开始', { hidden: autoStartHidden, packaged: isPackaged, versions: (() => { try { return mgr.currentVersions(); } catch { return null; } })() });
    bootTrace.mark('ready', autoStartHidden ? 'hidden' : 'visible');
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
    // 0c) 0.3.48 · H-08 通知通道自检：把"能不能发通知"的判断依据一次写进日志。
    //     事后看到"用户说没收到提示"时，这里能区分几种情况：没有托盘 / AUMID
    //     没生效（可能被系统吞）/ 通道能力缺失（Notification 也不可用）。
    //     0.3.48 复修后这里的 aumidApplied 在**成品里也应为 true**（身份取自随包
    //     常量 app-identity.js，不再依赖会被打包剥离的构建字段）。
    diag('通知通道自检（H-08）:', {
      aumid: appUserModelIdApplied || DSH_APP_ID,
      aumidApplied: !!appUserModelIdApplied,
      aumidSource: 'app-identity.js',
      platform: process.platform,
      trayBalloonApi: !!(tray && typeof tray.displayBalloon === 'function'),
      electronNotificationSupported: notificationSupported(),
      packaged: isPackaged
    });
    if (!appUserModelIdApplied) {
      // 设置失败必须显眼：这是我们唯一的主动通知通道的前提条件。
      diag('警告：AppUserModelID 未生效（aumidApplied:false）—— Win10/11 可能静默丢弃托盘气泡');
    }
    try {
      // 1) Seed writable active dir from factory resources (first run).
      diag('步骤1 初始化活跃目录 ensureSeeded');
      // 注意：ensureSeeded 是**同步**的（解压 payload），主进程在它执行期间是阻塞的 ——
      // 计时器根本不会跑。所以启动超时只覆盖"异步等待"的三个阶段（spawn/health/paint），
      // 不假装能给同步解压设超时（那是做不到的，写出来只会误导排查者）。
      mgr.ensureSeeded();
      bootTrace.mark('seeded');
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
      bootTrace.mark('applied', applied && applied.dsh ? `dsh→${applied.dsh}` : 'none');
      // 3.1) 0.3.49 · H-05：读「上次更新在交换阶段被打断」的残留标记。
      // 为什么要在启动早期读：此刻 `dsh`/`dsh.old`/`dsh.previous` 全是磁盘事实，
      // 再晚（比如等 ensureSeeded 补种出厂版本之后）现场就被覆盖了 —— 那正是
      // H-05「昨天刚更新，今天又变回去了」的成因窗口。
      // 这里只**记录事实**，不做任何自动恢复（恢复是不可逆动作，决策权在 showFatal）。
      try {
        const interrupted = mgr.interruptedApplyState();
        if (interrupted && interrupted.active) {
          interruptedApply = interrupted;
          diag('检测到上次更新未完成（H-05）:', {
            step: interrupted.step,
            target: interrupted.target,
            recovery: interrupted.recovery,
            live: interrupted.live && interrupted.live.version,
            old: interrupted.old && interrupted.old.version,
            previous: interrupted.previous && interrupted.previous.version,
            unreadable: !!interrupted.unreadable
          });
          pushLog(`上次更新未完成：步骤=${interrupted.step} 目标=${interrupted.target || '未知'}；`
            + `磁盘现状 dsh=${(interrupted.live && interrupted.live.version) || '缺失'} `
            + `dsh.old=${(interrupted.old && interrupted.old.version) || '无'} `
            + `dsh.previous=${(interrupted.previous && interrupted.previous.version) || '无'}`
            + `（建议恢复动作=${interrupted.recovery}，不会自动执行）\n`);
          queueNotice({
            kind: 'interrupted-apply',
            title: '上次更新未完成',
            message: '上次在应用更新时被中断（断电 / 强杀 / 启动失败）',
            detail: `中断发生在「${interrupted.step}」步骤，目标是版本 ${interrupted.target || '未知'}。\n\n`
              + `磁盘现状：当前 dsh=${(interrupted.live && interrupted.live.version) || '缺失'}；`
              + `dsh.old=${(interrupted.old && interrupted.old.version) || '无'}；`
              + `dsh.previous=${(interrupted.previous && interrupted.previous.version) || '无'}。\n\n`
              + '本次已按"尽量不覆盖可恢复现场"的顺序启动。如果随后出现版本异常或启动失败，'
              + '可在恢复弹窗里选择「回滚到上一个版本」（会使用真正可用的那份旧版本）。\n'
              + `完整日志：${desktopLogPath()}`
          });
        }
      } catch (e) {
        pushLog('检测「上次更新未完成」失败（不影响启动）: ' + (e && e.message) + '\n');
        diag('interruptedApplyState 失败:', e && e.stack ? e.stack : e);
      }
      // 3.2) Safe-mode resolution: --safe-mode keeps the reduced (core-only)
      // profile; a NORMAL launch while a safe-mode marker exists restores the
      // saved originals — a crash inside safe mode can never strand the
      // machine in a stripped state.
      try {
        const sm = mgr.applySafeModeBoot(process.argv);
        safeMode = !!sm.active;
        if (sm.active) { updateSplash('正在以安全模式启动（仅核心组件）…'); pushLog('安全模式：仅加载核心组件，第三方插件已临时停用。\n'); }
        if (sm.exited) pushLog(`已退出安全模式并还原第三方插件：${(sm.restored || []).join('、') || '（无还原项）'}\n`);
        // 0.3.49 · 台账：安全模式启动 = 第三方插件被跳过（一条 entry 说明"本轮为什么它们不在"）
        if (sm.active) {
          recordPluginJournal({ action: 'startup-skip', plugin: '(safe-mode)', source: 'profile', phase: 'startup', result: 'ok', reason: 'ESAFEMODE' });
        }
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
              detail: '上游组件 dsh-persona 升级后配置格式变更（text → prefix），你的自定义预设已自动迁移到新格式，会话可正常恢复。\n\n原文件已按 .persona-migrate-*.bak 后缀备份，详情见桌面日志：' + desktopLogPath()
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
        // 0.3.46 · 先恢复、后禁用：应用自己误禁用过的条目（此前解析根判错导致
        // 误伤）在包现在能解析时自动恢复 —— 自愈必须对称，否则误伤是单向的。
        const restored = mgr.restorePreflightDisabledEntries(mgr.dshHome(), {
          conflictIds: new Set(preConflicts.map((c) => c.id)),
        }) || { restored: [], skipped: [] };
        if (restored.restored.length) {
          diag('启动预检：已恢复此前被误禁用的条目', restored.restored);
          for (const r of restored.restored) {
            pushLog(`启动预检：条目 ${r.id}（${r.name}）此前因解析判断错误被禁用，现已自动恢复。\n`);
            // 0.3.49 · 台账：撤销自己此前的误伤（reason=EPREFLIGHT-MISFIRE）
            recordPluginJournal({
              action: 'restore', plugin: (r.name || r.id || '(unknown)'), source: 'profile', phase: 'startup',
              result: 'ok', reason: 'EPREFLIGHT-MISFIRE'
            });
          }
        }
        const preResolve = mgr.preflightBareNameResolution() || { repaired: [], broken: [], restored: [], skipped: [], roots: [], anchor: null };
        const repaired = preResolve.repaired || [];
        const allConflicts = preConflicts.concat(preResolve.broken || []);
        if (allConflicts.length || repaired.length || restored.restored.length) {
          diag('启动预检发现待处理项:', { conflicts: allConflicts, repaired, restored: restored.restored });
          if (repaired.length) {
            updateSplash('已自动修复插件的解析链接…');
            for (const r of repaired) {
              pushLog(`启动预检：插件包 ${r.name} 的安装目录名与包名不一致，已自动建立解析链接（${r.junction}），插件可正常加载。\n`);
            }
          }
          let fix = { fixed: [] };
          if (allConflicts.length) {
            pushLog(`启动预检：发现 ${allConflicts.length} 个问题条目，正在自动处理…\n`);
            fix = mgr.applyLoaderConflictFixes(allConflicts, { kind: 'preflight', reason: '启动预检判定该条目会导致冷启动失败' });
            if (fix.fixed.length) {
              updateSplash('已自动禁用冲突的插件配置条目…');
              const total = fix.fixed.reduce((n, f) => n + f.ids.length, 0);
              pushLog(`启动预检：已禁用 ${total} 个问题条目（各文件已备份）。\n`);
              // 0.3.49 · 台账：启动预检跳过的条目（startup-skip）。逐条记 id，
              // 这样"某插件为什么没加载"在成品里能直接查到，而不是只有一行总数。
              for (const f of fix.fixed) {
                for (const id of (f.ids || [])) {
                  recordPluginJournal({ action: 'startup-skip', plugin: String(id), source: 'profile', phase: 'startup', result: 'ok', reason: 'ELOADERCONFLICT' });
                }
              }
            }
          }
          if (!autoStartHidden && (repaired.length || fix.fixed.length || restored.restored.length)) {
            const restoredPart = restored.restored.length
              ? '已自动恢复（此前被误禁用，现在可以正常加载）：\n\n' + restored.restored.map((r) => `${r.id}：${r.name || ''}`).join('\n') + '\n\n'
              : '';
            const repairPart = repaired.length
              ? '已自动修复（插件继续正常加载，无需操作）：\n\n' + repaired.map((r) => `${r.name}：安装目录名与包名不一致，已建好解析链接`).join('\n') + '\n\n'
              : '';
            const disablePart = fix.fixed.length
              ? '已禁用（与内置组件/官方安装重复，或包确实无法解析；原配置已备份，后缀 .bak）：\n\n' +
                allConflicts.map((c) => `${c.id}：${c.reason}`).join('\n')
              : '';
            const r5 = await dialog.showMessageBox(null, {
              type: fix.fixed.length ? 'warning' : 'info',
              buttons: ['继续启动', '退出'], defaultId: 0, cancelId: 1,
              title: APP_NAME,
              message: fix.fixed.length ? '已处理冲突的插件配置条目' : '已自动修复插件解析',
              detail: restoredPart + repairPart + disablePart +
                '\n\n其余插件不受影响。详情见桌面日志：' + desktopLogPath()
            });
            if (r5.response === 1) { isQuitting = true; lifecycle.exit('user-exit-preflight'); app.exit(0); return; }
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
      // 0.3.49 · B-01：**绑定新端口之前**清理旧后端源遗留的 cookie。
      // 为什么必须在这之前：后端一旦以新端口起来，旧 cookie 就已经随首个请求发出去了；
      // 而 cookie 又忽略端口（RFC 6265），清完再起才是干净的。
      await cleanLegacyBackendCookies();
      diag('步骤5 启动后端');
      const url = await startBackendWithPluginIsolation(shouldIsolatePlugins);
      diag('步骤5 后端已启动:', url);
      // 6) Show UI + promote the tray to its normal (running) menu.
      // 0.3.48 · H-03 阶段三：mainWindow 的"创建"是同步的，但"首帧加载完成"是
      // 异步的 —— did-finish-load 之前给一个 deadline，否则白窗与没启动对用户等价。
      armPaintWatchdog();
      await createMainWindow(url);
      createTray();
      setBootPhase('running');
      diag('步骤6 主窗口与托盘就绪');
      // 0.3.48 · H-01：启动真的成功了 → 失败链断开（计数清零），并显示上一次
      // 自动回滚留下的"已自动回滚到 vX"一次性非阻塞提示。
      markStartupHealthy();
      // 0.3.49 · 阶段一审计遗留：把启动早期入队的用户可见通知（插件隔离放弃/还原、
      // 上次更新未完成）在主窗口就绪后**一次性、非阻塞**地告诉用户。
      showDeferredNotices();
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
          // 0.3.48 · H-01(3)：从「只写日志」升级为「决定是否提示用户」—— 这条
          // 证据是"当前版本可能本身不可用"的唯一早期信号，必须让用户看见（非阻塞），
          // 并顺手给出当时唯一有效的动作（回滚到上一个版本）。
          promptJournalUnverified(stale);
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
    if (isQuitting || !tray) {
      const why = isQuitting ? 'window-all-closed' : 'no-tray-quit';
      isQuitting = true;
      try { lifecycle.exit(why, '窗口全部关闭且托盘不可用'); } catch {}
      killProcessTree(backend); app.quit();
    }
  });

  // 0.3.46 · 系统关机/注销：Electron 在 Windows 上会先发 before-quit，
  // 这里补一条带原因的退出记录，让「机器关机导致的退出」与「被杀」可区分。
  try {
    const { powerMonitor } = require('electron');
    if (powerMonitor && typeof powerMonitor.on === 'function') {
      powerMonitor.on('shutdown', () => {
        try { lifecycle.exit('system-shutdown', '收到系统关机/注销事件'); } catch {}
      });
    }
  } catch {}

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
    // 0.3.46 · 退出原因台账：所有走到这里还没记过原因的退出，一律记下。
    // 「退出」这一动作本身没有原因可考，但**有没有走到这条路径**能区分
    // 「应用内退出」与「外部强杀」—— 后者根本不会触发本事件。
    if (isQuitting) { try { lifecycle.exit('quit-confirmed', '退出路径已确认'); } catch {} killProcessTree(backend); return; }
    if (quitGuard.settled) { isQuitting = true; try { lifecycle.exit('quit-confirmed', '退出确认已通过'); } catch {} killProcessTree(backend); return; }
    // 后端没起来过 / 已不在 ⇒ 没有任何会被中断的东西，不打扰用户。
    if (!backend || backend.exitCode !== null || !activeUrl) {
      isQuitting = true; try { lifecycle.exit('quit-no-backend', '后端未运行，直接退出'); } catch {} killProcessTree(backend); return;
    }
    e.preventDefault();
    quitGuard.requestQuit('before-quit').then(() => {
      if (isQuitting) killProcessTree(backend);
    }).catch((err) => {
      diag('退出确认异常，直接退出:', err && err.message);
      isQuitting = true; try { lifecycle.exit('quit-guard-error', String((err && err.message) || err)); } catch {} killProcessTree(backend); app.quit();
    });
  });
  // 0.3.46 · 兜底：进程走到 exit 事件却没有任何原因记录 ⇒ 说明是 app.exit()
  // 这类没有专门标注的路径（此时补记一条），而不是外部强杀（强杀不会触发）。
  process.on('exit', () => {
    isQuitting = true;
    try { lifecycle.exit('exit-event', '进程 exit 事件（未标注更具体原因）'); } catch {}
    killProcessTree(backend);
  });
}
