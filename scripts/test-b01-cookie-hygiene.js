'use strict';

/**
 * 0.3.49 · B-01 回归：旧后端源 cookie 清理（只清目标源，不动用户其它站点）。
 *
 * ## 关键背景
 *
 * 后端 `--port 0` 每次换端口，而 **cookie 作用域忽略端口**（RFC 6265）。旧端口种在
 * `127.0.0.1` 上的 cookie 会串到新端口 → "莫名重登 / 接口莫名报错"。
 *
 * 但 `127.0.0.1` 是公共命名空间：别的本地工具也在上面种 cookie。所以清理必须
 * **双重限定**（回环主机 + 本产品名前缀），否则就会误删别人的登录态 ——
 * 这正是本测试要打穿的地方：不只是"清干净了"，更要有"**没多清**"的断言。
 *
 * 用法：node scripts/test-b01-cookie-hygiene.js [--timeout 120]
 */

const sh = require('../session-hygiene');

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

/**
 * 多源 cookie 场景（模拟一台真实机器：本产品旧后端 + 别的本地工具 + 用户外网站点）。
 * `port` 只用于说明"端口不同但 hostname 相同"，cookie 本身不带端口。
 */
function multiSourceCookies() {
  return [
    // 本产品旧后端（回环 + dsh 前缀）—— 这些必须被清
    { name: 'dsh-auth-session', domain: '127.0.0.1', path: '/', secure: false },
    { name: 'dsh-session-id', domain: '127.0.0.1', path: '/', secure: false },
    { name: 'DSH-Token', domain: '.127.0.0.1', path: '/', secure: false },
    { name: 'dsh_pref', domain: 'localhost', path: '/', secure: false },
    { name: 'dsh-auth-web', domain: '::1', path: '/', secure: true },
    // 回环上但**不是**本产品 —— 绝不能动
    { name: 'other-tool', domain: '127.0.0.1', path: '/', secure: false },
    { name: 'grafana_session', domain: 'localhost', path: '/', secure: false },
    { name: 'not-dsh-but-similar', domain: '127.0.0.1', path: '/', secure: false },
    // 用户真实站点的登录态 —— 绝不能动
    { name: 'dsh-auth-lookalike', domain: 'github.com', path: '/', secure: true },
    { name: 'sessionid', domain: 'npmjs.com', path: '/', secure: true },
    { name: 'SID', domain: 'accounts.google.com', path: '/', secure: true },
    // 其它本地回环变体（不同 hostname）—— 按默认策略同样只是"回环+前缀"才清
    { name: 'dsh-auth-ipv6', domain: '[::1]', path: '/', secure: false }
  ];
}

(async () => {
console.log('0.3.49 · B-01 旧后端 cookie 清理（session-hygiene.js）');

// ── ① 纯计划：只清目标源 ────────────────────────────────────────────────────
section('① planCleanup：多源场景下"只清目标源"');
{
  const cookies = multiSourceCookies();
  const plan = sh.planCleanup(cookies, sh.resolvePolicy({}));
  const removedNames = plan.remove.map((c) => c.name);

  ok(removedNames.includes('dsh-auth-session') && removedNames.includes('dsh-session-id'),
    '回环 + dsh 前缀 → 清除', removedNames);
  ok(removedNames.includes('DSH-Token'), '前缀匹配大小写不敏感（DSH-Token）', removedNames);
  ok(removedNames.includes('dsh_pref'), '下划线分隔也算本产品前缀（dsh_pref）', removedNames);
  ok(removedNames.includes('dsh-auth-web'), 'https/secure 的 cookie 同样清除', removedNames);
  ok(removedNames.includes('dsh-auth-ipv6'), 'IPv6 回环 [::1] 上的本产品 cookie 清除', removedNames);

  ok(!removedNames.includes('other-tool'), '**其它本地工具的登录态（other-tool）必须保留**', removedNames);
  ok(!removedNames.includes('grafana_session'), '**其它本地服务（grafana_session）必须保留**', removedNames);
  ok(!removedNames.includes('not-dsh-but-similar'), '名字相似但不是前缀匹配（not-dsh-but-similar）保留', removedNames);
  ok(!removedNames.includes('dsh-auth-lookalike'), '**外网站点上的同前缀 cookie（github.com）必须保留**', removedNames);
  ok(!removedNames.includes('sessionid') && !removedNames.includes('SID'), '用户外网登录态（npmjs/google）保留', removedNames);

  const keepReasons = plan.keep.reduce((acc, k) => { acc[k.reason] = (acc[k.reason] || 0) + 1; return acc; }, {});
  ok(plan.keep.length === 6, '保留 6 条（3 回环他人 + 3 外网）', plan.keep.length);
  ok(keepReasons['not-our-host'] === 3, '外网站点被标记为 not-our-host（原因可追溯）', keepReasons);
  ok(keepReasons['name-prefix-mismatch'] === 3, '回环上他人 cookie 被标记为 name-prefix-mismatch', keepReasons);

  ok(plan.byHost['127.0.0.1'] === 3, '按主机汇总：127.0.0.1 三条（dsh-auth-session/dsh-session-id/DSH-Token）', plan.byHost);
  ok(plan.remove.every((c) => c.reason === 'name-prefix-match'), '每条删除都带原因', plan.remove.map((c) => c.reason));
}

// ── ② cookieRemovalUrl：Electron 的 remove(url,name) 需要正确的 URL ─────────
section('② cookieRemovalUrl');
{
  ok(sh.cookieRemovalUrl({ domain: '127.0.0.1', path: '/', secure: false }) === 'http://127.0.0.1/',
    '非 secure → http://', sh.cookieRemovalUrl({ domain: '127.0.0.1', path: '/', secure: false }));
  ok(sh.cookieRemovalUrl({ domain: '.127.0.0.1', path: '/x', secure: true }) === 'https://127.0.0.1/x',
    'secure + 点前缀 domain → https://（点前缀被去掉）', sh.cookieRemovalUrl({ domain: '.127.0.0.1', path: '/x', secure: true }));
  ok(sh.cookieRemovalUrl({}) === 'http:///', '极端缺字段不抛错（返回空 host 的 URL，由 remove 决定失败）', sh.cookieRemovalUrl({}));
}

// ── ③ 策略开关：前缀覆盖 / 全量清回环 ──────────────────────────────────────
section('③ 策略开关（配置驱动，不写死）');
{
  ok(sh.resolveNamePrefixes({}).join(',') === 'dsh,dsh-auth,dsh-session,dsh-desktop', '默认前缀清单可读', sh.resolveNamePrefixes({}));
  ok(sh.resolveNamePrefixes({ DSH_COOKIE_NAME_PREFIXES: 'acme, mytool' }).join(',') === 'acme,mytool',
    '环境变量可覆盖前缀（去空格/小写）', sh.resolveNamePrefixes({ DSH_COOKIE_NAME_PREFIXES: 'acme, mytool' }));
  ok(sh.shouldPurgeAllLoopback({}) === false, '默认**不**全量清回环（避免误伤）', true);
  ok(sh.shouldPurgeAllLoopback({ DSH_COOKIE_PURGE_ALL_LOOPBACK: '1' }) === true, '显式开关可打开全量清回环', true);

  const cookies = multiSourceCookies();
  const purgeAll = sh.planCleanup(cookies, sh.resolvePolicy({ purgeAllOnLoopback: true }));
  ok(purgeAll.remove.some((c) => c.name === 'other-tool'), '全量模式下回环他人 cookie 也在清理范围（显式选择）', purgeAll.remove.length);
  ok(!purgeAll.remove.some((c) => c.domain === 'github.com'), '即使全量模式也不碰外网站点', purgeAll.remove.map((c) => c.domain));

  const custom = sh.planCleanup(cookies, sh.resolvePolicy({ namePrefixes: ['other'] }));
  ok(custom.remove.length === 1 && custom.remove[0].name === 'other-tool', '自定义前缀只命中对应项', custom.remove.map((c) => c.name));
}

// ── ④ 假 session 驱动：真实执行路径 + 复核 + 失败可见 ───────────────────────
section('④ createCookieHygiene：用假 session 跑真实执行路径');
{
  /** 造一个内存 cookie store：remove 会真的删；可注入"删不掉"与"删会抛错"。 */
  function fakeSession(cookies, opts) {
    const o = opts || {};
    const store = cookies.map((c) => ({ ...c }));
    const calls = { get: 0, remove: [] };
    return {
      store,
      calls,
      cookies: {
        async get() { calls.get += 1; return store.map((c) => ({ ...c })); },
        async remove(url, name) {
          calls.remove.push({ url, name });
          if (o.throwOn && o.throwOn.includes(name)) throw new Error('cookie store 不可用（测试注入）');
          if (o.stuckOn && o.stuckOn.includes(name)) return true; // 假装成功删除（实际没删）
          const i = store.findIndex((c) => c.name === name);
          if (i >= 0) { store.splice(i, 1); return true; }
          return false;
        }
      }
    };
  }

  const session = fakeSession(multiSourceCookies());
  const logs = [];
  const hygiene = sh.createCookieHygiene({ session, log: (m, d) => logs.push({ m, d }) });
  const res = await hygiene.clean({});
  const remaining = session.store.map((c) => c.name);

  ok(res.scanned === 12, '扫描到全部 12 条 cookie', res.scanned);
  ok(res.removed.length === 6, '清除 6 条目标 cookie', res.removed.map((c) => c.name));
  ok(remaining.includes('other-tool') && remaining.includes('grafana_session'), '**其它本地工具的 cookie 仍在**', remaining);
  ok(remaining.includes('dsh-auth-lookalike') && remaining.includes('sessionid') && remaining.includes('SID'),
    '**用户外网站点登录态仍在**', remaining);
  ok(!remaining.some((n) => /^dsh(-|_)/i.test(n) && !n.includes('lookalike')), '本产品旧后端 cookie 已清空', remaining);
  ok(session.calls.get === 2, '清理前后各读一次 store（后一次用于复核）', session.calls.get);
  ok(res.stillThere.length === 0, '复核确认没有残留', res.stillThere);
  ok(logs.some((l) => /旧后端 cookie 清理完成/.test(l.m)), '清理结果写进日志（清了几条/按源分组）', logs.map((l) => l.m));

  const summary = sh.summarizeResult(res);
  ok(/扫描 12 条/.test(summary) && /清除 6 条/.test(summary) && /127\.0\.0\.1×3/.test(summary),
    '一行式摘要含条数与按源分组（供后端日志）', summary);
}

// ── ⑤ 失败不静默：抛错与"假成功"都要被记录 ────────────────────────────────
section('⑤ 失败与"假成功"都不静默');
{
  function fakeSession2(cookies, opts) {
    const o = opts || {};
    const store = cookies.map((c) => ({ ...c }));
    return {
      store,
      cookies: {
        async get() { return store.map((c) => ({ ...c })); },
        async remove(_url, name) {
          if (o.throwOn && o.throwOn.includes(name)) throw new Error('EACCES：cookie store 拒绝访问');
          if (o.stuckOn && o.stuckOn.includes(name)) return true;
          const i = store.findIndex((c) => c.name === name);
          if (i >= 0) store.splice(i, 1);
          return true;
        }
      }
    };
  }

  const throwing = fakeSession2(multiSourceCookies(), { throwOn: ['dsh-auth-session'] });
  const res1 = await sh.createCookieHygiene({ session: throwing }).clean({});
  ok(res1.failed.length === 1 && res1.failed[0].name === 'dsh-auth-session',
    'remove 抛错 → 记入 failed（不吞）', res1.failed);
  ok(/EACCES/.test(res1.failed[0].reason), '失败原因原文保留（可归因）', res1.failed[0].reason);
  ok(res1.removed.length === 5, '其它 5 条照常清理（一条失败不妨碍其余）', res1.removed.length);

  const stuck = fakeSession2(multiSourceCookies(), { stuckOn: ['dsh-session-id'] });
  const res2 = await sh.createCookieHygiene({ session: stuck }).clean({});
  ok(res2.stillThere.length === 1 && res2.stillThere[0].name === 'dsh-session-id',
    'remove 报成功但实际还在 → 复核抓出来（stillThere）', res2.stillThere);
  ok(!res2.removed.some((c) => c.name === 'dsh-session-id'), '复核失败的项不计入 removed（不虚报成功）', res2.removed.map((c) => c.name));
}

// ── ⑥ 幂等与边界 ───────────────────────────────────────────────────────────
section('⑥ 幂等与边界');
{
  const store = multiSourceCookies().filter((c) => sh.normalizeDomain(c.domain) !== '127.0.0.1');
  const session = {
    cookies: {
      async get() { return store.map((c) => ({ ...c })); },
      async remove(url, name) { const i = store.findIndex((c) => c.name === name); if (i >= 0) store.splice(i, 1); return true; }
    }
  };
  const hygiene = sh.createCookieHygiene({ session });
  const first = await hygiene.clean({});
  const second = await hygiene.clean({});
  ok(first.removed.length === 3, '第一轮清掉 3 条（localhost/::1/[::1]）', first.removed.length);
  ok(second.removed.length === 0, '第二轮（新端口启动）已无目标 → 幂等，不再删任何东西', second.removed.length);
  ok(second.kept === 4, '第二轮仍保留 4 条他人/外网 cookie（grafana/github/npmjs/google）', second.kept);

  let threw = null;
  try { await sh.createCookieHygiene({ session: null }).clean({}); } catch (e) { threw = e; }
  ok(!!threw && /没有可用的 session\.cookies/.test(threw.message),
    '没有 session 时明确抛错（不假装"本来就没 cookie"）', threw && threw.message);

  const empty = await sh.createCookieHygiene({
    session: { cookies: { async get() { return []; }, async remove() { return false; } } }
  }).clean({});
  ok(empty.scanned === 0 && empty.removed.length === 0, '空 store 不报错（首启动）', empty);
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
})().catch((err) => {
  console.error('[异常] 测试自身抛出未预期错误：');
  console.error(err && (err.stack || err.message));
  process.exit(2);
});
