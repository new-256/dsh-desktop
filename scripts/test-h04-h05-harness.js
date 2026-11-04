'use strict';

/**
 * 验证脚本的公共脚手架（**仅供测试期使用**，不随应用运行）。
 *
 * 使用者：阶段一 `test-h04-*.js` / `test-h05-*.js`；阶段二 `test-b03-*.js` /
 * `test-b17-*.js` / `test-b08-b06-*.js`（文件名沿用了最初引入时的前缀，内容与业务无关）。
 *
 * 它解决的三个问题：
 *  1. 防卡死：默认 120s 硬超时。超时立刻打印「卡在哪一步」+ 最后 40 条日志，
 *     并以 124 退出 —— 绝不允许测试无限挂起（PROJECT_RULES §5）。
 *  2. 硬件资源监控：另起一个**独立进程**（pwsh）每 3s 采样整机 CPU / 内存 /
 *     显存（有 nvidia-smi 才采），追加写入调试阶段日志。
 *  3. 真验证的取证：控制台输出同时进环形缓冲；断言失败一律打印实际值。
 *
 * 用法：
 *   const { createHarness } = require('./test-h04-h05-harness');
 *   const H = createHarness({ name: 'H-04 …', timeoutMs: 120000 });
 *   H.installElectronStub({ userData, desktop, resourcesPath, isPackaged: true });
 *   const mgr = require('../updater-backend.js');   // 必须在 stub 之后
 *   H.step('场景1 …'); H.eq(actual, expected, '标签'); … H.finish();
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 安装 electron 桩：纯 Node 进程里 `require('electron')` 会拿到一个字符串路径，
 * updater-backend 需要 `app.getPath/getVersion/isPackaged`。必须在 require 业务模块**之前**调用。
 */
function installElectronStub(opts = {}) {
  const stub = {
    app: {
      isPackaged: !!opts.isPackaged,
      getPath: (name) => (name === 'desktop' ? opts.desktop : opts.userData),
      getVersion: () => opts.version || '0.3.48',
      getName: () => 'DSH Desktop',
      getAppPath: () => REPO_ROOT,
      relaunch: () => {},
      quit: () => {}
    },
    dialog: {
      showMessageBoxSync: () => 0,
      showMessageBox: async () => ({ response: 0 })
    }
  };
  const id = require.resolve('electron');
  require.cache[id] = { id, filename: id, loaded: true, exports: stub, paths: [] };
  if (opts.resourcesPath) process.resourcesPath = opts.resourcesPath;
  return stub;
}

/**
 * 阻塞等待「目标目录真的被占用到不能 rename」。
 * 做法：反复尝试把 dir rename 到一个探针名再改回来；抛 EPERM/EBUSY 即证明占用生效。
 */
function waitRenameBlocked(dir, timeoutMs = 20000) {
  const probe = `${dir}.lockprobe`;
  const deadline = Date.now() + timeoutMs;
  let lastCode = null;
  while (Date.now() < deadline) {
    try {
      fs.renameSync(dir, probe);
    } catch (e) {
      return { blocked: true, code: e.code };
    }
    lastCode = 'rename-succeeded';
    try { fs.renameSync(probe, dir); }
    catch (e) { throw new Error(`占用探针回滚失败（现场已移动，需人工检查 ${probe}）：${e.message}`); }
    sleepSync(150);
  }
  return { blocked: false, code: lastCode };
}

/** 用 pwsh 打开一个「不共享 DELETE」的句柄并保持 —— 复刻杀软/索引服务扫描时的真实占用。 */
function holdFileHandle(file, holdSec = 90) {
  const quoted = file.replace(/'/g, "''");
  const script = `$fs=[System.IO.File]::Open('${quoted}','Open','Read','ReadWrite'); Start-Sleep -Seconds ${holdSec}`;
  return spawn('pwsh', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
}

function createHarness(opts = {}) {
  const name = opts.name || 'test';
  const timeoutMs = opts.timeoutMs || 120000;
  const startedAt = Date.now();
  const tail = [];
  const all = [];
  let currentStep = '(未开始)';
  let pass = 0;
  let fail = 0;
  const failures = [];
  const cleanups = [];
  let monitor = null;
  let monitorLog = null;

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  function emit(line) {
    const text = String(line);
    tail.push(text);
    if (tail.length > 40) tail.shift();
    all.push(text);
    origLog(text);
  }
  console.log = (...a) => emit(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = (...a) => emit(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

  function stopMonitor() {
    if (!monitor) return;
    try { monitor.kill(); } catch (e) { origLog(`（监控进程结束异常：${e.message}）`); }
    monitor = null;
    sampleSelf('monitor-stop');
    if (monitorLog) origLog(`  · 资源监控日志：${monitorLog}`);
  }

  /** 本进程自身的资源采样（短测试没有 3s 采样窗口时，这仍是逐步骤的硬件证据）。 */
  let cpuMark = process.cpuUsage();
  function sampleSelf(tag) {
    if (!monitorLog) return;
    const mu = process.memoryUsage();
    const cu = process.cpuUsage(cpuMark);
    cpuMark = process.cpuUsage();
    const line = `[${new Date().toISOString()}] [test-self] step=${tag} rssMB=${(mu.rss / 1048576).toFixed(1)} `
      + `heapUsedMB=${(mu.heapUsed / 1048576).toFixed(1)} cpuUserMs=${(cu.user / 1000).toFixed(0)} cpuSysMs=${(cu.system / 1000).toFixed(0)}`;
    try { fs.appendFileSync(monitorLog, line + '\n'); } catch (e) { origLog(`  · 自采样写入失败：${e.message}`); }
  }

  const watchdog = setTimeout(() => {
    origLog('');
    origLog(`✗ [超时 ${timeoutMs}ms] ${name} —— 卡在这一步：${currentStep}`);
    origLog('最后 40 条日志：');
    for (const l of tail) origLog('  ' + l);
    stopMonitor();
    process.exit(124);
  }, timeoutMs);
  watchdog.unref && watchdog.unref();

  process.on('uncaughtException', (e) => {
    origLog('');
    origLog(`✗ 未捕获异常：${e && e.stack ? e.stack : e}`);
    origLog(`卡在这一步：${currentStep}`);
    for (const l of tail.slice(-15)) origLog('  ' + l);
    stopMonitor();
    process.exit(2);
  });
  process.on('unhandledRejection', (e) => {
    origLog(`✗ 未处理的 Promise 拒绝：${e && e.stack ? e.stack : e}`);
    stopMonitor();
    process.exit(2);
  });

  const h = {
    sleepSync,
    holdFileHandle,
    waitRenameBlocked,
    repoRoot: REPO_ROOT,
    get stepName() { return currentStep; },
    step(s) {
      currentStep = s;
      sampleSelf(s);
      emit(`\n── ${s}`);
    },
    info(s) { emit(`  · ${s}`); },
    /** 迄今为止的全部输出（供「日志里必须出现某句」类断言取证）。 */
    all,
    seen(pattern) { return all.some((l) => pattern.test(l)); },
    /** 上一次出现的匹配行（断言失败时好打印实际值）。 */
    lastMatch(pattern) {
      for (let i = all.length - 1; i >= 0; i--) if (pattern.test(all[i])) return all[i];
      return null;
    },
    ok(cond, label, actual) {
      if (cond) { pass++; emit(`  ✓ ${label}`); return true; }
      fail++;
      const line = `  ✗ ${label}${actual === undefined ? '' : `（实际=${JSON.stringify(actual)}）`}`;
      emit(line);
      failures.push(line);
      return false;
    },
    eq(actual, expected, label) {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      if (same) { pass++; emit(`  ✓ ${label} = ${JSON.stringify(expected)}`); return true; }
      fail++;
      const line = `  ✗ ${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`;
      emit(line);
      failures.push(line);
      return false;
    },
    onCleanup(fn) { cleanups.push(fn); },
    /** 启动独立的资源监控进程；失败只记录不掩盖（测试逻辑不依赖它）。 */
    startMonitor(logDir) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        monitorLog = path.join(logDir, `${name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}_资源监控_${stamp()}.log`);
        const out = monitorLog.replace(/'/g, "''");
        const script = [
          `$out='${out}'`,
          `"[$(Get-Date -Format o)] monitor start" | Add-Content -Path $out`,
          // 先落一条即时内存采样：短测试（几百毫秒）也要有资源证据
          'try { $o0=Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop; "[$(Get-Date -Format o)] memUsedMB=$([math]::Round(($o0.TotalVisibleMemorySize-$o0.FreePhysicalMemory)/1024,1))/$([math]::Round($o0.TotalVisibleMemorySize/1024,1))" | Add-Content -Path $out } catch {}',
          'while ($true) {',
          '  $cpu="NA"',
          '  try { $cpu=(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name=\'_Total\'" -ErrorAction Stop).PercentProcessorTime } catch {}',
          '  $mem="NA"',
          '  try { $o=Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop; $mem="$([math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1024,1))/$([math]::Round($o.TotalVisibleMemorySize/1024,1))" } catch {}',
          '  $gpu="NA"',
          '  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {',
          '    try { $gpu=(& nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader | Select-Object -First 1) } catch {}',
          '  }',
          '  "[$(Get-Date -Format o)] cpu%=$cpu memUsedMB=$mem gpu=$gpu" | Add-Content -Path $out',
          '  Start-Sleep -Seconds 3',
          '}'
        ].join('; ');
        monitor = spawn('pwsh', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
        sampleSelf('monitor-start');
        emit(`  · 资源监控已启动（独立进程 pid=${monitor.pid}）→ ${monitorLog}`);
      } catch (e) {
        monitor = null;
        emit(`  · 资源监控启动失败（不影响断言，但请人工确认硬件占用）：${e.message}`);
      }
    },
    finish() {
      clearTimeout(watchdog);
      for (const fn of cleanups) {
        try { fn(); } catch (e) { emit(`  · 清理失败：${e.message}`); }
      }
      stopMonitor();
      emit('');
      emit(`结果：${pass} 通过 / ${fail} 失败（耗时 ${Date.now() - startedAt}ms）`);
      if (fail) {
        emit('失败清单：');
        for (const f of failures) emit(f);
      }
      emit(fail ? `✗ ${name} 未通过` : `✓ ${name} 全部通过`);
      process.exit(fail ? 1 : 0);
    },
    /** 尽力删除临时目录；占用句柄未释放时会失败，只报告不掩盖。 */
    removeTree(dir) {
      if (!dir) return;
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
      catch (e) { emit(`  · 临时目录未删净（${e.code || e.message}）：${dir}`); }
    },
    /** Windows 上造一次「冷」acl 拒绝（只为构造复制失败，不是业务路径）。 */
    denyReadAcl(dir) {
      execFileSync('icacls', [dir, '/deny', `${process.env.USERNAME}:(RD)`], { stdio: 'ignore' });
    },
    allowReadAcl(dir) {
      try { execFileSync('icacls', [dir, '/remove:d', process.env.USERNAME], { stdio: 'ignore' }); }
      catch (e) { emit(`  · 撤销 ACL 拒绝失败（该目录可能已被移走）：${e.message}`); }
    }
  };
  return h;
}

module.exports = { createHarness, installElectronStub, waitRenameBlocked, holdFileHandle, sleepSync, REPO_ROOT, stamp };

// 直接 `node scripts/test-h04-h05-harness.js` 时给出说明，避免被误当测试跑。
if (require.main === module) {
  process.stdout.write('这是 H-04/H-05 测试脚手架模块，不单独运行。\n请运行 scripts/test-h04-*.js 或 scripts/test-h05-*.js。\n');
}
