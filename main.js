'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, Tray, nativeImage, clipboard } = require('electron');
const { spawn, spawnSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const { pathToFileURL } = require('url');
const mgr = require('./updater-backend');
const diagLog = require('./diag-log');
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
let mainWindow = null;
let splashWindow = null;
let pendingShowMainWindow = false;
let activeUrl = null;
let activeLanUrl = null;
let activeMobilePort = null;
let mobileBridge = null;
let lastFirewallCommand = null;
let lastFirewallSuccess = null;
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

function stopMobileBridge() {
  if (mobileBridge) {
    try { mobileBridge.close(); } catch {}
    mobileBridge = null;
  }
}

/** Controlled stop: detach listeners first so a deliberate kill is never misread as a crash. */
function stopBackend() {
  stopMobileBridge();
  if (!backend) return;
  const proc = backend;
  backend = null;
  activeUrl = null;
  activeLanUrl = null;
  activeMobilePort = null;
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getLocalIp() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('127.')) {
          return net.address;
        }
      }
    }
  } catch {}
  return null;
}

function getMobileSettings() {
  let settings = {};
  try { settings = mgr.readSettings() || {}; } catch {}
  const m = settings.mobile || {};
  const port = parseInt(m.port, 10);
  return {
    enabled: typeof m.enabled === 'boolean' ? m.enabled : false,
    port: port >= 1 && port <= 65535 ? port : 47896
  };
}

function saveMobileSettings(cfg) {
  const current = getMobileSettings();
  const enabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : current.enabled;
  const portNum = parseInt(cfg.port, 10);
  const port = portNum >= 1 && portNum <= 65535 ? portNum : current.port;
  const updated = { enabled, port };
  try { mgr.writeSettings({ mobile: updated }); } catch (e) {
    pushLog(`[mobile] 保存设置失败: ${e.message}\n`);
  }
  return updated;
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0' }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveMobilePort(preferredPort) {
  const startPort = Math.max(1, Math.min(65535, Number(preferredPort) || 47896));
  for (let offset = 0; offset <= 10; offset++) {
    const candidate = startPort + offset;
    if (candidate > 65535) break;
    const ok = await checkPortAvailable(candidate);
    if (ok) {
      if (offset > 0) {
        pushLog(`[mobile] 端口 ${startPort} 冲突，已递增试探至可用端口 ${candidate}\n`);
      }
      return candidate;
    }
  }
  pushLog(`[mobile] 端口 ${startPort} 连续 10 次试探冲突，回退使用默认端口\n`);
  return startPort;
}

function tryAddFirewallRule(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      lastFirewallSuccess = true;
      return resolve(true);
    }
    const cmd = `netsh advfirewall firewall add rule name="DSH Desktop Mobile" dir=in action=allow protocol=TCP localport=${port}`;
    lastFirewallCommand = cmd;
    const delCmd = 'netsh advfirewall firewall delete rule name="DSH Desktop Mobile"';
    exec(delCmd, { windowsHide: true }, () => {
      exec(cmd, { windowsHide: true }, (err) => {
        if (err) {
          diag('防火墙规则添加失败 (可能需要管理员权限):', err.message);
          pushLog(`[mobile] 防火墙入站规则添加失败: ${err.message}\n`);
          lastFirewallSuccess = false;
          resolve(false);
        } else {
          diag('防火墙规则已添加: TCP', port);
          pushLog(`[mobile] 已成功添加入站防火墙规则: TCP ${port}\n`);
          lastFirewallSuccess = true;
          resolve(true);
        }
      });
    });
  });
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

    const mobileCfg = getMobileSettings();
    let args = ['--max-http-header-size=1048576', p.dshBin, 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'];
    const localIp = getLocalIp();
    if (localIp) {
      args.push('--trusted-host', localIp);
    }
    if (mobileCfg.enabled) {
      const port = await resolveMobilePort(mobileCfg.port);
      activeMobilePort = port;
      if (localIp) {
        args.push('--trusted-host', `${localIp}:${port}`);
      }
      tryAddFirewallRule(port).catch(() => {});
    } else {
      activeMobilePort = null;
      activeLanUrl = null;
    }

    const child = spawn(p.nodeExe, args, {
      cwd: path.dirname(p.dshBin), env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    backend = child;
    pushLog(`starting backend: node=${p.nodeExe} DSH_HOME=${p.dshHome} host=127.0.0.1 port=0 (mobileEnabled=${mobileCfg.enabled})\n`);

    let settled = false;
    const onUrl = (line) => {
      const m = /dsh web:\s*(https?:\/\/[^\s]+)/i.exec(line);
      if (!m) return;
      const url = m[1].trim();

      if (mobileCfg.enabled && activeMobilePort) {
        stopMobileBridge();
        try {
          const parsedUrl = new URL(url);
          const targetPort = Number(parsedUrl.port);
          mobileBridge = net.createServer((clientSocket) => {
            const upstream = net.connect({ port: targetPort, host: '127.0.0.1' }, () => {
              clientSocket.pipe(upstream);
              upstream.pipe(clientSocket);
            });
            clientSocket.on('error', () => upstream.destroy());
            upstream.on('error', () => clientSocket.destroy());
          });
          mobileBridge.listen(activeMobilePort, '0.0.0.0', () => {
            pushLog(`[mobile] 局域网端口桥接已启动: 0.0.0.0:${activeMobilePort} -> 127.0.0.1:${targetPort}\n`);
          });
          mobileBridge.on('error', (e) => {
            pushLog(`[mobile] 局域网桥接异常: ${e.message}\n`);
          });
          if (localIp) {
            activeLanUrl = `http://${localIp}:${activeMobilePort}/${parsedUrl.search}`;
          }
        } catch (e) {
          pushLog(`[mobile] 构建转发桥失败: ${e.message}\n`);
        }
      } else {
        const lanMatch = /\(LAN:\s*(https?:\/\/[^\s)]+)\)/i.exec(line);
        if (lanMatch) {
          activeLanUrl = lanMatch[1].trim();
        }
      }

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
async function startBackendWithHealing(opts = {}) {
  const isolationRound = !!(opts && opts.isolationRound);
  const p = activePaths();
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
      stopBackend();
      await new Promise((r) => setTimeout(r, 800));
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
  stopBackend();
  await new Promise((r) => setTimeout(r, 1200));
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
      stopBackend();
      await new Promise((r) => setTimeout(r, 600));
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
      stopBackend();
      await new Promise((r) => setTimeout(r, 600));
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
        stopBackend();
        await new Promise((r) => setTimeout(r, 800));
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
  const fixed = mgr.repairProfileJunctions(p.dshHome);
  if (fixed > 0) {
    pushLog(`自定义插件 junction 修复/重建：${fixed} 项。\n`);
    stopBackend();
    await new Promise((r) => setTimeout(r, 800));
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
  stopBackend();
  await new Promise((r) => setTimeout(r, 800));

  if (disabled.length) {
    try {
      pushLog('retrying backend after disabling broken plugin entries…\n');
      return await spawnBackend();
    } catch (retryErr1b) {
      pushLog('backend start failed after plugin entry disable\n');
    }
  }

  // Escalation 2 (LAST resort): quarantine the broken profiles dir — dsh
  // rebuilds a fresh tree — but FIRST preserve third-party registrations
  // (bundles / dependencies / profile patches) so a successful rebuild can
  // AUTO-RESTORE them instead of leaving the user to reinstall everything by
  // hand. If the re-merged boot fails, the restore is rolled back and the
  // failure falls through to Node repair.
  const qRes = mgr.quarantineProfiles(p.dshHome);
  let booted = false;
  if (qRes && qRes.quarantined) {
    if (!qRes.fallback) {
      pushLog(`旧 profiles 已备份为 ${qRes.name}（未删除），dsh 将重建配置。\n`);
    } else {
      pushLog('旧 profiles 清理完成，dsh 将重建配置。\n');
    }
    stopBackend();
    await new Promise((r) => setTimeout(r, 800));
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
        stopBackend();
        await new Promise((r) => setTimeout(r, 800));
        try {
          return await spawnBackend();
        } catch (restoreBootErr) {
          pushLog('还原第三方注册后启动失败，回滚还原。第三方注册仍保存在备份中，可稍后手动恢复。\n');
          mgr.rollbackProfileRestore(p.dshHome, qRes.registryFile);
          stopBackend();
          await new Promise((r) => setTimeout(r, 800));
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
    mgr.finishPluginIsolation((isolation.entries || []).map((e) => ({ index: e.index, status: 'not-tested' })));
    throw error;
  }
  stopBackend();
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
    stopBackend();
    await new Promise((resolve) => setTimeout(resolve, 500));
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
    { label: '手机配对二维码', click: () => openQrWindow() },
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

function createChromiumWindow(url) {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#0b1020', title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  Menu.setApplicationMenu(null);
  applyWindowHandlers(win);

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
  setBootPhase('failed', err);
  closeSplash();
  const tail = backendLogs.join('').split(/\r?\n/).filter(Boolean).slice(-30).join('\n');
  let logPath = 'DSH-Desktop-日志.txt';
  try { logPath = diagLog.logFile(); } catch {}

  // Without a tray there is no recovery console at all — keep the old terminal
  // behaviour rather than leaving an invisible, unusable process behind.
  if (!tray || tray.isDestroyed()) {
    dialog.showErrorBox(`${APP_NAME} 启动失败`,
      (err && err.stack ? err.stack : String(err)) +
      '\n\n--- 后端日志（末尾）---\n' + tail +
      `\n\n--- 详细诊断日志：${logPath} ---`);
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

  dialog.showMessageBox(null, {
    type: 'error',
    buttons: ['查看启动日志', '修复插件配置', '以安全模式重启', '重试启动', '留在托盘稍后处理', '退出'],
    defaultId: 0, cancelId: 4, noLink: true,
    title: `${APP_NAME} 启动失败`,
    message: '后端没能启动 —— 自救入口已就绪',
    detail: (err && err.message ? err.message : String(err)) +
      '\n\n--- 后端日志（末尾）---\n' + tail +
      `\n\n完整日志：${logPath}` +
      '\n\n你的会话、密钥、设置都在独立数据目录里，不受影响。' +
      '\n关闭此窗口后，右键系统托盘的 DSH 图标随时可以再进这些操作。'
  }).then(async (r) => {
    switch (r.response) {
      case 0: try { shell.openPath(logPath); } catch {} break;
      case 1: await requestPatchRepair(); break;
      case 2: await requestEnterSafeMode(); break;
      case 3: await restartApp(); break;
      case 4: break; // stay resident; tray remains the recovery console
      case 5: quitApp(); break;
      default: break;
    }
  }).catch(() => {});
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

ipcMain.handle('settings:get', () => settingsSnapshot());
ipcMain.handle('settings:set-route', (_e, route) => {
  if (route !== 'official' && route !== 'mirror') return null;
  mgr.writeSettings({ npmRegistry: route });
  const info = mgr.registryInfo();
  pushLog(`更新路线已切换：${info.label}（${info.url}）\n`);
  diag('更新路线设置变更:', info);
  return info;
});
ipcMain.handle('settings:check-updates', async () => {
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
ipcMain.handle('settings:download-updates', async () => {
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
ipcMain.handle('settings:set-autostart', (_e, on) => {
  try { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); pushLog(`auto-start ${on ? 'enabled' : 'disabled'}（设置窗）\n`); return true; } catch { return false; }
});
ipcMain.handle('settings:open-log', () => {
  try { return shell.openPath(require('./diag-log').logFile()); } catch { return 'failed'; }
});
ipcMain.handle('settings:restart-app', () => restartApp());
ipcMain.handle('settings:set-node-dist', (_e, dist) => {
  if (dist !== 'official' && dist !== 'mirror') return null;
  mgr.writeSettings({ nodeDist: dist });
  const info = mgr.nodeDistInfo();
  pushLog(`Node 下载源已切换：${info.label}（${info.url}）\n`);
  return info;
});
ipcMain.handle('settings:check-node', async () => {
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
ipcMain.handle('settings:download-node', async (_e, version) => {
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
// Mobile companion — QR window and IPC
// ---------------------------------------------------------------------------
let qrSvgFn = null;
async function getQrSvg() {
  if (!qrSvgFn) {
    const qrPath = path.join(__dirname, 'plugins', 'mobile-companion', 'lib', 'qr.mjs');
    const mod = await import(pathToFileURL(qrPath).href);
    qrSvgFn = mod.qrSvg;
  }
  return qrSvgFn;
}

let qrWindow = null;

async function renderQrWindow(win) {
  const mobileCfg = getMobileSettings();
  let html = '';
  if (activeLanUrl) {
    let svg = '';
    try {
      const qrSvg = await getQrSvg();
      svg = qrSvg(activeLanUrl, { scale: 5, quiet: 2 });
    } catch (e) {
      svg = `<div style="color:#bf616a;padding:20px;font-size:12px;">生成二维码失败: ${escapeHtml(e.message)}</div>`;
    }
    html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机配对二维码</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #ffffff;
    color: #1a202c;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 20px 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    user-select: none;
  }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #111827; }
  .qr-box {
    width: 200px;
    height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 8px;
    background: #ffffff;
    box-shadow: 0 2px 6px rgba(0,0,0,0.05);
  }
  .qr-box svg { width: 100%; height: 100%; display: block; }
  .url-card {
    margin-top: 12px;
    width: 100%;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: #334155;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .url-text {
    flex: 1;
    text-align: left;
    font-family: Consolas, Monaco, monospace;
    font-size: 11px;
    word-break: break-all;
    user-select: text;
  }
  .btn-copy {
    background: #2563eb;
    color: #ffffff;
    border: none;
    border-radius: 4px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-copy:hover { background: #1d4ed8; }
  .btn-copy.copied { background: #16a34a; }
  .steps {
    margin-top: 14px;
    text-align: left;
    width: 100%;
    background: #f9fafb;
    border-radius: 6px;
    padding: 10px 12px 10px 28px;
    font-size: 12px;
    color: #4b5563;
    line-height: 1.6;
  }
  .steps li { margin-bottom: 2px; }
  .steps li:last-child { margin-bottom: 0; }
</style>
</head>
<body>
  <h2>手机配对</h2>
  <div class="qr-box">${svg}</div>
  <div class="url-card">
    <div class="url-text" id="urlText">${escapeHtml(activeLanUrl)}</div>
    <button class="btn-copy" id="btnCopy" onclick="copyUrl()">复制</button>
  </div>
  <ol class="steps">
    <li>手机安装 <b>DSH 手机版 App</b> 扫码连接</li>
    <li>或手机浏览器直接打开该 URL 后访问 <b>/m/</b></li>
    <li>请确保手机与电脑在同一局域网（Wi-Fi）</li>
  </ol>
  <script>
    function copyUrl() {
      const text = document.getElementById('urlText').innerText;
      const btn = document.getElementById('btnCopy');
      const finish = () => {
        btn.textContent = '已复制！';
        btn.className = 'btn-copy copied';
        setTimeout(() => { btn.textContent = '复制'; btn.className = 'btn-copy'; }, 1500);
      };
      if (window.dshSettings && window.dshSettings.copyText) {
        window.dshSettings.copyText(text).then(finish);
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(finish).catch(() => fallback(text, finish));
      } else {
        fallback(text, finish);
      }
    }
    function fallback(text, cb) {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy'); cb(); } catch {}
      document.body.removeChild(t);
    }
  </script>
</body>
</html>`;
  } else {
    html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>手机配对二维码</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #ffffff;
    color: #1a202c;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 28px 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .icon { font-size: 36px; margin-bottom: 10px; }
  h2 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #111827; }
  .guide {
    background: #fffbeb;
    border: 1px solid #fef3c7;
    border-radius: 6px;
    padding: 10px 14px;
    color: #b45309;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 16px;
    width: 100%;
  }
  .status-list {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 12px 14px;
    width: 100%;
    text-align: left;
    font-size: 12px;
    margin-bottom: 20px;
  }
  .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #edf2f7; }
  .row:last-child { border-bottom: none; }
  .k { color: #64748b; }
  .v { color: #0f172a; font-weight: 500; }
  .actions { display: flex; gap: 10px; width: 100%; }
  button {
    flex: 1;
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  button.secondary {
    background: #f1f5f9;
    color: #334155;
    border: 1px solid #cbd5e1;
  }
  button.secondary:hover { background: #e2e8f0; }
</style>
</head>
<body>
  <div class="icon">📱</div>
  <h2>未获取到局域网访问地址</h2>
  <div class="guide">请先在设置中启用手机访问并重启后端</div>
  <div class="status-list">
    <div class="row"><span class="k">手机访问设置</span><span class="v">${mobileCfg.enabled ? '已开启' : '未开启'}</span></div>
    <div class="row"><span class="k">设置端口</span><span class="v">${mobileCfg.port}</span></div>
    <div class="row"><span class="k">后端运行状态</span><span class="v">${backend ? (activeMobilePort ? `运行中（端口 ${activeMobilePort}）` : '运行中（本地模式）') : '未运行'}</span></div>
  </div>
  <div class="actions">
    <button class="secondary" onclick="openSettings()">打开设置</button>
    <button onclick="restart()">重启应用</button>
  </div>
  <script>
    function openSettings() {
      if (window.dshSettings && window.dshSettings.openSettings) {
        window.dshSettings.openSettings();
      } else {
        window.location.hash = '#open-settings';
      }
    }
    function restart() {
      if (window.dshSettings && window.dshSettings.restart) {
        window.dshSettings.restart();
      } else {
        window.location.hash = '#restart';
      }
    }
  </script>
</body>
</html>`;
  }
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

async function openQrWindow() {
  if (qrWindow && !qrWindow.isDestroyed()) {
    await renderQrWindow(qrWindow);
    qrWindow.show();
    qrWindow.focus();
    return;
  }

  qrWindow = new BrowserWindow({
    width: 380,
    height: 480,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '手机配对二维码',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null);
  qrWindow.webContents.on('will-navigate', (event, url) => {
    if (url.includes('#open-settings')) {
      event.preventDefault();
      createSettingsWindow();
    } else if (url.includes('#restart')) {
      event.preventDefault();
      restartApp();
    }
  });

  await renderQrWindow(qrWindow);
  qrWindow.once('ready-to-show', () => {
    if (qrWindow && !qrWindow.isDestroyed()) {
      qrWindow.show();
      qrWindow.focus();
    }
  });
  qrWindow.on('closed', () => { qrWindow = null; });
}

function getMobileStatus() {
  const cfg = getMobileSettings();
  return {
    enabled: cfg.enabled,
    port: cfg.port,
    activePort: activeMobilePort,
    lanUrl: activeLanUrl,
    firewallOk: lastFirewallSuccess,
    firewallCommand: lastFirewallCommand || `netsh advfirewall firewall add rule name="DSH Desktop Mobile" dir=in action=allow protocol=TCP localport=${cfg.port}`
  };
}

ipcMain.handle('mobile:get', () => getMobileStatus());
ipcMain.handle('mobile:set', async (_e, data) => {
  const prev = getMobileSettings();
  const next = saveMobileSettings(data || {});
  if (!prev.enabled && next.enabled) {
    await tryAddFirewallRule(next.port);
  }
  return getMobileStatus();
});
ipcMain.handle('mobile:openQr', async () => {
  await openQrWindow();
  return true;
});
ipcMain.handle('mobile:copy-text', (_e, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('settings:open', () => {
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
  // Strip any stale --safe-mode so a normal restart exits safe mode by default.
  const baseArgs = process.argv.slice(1).filter((a) => a !== '--safe-mode');
  app.relaunch({ args: baseArgs.concat(extraArgs || []) });
  app.exit(0);
}

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('backend:versions', () => { try { return mgr.currentVersions(); } catch { return null; } });
ipcMain.handle('env:isolation', () => { try { return mgr.describeEnvIsolation(); } catch { return null; } });
ipcMain.handle('backend:check-updates', () => checkBackendUpdates({ includeNode: true }));
// 后端全版本列表（npm 已发布全部版本，倒序）+ 当前/暂存/最新。
ipcMain.handle('backend:list-versions', async () => {
  try {
    const info = await mgr.npmDshVersionsAll();
    const cur = mgr.currentVersions()?.dsh || null;
    const staged = mgr.stagedVersions()?.dsh || null;
    return { all: info.all, latest: info.latest, current: cur, staged, engines: info.engines };
  } catch (e) { return { err: (e && e.message) || '获取版本列表失败' }; }
});
// 回退兼容性分析：对目标版本给出各插件可用性判定 + 导出桌面报告。
ipcMain.handle('backend:compat-plan', async (_e, version) => {
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
ipcMain.handle('backend:rollback-to', async (_e, version) => {
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
ipcMain.handle('plugins:terminal-status', () => {
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
ipcMain.handle('plugins:set-dsh-home-env', (_e, enabled) => {
  try {
    const st = mgr.setDshHomeEnv(!!enabled);
    diag('DSH_HOME 用户环境变量:', enabled ? '写入' : '移除', st.current);
    return { ok: true, env: st };
  } catch (e) { return { ok: false, msg: (e && e.message) || '写入环境变量失败' }; }
});

// 生成包装器脚本 + 加入/移出用户 PATH（追加在末尾，不抢占已有全局 dsh）。
ipcMain.handle('plugins:set-path-entry', (_e, enabled) => {
  try {
    const st = mgr.setUserPathEntry(!!enabled);
    diag('包装器 PATH:', enabled ? '加入' : '移出', st.dir);
    return { ok: true, path: st };
  } catch (e) { return { ok: false, msg: (e && e.message) || '修改 PATH 失败' }; }
});

ipcMain.handle('plugins:write-wrappers', () => {
  try { return { ok: true, ...mgr.writeWrapperScripts() }; }
  catch (e) { return { ok: false, msg: (e && e.message) || '生成包装器失败' }; }
});

// 应用内安装插件 —— 唯一保证 DSH_HOME 正确的通道（分发用户无需碰终端）。
ipcMain.handle('plugins:install', async (_e, payload) => {
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
ipcMain.handle('plugins:scan-legacy', () => {
  try {
    const scan = mgr.scanLegacyHome();
    diag('旧 Home 扫描:', { home: scan.home, exists: scan.exists, orphans: scan.total });
    return { ok: true, scan };
  } catch (e) { return { ok: false, msg: (e && e.message) || '扫描失败' }; }
});

// 勾选导入：逐个走应用内安装流程装进桌面 home，并把报告导出到桌面。
ipcMain.handle('plugins:import-legacy', async (_e, payload) => {
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

ipcMain.handle('app:restart', () => restartApp());

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
      // 5) Start backend (self-heals and retries on profile/symlink errors).
      diag('步骤5 启动后端');
      const url = await startBackendWithPluginIsolation(shouldIsolatePlugins);
      diag('步骤5 后端已启动:', url);
      // 6) Show UI + promote the tray to its normal (running) menu.
      await createMainWindow(url);
      createTray();
      setBootPhase('running');
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
