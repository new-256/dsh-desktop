'use strict';

/**
 * session-hygiene —— 旧后端源遗留 cookie 的清理（0.3.49 · B-01）。
 *
 * ## 为什么存在（这是真 bug，不是洁癖）
 *
 * 后端用 `--port 0` 启动，**每次启动端口都不同**。而 **cookie 的作用域只看
 * hostname，端口不参与**（RFC 6265；官方注释原文："Cookies ignore ports, so
 * cookies from earlier random-port Hosts would otherwise travel with every
 * request to that hostname until they expire."）。
 *
 * 后果：上一轮后端（旧端口）种在 `127.0.0.1` 上的 cookie，会被带到本轮**新端口**
 * 的请求里 —— 表现为"莫名要求重新登录 / 接口莫名报错 / Failed to fetch"这类
 * 无法归因的故障。0.3.48 之前在 `session` 上**没有任何 cookie 处理**。
 *
 * ## 清理边界（唯一的真实风险，必须写死在这里）
 *
 * `127.0.0.1` 是公共命名空间：同一台机器上还有别的本地服务（别的工具、用户的
 * 自建服务）也可能在回环上种 cookie。**无差别清空回环 cookie 会误删别人的登录态。**
 * 所以默认策略是**双重限定**：
 *
 *   ① 主机名 ∈ {127.0.0.1, localhost, ::1}（我们的后端只在这些主机上）；
 *   ② cookie 名命中本产品前缀（默认 `dsh`/`dsh-auth`/`dsh-session`/`dsh-desktop`，
 *      可用环境变量覆盖）。
 *
 * 两条同时满足才会删除。不满足的（包括回环上别家的 `other-tool=1`、以及用户在
 * github.com 等站点的登录 cookie）**一律不动**，并在计划里留下 "keep + reason"，
 * 便于事后核对"为什么它没被清"。
 *
 * 另外提供显式收紧/放宽开关（都要求用户明确打开，默认关闭）：
 *   · `DSH_COOKIE_NAME_PREFIXES=a,b`  覆盖前缀清单
 *   · `DSH_COOKIE_PURGE_ALL_LOOPBACK=1` 清空回环上的**全部** cookie
 *     （整机只有本产品用 127.0.0.1 时可开；默认关闭，避免误伤）
 *
 * ## 为什么拆成「纯计划 + 薄执行」
 *
 * `planCleanup(cookies, policy)` 是纯函数：输入 Electron `cookies.get({})` 的
 * 结果数组，输出要删/要留的清单与原因。于是"只清目标源、不动其它站点"这件事可以
 * 在 Node 里用几十条断言打穿（`scripts/test-b01-cookie-hygiene.js`），而不是靠
 * 手工开两个窗口点一遍。`createCookieHygiene({session}).clean()` 只负责把计划执行
 * 掉并汇总 —— 失败逐条记录，绝不静默（调用方会把失败写进诊断日志与后端日志）。
 */

/** 后端只监听回环；这些主机名属于本应用的 Web UI。 */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

/** 默认的"本产品 cookie 名"前缀（命中才算我们的）。 */
const DEFAULT_NAME_PREFIXES = Object.freeze(['dsh', 'dsh-auth', 'dsh-session', 'dsh-desktop']);

/** 解析 `DSH_COOKIE_NAME_PREFIXES`（逗号分隔）；空/未设 → 默认清单。 */
function resolveNamePrefixes(env) {
  const raw = env && env.DSH_COOKIE_NAME_PREFIXES;
  if (!raw || !String(raw).trim()) return [...DEFAULT_NAME_PREFIXES];
  const list = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : [...DEFAULT_NAME_PREFIXES];
}

/** `DSH_COOKIE_PURGE_ALL_LOOPBACK=1` 才清空回环全部 cookie（默认关）。 */
function shouldPurgeAllLoopback(env) {
  const raw = env && env.DSH_COOKIE_PURGE_ALL_LOOPBACK;
  return String(raw || '').trim() === '1';
}

/** 规范化 domain：`cookies.get()` 常见 `.127.0.0.1` 形态。 */
function normalizeDomain(domain) {
  if (!domain) return '';
  let d = String(domain).trim().toLowerCase();
  if (d.startsWith('.')) d = d.slice(1);
  if (d.startsWith('[') && d.endsWith(']')) d = d.slice(1, -1);
  return d;
}

/** 名字是否命中任一前缀（大小写不敏感；`dsh` 命中 `dsh-auth-xyz`）。 */
function nameMatchesPrefix(name, prefixes) {
  const n = String(name || '').toLowerCase();
  return prefixes.some((p) => n === p || n.startsWith(p + '-') || n.startsWith(p + '_') || n.startsWith(p));
}

/**
 * 组装清理策略。
 * @param {{hosts?: string[], namePrefixes?: string[], purgeAllOnLoopback?: boolean}} [opts]
 * @returns {{hosts: string[], namePrefixes: string[], purgeAllOnLoopback: boolean}}
 */
function resolvePolicy(opts) {
  const o = opts || {};
  const hosts = (Array.isArray(o.hosts) && o.hosts.length ? o.hosts : LOOPBACK_HOSTS)
    .map(normalizeDomain).filter(Boolean);
  const namePrefixes = (Array.isArray(o.namePrefixes) && o.namePrefixes.length ? o.namePrefixes : DEFAULT_NAME_PREFIXES)
    .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return { hosts, namePrefixes, purgeAllOnLoopback: !!o.purgeAllOnLoopback };
}

/** 构造 `cookies.remove(url, name)` 需要的 URL（协议由 secure 决定）。 */
function cookieRemovalUrl(cookie) {
  const scheme = cookie && cookie.secure ? 'https' : 'http';
  const domain = normalizeDomain(cookie && cookie.domain);
  const path = (cookie && cookie.path) || '/';
  return `${scheme}://${domain}${path}`;
}

/**
 * 纯计划：给定 cookie 列表与策略，算出"删哪些、为什么"和"留哪些、为什么"。
 *
 * @param {Array<{name?:string, domain?:string, path?:string, secure?:boolean, hostOnly?:boolean}>} cookies
 * @param {ReturnType<typeof resolvePolicy>} policy
 * @returns {{remove: Array<object>, keep: Array<{name:string, domain:string, reason:string}>,
 *            byHost: Record<string, number>}}
 */
function planCleanup(cookies, policy) {
  const p = resolvePolicy(policy);
  const list = Array.isArray(cookies) ? cookies : [];
  const remove = [];
  const keep = [];
  const byHost = {};

  for (const c of list) {
    const name = String((c && c.name) || '');
    const domain = normalizeDomain(c && c.domain);
    const onLoopback = p.hosts.includes(domain);

    if (!onLoopback) {
      keep.push({ name, domain, reason: 'not-our-host' });
      continue;
    }
    if (!p.purgeAllOnLoopback && !nameMatchesPrefix(name, p.namePrefixes)) {
      // 回环上但不属于本产品前缀 ⇒ 可能是别的本地工具的登录态，绝不动。
      keep.push({ name, domain, reason: 'name-prefix-mismatch' });
      continue;
    }
    const item = {
      name,
      domain,
      path: (c && c.path) || '/',
      secure: !!(c && c.secure),
      hostOnly: !!(c && c.hostOnly),
      url: cookieRemovalUrl(c),
      reason: p.purgeAllOnLoopback ? 'loopback-purge-all' : 'name-prefix-match'
    };
    remove.push(item);
    byHost[domain] = (byHost[domain] || 0) + 1;
  }

  return { remove, keep, byHost };
}

/**
 * 薄执行器：注入 Electron `session`（任何带 `cookies.get/ remove` 的对象都行，
 * 便于测试用假 session 驱动）。
 *
 * @param {{session: {cookies: {get: Function, remove: Function}},
 *          log?: (message: string, detail?: any) => void, now?: () => Date}} deps
 */
function createCookieHygiene(deps) {
  const d = deps || {};
  const session = d.session;
  const log = typeof d.log === 'function' ? d.log : () => {};
  const now = typeof d.now === 'function' ? d.now : () => new Date();

  /**
   * 执行一次清理。
   * @param {{hosts?: string[], namePrefixes?: string[], purgeAllOnLoopback?: boolean}} [opts]
   * @returns {Promise<{scanned:number, removed:Array<object>, failed:Array<{url:string,name:string,reason:string}>,
   *                    byHost:Record<string,number>, kept:number, skipped:boolean}>}
   */
  async function clean(opts) {
    const policy = resolvePolicy(opts || {});
    if (!session || !session.cookies || typeof session.cookies.get !== 'function') {
      // 明确失败：调用方必须知道"没扫成"，而不是以为"本来就没有 cookie"。
      throw new Error('session-hygiene：没有可用的 session.cookies（无法清理旧后端 cookie）');
    }
    const all = await session.cookies.get({});
    const plan = planCleanup(all, policy);
    const removed = [];
    const failed = [];

    for (const item of plan.remove) {
      try {
        // Electron 的 remove 返回 Promise<boolean>；false 表示"没删掉"（cookie 已不在）。
        // 两种情况都不算失败：目标是"清理后不存在"，这里用 get 复核（见下）。
        await session.cookies.remove(item.url, item.name);
        removed.push(item);
      } catch (e) {
        failed.push({ url: item.url, name: item.name, reason: (e && e.message) || String(e) });
      }
    }

    // 复核：真的没了吗？（remove 抛错已记录；这里抓"静默没删掉"的情况）
    const stillThere = [];
    if (removed.length) {
      try {
        const after = await session.cookies.get({});
        const afterKeys = new Set((Array.isArray(after) ? after : []).map((c) => `${normalizeDomain(c.domain)}|${c.name}`));
        for (const item of removed) {
          if (afterKeys.has(`${item.domain}|${item.name}`)) stillThere.push(item);
        }
      } catch (e) {
        log('session-hygiene：清理后复核失败（按未复核记录）', { error: (e && e.message) || String(e) });
      }
    }

    const result = {
      scanned: Array.isArray(all) ? all.length : 0,
      removed: removed.filter((x) => !stillThere.some((s) => s.domain === x.domain && s.name === x.name)),
      failed,
      stillThere,
      byHost: plan.byHost,
      kept: plan.keep.length,
      at: now().toISOString(),
      policy
    };
    log('session-hygiene：旧后端 cookie 清理完成', {
      scanned: result.scanned,
      removed: result.removed.length,
      kept: result.kept,
      byHost: result.byHost,
      failed: result.failed.length,
      stillThere: result.stillThere.length
    });
    return result;
  }

  return { clean, plan: planCleanup };
}

/** 一行式摘要（main.js 写后端日志用，避免再拼一遍字符串）。 */
function summarizeResult(result) {
  const r = result || {};
  const hosts = Object.keys(r.byHost || {});
  const hostPart = hosts.length ? hosts.map((h) => `${h}×${r.byHost[h]}`).join('、') : '无';
  return `旧后端 cookie 清理：扫描 ${r.scanned || 0} 条，清除 ${(r.removed || []).length} 条（${hostPart}），保留 ${r.kept || 0} 条`
    + (r.failed && r.failed.length ? `；失败 ${r.failed.length} 条` : '')
    + (r.stillThere && r.stillThere.length ? `；清理后仍存在 ${r.stillThere.length} 条` : '');
}

module.exports = {
  LOOPBACK_HOSTS,
  DEFAULT_NAME_PREFIXES,
  resolveNamePrefixes,
  shouldPurgeAllLoopback,
  normalizeDomain,
  nameMatchesPrefix,
  resolvePolicy,
  cookieRemovalUrl,
  planCleanup,
  createCookieHygiene,
  summarizeResult
};
