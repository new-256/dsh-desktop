'use strict';

/**
 * url-policy —— 主进程的**导航与开窗判定**（0.3.49 · B-05 / B-11）。
 *
 * ## 为什么存在
 *
 * 0.3.48 的两个窗口是 `sandbox:false` + 没有 `will-navigate` 处理器 +
 * `setWindowOpenHandler` 对非 http(s) **一律放行**（`main.js` 旧实现）：
 *
 *   · 页面里一个普通链接就能把主窗口导航到任意站点。导航出去以后，页面依然挂着
 *     本应用的 preload（`window.dshDesktop`）与 IPC 授权 —— 等于把"应用窗口"交给
 *     了外部页面。
 *   · `window.open('file:///C:/Windows/System32/calc.exe')`、`data:`、自定义协议
 *     会真的开出一个新 BrowserWindow（共享同一 session、无 preload 但仍有导航能力）。
 *   · `shell.openExternal(target)` 对目标**不做任何校验**（B-11）。
 *
 * ## 设计原则（为什么是"纯函数 + 每次动态给上下文"）
 *
 * 我们的后端用 `--port 0`，**每次启动端口都不同**；任何写死 origin/端口的白名单
 * 第二天就失效。所以判定函数只接收入参：目标 URL + 当前窗口所属 origin +
 * 允许的文件根 + 可选的外链主机允许清单。main.js 每次调用时把这些上下文传进来，
 * 端口变化自动跟随。
 *
 * 本模块不 require electron —— 因此可以在 Node 里用几十个用例把判定打穿
 * （`scripts/test-b05-url-policy.js`），而不是靠"打开窗口点一点"。
 */

/** 导航允许的协议（其余一律拒；导航绝不打开邮件/外部程序）。 */
const NAVIGATION_ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:', 'file:']);

/**
 * 允许交给系统浏览器/邮件客户端的外部协议（B-11 白名单）。
 * 为什么含 `http:`：内网/文档链接常见，且它打开的是**用户自己的浏览器**，
 * 真正的风险面是 `file:`/`javascript:`/自定义协议（会让系统执行东西）。
 * 为什么含 `mailto:`：更新弹窗与文档里的联系链接；只打开邮件客户端，无执行面。
 */
const EXTERNAL_ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:', 'mailto:']);

/** 后端只监听回环；这些主机名属于"我们自己的 Web UI"。 */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 主机名只允许 ASCII 字母/数字/点/短横（挡住 Unicode 同形字钓鱼）。 */
const ASCII_HOST_RE = /^[a-z0-9.-]+$/i;

/**
 * 原始 URL 里的 authority 段是否全 ASCII。
 *
 * 为什么不能只看 `new URL(x).hostname`：WHATWG URL 会把 Unicode 主机**自动转成
 * punycode**（`https://аpple.com/` → `https://xn--pple-43d.com/`），于是"看起来是
 * ASCII" —— 同形字钓鱼正好借这一步洗白。所以必须回到**用户给出的原始字符串**
 * 上看主体部分有没有非 ASCII 字符。
 */
function rawAuthorityIsAscii(raw) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(raw == null ? '' : raw).trim());
  if (!m) return true; // 没有 authority 的形态（mailto: 等）不适用本条
  let authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  authority = authority.replace(/:\d+$/, '');
  return /^[a-z0-9.[\]-]+$/i.test(authority);
}


function safeParseUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  try { return new URL(text); } catch { return null; }
}

/** `proto//host:port`（`URL.origin` 对 file: 会返回 'null'，这里统一成字符串）。 */
function originOf(input) {
  const u = safeParseUrl(typeof input === 'string' ? input : '');
  if (!u) return null;
  if (u.protocol === 'file:') return 'file://';
  return u.origin;
}

/** 是否回环主机（后端 Web UI 的宿主）。 */
function isLoopbackHost(host) {
  if (!host) return false;
  return LOOPBACK_HOSTS.includes(String(host).toLowerCase());
}

/** 规范化主机名：去端口/去尾点/小写（`cookies.get()` 的 domain 常带前导点）。 */
function normalizeHost(value) {
  if (!value) return '';
  let host = String(value).trim().toLowerCase();
  if (host.startsWith('.')) host = host.slice(1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function sameOrigin(a, b) {
  const oa = originOf(a);
  const ob = originOf(b);
  return !!oa && !!ob && oa === ob;
}

function hasCredentials(url) {
  return !!(url && (url.username || url.password));
}

/** Windows 下 `file://` 路径比较要忽略大小写与分隔符差异。 */
function normalizeFsPath(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
  if (/^\/[a-z]:/i.test(s)) s = s.slice(1);
  return s.replace(/\/+$/, '').toLowerCase();
}

function isInsideRoots(fileUrl, roots) {
  const list = Array.isArray(roots) ? roots : [];
  if (!list.length) return false;
  let target;
  try { target = decodeURIComponent(fileUrl.pathname); } catch { target = fileUrl.pathname; }
  const normalizedTarget = normalizeFsPath(target);
  return list.some((root) => {
    const r = normalizeFsPath(root);
    return r && (normalizedTarget === r || normalizedTarget.startsWith(r + '/'));
  });
}

/**
 * 导航判定：页面是否允许在主窗口里切走。
 *
 * 规则（自解释，顺序即优先级）：
 *   1. 解析失败/空 → 拒（unparsable-url）
 *   2. `about:blank` → 拒（about-blank：我们不需要空白弹窗）
 *   3. `file:` → 只允许应用自身目录内的页面（app-file），其余拒（file-outside-app）
 *   4. `http(s)` → 只允许与"当前窗口所属 origin"完全一致（含端口）；跨源一律拒
 *      （cross-origin-navigation）。这是最关键的一条：**不能用"是否回环"判定**，
 *      否则页面可以跳到另一个本地服务并继续携带我们的 preload 与 IPC 授权。
 *   5. 其余协议（data:/javascript:/blob:/自定义）→ 拒（protocol-not-allowed）
 *
 * @param {{target: string, currentOrigin?: string|null, allowedFileRoots?: string[]}} input
 * @returns {{allow: boolean, kind: 'backend-origin'|'app-file'|'denied', reason: string}}
 */
function decideNavigation(input) {
  const i = input || {};
  const target = safeParseUrl(i.target);
  if (!target) return { allow: false, kind: 'denied', reason: 'unparsable-url' };

  if (target.protocol === 'about:') {
    return { allow: false, kind: 'denied', reason: 'about-blank' };
  }
  if (!NAVIGATION_ALLOWED_PROTOCOLS.includes(target.protocol)) {
    return { allow: false, kind: 'denied', reason: 'protocol-not-allowed' };
  }
  if (target.protocol === 'file:') {
    return isInsideRoots(target, i.allowedFileRoots)
      ? { allow: true, kind: 'app-file', reason: 'app-file' }
      : { allow: false, kind: 'denied', reason: 'file-outside-app' };
  }
  // http / https
  const current = i.currentOrigin ? originOf(i.currentOrigin) : null;
  if (current && target.origin === current) {
    return { allow: true, kind: 'backend-origin', reason: 'same-origin' };
  }
  return { allow: false, kind: 'denied', reason: 'cross-origin-navigation' };
}

/**
 * 开窗判定（`setWindowOpenHandler`）。默认拒绝：我们**不需要**任何子窗口，
 * 唯一"放行"的形式是交给系统浏览器/邮件客户端的 `open-external`。
 *
 * 规则：
 *   1. 解析失败 → deny（unparsable-url）
 *   2. 与当前窗口同源 → deny（same-origin-popup-denied：同源弹窗也用不上，
 *      且会多出一个持有我们 preload 的窗口）
 *   3. 协议不在 `EXTERNAL_ALLOWED_PROTOCOLS` → deny（protocol-not-allowlisted）
 *   4. URL 带用户名/密码 → deny（credentials-in-url：`https://user:pass@host/`
 *      是经典钓鱼形态，官方同样明确拒绝）
 *   5. 主机含非 ASCII 字符 → deny（host-non-ascii：Unicode 同形字）
 *   6. http(s) 且主机是回环 → deny（loopback-not-external：我们自己的 UI 不该
 *      被丢进系统浏览器）
 *   7. 配了外链主机允许清单（可选）而主机不在其中 → deny（host-not-allowlisted）
 *   8. 其余 → open-external（浏览器 / 邮件客户端）
 *
 * @param {{target: string, currentOrigin?: string|null, externalHostAllowlist?: string[]}} input
 * @returns {{action: 'deny'|'open-external', reason: string, url: string|null}}
 */
function decideWindowOpen(input) {
  const i = input || {};
  const target = safeParseUrl(i.target);
  if (!target) return { action: 'deny', reason: 'unparsable-url', url: null };

  if (i.currentOrigin && sameOrigin(i.target, i.currentOrigin)) {
    return { action: 'deny', reason: 'same-origin-popup-denied', url: target.href };
  }
  if (!EXTERNAL_ALLOWED_PROTOCOLS.includes(target.protocol)) {
    return { action: 'deny', reason: 'protocol-not-allowlisted', url: target.href };
  }
  if (hasCredentials(target)) {
    return { action: 'deny', reason: 'credentials-in-url', url: target.href };
  }
  // 邮件地址没有 host：在主机类检查之前返回，否则会被当成"空主机"误杀。
  if (target.protocol === 'mailto:') {
    return { action: 'open-external', reason: 'mailto', url: target.href };
  }
  // 同形字检查必须看原始字符串（URL 会把 Unicode 主机洗成 punycode）。
  if (!rawAuthorityIsAscii(i.target)) {
    return { action: 'deny', reason: 'host-non-ascii', url: target.href };
  }
  const host = normalizeHost(target.hostname);
  if (!host || !ASCII_HOST_RE.test(host)) {
    return { action: 'deny', reason: 'host-non-ascii', url: target.href };
  }
  if (isLoopbackHost(host)) {
    // 回环地址属于"我们自己的 UI"或其它本地服务：绝不交给系统浏览器。
    return { action: 'deny', reason: 'loopback-not-external', url: target.href };
  }
  const allow = Array.isArray(i.externalHostAllowlist) ? i.externalHostAllowlist.map(normalizeHost).filter(Boolean) : [];
  if (allow.length && !allow.some((h) => host === h || host.endsWith('.' + h))) {
    return { action: 'deny', reason: 'host-not-allowlisted', url: target.href };
  }
  return { action: 'open-external', reason: 'external-http', url: target.href };
}

/**
 * 从环境变量解析外链主机允许清单（可选收紧手段）。
 * 为什么放在这里而不是 main.js：main.js 只做接线，解析规则要可单测。
 * 未设置（或为空）→ 返回空数组，表示"按协议+凭据+ASCII 判定，不限制主机"。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {string[]}
 */
function resolveExternalHostAllowlist(env) {
  const raw = env && env.DSH_EXTERNAL_HOST_ALLOWLIST;
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((s) => normalizeHost(s))
    .filter((s) => s && ASCII_HOST_RE.test(s));
}

/** 把判定结果压成一行日志文案（main.js 只调这一个，不自己拼）。 */
function describeDecision(scope, target, decision) {
  const d = decision || {};
  const what = d.action ? `action=${d.action}` : `allow=${d.allow} kind=${d.kind}`;
  return `[url-policy] ${scope} ${what} reason=${d.reason} target=${String(target || '').slice(0, 200)}`;
}

module.exports = {
  NAVIGATION_ALLOWED_PROTOCOLS,
  EXTERNAL_ALLOWED_PROTOCOLS,
  LOOPBACK_HOSTS,
  safeParseUrl,
  originOf,
  isLoopbackHost,
  normalizeHost,
  sameOrigin,
  decideNavigation,
  decideWindowOpen,
  resolveExternalHostAllowlist,
  describeDecision
};
