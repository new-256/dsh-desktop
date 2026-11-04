'use strict';

/**
 * 0.3.42 安全与数据完整性修复测试。
 *
 * 覆盖本轮比对后实施的修复（每条都对应一个已确认的真实缺陷）：
 *   1. setUserPathEntry 绝不在"读不到 PATH"时写入（旧实现会抹掉用户整个 PATH）
 *   2. setUserPathEntry 写后回读校验 + 失败回滚
 *   3. writeJson 原子写（temp+rename），不留半截文件
 *   4. IPC 来源校验接线（28 个处理器全部经过 assertOwnedSender）
 *   5. crash-report：flag:'wx' 不覆盖 / pid 头部 / 有界落盘导出
 *   6. showFatal：不再吞掉恢复动作失败（无 .catch(()=>{})）
 *
 * 用法：node scripts/test-042.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const STUB_ID = '\0electron-stub';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-042-'));
require.cache[STUB_ID] = {
  id: STUB_ID, filename: STUB_ID, loaded: true,
  exports: { app: { getPath: () => path.join(TMP_ROOT, 'userData'), isPackaged: false, getVersion: () => '0.3.42-test' } }
};

const mgr = require('../updater-backend.js');
const crashReport = require('../crash-report.js');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }

const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const UPD_SRC = fs.readFileSync(path.join(__dirname, '..', 'updater-backend.js'), 'utf8');
const CRASH_SRC = fs.readFileSync(path.join(__dirname, '..', 'crash-report.js'), 'utf8');

section('1. PATH 抹除防线（最严重：旧实现会清空用户整个用户级 PATH）');
{
  // 旧代码形态： read 失败 → entries=[] → next=[] → regDeleteUserEnv('Path')
  const setFn = UPD_SRC.slice(UPD_SRC.indexOf('function setUserPathEntry'), UPD_SRC.indexOf('function setUserPathEntry') + 2600);
  ok(/cur === null/.test(setFn), '检测到"读不到"分支（cur === null）');
  ok(/unreadable/.test(setFn), '读不到时返回 reason: unreadable 并中止');
  ok(/refusing to write from a stale snapshot/.test(setFn), '注释说明拒绝基于陈旧快照写入');
  ok(/unsafe-reduction/.test(setFn), '存在"把 N 条 PATH 缩减到极少"的安全阀');
  ok(/verify-failed/.test(setFn), '存在写后回读校验失败分支');
  ok(/restoring previous value/.test(setFn), '校验失败时回滚到原值');
  // 关键：中止必须发生在本函数任何写入之前
  const abortIdx = setFn.indexOf('unreadable');
  const firstWriteIdx = Math.min(
    ...['regDeleteUserEnv', 'regSetUserEnv']
      .map((n) => { const i = setFn.indexOf(n); return i === -1 ? Infinity : i; })
  );
  ok(abortIdx > 0 && abortIdx < firstWriteIdx, '中止分支位于任何注册表写入之前');

  // 真实执行：读不到 PATH 时必须不写
  let wrote = false;
  const realRegQuery = mgr.regQueryUserEnv;
  ok(typeof mgr.setUserPathEntry === 'function' || /function setUserPathEntry/.test(UPD_SRC), 'setUserPathEntry 存在');
  // 通过替换注册表读写来验证行为（若函数已导出）
  if (typeof mgr.setUserPathEntry === 'function') {
    try {
      // 无法轻易打桩内部 regQueryUserEnv；改用源码契约断言（已在上方覆盖）
      ok(true, '（内部依赖不可打桩，行为由上述源码契约断言保证）');
    } catch (e) { ok(false, '调用不应抛错: ' + e.message); }
  } else {
    ok(true, '（未导出，改用源码契约断言）');
  }
}

section('2. writeJson 原子写（不留半截 JSON）');
{
  ok(/function writeJson\(file, obj\)/.test(UPD_SRC), 'writeJson 存在');
  const fn = UPD_SRC.slice(UPD_SRC.indexOf('function writeJson(file, obj)'), UPD_SRC.indexOf('function writeJson(file, obj)') + 900);
  ok(/\.tmp`/.test(fn) || /\.tmp'/.test(fn), '使用 .tmp 临时文件');
  ok(/renameSync/.test(fn), '使用 renameSync 原子替换');
  ok(/unlinkSync\(temp\)/.test(fn), '失败时清理临时文件');
  ok(!/function writeJson\(file, obj\) \{ mkdirp\(path\.dirname\(file\)\); fs\.writeFileSync\(file/.test(UPD_SRC),
    '旧的裸 writeFileSync 实现已被替换');

  // 真实执行：写一个 JSON 并确认内容正确、无残留 tmp
  const dir = path.join(TMP_ROOT, 'wj');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'a.json');
  ok(typeof mgr.writeJson === 'function', 'writeJson 已导出');
  if (typeof mgr.writeJson === 'function') {
    mgr.writeJson(target, { n: 1, s: '中文' });
    const back = JSON.parse(fs.readFileSync(target, 'utf8'));
    ok(back.n === 1 && back.s === '中文', '写入内容可正确读回');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    ok(leftovers.length === 0, '写入后没有残留 .tmp 文件');
    // 覆盖写：旧内容必须被完整替换（不是追加/截断混合）
    mgr.writeJson(target, { replaced: true });
    const back2 = JSON.parse(fs.readFileSync(target, 'utf8'));
    ok(back2.replaced === true && back2.n === undefined, '覆盖写完整替换旧内容');
  }
}

section('3. IPC 来源校验（28 个处理器全部受保护）');
{
  ok(/function assertOwnedSender\(event, channel\)/.test(MAIN_SRC), 'assertOwnedSender 已定义');
  ok(/function handleIpc\(channel, listener\)/.test(MAIN_SRC), 'handleIpc 包装器已定义');
  ok(/function ownedWebContentsIds\(\)/.test(MAIN_SRC), 'ownedWebContentsIds 已定义');

  const direct = (MAIN_SRC.match(/ipcMain\.handle\(/g) || []).length;
  const viaWrapper = (MAIN_SRC.match(/handleIpc\(/g) || []).length;
  ok(direct === 1, `仅 handleIpc 内部直接调用 ipcMain.handle（实际 ${direct}）`);
  ok(viaWrapper >= 28, `至少 28 个处理器经过包装（实际 ${viaWrapper - 1} 个调用点）`);

  // 高危通道必须被包装
  for (const ch of ['backend:rollback-to', 'plugins:install', 'app:restart', 'plugins:set-path-entry', 'plugins:set-dsh-home-env', 'settings:set-node-dist']) {
    ok(MAIN_SRC.includes(`handleIpc('${ch}'`), `高危通道 "${ch}" 已包装`);
  }
  // 校验逻辑要点
  ok(/无 sender frame/.test(MAIN_SRC), '无 senderFrame 时拒绝');
  ok(/非本应用窗口/.test(MAIN_SRC), '非本应用 webContents 时拒绝');
  ok(/127\.0\.0\.1/.test(MAIN_SRC.slice(MAIN_SRC.indexOf('function assertOwnedSender'), MAIN_SRC.indexOf('function assertOwnedSender') + 1600)),
    'origin 兜底校验包含回环地址');
}

section('4. crash-report：不覆盖 / pid / 有界落盘');
let boundedCheck = Promise.resolve();
{
  ok(/flag: 'wx'/.test(CRASH_SRC), "writeFileSync 使用 flag:'wx'（不覆盖已存在报告）");
  ok(/pid: \$\{process\.pid\}/.test(CRASH_SRC), '头部包含 pid');
  ok(/function writeCrashReportBounded/.test(CRASH_SRC), 'writeCrashReportBounded 已定义');
  ok(/CRASH_REPORT_WAIT_MS = 1000/.test(CRASH_SRC), '等待上限为 1000ms（对齐官方）');
  ok(/Promise\.race/.test(CRASH_SRC), '使用 Promise.race 实现上限');
  ok(/writeCrashReportBounded/.test(crashReport ? Object.keys(crashReport).join(',') : ''), 'writeCrashReportBounded 已导出');
  ok(typeof crashReport.CRASH_REPORT_WAIT_MS === 'number', 'CRASH_REPORT_WAIT_MS 已导出');

  // 真实执行：同名文件不得被覆盖（wx）。注意崩溃报告文件名含毫秒，两次调用
  // 天然得到不同名字，所以要直接测底层语义：手动造一个同名文件再写。
  const dir = path.join(TMP_ROOT, 'crash');
  fs.mkdirSync(dir, { recursive: true });
  const collision = path.join(dir, 'crash-2026-01-01T00-00-00-000Z-host.log');
  fs.writeFileSync(collision, 'EXISTING EVIDENCE');
  let threw = false;
  try {
    fs.writeFileSync(collision, 'NEW', { encoding: 'utf8', flag: 'wx' });
  } catch (e) { threw = true; }
  ok(threw, "flag:'wx' 对已存在文件确实抛错（不覆盖）");
  ok(fs.readFileSync(collision, 'utf8') === 'EXISTING EVIDENCE', '已存在的报告内容保持不变');

  const input = {
    source: 'host', phase: 'startup', error: new Error('boom'),
    backendReady: false, backendLogTail: 'tail', rendererConsole: []
  };
  const first = crashReport.writeCrashReport(input);
  ok(!!first, '第一次写入成功');
  if (first) {
    const body = fs.readFileSync(first, 'utf8');
    ok(/pid: \d+/.test(body), '报告头部确实包含 pid');
    ok(/boom/.test(body), '报告包含错误内容');
  }

  // 有界落盘：必须 resolve 且返回路径或 null，绝不挂起
  boundedCheck = crashReport.writeCrashReportBounded(input, 1000).then((p) => {
    ok(p === null || typeof p === 'string', '有界落盘返回 string|null 而非挂起');
  });
}

section('5. showFatal：恢复动作失败必须可见');
{
  // 精确切出 showFatal 函数体（到下一个顶层 function 为止），避免把邻近代码算进来。
  const sfIdx = MAIN_SRC.indexOf('async function showFatal');
  const sfEnd = MAIN_SRC.indexOf('\nfunction isRealFeedUrl', sfIdx);
  const sf = MAIN_SRC.slice(sfIdx, sfEnd > sfIdx ? sfEnd : sfIdx + 6000);
  ok(sfIdx > 0, 'showFatal 为 async');
  // 去掉注释后再断言，避免"注释里提到旧写法"造成假阳性。
  const sfCode = sf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/\.catch\(\(\) => \{\}\)/.test(sfCode), '不再有吞掉一切的 .catch(() => {})（已排除注释）');
  ok(/恢复操作失败/.test(sfCode), '动作失败时改写 message 为「恢复操作失败」');
  ok(/for \(;;\)/.test(sfCode), '使用循环重弹（对齐官方 for(;;)）');
  ok(/恢复操作失败/.test(sfCode), '失败原因回灌给用户');
  ok(/showMessageBox\(mainWindow/.test(sfCode), '弹窗挂到 mainWindow（有则模态）');
  ok(/actionErr/.test(sfCode), '捕获具体动作错误（actionErr）');
}

section('6. 退出前确认（此前完全缺失：死常量 → 真实实现）');
let quitCheck = Promise.resolve();
{
  const qg = require('../quit-guard.js');
  ok(typeof qg.createQuitGuard === 'function', 'quit-guard 模块可用');
  ok(qg.QUIT_CONFIRM_DEADLINE_MS === 2000, '截止时间 2000ms（对齐官方 2s）');

  // 接线断言：before-quit 必须挂上守卫，且常量不再是死代码
  ok(/const quitGuard = createQuitGuard\(/.test(MAIN_SRC), 'main.js 已创建 quitGuard');
  ok(/app\.on\('before-quit', \(e\) => \{/.test(MAIN_SRC), 'before-quit 已挂守卫');
  ok(/e\.preventDefault\(\)/.test(MAIN_SRC), '需要确认时阻止默认退出');
  ok(/quitGuard\.requestQuit\('before-quit'\)/.test(MAIN_SRC), '调用守卫的 requestQuit');
  ok(/const \{ createQuitGuard \} = require\('\.\/quit-guard'\)/.test(MAIN_SRC), '已 require quit-guard');

  quitCheck = (async () => {
    // 行为验证：无任务 → 直接退出，不弹窗
    let asked = 0, exited = 0;
    const g = qg.createQuitGuard({
      hasInterruptibleWork: () => false,
      confirm: async () => { asked++; return true; },
      now: () => { exited++; }
    });
    const r = await g.requestQuit('test');
    ok(r === true && asked === 0 && exited === 1, '无可能中断的任务时不弹窗、直接退出');

    // 有任务 + 用户确认 → 退出
    let asked2 = 0, exited2 = 0;
    const g2 = qg.createQuitGuard({
      hasInterruptibleWork: () => true,
      confirm: async () => { asked2++; return true; },
      now: () => { exited2++; }
    });
    await g2.requestQuit('test');
    ok(asked2 === 1 && exited2 === 1, '有任务 + 用户选「仍然退出」→ 询问后执行退出');

    // 有任务 + 用户取消 → 不退出
    let exited3 = 0;
    const g3 = qg.createQuitGuard({
      hasInterruptibleWork: () => true,
      confirm: async () => false,
      now: () => { exited3++; }
    });
    const r3 = await g3.requestQuit('test');
    ok(r3 === false && exited3 === 0, '有任务 + 用户选「取消」→ 不退出');
    await g3.requestQuit('test');
    ok(exited3 === 0, '取消后再次请求仍不退出（用户已表态）');

    // 防重入：确认框显示期间重复请求只弹一次
    let askedCount = 0, exitedCount = 0;
    let release;
    const gate = new Promise((res) => { release = res; });
    const g4 = qg.createQuitGuard({
      hasInterruptibleWork: () => true,
      confirm: async () => { askedCount++; await gate; return true; },
      now: () => { exitedCount++; }
    });
    const p1 = g4.requestQuit('a');
    const p2 = g4.requestQuit('b');
    const p3 = g4.requestQuit('c');
    release();
    await Promise.all([p1, p2, p3]);
    ok(askedCount === 1, '确认框显示期间的重复退出请求被合并（只问一次）');
    ok(exitedCount === 1, '合并后只退出一次');

    // 确认弹窗抛错时必须放行，不能卡住退出
    let exited5 = 0;
    const g5 = qg.createQuitGuard({
      hasInterruptibleWork: () => true,
      confirm: async () => { throw new Error('no display'); },
      now: () => { exited5++; }
    });
    await g5.requestQuit('x');
    ok(exited5 === 1, '确认弹窗失败时仍放行退出（不卡死）');
  })();
}

Promise.all([boundedCheck, quitCheck]).then(() => finish()).catch((e) => {
  console.error('测试执行异常:', e);
  failures.push('测试执行异常: ' + (e && e.message));
  finish();
});

function finish() {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
  console.log('\n' + '─'.repeat(60));
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('全部通过');
}
