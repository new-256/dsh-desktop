'use strict';

/**
 * vendor-manifest.json 完整性校验的针对性测试。
 *
 * 这些断言覆盖「安装包 payload 损坏 / 解压不完整 / 版本错配」这三类真实故障，
 * 以及清单路径的越界防护（对齐官方 runtime-tree.ts 的 runtimePath 纪律）。
 *
 * 不依赖真实 vendor 树、不联网、不触碰用户目录：在系统临时目录里造一棵
 * 微型「已解压后端」，按 write-vendor-manifest.js 的格式生成清单，再逐项破坏
 * 并断言校验器确实报错。
 *
 * 用法：node scripts/test-manifest-verify.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

// ── 用桩模块替换 electron，让 updater-backend.js 能在纯 Node 下被加载 ──────
const STUB_ID = '\0electron-stub';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
require.cache[STUB_ID] = {
  id: STUB_ID,
  filename: STUB_ID,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => os.tmpdir() } }
};

const mgr = require('../updater-backend.js');
const { verifyPayloadParts, verifyVendorManifest, manifestPath, countTree } = mgr;

// ── 断言框架 ───────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }

// ── 造一棵微型「已解压后端」 ───────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-manifest-test-'));
const ROOT = path.join(TMP, 'backend');
const PAYLOAD = path.join(TMP, 'payload');

function put(rel, content) {
  const abs = path.join(ROOT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const CRITICAL = [
  'node.exe',
  'node_modules/npm/bin/npm-cli.js',
  'dsh/node_modules/@deepseek-ai/dsh/package.json',
  'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
];
const DSH_VERSION = '9.9.9-test';

put('node.exe', 'FAKE-NODE-BINARY');
put('node_modules/npm/bin/npm-cli.js', '#!/usr/bin/env node\nrequire("../lib/cli.js")(process)\n');
put('node_modules/npm/lib/cli.js', '// npm cli body');
put('dsh/package.json', JSON.stringify({ name: 'dsh-desktop-backend' }));
put('dsh/node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION }));
put('dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', '// dsh bin');
put('dsh/node_modules/other/index.js', '// other dep');
put('dsh/sub/deep/leaf.txt', 'leaf');
put('node_modules/corepack/dist/corepack.js', '// corepack');

const PART_A = 'PART-A-BYTES';
const PART_B = 'PART-B-BYTES';
fs.mkdirSync(PAYLOAD, { recursive: true });
fs.writeFileSync(path.join(PAYLOAD, 'vendor-0.7z'), PART_A);
fs.writeFileSync(path.join(PAYLOAD, 'vendor-1.7z'), PART_B);

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function topLevelNames(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name).sort();
}
function walkTree(dir, prefix, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) { acc.symlinks++; continue; }
    if (st.isDirectory()) walkTree(full, rel, acc);
    else { acc.files++; acc.bytes += st.size; }
  }
  return acc;
}

function makeManifest() {
  const critical = CRITICAL.map((rel) => {
    const abs = path.join(ROOT, ...rel.split('/'));
    return { path: rel, bytes: fs.statSync(abs).size, sha256: sha256File(abs) };
  });
  const runtimeAcc = walkTree(path.join(ROOT, 'node_modules'), '', { files: 0, bytes: 0, symlinks: 0 });
  const dshAcc = walkTree(path.join(ROOT, 'dsh'), 'dsh', { files: 0, bytes: 0, symlinks: 0 });
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    dshVersion: DSH_VERSION,
    nodeVersion: '24.4.0',
    parts: ['vendor-0.7z', 'vendor-1.7z'].map((f) => {
      const abs = path.join(PAYLOAD, f);
      return { file: f, bytes: fs.statSync(abs).size, sha256: sha256File(abs) };
    }),
    totals: {
      runtime: { files: runtimeAcc.files, bytes: runtimeAcc.bytes, symlinks: 0 },
      dsh: { files: dshAcc.files, bytes: dshAcc.bytes, symlinks: 0 }
    },
    topLevel: {
      // runtime 顶层 = 后端根下除 dsh/ 以外的条目
      runtime: topLevelNames(ROOT).filter((n) => n !== 'dsh'),
      dsh: topLevelNames(path.join(ROOT, 'dsh'))
    },
    critical
  };
}

// p 对象只需满足校验函数用到的字段
function makeP() {
  return {
    root: ROOT,
    dshDir: path.join(ROOT, 'dsh'),
    nodeExe: path.join(ROOT, 'node.exe'),
    npmDir: path.join(ROOT, 'node_modules', 'npm'),
    dshBin: path.join(ROOT, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    dshPkg: path.join(ROOT, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    seedPayloadDir: PAYLOAD
  };
}

const baseline = makeManifest();

// ─────────────────────────────────────────────────────────────────────────
section('1. 正常路径：清单与树一致 → 通过');
{
  const p = makeP();
  const pre = verifyPayloadParts(p, baseline);
  ok(pre.ok === true, '分卷校验通过');
  ok(pre.checked === 2, `分卷校验项数正确（checked=${pre.checked}）`);
  const post = verifyVendorManifest(p, baseline);
  ok(post.ok === true, '落地树校验通过' + (post.ok ? '' : `（${post.reason}）`));
  ok(post.checked >= 10, `校验项数合理（checked=${post.checked}）`);
}

section('2. 旧安装包兼容：无清单 → 跳过（不阻塞启动）');
{
  const p = makeP();
  const empty = { parts: [], topLevel: {}, totals: {}, critical: [] };
  const pre = verifyPayloadParts(p, empty);
  ok(pre.ok === true && pre.checked === 0, '空清单的分卷校验视为跳过');
  const post = verifyVendorManifest(p, empty);
  ok(post.ok === true, '空清单的落地校验视为跳过');
}

section('3. 分卷损坏：大小不符 / 校验和不符 / 缺失 / 非法名');
{
  const p = makeP();

  const mSize = JSON.parse(JSON.stringify(baseline));
  mSize.parts[0].bytes = 999999;
  const r1 = verifyPayloadParts(p, mSize);
  ok(r1.ok === false && /大小不符/.test(r1.reason), '分卷大小不符被拦下：' + r1.reason);

  const mHash = JSON.parse(JSON.stringify(baseline));
  mHash.parts[1].sha256 = 'deadbeef'.repeat(8);
  const r2 = verifyPayloadParts(p, mHash);
  ok(r2.ok === false && /校验和不符/.test(r2.reason), '分卷校验和不符被拦下：' + r2.reason);

  const mMissing = JSON.parse(JSON.stringify(baseline));
  mMissing.parts.push({ file: 'vendor-9.7z', bytes: 1, sha256: 'x' });
  const r3 = verifyPayloadParts(p, mMissing);
  ok(r3.ok === false && /缺少分卷/.test(r3.reason), '分卷缺失被拦下：' + r3.reason);

  const mEvil = JSON.parse(JSON.stringify(baseline));
  mEvil.parts.push({ file: '../../etc/passwd', bytes: 1 });
  const r4 = verifyPayloadParts(p, mEvil);
  ok(r4.ok === false && /非法/.test(r4.reason), '分卷名越界被拦下：' + r4.reason);
}

section('4. 落地树损坏：关键文件缺失 / 内容不符 / 顶层目录缺失');
{
  const p = makeP();

  const mMissing = JSON.parse(JSON.stringify(baseline));
  mMissing.critical.push({ path: 'dsh/missing-file.js', bytes: 1, sha256: 'a'.repeat(64) });
  const r1 = verifyVendorManifest(p, mMissing);
  ok(r1.ok === false && /缺少关键文件/.test(r1.reason), '关键文件缺失被拦下：' + r1.reason);

  const mHash = JSON.parse(JSON.stringify(baseline));
  mHash.critical[0].sha256 = 'b'.repeat(64);
  const r2 = verifyVendorManifest(p, mHash);
  ok(r2.ok === false && /校验和不符/.test(r2.reason), '关键文件哈希不符被拦下：' + r2.reason);

  const mSize = JSON.parse(JSON.stringify(baseline));
  mSize.critical[0].bytes = fs.statSync(path.join(ROOT, 'node.exe')).size + 1;
  const r3 = verifyVendorManifest(p, mSize);
  ok(r3.ok === false && /大小不符/.test(r3.reason), '关键文件大小不符被拦下：' + r3.reason);

  const mTop = JSON.parse(JSON.stringify(baseline));
  mTop.topLevel.dsh.push('node_modules_missing');
  const r4 = verifyVendorManifest(p, mTop);
  ok(r4.ok === false && /缺少顶层条目/.test(r4.reason), '顶层条目缺失被拦下：' + r4.reason);
}

section('5. 解压不完整：dsh 树文件数/字节数对账');
{
  const p = makeP();

  const mCount = JSON.parse(JSON.stringify(baseline));
  mCount.totals.dsh.files += 1;
  const r1 = verifyVendorManifest(p, mCount);
  ok(r1.ok === false && /规模不符/.test(r1.reason), '文件数不符被拦下：' + r1.reason);

  const mBytes = JSON.parse(JSON.stringify(baseline));
  mBytes.totals.dsh.bytes += 1024;
  const r2 = verifyVendorManifest(p, mBytes);
  ok(r2.ok === false && /规模不符/.test(r2.reason), '字节数不符被拦下：' + r2.reason);
}

section('6. 版本错配：清单 dsh 版本 ≠ 实际 package.json 版本');
{
  const p = makeP();
  const mVer = JSON.parse(JSON.stringify(baseline));
  mVer.dshVersion = '0.1.7-alpha.2'; // 实际是 9.9.9-test
  const r = verifyVendorManifest(p, mVer);
  ok(r.ok === false && /版本不符/.test(r.reason), '版本错配被拦下：' + r.reason);
}

section('7. 清单路径越界防护（对齐官方 runtimePath 纪律）');
{
  const illegal = ['', '/abs/x', 'C:/x', 'a\\b', 'a/../b', '../x', 'a//b', 'a/./b'];
  for (const rel of illegal) {
    ok(manifestPath(ROOT, rel) === null, `拒绝非法路径 ${JSON.stringify(rel)}`);
  }
  const legal = ['node.exe', 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'];
  for (const rel of legal) {
    ok(typeof manifestPath(ROOT, rel) === 'string', `接受合法路径 ${JSON.stringify(rel)}`);
  }

  const mEvil = JSON.parse(JSON.stringify(baseline));
  mEvil.critical.push({ path: '../../../windows/system32/x.dll', bytes: 1 });
  const r = verifyVendorManifest(makeP(), mEvil);
  ok(r.ok === false && /路径非法/.test(r.reason), '清单内越界路径被拦下：' + r.reason);
}

section('8. countTree 与构建期统计口径一致（跳过符号链接）');
{
  const got = countTree(path.join(ROOT, 'dsh'));
  ok(got.files === baseline.totals.dsh.files, `文件数一致（${got.files}）`);
  ok(got.bytes === baseline.totals.dsh.bytes, `字节数一致（${got.bytes}）`);
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
