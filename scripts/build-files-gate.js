'use strict';

/**
 * build-files-gate —— 出包前的「打包清单闭包门禁」。
 *
 * 为什么存在：`package.json` 的 `build.files` 是 electron-builder 的**白名单**，
 * 不在其中的文件不会进 app.asar。历史事故形态是：新增一个运行期模块（例如设置窗
 * 外提脚本、启动超时模块）却忘了加进白名单 —— `node --check` 通过、纯 Node 测试
 * 通过、`npm run dist` 也"成功"，只有用户装完启动时才发现「设置窗白屏 / 主进程
 * require 直接抛错」。这类缺陷**只能在打包清单层面**拦住。
 *
 * 判定方式（通用闭包，不写死任何文件名）：
 *   1) 入口 = package.json 的 main + 仓库根全部 .html；
 *   2) 从入口出发，扫 `require('./x')`（含相对子目录）与 `path.join(__dirname,'x')`
 *      这类静态引用，**递归**求传递闭包；
 *   3) 扫 .html 里的 `<script src>` / `<link rel=stylesheet href>` / `<img src>`，
 *      忽略 http(s)/data/协议相对等外部 URL；
 *   4) 把闭包里的每个文件拿 `build.files` 的白/黑名单做 glob 匹配，**缺一项即 exit 1
 *      并点名**；
 *   5) 反向体检（只告警不阻断）：列了却不存在、列了却没被任何入口引用；
 *   6) 裸包 require（如 electron-updater）单独列出，并检查 `node_modules/**` 是否被
 *      白名单显式排除 —— 一旦排除，运行期 `require('裸包')` 必然失败。
 *
 * 这个门禁被串进 `npm run dist`（见 package.json scripts.dist），因此"出包必过门禁"
 * 是机制而不是纪律。
 *
 * 退出码：0 = 通过（可能有告警）；1 = 有必需文件不在 build.files；2 = 用法错误。
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
// Node 内置模块不是 npm 包；electron 由 Electron 运行时本身提供（不来自 node_modules）。
const HOST_PROVIDED = new Set(['electron', ...builtinModules]);
// 反向体检只走应用源码树，跳过这些巨型/无关目录。
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'release', '.git', '.tmp-othersapi-test', '.tmp-research', '.playwright-mcp', 'build']);

function parseArgs(argv) {
  // strict 默认开启：这条检查（运行期读取被剥离字段）已经真实咬到过一次
  // （0.3.48 的 H-08 打包后 AUMID 空转），告警级别不够 —— 打包才知道的缺陷必须 fail-closed。
  const o = { json: null, verbose: false, quiet: false, pkg: null, strict: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = argv[++i];
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--no-strict') o.strict = false;
    // --pkg 用于对一个"历史/假设的 package.json"复算门禁（出包门禁的红绿取证要可复现）。
    else if (a === '--pkg') o.pkg = argv[++i];
    else { console.error('未知参数：' + a + '（可用：--json <文件> --verbose --quiet --pkg <package.json> --strict / --no-strict）'); process.exit(2); }
  }
  return o;
}

const OUT = [];
function say(line = '') { OUT.push(line); console.log(line); }

function toPosix(p) { return p.split(path.sep).join('/'); }

/** 把 minimatch 风格的模式编译成正则（够用即可：*, **, ?, 目录前缀）。 */
function globToRegExp(pattern) {
  let p = pattern.replace(/\\/g, '/');
  if (p.endsWith('/')) p += '**/*';
  // 无通配符且形如目录（不以常见扩展名结尾）→ 视为该目录下全部内容
  const hasWildcard = /[*?]/.test(p);
  if (!hasWildcard && !/\.[a-z0-9]+$/i.test(p)) p += '/**/*';

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // ** 跨越任意层级；吃掉紧随其后的 '/'
        i++;
        if (p[i + 1] === '/') i++;
        re += '(?:.*/)?';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

/** node 的 require 解析顺序（只处理工程内相对路径）。 */
function resolveRequire(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates = [];
  if (path.extname(base)) candidates.push(base);
  candidates.push(base, base + '.js', base + '.json', path.join(base, 'index.js'));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 下一个候选 */ }
  }
  return null;
}

const RE_REQUIRE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
// main.js 用 path.join(__dirname, 'preload.js') 而不是 require 引用 preload/资源，
// 只扫 require 会漏掉整个 preload / splash / icon 家族，所以补两条静态路径模式：
//   多段：path.join(__dirname, 'assets', 'icon.png')
//   拼接：__dirname + '/assets/icon.png'
const RE_DIRNAME_JOIN = /path\.(?:join|resolve)\(\s*__dirname((?:\s*,\s*(['"])[^'"]*\2)+)\s*\)/g;
const RE_QUOTED = /(['"])([^'"]*)\1/g;
const RE_DIRNAME_CAT = /__dirname\s*\+\s*(['"])([^'"]*)\1/g;

/** 解析一个 JS 文件里的静态引用：相对 require + __dirname 字面量路径。 */
function parseJs(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const relRefs = [];
  const bareRefs = [];
  let m;

  RE_REQUIRE.lastIndex = 0;
  while ((m = RE_REQUIRE.exec(src)) !== null) {
    const spec = m[2];
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const resolved = resolveRequire(abs, spec);
      relRefs.push({ spec, abs: resolved });
    } else if (!spec.startsWith('/') && !spec.startsWith('node:')) {
      const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!HOST_PROVIDED.has(pkgName)) bareRefs.push(spec);
    }
  }

  // __dirname 静态路径引用（preload / splash / 资源图标这类不走 require 的引用）
  const dirnameCandidates = [];
  RE_DIRNAME_JOIN.lastIndex = 0;
  while ((m = RE_DIRNAME_JOIN.exec(src)) !== null) {
    const parts = [];
    RE_QUOTED.lastIndex = 0;
    let q;
    while ((q = RE_QUOTED.exec(m[1])) !== null) parts.push(q[2]);
    if (parts.length) dirnameCandidates.push(parts.join('/'));
  }
  RE_DIRNAME_CAT.lastIndex = 0;
  while ((m = RE_DIRNAME_CAT.exec(src)) !== null) {
    const lit = m[2].replace(/\\/g, '/').replace(/^\/+/, '');
    if (lit) dirnameCandidates.push(lit);
  }
  for (const rel of dirnameCandidates) {
    if (!/\.(js|html|json|png|jpg|jpeg|svg|ico|css|woff2?)$/i.test(rel)) continue;
    const candidate = path.resolve(ROOT, rel);
    try {
      if (fs.statSync(candidate).isFile()) relRefs.push({ spec: './' + rel, abs: candidate });
    } catch { /* 静态不可解析的引用不追（运行期拼出来的路径本门禁无法判定） */ }
  }
  return { relRefs, bareRefs };
}

const RE_SCRIPT = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const RE_LINK = /<link[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
const RE_IMG = /<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

function isExternalUrl(u) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);
}

function parseHtml(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const refs = [];
  for (const re of [RE_SCRIPT, RE_LINK, RE_IMG]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const raw = m[1].trim();
      if (!raw || isExternalUrl(raw)) continue;
      const clean = raw.split('?')[0].split('#')[0];
      const candidate = path.resolve(path.dirname(abs), clean);
      refs.push({ spec: raw, abs: fs.existsSync(candidate) ? candidate : null });
    }
  }
  return refs;
}

/** 从入口出发求传递闭包。返回 { files:Set<abs>, jsFiles:Set<abs>, bareRefs:Map<spec, from[]> } */
function buildClosure(entries) {
  const files = new Set();
  const jsFiles = new Set();
  const bareRefs = new Map();
  const missingRefs = [];
  const queue = [...entries];

  while (queue.length) {
    const abs = queue.shift();
    if (!abs || files.has(abs)) continue;
    if (!fs.existsSync(abs)) { missingRefs.push(abs); continue; }
    files.add(abs);

    const ext = path.extname(abs).toLowerCase();
    if (ext === '.html') {
      for (const r of parseHtml(abs)) {
        if (r.abs) queue.push(r.abs);
        else missingRefs.push(path.resolve(path.dirname(abs), r.spec.split('?')[0]));
      }
    } else if (ext === '.js') {
      jsFiles.add(abs);
      const parsed = parseJs(abs);
      for (const r of parsed.relRefs) {
        if (r.abs) queue.push(r.abs);
        else missingRefs.push(path.resolve(path.dirname(abs), r.spec));
      }
      for (const b of parsed.bareRefs) {
        const pkgName = b.startsWith('@') ? b.split('/').slice(0, 2).join('/') : b.split('/')[0];
        if (!bareRefs.has(pkgName)) bareRefs.set(pkgName, new Set());
        bareRefs.get(pkgName).add(toPosix(path.relative(ROOT, abs)));
      }
    }
  }
  return { files, jsFiles, bareRefs, missingRefs };
}

/** 递归列目录（跳过 SKIP_DIRS），用于反向体检「列了却不存在」。 */
function walkFiles(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.strict) {
    // 逃生阀必须喊话：允许有人临时绕过，但绝不允许"悄悄绕过"。
    console.log('');
    console.log('  ⚠⚠ 已跳过严格模式（--no-strict）：【3b】运行期读取被剥离字段 只告警、不阻断。');
    console.log('  ⚠⚠ 这是已知风险状态 —— 该检查曾真实拦下过「AUMID 在成品空转」的缺陷，');
    console.log('  ⚠⚠ 放行本次出包意味着把这类缺陷交付给用户。请在交付清单里如实记录本次绕过。');
    console.log('');
  }
  const pkgPath = opts.pkg ? path.resolve(opts.pkg) : path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const rawPatterns = Array.isArray(pkg.build && pkg.build.files) ? pkg.build.files : [];

  const includes = rawPatterns.filter((p) => !p.startsWith('!')).map((p) => ({ raw: p, re: globToRegExp(p) }));
  const excludes = rawPatterns.filter((p) => p.startsWith('!')).map((p) => ({ raw: p, re: globToRegExp(p.slice(1)) }));

  /** 该仓库相对路径是否会被打进安装包。 */
  function isPacked(relPosix) {
    if (excludes.some((e) => e.re.test(relPosix))) return { packed: false, why: '被排除模式命中最深的否定项' };
    const hit = includes.find((i) => i.re.test(relPosix));
    return hit ? { packed: true, why: hit.raw } : { packed: false, why: null };
  }

  // ── 入口 ────────────────────────────────────────────────────────────────
  const entries = [];
  if (typeof pkg.main === 'string') entries.push(path.resolve(ROOT, pkg.main));
  const rootHtml = fs.readdirSync(ROOT).filter((n) => n.toLowerCase().endsWith('.html')).map((n) => path.join(ROOT, n));
  entries.push(...rootHtml);
  // 仓库根全部 .js 也作为候选入口参与"未被引用"体检，但不强行要求入包。
  const rootJs = fs.readdirSync(ROOT).filter((n) => n.endsWith('.js')).map((n) => path.join(ROOT, n));

  const { files, jsFiles, bareRefs, missingRefs } = buildClosure(entries);

  say('');
  say('══════════════════════════════════════════════════════════════════════════════');
  say('  build.files 出包清单闭包门禁');
  say(`  仓库根 : ${ROOT}`);
  say(`  版本   : ${pkg.version}`);
  say(`  入口   : ${[pkg.main, ...rootHtml.map((p) => path.basename(p))].filter(Boolean).join(' + ')}`);
  say(`  白名单 : ${includes.length} 条  黑名单 : ${excludes.length} 条`);
  say('══════════════════════════════════════════════════════════════════════════════');

  // ── 1. 闭包文件是否都在白名单里 ──────────────────────────────────────────
  say('');
  say('【1】引用闭包 → build.files 覆盖检查');
  const required = [...files]
    .map((abs) => toPosix(path.relative(ROOT, abs)))
    .filter((rel) => !rel.startsWith('..'))
    .sort();
  // package.json 是 asar 的应用清单（main 字段由它决定），electron-builder 必须带上；
  // 它不来自任何 require，所以显式计入"必需"，否则反向体检会误报"列了没人用"。
  if (!required.includes('package.json')) required.unshift('package.json');

  const missing = [];
  for (const rel of required) {
    const verdict = isPacked(rel);
    if (!verdict.packed) missing.push({ file: rel, why: verdict.why });
  }

  say(`  闭包文件数 : ${required.length}`);
  if (opts.verbose) for (const r of required) say(`    · ${r}`);
  if (missing.length) {
    say(`  ✖ 缺失 ${missing.length} 项（打包后会从 app.asar 里消失 → 现场表现为主进程 require 失败或界面白屏）：`);
    for (const m of missing) say(`    ✖ ${m.file}${m.why ? '  (' + m.why + ')' : ''}`);
  } else {
    say('  ✔ 闭包内全部文件都被 build.files 覆盖');
  }

  // ── 2. 引用不存在 ─────────────────────────────────────────────────────────
  say('');
  say('【2】引用目标存在性（悬空引用）');
  const dangling = [...new Set(missingRefs.map((p) => toPosix(path.relative(ROOT, p))))].filter((r) => !r.startsWith('..'));
  if (dangling.length) {
    say(`  ⚠ 有 ${dangling.length} 个静态引用指向不存在的文件（不影响本门禁判定，但运行期会抛 ENOENT）：`);
    for (const d of dangling) say(`    ⚠ ${d}`);
  } else {
    say('  ✔ 无悬空引用');
  }

  // ── 3. 反向体检 ──────────────────────────────────────────────────────────
  say('');
  say('【3】反向体检（只告警，不阻断出包）');
  let warnCount = 0;
  const allFiles = [...walkFiles(ROOT)].map((abs) => toPosix(path.relative(ROOT, abs)));
  const requiredSet = new Set(required);
  for (const inc of includes) {
    const rawBase = inc.raw.replace(/^!/, '');
    const matched = allFiles.filter((f) => inc.re.test(f));
    if (matched.length === 0) {
      warnCount++;
      say(`  ⚠ 白名单条目匹配不到任何文件：${rawBase}（拼写错误？该文件已删除？）`);
      continue;
    }
    // 只有"点名到具体文件"的条目才值得报未被引用；通配条目（*.js / assets/**）必然含大量合法资源。
    const isConcreteFile = !/[*?]/.test(rawBase) && /\.[a-z0-9]+$/i.test(rawBase);
    if (isConcreteFile) {
      const unref = matched.filter((f) => !requiredSet.has(f));
      for (const u of unref) {
        warnCount++;
        say(`  ⚠ 白名单点名了「${rawBase}」但它没被任何入口引用（会被打进包，白占体积）：${u}`);
      }
    }
  }
  const unreachableRootJs = rootJs
    .map((abs) => toPosix(path.relative(ROOT, abs)))
    .filter((rel) => !requiredSet.has(rel));
  if (unreachableRootJs.length) {
    warnCount += unreachableRootJs.length;
    say(`  ⚠ 仓库根有 ${unreachableRootJs.length} 个 .js 未被入口闭包引用（不会被需要，但若被通配模式 * 收进包会白占体积）：`);
    for (const u of unreachableRootJs) say(`    ⚠ ${u}`);
  }
  if (warnCount === 0) say('  ✔ 未发现「列了却不存在」或「列了却没人用」的条目');

  // ── 3b. 运行期读取「会被打包剥离的字段」────────────────────────────────────
  // 为什么单独查这一条：electron-builder 打包时会重写 app 的 package.json，
  // 只保留 name/version/main/dependencies 等必要字段 —— `build`、`scripts`、
  // `devDependencies` 全被剥掉。运行期若去读 `require('./package.json').build.appId`
  // 之类，**开发态永远是对的、装完之后永远是 undefined**，而且不报错、只在业务上静默失效。
  // 实物案例：0.3.48 的 H-08 就是这样 —— 打包后 `build.appId` 为 undefined，
  // `app.setAppUserModelId()` 从未执行，AUMID 保护在 shipped 包里空转。
  say('');
  say('【3b】运行期读取「打包后会被剥离的字段」检查');
  let strippedCount = 0;
  const STRIPPED_FIELDS = ['build', 'scripts', 'devDependencies'];
  for (const abs of files) {
    if (path.extname(abs).toLowerCase() !== '.js') continue;
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (!/require\s*\(\s*['"]\.\/package\.json['"]\s*\)/.test(src)) continue;
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const f of STRIPPED_FIELDS) {
        if (new RegExp('\\.' + f + '\\b').test(line)) {
          strippedCount++;
          say(`  ⚠ ${toPosix(path.relative(ROOT, abs))}:${i + 1} 读取 package.json 的 .${f}（打包后该字段会被剥离）`);
          say(`      → ${line.trim().slice(0, 120)}`);
        }
      }
    }
  }
  if (strippedCount === 0) say('  ✔ 未发现运行期依赖被剥离字段');
  else {
    say('  处置：把该值改由构建期注入（electron-builder extraMetadata）或随包常量文件提供；');
    say('        不要假定 electron-builder 打包后的 package.json 与源码一致。');
    if (opts.strict) missing.push({ file: '(运行期读取被剥离字段)', why: `${strippedCount} 处（--strict 已阻断）` });
  }

  // ── 4. 裸包依赖（node_modules）────────────────────────────────────────────
  say('');
  say('【4】运行期裸包依赖（node_modules）');
  const nodeModulesExcluded = excludes.some((e) => e.re.test('node_modules/electron-updater/package.json'));
  const bareList = [...bareRefs.keys()].sort();
  if (bareList.length === 0) say('  （闭包内无裸包 require）');
  for (const name of bareList) {
    const installed = fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json'));
    const from = [...bareRefs.get(name)].join(', ');
    const declared = Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, name);
    const state = installed ? (nodeModulesExcluded ? '✖ 已安装但 node_modules 被白名单排除' : '✔ 已安装') : '✖ 未安装';
    say(`  ${state}  ${name}  (require 自: ${from}${declared ? '；已在 dependencies' : '；⚠ 未列入 dependencies'}）`);
    if (!installed) missing.push({ file: `node_modules/${name}`, why: '运行期裸包未安装' });
    if (installed && nodeModulesExcluded) missing.push({ file: `node_modules/${name}`, why: 'node_modules 被 build.files 否定模式排除' });
  }

  // ── 结论 ─────────────────────────────────────────────────────────────────
  say('');
  say('══════════════════════════════════════════════════════════════════════════════');
  if (missing.length) {
    say(`  结论：✖ 门禁未通过 —— ${missing.length} 项阻断，禁止出包。`);
    say('  阻断项：');
    for (const m of missing) say(`    - ${m.file}${m.why ? '  (' + m.why + ')' : ''}`);
    const fileItems = missing.filter((m) => !m.file.startsWith('('));
    if (fileItems.length) {
      say('  其中「不在打包清单内」的条目，处置方式：补进 package.json build.files（优先用通配模式，避免下次再漏）：');
      for (const m of fileItems) say(`    → ${m.file}`);
    }
  } else {
    say('  结论：✔ 门禁通过 —— 引用闭包与 build.files 一致，可以出包。');
  }
  say('══════════════════════════════════════════════════════════════════════════════');
  say('');

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify({
      generatedAt: new Date().toISOString(),
      version: pkg.version,
      entryPoints: entries.map((e) => toPosix(path.relative(ROOT, e))),
      includePatterns: rawPatterns.filter((p) => !p.startsWith('!')),
      excludePatterns: rawPatterns.filter((p) => p.startsWith('!')),
      closureFiles: required,
      missing, dangling, barePackages: bareList,
      passed: missing.length === 0
    }, null, 2) + '\n');
  }
  process.exit(missing.length ? 1 : 0);
}

main();
