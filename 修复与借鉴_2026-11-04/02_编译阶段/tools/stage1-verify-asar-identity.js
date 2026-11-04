'use strict';

/**
 * stage1-verify-asar-identity —— 从**成品 asar** 里读出关键源码，核对"装到用户机器上的到底是哪份代码"。
 *
 * 为什么需要：0.3.48 的 A 版事故证明，"仓库里跑绿"与"成品行为"完全可能脱节
 * （main.js 读 `require('./package.json').build.appId`，开发态有、成品里被剥离 → AUMID 空转）。
 * 只看构建日志与配置推断是不够的，必须回到产物字节上做断言：
 *   1) `main.js` 里不再出现 `require('./package.json')`（剥离字段的死路）；
 *   2) `main.js` 真的 require 了 `./app-identity` 并调用 `setAppUserModelId`；
 *   3) `app-identity.js` 里的 appId 字面量与 `package.json build.appId` 一致；
 *   4) 顺带核对闭包里每个 .js 的 SHA-256 与仓库源码一致（shipped == tested）。
 *
 * 用法：
 *   node stage1-verify-asar-identity.js <app.asar> [--repo <仓库根>] [--json <文件>]
 * 退出码：0=通过；1=不通过；2=用法/解析错误。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const o = { asar: null, repo: path.join(__dirname, '..', '..', '..'), json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = path.resolve(argv[++i]);
    else if (a === '--json') o.json = argv[++i];
    else if (!a.startsWith('--')) o.asar = a;
    else { console.error('未知参数：' + a); process.exit(2); }
  }
  if (!o.asar) { console.error('用法：node stage1-verify-asar-identity.js <app.asar> [--repo <根>] [--json <文件>]'); process.exit(2); }
  return o;
}

function loadAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const sz = Buffer.alloc(8);
  fs.readSync(fd, sz, 0, 8, 0);
  const size = sz.readUInt32LE(4);
  const hb = Buffer.alloc(size);
  fs.readSync(fd, hb, 0, size, 8);
  const sl = hb.readUInt32LE(4);
  const tree = JSON.parse(hb.toString('utf8', 8, 8 + sl));
  const base = 8 + size;
  const files = [];
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child && child.files) walk(child, rel);
      else files.push({ path: rel, entry: child });
    }
  })(tree, '');
  return {
    fd, base, files,
    read(rel) {
      const f = files.find((x) => x.path === rel);
      if (!f) return null;
      const off = Number(f.entry.offset);
      const len = f.entry.size;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, base + off);
      return buf;
    },
    close() { fs.closeSync(fd); }
  };
}

/**
 * 去掉注释后再做源码断言。
 * 为什么必须去注释：修复提交里通常会在注释里写清"旧写法是什么"（例如
 * `require('./package.json').<build 字段>` 这段血泪说明），如果直接正则扫全文，
 * 会把注释里的反面教材当成真实代码，制造假红灯 —— 门禁一旦开始误报就没人信了。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const asarPath = path.resolve(opts.asar);
  if (!fs.existsSync(asarPath)) { console.error('找不到 asar：' + asarPath); process.exit(2); }

  const pkg = JSON.parse(fs.readFileSync(path.join(opts.repo, 'package.json'), 'utf8'));
  const expectedAppId = pkg.build && pkg.build.appId;
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || '' }); console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  —— ' + detail : ''}`); };

  const asar = loadAsar(asarPath);
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  成品 asar 源码身份核对（shipped == tested？）');
  console.log(`  asar    : ${asarPath}（${fs.statSync(asarPath).size} 字节，${asar.files.length} 条目）`);
  console.log(`  仓库根  : ${opts.repo}`);
  console.log(`  期望 appId: ${expectedAppId || '（缺失）'}`);
  console.log('══════════════════════════════════════════════════════════════════════════════');

  console.log('\n【1】main.js 是否还留有"读被剥离字段"的死路');
  const mainBuf = asar.read('main.js');
  if (!mainBuf) check('asar 内存在 main.js', false);
  else {
    const src = stripComments(mainBuf.toString('utf8'));
    const pkgRequires = (src.match(/require\(['"]\.\/package\.json['"]\)/g) || []).length;
    check('代码里不再 require ./package.json', pkgRequires === 0, `实际 ${pkgRequires} 次（注释不计）`);
    check('代码里不再访问 .build / .scripts / .devDependencies', !/(?:pkg|packageJson|pkgJson)\s*\.\s*(?:build|scripts|devDependencies)\b/.test(src), '');
  }

  console.log('\n【2】app-identity 接线');
  const idBuf = asar.read('app-identity.js');
  check('asar 内存在 app-identity.js', !!idBuf, idBuf ? `${idBuf.length} 字节` : '缺失 —— 打包白名单没覆盖它');
  if (mainBuf) {
    const src = mainBuf.toString('utf8');
    check('main.js require ./app-identity', /require\(['"]\.\/app-identity['"]\)/.test(src));
    check('main.js 调用了 setAppUserModelId', (src.match(/setAppUserModelId/g) || []).length > 0);
  }

  console.log('\n【3】成品内的 appId 字面量');
  if (idBuf) {
    const idSrc = idBuf.toString('utf8');
    check(`app-identity.js 含期望 appId '${expectedAppId}'`, idSrc.includes(`'${expectedAppId}'`) || idSrc.includes(`"${expectedAppId}"`));
    const literals = [...new Set((idSrc.match(/'[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+'/g) || []))];
    check('app-identity.js 未出现第二个 appId 字面量', literals.length <= 1, literals.join(', ') || '无');
  }

  console.log('\n【5】窗口安全边界（从成品 main.js 静态断言）');
  // 为什么要静态断言：sandbox:true 在"页面里有没有 require"上**看不出来** ——
  // contextIsolation 单独就能让页面看不到 Node 全局。所以渲染侧探针只能证明隔离生效，
  // 沙箱是否开启必须回到成品代码本身核对（并配合 settings 探针在 sandbox:true 下的运行证据）。
  if (mainBuf) {
    const src = stripComments(mainBuf.toString('utf8'));
    const sandboxTrue = (src.match(/sandbox:\s*true/g) || []).length;
    const sandboxFalse = (src.match(/sandbox:\s*false/g) || []).length;
    const ctxTrue = (src.match(/contextIsolation:\s*true/g) || []).length;
    const nodeIntegrationFalse = (src.match(/nodeIntegration:\s*false/g) || []).length;
    check('main.js 所有窗口 sandbox:true（无 sandbox:false 残留）', sandboxTrue > 0 && sandboxFalse === 0, `sandbox:true ×${sandboxTrue} / sandbox:false ×${sandboxFalse}`);
    check('main.js 所有窗口 contextIsolation:true', ctxTrue > 0, `×${ctxTrue}`);
    check('main.js 所有窗口 nodeIntegration:false', nodeIntegrationFalse > 0, `×${nodeIntegrationFalse}`);
  }

  console.log('\n【4】闭包内 .js 与仓库源码逐文件 SHA-256 对比');
  const jsFiles = asar.files.filter((f) => f.path.endsWith('.js') && !f.path.startsWith('node_modules/'));
  let same = 0; let diff = 0; let absent = 0;
  for (const f of jsFiles) {
    const srcPath = path.join(opts.repo, ...f.path.split('/'));
    if (!fs.existsSync(srcPath)) { absent++; console.log(`    · ${f.path}（仓库无对应文件，跳过）`); continue; }
    const a = crypto.createHash('sha256').update(asar.read(f.path)).digest('hex');
    const b = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex');
    if (a === b) same++;
    else { diff++; check(`源码一致性 ${f.path}`, false, `asar=${a.slice(0, 12)}… ≠ 仓库=${b.slice(0, 12)}…`); }
  }
  check('闭包内 .js 与仓库源码逐文件一致', diff === 0, `${same} 个一致 / ${diff} 个不一致 / ${absent} 个仓库无对应`);

  asar.close();
  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(`  结论：${failed.length ? `✖ ${failed.length} 项失败` : '✔ 全部通过'}（共 ${checks.length} 项断言）`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify({
      generatedAt: new Date().toISOString(), asar: asarPath, checks, passed: failed.length === 0
    }, null, 2) + '\n');
  }
  process.exit(failed.length ? 1 : 0);
}

main();
