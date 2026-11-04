'use strict';

/**
 * 0.3.48 · H-02 回归：`spawnBackend()` 的 async executor 反模式不再吞掉同步异常。
 *
 * ## 背景（要复现的缺陷）
 *
 * 0.3.47 的实现是 `return new Promise(async (resolve, reject) => {...})`。
 * async 函数体里**同步**抛出的异常只会 reject 那个"函数自己返回、然后被丢弃"
 * 的 Promise；外层 `new Promise` 既不 resolve 也不 reject，于是：
 *     await startBackendWithPluginIsolation(...)  // ← 永不返回
 *     whenReady 的 catch → showFatal()            // ← 永不执行
 * 用户看到的就是"启动画面永远在转，没有任何提示"（H-02）。
 *
 * 实测会同步抛出的两处：`mgr.buildDedicatedEnv()`（内部裸 `mkdirSync`：
 * %APPDATA% 权限异常 / 磁盘满 / 杀软拦截）与 `spawn()`（EACCES / EPERM）。
 *
 * ## 本测试怎么保证"测的是真代码"
 *
 * 不复制实现、不造影子函数：用 `scripts/lib/stage1-main-harness.js` 把 main.js
 * 源码在桩环境里编译，直接调用**真实的 spawnBackend / prepareBackendSpawn**，
 * 只把 electron / child_process / updater-backend 换成桩。
 *
 * 用法：node scripts/test-h02-spawn-sync.js [--timeout 120]
 */

const fs = require('fs');
const path = require('path');
const h = require('./lib/stage1-main-harness');

const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 120;
const t = h.createAsserts();
const BASE = h.makeBase('h02');
process.env.DSH_DIAG_BASE = BASE;
// 让 crash-report 的 cwd 兜底也落在沙箱里（它没有 electron 时会用 cwd/logs）。
process.chdir(BASE);
// 极短预算：spawn/health 各 400ms，测试才能秒级验证超时分支。
process.env.DSH_STARTUP_TIMEOUT_SPAWN_MS = '400';
process.env.DSH_STARTUP_TIMEOUT_HEALTH_MS = '400';
process.env.DSH_STARTUP_TIMEOUT_PAINT_MS = '400';

const LOG_FILE = path.join(BASE, 'logs', 'DSH-Desktop-日志.txt');

let killer = setTimeout(() => {
  console.error(`\n[超时] 测试超过 ${TIMEOUT_SEC}s 未结束，强制退出（防卡死）。`);
  h.printLogHead(LOG_FILE, 20);
  process.exit(124);
}, TIMEOUT_SEC * 1000);

/** 等待一个 Promise 落定；超时返回 {timedOut:true} —— 这是"永不 settle"的直接判据。 */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, ms);
    promise.then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve({ resolved: true, value }); } },
      (err) => { if (!done) { done = true; clearTimeout(timer); resolve({ rejected: true, err }); } }
    );
  });
}

/** 在每个用例里造出"活跃目录齐全"的假后端文件（否则会先撞上 seed 缺失分支）。 */
function makeActiveFiles(root) {
  const nodeExe = path.join(root, 'node.exe');
  const dshBin = path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(path.dirname(dshBin), { recursive: true });
  fs.writeFileSync(nodeExe, 'fake node', 'utf8');
  fs.writeFileSync(dshBin, 'fake dsh', 'utf8');
  return { nodeExe, dshBin };
}

/**
 * 载入一份"全新的 main.js"（模块级状态重置 = 模拟一次新启动）。
 * @param {{root: string, backend?: object, spawn?: Function}} cfg
 */
function boot(cfg) {
  const { electron, state } = h.createElectronStub({ userData: BASE });
  const childProcessStub = h.createChildProcessStub({ onSpawn: cfg.spawn });
  const backendStub = h.createUpdaterBackendStub(Object.assign({
    root: cfg.root,
    nodeExe: cfg.nodeExe,
    dshBin: cfg.dshBin
  }, cfg.backend || {}));
  const mod = h.loadMain({
    base: BASE,
    electronStub: electron,
    childProcessStub: childProcessStub.module,
    backendStub,
    exports: ['spawnBackend', 'prepareBackendSpawn', 'startupBudgets', 'bootTrace']
  });
  return { mod, electronState: state, cp: childProcessStub, backend: backendStub };
}

(async () => {
  console.log('0.3.48 · H-02 回归：spawnBackend 的同步异常必须 reject 外层 Promise');
  console.log('沙箱：' + BASE);
  console.log('预算：spawn=400ms health=400ms（环境变量覆盖，默认值见 startup-deadline.js）');

  // ── ⓪ 对照实验：旧结构在同样的同步抛出下确实永不 settle ─────────────────
  // 放在最前面（且自带 unhandledRejection 兜底监听）：旧结构会把同步抛出变成
  // 一个"没人接的 Promise 拒绝"，Node 默认会因此终止进程 —— 那正是 0.3.47 里
  // 用户看不到任何提示的另一半原因。
  t.section('⓪ 对照实验（证明本测试能抓住这个缺陷）');
  {
    const noop = () => {};
    process.on('unhandledRejection', noop);
    // 这就是 0.3.47 的结构（刻意保留在测试里作为"反面样本"）。
    const legacySpawn = () => new Promise(async (resolve, reject) => {
      throw new Error('旧结构：同步抛出只 reject 内部被丢弃的 Promise');
    });
    const outcome = await settleWithin(legacySpawn(), 800);
    process.removeListener('unhandledRejection', noop);
    t.ok(outcome.timedOut === true,
      '旧结构（new Promise(async …)）在外层确实永不 settle —— 本测试有能力发现回归',
      outcome);
  }

  // ── ① 结构断言：反模式必须彻底消失 ───────────────────────────────────────
  t.section('① 结构断言（源码级）');
  const mainSrc = fs.readFileSync(path.join(h.ROOT, 'main.js'), 'utf8');
  // 只看代码，不看注释：本次修复的说明里需要引用"旧结构长什么样"。
  const codeOnly = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  t.ok(!/new\s+Promise\s*\(\s*async\b/.test(codeOnly),
    'main.js 的可执行代码中不存在 `new Promise(async …)` 反模式',
    (codeOnly.match(/new\s+Promise\s*\(\s*async\b/g) || []).length + ' 处');
  t.ok(/function\s+prepareBackendSpawn\s*\(/.test(codeOnly), '同步准备已抽成 prepareBackendSpawn()（可被 try/catch 包住）');
  t.ok(/prepareBackendSpawn\(\)[\s\S]{0,400}?reject\(err\)/.test(codeOnly),
    'spawnBackend 内对同步准备失败显式 reject 外层 Promise');

  // ── ② 缺少 node.exe：同步 throw 必须变成"拒绝"而不是"挂起" ──────────────
  t.section('② 缺 node.exe（旧实现会永久 pending）');
  {
    const root = path.join(BASE, 'case2');
    fs.mkdirSync(root, { recursive: true });
    const { mod } = boot({ root });
    const outcome = await settleWithin(mod.spawnBackend(), 3000);
    t.ok(!outcome.timedOut, 'Promise 在 3s 内落定（没有永久 pending）', outcome);
    t.ok(outcome.rejected === true, 'Promise 以 reject 落定（不是静默 resolve）', outcome.value);
    t.ok(outcome.err && /缺少 Node 运行时/.test(outcome.err.message),
      '错误文案保留原有语义（缺少 Node 运行时…）', outcome.err && outcome.err.message);
  }

  // ── ③ buildDedicatedEnv 同步抛错 ───────────────────────────────────────────
  t.section('③ buildDedicatedEnv() 同步抛错');
  {
    const root = path.join(BASE, 'case3');
    const files = makeActiveFiles(root);
    const { mod, backend } = boot({ root, nodeExe: files.nodeExe, dshBin: files.dshBin, backend: { buildEnvThrows: true } });
    const outcome = await settleWithin(mod.spawnBackend(), 3000);
    t.ok(!outcome.timedOut, 'Promise 在 3s 内落定（旧实现里这里就是永久 pending 的现场）', outcome);
    t.ok(outcome.rejected === true, 'Promise 以 reject 落定', outcome.value);
    t.ok(outcome.err && /buildDedicatedEnv 失败/.test(outcome.err.message),
      '原始异常信息原样透出（不被改写成模糊文案）', outcome.err && outcome.err.message);
    t.ok(backend.calls.buildEnv === 1, '基本检查通过后确实调用了 buildDedicatedEnv', backend.calls);
  }

  // ── ④ spawn() 同步抛 EACCES ───────────────────────────────────────────────
  t.section('④ spawn() 同步抛出 EACCES');
  {
    const root = path.join(BASE, 'case4');
    const files = makeActiveFiles(root);
    const { mod } = boot({
      root, nodeExe: files.nodeExe, dshBin: files.dshBin,
      spawn: () => { const e = new Error('spawn EACCES'); e.code = 'EACCES'; throw e; }
    });
    const outcome = await settleWithin(mod.spawnBackend(), 3000);
    t.ok(!outcome.timedOut, 'Promise 在 3s 内落定', outcome);
    t.ok(outcome.rejected === true, 'Promise 以 reject 落定', outcome.value);
    t.ok(outcome.err && outcome.err.code === 'EACCES', '错误码 EACCES 完整保留（便于归因杀软/权限）', outcome.err && outcome.err.code);
  }

  // ── ⑤ H-03 阶段一：后端不打印地址 → spawn deadline ───────────────────────
  t.section('⑤ H-03 阶段一：后端不打印地址（spawn deadline）');
  {
    const root = path.join(BASE, 'case5');
    const files = makeActiveFiles(root);
    let child = null;
    const { mod, cp } = boot({
      root, nodeExe: files.nodeExe, dshBin: files.dshBin,
      spawn: () => { child = h.createFakeBackendChild(5150); return child; }
    });
    const promise = mod.spawnBackend();
    // 让日志里有"最后一条输出"，超时文案必须带上它。
    await new Promise((r) => setTimeout(r, 60));
    child.stdout.emit('data', Buffer.from('booting dsh web, loading plugins...\n'));
    const outcome = await settleWithin(promise, 4000);
    t.ok(!outcome.timedOut, '超时后 Promise 在 4s 内落定（旧实现会永远停在这里）', outcome);
    t.ok(outcome.rejected === true, '超时按 reject 处理（走既有 showFatal 路径）', outcome.value);
    const err = outcome.err;
    t.ok(err && err.code === 'E_STARTUP_SPAWN_NO_URL', '错误码区分了"未捕获到后端地址"', err && err.code);
    t.ok(err && /后端进程拉起/.test(err.message), '超时文案含超时阶段名', err && err.message && err.message.slice(0, 120));
    t.ok(err && /loading plugins/.test(err.message), '超时文案含最后一条后端日志', err && err.message);
    t.ok(err && /完整日志（绝对路径）/.test(err.message), '超时文案含日志绝对路径标签', err && err.message);
    const logPathInMsg = err && /完整日志（绝对路径）：(.+)/.exec(err.message);
    t.ok(logPathInMsg && path.isAbsolute(logPathInMsg[1].trim()), '日志路径确实是绝对路径',
      logPathInMsg && logPathInMsg[1]);
    t.ok(cp.calls.taskkills.length >= 1, '超时后清理了卡住的后端进程（避免占着端口/文件锁）', cp.calls.taskkills);

    const trace = mod.bootTrace.snapshot();
    t.ok(trace.some((m) => m.phase === 'spawn'), '阶段打点记录了 spawn（事后可回答卡在哪一步）', trace);
  }

  // ── ⑥ H-03 阶段二：打印了地址但 HTTP 不响应 → health deadline ────────────
  t.section('⑥ H-03 阶段二：地址已打印但 HTTP 无响应（health deadline）');
  {
    const root = path.join(BASE, 'case6');
    const files = makeActiveFiles(root);
    let child = null;
    const { mod } = boot({
      root, nodeExe: files.nodeExe, dshBin: files.dshBin,
      spawn: () => { child = h.createFakeBackendChild(5151); return child; }
    });
    const promise = mod.spawnBackend();
    await new Promise((r) => setTimeout(r, 60));
    // 端口 1 必然连接被拒（不会真的连上任何服务）。
    child.stdout.emit('data', Buffer.from('dsh web: http://127.0.0.1:1\n'));
    const outcome = await settleWithin(promise, 5000);
    t.ok(!outcome.timedOut, 'health 阶段超时后 Promise 落定', outcome);
    const err = outcome.err;
    t.ok(outcome.rejected === true, 'health 超时按 reject 处理', outcome.value);
    t.ok(err && err.code === 'E_STARTUP_HEALTH_UNRESPONSIVE',
      '错误码与"未捕获到地址"不同（H-03 要求分成两个错误码）', err && err.code);
    t.ok(err && /后端健康检查/.test(err.message), '超时文案含 health 阶段名', err && err.message && err.message.slice(0, 120));
    const trace = mod.bootTrace.snapshot();
    t.ok(trace.some((m) => m.phase === 'url-ready'), '阶段打点记录了 url-ready（说明地址确实抓到了）', trace);
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  clearTimeout(killer);
  killer = null;
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
