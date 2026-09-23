'use strict';

/**
 * 生成随包分发的**运行时完整性清单** build/payload/vendor-manifest.json。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────────
 * 官方 apps/desktop 的 desktop-runtime.json 给每个文件记 bytes + sha256 +
 * executable，并在启动前用 verifyDesktopRuntime() 全量校验。本地打包器此前
 * 完全没有等价物：安装包里的 payload 分卷一旦损坏/漏拷，或并发解压某个分卷
 * 悄悄少写文件，用户拿到的是「能启动但行为诡异」的后端，排查成本极高。
 *
 * 这里取一个**成本可控的折中**（安装期只花几百毫秒，而不是哈希整个 ~400MB）：
 *   - critical[]：4 个决定「能否启动 / 跑的是哪个版本」的文件，逐字节 sha256；
 *   - parts[]   ：每个 payload 分卷的 bytes + sha256（构建期算一次，安装前可验）；
 *   - totals    ：dsh 树的文件数与字节数（解压是否完整的最强信号）；
 *   - topLevel  ：两棵树的顶层条目名（捕捉「少解压了一整个目录」）；
 *   - versions  ：dsh 版本 + node 版本，用于和期望值对账。
 *
 * 清单里的路径一律是「相对后端根目录」的 POSIX 风格路径（node.exe 在根、
 * dsh 树在 dsh/ 下），与 updater-backend.js 解压后的布局一一对应。
 *
 * 用法：node scripts/write-vendor-manifest.js
 *   也作为模块被 pack-vendor.js 调用（打包后立刻生成，保证分卷哈希有效）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const RUNTIME_DIR = path.join(VENDOR, 'runtime');
const DSH_DIR = path.join(VENDOR, 'dsh');
const OUT_DIR = path.join(ROOT, 'build', 'payload');
const OUT = path.join(OUT_DIR, 'vendor-manifest.json');

const SCHEMA = 1;

/**
 * 关键文件（相对后端根的 POSIX 路径）。挑的都是「缺一个后端就起不来」或者
 * 「能唯一标识后端版本」的文件。
 */
const CRITICAL = [
  'node.exe',
  'node_modules/npm/bin/npm-cli.js',
  'dsh/node_modules/@deepseek-ai/dsh/package.json',
  'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
];

function log(m) { console.log('[vendor-manifest] ' + m); }

// --------------------------------------------------------------------------
// 路径安全（对齐官方 runtime-tree.ts 的 runtimePath 校验）
// --------------------------------------------------------------------------
/**
 * 校验并归一化一个相对路径。拒绝绝对路径、反斜杠、盘符、空段、. 与 ..
 * —— 与官方 runtimePath() 同一条纪律：清单里的路径永远不能逃出后端根目录。
 */
function safeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.includes('\\') || rel.includes(':')) {
    throw new Error(`vendor-manifest: invalid relative path ${JSON.stringify(rel)}`);
  }
  if (rel.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`vendor-manifest: invalid relative path ${JSON.stringify(rel)}`);
  }
  return rel;
}

/** 把清单相对路径解析为本地真实路径。 */
function resolveUnder(root, rel) {
  return path.join(root, ...safeRelPath(rel).split('/'));
}

/** 清单相对路径 → 构建机上的源文件路径（runtime 在 vendor/runtime，dsh 在 vendor/dsh）。 */
function sourcePath(rel) {
  safeRelPath(rel);
  return rel.startsWith('dsh/') ? path.join(VENDOR, ...rel.split('/')) : path.join(RUNTIME_DIR, ...rel.split('/'));
}

// --------------------------------------------------------------------------
// 基础工具
// --------------------------------------------------------------------------
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 递归统计一棵树。`prefix` 是该树在后端根下的挂载点（runtime 为 ''，dsh 为 'dsh'）。
 * 符号链接单独计数：7z 与 fs.cpSync 对链接的处理不同，单独记下来便于事后判断。
 */
function walkTree(dir, prefix, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) { acc.symlinks.push(rel); continue; }
    if (st.isDirectory()) walkTree(full, rel, acc);
    else { acc.files++; acc.bytes += st.size; }
  }
  return acc;
}

function topLevelNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// --------------------------------------------------------------------------
// 清单构建
// --------------------------------------------------------------------------
async function buildManifest() {
  if (!fs.existsSync(path.join(RUNTIME_DIR, 'node.exe'))) {
    throw new Error('vendor/runtime/node.exe 不存在，请先运行 scripts/prepare-runtime.js');
  }
  if (!fs.existsSync(path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error('vendor/dsh 中缺少 @deepseek-ai/dsh，请先运行 scripts/install-backend.js');
  }

  const dshPkg = readJson(path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  const dshVersion = dshPkg && dshPkg.version ? dshPkg.version : null;
  if (!dshVersion) throw new Error('无法从 vendor/dsh 读出 @deepseek-ai/dsh 版本。');

  let nodeVersion = null;
  try {
    nodeVersion = execFileSync(path.join(RUNTIME_DIR, 'node.exe'), ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '');
  } catch (err) {
    log('警告：无法执行 vendor/runtime/node.exe 获取版本（' + err.message + '），nodeVersion 记为 null。');
  }

  // 关键文件哈希
  const critical = [];
  for (const rel of CRITICAL) {
    const abs = sourcePath(rel);
    if (!fs.existsSync(abs)) throw new Error(`关键文件缺失，无法生成清单：${rel}（期望位于 ${abs}）`);
    const st = fs.statSync(abs);
    critical.push({ path: safeRelPath(rel), bytes: st.size, sha256: await sha256File(abs) });
  }

  // 两棵树的规模
  const runtimeAcc = walkTree(RUNTIME_DIR, '', { files: 0, bytes: 0, symlinks: [] });
  const dshAcc = walkTree(DSH_DIR, 'dsh', { files: 0, bytes: 0, symlinks: [] });

  // payload 分卷（若有）—— 安装前可用来验「分卷有没有被拷坏」
  const parts = [];
  if (fs.existsSync(OUT_DIR)) {
    const names = fs.readdirSync(OUT_DIR).filter((n) => /^vendor-\d+\.7z$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    for (const name of names) {
      const abs = path.join(OUT_DIR, name);
      parts.push({ file: name, bytes: fs.statSync(abs).size, sha256: await sha256File(abs) });
    }
  }

  const manifest = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    dshVersion,
    nodeVersion,
    parts,
    totals: {
      runtime: { files: runtimeAcc.files, bytes: runtimeAcc.bytes, symlinks: runtimeAcc.symlinks.length },
      dsh: { files: dshAcc.files, bytes: dshAcc.bytes, symlinks: dshAcc.symlinks.length }
    },
    topLevel: {
      runtime: topLevelNames(RUNTIME_DIR),
      dsh: topLevelNames(DSH_DIR)
    },
    critical
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');

  log(`dsh=${dshVersion} node=${nodeVersion || '未知'} parts=${parts.length}`);
  log(`files: runtime=${runtimeAcc.files} dsh=${dshAcc.files}（合计 ${runtimeAcc.files + dshAcc.files}）`);
  if (runtimeAcc.symlinks.length || dshAcc.symlinks.length) {
    log(`注意：存在符号链接 runtime=${runtimeAcc.symlinks.length} dsh=${dshAcc.symlinks.length}`);
  }
  log(`written: ${OUT} (${fs.statSync(OUT).size} bytes)`);
  return manifest;
}

module.exports = { buildManifest, OUT, CRITICAL };

if (require.main === module) {
  buildManifest().catch((err) => {
    console.error('[vendor-manifest] 生成失败：' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
