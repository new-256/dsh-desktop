'use strict';

/**
 * 后端环境自管理（在 Electron 主进程运行）。
 *
 * 设计目标：**保证软件总能启动** 优先，其次才是更新到最新。
 *
 * - 后端(dsh)、Node 运行时、npm 都运行在用户可写的“活跃目录”（userData/backend），
 *   出厂副本在安装目录 resources/vendor，仅用于首次 seed 与回退，无需管理员权限。
 * - 所有更新都先下载/安装到“暂存区”，**绝不改动正在运行的文件**；在下次启动、
 *   后端尚未拉起前统一应用（apply），杜绝 Windows 文件占用导致的失败/损坏。
 * - Node 版本：启动前先确认活跃 node 满足 DSH 要求；不满足时若已暂存了合适的
 *   node 则立即应用，否则下载合规 node（锁定主版本 24，原生模块 ABI 兼容）。
 *
 * 目录（userData 下）：
 *   backend/
 *     node.exe                          活跃 Node
 *     node_modules/npm                  活跃 npm（随 Node 发行包，版本配对）
 *     dsh/node_modules/@deepseek-ai/dsh 活跃后端
 *     dsh.new/                          暂存：新后端（应用后改名替换 dsh/）
 *     node.new/                         暂存：新 Node（node.exe + node_modules/npm …）
 *     downloads/                        下载的 node zip
 *     versions.json                     版本记录
 *   dsh-home/                           独立 DSH_HOME（隔离用户 CLI 的 ~/.dsh）
 */

const { app } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

const REGISTRY = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';
const NODE_DIST_BASE = process.env.DSH_NODE_DIST_BASE || 'https://cdn.npmmirror.com/binaries/node';
// Node 自动更新锁定的主版本（与 DSH 原生模块预编译 ABI 对齐）。
const PINNED_NODE_MAJOR = parseInt(process.env.DSH_NODE_MAJOR || '24', 10);
// 兜底最低 Node 版本（读不到 dsh engines 时使用）。DSH 需要 zstd / stripTypeScriptTypes。
const FALLBACK_MIN_NODE = '22.15.0';

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------
function userDataPath() {
  try { return app.getPath('userData'); } catch (_) { return path.join(os.tmpdir(), 'dsh-desktop'); }
}
function activeRoot() { return path.join(userDataPath(), 'backend'); }
function dshHome() { return path.join(userDataPath(), 'dsh-home'); }
function seedRoot() { return process.resourcesPath && app.isPackaged ? process.resourcesPath : path.join(__dirname); }

function P() {
  const root = activeRoot();
  const seed = seedRoot();
  return {
    root,
    dshHome: dshHome(),
    nodeExe: path.join(root, 'node.exe'),
    npmDir: path.join(root, 'node_modules', 'npm'),
    npmCli: path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    dshDir: path.join(root, 'dsh'),
    dshBin: path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    dshPkg: path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    dshNew: path.join(root, 'dsh.new'),
    nodeNew: path.join(root, 'node.new'),
    downloadDir: path.join(root, 'downloads'),
    versionsJson: path.join(root, 'versions.json'),
    seedRuntimeDir: path.join(seed, 'vendor', 'runtime'),
    seedNodeExe: path.join(seed, 'vendor', 'runtime', 'node.exe'),
    seedNpmDir: path.join(seed, 'vendor', 'runtime', 'node_modules', 'npm'),
    // seedDshModules is the dsh package's node_modules dir; copying it into
    // dsh/node_modules gives dsh/node_modules/@deepseek-ai/dsh/lib/bin.js (+ deps).
    seedDshModules: path.join(seed, 'vendor', 'dsh', 'node_modules'),
    // isolated npm/pnpm/corepack locations (dedicated to this app)
    npmPrefix: path.join(root, '.npm-prefix'),
    npmCache: path.join(root, '.npm-cache'),
    npmRc: path.join(root, '.npmrc'),
    corepackHome: path.join(root, '.corepack'),
    pnpmHome: path.join(root, '.pnpm')
  };
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
function log(...a) { console.log('[backend-mgr]', ...a); }
function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }
function execSync(cmd) {
  try { require('child_process').execSync(cmd, { stdio: 'ignore', shell: true }); } catch {}
}
function rimraf(d) {
  if (!d) return;
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); }
  catch { execSync(`rmdir /s /q "${d}"`); }
}
function copyDir(src, dst) {
  mkdirp(path.dirname(dst));
  rimraf(dst);
  try { require('child_process').execSync(`robocopy "${src}" "${dst}" /E /NFL /NDL /NJH /NJS /NP /XD .git`, { stdio: 'ignore' }); }
  catch { /* robocopy success codes are non-zero */ }
}
function copyFile(src, dst) { mkdirp(path.dirname(dst)); fs.copyFileSync(src, dst); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) { mkdirp(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function parts(v) { return String(v).split('.').map((n) => parseInt(n, 10) || 0); }
function compareSemver(a, b) {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}
function highestSemver(list) { return list.reduce((b, v) => (b == null || compareSemver(v, b) > 0 ? v : b), null); }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || os.tmpdir(),
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true, shell: false
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { const s = d.toString(); out += s; opts.onOutput && opts.onOutput(s); });
    child.stderr.on('data', (d) => { const s = d.toString(); err += s; opts.onOutput && opts.onOutput(s); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve({ stdout: out, stderr: err })
      : reject(new Error(`命令失败(code ${code}): ${cmd} ${args.join(' ')}\n${err || out}`)));
  });
}

// --------------------------------------------------------------------------
// Dedicated, isolated runtime environment
// --------------------------------------------------------------------------
/**
 * Build the environment for the dsh backend AND every child process it spawns
 * (npm/pnpm/corepack when installing plugins, etc.). This guarantees:
 *  - the dedicated node.exe is first on PATH (and SystemRoot etc. are kept);
 *  - npm/pnpm/corepack caches, prefixes and config live inside the app dir,
 *    never the user's ~/.npm or global npm/pnpm store or the system Node.
 */
function buildDedicatedEnv() {
  const p = P();
  mkdirp(p.npmPrefix); mkdirp(p.npmCache); mkdirp(p.corepackHome); mkdirp(p.pnpmHome);

  // Dedicated .npmrc so the bundled npm never reads the user's global config.
  const registry = REGISTRY;
  const npmrcLines = [
    `registry=${registry}`,
    `cache=${p.npmCache.replace(/\\/g, '/')}`,
    `prefix=${p.npmPrefix.replace(/\\/g, '/')}`,
    'audit=false',
    'fund=false'
  ];
  try { fs.writeFileSync(p.npmRc, npmrcLines.join('\n') + '\n'); } catch {}

  const env = { ...process.env };
  // Put the dedicated node prefix (where node.exe / npm.cmd / npx.cmd live) first.
  const pathSep = process.platform === 'win32' ? ';' : ':';
  env.PATH = [p.root, p.npmPrefix, process.env.PATH || process.env.Path || ''].join(pathSep);
  // Remove any ambient node-related vars that could redirect resolution.
  delete env.ELECTRON_RUN_AS_NODE;
  // Isolated npm / corepack / pnpm homes.
  env.NPM_CONFIG_USERCONFIG = p.npmRc;
  env.NPM_CONFIG_CACHE = p.npmCache;
  env.NPM_CONFIG_PREFIX = p.npmPrefix;
  env.npm_config_userconfig = p.npmRc;
  env.npm_config_cache = p.npmCache;
  env.npm_config_prefix = p.npmPrefix;
  env.COREPACK_HOME = p.corepackHome;
  env.COREPACK_ENABLE_AUTO_PIN = '0';
  env.PNPM_HOME = p.pnpmHome;
  env.XDG_DATA_HOME = p.corepackHome;
  // Isolated harness home (do NOT inherit the user's CLI DSH_HOME).
  delete env.DSH_HOME;
  env.DSH_HOME = p.dshHome;
  return env;
}

// Ensure pnpm/yarn shims exist inside the dedicated node prefix (dsh plugins use pnpm).
function enableCorepack(env) {
  const p = P();
  const corepackJs = path.join(p.root, 'node_modules', 'corepack', 'dist', 'corepack.js');
  try {
    if (fs.existsSync(corepackJs)) {
      execFileSync(p.nodeExe, [corepackJs, 'enable'], { cwd: p.root, env: env || buildDedicatedEnv(), stdio: 'ignore' });
    }
  } catch (e) { log('corepack enable skipped:', e.message); }
}

// --------------------------------------------------------------------------
// network
// --------------------------------------------------------------------------
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'dsh-desktop' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
        res.resume(); return resolve(httpsGet(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout ' + url)));
  });
}
async function fetchJson(url) {
  const res = await httpsGet(url);
  let body = ''; res.setEncoding('utf8');
  for await (const c of res) body += c;
  return JSON.parse(body);
}
async function downloadFile(url, dest, onProgress) {
  const res = await httpsGet(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  mkdirp(path.dirname(dest));
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  res.on('data', (c) => { got += c.length; if (onProgress && total && Date.now() - last > 250) { onProgress(got / total); last = Date.now(); } });
  await new Promise((resolve, reject) => { res.pipe(out); out.on('finish', resolve); out.on('error', reject); res.on('error', reject); });
  fs.renameSync(tmp, dest); if (onProgress && total) onProgress(1);
}
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    mkdirp(destDir);
    const child = spawn('tar.exe', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let e = ''; child.stderr.on('data', (d) => (e += d));
    child.on('error', reject);
    child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('解压失败: ' + e))));
  });
}

// --------------------------------------------------------------------------
// versions
// --------------------------------------------------------------------------
function nodeVersion(nodeExe) {
  try { return execFileSync(nodeExe, ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, ''); } catch { return null; }
}
function npmVersion(npmCli, nodeExe) {
  try { return execFileSync(nodeExe, [npmCli, '-v'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim(); } catch { return null; }
}
function dshVersion() { const m = readJson(P().dshPkg, null); return m && m.version ? m.version : null; }
function currentVersions() {
  const p = P();
  return {
    node: fs.existsSync(p.nodeExe) ? nodeVersion(p.nodeExe) : null,
    npm: fs.existsSync(p.npmCli) ? npmVersion(p.npmCli, p.nodeExe) : null,
    dsh: fs.existsSync(p.dshBin) ? dshVersion() : null
  };
}
async function latestDshVersion() { return (await fetchJson(`${REGISTRY}/@deepseek-ai%2Fdsh/latest`)).version; }
async function latestNodeVersion() {
  const idx = await fetchJson(`${NODE_DIST_BASE}/index.json`);
  const same = idx.filter((e) => e && e.version && new RegExp(`^v${PINNED_NODE_MAJOR}\\.\\d+\\.\\d+$`).test(e.version)).map((e) => e.version.slice(1));
  const picked = highestSemver(same);
  if (!picked) throw new Error(`未找到 Node v${PINNED_NODE_MAJOR}.x`);
  return picked;
}
/**
 * Synchronously evaluate the Node runtime requirement without network requests.
 * Note: Upstream @deepseek-ai/dsh currently publishes NO `engines` field at all
 * (verified against registry.npmmirror.com for 0.1.1-rc.2), so in practice
 * FALLBACK_MIN_NODE is what governs; the engines parsing remains as future-proofing.
 */
function nodeRequirement() {
  const p = P();
  const current = nodeVersion(p.nodeExe);
  const m = readJson(p.dshPkg, null);
  const range = m && m.engines && typeof m.engines.node === 'string' ? m.engines.node : '';
  const nums = [...range.matchAll(/(\d+)\.(\d+)\.(\d+)/g)].map((x) => `${x[1]}.${x[2]}.${x[3]}`);
  const source = nums.length > 0 ? 'engines' : 'fallback';
  const required = highestSemver([...nums, FALLBACK_MIN_NODE]);
  const ok = nodeMeetsRequirement(current, required);
  return { current, required, ok, source };
}

function minNodeForDsh() {
  return nodeRequirement().required;
}
function nodeMeetsRequirement(version, minVer) { return !!version && compareSemver(version, minVer) >= 0; }

// --------------------------------------------------------------------------
// seeding (first run)
// --------------------------------------------------------------------------
function ensureSeeded() {
  const p = P();
  let changed = false;
  mkdirp(p.root); mkdirp(path.join(p.root, 'node_modules'));
  // Isolated harness home (created eagerly so junction repair / first boot work even on a fresh install).
  mkdirp(p.dshHome);

  // Dedicated Node prefix: copy node.exe + shims (npm.cmd/npx.cmd/corepack.cmd)
  // + node_modules/{npm,corepack} from the factory runtime into the active root,
  // so the active dir is itself a complete, self-contained Node install.
  const needNode = !fs.existsSync(p.nodeExe);
  const needNpm = !fs.existsSync(p.npmCli);
  const needCorepack = !fs.existsSync(path.join(p.root, 'node_modules', 'corepack', 'dist', 'corepack.js'));
  if (needNode && fs.existsSync(p.seedNodeExe)) {
    copyDir(p.seedRuntimeDir, p.root);
    log('seeded dedicated Node prefix from factory runtime');
    changed = true;
  } else if (needNpm || needCorepack) {
    if (fs.existsSync(path.join(p.seedRuntimeDir, 'node_modules'))) {
      copyDir(path.join(p.seedRuntimeDir, 'node_modules'), path.join(p.root, 'node_modules'));
      // also ensure node.exe / shims are present
      if (!fs.existsSync(p.nodeExe) && fs.existsSync(p.seedNodeExe)) copyFile(p.seedNodeExe, p.nodeExe);
      log('seeded Node modules (npm/corepack)');
      changed = true;
    }
  }

  // Dedicated backend (dsh).
  if (!fs.existsSync(p.dshBin) && fs.existsSync(path.join(p.seedDshModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    copyDir(p.seedDshModules, path.join(p.dshDir, 'node_modules'));
    log('seeded dsh backend from factory resources');
    changed = true;
  }

  if (changed) {
    try { enableCorepack(buildDedicatedEnv()); } catch {}
  }
  // Always make sure corepack/pnpm shims are present (cheap; idempotent), since dsh
  // plugins may need pnpm to install on first run.
  try { enableCorepack(buildDedicatedEnv()); } catch {}
  const cur = currentVersions();
  writeJson(p.versionsJson, { ...readJson(p.versionsJson, {}), ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v)) });
  return changed;
}

// --------------------------------------------------------------------------
// profile junction healing (prevents the "exists and is not a symlink" abort)
// --------------------------------------------------------------------------
/**
 * dsh manages `$DSH_HOME/profiles/node_modules/<pkg>` as junctions. A real
 * directory there (leftover from a pnpm run, a copy, etc.) makes dsh throw and
 * refuse to boot. Remove every non-junction entry so dsh can re-create links.
 */
function repairProfileJunctions(home) {
  const modulesDir = path.join(home, 'profiles', 'node_modules');
  if (!fs.existsSync(modulesDir)) return false;
  let repaired = false;
  for (const entry of fs.readdirSync(modulesDir)) {
    const full = path.join(modulesDir, entry);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      if (entry.startsWith('@')) {
        for (const sub of fs.readdirSync(full)) {
          const sfull = path.join(full, sub);
          let sst; try { sst = fs.lstatSync(sfull); } catch { continue; }
          if (sst.isDirectory() && !sst.isSymbolicLink()) { rimraf(sfull); repaired = true; }
        }
      } else { rimraf(full); repaired = true; }
    }
  }
  if (repaired) log('repaired non-junction profile entries under', modulesDir);
  return repaired;
}

function stagedVersions() {
  const p = P();
  let dsh = null;
  let node = null;
  try {
    const dshPkgPath = path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    if (fs.existsSync(dshPkgPath)) {
      const m = readJson(dshPkgPath, null);
      if (m && typeof m.version === 'string') dsh = m.version;
    }
  } catch {}
  try {
    const nodeExePath = path.join(p.nodeNew, 'node.exe');
    if (fs.existsSync(nodeExePath)) {
      node = nodeVersion(nodeExePath);
    }
  } catch {}
  return { dsh, node };
}

// --------------------------------------------------------------------------
// STAGED updates — install/download to staging only; never touch running files.
// --------------------------------------------------------------------------
async function stageDsh(callbacks = {}) {
  const p = P();
  const say = (m) => callbacks.onLog && callbacks.onLog(m);
  const staged = stagedVersions().dsh;
  if (staged) {
    try {
      const latest = await latestDshVersion();
      if (compareSemver(staged, latest) >= 0) {
        log(`dsh version ${staged} is already staged (latest=${latest}); reusing`);
        say(`最新 DSH 后端 (${staged}) 已在暂存区，无需重复下载。`);
        return { version: staged, reused: true };
      }
    } catch {}
  }
  if (!fs.existsSync(p.nodeExe) || !fs.existsSync(p.npmCli)) throw new Error('缺少 node/npm，无法更新后端。');
  rimraf(p.dshNew); mkdirp(p.dshNew);
  writeJson(path.join(p.dshNew, 'package.json'), { name: 'dsh-active-backend', version: '0.0.0', private: true, dependencies: { '@deepseek-ai/dsh': 'latest' } });
  say('正在下载并安装最新 DSH 后端（npmmirror，依赖较多，请稍候）…');
  await run(p.nodeExe, [p.npmCli, 'install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${REGISTRY}`, '--no-bin-links'], {
    cwd: p.dshNew,
    env: buildDedicatedEnv(),
    onOutput: (s) => { const l = s.trim(); if (l && l.includes('packages')) say(l); }
  });
  const newBin = path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(newBin)) { rimraf(p.dshNew); throw new Error('后端暂存安装后未找到 dsh，已放弃（当前版本不受影响）。'); }
  const ver = readJson(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {}).version || null;
  log('staged dsh', ver);
  return { version: ver, reused: false };
}

async function stageNode(callbacks = {}) {
  const p = P();
  const say = (m) => callbacks.onLog && callbacks.onLog(m);
  const progress = (f) => callbacks.onProgress && callbacks.onProgress(f);
  const latest = await latestNodeVersion();
  const staged = stagedVersions().node;
  if (staged && compareSemver(staged, latest) >= 0) {
    log(`node version ${staged} is already staged (latest=${latest}); reusing`);
    say(`最新 Node 运行时 (${staged}) 已在暂存区，无需重复下载。`);
    return { version: staged, reused: true };
  }
  const zipName = `node-v${latest}-win-x64.zip`;
  const url = `${NODE_DIST_BASE}/v${latest}/${zipName}`;
  const zip = path.join(p.downloadDir, zipName);
  say(`正在下载 Node v${latest} …`);
  await downloadFile(url, zip, progress);
  rimraf(p.nodeNew); mkdirp(p.nodeNew);
  say('正在解压 Node …');
  await extractZip(zip, p.nodeNew);
  const extracted = path.join(p.nodeNew, `node-v${latest}-win-x64`);
  if (!fs.existsSync(path.join(extracted, 'node.exe'))) { rimraf(p.nodeNew); throw new Error('Node 解压失败，已放弃。'); }
  for (const e of fs.readdirSync(extracted)) {
    const from = path.join(extracted, e), to = path.join(p.nodeNew, e);
    rimraf(to); fs.renameSync(from, to);
  }
  rimraf(extracted);
  try { fs.unlinkSync(zip); } catch {}
  log('staged node', latest);
  return { version: latest, reused: false };
}

// Apply anything staged. Runs BEFORE the backend is spawned (so nothing is locked).
function applyStaged() {
  const p = P();
  const applied = { dsh: null, node: null };

  // Node first: apply the FULL staged prefix (node.exe + shims + node_modules/{npm,corepack}).
  if (fs.existsSync(path.join(p.nodeNew, 'node.exe'))) {
    try {
      const env = buildDedicatedEnv();
      // node.exe
      copyFile(path.join(p.nodeNew, 'node.exe'), p.nodeExe);
      // copy all shims/scripts present at the prefix root (npm.cmd, npx.cmd, corepack.cmd, *.ps1, …)
      for (const f of fs.readdirSync(p.nodeNew)) {
        const from = path.join(p.nodeNew, f);
        let st; try { st = fs.lstatSync(from); } catch { continue; }
        if (f === 'node.exe' || f === 'node_modules' || f === 'node.lib' || f === 'install_tools' || /\.zip$/.test(f)) continue;
        const to = path.join(p.root, f);
        if (st.isDirectory()) copyDir(from, to);
        else copyFile(from, to);
      }
      // node_modules (npm + corepack) wholesale
      const nmSrc = path.join(p.nodeNew, 'node_modules');
      if (fs.existsSync(nmSrc)) copyDir(nmSrc, path.join(p.root, 'node_modules'));
      applied.node = nodeVersion(p.nodeExe);
      log('applied staged Node prefix', applied.node);
      try { enableCorepack(env); } catch {}
    } catch (e) { log('apply staged node failed:', e.message); }
    rimraf(p.nodeNew);
  }

  // Dsh backend: swap dshDir with dshNew.
  if (fs.existsSync(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    try {
      const oldBackup = path.join(p.root, 'dsh.old');
      rimraf(oldBackup);
      if (fs.existsSync(p.dshDir)) fs.renameSync(p.dshDir, oldBackup);
      fs.renameSync(p.dshNew, p.dshDir);
      rimraf(oldBackup);
      applied.dsh = dshVersion(); log('applied staged dsh', applied.dsh);
    } catch (e) {
      log('apply staged dsh failed:', e.message);
      // dsh.new stays for next attempt; current dsh remains usable.
    }
  }

  if (applied.node || applied.dsh) {
    const cur = currentVersions();
    writeJson(p.versionsJson, { ...readJson(p.versionsJson, {}), ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v)) });
  }
  return applied;
}

/**
 * Make sure the active Node meets DSH's requirement before booting the backend.
 * NOTE: This is the ONLY place allowed to pull Node from network when required.
 * If requirement is already met, it returns false immediately with zero network requests.
 * Returns true when the runtime was changed.
 */
async function ensureNodeMeetsRequirement(callbacks = {}) {
  const p = P();
  let cur = nodeVersion(p.nodeExe);
  const minVer = minNodeForDsh();
  if (nodeMeetsRequirement(cur, minVer)) return false;
  log(`active node ${cur} below required ${minVer}; repairing`);
  callbacks.onLog && callbacks.onLog(`当前 Node ${cur || '无'} 不满足 DSH 要求（≥${minVer}），正在准备合规 Node…`);
  applyStaged();
  cur = nodeVersion(p.nodeExe);
  if (nodeMeetsRequirement(cur, minVer)) return true;
  await stageNode(callbacks);
  applyStaged();
  cur = nodeVersion(p.nodeExe);
  if (!nodeMeetsRequirement(cur, minVer)) throw new Error(`无法准备满足要求的 Node（需要 ≥${minVer}）。`);
  return true;
}

/**
 * Escalate a backend spawn failure by attempting to stage and apply the newest pinned-major Node.
 * Used when backend spawn failed even though version gate passed.
 * Returns true when the runtime actually changed, false when nothing could be improved.
 * Must never throw for network errors — logs through callbacks.onLog and returns false.
 */
async function repairNodeForBackendFailure(callbacks = {}) {
  const p = P();
  const oldVer = nodeVersion(p.nodeExe);
  const say = (m) => callbacks.onLog && callbacks.onLog(m);
  try {
    say('尝试升级拉取 Node 运行时以修复后端启动异常…');
    await stageNode(callbacks);
    applyStaged();
    const newVer = nodeVersion(p.nodeExe);
    if (newVer && newVer !== oldVer) {
      log(`repairNodeForBackendFailure successfully updated Node from ${oldVer} to ${newVer}`);
      return true;
    }
  } catch (e) {
    say('修复 Node 运行时失败: ' + (e && e.message));
  }
  return false;
}

// --------------------------------------------------------------------------
// background check (silent) — stages newer versions; applied on next launch
// --------------------------------------------------------------------------
async function checkForUpdates(options = {}) {
  const { includeNode = false } = options;
  ensureSeeded();
  const cur = currentVersions();
  const staged = stagedVersions();
  const result = { current: cur, latest: { npm: cur.npm }, updates: [], pending: [], errors: [] };
  const tasks = [
    { key: 'dsh', fn: latestDshVersion }
  ];
  if (includeNode) {
    tasks.push({ key: 'node', fn: latestNodeVersion });
  }
  await Promise.all(tasks.map(async (t) => {
    try {
      const latest = await t.fn();
      result.latest[t.key] = latest;
      const currentVer = cur[t.key] || null;
      if (!currentVer || compareSemver(latest, currentVer) > 0) {
        const stagedVer = staged[t.key];
        if (stagedVer && compareSemver(stagedVer, latest) >= 0) {
          result.pending.push({ component: t.key, current: currentVer, latest, staged: stagedVer });
        } else {
          result.updates.push({ component: t.key, current: currentVer, latest });
        }
      }
    } catch (e) { result.errors.push({ component: t.key, error: e.message }); }
  }));
  return result;
}

module.exports = {
  P, activeRoot, dshHome,
  ensureSeeded, applyStaged, ensureNodeMeetsRequirement,
  repairProfileJunctions, repairNodeForBackendFailure, nodeRequirement,
  // main.js spawns the backend with this dedicated/isolated environment.
  buildDedicatedEnv, enableCorepack,
  currentVersions, stagedVersions, checkForUpdates,
  stageDsh, stageNode,
  latestDshVersion, latestNodeVersion, minNodeForDsh, nodeMeetsRequirement,
  compareSemver
};
