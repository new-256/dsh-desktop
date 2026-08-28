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
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'vendor', 'runtime');

function log(m) { console.log('[prepare-runtime] ' + m); }

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

function robocopy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  try {
    execSync(`robocopy "${src}" "${dst}" /E /NFL /NDL /NJH /NJS /NP /XD .git`, { stdio: 'ignore' });
  } catch { /* robocopy success codes are non-zero */ }
}

function main() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const nodeDir = findSystemNodeDir();
  if (!nodeDir) throw new Error('未找到系统 Node 安装目录，无法捆绑专用运行时。请先安装 Node 22.15+ / 24。');
  const nodeExe = path.join(nodeDir, 'node.exe');
  const major = parseInt((execSync(`"${nodeExe}" -v`, { encoding: 'utf8' }).trim().replace(/^v/, '').split('.')[0]), 10);
  log(`system node dir: ${nodeDir} (v${major})`);
  if (major < 22) throw new Error(`DSH 需要 Node >= 22.15（检测到 v${major}）。`);

  const marker = path.join(RUNTIME, '.runtime-ready');
  if (fs.existsSync(marker) && fs.existsSync(path.join(RUNTIME, 'node.exe')) &&
      fs.existsSync(path.join(RUNTIME, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
    log('dedicated runtime already prepared; reusing.');
  } else {
    // Copy the whole Node install prefix (node.exe + shims + npm + corepack).
    log('copying complete Node prefix into vendor/runtime ...');
    robocopy(nodeDir, RUNTIME);
    fs.writeFileSync(marker, new Date().toISOString());
  }

  const ver = execSync(`"${path.join(RUNTIME, 'node.exe')}" -v`, { encoding: 'utf8' }).trim();
  const npmVer = execSync(`"${path.join(RUNTIME, 'node.exe')}" "${path.join(RUNTIME, 'node_modules', 'npm', 'bin', 'npm-cli.js')}" -v`, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  log(`dedicated runtime ready. node=${ver} npm=${npmVer}`);
}

main();
