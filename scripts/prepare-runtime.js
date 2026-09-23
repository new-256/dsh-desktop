'use strict';

/**
 * 准备随包分发的、**DSH 专用**的 Node 运行时 vendor/runtime。
 *
 * 它是一个完整、自包含的 Node 安装前缀（与系统 Node 互不干扰）：
 *   node.exe
 *   npm.cmd / npx.cmd / corepack.cmd        （Windows shim）
 *   node_modules/npm                        （npm）
 *   node_modules/corepack                   （corepack，承载 pnpm/yarn shim）
 *
 * 桌面版运行时会把该目录放到 PATH 最前，并把 npm/pnpm/corepack 的缓存、前缀、
 * 配置全部指向 DSH 专用目录，因此 dsh 及其任何子进程（npm/pnpm 安装插件等）
 * 都只使用这套运行时，不会读取系统 Node 或用户全局 npm 环境，避免版本错配。
 *
 * ── 版本来源（本次改动的核心）────────────────────────────────────────────
 * 旧实现用 findSystemNodeDir() + robocopy 直接复制**构建机上的系统 Node**：
 * 构建机装什么版本就打包什么版本，产物不可复现，也没法在运行时清单里断言
 * 版本。现在改为**固定版本**：
 *   1) vendor/runtime 已有且版本 === 固定版本 → 复用；
 *   2) 否则下载官方 win-x64 zip（先 npmmirror，再 nodejs.org），用捆绑的
 *      7za 解压（zip 内顶层是 node-v<ver>-win-x64/，解完把内容上提一层）；
 *   3) 下载不可用时，仅当显式设置 DSH_RUNTIME_FROM_SYSTEM=1 才回退复制系统
 *      Node，并打印醒目告警 —— 那条路径产物不可复现，不该是默认行为。
 *
 * 固定版本必须与 updater-backend.js 的 PINNED_NODE_MAJOR 同主版本：
 * 运行时按主版本判断「活跃 Node 是否满足要求」，跨主版本会被判为需要重下。
 *
 * ── 环境变量 ──────────────────────────────────────────────────────────────
 *   DSH_RUNTIME_VERSION       固定版本，默认 24.4.0
 *   DSH_RUNTIME_FROM_SYSTEM   1 = 允许回退复制系统 Node（不可复现）
 *   DSH_RUNTIME_KEEP_ZIP      1 = 保留下载的 zip 到 build/cache
 *   DSH_RUNTIME_MIRROR        覆盖下载基址
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'vendor', 'runtime');
const SEVEN_ZA = path.join(ROOT, 'build', 'tools', '7za.exe');
const CACHE_DIR = path.join(ROOT, 'build', 'cache');
const MARKER = path.join(RUNTIME, '.runtime-ready');

/** 固定版本：与 updater-backend.js 的 PINNED_NODE_MAJOR=24 对齐。 */
const PINNED_NODE_VERSION = (process.env.DSH_RUNTIME_VERSION || '24.4.0').trim();
const PINNED_NODE_MAJOR = parseInt(PINNED_NODE_VERSION.split('.')[0], 10);
/** 与 updater-backend.js 的 FALLBACK_MIN_NODE 保持一致。 */
const MIN_NODE = '22.15.0';

const MIRRORS = [
  'https://cdn.npmmirror.com/binaries/node',
  'https://nodejs.org/dist'
];

function log(m) { console.log('[prepare-runtime] ' + m); }
function warn(m) { console.warn('[prepare-runtime] ⚠ ' + m); }

// --------------------------------------------------------------------------
// 版本工具
// --------------------------------------------------------------------------
function parseVersion(v) {
  return String(v || '').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
}
function compareVersion(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}
function meetsMin(v) { return !!v && compareVersion(v, MIN_NODE) >= 0; }

function nodeExeVersion(nodeExe) {
  try {
    return execFileSync(nodeExe, ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '') || null;
  } catch {
    return null;
  }
}

function hasNpm() {
  return fs.existsSync(path.join(RUNTIME, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
}

function readMarker() {
  try { return fs.readFileSync(MARKER, 'utf8'); } catch { return ''; }
}

/**
 * 判断现有 vendor/runtime 能否复用。
 * 旧标记只是一个时间戳，无法判断版本；新标记记录 node= / source=，据此比对。
 */
function reuseDecision() {
  const nodeExe = path.join(RUNTIME, 'node.exe');
  if (!fs.existsSync(nodeExe)) return { reuse: false, reason: 'vendor/runtime/node.exe 不存在' };
  if (!hasNpm()) return { reuse: false, reason: 'vendor/runtime 缺少 npm（node_modules/npm/bin/npm-cli.js）' };

  const actual = nodeExeVersion(nodeExe);
  if (!actual) return { reuse: false, reason: 'vendor/runtime/node.exe 无法执行' };
  if (!meetsMin(actual)) return { reuse: false, reason: `现有 Node v${actual} 低于最低要求 ${MIN_NODE}` };
  if (actual !== PINNED_NODE_VERSION) {
    return { reuse: false, reason: `现有 Node v${actual} ≠ 固定版本 v${PINNED_NODE_VERSION}` };
  }
  const marker = readMarker();
  if (!marker.includes(`node=${actual}`)) {
    return {
      reuse: true,
      reason: `版本相符（v${actual}），但标记缺失/过期（标记内容：${marker.trim().split('\n')[0] || '空'}）`,
      actual
    };
  }
  return { reuse: true, reason: `版本相符（v${actual}，${(marker.match(/source=(\S+)/) || [])[1] || '来源未知'}）`, actual };
}

// --------------------------------------------------------------------------
// 下载 / 解压
// --------------------------------------------------------------------------
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) { reject(new Error('重定向过多：' + url)); return; }
    https.get(url, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        download(next, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error(`HTTP ${code} ${url}`)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      const out = fs.createWriteStream(dest);
      let got = 0;
      let lastLog = 0;
      res.on('data', (chunk) => {
        got += chunk.length;
        const now = Date.now();
        if (now - lastLog > 2000) {
          lastLog = now;
          const pct = total ? ` ${((got / total) * 100).toFixed(1)}%` : '';
          log(`  下载中 ${(got / 1048576).toFixed(1)} MB${total ? ' / ' + (total / 1048576).toFixed(1) + ' MB' : ''}${pct}`);
        }
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => out.close(() => resolve({ bytes: got })));
    }).on('error', reject);
  });
}

/**
 * 下载并解压官方 Node win-x64 zip 到 vendor/runtime。
 * zip 内顶层目录是 node-v<ver>-win-x64/，解完需要把内容上提一层，
 * 使 vendor/runtime 本身就是 Node 前缀（与旧 robocopy 布局完全一致）。
 */
async function fetchRuntime() {
  if (!fs.existsSync(SEVEN_ZA)) {
    throw new Error(`缺少捆绑的 7za.exe：${SEVEN_ZA}（zip 解压需要它）`);
  }
  const zipName = `node-v${PINNED_NODE_VERSION}-win-x64.zip`;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, zipName);

  // 缓存命中：避免反复下载（构建机上 30+ MB 也不该每次重下）。
  const cachedOk = fs.existsSync(zipPath) && fs.statSync(zipPath).size > 10 * 1048576;
  if (cachedOk) {
    log(`复用已缓存的 ${zipName}（${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB）`);
  } else {
    const bases = process.env.DSH_RUNTIME_MIRROR ? [process.env.DSH_RUNTIME_MIRROR] : MIRRORS;
    let lastErr = null;
    for (const base of bases) {
      const url = `${base}/v${PINNED_NODE_VERSION}/${zipName}`;
      try {
        log(`下载 ${url}`);
        const started = Date.now();
        const { bytes } = await download(url, zipPath + '.part');
        fs.renameSync(zipPath + '.part', zipPath);
        log(`下载完成：${(bytes / 1048576).toFixed(1)} MB，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        try { fs.unlinkSync(zipPath + '.part'); } catch {}
        warn(`镜像失败（${base}）：${err.message}`);
      }
    }
    if (lastErr) throw new Error(`所有镜像都下载失败，最后一个错误：${lastErr.message}`);
  }

  // 解压到暂存目录，再把顶层目录内容上提
  const stage = path.join(ROOT, 'vendor', '.runtime-stage');
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(stage, { recursive: true });
  log('解压 zip …');
  execFileSync(SEVEN_ZA, ['x', zipPath, '-aoa', '-mmt=on', '-o' + stage], { stdio: 'ignore' });

  const inner = fs.readdirSync(stage).find((n) => {
    try { return fs.statSync(path.join(stage, n)).isDirectory(); } catch { return false; }
  });
  if (!inner) throw new Error('解压结果里找不到顶层目录（zip 结构异常）');
  const innerDir = path.join(stage, inner);
  if (!fs.existsSync(path.join(innerDir, 'node.exe'))) {
    throw new Error(`解压结果里没有 node.exe（顶层目录 ${inner}）`);
  }

  // 上提：先清掉旧运行时，再逐项 move（同卷 rename，快）
  try { fs.rmSync(RUNTIME, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (const name of fs.readdirSync(innerDir)) {
    fs.renameSync(path.join(innerDir, name), path.join(RUNTIME, name));
  }
  fs.rmSync(stage, { recursive: true, force: true });

  if (!process.env.DSH_RUNTIME_KEEP_ZIP) {
    try { fs.unlinkSync(zipPath); } catch {}
  }
  return { source: 'download', zipName };
}

// --------------------------------------------------------------------------
// 回退：复制系统 Node（不可复现，仅显式开启）
// --------------------------------------------------------------------------
function findSystemNodeDir() {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs')
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(path.join(c, 'node.exe'))) return c; } catch {} }
  try {
    const p = execSync('where node.exe', { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (p && fs.existsSync(p)) return path.dirname(p);
  } catch {}
  return null;
}

function copyFromSystem() {
  const nodeDir = findSystemNodeDir();
  if (!nodeDir) throw new Error('未找到系统 Node 安装目录。');
  const nodeExe = path.join(nodeDir, 'node.exe');
  const ver = nodeExeVersion(nodeExe);
  const major = ver ? parseVersion(ver)[0] : 0;
  if (major < 22) throw new Error(`DSH 需要 Node >= ${MIN_NODE}（检测到 v${ver || '未知'}）。`);
  warn(`回退复制系统 Node：${nodeDir}（v${ver}）`);
  warn('这条路径产出的运行时版本取决于构建机，**不可复现**，也不满足固定版本断言。');
  warn(`如需可复现产物，请修复网络后重跑（固定版本 v${PINNED_NODE_VERSION}）。`);
  try { fs.rmSync(RUNTIME, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(RUNTIME, { recursive: true });
  try {
    execSync(`robocopy "${nodeDir}" "${RUNTIME}" /E /NFL /NDL /NJH /NJS /NP /XD .git`, { stdio: 'ignore' });
  } catch { /* robocopy 成功也返回非 0 */ }
  return { source: 'system-copy', nodeDir, version: ver };
}

// --------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(RUNTIME, { recursive: true });

  const force = process.env.DSH_RUNTIME_FORCE === '1';
  if (!force) {
    const d = reuseDecision();
    if (d.reuse) {
      log('专用运行时已就绪，复用：' + d.reason);
      // 标记缺失/过期时补齐，保证 vendor/runtime 自述版本始终可读。
      if (!readMarker().includes(`node=${d.actual}`)) {
        writeMarker({ actual: d.actual, npmVer: null, source: 'reused' });
      }
      return;
    }
    log('需要重新准备运行时：' + d.reason);
  } else {
    log('DSH_RUNTIME_FORCE=1：强制重新准备运行时。');
  }

  let result = null;
  try {
    result = await fetchRuntime();
  } catch (err) {
    warn('下载官方运行时失败：' + err.message);
    if (process.env.DSH_RUNTIME_FROM_SYSTEM === '1') {
      result = copyFromSystem();
    } else {
      throw new Error(
        '无法获取固定的 Node 运行时，已中止（以免打包出不可复现的产物）。\n' +
        '  可选处理：\n' +
        '   1) 检查网络 / 设 DSH_RUNTIME_MIRROR=<镜像基址> 后重试；\n' +
        '   2) 若确实要用构建机的系统 Node，显式设 DSH_RUNTIME_FROM_SYSTEM=1（产物不可复现）。\n' +
        `  原始错误：${err.message}`
      );
    }
  }

  // ── 断言：运行时必须存在、可执行、版本正确 ────────────────────────────────
  const nodeExe = path.join(RUNTIME, 'node.exe');
  if (!fs.existsSync(nodeExe)) throw new Error('运行时准备失败：vendor/runtime/node.exe 不存在。');
  const actual = nodeExeVersion(nodeExe);
  if (!actual) throw new Error('运行时准备失败：vendor/runtime/node.exe 无法执行。');
  if (!meetsMin(actual)) throw new Error(`运行时准备失败：Node v${actual} 低于最低要求 ${MIN_NODE}。`);
  if (result.source === 'download' && actual !== PINNED_NODE_VERSION) {
    throw new Error(`运行时版本断言失败：期望 v${PINNED_NODE_VERSION}，实际 v${actual}。`);
  }
  if (!hasNpm()) throw new Error('运行时准备失败：缺少 npm（node_modules/npm/bin/npm-cli.js）。');

  let npmVer = null;
  try {
    npmVer = execFileSync(nodeExe, [path.join(RUNTIME, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '-v'], { encoding: 'utf8' })
      .trim().split(/\r?\n/).pop();
  } catch (err) {
    warn('npm 自检失败：' + err.message);
  }

  writeMarker({ actual, npmVer, source: result.source, nodeDir: result.nodeDir });

  log(`专用运行时就绪：node=v${actual} npm=${npmVer || '未知'}（来源 ${result.source}）`);
  if (result.source === 'system-copy') {
    warn('注意：本次运行时来自系统复制，vendor-manifest.json 记录的 nodeVersion 将是构建机的版本。');
  }
}

function writeMarker({ actual, npmVer, source, nodeDir }) {
  fs.writeFileSync(MARKER, [
    `node=${actual}`,
    `pinned=${PINNED_NODE_VERSION}`,
    `npm=${npmVer || 'unknown'}`,
    `source=${source}${nodeDir ? ':' + nodeDir : ''}`,
    `at=${new Date().toISOString()}`
  ].join('\n') + '\n');
}

main().catch((err) => {
  console.error('[prepare-runtime] 失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
