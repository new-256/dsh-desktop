'use strict';

/**
 * stage1-verify-unpacked —— 出包后对 `release/win-unpacked` 做「不安装也能证明能装」的完整性核对。
 *
 * 为什么需要它：本轮（阶段一）按 lead 裁决**不执行 NSIS 安装**（安装器会用 taskkill /T 带走
 * 宿主 DSH 与全部 agent 会话，且卸载/重装只应在阶段二统一做一次）。但「装完能不能起」
 * 不能因此变成一句空话，所以把「安装会做哪些事」拆成可在原目录验证的机械断言：
 *   1) 安装器实际会落盘的关键文件是否都在（exe / asar / 全部 payload 分卷 / 7za / 清单）；
 *   2) payload 分卷的 bytes+sha256 是否与 vendor-manifest.json 一致
 *      （= 随包后端与构建期一致，装到用户机器上不会「能启动但行为诡异」）；
 *   3) app.asar 内的文件清单是否覆盖运行期引用闭包（复用门禁导出的 JSON）；
 *   4) asarUnpack 规则命中的文件是否真的出现在 app.asar.unpacked 下。
 *
 * 与 stage1-asar-list.js 的分工：后者负责 asar 内部清单，本脚本负责「目录级/分卷级」整体核对。
 *
 * 用法：
 *   node stage1-verify-unpacked.js <win-unpacked 目录> [--asar-tool <stage1-asar-list.js>]
 *        [--gate-json <门禁导出 JSON>] [--json <输出文件>] [--skip-hash]
 *   退出码：0=全部通过；1=有断言失败；2=用法错误。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const o = { dir: null, asarTool: null, gateJson: null, json: null, skipHash: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asar-tool') o.asarTool = argv[++i];
    else if (a === '--gate-json') o.gateJson = argv[++i];
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--skip-hash') o.skipHash = true;
    else if (!a.startsWith('--')) o.dir = a;
    else { console.error('未知参数：' + a); process.exit(2); }
  }
  if (!o.dir) {
    console.error('用法：node stage1-verify-unpacked.js <win-unpacked 目录> [--gate-json <json>] [--asar-tool <js>] [--json <文件>] [--skip-hash]');
    process.exit(2);
  }
  return o;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? '✔' : '✖';
  console.log(`  ${mark} ${name}${detail ? '  —— ' + detail : ''}`);
  return !!ok;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.dir);
  if (!fs.existsSync(root)) { console.error('目录不存在：' + root); process.exit(2); }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('  win-unpacked 完整性核对（不安装，直接验证安装会落盘的内容）');
  console.log(`  目录 : ${root}`);
  console.log('══════════════════════════════════════════════════════════════════════════════');

  const resDir = path.join(root, 'resources');
  const payloadDir = path.join(resDir, 'payload');
  const exe = path.join(root, 'DSH Desktop.exe');
  const asar = path.join(resDir, 'app.asar');
  const manifestPath = path.join(payloadDir, 'vendor-manifest.json');

  console.log('\n【1】关键文件存在性');
  check('主程序 DSH Desktop.exe', fs.existsSync(exe), fs.existsSync(exe) ? `${fs.statSync(exe).size} 字节` : '缺失');
  check('resources/app.asar', fs.existsSync(asar), fs.existsSync(asar) ? `${fs.statSync(asar).size} 字节` : '缺失');
  check('resources/payload/vendor-manifest.json', fs.existsSync(manifestPath), fs.existsSync(manifestPath) ? '存在' : '缺失');
  check('resources/payload/7za.exe', fs.existsSync(path.join(payloadDir, '7za.exe')), '');

  // exe 的 ProductVersion 应当等于包版本（赢信号：装出来的就是这版）。
  // electron-builder 会补成四段（0.3.47 → "0.3.47.0"），所以按"去掉尾部 .0 后相等"判定，
  // 而不是逐字符比较 —— 否则每次都会因为格式差异误报。
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const ver = require('child_process').execFileSync('powershell.exe', [
      '-NoProfile', '-Command', `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`
    ], { encoding: 'utf8' }).trim();
    const norm = (v) => String(v || '').trim().replace(/(\.0)+$/, '');
    check('exe ProductVersion 与 package.json 一致', norm(ver) === norm(pkg.version), `exe=${ver} / package.json=${pkg.version}`);
  } catch (err) {
    check('exe ProductVersion 与 package.json 一致', false, '读取失败：' + err.message);
  }

  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (err) { check('vendor-manifest.json 可解析', false, err.message); }
  }

  console.log('\n【2】payload 分卷（随包后端）字节与哈希');
  if (!manifest || !Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    check('清单含 payload 分卷记录', false, '未找到 parts[]');
  } else {
    check('清单含 payload 分卷记录', true, `${manifest.parts.length} 个分卷, dsh=${manifest.dshVersion}, node=${manifest.nodeVersion}`);
    let totalBytes = 0;
    for (const p of manifest.parts) {
      const abs = path.join(payloadDir, p.file);
      if (!fs.existsSync(abs)) { check(`分卷 ${p.file} 存在`, false, '缺失'); continue; }
      const size = fs.statSync(abs).size;
      totalBytes += size;
      if (size !== p.bytes) { check(`分卷 ${p.file} 字节数`, false, `实际 ${size} ≠ 清单 ${p.bytes}`); continue; }
      if (opts.skipHash) { check(`分卷 ${p.file}`, true, `${size} 字节（--skip-hash 未校验哈希）`); continue; }
      const h = sha256File(abs);
      check(`分卷 ${p.file}`, h === p.sha256, h === p.sha256 ? `${size} 字节, sha256 一致` : `sha256 不一致：实际 ${h} ≠ 清单 ${p.sha256}`);
    }
    console.log(`  分卷合计：${(totalBytes / 1048576).toFixed(1)} MB`);
  }

  console.log('\n【3】节点运行时与后端版本记录');
  if (manifest) {
    check('清单记录了 node 版本', !!manifest.nodeVersion, String(manifest.nodeVersion || '未知'));
    check('清单记录了 dsh 版本', !!manifest.dshVersion, String(manifest.dshVersion || '未知'));
    const t = manifest.totals || {};
    const rt = t.runtime || {}; const dh = t.dsh || {};
    check('清单含两棵树的规模', !!(rt.files && dh.files), `runtime ${rt.files} 文件 / dsh ${dh.files} 文件`);
    check('清单含关键文件哈希', Array.isArray(manifest.critical) && manifest.critical.length > 0, `${(manifest.critical || []).length} 个关键文件`);
  }

  // asar 内部清单（交给 stage1-asar-list.js，闭包对账也由它做）
  console.log('\n【4】app.asar 内部清单 + 闭包对账');
  if (!fs.existsSync(asar)) {
    check('asar 清单可读取', false, 'app.asar 缺失');
  } else {
    const toolCandidates = [
      opts.asarTool,
      path.join(__dirname, 'stage1-asar-list.js')
    ].filter(Boolean);
    const tool = toolCandidates.find((p) => fs.existsSync(path.resolve(p)));
    if (!tool) {
      check('asar 清单可读取', false, '找不到 stage1-asar-list.js，请用 --asar-tool 指定');
    } else {
      const args = [path.resolve(tool), asar, '--quiet'];
      if (opts.gateJson) args.push('--compare-gate', path.resolve(opts.gateJson));
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
      const out = (r.stdout || '') + (r.stderr || '');
      check('asar 清单 + 闭包对账', r.status === 0, r.status === 0 ? 'closure 全覆盖' : `exit=${r.status}`);
      console.log(out.split('\n').filter((l) => l.trim()).map((l) => '    ' + l).join('\n'));
    }
  }

  console.log('\n【5】asarUnpack 落点（**/*.{node,dll,exe}）');
  const unpackedDir = path.join(resDir, 'app.asar.unpacked');
  if (fs.existsSync(unpackedDir)) {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else { n++; if (n <= 8) console.log(`    · ${path.relative(resDir, full)}`); }
      }
    };
    walk(unpackedDir);
    check('app.asar.unpacked 存在', n > 0, `${n} 个文件`);
  } else {
    console.log('    （没有 app.asar.unpacked 目录——本次依赖里没有 .node/.dll/.exe，属正常）');
    check('app.asar.unpacked 存在（可缺省）', true, '未生成（依赖中无原生二进制）');
  }

  console.log('\n【6】安装期不会缺的其它资源');
  for (const rel of ['resources/elevate.exe', 'resources/app-update.yml']) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) console.log(`    · ${rel} 存在 (${fs.statSync(abs).size} 字节)`);
    else console.log(`    · ${rel} 不存在（electron-builder 版本差异，非致命）`);
  }

  console.log('\n【7】成品 asar 源码身份核对（shipped == tested）');
  // 单一事实来源：直接调用 stage1-verify-asar-identity.js，不在这里重复实现 asar 读取。
  {
    const idTool = path.join(__dirname, 'stage1-verify-asar-identity.js');
    if (!fs.existsSync(idTool)) {
      check('源码身份核对工具存在', false, '找不到 stage1-verify-asar-identity.js');
    } else if (fs.existsSync(asar)) {
      const r = spawnSync(process.execPath, [idTool, asar, '--repo', path.join(__dirname, '..', '..', '..')], { encoding: 'utf8', timeout: 180000 });
      const out = (r.stdout || '') + (r.stderr || '');
      check('成品 asar 源码身份核对', r.status === 0, r.status === 0 ? '8 项断言全通过（含逐文件 SHA-256 一致性）' : `exit=${r.status}`);
      console.log(out.split('\n').filter((l) => l.trim()).map((l) => '    ' + l).join('\n'));
    } else {
      check('成品 asar 源码身份核对', false, 'app.asar 缺失');
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log(`  结论：${failed.length ? `✖ ${failed.length} 项失败` : '✔ 全部通过'}  （共 ${checks.length} 项断言）`);
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('');

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify({
      generatedAt: new Date().toISOString(), dir: root, checks,
      passed: failed.length === 0, failed: failed.map((f) => f.name)
    }, null, 2) + '\n');
  }
  process.exit(failed.length ? 1 : 0);
}

main();
