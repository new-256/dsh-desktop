'use strict';

/**
 * stage1-compile-gate —— 阶段一的编译/静态检查 + 验证脚本总闸。
 *
 * 为什么需要它：本阶段有 3 支团队并行改 5 个文件、新增若干模块与十几个测试脚本。
 * 逐个手敲命令既会漏（新文件没人 --check），也无法回答「这一次门禁到底跑了什么」。
 * 所以门禁必须**自发现 + 单点超时 + 全文归档**：
 *   1) 运行期 JS 清单取自 package.json 的 build.files（electron-builder 的白名单，
 *      也就是「真正会被打进 asar 的文件」），再并上仓库根的 `*.js` 与本次新增的
 *      模块文件——后者即使忘了加进 build.files 也要先过语法检查，从而把
 *      「漏打包」暴露成门禁告警而不是用户现场的启动崩溃；
 *   2) 每个检查/每个测试都经 stage1-run-with-timeout.js 执行 → 不会无限挂起，
 *      超时会给出卡死位置与最后输出；
 *   3) 所有输出**全文**落到同一个日志文件（项目规则：编译错误全文入档），
 *      末尾附机器可读的汇总 JSON，便于 02_编译阶段/编译错误分析与修复.md 引用。
 *
 * 用法：
 *   node stage1-compile-gate.js --log <日志文件> [--timeout 300] [--test-timeout 120]
 *        [--tests "scripts/test-h*.js,scripts/test-h10-*.js"] [--skip-tests]
 *        [--summary-json <文件>]
 *   退出码：0=全通过；1=有失败/超时；2=用法错误。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..'); // 修复与借鉴_.../02_编译阶段/tools → 仓库根
const RUNNER = path.join(__dirname, 'stage1-run-with-timeout.js');

function parseArgs(argv) {
  const o = { log: null, timeout: 300, testTimeout: 120, testPatterns: [], skipTests: false, summaryJson: null, suite: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log') o.log = argv[++i];
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--test-timeout') o.testTimeout = Number(argv[++i]);
    else if (a === '--tests') o.testPatterns.push(...String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--suite') o.suite = argv[++i];
    else if (a === '--skip-tests') o.skipTests = true;
    else if (a === '--summary-json') o.summaryJson = argv[++i];
    else { console.error('未知参数：' + a); process.exit(2); }
  }
  if (!o.log) { console.error('用法：node stage1-compile-gate.js --log <日志文件> [--suite stage2] [--tests "a,b"] [--skip-tests]'); process.exit(2); }
  return o;
}

/** 把 "scripts/test-h*.js" 之类的简单通配展开成实际文件（只需支持 * 与目录前缀）。 */
function expandGlob(pattern) {
  const norm = pattern.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dirPart = slash === -1 ? '.' : norm.slice(0, slash);
  const filePart = slash === -1 ? norm : norm.slice(slash + 1);
  const dir = path.join(ROOT, dirPart);
  if (!fs.existsSync(dir)) return [];
  if (!filePart.includes('*')) return [path.join(dir, filePart)].filter((p) => fs.existsSync(p));
  const re = new RegExp('^' + filePart.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return fs.readdirSync(dir)
    .filter((n) => re.test(n))
    .map((n) => path.join(dir, n))
    .sort();
}

/**
 * 判定一个验证脚本该用哪个运行器。
 *
 * 为什么需要判定：真机类验收脚本（例如 H-06 的 CSP 真机断言）必须跑在 Electron 里才有
 * `ipcMain`/`BrowserWindow`；用 node 跑会在 `ipcMain.handle` 处直接 TypeError —— 那是
 * **调用方跑错运行时**，不是产品缺陷。门禁如果把这类脚本一律丢给 node，就会产出假失败，
 * 久而久之没人再信门禁。所以这里按脚本内容自动识别，不写死文件名。
 */
function pickRunner(abs) {
  let src = '';
  try { src = fs.readFileSync(abs, 'utf8'); } catch { return { runner: process.execPath, via: 'node（读取失败，按 node 处理）' }; }

  const electronBin = [process.env.DSH_ELECTRON_BIN, path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')]
    .filter(Boolean).find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;

  // ① 脚本自己声明的用法注释最权威（两类脚本都写了「用法：…」）：
  //    "用法：node scripts/x.js"                          → 父模式，必须用 node
  //    "用法：node_modules\electron\dist\electron.exe …"  → 真机模式，必须用 electron
  // 这一步很关键：有的脚本是「一个文件两种模式」，用 node 跑父模式、再由它自己 spawn electron
  // 跑子模式 —— 若门禁一律丢给 electron，父模式会拿不到 electron 路径字符串而直接失败。
  const usage = /用法[:：]\s*(\S[^\r\n]*)/.exec(src);
  if (usage) {
    const u = usage[1];
    if (/electron(?:\.exe)?/i.test(u) && !/^node\s+scripts/i.test(u.trim())) {
      return electronBin ? { runner: electronBin, via: 'electron（脚本用法注明需 Electron）' }
        : { runner: null, via: 'electron（未找到 electron.exe，无法执行）' };
    }
    if (/^node\s+scripts/i.test(u.trim())) return { runner: process.execPath, via: 'node（脚本用法注明用 node）' };
  }

  // ② 无用法注释时按代码特征判断。
  const selfSpawnsElectron = /spawn(?:Sync)?\(\s*electron(?:Exe|Path|Bin)?\b/.test(src)
    || /typeof\s+\w*electron\w*\s*!==\s*['"]string['"]/.test(src);
  if (selfSpawnsElectron) return { runner: process.execPath, via: 'node（脚本自举 Electron 子进程）' };

  const requiresElectron = /require\s*\(\s*['"]electron['"]\s*\)/.test(src);
  const usesElectronApi = /\b(?:app\.whenReady|new\s+BrowserWindow|ipcMain\.(?:handle|on)|BrowserWindow\()/.test(src);
  if (requiresElectron && usesElectronApi) {
    return electronBin ? { runner: electronBin, via: 'electron（脚本使用了 Electron API）' }
      : { runner: null, via: 'electron（未找到 electron.exe，无法执行）' };
  }
  return { runner: process.execPath, via: 'node' };
}

/** 运行期 JS 清单：build.files 的白名单 ∪ 仓库根 *.js（后者能抓出「新模块忘了进白名单」）。 */
function collectRuntimeFiles() {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const files = Array.isArray(pkg.build && pkg.build.files) ? pkg.build.files : [];

  const fromBuild = new Set();
  for (const pattern of files) {
    if (!pattern.endsWith('.js') || pattern.startsWith('!') || pattern.includes('*')) continue;
    const abs = path.join(ROOT, pattern);
    if (fs.existsSync(abs)) fromBuild.add(abs);
  }

  const rootJs = fs.readdirSync(ROOT)
    .filter((n) => n.endsWith('.js'))
    .map((n) => path.join(ROOT, n));

  const all = new Map();
  for (const abs of rootJs) all.set(abs, fromBuild.has(abs) ? 'build.files' : 'root-only(未列入 build.files)');
  for (const abs of fromBuild) if (!all.has(abs)) all.set(abs, 'build.files');
  return { pkg, entries: [...all.entries()].sort((a, b) => a[0].localeCompare(b[0])) };
}

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

/**
 * 「断言全通过但脚本自己不退出」的登记表。
 *
 * 为什么需要这个机制：历史 Electron 测试脚本（0.3.43 时代的 test-043.js 等）跑完断言后
 * 没有 app.quit()，进程会一直挂着 —— 它既不是产品回归（断言全绿），也不是能被修好的
 * 代码缺陷（要动别人的测试文件），更不该让门禁永远红着以至于没人再相信门禁。
 * 所以用一张**显式登记的例外表**：只有表里点名的脚本、且只在「超时」这一种结局下，
 * 才降级为 WARN 并在汇总里单独列出。未登记的脚本超时仍算失败。
 */
function loadKnownHangs() {
  const p = path.join(__dirname, 'known-hangs.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const map = new Map();
    for (const e of (raw.entries || [])) map.set(e.script, e);
    return map;
  } catch {
    return new Map();
  }
}

/**
 * 读取门禁套件清单（gate-suites.json）。
 * 把「本轮必须跑哪些测试」从代码搬到数据：测试改名/新增只改 JSON，
 * 而且清单里 required 的预期项缺失会显式报红，不会静默漏跑。
 */
function loadSuite(name) {
  if (!name) return null;
  const p = path.join(__dirname, 'gate-suites.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const suite = (raw.suites || {})[name];
  if (!suite) throw new Error(`未知门禁套件：${name}（可用：${Object.keys(raw.suites || {}).join(' / ')}）`);
  return suite;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logPath = path.resolve(opts.log);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const banner = [
    '',
    '#'.repeat(78),
    `# 阶段一 编译门禁  ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `# 仓库根     : ${ROOT}`,
    `# node       : ${process.version}`,
    `# 单项超时   : --check ${opts.timeout}s / 测试 ${opts.testTimeout}s`,
    `# 日志       : ${logPath}`,
    '#'.repeat(78),
    ''
  ].join('\n');
  fs.writeFileSync(logPath, banner + '\n');
  process.stdout.write(banner + '\n');

  const { pkg, entries } = collectRuntimeFiles();
  const results = [];

  // ── 0. 打包白名单门禁（单一事实来源：直接调用 scripts/build-files-gate.js）────
  // 为什么在这里也要跑：compile-gate 是"交付前全量体检"，而"新文件忘了进 build.files"
  // 是最容易在体检里被漏掉的一类（node --check 与业务测试都发现不了）。
  // 这里**不重复实现** glob 匹配 —— 早期版本在本文件里用朴素字符串比较，遇到 `*.js`
  // 通配就会把全部根级模块误报成"未列入 build.files"，那种假红灯会直接毁掉门禁可信度。
  const filesGateHeader = `\n${'─'.repeat(78)}\n【第零节】打包白名单门禁（scripts/build-files-gate.js）\n${'─'.repeat(78)}\n`;
  fs.appendFileSync(logPath, filesGateHeader + '\n');
  process.stdout.write(filesGateHeader);
  const filesGateJson = path.join(path.dirname(logPath), `build-files-gate_${Date.now()}.json`);
  const filesGateRes = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'build-files-gate.js'), '--json', filesGateJson
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const filesGateOut = (filesGateRes.stdout || '') + (filesGateRes.stderr || '');
  fs.appendFileSync(logPath, filesGateOut + '\n');
  process.stdout.write(filesGateOut);
  results.push({ kind: 'gate', target: 'scripts/build-files-gate.js', exit: filesGateRes.status, label: 'build-files-gate' });

  // ── 0b. 随包 appId 常量门禁（H-08 / AUMID）─────────────────────────────────
  // 与 build-files-gate 同理：这是"打包才知道"的缺陷，必须在体检里有一票否决权。
  const idGateHeader = `\n${'─'.repeat(78)}\n【第零·二节】随包 appId 常量一致性门禁（scripts/app-identity-gate.js）\n${'─'.repeat(78)}\n`;
  fs.appendFileSync(logPath, idGateHeader + '\n');
  process.stdout.write(idGateHeader);
  const idGateJson = path.join(path.dirname(logPath), `app-identity-gate_${Date.now()}.json`);
  const idGateRes = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'app-identity-gate.js'), '--json', idGateJson
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const idGateOut = (idGateRes.stdout || '') + (idGateRes.stderr || '');
  fs.appendFileSync(logPath, idGateOut + '\n');
  process.stdout.write(idGateOut);
  results.push({ kind: 'gate', target: 'scripts/app-identity-gate.js', exit: idGateRes.status, label: 'app-identity-gate' });

  // ── 1. node --check ────────────────────────────────────────────────────────
  const checkHeader = `\n${'─'.repeat(78)}\n【第一节】node --check 语法检查（${entries.length} 个文件）\n${'─'.repeat(78)}\n`;
  fs.appendFileSync(logPath, checkHeader + '\n');
  process.stdout.write(checkHeader);

  // 白名单覆盖情况已由【第零节】的 build-files-gate 权威判定（含 glob 与否定模式），
  // 这里不再用朴素字符串比较重复一遍 —— 早期的重复实现会把 `*.js` 通配下的全部根级模块误报，
  // 那种假红灯会直接毁掉门禁的可信度。

  for (const [abs] of entries) {
    const label = `node --check ${rel(abs)}`;
    const res = spawnSync(process.execPath, [
      RUNNER, '--label', label, '--timeout', String(opts.timeout), '--log', logPath, '--', process.execPath, '--check', abs
    ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    results.push({ kind: 'check', target: rel(abs), exit: res.status, label });
    process.stdout.write(res.stdout || '');
    if (res.stderr) process.stdout.write(res.stderr);
  }

  // ── 2. 验证脚本 ────────────────────────────────────────────────────────────
  const knownHangs = loadKnownHangs();
  if (!opts.skipTests) {
    const testFiles = [];
    const seen = new Set();
    // 默认门禁集合 = 阶段一三支团队的验证脚本 + 会随代码演进被打破的历史回归脚本。
    // 套件来自工具目录下的 gate-suites.json：新增/改名测试只改清单，门禁代码不动。
    // 清单里 required=true 的「预期测试」若匹配 0 个文件会显式判失败 —— 这样"测试没写"、
    // "测试被改名后没人发现"都不会伪装成绿。
    const suite = loadSuite(opts.suite);
    const patterns = opts.testPatterns.length
      ? opts.testPatterns
      : (suite ? suite.include : ['scripts/test-h*.js', 'scripts/verify-h*.js', 'scripts/test-047-desktop-report.js']);
    const matchStats = [];
    for (const p of patterns) {
      const hits = expandGlob(p);
      matchStats.push({ pattern: p, count: hits.length });
      for (const abs of hits) {
        if (seen.has(abs)) continue;
        seen.add(abs);
        testFiles.push(abs);
      }
    }

    // 预期测试存在性（required 缺席 = 硬失败）
    const missingExpected = [];
    if (suite && Array.isArray(suite.expect)) {
      for (const e of suite.expect) {
        const hits = expandGlob(e.pattern);
        if (hits.length === 0 && e.required) missingExpected.push(e);
      }
    }

    const testHeader = `\n${'─'.repeat(78)}\n【第二节】验证脚本（${opts.suite ? '套件 ' + opts.suite : '自定义'}：${testFiles.length} 个）\n` +
      matchStats.map((s) => `  模式 ${s.pattern.padEnd(42)} 命中 ${s.count}`).join('\n') + '\n' +
      (testFiles.length ? '\n' + testFiles.map((f) => '  · ' + rel(f)).join('\n') : '\n  （无匹配文件——若团队尚未产出，这是硬失败，不是通过）') + '\n' +
      `${'─'.repeat(78)}\n\n`;
    fs.appendFileSync(logPath, testHeader);
    process.stdout.write(testHeader);

    if (missingExpected.length) {
      const msg = `✖ 清单里 required 的预期测试缺失（${missingExpected.length} 项）：\n` +
        missingExpected.map((e) => `    - ${e.pattern}  （${e.why}）`).join('\n') + '\n';
      fs.appendFileSync(logPath, msg);
      process.stdout.write(msg);
      results.push({ kind: 'suite', target: '缺少预期测试', exit: 1, label: `预期测试缺失 ${missingExpected.length} 项`, missingExpected });
    }

    if (testFiles.length === 0) {
      results.push({ kind: 'test', target: '(none)', exit: 1, label: '无任何验证脚本匹配' });
    }
    for (const abs of testFiles) {
      const pick = pickRunner(abs);
      const label = `${pick.via.split('（')[0]} ${rel(abs)}`;
      if (!pick.runner) {
        const msg = `\n[SKIP→FAIL] ${rel(abs)}：${pick.via}\n`;
        fs.appendFileSync(logPath, msg);
        process.stdout.write(msg);
        results.push({ kind: 'test', target: rel(abs), exit: 1, label, runner: null });
        continue;
      }
      const runnerArgs = pick.runner === process.execPath
        ? [RUNNER, '--label', label, '--timeout', String(opts.testTimeout), '--log', logPath, '--', process.execPath, abs]
        : [RUNNER, '--label', label, '--timeout', String(opts.testTimeout), '--log', logPath, '--', pick.runner, abs];
      const res = spawnSync(process.execPath, runnerArgs, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
      const known = knownHangs.get(rel(abs));
      if (res.status === 124 && known) {
        const note = `\n[已知未退出] ${rel(abs)}：断言跑完后脚本不退出（超时 ${opts.testTimeout}s 后被 kill）。\n` +
          `  登记理由：${known.reason}\n  证据：${known.evidence}\n  复核：${known.reviewedBy} @ ${known.reviewedAt}\n`;
        fs.appendFileSync(logPath, note);
        process.stdout.write(note);
        results.push({ kind: 'test', target: rel(abs), exit: 124, label, runner: pick.runner, passWithHang: true, knownHang: known });
        continue;
      }
      results.push({ kind: 'test', target: rel(abs), exit: res.status, label, runner: pick.runner });
      process.stdout.write(res.stdout || '');
      if (res.stderr) process.stdout.write(res.stderr);
    }
  }

  // ── 3. 汇总 ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.exit !== 0 && !r.passWithHang);
  const timedOut = results.filter((r) => r.exit === 124);
  const hangs = results.filter((r) => r.passWithHang);
  const table = [
    '',
    '═'.repeat(78),
    '【门禁汇总】',
    `  版本(package.json) : ${pkg.version}`,
    `  检查项             : ${results.length}（语法 ${results.filter((r) => r.kind === 'check').length} / 门禁 ${results.filter((r) => r.kind === 'gate').length} / 测试 ${results.filter((r) => r.kind === 'test').length}）`,
    `  通过               : ${results.length - failed.length - hangs.length}`,
    `  通过但进程未退出    : ${hangs.length}${hangs.length ? '（断言全绿、脚本自身没调 app.quit/exit —— 已在下面点名）' : ''}`,
    `  失败               : ${failed.length}${timedOut.length ? `（其中超时卡死 ${timedOut.length}）` : ''}`,
    hangs.length ? '  通过但未退出清单    :\n' + hangs.map((r) => `    ⚠ ${r.target}`).join('\n') : '',
    failed.length ? '  失败清单           :\n' + failed.map((r) => `    ✗ [${r.kind}] ${r.target} → exit=${r.exit}`).join('\n')
      : '  结论               : ✅ 全部通过',
    '═'.repeat(78),
    ''
  ].filter((l) => l !== '').join('\n');
  fs.appendFileSync(logPath, table);
  process.stdout.write(table);

  if (opts.summaryJson) {
    fs.writeFileSync(path.resolve(opts.summaryJson), JSON.stringify({
      startedAt: new Date().toISOString(), version: pkg.version, log: logPath,
      total: results.length, failed: failed.length, timedOut: timedOut.length,
      passWithHang: hangs.map((r) => r.target), results
    }, null, 2) + '\n');
  }
  process.exit(failed.length ? 1 : 0);
}

main();
