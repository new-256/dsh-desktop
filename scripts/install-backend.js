'use strict';

/**
 * 把 DSH 后端（@deepseek-ai/dsh 及其完整依赖）准备到 vendor/dsh，
 * 使其随安装包分发、目标机器无需预装 Node/dsh。
 *
 * ── 版本策略（本次改动的核心）────────────────────────────────────────────
 * 旧实现只做「存在性检查」（bin.js 在就复用），因此改了 DSH_VERSION 也不生效：
 * 实测 vendor/dsh 里长期躺着 0.1.1-rc.2，而期望已经是 0.1.7-alpha.2，安装包里
 * 装出去的仍是旧后端，且没有任何提示。现在按 DSH_VERSION 是否精确锁定分两路：
 *
 *   精确锁定（如 0.1.7-alpha.2）：
 *     1) vendor/dsh 存在且版本严格相符 → 复用；
 *     2) 否则 `npm install @deepseek-ai/dsh@<版本>`（权威来源，联网）；
 *     3) 联网失败时，仅当全局 dsh 版本**也相符**才回退复制，否则直接失败。
 *   未锁定（latest / 范围）：
 *     1) vendor/dsh 可用 → 复用（不联网、不做隐式降级）；
 *     2) 否则优先复制全局 dsh（快），再回退 npm install。
 *
 * 无论哪条路径，结束后都做一次**版本断言**：锁定模式下实际版本必须等于期望
 * 版本，否则报错中止（宁可打包失败，也不打包出错误版本）。成功后在 vendor/dsh
 * 写 `.dsh-backend.json` 戳记，记录「请求值 → 解析值 → 来源」，便于事后追溯。
 *
 * ── 环境变量 ──────────────────────────────────────────────────────────────
 *   DSH_VERSION         期望版本，默认 latest（精确版本如 0.1.7-alpha.2 会强校验）
 *   DSH_BACKEND_FORCE   1 = 忽略已有 vendor/dsh，强制重新准备
 *   DSH_SKIP_BACKEND    1 = 完全跳过后端准备
 *   DSH_NPM_REGISTRY    覆盖 npm registry（国内构建建议 npmmirror）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'dsh');
const DSH_VERSION = (process.env.DSH_VERSION || 'latest').trim();
// 戳记放在 vendor/ 下、与 dsh 平级：pack-vendor.js 只打包 vendor/dsh 本身，
// 因此戳记不会被装进 7z、也不会出现在用户的 backend 目录里。
const STAMP = path.join(ROOT, 'vendor', '.dsh-backend.json');
const DSH_PKG_DIR = path.join('node_modules', '@deepseek-ai', 'dsh');

function binJs(root) {
  return path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function log(msg) { console.log('[install-backend] ' + msg); }

/** 精确版本判定：1.2.3 / 1.2.3-alpha.2 这类；latest、^1.2.3、>=1 一律视为未锁定。 */
function isExactVersion(spec) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec);
}

/** 读某个 dsh 安装根目录下的 @deepseek-ai/dsh 版本号；读不到返回 null。 */
function readVersionFrom(root) {
  try {
    const raw = fs.readFileSync(path.join(root, DSH_PKG_DIR, 'package.json'), 'utf8');
    const v = JSON.parse(raw).version;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch (_) {
    return null;
  }
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch (_) { return null; }
}

function writeStamp(obj) {
  try {
    fs.mkdirSync(VENDOR, { recursive: true });
    fs.writeFileSync(STAMP, JSON.stringify({ ...obj, preparedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (err) {
    log('警告：戳记写入失败（' + err.message + '）');
  }
}

/**
 * 判断 vendor/dsh 能否直接复用。
 * @returns {{reuse:boolean, reason:string, installed:(string|null)}}
 */
function reuseDecision() {
  const installed = readVersionFrom(VENDOR);

  if (!fs.existsSync(binJs(VENDOR))) {
    return { reuse: false, reason: 'vendor/dsh 不存在或缺少 dsh/lib/bin.js', installed };
  }
  if (!installed) {
    // bin.js 在、但 package.json 缺失/损坏：无法判定版本，按不可信处理。
    return { reuse: false, reason: '@deepseek-ai/dsh/package.json 缺失或损坏，无法校验版本', installed: null };
  }

  if (isExactVersion(DSH_VERSION)) {
    if (installed === DSH_VERSION) {
      return { reuse: true, reason: `版本相符（${installed}）`, installed };
    }
    return { reuse: false, reason: `版本不符：已有 ${installed}，期望 ${DSH_VERSION}`, installed };
  }

  // 未锁定（latest / 范围）：沿用已有产物，避免联网与隐式降级。
  const stamp = readStamp();
  if (!stamp) {
    return {
      reuse: true,
      reason: `未锁定版本（${DSH_VERSION}），沿用已有 ${installed}；如需重新解析请设 DSH_BACKEND_FORCE=1`,
      installed
    };
  }
  return {
    reuse: true,
    reason: `未锁定版本（${DSH_VERSION}），沿用已有 ${installed}（戳记 requested=${stamp.requested}，resolved=${stamp.resolved}）`,
    installed
  };
}

function npmInstall() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const pkg = {
    name: 'dsh-desktop-backend',
    version: '0.0.0',
    private: true,
    description: 'Bundled DSH backend for DSH Desktop',
    dependencies: { '@deepseek-ai/dsh': DSH_VERSION }
  };
  fs.writeFileSync(path.join(VENDOR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  // 删掉旧锁文件：否则 npm 可能按锁定的旧版本树做「已满足」判断，改了
  // DSH_VERSION 也不升级 —— 与旧版 ensurePresent 的失效模式同类。
  try { fs.unlinkSync(path.join(VENDOR, 'package-lock.json')); } catch (_) { /* 不存在即可 */ }
  // 换版本时先清掉旧戳记，避免安装失败后留下「已准备好」的假象。
  try { fs.unlinkSync(STAMP); } catch (_) { /* 不存在即可 */ }

  const registry = (process.env.DSH_NPM_REGISTRY || '').trim();
  const args = ['install', '--no-audit', '--no-fund', '--loglevel=error'];
  if (registry) args.push('--registry', registry);

  log(`running npm install @deepseek-ai/dsh@${DSH_VERSION} in vendor/dsh ...`);
  // Use cmd so npm.cmd resolves on Windows; --no-audit/--no-fund keep it quiet.
  execSync('npm ' + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '), {
    cwd: VENDOR,
    stdio: 'inherit',
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  });
}

function globalDshRoot() {
  const candidates = [];
  const appData = process.env.APPDATA;
  if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  // npm global root via `npm root -g`
  try {
    const gr = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(path.join(gr, '@deepseek-ai', 'dsh'));
  } catch (_) { /* ignore */ }
  return candidates.find((p) => fs.existsSync(path.join(p, 'lib', 'bin.js'))) || null;
}

/**
 * 回退：复制全局安装的 dsh（自带嵌套 node_modules，自包含）。
 * expectedVersion 非空时必须版本相符，否则拒绝复制 —— 这是「用旧后端打包」
 * 的第二条泄漏路径（旧实现无条件复制全局版本）。
 */
function copyGlobal(expectedVersion) {
  const src = globalDshRoot();
  if (!src) throw new Error('找不到全局 dsh 安装，无法回退复制。');
  let actual = null;
  try { actual = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version || null; } catch (_) { /* 读不到即视为未知 */ }
  if (expectedVersion && actual !== expectedVersion) {
    throw new Error(`全局 dsh 版本不符（${actual || '未知'} ≠ ${expectedVersion}），拒绝回退复制。`);
  }
  log(`falling back to copying global dsh from: ${src}${actual ? ` (v${actual})` : ''}`);
  // The global @deepseek-ai/dsh has its own node_modules with the full dep tree.
  const destBase = path.join(VENDOR, 'node_modules', '@deepseek-ai');
  fs.mkdirSync(destBase, { recursive: true });
  fs.cpSync(src, path.join(destBase, 'dsh'), { recursive: true, force: true });
  // bin.js is inside the package; its dependencies are resolved relative to it,
  // so copying the self-contained global package (with nested node_modules) is enough.
}

function main() {
  if (process.env.DSH_SKIP_BACKEND === '1') {
    log('DSH_SKIP_BACKEND=1 set; skipping backend preparation.');
    return;
  }

  const pinned = isExactVersion(DSH_VERSION);
  const force = process.env.DSH_BACKEND_FORCE === '1';
  log(`DSH_VERSION=${DSH_VERSION}（${pinned ? '精确锁定，将强校验' : '未锁定'}）`);

  if (!force) {
    const d = reuseDecision();
    if (d.reuse) {
      log('vendor/dsh 可复用：' + d.reason);
      // 补齐戳记：让「这份产物是怎么来的」在复用路径上也可追溯。
      if (!readStamp()) writeStamp({ requested: DSH_VERSION, resolved: d.installed, source: 'reused' });
      return;
    }
    if (fs.existsSync(binJs(VENDOR))) log('需要重新准备后端：' + d.reason);
  } else {
    log('DSH_BACKEND_FORCE=1：强制重新准备后端。');
  }

  let source = null;

  if (pinned) {
    // 锁定版本：npm 是权威来源，先联网装；失败才考虑全局复制（且必须版本相符）。
    try {
      npmInstall();
      source = 'npm';
    } catch (err) {
      log('npm install 失败（' + (err && err.message) + '），尝试回退复制全局 dsh。');
      try {
        copyGlobal(DSH_VERSION);
        source = 'global-copy';
      } catch (err2) {
        throw new Error(
          `后端准备失败：npm install 与全局复制均不可用。\n` +
          `  npm: ${(err && err.message) || err}\n` +
          `  全局复制: ${(err2 && err2.message) || err2}\n` +
          `  提示：可设 DSH_NPM_REGISTRY=https://registry.npmmirror.com 重试。`
        );
      }
    }
  } else if (globalDshRoot()) {
    // 未锁定：优先复用现成的全局 dsh（快、无需联网）。
    try {
      copyGlobal(null);
      source = 'global-copy';
    } catch (err) {
      log('global copy failed (' + (err && err.message) + '); trying npm install.');
      npmInstall();
      source = 'npm';
    }
  } else {
    npmInstall();
    source = 'npm';
  }

  // ── 版本断言：宁可打包失败，也不打包出错误版本 ──────────────────────────
  const installed = readVersionFrom(VENDOR);
  if (!fs.existsSync(binJs(VENDOR)) || !installed) {
    throw new Error('后端准备失败：vendor/dsh 中未找到可用的 @deepseek-ai/dsh（bin.js 或 package.json 缺失）。');
  }
  if (pinned && installed !== DSH_VERSION) {
    throw new Error(`后端版本校验失败：期望 ${DSH_VERSION}，实际 ${installed}（来源 ${source}）。请检查网络 / DSH_NPM_REGISTRY 后重试。`);
  }

  writeStamp({ requested: DSH_VERSION, resolved: installed, source });
  log(`DSH backend ready: @deepseek-ai/dsh@${installed} (source=${source}) at ${binJs(VENDOR)}`);
}

main();
