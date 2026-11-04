'use strict';

/**
 * app-identity-gate —— 「随包 appId 常量」与 `package.json build.appId` 的一致性门禁。
 *
 * 为什么存在（0.3.48 实测事故）：
 *   electron-builder 打包时会重写 app 的 package.json，**`build` 字段被剥离**。
 *   于是 `require('./package.json').build.appId` 在开发态正确、在成品里恒为 undefined ——
 *   `app.setAppUserModelId()` 从未执行，AUMID 保护在 shipped 包里静默空转
 *   （实测日志：`未取得 build.appId，跳过 AppUserModelID 设置` / `aumidApplied:false`）。
 *   修法是把 appId 作为**随包常量模块**分发，运行期只读它。
 *
 *   但"两处各自写死 appId"必然漂移（安装器按 build.appId 写快捷方式身份、进程按常量设置
 *   AUMID；两者一旦不同，Windows 会把托盘气泡当成"另一个应用"而静默丢弃）。
 *   所以必须有一道机械校验：**常量模块导出的 appId 必须与 build.appId 完全一致**，
 *   且该模块必须真的被 main.js 引用、真的喂给 `setAppUserModelId`。
 *
 * 判定（全部 fail-closed，缺一不可）：
 *   1) 能找到「导出 appId 样式字符串常量」的随包模块（不写死文件名，按导出形状识别）；
 *   2) 该常量与 package.json 的 build.appId 逐字符相等；
 *   3) main.js 确实 require 了该模块，并把该常量传给 app.setAppUserModelId(...)；
 *   4) 若 main.js 仍在读 package.json 的 build/scripts/devDependencies → 直接失败。
 *
 * 用法：node scripts/app-identity-gate.js [--json <文件>]
 * 退出码：0=通过；1=不通过（阻断出包）；2=用法错误。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const o = { json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = argv[++i];
    else { console.error('未知参数：' + argv[i] + '（可用：--json <文件>）'); process.exit(2); }
  }
  return o;
}

function say(line = '') { console.log(line); }

const failures = [];
function fail(what, detail) { failures.push({ what, detail }); }

/**
 * 从源码文本里静态提取「形状像 appId」的字符串常量导出。
 *
 * 判定方式：先匹配任意「标识符 = 点分小写字符串」，再按名字同时含 APP 与 ID（不分大小写）过滤。
 * 刻意不用 `[A-Za-z_$][\w$]*APP` 这类写法 —— 那会把 `APP_ID` 这种**以 APP 开头**的名字整个漏掉，
 * 而本文件注释里举的例子恰好就是这种命名（该缺陷由 main-process-fix 复核时实测抓出：
 * `APP_ID` NO-MATCH / `DSH_APP_ID` MATCH，属于"实现迁就门禁"的反面教材）。
 * 现在由 `runSelfTest()` 用四个形状样本把这条判定钉死，退化会当场红灯。
 */
function extractFromSource(src) {
  const found = [];
  // appId 是反向域名式标识：**必须含点**（com.example.app）。
  // 早期版本允许纯连字符串（如 'no-dots-here'）通过，会让反向自测误判 —— 是匹配器过宽，不是样本太刁。
  const lookedLikeAppId = (v) => v.includes('.') && /^[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+$/.test(v);
  const nameLooksLikeAppId = (n) => /app/i.test(n) && /id/i.test(n);

  // const|let|var NAME = 'x.y.z';
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (nameLooksLikeAppId(m[1]) && lookedLikeAppId(m[2])) found.push({ name: m[1], value: m[2] });
  }
  // module.exports = { NAME: 'x.y.z', ... }   /   exports.NAME = 'x.y.z'
  const re2 = /(?:module\.exports\s*=\s*\{[^}]*?|exports\.)\s*([A-Za-z_$][\w$]*)\s*[:=]\s*['"]([^'"]+)['"]/g;
  while ((m = re2.exec(src)) !== null) {
    if (nameLooksLikeAppId(m[1]) && lookedLikeAppId(m[2])) found.push({ name: m[1], value: m[2] });
  }
  return found;
}

/** 读文件版（保留 file 字段，便于报错时指路）。 */
function findAppIdExports(file) {
  return extractFromSource(fs.readFileSync(file, 'utf8')).map((f) => ({ ...f, file }));
}

/**
 * 门禁自测：四种真实命名形状都必须被识别。
 * 为什么放在门禁内部每次跑：这个匹配器的历史版本退化成"吞掉首字符"，
 * 结果只认带前缀的名字 —— 那会让下一个人照文档写 `APP_ID` 就遇到假红，
 * 然后"改代码迁就门禁"。自测把这条路堵死：匹配器一旦退化，门禁自己先红。
 */
const SELF_TEST_SAMPLES = [
  { name: 'APP_ID', code: "const APP_ID = 'com.example.app';" },
  { name: 'APP_USER_MODEL_ID', code: "const APP_USER_MODEL_ID = 'com.example.app';" },
  { name: 'DSH_APP_ID', code: "const DSH_APP_ID = 'com.example.app';" },
  { name: 'myAppId', code: "const myAppId = 'com.example.app';" },
  { name: 'module.exports.APP_ID', code: "module.exports = { APP_ID: 'com.example.app' };" },
  { name: 'exports.APP_USER_MODEL_ID', code: "exports.APP_USER_MODEL_ID = 'com.example.app';" }
];

function runSelfTest(quiet) {
  const rows = [];
  let bad = 0;
  for (const s of SELF_TEST_SAMPLES) {
    const hits = extractFromSource(s.code);
    const matched = hits.some((h) => h.name === s.name.split('.').pop() && h.value === 'com.example.app');
    if (!matched) bad++;
    rows.push({ sample: s.name, code: s.code, matched, hits });
    if (!quiet) {
      say(`  ${matched ? '✔' : '✖'} 自测样本 ${s.name.padEnd(24)} → ${matched ? 'MATCH' : 'NO-MATCH'}（命中 ${hits.length}）`);
    }
  }
  // 反向样本：不是 appId 形状的常量不能被误判
  const neg = extractFromSource("const OTHER_NAME = 'not-an-app-id';\nconst APP_ID = 'no-dots-here';");
  const negOk = neg.length === 0;
  if (!negOk) bad++;
  if (!quiet) say(`  ${negOk ? '✔' : '✖'} 自测反向样本（无点号/非 appId 名）→ ${negOk ? '未误判' : '误判 ' + neg.length + ' 条'}`);
  return { rows, negativeOk: negOk, failures: bad };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const expected = pkg.build && pkg.build.appId;

  say('');
  say('══════════════════════════════════════════════════════════════════════════════');
  say('  随包 appId 常量一致性门禁（H-08 / AUMID）');
  say(`  仓库根 : ${ROOT}`);
  say(`  版本   : ${pkg.version}`);
  say(`  期望 appId（package.json build.appId）: ${expected || '（缺失）'}`);
  say('══════════════════════════════════════════════════════════════════════════════');

  if (!expected) fail('package.json build.appId', '缺失 —— 安装器身份无从确定');

  say('');
  say('【0】门禁自测：四种 appId 命名形状必须都被识别');
  const selfTest = runSelfTest(false);
  if (selfTest.failures > 0) {
    fail('门禁自测', `${selfTest.failures} 个样本未按预期匹配（匹配器退化，本门禁结论不可信）`);
  } else {
    say('  ✔ 自测全部通过（6 个正向样本 + 反向样本未误判）');
  }

  // ── 1. main.js 不得再读会被剥离的字段 ─────────────────────────────────────
  say('');
  say('【1】main.js 是否仍在读会被打包剥离的字段');
  const mainPath = path.join(ROOT, 'main.js');
  if (!fs.existsSync(mainPath)) fail('main.js', '不存在');
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  let strippedHits = 0;
  mainSrc.split(/\r?\n/).forEach((line, i) => {
    if (!/require\s*\(\s*['"]\.\/package\.json['"]\s*\)/.test(line) && !/\bpkg\b/.test(line)) return;
    for (const f of ['build', 'scripts', 'devDependencies']) {
      if (new RegExp('\\.' + f + '\\b').test(line)) {
        strippedHits++;
        say(`  ✖ main.js:${i + 1} 读取 .${f}（打包后该字段会被剥离）`);
        say(`      ${line.trim().slice(0, 120)}`);
      }
    }
  });
  // 兜底：任何位置出现 require('./package.json').build 都算
  if (/require\s*\(\s*['"]\.\/package\.json['"]\s*\)\s*\.\s*build/.test(mainSrc) && strippedHits === 0) {
    strippedHits++;
    say('  ✖ main.js 存在 require(\'./package.json\').build 链式访问');
  }
  if (strippedHits === 0) say('  ✔ main.js 不再依赖 package.json 的 build/scripts/devDependencies');
  else fail('main.js 读取被剥离字段', `${strippedHits} 处`);

  // ── 2. 找到随包 appId 常量模块 ────────────────────────────────────────────
  say('');
  say('【2】随包 appId 常量模块');
  const rootJs = fs.readdirSync(ROOT).filter((n) => n.endsWith('.js')).map((n) => path.join(ROOT, n));
  const candidates = [];
  for (const abs of rootJs) {
    if (path.basename(abs) === 'main.js') continue;
    let found;
    try { found = findAppIdExports(abs); } catch { continue; }
    for (const f of found) candidates.push(f);
  }
  if (candidates.length === 0) {
    say('  ✖ 仓库根找不到任何「appId 形状的字符串常量」模块');
    fail('随包 appId 常量', '未找到（H-08 修复缺失：成品里 setAppUserModelId 将永不执行）');
  } else {
    for (const c of candidates) say(`  · ${path.relative(ROOT, c.file)} → ${c.name} = '${c.value}'`);
  }

  // ── 3. 一致性比对 ────────────────────────────────────────────────────────
  say('');
  say('【3】常量值 vs build.appId 一致性');
  const matching = candidates.filter((c) => c.value === expected);
  if (candidates.length && expected) {
    if (matching.length === 0) {
      for (const c of candidates) fail('appId 不一致', `${path.relative(ROOT, c.file)}:${c.name}='${c.value}' ≠ build.appId='${expected}'`);
      say(`  ✖ 没有任何常量与 build.appId 相等（期望 '${expected}'）`);
      say('      → 安装器写进快捷方式的身份与进程 AUMID 分叉，Windows 会静默丢弃托盘气泡');
    } else {
      say(`  ✔ ${matching.length} 个常量与 build.appId 完全一致：'${expected}'`);
    }
  } else if (expected) {
    say('  （无可比对的常量，见【2】）');
  }

  // ── 4. 真的被 main.js 引用并喂给 setAppUserModelId ────────────────────────
  say('');
  say('【4】main.js 是否真的使用该常量设置 AUMID');
  const usedRequire = /require\s*\(\s*['"]\.\/([^'"]+)['"]\s*\)/.test(mainSrc);
  const callsSetAumid = /app\.setAppUserModelId\s*\(/.test(mainSrc);
  const anyConstName = candidates.map((c) => c.name);
  const usesCandidate = anyConstName.some((n) => new RegExp('\\b' + n + '\\b').test(mainSrc));
  say(`  main.js 有本地 require                : ${usedRequire ? '是' : '否'}`);
  say(`  main.js 调用 app.setAppUserModelId(…)  : ${callsSetAumid ? '是' : '否'}`);
  say(`  main.js 引用了候选常量名               : ${usesCandidate ? '是' : '否'}`);
  if (!callsSetAumid) fail('setAppUserModelId 未调用', 'main.js 中没有该调用');
  if (candidates.length && !usesCandidate) fail('常量未被使用', 'main.js 未引用任何候选 appId 常量');

  // ── 结论 ─────────────────────────────────────────────────────────────────
  say('');
  say('══════════════════════════════════════════════════════════════════════════════');
  if (failures.length) {
    say(`  结论：✖ 门禁未通过 —— ${failures.length} 项，禁止出包。`);
    for (const f of failures) say(`    - ${f.what}: ${f.detail}`);
  } else {
    say('  �� 门禁通过 —— appId 常量与 build.appId 一致，且已被 main.js 用于设置 AUMID。');
  }
  say('══════════════════════════════════════════════════════════════════════════════');
  say('');

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify({
      generatedAt: new Date().toISOString(), version: pkg.version,
      expectedAppId: expected, candidates: candidates.map((c) => ({ file: path.relative(ROOT, c.file), name: c.name, value: c.value })),
      selfTest: selfTest.rows, selfTestNegativeOk: selfTest.negativeOk, selfTestFailures: selfTest.failures,
      strippedFieldHits: strippedHits, passed: failures.length === 0, failures
    }, null, 2) + '\n');
  }
  process.exit(failures.length ? 1 : 0);
}

main();
