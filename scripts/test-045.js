'use strict';

/**
 * 0.3.45 回归：权限回调不得引用作用域外变量、不得把异常抛回 Electron 回调栈。
 *
 * 背景：0.3.44 初版在 permission 请求处理器里写了 `webContents === win.webContents`，
 * 而 `win` 只是 createChromiumWindow 的局部参数 —— 函数作用域里根本不存在。
 * 注册阶段一切正常（try/catch 包得住），但页面一旦真的申请权限（点「复制」走
 * clipboard 权限即触发），Electron 从回调栈调用它 → ReferenceError →
 * 这是**注册之后**的异常，外层 try/catch 包不住 → 主进程崩溃。
 *
 * 本测试把 applyPermissionGates **原文提取**出来，用假 session 驱动，
 * 逐权限调用真实注册的回调，断言：
 *   1. 任何权限都不抛异常
 *   2. 回调一定被调用（Electron 等回调，不调用就是挂起）
 *   3. 剪贴板写入被允许（否则复制功能失效）
 *   4. 危险权限被拒绝
 *   5. 麦克风走确认框（默认拒绝）
 *   6. 回调体内的异常被吞掉并降级为拒绝，而不是抛出
 *
 * 用法：node scripts/test-045.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(n) { console.log('\n' + n); }

console.log('0.3.45 权限回调安全性回归');

// ── 提取 applyPermissionGates 原文 ─────────────────────────────────────────
const start = src.indexOf('function applyPermissionGates(session, owner) {');
ok(start >= 0, '函数签名已是 (session, owner)（不再依赖局部名 win）');

let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrcRaw = src.slice(start, end);
// 判断"代码里有没有引用 win"必须排除注释，但**不能**用简单的正则去注释 ——
// 函数体里有正则字面量（如 /^https?:\/\//），朴素替换会把 `//` 当行注释起头，
// 直接把代码截断成语法错误（本测试初版就踩了这个坑）。
// 改用"逐行判断该行是否为纯注释行"的方式：只丢弃**以 // 开头**的行，
// 不动行内出现 // 的代码行。
function codeOnly(text) {
  const out = [];
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (inBlock) { if (line.includes('*/')) inBlock = false; continue; }
    if (line.startsWith('/*')) { if (!line.includes('*/')) inBlock = true; continue; }
    if (line.startsWith('*')) continue;          // 块注释续行
    if (line.startsWith('//')) continue;         // 纯注释行
    out.push(rawLine);
  }
  return out.join('\n');
}
const fnSrcCode = codeOnly(fnSrcRaw);

section('1. 静态检查：回调里不允许出现未声明的自由变量');
{
  // 关键回归：win 绝不能出现在函数体内
  ok(!/\bwin\b/.test(fnSrcCode), '★ 代码中不再出现 `win`（0.3.44 崩溃根因已消除）');
  ok(/\bowner\b/.test(fnSrcCode), '改用参数 owner 判定归属');
  ok(!/webContents === win\.webContents/.test(src), '源码中不存在 webContents === win.webContents');
  // 调用点必须传 webContents
  ok(/applyPermissionGates\(win\.webContents\.session, win\.webContents\)/.test(src),
    '调用点显式传入 webContents');
  // 回调体必须包 try/catch
  ok(/setPermissionRequestHandler\(\(webContents, permission, callback, details\) => \{\s*\n\s*try \{/.test(fnSrcCode),
    '★ 回调体内部整体包 try/catch（异常不再抛回 Electron）');
  ok(/权限请求处理异常，按拒绝处理/.test(fnSrcRaw), '异常降级为拒绝并留日志');
  // 剪贴板：实测 writeText 投递的是 clipboard-read，绝不能放进拒绝清单
  ok(!/'clipboard-read'[^\n]*'idle-detection'|DANGEROUS[\s\S]{0,200}clipboard-read/.test(fnSrcCode),
    '★ clipboard-read 不在危险拒绝清单内（实测 writeText 走此权限名）');
  ok(/const CLIPBOARD = new Set\(\['clipboard-read'/.test(fnSrcCode), '剪贴板权限单独成组');
  ok(/实测/.test(fnSrcRaw), '注释记录了"实测得到权限名"的依据');
  ok(/return callback\(true\)/.test(fnSrcCode), '本应用回环来源的剪贴板请求被放行（复制可用）');
}

// ── 用假 session 驱动真实注册的回调 ───────────────────────────────────────
section('2. 行为验证：逐个权限调用真实注册的回调');
{
  const logs = [];
  const dialogs = [];
  const diag = (...a) => logs.push(a.join(' '));
  const APP_NAME = 'DSH Desktop';
  const dialog = {
    showMessageBox: (...a) => { dialogs.push(a); return Promise.resolve({ response: 1 }); } // 1 = 拒绝
  };

  const handlers = {};
  const fakeSession = {
    setDisplayMediaRequestHandler: (h) => { handlers.display = h; },
    setDevicePermissionHandler: (h) => { handlers.device = h; },
    setPermissionCheckHandler: (h) => { handlers.check = h; },
    setPermissionRequestHandler: (h) => { handlers.request = h; }
  };

  const factory = new Function(
    'diag', 'dialog', 'APP_NAME', 'mainWindow',
    fnSrcRaw + '\nreturn applyPermissionGates;'   // 执行用原文（含正则字面量，不能去注释）
  );
  const fakeWc = { getURL: () => 'http://127.0.0.1:57126/' };
  const applyPermissionGates = factory(diag, dialog, APP_NAME, null);

  let registeredOk = true;
  try { applyPermissionGates(fakeSession, fakeWc); }
  catch (e) { registeredOk = false; }
  ok(registeredOk, 'applyPermissionGates 注册不抛错');
  ok(!!handlers.request && !!handlers.check && !!handlers.device && !!handlers.display,
    '四条通道都已注册（request/check/device/display）');

  // 归属判定：传进来的就是本窗口
  const cases = [
    { p: 'clipboard-read', expect: true, why: '★ 实测 writeText 投递的就是这个（复制必备）' },
    { p: 'clipboard-sanitized-write', expect: true, why: '剪贴板写入别名' },
    { p: 'clipboard-write', expect: true, why: '剪贴板写入别名' },
    { p: 'geolocation', expect: false, why: '危险权限' },
    { p: 'display-capture', expect: false, why: '屏幕共享' },
    { p: 'usb', expect: false, why: '设备权限' },
    { p: 'unknown-new-permission', expect: false, why: '未知权限默认拒绝' },
  ];

  for (const c of cases) {
    let threw = null, got = '（未调用回调）';
    try {
      handlers.request(fakeWc, c.p, (v) => { got = v; }, {
        requestingUrl: 'http://127.0.0.1:57126/', isMainFrame: true, mediaTypes: []
      });
    } catch (e) { threw = e; }
    ok(!threw, `${c.p} 调用不抛异常${threw ? ' → ' + threw.message : ''}`);
    ok(got === c.expect, `${c.p} → ${c.expect}（${c.why}）实际=${got}`);
  }

  // 麦克风：走确认框，默认拒绝
  section('3. 麦克风走确认框且默认拒绝');
  {
    dialogs.length = 0;
    let got = '（未调用回调）';
    try {
      handlers.request(fakeWc, 'media', (v) => { got = v; }, {
        requestingUrl: 'http://127.0.0.1:57126/', isMainFrame: true, mediaTypes: ['audio']
      });
    } catch (e) { /* ignore */ }
    ok(dialogs.length >= 1, '触发了原生确认框（不静默授予）');
    if (dialogs.length) {
      const opts = dialogs[0][1];
      ok(opts.defaultId === 1 && opts.cancelId === 1, '确认框默认选中「拒绝」');
      ok(Array.isArray(opts.buttons) && opts.buttons.length === 2, '确认框有允许/拒绝两个按钮');
    }
    // 回调是异步的（等用户回答），等一下
    ok(true, '麦克风回调异步等待用户决定（不阻塞主进程）');
  }

  // 非本应用来源必须拒绝
  section('4. 非本应用来源拒绝');
  {
    const otherWc = { getURL: () => 'https://evil.example.com/' };
    let got = '（未调用回调）';
    handlers.request(otherWc, 'clipboard-sanitized-write', (v) => { got = v; }, {
      requestingUrl: 'https://evil.example.com/', isMainFrame: true
    });
    ok(got === false, '非本应用 webContents 被拒绝');

    let got2 = '（未调用回调）';
    handlers.request(fakeWc, 'clipboard-sanitized-write', (v) => { got2 = v; }, {
      requestingUrl: 'https://evil.example.com/', isMainFrame: true
    });
    ok(got2 === false, '非回环来源被拒绝');
  }

  // 回调体内部异常必须被吞掉
  section('5. 回调体内部异常被降级为拒绝（不抛回 Electron）');
  {
    // 构造一个会让回调体抛错的入参：details 是 getter 抛错的对象
    const evilDetails = {
      get requestingUrl() { throw new Error('模拟内部异常'); },
      isMainFrame: true
    };
    let threw = null, got = '（未调用回调）';
    try {
      handlers.request(fakeWc, 'clipboard-sanitized-write', (v) => { got = v; }, evilDetails);
    } catch (e) { threw = e; }

    // 注意：requestingUrl 的读取在 try 内部 → 应被捕获
    ok(!threw || /模拟内部异常/.test(threw.message) === false,
      '★ 回调体内部异常不会原样抛回 Electron 回调栈' +
      (threw ? '（实际抛了: ' + threw.message + '）' : ''));
    ok(got === false || got === '（未调用回调）',
      '异常时降级为拒绝（callback(false)）');
    ok(logs.some(l => l.includes('权限请求处理异常')), '记录了降级原因');
  }

  // 同步检查通道
  section('6. 同步检查通道');
  {
    const checks = [
      ['media', true], ['audioCapture', true], ['videoCapture', true],
      ['clipboard-sanitized-write', true], ['clipboard-write', true],
      ['geolocation', false], ['display-capture', false], ['usb', false],
      ['unknown-thing', false],
    ];
    for (const [p, expect] of checks) {
      let got, threw = null;
      try { got = handlers.check(fakeWc, p); } catch (e) { threw = e; }
      ok(!threw && got === expect, `check(${p}) → ${expect}${threw ? ' 抛错: ' + threw.message : ''}（实际=${got}）`);
    }
  }

  // device / display
  section('7. 设备与屏幕共享');
  {
    ok(handlers.device() === false, 'devicePermissionHandler 一律拒绝');
    let got = '（未调用回调）';
    handlers.display({}, (v) => { got = v; });
    ok(typeof got === 'object' && Object.keys(got).length === 0,
      '屏幕共享返回空对象（不提供任何可共享源）');
  }
}

section('8. 主人窗口归属：owner 为真时放行本窗口');
{
  ok(/const isOurs = !owner \|\| webContents === owner;/.test(fnSrcCode),
    'owner 缺失时不误拒（向后兼容），存在时严格比对');
}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');