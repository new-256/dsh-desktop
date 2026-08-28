'use strict';

/**
 * 把 DSH 后端（@deepseek-ai/dsh 及其完整依赖）准备到 vendor/dsh，
 * 使其随安装包分发、目标机器无需预装 Node/dsh。
 *
 * 策略：
 *   1) 若 vendor/dsh 已存在且可解析到 dsh 的 bin.js → 直接复用；
 *   2) 否则尝试在 vendor/dsh 里 `npm install @deepseek-ai/dsh@<版本>`（联网）；
 *   3) 联网失败时，回退为复制当前全局安装的 dsh（含其内嵌 node_modules）。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'dsh');
const DSH_VERSION = process.env.DSH_VERSION || 'latest';

function binJs(root) {
  return path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function log(msg) { console.log('[install-backend] ' + msg); }

function ensurePresent() {
  return fs.existsSync(binJs(VENDOR));
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
  fs.writeFileSync(path.join(VENDOR, 'package.json'), JSON.stringify(pkg, null, 2));

  log('running npm install in vendor/dsh (this downloads the DSH backend)...');
  // Use cmd so npm.cmd resolves on Windows; --no-audit/--no-fund keep it quiet.
  execSync(
    'npm install --no-audit --no-fund --loglevel=error',
    { cwd: VENDOR, stdio: 'inherit', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }
  );
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

function copyGlobal() {
  const src = globalDshRoot();
  if (!src) throw new Error('找不到全局 dsh 安装，无法回退复制。');
  log('falling back to copying global dsh from: ' + src);
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
  if (ensurePresent()) {
    log('vendor/dsh already present, reusing.');
    return;
  }
  // Prefer a ready, self-contained dsh (global install) by copying it — this is
  // fast and reliable. Fall back to a fresh `npm install` only when none exists.
  if (globalDshRoot()) {
    try {
      copyGlobal();
    } catch (err) {
      log('global copy failed (' + (err && err.message) + '); trying npm install.');
      if (!ensurePresent()) npmInstall();
    }
  } else {
    npmInstall();
  }
  if (!ensurePresent()) {
    throw new Error('后端准备失败：vendor/dsh 中未找到 dsh/lib/bin.js。');
  }
  log('DSH backend ready at: ' + binJs(VENDOR));
}

main();
