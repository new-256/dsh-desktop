'use strict';

/**
 * 0.3.43 链接安全删除（junction / symlink）回归测试。
 *
 * ## 背景：为什么这个测试必须在 Electron 里跑
 *
 * 官方 owned-directory.ts:19 有一句注释：
 *   "Electron's recursive rm follows nested Windows junctions into installed resources."
 *
 * 我们实测证实了这一点，而且发现**用普通 node 测试会得到假阴性**：
 *
 *   | 运行时                        | fs.rmSync(recursive) 对 junction 目标 |
 *   |-------------------------------|--------------------------------------|
 *   | 独立 node 24.21               | 保留（不跟随）                        |
 *   | Electron 44.3.0（我们的运行时）| **清空（删除链接目标的内容）**         |
 *
 * 所以：**本测试必须用 Electron 跑**，用 node 跑会全绿却什么也没验证。
 * 脚本会自动检测并派发到 Electron；若 Electron 不可用则明确跳过（不假通过）。
 *
 * ## 真实危害
 *
 * 用户机器 `dsh-home\profiles\web\node_modules` 里实测有两个 junction 指向
 * 真实的插件开发目录（含 .git、123 个文件）。我们旧 rimraf 的降级路径
 * （fs.rmSync recursive）在 Electron 下会**删掉这些源码和未提交改动**。
 *
 * 用法：
 *   node scripts/test-043.js           # 自动派发到 Electron
 *   electron -r ... 由脚本自行处理
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const IS_ELECTRON = !!process.versions.electron;

// ── 非 Electron 时：派发到 Electron 重跑 ─────────────────────────────────
if (!IS_ELECTRON) {
  const electronBin = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) {
    console.log('跳过：未找到 Electron（本测试必须用 Electron 运行，用 node 会假通过）');
    console.log('  期望路径: ' + electronBin);
    process.exit(2);
  }
  const r = spawnSync(electronBin, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  process.exit(r.status === null ? 1 : r.status);
}

// ── Electron 环境：真正执行 ─────────────────────────────────────────────

const Module = require('module');
const origResolve = Module._resolveFilename;
const STUB_ID = '\0electron-stub';
const TMP = path.join(os.tmpdir(), 'dsh-043-' + process.pid);

Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
require.cache[STUB_ID] = {
  id: STUB_ID, filename: STUB_ID, loaded: true,
  exports: { app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.3.43-test' } }
};

const mgr = require('../updater-backend.js');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(n) { console.log('\n' + n); }

fs.mkdirSync(TMP, { recursive: true });

/** 造一个"用户源码目录"（模拟真实插件开发目录）。 */
function makeUserSource(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'precious.js'), 'MY UNCOMMITTED WORK');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'deep.js'), 'DEEP');
  return dir;
}

/** 造一个"我们拥有的目录"，内含指向用户源码的 junction（含嵌套层）。 */
function makeOwnedTree(name, sourceDir) {
  const owned = path.join(TMP, name);
  fs.mkdirSync(path.join(owned, 'node_modules', '@local'), { recursive: true });
  fs.mkdirSync(path.join(owned, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(owned, 'regular-file.txt'), 'x');
  fs.writeFileSync(path.join(owned, 'a', 'b', 'c', 'nested-file.txt'), 'y');
  fs.symlinkSync(sourceDir, path.join(owned, 'node_modules', '@local', 'plug'), 'junction');
  fs.symlinkSync(sourceDir, path.join(owned, 'a', 'b', 'c', 'deep-link'), 'junction');
  return owned;
}

function sourceIntact(src) {
  return fs.existsSync(path.join(src, 'precious.js'))
    && fs.existsSync(path.join(src, '.git', 'HEAD'))
    && fs.existsSync(path.join(src, 'sub', 'deep.js'));
}

section('0. 环境确认：Electron 的 fs.rmSync 确实会跟随 junction（危险基线）');
{
  ok(IS_ELECTRON, '本测试运行在 Electron 中（不是 node）');
  ok(!!process.versions.electron, 'Electron 版本: ' + process.versions.electron);

  // 复现危险：这正是我们旧 rimraf 的降级路径
  const src = makeUserSource('baseline-src');
  const owned = makeOwnedTree('baseline-owned', src);
  let threw = null;
  try { fs.rmSync(owned, { recursive: true, force: true }); } catch (e) { threw = e; }
  const intact = sourceIntact(src);
  ok(!intact,
    '基线复现：Electron 下 fs.rmSync(recursive) 会删掉 junction 目标内容 ' +
    '(源码完好=' + intact + ')' + (threw ? ' [抛错 ' + threw.code + ']' : ''));
  // 记录这条基线，用于证明后面的修复有意义
  if (intact) {
    console.log('    ⚠ 注意：本机 Electron 未复现跟随行为，后续断言仍有效但基线不同');
  }
}

section('1. removeOwnedDirectory：绝不进入链接目标');
{
  const src = makeUserSource('safe-src');
  const owned = makeOwnedTree('safe-owned', src);
  const before = JSON.stringify(fs.readdirSync(src, { recursive: true }).sort());

  const r = mgr.removeOwnedDirectory(owned);

  ok(r.removed === true, '我们的目录被完整清理（removed=true）' + (r.reason ? ' [' + r.reason + ']' : ''));
  ok(r.linksUnlinked === 2, '摘除了 2 个链接（实际 ' + r.linksUnlinked + '）');
  ok(!fs.existsSync(owned), '我们的目录树已消失');
  ok(sourceIntact(src), '★ 用户源码文件完好（precious.js / .git / sub）');
  ok(fs.existsSync(path.join(src, '.git', 'HEAD')), '★ 用户 .git 完好（未提交工作未丢失）');
  const after = JSON.stringify(fs.readdirSync(src, { recursive: true }).sort());
  ok(before === after, '★ 用户目录内容与删除前逐项一致');
  ok(!fs.existsSync(path.join(owned, 'node_modules', '@local', 'plug')), '嵌套 junction 已被摘除');
}

section('2. removeOwnedDirectory：边界');
{
  ok(mgr.removeOwnedDirectory(path.join(TMP, 'does-not-exist')).removed === false, '不存在的路径：安全返回（不抛错）');

  // 根自身是链接 → 只摘链接，目标保留
  const src = makeUserSource('rootlink-src');
  const link = path.join(TMP, 'root-is-link');
  fs.symlinkSync(src, link, 'junction');
  const r = mgr.removeOwnedDirectory(link);
  ok(r.removed === true && r.linksUnlinked === 1, '根是链接：只摘链接本身');
  ok(!fs.existsSync(link), '链接已消失');
  ok(sourceIntact(src), '★ 根链接的目标内容完好');

  // 普通文件：不当作目录删除
  const file = path.join(TMP, 'plain.txt');
  fs.writeFileSync(file, 'z');
  const rf = mgr.removeOwnedDirectory(file);
  ok(rf.removed === false, '普通文件：不按目录删除（保守）');
  ok(fs.existsSync(file), '普通文件仍在（未被误删）');

  // 空目录
  const empty = path.join(TMP, 'empty-dir');
  fs.mkdirSync(empty, { recursive: true });
  ok(mgr.removeOwnedDirectory(empty).removed === true, '空目录：正常删除');
}

section('3. rimraf 默认走安全路径');
{
  const src = makeUserSource('rimraf-src');
  const owned = makeOwnedTree('rimraf-owned', src);
  mgr.rimraf(owned);
  ok(!fs.existsSync(owned), 'rimraf 默认清理了目录');
  ok(sourceIntact(src), '★ rimraf 默认不跟随链接（源码完好）');
}
{
  // 对照：显式 followLinks 在 Electron 下确实是危险的（证明默认值选对了）
  const src = makeUserSource('follow-src');
  const owned = makeOwnedTree('follow-owned', src);
  let threw = null;
  try { mgr.rimraf(owned, { followLinks: true }); } catch (e) { threw = e; }
  const intact = sourceIntact(src);
  ok(!fs.existsSync(owned), 'followLinks 路径也清理了目录');
  console.log('    （对照）followLinks=true 下用户源码完好=' + intact +
    (threw ? ' [抛错 ' + threw.code + ']' : ''));
  ok(true, '对照实验完成（用于说明为何默认必须安全）');
}

section('4. 生产代码接线：junction 修复/隔离路径全部走安全删除');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'updater-backend.js'), 'utf8');
  ok(/function removeOwnedDirectory\(target, opts/.test(src), 'removeOwnedDirectory 已定义');
  ok(/function rimraf\(d, opts = \{\}\)/.test(src), 'rimraf 已接受 opts（默认安全）');
  ok(/if \(opts\.followLinks\)/.test(src), '仅显式 followLinks 时才用原生递归删除');
  ok(/★ 核心保证：只摘链接本身，绝不进入目标/.test(src), '安全遍历处有明确注释');
  ok(/result\.linksUnlinked\+\+/.test(src), '统计摘除的链接数');
  ok(/fs\.rmdirSync\(dir\)/.test(src), '递归返回后就地 rmdir（否则 ENOTEMPTY 残树）');

  // 关键调用点必须是安全形态（无 followLinks）
  const callLines = src.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter((x) => /rimraf\(/.test(x.l) && !/function rimraf|rimraf\(safe\)/.test(x.l));
  const unsafe = callLines.filter((x) => /followLinks:\s*true/.test(x.l));
  ok(unsafe.length === 0, '没有任何生产调用点使用 followLinks:true（实际 ' + unsafe.length + ' 处）');
  ok(callLines.length >= 20, 'rimraf 调用点数量合理（' + callLines.length + ' 处）');

  // profiles 相关的高危点必须存在且为安全形态
  // 0.3.48 · H-04：隔离兜底的「整树 rimraf」已被取消（它等于直接删用户数据）。
  // 现在 rename 失败必须走「复制 → 逐项校验 → 才删原树」，删除被占用挡到一半时
  // 用校验过的副本把原树还原。断言随之翻转为「不安全的形态不存在」。
  ok(!/rimraf\(prof\)/.test(src), 'profiles 整树 rimraf 兜底已移除（H-04）');
  ok(/quarantineProfilesByCopy\(prof, targetPath, targetName\)/.test(src), '隔离兜底改为复制+校验（H-04）');
  ok(/restoreLiveTreeFromCopy\(targetPath, prof\)/.test(src), '删除未完成时用校验副本还原原树（H-04）');
  ok(/rimraf\(itemPath\)/.test(src), 'profiles/node_modules 条目删除点存在（junction 修复路径）');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项  （Electron ${process.versions.electron}）`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
