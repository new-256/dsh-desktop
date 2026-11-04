'use strict';

/**
 * 0.3.44 退出/权限/输入法守卫测试。
 *
 * 覆盖：
 *   1. 有界停止（stopBackendBounded）：温和 → 验证退出 → 超时强制 → 再验证，
 *      并且**真的等到进程死了**才返回（旧实现 fire-and-forget）
 *   2. 固定 sleep 已被"真实等待"取代（15 处）
 *   3. 权限闸门：危险级拒绝 / 麦克风弹框 / 非本应用来源拒绝
 *   4. 输入法守卫：isComposing / isAutoRepeat 不触发 DevTools
 *   5. 平台事实：官方三段式在 Windows 上为何不适用（防止后人"顺手抄回来"）
 *
 * 用法：node scripts/test-044.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'dsh-044-' + process.pid);

const Module_ = Module;
const origResolve = Module_._resolveFilename;
const STUB_ID = '\0electron-stub';
Module_._resolveFilename = function (r, ...a) { if (r === 'electron') return STUB_ID; return origResolve.call(this, r, ...a); };

const registered = { permission: null, check: null, device: null, display: null };
const dialogs = [];
require.cache[STUB_ID] = {
  id: STUB_ID, filename: STUB_ID, loaded: true,
  exports: {
    app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.3.44-test', on: () => {}, whenReady: () => new Promise(() => {}) },
    dialog: { showMessageBox: (...a) => { dialogs.push(a); return Promise.resolve({ response: 0 }); } },
    ipcMain: { handle: () => {}, on: () => {} },
    shell: { openExternal: () => {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} destroy() {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }) },
    clipboard: { writeText: () => {} }
  }
};

fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(n) { console.log('\n' + n); }

async function main() {
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const mgr = require(path.join(ROOT, 'updater-backend.js'));

console.log('0.3.44 退出/权限/输入法');

// ─────────────────────────────────────────────────────────────────────────
section('1. 有界停止：真的等到进程退出');
{
  ok(/async function stopBackendBounded\(proc, opts = \{\}\)/.test(mainSrc), 'stopBackendBounded 已定义');
  ok(/const waitExit = \(ms\) => new Promise/.test(mainSrc), '存在退出等待原语');
  ok(/proc\.once\('exit', onExit\)/.test(mainSrc), '监听真实 exit 事件（不是猜时间）');
  ok(/if \(await waitExit\(timeoutMs\)\)/.test(mainSrc), '阶段一：等待温和停止生效');
  ok(/diag\(`后端未在 \$\{timeoutMs\}ms 内退出，升级为强制终止/.test(mainSrc), '超时后升级为强制');
  ok(/if \(await waitExit\(forceTimeoutMs\)\)/.test(mainSrc), '阶段二：强制后再次验证退出');
  ok(/stopBackendBounded\(proc, \{ timeoutMs: 6000, forceTimeoutMs: 5000 \}\)/.test(mainSrc), 'restartApp 使用统一实现');
  ok(/how: 'still-running'/.test(mainSrc), '未退出时如实返回 still-running（不假装成功）');
}

section('2. 行为验证：等待原语确实等待');
{
  // 用一个真实子进程验证 waitExit 的语义（抽出同构实现做行为测试）
  const waitExitImpl = (proc, ms) => new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(true);
    let done = false;
    const onExit = () => { if (!done) { done = true; clearTimeout(t); resolve(true); } };
    const t = setTimeout(() => { if (!done) { done = true; try { proc.removeListener('exit', onExit); } catch {} resolve(false); } }, ms);
    try { proc.once('exit', onExit); } catch { clearTimeout(t); resolve(false); }
  });

  const script = path.join(TMP, 'slow.js');
  fs.writeFileSync(script, 'setTimeout(() => process.exit(0), 1200);');
  const c = spawn(process.execPath, [script], { stdio: 'ignore' });

  const t0 = Date.now();
  const exitedSoon = await waitExitImpl(c, 300);
  const elapsed1 = Date.now() - t0;
  ok(exitedSoon === false, '子进程还活着时 waitExit 返回 false（不谎报已退出）');
  ok(elapsed1 >= 280 && elapsed1 < 900, `等待时长符合预期（${elapsed1}ms，未被固定 sleep 替代）`);

  const exited = await waitExitImpl(c, 4000);
  ok(exited === true, '子进程真的退出后 waitExit 返回 true');
}

section('3. 固定 sleep 已被真实等待取代');
{
  const sites = (mainSrc.match(/await stopBackendAndWait\(\)/g) || []).length;
  ok(sites >= 15, `stopBackendAndWait 调用点 ${sites} 处（≥15）`);
  // 阶梯内不应再出现 "stopBackend(); 固定 sleep" 的组合
  const badPattern = /stopBackend\(\);\s*\n\s*await new Promise\(\(r\) => setTimeout\(r, \d+\)\);/;
  ok(!badPattern.test(mainSrc), '不存在"停后端 + 固定 sleep"的旧模式');
  ok(/async function stopBackendAndWait\(opts = \{\}\)/.test(mainSrc), 'stopBackendAndWait 已定义');
  ok(/if \(!proc\) return \{ stopped: true, forced: false, ms: 0, how: 'no-backend' \}/.test(mainSrc),
    '无后端时安全返回（幂等）');
}

section('4. 平台事实：为何不照抄官方三段式');
{
  ok(/shutdown IPC → 等 10s → SIGTERM → 等 5s → SIGKILL → 等 5s/.test(mainSrc), '注释记录了官方阶梯原文');
  ok(/Windows 没有可捕获的信号/.test(mainSrc), '注释说明了 Windows 信号事实');
  ok(/全部未能触发/.test(mainSrc), '注释记录了实测结论');
  ok(/stdio: \['ignore', 'pipe', 'pipe'\]/.test(mainSrc), '我们确实没有 IPC 通道（与注释一致）');
  // Windows 分支必须用 taskkill（不带 /F 的温和形式）
  ok(/spawn\('taskkill', \['\/pid', String\(pid\), '\/T'\]/.test(mainSrc), 'Windows 走 taskkill /T（不带 /F）');
  ok(/process\.platform === 'win32'/.test(mainSrc), '有明确的平台分支');
}

section('5. 权限闸门');
{
  ok(/function applyPermissionGates\(session, owner\)/.test(mainSrc), 'applyPermissionGates 已定义（带 owner 参数）');
  ok(/session\.setPermissionRequestHandler\(/.test(mainSrc), '注册了请求处理器');
  ok(/session\.setPermissionCheckHandler\(/.test(mainSrc), '注册了同步检查处理器');
  ok(/session\.setDevicePermissionHandler\(\) => false\)/.test(mainSrc) || /setDevicePermissionHandler\(\(\) => false\)/.test(mainSrc),
    '设备权限（USB/串口/HID）一律拒绝');
  ok(/session\.setDisplayMediaRequestHandler\(/.test(mainSrc), '注册了屏幕共享处理器');
  ok(/callback\(\{\}\)/.test(mainSrc), '屏幕共享返回空源（= 不提供任何可共享对象）');
  ok(/applyPermissionGates\(win\.webContents\.session, win\.webContents\)/.test(mainSrc),
    '在主窗口创建时接线（并传入 owner webContents）');

  // 危险级必须拒绝（注意：clipboard-read 曾被误列入，0.3.45 已按实测移出——
  // 见 test-045；这里不再钉它，避免把回归缺陷当成规范锁死）
  for (const p of ['display-capture', 'geolocation', 'midiSysex', 'usb', 'serial']) {
    ok(mainSrc.includes(`'${p}'`), `危险权限在拒绝清单内: ${p}`);
  }
  ok(/const CLIPBOARD = new Set\(\['clipboard-read'/.test(mainSrc),
    '★ 剪贴板权限已独立成组，不再误杀复制功能');
  ok(/function applyPermissionGates\(session, owner\)/.test(mainSrc),
    '★ 签名已修正为 (session, owner)（0.3.44 的 win 未定义崩溃已修）');
  // 麦克风必须走弹框而不是静默拒绝
  ok(/const isMic = p === 'media' \|\| p === 'audioCapture' \|\| p === 'videoCapture'/.test(mainSrc),
    '麦克风/摄像头被识别为"可询问级"');
  ok(/type: 'question'/.test(mainSrc), '可询问级弹确认框（不静默授予也不静默拒绝）');
  ok(/defaultId: 1/.test(mainSrc), '确认框默认选中「拒绝」（安全默认）');
  // 来源校验
  ok(/const isLoopback = \/\^https\?:\\\/\\\/\(127\\\.0\\\.0\\\.1\|localhost/.test(mainSrc) || /isLoopback/.test(mainSrc),
    '校验请求来源是回环地址');
  ok(/if \(!isOurs \|\| !isLoopback\)/.test(mainSrc), '非本应用来源直接拒绝');
  // 明确记录不照抄官方的原因
  ok(/不能照抄官方/.test(mainSrc), '注释说明了不照抄官方的理由');
  ok(/永久废掉所有需要浏览器权限的功能/.test(mainSrc), '注释点名了照抄的后果');
}

section('6. 输入法守卫（防 Ctrl+Shift 误触 DevTools）');
{
  ok(/input\.isComposing/.test(mainSrc), '输入法组合态被检查');
  ok(/input\.isAutoRepeat/.test(mainSrc), '忽略自动重复（长按不连续开合）');
  ok(/if \(input\.isComposing\) return; \/\/ 输入法组合中，绝不当作快捷键/.test(mainSrc),
    '组合态直接返回（最严格）');
  ok(/输入法守卫/.test(mainSrc), '注释说明了守卫目的');
  ok(/忽略 DevTools 快捷键：输入法组合进行中/.test(mainSrc), '拒绝时留下诊断日志');
  ok(/key === 'f12' \|\| \(\(input\.control \|\| input\.meta\) && input\.shift && key === 'i'\)/.test(mainSrc),
    '快捷键判定仍在（功能未被移除）');
}

section('7. 关窗确认：并发合并 + 弹窗失败不隐藏窗口');
{
  ok(/let closeConfirmPending = false/.test(mainSrc), '存在确认框并发闸门');
  ok(/if \(closeConfirmPending\) return;/.test(mainSrc), '同一时刻只允许一个确认框（C1）');
  ok(/closeConfirmPending = true;/.test(mainSrc), '进入确认流程时置位');
  ok(/closeConfirmPending = false;/.test(mainSrc.replace(/closeConfirmPending = true;/g, '')),
    '两条出口（回答/异常）都复位');
  // C3：弹窗失败绝不再隐藏窗口
  const closeBlock = mainSrc.slice(mainSrc.indexOf("win.on('close'"), mainSrc.indexOf("win.on('close'") + 2200);
  ok(!/\.catch\(\(\) => \{ doHide\(\); \}\)/.test(closeBlock), '★ 弹窗失败不再偷偷隐藏窗口（C3 已修）');
  ok(/保留窗口可见（不代替用户做决定）/.test(closeBlock), '失败时保留窗口并记录原因');
  ok(/e\.preventDefault\(\)/.test(closeBlock), '仍拦截默认关闭行为（功能未回退）');
}

section('8. 崩溃报告文件名消毒（防路径注入）');
{
  const crash = require(path.join(ROOT, 'crash-report.js'));
  const f = crash._internal.crashFileName;
  const t = new Date('2026-10-11T12:34:56.789Z');

  ok(/function sanitizeToken\(value, fallback\)/.test(fs.readFileSync(path.join(ROOT, 'crash-report.js'), 'utf8')),
    '存在消毒函数');

  const malicious = ['../../../evil', 'C:\\Windows\\System32\\x', '..\\..\\boom', 'a/b:c*d?e"f<g>h|i'];
  for (const v of malicious) {
    const n = f(t, v);
    const core = n.replace(/\.log$/, '');
    const safe = !/[\\/:*?"<>|]/.test(core) && !core.includes('..');
    ok(safe, `恶意 source 被消毒: ${JSON.stringify(v).slice(0, 34)} → ${n.slice(-28)}`);
  }
  ok(/unknown\.log$/.test(f(t, '')), '空 source 兜底为 unknown');
  ok(/unknown\.log$/.test(f(t, null)), 'null source 兜底为 unknown');
  ok(/unknown\.log$/.test(f(t, '...')), '纯点 source 兜底为 unknown');
  ok(f(t, 'host').length <= 120, '正常名字长度合理');
  ok(/crash-2026-10-11T12-34-56-789Z-host\.log$/.test(f(t, 'host')),
    '★ 正常的 host 报告名保持原样（兼容既有文件）');
}

section('9. 官方三段式在 Windows 上确实等价的实测依据');
{
  // 这条断言把"我们为什么不抄"钉在可验证的事实上：Windows 上
  // child.kill('SIGTERM') 走 TerminateProcess，handler 不会执行。
  const script = path.join(TMP, 'sig.js');
  const logFile = path.join(TMP, 'sig.log');
  fs.writeFileSync(script, [
    'const fs = require("fs");',
    'fs.writeFileSync(process.env.SIGLOG, "READY\\n");',
    'process.on("SIGTERM", () => fs.appendFileSync(process.env.SIGLOG, "GOT_SIGTERM\\n"));',
    'setInterval(() => {}, 500);'
  ].join('\n'));

  await new Promise((resolve) => {
    const c = spawn(process.execPath, [script], { stdio: 'ignore', env: { ...process.env, SIGLOG: logFile } });
    setTimeout(() => { try { c.kill('SIGTERM'); } catch {} }, 500);
    setTimeout(() => {
      let content = '';
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      const gotHandler = /GOT_SIGTERM/.test(content);
      if (process.platform === 'win32') {
        ok(!gotHandler, 'Windows 上 child.kill(SIGTERM) 不触发子进程 handler（官方阶梯在此平台无效）');
      } else {
        ok(true, '非 Windows：信号语义不同（本断言仅针对 win32）');
      }
      resolve();
    }, 1500);
  });
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
}

main().catch((e) => { console.error(e); process.exit(1); });
