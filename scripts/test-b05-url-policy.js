'use strict';

/**
 * 0.3.49 · B-05/B-11 回归：导航白名单 + 开窗默认拒 + 外链白名单（纯函数）。
 *
 * ## 为什么单测能顶事
 *
 * 这三条判定的全部价值在"边界情况判断对不对"：跨端口、跨源、file 路径逃逸、
 * `about:blank`、带凭据 URL、Unicode 同形字、回环 vs 外网……这些用开窗口点一遍
 * 永远覆盖不全，而纯函数可以逐条打穿。main.js 的接线另由 `test-b05-wiring.js`
 * （桩驱动真实 main.js）覆盖。
 *
 * 用法：node scripts/test-b05-url-policy.js [--timeout 120]
 */

const path = require('path');
const up = require('../url-policy');

const TIMEOUT_SEC = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1]) || 120;
const killer = setTimeout(() => {
  console.error(`\n[超时] 测试超过 ${TIMEOUT_SEC}s 未结束，强制退出（防卡死）。`);
  process.exit(124);
}, TIMEOUT_SEC * 1000);

let pass = 0;
const failures = [];
function ok(cond, label, actual) {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else {
    failures.push(label);
    console.log('  ✗ ' + label);
    if (actual !== undefined) console.log('      实际值：' + require('util').inspect(actual, { depth: 4, breakLength: 140 }));
  }
}
const section = (n) => console.log('\n' + n);

const APP_ROOT = path.join(__dirname, '..');
const OLD_PORT = 'http://127.0.0.1:51001';
const NEW_PORT = 'http://127.0.0.1:52002';

console.log('0.3.49 · B-05/B-11 导航与开窗判定（url-policy.js，纯函数）');

// ── ① 导航：同源放行、跨源拒绝（端口每次启动都变）──────────────────────────
section('① 导航白名单（will-navigate）');
{
  const nav = (target, current) => up.decideNavigation({ target, currentOrigin: current, allowedFileRoots: [APP_ROOT] });

  const same = nav(NEW_PORT + '/#/session/1', NEW_PORT);
  ok(same.allow === true && same.kind === 'backend-origin', '同源（随机端口）内的页面跳转放行', same);
  ok(same.reason === 'same-origin', '放行原因为 same-origin', same.reason);

  const otherPort = nav('http://127.0.0.1:59999/x', NEW_PORT);
  ok(otherPort.allow === false && otherPort.reason === 'cross-origin-navigation',
    '回环但**不同端口**也拒绝（不能用"是否回环"判定，否则可跳到别的本地服务并继续带我们的 preload）', otherPort);

  const crossOrigin = nav('https://example.com/', NEW_PORT);
  ok(crossOrigin.allow === false && crossOrigin.reason === 'cross-origin-navigation', '跨源导航拒绝', crossOrigin);

  const localhostVsIp = nav('http://localhost:52002/x', NEW_PORT);
  ok(localhostVsIp.allow === false, 'localhost 与 127.0.0.1 属不同 origin，跨源拒绝', localhostVsIp);

  // 端口无关：同一套策略在旧端口/新端口下都成立（不写死端口）
  const olderRun = nav(OLD_PORT + '/x', OLD_PORT);
  ok(olderRun.allow === true, '换一次启动（端口 51001）同样放行自身 origin', olderRun);

  const hashOnly = nav(NEW_PORT + '/#/plugins', NEW_PORT);
  ok(hashOnly.allow === true, '纯 hash 路由不触发拒绝', hashOnly);
}

// ── ② 导航：file:// 只允许应用自身目录 ──────────────────────────────────────
section('② 导航白名单（file:// 自身页面）');
{
  const nav = (target) => up.decideNavigation({ target, currentOrigin: NEW_PORT, allowedFileRoots: [APP_ROOT] });
  const settingsUrl = 'file:///' + path.join(APP_ROOT, 'settings.html').replace(/\\/g, '/');
  const splashUrl = 'file:///' + path.join(APP_ROOT, 'splash.html').replace(/\\/g, '/');
  ok(nav(settingsUrl).allow === true, '应用目录内的 settings.html 放行', nav(settingsUrl));
  ok(nav(splashUrl).allow === true, '应用目录内的 splash.html 放行', nav(splashUrl));
  const outside = nav('file:///C:/Windows/System32/calc.exe');
  ok(outside.allow === false && outside.reason === 'file-outside-app', '应用目录外的 file:// 拒绝（挡住"用导航打开本机程序"）', outside);
  const escape = nav('file:///' + path.join(APP_ROOT, '..', 'evil.html').replace(/\\/g, '/'));
  ok(escape.allow === false, '用 .. 逃出应用目录同样拒绝', escape);
}

// ── ③ 导航：协议白名单与不可解析输入 ────────────────────────────────────────
section('③ 导航：其它协议一律拒');
{
  const nav = (t) => up.decideNavigation({ target: t, currentOrigin: NEW_PORT, allowedFileRoots: [APP_ROOT] });
  ok(nav('about:blank').allow === false && nav('about:blank').reason === 'about-blank', 'about:blank 拒绝', nav('about:blank'));
  ok(nav('javascript:alert(1)').allow === false, 'javascript: 拒绝', nav('javascript:alert(1)'));
  ok(nav('data:text/html,<h1>x</h1>').allow === false, 'data: 拒绝', nav('data:text/html,<h1>x</h1>'));
  ok(nav('blob:http://127.0.0.1:52002/abc').allow === false, 'blob: 拒绝', nav('blob:http://127.0.0.1:52002/abc'));
  ok(nav('mailto:a@b.com').allow === false, 'mailto 不作为导航放行（只走开窗通道）', nav('mailto:a@b.com'));
  ok(nav('vscode://x').allow === false, '自定义协议拒绝', nav('vscode://x'));
  ok(nav('').allow === false && nav('').reason === 'unparsable-url', '空串拒绝', nav(''));
  ok(nav('not a url').allow === false, '不可解析字符串拒绝', nav('not a url'));
  ok(nav(null).allow === false, 'null 拒绝（不让 undefined 漏过去）', nav(null));
}

// ── ④ 开窗：默认 deny + 外链放行 ───────────────────────────────────────────
section('④ 开窗判定（setWindowOpenHandler，默认拒绝）');
{
  const open = (t, extra) => up.decideWindowOpen(Object.assign({ target: t, currentOrigin: NEW_PORT }, extra || {}));

  ok(open('https://github.com/deepseek-ai/deepseek-harness').action === 'open-external',
    '受信外链（GitHub）交给系统浏览器打开', open('https://github.com/deepseek-ai/deepseek-harness'));
  ok(open('https://github.com/x').reason === 'external-http', '外链原因 external-http', open('https://github.com/x').reason);
  ok(open('mailto:help@deepseek.com').action === 'open-external', 'mailto 交给邮件客户端', open('mailto:help@deepseek.com'));

  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x/y', 'vscode://x', '']) {
    const d = open(bad);
    ok(d.action === 'deny', `拒绝 ${JSON.stringify(bad)}`, d);
  }
  ok(open('file:///C:/Windows/System32/calc.exe').reason === 'protocol-not-allowlisted',
    'file:// 的拒绝理由是协议不在白名单（B-11 的显式理由）', open('file:///C:/Windows/System32/calc.exe').reason);

  const creds = open('https://user:pass@evil.example/');
  ok(creds.action === 'deny' && creds.reason === 'credentials-in-url', '带用户名/密码的 URL 拒绝（经典钓鱼形态）', creds);

  const ascii = open('https://xn--80ak6aa92e.com/');
  ok(ascii.action === 'open-external', 'punycode 形态（已是 ASCII）按普通外链处理', ascii);
  const uni = open('https://аpple.com/'); // 首字母是西里尔字母 а
  ok(uni.action === 'deny' && uni.reason === 'host-non-ascii', '含非 ASCII 字符的主机拒绝（Unicode 同形字钓鱼）', uni);

  const sameOrig = open(NEW_PORT + '/somewhere');
  ok(sameOrig.action === 'deny' && sameOrig.reason === 'same-origin-popup-denied',
    '同源弹窗也拒绝（我们不需要任何子窗口）', sameOrig);
  const loopback = open('http://127.0.0.1:59999/x');
  ok(loopback.action === 'deny' && loopback.reason === 'loopback-not-external',
    '回环地址不交给系统浏览器（那是我们自己的 UI/本地服务）', loopback);

  const about = open('about:blank');
  ok(about.action === 'deny', 'about:blank 开窗拒绝', about);
}

// ── ⑤ 可选：外链主机允许清单（配置驱动，不写死）────────────────────────────
section('⑤ 外链主机允许清单（可选收紧）');
{
  const allow = up.resolveExternalHostAllowlist({ DSH_EXTERNAL_HOST_ALLOWLIST: 'github.com, deepseek.com' });
  ok(allow.join(',') === 'github.com,deepseek.com', '环境变量解析为主机清单', allow);
  ok(up.resolveExternalHostAllowlist({}).length === 0, '未设置 → 空清单（不限制主机）', up.resolveExternalHostAllowlist({}));
  ok(up.resolveExternalHostAllowlist({ DSH_EXTERNAL_HOST_ALLOWLIST: ' , ' }).length === 0, '全空 → 空清单', true);

  const open = (t) => up.decideWindowOpen({ target: t, currentOrigin: NEW_PORT, externalHostAllowlist: allow });
  ok(open('https://github.com/x').action === 'open-external', '清单内主机放行', open('https://github.com/x'));
  ok(open('https://api.github.com/x').action === 'open-external', '子域按后缀匹配放行', open('https://api.github.com/x'));
  const denied = open('https://evil.example/x');
  ok(denied.action === 'deny' && denied.reason === 'host-not-allowlisted', '清单外主机拒绝', denied);
}

// ── ⑥ 辅助函数与日志文案 ────────────────────────────────────────────────────
section('⑥ 辅助函数');
{
  ok(up.originOf('http://127.0.0.1:1234/a/b?c=1') === 'http://127.0.0.1:1234', 'originOf 丢掉路径与查询', up.originOf('http://127.0.0.1:1234/a/b?c=1'));
  ok(up.originOf('file:///C:/x.html') === 'file://', 'originOf 对 file: 返回统一标记', up.originOf('file:///C:/x.html'));
  ok(up.originOf('nope') === null, '不可解析返回 null', up.originOf('nope'));
  ok(up.isLoopbackHost('127.0.0.1') && up.isLoopbackHost('LOCALHOST') && up.isLoopbackHost('[::1]'), '回环主机识别（大小写/IPv6 括号）', true);
  ok(!up.isLoopbackHost('example.com') && !up.isLoopbackHost('127.0.0.1.evil.com'), '近似域名不算回环', true);
  ok(up.normalizeHost('.127.0.0.1') === '127.0.0.1', 'normalizeHost 去掉 cookies 常见的点前缀', up.normalizeHost('.127.0.0.1'));
  ok(up.sameOrigin('http://127.0.0.1:1/a', 'http://127.0.0.1:1/b') === true, 'sameOrigin 忽略路径', true);
  ok(up.sameOrigin('http://127.0.0.1:1/a', 'http://127.0.0.1:2/a') === false, 'sameOrigin 区分端口', true);

  const line = up.describeDecision('will-navigate', 'https://evil.example/', up.decideNavigation({ target: 'https://evil.example/', currentOrigin: NEW_PORT }));
  ok(/^\[url-policy\] will-navigate allow=false/.test(line), 'describeDecision 生成统一日志行（main.js 不再自己拼）', line);
  ok(up.NAVIGATION_ALLOWED_PROTOCOLS.includes('http:') && up.NAVIGATION_ALLOWED_PROTOCOLS.includes('file:'),
    '导航允许协议清单显式可读', up.NAVIGATION_ALLOWED_PROTOCOLS);
  ok(!up.EXTERNAL_ALLOWED_PROTOCOLS.includes('file:'), '外链白名单**不含** file:（B-11 的核心）', up.EXTERNAL_ALLOWED_PROTOCOLS);
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
clearTimeout(killer);
console.log('\n────────────────────────────────────────');
console.log(`断言 ${pass + failures.length} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
}
process.exit(failures.length ? 1 : 0);
