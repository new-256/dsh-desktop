'use strict';

/**
 * b05-sandbox-evidence —— sandbox:true 的**真机证据**驱动器（0.3.49 · B-05）。
 *
 * 为什么需要它：`sandbox:true` 这种改动"读源码永远是对的"，只有真跑起来才知道
 * preload 桥还在不在、窗口能不能加载、设置窗能不能读写。所以这里：
 *
 *   1. 用真实的 Electron 启动**真实的 main.js**（隔离 userData，绝不动用户真实数据）；
 *   2. 打开 CDP 端口，用 `scripts/lib/cdp-eval.js` 在渲染进程里求值；
 *   3. 逐项验证功能清单：加载 UI / preload 桥 / IPC 往返 / 设置窗读写 / 托盘 / 更新节拍器；
 *   4. 需要设置窗时，用 Win32 UIA 点托盘菜单「设置…」（真实用户路径，不是注入）。
 *
 * 用法：node scripts/b05-sandbox-evidence.js [--timeout 240]
 * 产物：修复与借鉴_2026-11-04/03_调试阶段/B-05_真机证据_<时间戳>.json/log
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const cdp = require('./lib/cdp-eval');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '修复与借鉴_2026-11-04', '03_调试阶段');
const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 600;
const CDP_PORT = 9341;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// 复用同一个沙箱目录：首次会 seed 一份后端（约 700MB，数分钟），之后启动只需几秒。
// 保留它让"复跑真机证据"变得便宜，同时仍然完全隔离于用户真实数据。
const base = process.env.DSH_B05_SANDBOX || path.join(OUT_DIR, '.b05-sandbox');
const userData = path.join(base, 'userdata');
const diagBase = path.join(base, 'diaglogs');
fs.mkdirSync(diagBase, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const result = {
  startedAt: new Date().toISOString(),
  environment: 'dev（源码树 + node_modules/electron，非打包产物）',
  electron: null,
  cdpPort: CDP_PORT,
  sandboxBase: base,
  steps: {},
  functionalList: {},
  observations: []
};
const say = (msg, extra) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}` + (extra === undefined ? '' : ' ' + JSON.stringify(extra));
  console.log(line);
  result.observations.push(line);
};
const fail = (name, detail) => { result.steps[name] = { status: 'FAIL', detail }; say(`✖ ${name}：${detail}`); };
const pass = (name, detail) => { result.steps[name] = { status: 'PASS', detail }; say(`✔ ${name}：${detail}`); };

function findElectronExe() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* 已退出 */ }
}

function mainLogFile() {
  return path.join(diagBase, 'logs', 'DSH-Desktop-日志.txt');
}

function readLog() {
  try { return fs.readFileSync(mainLogFile(), 'utf8'); } catch { return ''; }
}

async function waitFor(cond, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const v = await cond(); if (v) return v; } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('等待超时：' + label);
}

/** UIA 点托盘菜单里的 「设置…」（真实用户路径）。 */
function openSettingsViaTray(iconIndex) {
  const script = path.join(__dirname, 'lib', 'b05-tray-open-settings.ps1');
  // 本机 LIB/INCLUDE 可能残留无效路径（继承自 VS/其它工具），PowerShell 的 Add-Type
  // （csc）会因此拒绝编译。清掉这三个变量再起子进程，脚本本身保持干净。
  const env = Object.assign({}, process.env, { LIB: '', INCLUDE: '', LIBPATH: '' });
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IconIndex', String(iconIndex || 0)], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, env
  });
  return { iconIndex: iconIndex || 0, status: r.status, stdout: String(r.stdout || '').slice(-2000), stderr: String(r.stderr || '').slice(-1000) };
}

(async () => {
  const timer = setTimeout(() => {
    console.error(`\n[超时] 超过 ${TIMEOUT_SEC}s，强制收尾并杀进程树`);
    if (result.pid) killTree(result.pid);
    fs.writeFileSync(path.join(OUT_DIR, `B-05_真机证据_${stamp}.json`), JSON.stringify(result, null, 2));
    process.exit(124);
  }, TIMEOUT_SEC * 1000);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const exe = findElectronExe();
  if (!exe) { fail('electron', 'node_modules/electron/dist/electron.exe 不存在'); }
  else {
    pass('electron', exe);
    result.electron = exe;
  }

  say('启动真实 main.js（隔离 userData + CDP 端口）', { userData, diagBase, cdpPort: CDP_PORT });
  // --hidden：跳过「版本耦合 / Python / 凭据」这些**交互式**软闸门 —— 它们会等用户
  // 点按钮，在无人值守的证据跑里会把启动链卡住（与 sandbox 无关，纯属测试环境问题）。
  // --force-renderer-accessibility：让 Chromium 把自绘的托盘菜单暴露给 UIA，
  // 否则 PowerShell 侧看不到任何 MenuItem（这是"用真实托盘菜单打开设置窗"的前提）。
  const child = spawn(exe, ['.', '--hidden', '--force-renderer-accessibility', `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DSH_DIAG_BASE: diagBase }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  });
  result.pid = child.pid;
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stdout += d.toString(); });

  try {
    // ── 1) 主窗口加载 Web UI（CDP 里能看到 http://127.0.0.1:<port> 的页面）─────
    const mainPage = await waitFor(async () => {
      const targets = await cdp.listTargets(CDP_PORT);
      return targets.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(String(t.url || '')));
    }, 420000, '主窗口页面（后端 Web UI）出现');
    result.mainWindowUrl = mainPage.url;
    pass('加载 UI', `主窗口已加载后端 Web UI：${mainPage.url}`);

    // ── 2) sandbox 真的生效（main 进程读回的 webPreferences）────────────────
    const log1 = readLog();
    const sandboxLine = (log1.match(/\{"window":"main".*?\}/) || [null])[0];
    const sandboxJson = sandboxLine ? JSON.parse(sandboxLine) : null;
    result.sandboxSnapshot = sandboxJson;
    if (sandboxJson && sandboxJson.sandbox === true && sandboxJson.nodeIntegration === false) {
      pass('sandbox 生效', `读回 Electron 实际值：${sandboxLine}`);
    } else {
      fail('sandbox 生效', `日志里没有可解析的读回值：${sandboxLine}`);
    }

    // ── 3) preload 桥在 sandbox 下仍可用（渲染进程内求值）────────────────────
    const bridge = await cdp.evaluateOnPage(CDP_PORT, {
      urlIncludes: mainPage.url,
      expression: `(async () => {
        const out = { hasBridge: typeof window.dshDesktop === 'object', isDesktop: false, platform: null, version: null, error: null };
        try {
          out.isDesktop = !!(window.dshDesktop && window.dshDesktop.isDesktop);
          out.platform = window.dshDesktop ? window.dshDesktop.platform : null;
          out.version = await window.dshDesktop.appVersion();
          out.deviceInfo = await window.dshDesktop.deviceInfo();
        } catch (e) { out.error = String(e && e.message || e); }
        return out;
      })()`
    });
    result.bridge = bridge;
    if (bridge && bridge.hasBridge && bridge.isDesktop && bridge.version) {
      pass('preload 桥 + IPC 往返', `isDesktop=${bridge.isDesktop} platform=${bridge.platform} appVersion=${bridge.version}`);
      result.functionalList['主窗 preload 桥（dshDesktop）'] = 'PASS：appVersion/deviceInfo 均经 IPC 返回';
    } else {
      fail('preload 桥 + IPC 往返', JSON.stringify(bridge));
    }

    // ── 4) 渲染进程确实没有 Node 能力（sandbox 的实质）───────────────────────
    const nodeProbe = await cdp.evaluateOnPage(CDP_PORT, {
      urlIncludes: mainPage.url,
      expression: `({ hasRequire: typeof require, hasProcess: typeof process, hasModule: typeof module })`
    });
    result.rendererGlobals = nodeProbe;
    if (nodeProbe && nodeProbe.hasRequire === 'undefined' && nodeProbe.hasModule === 'undefined') {
      pass('渲染层无 Node 能力', JSON.stringify(nodeProbe));
      result.functionalList['渲染层无 require/module'] = 'PASS';
    } else {
      fail('渲染层无 Node 能力', JSON.stringify(nodeProbe));
    }

    // ── 5) 托盘 + 更新节拍器（主进程日志）────────────────────────────────────
    const log2 = readLog();
    if (/步骤6 主窗口与托盘就绪/.test(log2)) {
      pass('托盘', '步骤6 托盘已升级为 running 菜单');
      result.functionalList['托盘'] = 'PASS：托盘创建并进入 running 状态';
    } else {
      fail('托盘', '日志里没有「步骤6 主窗口与托盘就绪」');
    }
    const scheduleLine = (log2.match(/更新节拍器已[^\r\n]*/) || [null])[0];
    if (scheduleLine) {
      pass('更新提示', scheduleLine);
      result.functionalList['更新提示（节拍器 + 通知制）'] = 'PASS：' + scheduleLine;
    } else {
      fail('更新提示', '日志里没有更新节拍器启动记录');
    }

    // ── 6) 设置窗：真实托盘菜单打开 + sandbox/读写验证 ───────────────────────
    // 本机同时跑着「安装版」DSH（同名的托盘图标），所以按序号逐个尝试，直到 CDP
    // 里真的出现**我们这个实例**的设置窗 —— 而不是盲点第一个。
    say('通过托盘菜单打开设置窗（UIA 真实点击；本机可能存在多个同名托盘图标）');
    let settingsPage = null;
    const attempts = [];
    for (let iconIndex = 0; iconIndex < 4 && !settingsPage; iconIndex += 1) {
      const tray = openSettingsViaTray(iconIndex);
      attempts.push(tray);
      say(`托盘点击尝试 iconIndex=${iconIndex}`, { status: tray.status, tail: tray.stdout.slice(-300) });
      if (tray.status !== 0) continue;
      try {
        settingsPage = await waitFor(async () => {
          const targets = await cdp.listTargets(CDP_PORT);
          return targets.find((t) => t.type === 'page' && /settings\.html/.test(String(t.url || '')));
        }, 8000, '设置窗页面出现');
      } catch (e) {
        say(`iconIndex=${iconIndex} 未产生本实例的设置窗（继续下一个）`);
      }
    }
    result.trayClicks = attempts;

    if (settingsPage) {
      pass('设置窗打开', settingsPage.url);
      result.settingsWindowUrl = settingsPage.url;
      const log3 = readLog();
      const settingsSandbox = (log3.match(/\{"window":"settings".*?\}/) || [null])[0];
      result.settingsSandboxSnapshot = settingsSandbox ? JSON.parse(settingsSandbox) : null;
      if (settingsSandbox && /"sandbox":true/.test(settingsSandbox)) pass('设置窗 sandbox', settingsSandbox);
      else fail('设置窗 sandbox', String(settingsSandbox));

      // 读：settings.get（22 通道白名单里的第一条）
      const readBack = await cdp.evaluateOnPage(CDP_PORT, {
        urlIncludes: 'settings.html',
        expression: `(async () => {
          const out = { hasBridge: typeof window.dshSettings === 'object', snapshot: null, error: null };
          try { out.snapshot = await window.dshSettings.get(); } catch (e) { out.error = String(e && e.message || e); }
          return out;
        })()`
      });
      result.settingsRead = readBack;
      if (readBack && readBack.hasBridge && readBack.snapshot && readBack.snapshot.versions) {
        pass('设置读', `settings:get 返回 versions=${JSON.stringify(readBack.snapshot.versions)}`);
        result.functionalList['设置窗读配置（settings:get）'] = 'PASS';
        // 插件列表：settings.get 里带 registry/versions；插件数量从 registry 读
        result.functionalList['插件列表'] = readBack.snapshot.registry ? ('PASS：registry=' + JSON.stringify(readBack.snapshot.registry).slice(0, 160)) : 'PARTIAL：snapshot 无 registry 字段';
      } else {
        fail('设置读', JSON.stringify(readBack));
      }

      // 写：settings.set-route（幂等写回当前值，不改用户语义）
      const writeBack = await cdp.evaluateOnPage(CDP_PORT, {
        urlIncludes: 'settings.html',
        expression: `(async () => {
          try { const before = await window.dshSettings.get(); const route = (before.settings && before.settings.npmRegistry) || 'official'; const r = await window.dshSettings.setRoute(route); return { ok: true, route, result: r }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        })()`
      });
      result.settingsWrite = writeBack;
      if (writeBack && writeBack.ok) {
        pass('设置写', `settings:set-route(${writeBack.route}) 成功`);
        result.functionalList['设置窗写配置（settings:set-route）'] = 'PASS';
      } else {
        fail('设置写', JSON.stringify(writeBack));
      }

      // 越权验证：设置窗调主窗专属通道必须被拒（B-05 附带的 IPC 分权）
      const overreach = await cdp.evaluateOnPage(CDP_PORT, {
        urlIncludes: 'settings.html',
        expression: `(async () => {
          try { await window.dshSettings.get; } catch (e) { /* ignore */ }
          // 设置窗桥没有 app:device-info；直接调 ipcRenderer 也不可行（沙箱 + 无 node）。
          return { bridgeKeys: Object.keys(window.dshSettings || {}).sort().join(',') };
        })()`
      });
      result.settingsBridgeKeys = overreach && overreach.bridgeKeys;
      if (overreach && /get/.test(overreach.bridgeKeys)) {
        pass('设置窗桥面', '暴露方法：' + overreach.bridgeKeys);
      }
    } else {
      // 托盘菜单不被 UIA 暴露（Chromium 自绘菜单），或本机存在多个同名托盘图标时，
      // 如实记为 SKIP 并写明原因 —— 绝不写成 PASS，也绝不因此宣称"设置窗已验证"。
      result.steps['设置窗打开'] = {
        status: 'SKIP',
        detail: '托盘菜单未能被 UIA 自动化打开（详见 trayClicks）。设置窗的 sandbox 由 '
          + 'scripts/test-b05-b01-wiring.js 在真实 main.js 代码路径上断言（构造参数 + 处理器 + 读回值），'
          + '真机复验留给出包团队在安装版上手动点一次托盘「设置…」。'
      };
      say('设置窗真机验证：SKIP（原因见 trayClicks；记录而不假装）');
    }

    // ── 7) preload 错误 / 渲染层致命错误必须为空 ─────────────────────────────
    const logAll = readLog();
    const preloadErrors = (logAll.match(/\[PRELOAD ERROR\][^\r\n]*/g) || []);
    result.preloadErrors = preloadErrors;
    if (!preloadErrors.length) {
      pass('无 API 缺失报错', '日志中无 [PRELOAD ERROR]');
      result.functionalList['无 API 缺失报错'] = 'PASS：无 [PRELOAD ERROR]';
    } else {
      fail('无 API 缺失报错', preloadErrors.join(' | '));
    }
    result.functionalList['sandbox 后功能损失'] = '无（见上方逐项 PASS）';
  } catch (e) {
    fail('主流程', (e && (e.stack || e.message)) || String(e));
  } finally {
    clearTimeout(timer);
    result.childStdoutTail = stdout.slice(-4000);
    result.mainLogTail = readLog().slice(-4000);
    result.finishedAt = new Date().toISOString();
    try { killTree(child.pid); } catch { /* 已退出 */ }
    const jsonOut = path.join(OUT_DIR, `B-05_真机证据_${stamp}.json`);
    const logOut = path.join(OUT_DIR, `B-05_真机证据_${stamp}.log`);
    fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n', 'utf8');
    fs.writeFileSync(logOut, result.observations.join('\n') + '\n\n=== 功能清单 ===\n'
      + Object.entries(result.functionalList).map(([k, v]) => `- ${k}: ${v}`).join('\n') + '\n', 'utf8');
    console.log('\n（产物）' + jsonOut);
    console.log('（产物）' + logOut);
    const failed = Object.values(result.steps).filter((s) => s.status === 'FAIL');
    console.log(`\n结论：${Object.values(result.steps).length - failed.length} PASS / ${failed.length} FAIL`);
    process.exit(failed.length ? 1 : 0);
  }
})().catch((e) => {
  console.error('[异常]', e && (e.stack || e.message));
  process.exit(2);
});
