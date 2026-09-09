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

// 更新路线：托盘「设置」窗可切换 'mirror'（npmmirror，国内快、同步滞后）与
// 'official'（npmjs，版本始终最新）。未设置时退回环境变量，再退回镜像站。
function settingsPath() { return path.join(userDataPath(), 'settings.json'); }
function readSettings() { try { return readJson(settingsPath(), {}); } catch { return {}; } }
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  try { writeJson(settingsPath(), s); } catch (e) { log('write settings failed:', e.message); }
  return s;
}
function npmRegistryUrl() {
  const s = readSettings();
  const route = s && (s.npmRegistry === 'official' || s.npmRegistry === 'mirror') ? s.npmRegistry : null;
  if (route === 'official') return 'https://registry.npmjs.org';
  if (route === 'mirror') return 'https://registry.npmmirror.com';
  return process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';
}
function registryInfo() {
  const url = npmRegistryUrl();
  let route;
  if (url === 'https://registry.npmjs.org') route = 'official';
  else if (url === 'https://registry.npmmirror.com') route = 'mirror';
  else route = 'env';
  return { route, url, label: route === 'official' ? '官方站（npmjs）' : route === 'mirror' ? '镜像站（npmmirror）' : '环境变量 DSH_NPM_REGISTRY' };
}
const UPSTREAM_GITHUB_RAW = process.env.DSH_UPSTREAM_GITHUB_RAW || 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master';
const UPSTREAM_GITHUB_API = process.env.DSH_UPSTREAM_GITHUB_API || 'https://api.github.com/repos/deepseek-ai/deepseek-harness';
const NODE_DIST_MIRROR = 'https://cdn.npmmirror.com/binaries/node';
const NODE_DIST_OFFICIAL = 'https://nodejs.org/dist';
// Node 运行时下载源：环境变量 DSH_NODE_DIST_BASE > 设置(nodeDist) > 默认镜像站。
function nodeDistBase() {
  if (process.env.DSH_NODE_DIST_BASE) return process.env.DSH_NODE_DIST_BASE;
  const s = readSettings();
  if (s && s.nodeDist === 'official') return NODE_DIST_OFFICIAL;
  return NODE_DIST_MIRROR;
}
function nodeDistInfo() {
  const base = nodeDistBase();
  return {
    route: base === NODE_DIST_OFFICIAL ? 'official' : base === NODE_DIST_MIRROR ? 'mirror' : 'env',
    url: base,
    label: base === NODE_DIST_OFFICIAL ? '官方站（nodejs.org）' : base === NODE_DIST_MIRROR ? '镜像站（npmmirror）' : '环境变量 DSH_NODE_DIST_BASE'
  };
}
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
    dshPrevious: path.join(root, 'dsh.previous'),
    pluginSnapshot: path.join(root, 'plugin-state.json'),
    nodeNew: path.join(root, 'node.new'),
    downloadDir: path.join(root, 'downloads'),
    versionsJson: path.join(root, 'versions.json'),
    seedRuntimeDir: path.join(seed, 'vendor', 'runtime'),
    seedNodeExe: path.join(seed, 'vendor', 'runtime', 'node.exe'),
    seedNpmDir: path.join(seed, 'vendor', 'runtime', 'node_modules', 'npm'),
    // seedDshModules is the dsh package's node_modules dir; copying it into
    // dsh/node_modules gives dsh/node_modules/@deepseek-ai/dsh/lib/bin.js (+ deps).
    seedDshModules: path.join(seed, 'vendor', 'dsh', 'node_modules'),
    // Packed layout: multi-threaded 7z PARTS shipped under resources/payload
    // (payload/vendor-0.7z … vendor-(N-1).7z), extracted CONCURRENTLY straight
    // into the backend root on first run. A legacy single vendor.7z is still
    // honored for backward compatibility.
    seedPayloadDir: path.join(seed, 'payload'),
    seedVendorArchive: path.join(seed, 'payload', 'vendor.7z'),
    seedVendor7za: path.join(seed, 'payload', '7za.exe'),
    // isolated npm/pnpm/corepack locations (dedicated to this app)
    npmPrefix: path.join(root, '.npm-prefix'),
    npmCache: path.join(root, '.npm-cache'),
    npmRc: path.join(root, '.npmrc'),
    corepackHome: path.join(root, '.corepack'),
    pnpmHome: path.join(root, '.pnpm'),
    // 终端包装器脚本目录（dsh.cmd / dsh-desktop.cmd，可加入用户 PATH）
    binDir: path.join(userDataPath(), 'bin')
  };
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
const diagLog = require('./diag-log').write;
function log(...a) { console.log('[backend-mgr]', ...a); diagLog('[backend-mgr]', ...a); }
function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }
function execSync(cmd) {
  try { require('child_process').execSync(cmd, { stdio: 'ignore', shell: true }); } catch {}
}
function rimraf(d) {
  if (!d) return;
  try { fs.rmdirSync(d); return; } catch {}
  try { fs.unlinkSync(d); return; } catch {}
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
function parts(v) { return String(v || '0.0.0').replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0); }
function compareSemver(a, b) {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  const pre = (v) => { const s = String(v || '').replace(/^v/, '').split('-')[1]; return s ? s.split('.') : []; };
  const aa = pre(a), bb = pre(b);
  if (!aa.length && bb.length) return 1;
  if (aa.length && !bb.length) return -1;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] == null) return -1; if (bb[i] == null) return 1;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    if (an && bn && Number(aa[i]) !== Number(bb[i])) return Number(aa[i]) > Number(bb[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  }
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
// Dedicated, isolated runtime environment
// --------------------------------------------------------------------------
const NODE_HIJACK_VARS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_ICU_DATA',
  'NODE_V8_COVERAGE',
  'ELECTRON_RUN_AS_NODE'
];

const NPM_PROXY_TLS_ALLOWLIST = new Set([
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
  'npm_config_cafile',
  'npm_config_ca',
  'npm_config_strict_ssl'
]);

const TARGET_BINARIES = ['node.exe', 'npm.cmd', 'npx.cmd', 'pnpm.cmd', 'dsh.cmd'];

function isInsideActiveRoot(dirPath, rootPath) {
  if (!dirPath || !rootPath) return false;
  try {
    const resolvedDir = path.resolve(dirPath).toLowerCase();
    const resolvedRoot = path.resolve(rootPath).toLowerCase();
    return resolvedDir === resolvedRoot || resolvedDir.startsWith(resolvedRoot + path.sep);
  } catch {
    return false;
  }
}

function containsForeignBinary(dirPath) {
  if (!dirPath) return false;
  try {
    const cleanDir = dirPath.replace(/^"+|"+$/g, '').trim();
    if (!cleanDir) return false;
    for (const bin of TARGET_BINARIES) {
      if (fs.existsSync(path.join(cleanDir, bin))) {
        return true;
      }
    }
  } catch {}
  return false;
}

function analyzeEnvIsolation(baseEnv = process.env) {
  const p = P();
  const env = {};
  const strippedVarsSet = new Set();

  for (const key of Object.keys(baseEnv)) {
    env[key] = baseEnv[key];
  }

  // Remove Node startup / module resolution hijacking vectors that cause backend spawn failure
  // (e.g., stray NODE_OPTIONS --require or stale NODE_PATH).
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    if (NODE_HIJACK_VARS.includes(upperKey)) {
      strippedVarsSet.add(key);
      delete env[key];
    }
  }

  // Normalize npm configuration case-insensitively. Remove ambient npm_config_* vars
  // (except proxy/TLS allowlist) so user's global config cannot win over dedicated .npmrc.
  // Preserve corporate network proxy & custom CA cert settings (HTTP_PROXY, HTTPS_PROXY,
  // NO_PROXY, NODE_EXTRA_CA_CERTS). Unlike NODE_OPTIONS, these do not allow code execution hijacking.
  const proxyTlsValues = {};
  for (const key of Object.keys(env)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('npm_config_')) {
      if (NPM_PROXY_TLS_ALLOWLIST.has(lowerKey)) {
        if (env[key] !== undefined) {
          proxyTlsValues[lowerKey] = env[key];
        }
      } else {
        strippedVarsSet.add(key);
      }
      delete env[key];
    } else if (lowerKey === 'npm_execpath' || lowerKey === 'npm_lifecycle_script' || lowerKey.startsWith('npm_package_') || lowerKey === 'npm_token') {
      strippedVarsSet.add(key);
      delete env[key];
    }
  }

  // Re-emit proxy/TLS allowlisted npm config keys in lowercase form.
  for (const [k, v] of Object.entries(proxyTlsValues)) {
    env[k] = v;
  }

  // Isolated npm / corepack / pnpm homes & DSH_HOME.
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

  if (env.DSH_HOME && env.DSH_HOME !== p.dshHome) {
    strippedVarsSet.add('DSH_HOME');
  }
  delete env.DSH_HOME;
  env.DSH_HOME = p.dshHome;

  // PATH hygiene: build PATH as [our node prefix, our npm prefix, ...filtered ambient PATH].
  const rawPath = baseEnv.PATH || baseEnv.Path || baseEnv.path || '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const rawEntries = rawPath.split(pathSep).map((e) => e.replace(/^"+|"+$/g, '').trim()).filter(Boolean);

  const droppedPathEntries = [];
  const keptAmbientEntries = [];

  for (const entry of rawEntries) {
    if (isInsideActiveRoot(entry, p.root)) {
      keptAmbientEntries.push(entry);
    } else if (containsForeignBinary(entry)) {
      droppedPathEntries.push(entry);
    } else {
      keptAmbientEntries.push(entry);
    }
  }

  const pathHead = [p.root, p.npmPrefix];
  env.PATH = [...pathHead, ...keptAmbientEntries].join(pathSep);

  const strippedVars = Array.from(strippedVarsSet).sort();

  return {
    env,
    strippedVars,
    droppedPathEntries,
    pathHead
  };
}

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
  const registry = npmRegistryUrl();
  const npmrcLines = [
    `registry=${registry}`,
    `cache=${p.npmCache.replace(/\\/g, '/')}`,
    `prefix=${p.npmPrefix.replace(/\\/g, '/')}`,
    'audit=false',
    'fund=false'
  ];
  try { fs.writeFileSync(p.npmRc, npmrcLines.join('\n') + '\n'); } catch {}

  const isolation = analyzeEnvIsolation(process.env);
  delete isolation.env.ELECTRON_RUN_AS_NODE;
  if (isolation.droppedPathEntries.length > 0) {
    log(`dropped ${isolation.droppedPathEntries.length} foreign PATH entry(ies) from ambient PATH`);
  }
  return isolation.env;
}

function describeEnvIsolation() {
  const p = P();
  const isolation = analyzeEnvIsolation(process.env);
  return {
    nodePrefix: p.root,
    npmPrefix: p.npmPrefix,
    dshHome: p.dshHome,
    strippedVars: isolation.strippedVars,
    droppedPathEntries: isolation.droppedPathEntries,
    pathHead: isolation.pathHead
  };
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
/** npm 镜像上 @deepseek-ai/dsh 已发布的版本集合（与 GitHub 版本交叉校核用）。 */
async function npmDshPublished() {
  const doc = await fetchJson(`${npmRegistryUrl()}/@deepseek-ai%2Fdsh`);
  const versions = Object.keys((doc && doc.versions) || {});
  if (!versions.length) throw new Error('npm registry returned no versions');
  // 每个版本声明的 engines.node（可能缺失；缺失时调用方自行回退 FALLBACK_MIN_NODE）。
  const engines = {};
  for (const v of versions) {
    const meta = doc.versions[v];
    const en = meta && meta.engines && typeof meta.engines.node === 'string' ? meta.engines.node : null;
    if (en) engines[v] = en;
  }
  return { versions, latest: highestSemver(versions), engines };
}

async function latestDshInfo() {
  // 1) GitHub master = 权威最新版本。
  let github = null; let changes = []; let githubErr = null;
  try {
    const pkg = await fetchJson(`${UPSTREAM_GITHUB_RAW}/apps/cli/package.json`);
    if (!pkg || !pkg.version) throw new Error('GitHub package version missing');
    github = pkg.version;
    try {
      const commits = await fetchJson(`${UPSTREAM_GITHUB_API}/commits?path=apps/cli&per_page=5`);
      changes = Array.isArray(commits) ? commits.map((c) => c && c.commit && c.commit.message).filter(Boolean).map((m) => m.split(/\r?\n/)[0]).slice(0, 5) : [];
    } catch {}
  } catch (e) { githubErr = e.message; }

  // 2) npm 已发布版本 —— 只有两边都存在的版本才提示更新（否则下载必然失败）。
  let npm = null; let npmErr = null;
  try { npm = await npmDshPublished(); } catch (e) { npmErr = e.message; }

  if (github && npm) {
    if (npm.versions.includes(github)) {
      return { version: github, source: 'github+npm', changes, github, npmLatest: npm.latest };
    }
    // GitHub 领先于 npm：仅提示 npm 已发布且不超过 GitHub 的最新版本。
    const installable = npm.versions.filter((v) => compareSemver(v, github) <= 0);
    const best = highestSemver(installable);
    if (best) {
      log(`GitHub 已到 ${github}，npm 尚未发布该版本；本次仅提示两边均存在的 ${best}（npm 最新 ${npm.latest}）`);
      return { version: best, source: 'npm-verified', changes, github, npmLatest: npm.latest, githubAhead: github };
    }
    if (npm.latest) return { version: npm.latest, source: 'npm', changes, github, npmLatest: npm.latest };
  }
  if (github && !npm) {
    // npm 校核失败（网络等）：退回 GitHub 版本；下载失败时界面会如实报错。
    log(`npm 版本校核失败（${npmErr}），退回 GitHub 版本 ${github}`);
    return { version: github, source: 'github', changes, github, npmCheckFailed: npmErr };
  }
  if (!github && npm && npm.latest) {
    return { version: npm.latest, source: 'npm', changes: [], fallback: githubErr };
  }
  const version = (await fetchJson(`${npmRegistryUrl()}/@deepseek-ai%2Fdsh/latest`)).version;
  return { version, source: 'npm', changes: [], fallback: githubErr || npmErr };
}
async function latestDshVersion() { return (await latestDshInfo()).version; }
async function latestNodeVersion() {
  const idx = await fetchJson(`${nodeDistBase()}/index.json`);
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
/**
 * Discover the shipped payload archives under resources/payload. Prefers the
 * multi-part layout (vendor-0.7z … vendor-(N-1).7z, sorted by index); falls back
 * to a legacy single vendor.7z. Returns a sorted array of absolute part paths.
 */
function discoverVendorParts(p) {
  let names;
  try { names = fs.readdirSync(p.seedPayloadDir); } catch { return []; }
  const parts = names
    .map((n) => /^vendor-(\d+)\.7z$/.exec(n))
    .filter(Boolean)
    .map((m) => ({ idx: parseInt(m[1], 10), file: path.join(p.seedPayloadDir, m[0]) }))
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.file);
  if (parts.length > 0) return parts;
  if (fs.existsSync(p.seedVendorArchive)) return [p.seedVendorArchive];
  return [];
}

// PowerShell single-quote escaping (double any embedded single quote).
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/**
 * Extract the packed vendor payload straight into the backend root using the
 * bundled 7za. Each part stores runtime files at its root and the dsh tree under
 * dsh/, so extracting EVERY part into <root> reproduces exactly the layout the
 * directory-copy path produces:
 *   <root>/node.exe, <root>/node_modules/**, <root>/dsh/node_modules/**
 *
 * Parallelism: ensureSeeded() must stay synchronous, so we launch one hidden
 * 7za process per part CONCURRENTLY via a single blocking spawnSync of
 * PowerShell (Start-Process -PassThru … | Wait-Process), then fail if any part
 * exited non-zero. This parallelises the file-WRITE side (the real first-run
 * cost); a single `7za x` writes with one thread regardless of decode threads.
 * Returns true only when extraction succeeded AND the expected files landed.
 */
function seedFromArchive(p) {
  const parts = discoverVendorParts(p);
  if (parts.length === 0 || !fs.existsSync(p.seedVendor7za)) return false;
  try {
    mkdirp(p.root);
    log(`seeding backend from ${parts.length} payload part(s) via concurrent 7za extract …`);

    if (parts.length === 1) {
      // Legacy single archive: one blocking extract, no PowerShell needed.
      // x = extract with full paths; -aoa = overwrite all; -mmt=on = multi-thread.
      execFileSync(p.seedVendor7za, ['x', parts[0], '-aoa', '-mmt=on', '-o' + p.root], { stdio: 'ignore' });
    } else {
      // Build an inline PowerShell command that spawns one hidden 7za per part
      // and waits for all of them. No helper script is written to disk.
      //
      // Quoting matters and is NOT optional: Start-Process joins -ArgumentList
      // ARRAY elements with spaces WITHOUT quoting them, so the array form breaks
      // on the real paths, which always contain a space ("DSH Desktop"). That
      // failure is silent -- 7za still exits 0 while extracting nothing -- so the
      // arguments are passed as ONE pre-quoted string instead. Trailing
      // backslashes are stripped so the closing quote of "-o..." cannot be escaped.
      const rootArg = String(p.root).replace(/\\+$/, '');
      const partsLiteral = parts.map(psQuote).join(',');
      const ps = [
        "$ErrorActionPreference='Stop';",
        '$exe=' + psQuote(p.seedVendor7za) + ';',
        '$root=' + psQuote(rootArg) + ';',
        '$parts=@(' + partsLiteral + ');',
        '$procs=@();',
        'foreach($pt in $parts){',
        '  $a=\'x "\'+$pt+\'" -aoa -mmt=on "-o\'+$root+\'"\';',
        '  $procs+=Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden;',
        '}',
        '$procs | Wait-Process;',
        '$fail=0; foreach($pr in $procs){ if($pr.ExitCode -ne 0){ $fail++ } }',
        'if($fail -gt 0){ Write-Output ("parts failed: "+$fail); exit 1 }; exit 0'
      ].join(' ');
      const res = require('child_process').spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { encoding: 'utf8', windowsHide: true }
      );
      if (res.error) throw res.error;
      if (res.status !== 0) {
        const out = String((res.stdout || '') + (res.stderr || '')).trim().slice(-400);
        throw new Error(`并行解压有分卷失败(code ${res.status})${out ? ': ' + out : ''}`);
      }
    }

    if (fs.existsSync(p.nodeExe) && fs.existsSync(p.dshBin)) {
      log(`已并行解压 ${parts.length} 个分卷完成后端初始化`);
      return true;
    }
    log('payload extracted but expected files missing; falling back to directory copy');
  } catch (e) {
    log('payload seed failed (' + e.message + '); falling back to directory copy');
  }
  return false;
}

function requestedBackendVersion() {
  const file = path.join(userDataPath(), 'requested-backend-version.txt');
  try { const value = fs.readFileSync(file, 'utf8').trim(); if (value === 'online') return 'online'; if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) return value; } catch {}
  return null;
}
/** Consume the installer's backend-selection marker so it applies exactly once. */
function clearRequestedBackendVersion() {
  try { fs.unlinkSync(path.join(userDataPath(), 'requested-backend-version.txt')); } catch {}
}

function migrateProjectionCache() {
  const p = P();
  const dir = path.join(p.dshHome, 'storages', 'session_projcache');
  if (!fs.existsSync(dir)) return { changed: 0, skipped: 0 };
  const backupDir = path.join(dir, `migration-backup-${formatDateTimestamp()}`);
  let changed = 0; let skipped = 0;
  const files = [];
  function collect(root) {
    let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(full);
    }
  }
  collect(dir);
  for (const file of files) {
    let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { skipped++; continue; }
    let touched = false;
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.identity && typeof node.identity === 'object' && !Array.isArray(node.identity)) {
        if (typeof node.identity.isSeeded !== 'boolean') { node.identity.isSeeded = false; touched = true; }
        if (typeof node.identity.inheritedEventCount !== 'number' || !Number.isFinite(node.identity.inheritedEventCount)) { node.identity.inheritedEventCount = 0; touched = true; }
      }
      for (const child of Object.values(node)) visit(child);
    }
    visit(value);
    if (!touched) continue;
    try {
      mkdirp(path.dirname(path.join(backupDir, path.relative(dir, file))));
      fs.copyFileSync(file, path.join(backupDir, path.relative(dir, file)));
      const temp = `${file}.migration-${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
      fs.renameSync(temp, file);
      changed++;
    } catch (e) { try { fs.unlinkSync(`${file}.migration-${process.pid}.tmp`); } catch {} log('projection cache migration skipped:', e.message); skipped++; }
  }
  if (changed) log(`migrated ${changed} projection cache file(s); backups: ${backupDir}`);
  return { changed, skipped, backup: changed ? backupDir : null };
}

function ensureSeeded() {
  const p = P();
  let changed = false;
  mkdirp(p.root); mkdirp(path.join(p.root, 'node_modules'));
  // Isolated harness home (created eagerly so junction repair / first boot work even on a fresh install).
  mkdirp(p.dshHome);
  migrateProjectionCache();

  // Dedicated Node prefix: copy node.exe + shims (npm.cmd/npx.cmd/corepack.cmd)
  // + node_modules/{npm,corepack} from the factory runtime into the active root,
  // so the active dir is itself a complete, self-contained Node install.
  const needNode = !fs.existsSync(p.nodeExe);
  const needNpm = !fs.existsSync(p.npmCli);
  const needCorepack = !fs.existsSync(path.join(p.root, 'node_modules', 'corepack', 'dist', 'corepack.js'));
  const needDsh = !fs.existsSync(p.dshBin);
  const needsSeeding = needNode || needNpm || needCorepack || needDsh;

  // Prefer the packed archive (new layout). This replaces writing ~31.8k loose
  // files with one multi-threaded extract; it changes only HOW the bytes arrive.
  if (needsSeeding && seedFromArchive(p)) {
    changed = true;
  } else {
    // Fallback: old loose-directory layout. Also the path taken by `npm start`
    // from a source checkout, where resources/payload/vendor.7z does not exist
    // but vendor/dsh and vendor/runtime do.
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
 * refuse to boot. Remove every non-junction entry, foreign junction (pointing
 * outside active root), or broken link so dsh can re-create valid links.
 *
 * Since 0.3.4 this ALSO rebuilds custom plugin junctions: any junction living
 * in the home-level `node_modules` (which survives profile quarantine by
 * design) is mirrored into `profiles/node_modules` and
 * `profiles/web/node_modules`, so bare-name plugins keep resolving after the
 * launcher quarantines and dsh rebuilds the profile tree.
 *
 * Returns the number of entries removed + junctions rebuilt (0 = no change).
 */
function repairProfileJunctions(home) {
  const root = activeRoot();
  const modulesDir = path.join(home, 'profiles', 'node_modules');
  // Custom plugin junctions (mirrored from home-level node_modules) point
  // OUTSIDE the active root by design — exempt their targets from the
  // "foreign link" sweep so the rebuild pass is not immediately undone.
  // Real-directory installs count too: a plugin copied in by hand (e.g. a
  // local tgz install) has no junction, but links under profiles pointing
  // at it are just as deliberate (9/8 15:32 incident: the sweep removed a
  // bridge junction because its target was a misnamed real dir, not a
  // junction — crashing a plugin that would otherwise have booted).
  const customTargets = new Set(collectHomeModuleTargets(path.join(home, 'node_modules')));
  let removed = 0;
  const removedItems = []; // { name, kind, target } — logged so boot records answer "what was removed"

  if (fs.existsSync(modulesDir)) {
    let realDirs = 0;
    let foreignLinks = 0;
    let brokenLinks = 0;

    function inspectAndRepair(itemPath) {
      let st;
      try {
        st = fs.lstatSync(itemPath);
      } catch {
        return;
      }

      if (st.isDirectory() && !st.isSymbolicLink()) {
        rimraf(itemPath);
        realDirs++;
        removedItems.push({ name: path.basename(itemPath), kind: 'real-dir', target: null });
        return;
      }

      if (st.isSymbolicLink()) {
        let targetPath;
        try {
          targetPath = fs.realpathSync(itemPath);
        } catch {
          rimraf(itemPath);
          brokenLinks++;
          removedItems.push({ name: path.basename(itemPath), kind: 'broken-link', target: null });
          return;
        }

        if (!isInsideActiveRoot(targetPath, root) && !customTargets.has(targetPath.toLowerCase())) {
          rimraf(itemPath);
          foreignLinks++;
          removedItems.push({ name: path.basename(itemPath), kind: 'foreign-link', target: targetPath });
          return;
        }
      }
    }

    try {
      const entries = fs.readdirSync(modulesDir);
      for (const entry of entries) {
        const full = path.join(modulesDir, entry);
        let st;
        try { st = fs.lstatSync(full); } catch { continue; }

        if (entry.startsWith('@')) {
          if (st.isSymbolicLink()) {
            inspectAndRepair(full);
          } else if (st.isDirectory()) {
            let subEntries = [];
            try { subEntries = fs.readdirSync(full); } catch {}
            for (const sub of subEntries) {
              inspectAndRepair(path.join(full, sub));
            }
          }
        } else {
          inspectAndRepair(full);
        }
      }
    } catch {}

    removed = realDirs + foreignLinks + brokenLinks;
    if (removed > 0) {
      const details = [];
      if (realDirs > 0) details.push(`${realDirs} real dir(s)`);
      if (foreignLinks > 0) details.push(`${foreignLinks} foreign link(s)`);
      if (brokenLinks > 0) details.push(`${brokenLinks} broken link(s)`);
      // Name every removed item — "1 foreign link(s)" alone made the 9/8
      // bot-gateway investigation rely on mtime forensics.
      const named = removedItems.map((it) => (it.target ? `${it.name} -> ${it.target}` : it.name));
      const suffix = named.length ? ` [${named.slice(0, 8).join('; ')}${named.length > 8 ? `; …共${named.length}项` : ''}]` : '';
      log(`repaired profile entries under ${modulesDir}: ${details.join(', ')}${suffix}`);
    }
  }

  const rebuilt = rebuildCustomPluginJunctions(home);
  const total = removed + rebuilt;
  if (total > 0) log(`profile junction heal total: removed=${removed}, rebuilt=${rebuilt}`);
  return total;
}

/**
 * Realpaths of everything deliberately placed directly under home-level
 * node_modules — junctions AND real directories (one level, plus @scope
 * nesting). These are the user's custom plugin installs; profile-layer
 * links pointing at them are exempt from the foreign-link sweep.
 */
function collectHomeModuleTargets(modulesDir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(modulesDir); } catch { return out; }
  const addRealpath = (p) => { try { out.push(fs.realpathSync(p).toLowerCase()); } catch {} };
  for (const entry of entries) {
    const full = path.join(modulesDir, entry);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink() || st.isDirectory()) {
      addRealpath(full);
      if (!st.isSymbolicLink() && entry.startsWith('@')) {
        let subs;
        try { subs = fs.readdirSync(full); } catch { subs = []; }
        for (const sub of subs) addRealpath(path.join(full, sub));
      }
    }
  }
  return out;
}

/**
 * Collect junctions under a directory (recursing one level into `@scope`
 * dirs), returning [{ name, target }] for links whose target still exists.
 */
function collectJunctionSources(modulesDir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(modulesDir); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(modulesDir, entry);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      const target = junctionTarget(full);
      if (target) out.push({ name: entry, target });
    } else if (st.isDirectory() && entry.startsWith('@')) {
      let subs;
      try { subs = fs.readdirSync(full); } catch { continue; }
      for (const sub of subs) {
        const sfull = path.join(full, sub);
        let sst;
        try { sst = fs.lstatSync(sfull); } catch { continue; }
        if (sst.isSymbolicLink()) {
          const target = junctionTarget(sfull);
          if (target) out.push({ name: `${entry}/${sub}`, target });
        }
      }
    }
  }
  return out;
}

/** Return the link target if the link resolves to an existing path, else null. */
function junctionTarget(link) {
  let target;
  try { target = fs.readlinkSync(link); } catch { return null; }
  try { if (!fs.existsSync(target)) return null; } catch { return null; }
  return target;
}

/**
 * Mirror home-level custom plugin junctions into the profile layers so
 * bare-name plugins resolve after quarantine + profile rebuild. Returns the
 * number of junctions created or repaired.
 */
function rebuildCustomPluginJunctions(home) {
  const homeModules = path.join(home, 'node_modules');
  const sources = collectJunctionSources(homeModules);
  if (!sources.length) return 0;

  let changed = 0;
  for (const { name, target } of sources) {
    for (const rel of ['profiles', 'profiles/web']) {
      const linkPath = path.join(home, rel, 'node_modules', name);
      let st;
      try { st = fs.lstatSync(linkPath); } catch { st = null; }

      if (st && st.isSymbolicLink()) {
        let ok = false;
        try {
          const cur = fs.realpathSync(linkPath);
          const want = fs.realpathSync(target);
          ok = cur.toLowerCase() === want.toLowerCase();
        } catch {}
        if (ok) continue;
        try { fs.unlinkSync(linkPath); } catch {}
      } else if (st) {
        // A real dir/file squatting the plugin name breaks resolution; replace.
        rimraf(linkPath);
      }

      try {
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(target, linkPath, 'junction');
        changed++;
      } catch (e) {
        log(`rebuild junction failed ${linkPath}: ${e.message}`);
      }
    }
  }
  if (changed) log(`rebuilt ${changed} custom plugin junction(s) under ${home}\\profiles`);
  return changed;
}

function formatDateTimestamp(d = new Date()) {
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${YYYY}${MM}${DD}-${hh}${mm}${ss}`;
}

function pruneQuarantineProfiles(home) {
  try {
    const entries = fs.readdirSync(home);
    const quarantineDirs = [];
    for (const entry of entries) {
      if (/^profiles\.broken-/i.test(entry)) {
        const full = path.join(home, entry);
        let st;
        try { st = fs.lstatSync(full); } catch { continue; }
        if (st.isDirectory()) {
          quarantineDirs.push({ name: entry, path: full, mtime: st.mtimeMs });
        }
      }
    }

    quarantineDirs.sort((a, b) => b.name.localeCompare(a.name) || (b.mtime - a.mtime));

    if (quarantineDirs.length > 2) {
      const toRemove = quarantineDirs.slice(2);
      for (const item of toRemove) {
        rimraf(item.path);
        log(`pruned old quarantine directory: ${item.name}`);
      }
    }
  } catch (e) {
    log(`pruneQuarantineProfiles error: ${e.message}`);
  }
}

/**
 * Safely quarantine a broken profiles directory to profiles.broken-<YYYYMMDD-HHmmss>.
 * Falls back to destructive rimraf only if rename fails (e.g. file lock), ensuring
 * app boot reliability is never compromised. Prunes old quarantine dirs keeping the 2 most recent.
 */
/** Snapshot third-party registrations per profile dir (bundles / deps / patch). */
function collectProfileRegistrations(home) {
  const prof = path.join(home, 'profiles');
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(prof, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'node_modules')
      .map((d) => d.name);
  } catch { return out; }
  for (const name of dirs) {
    const dir = path.join(prof, name);
    const pkg = readJson(path.join(dir, 'package.json'), null);
    const patchPath = path.join(dir, 'cordis.patch.yml');
    let patch = null;
    try { patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : null; } catch {}
    if (!pkg && patch == null) continue;
    out.push({
      profile: name,
      bundles: (pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles.map(String) : [],
      dependencies: (pkg && pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)) ? { ...pkg.dependencies } : {},
      patch
    });
  }
  return out;
}

function quarantineProfiles(home) {
  const prof = path.join(home, 'profiles');
  if (!fs.existsSync(prof)) return { quarantined: false, name: null, fallback: false };

  const timestamp = formatDateTimestamp();
  let targetName = `profiles.broken-${timestamp}`;
  let targetPath = path.join(home, targetName);

  let counter = 1;
  while (fs.existsSync(targetPath)) {
    targetName = `profiles.broken-${timestamp}_${counter++}`;
    targetPath = path.join(home, targetName);
  }

  // Snapshot third-party registrations BEFORE the rename: after a successful
  // rebuild the desktop can auto-restore them (no more "清了就不管"). The
  // registry file lives in home, so it survives the profiles rename.
  const registry = collectProfileRegistrations(home);
  let registryFile = null;
  if (registry.length) {
    registryFile = path.join(home, `profiles-registry-${timestamp}.json`);
    try {
      writeJson(registryFile, registry);
      log(`preserved ${registry.length} profile registration(s) to ${path.basename(registryFile)}`);
    } catch (e) {
      registryFile = null;
      log('preserve profile registrations failed:', e.message);
    }
  }

  let quarantined = false;
  let fallback = false;

  try {
    fs.renameSync(prof, targetPath);
    quarantined = true;
    log(`quarantined broken profiles to ${targetName}`);
  } catch (e) {
    log(`rename profiles to ${targetName} failed (${e.message}); falling back to rimraf`);
    try {
      rimraf(prof);
      quarantined = true;
      fallback = true;
    } catch (err) {
      log(`fallback rimraf profiles failed: ${err.message}`);
    }
  }

  pruneQuarantineProfiles(home);

  return { quarantined, name: targetName, path: targetPath, fallback, registryFile, registry };
}

/**
 * Auto-restore third-party registrations preserved by a quarantine into the
 * FRESH profiles tree the backend rebuilt. Names appearing in skipNames (the
 * failure log's failing specifiers) are left out — the culprit must not be
 * re-added. Every file overwritten gets a .restore.bak first, so the caller
 * can roll back when the re-merged boot still fails.
 * Returns { restored, skipped, files, rollback }.
 */
function restoreProfileRegistrations(home, registryFile, skipNames = []) {
  const out = { restored: [], skipped: [], files: [], rollback: [] };
  if (!registryFile || !fs.existsSync(registryFile)) return out;
  let registry = [];
  try { registry = readJson(registryFile, []); } catch { return out; }
  if (!Array.isArray(registry) || !registry.length) return out;
  const skip = new Set((skipNames || []).map((n) => normalizeSpecifier(n)));
  const isSkipped = (name) => skip.has(normalizeSpecifier(String(name || '')));

  for (const item of registry) {
    if (!item || !item.profile) continue;
    const dir = path.join(home, 'profiles', item.profile);
    if (!fs.existsSync(dir)) continue;
    let touched = false;

    // package.json: merge preserved bundles/deps minus skipped names.
    const pkgPath = path.join(dir, 'package.json');
    const fresh = readJson(pkgPath, null);
    if (fresh) {
      const freshBundles = (fresh.dsh && fresh.dsh.profile && Array.isArray(fresh.dsh.profile.bundles)) ? fresh.dsh.profile.bundles.map(String) : [];
      const keptFresh = freshBundles.filter((b) => !isSkipped(b));
      const restoredBundles = (item.bundles || []).filter((b) => !isSkipped(b) && !keptFresh.includes(b));
      const restoredDeps = {};
      for (const [k, v] of Object.entries(item.dependencies || {})) if (!isSkipped(k)) restoredDeps[k] = v;
      const skippedHere = (item.bundles || []).filter(isSkipped).concat(Object.keys(item.dependencies || {}).filter(isSkipped));
      if (restoredBundles.length || Object.keys(restoredDeps).length || skippedHere.length) {
        try { fs.copyFileSync(pkgPath, pkgPath + '.restore.bak'); out.rollback.push(pkgPath + '.restore.bak'); } catch {}
        const nextPkg = {
          ...fresh,
          dependencies: { ...(fresh.dependencies || {}), ...restoredDeps },
          dsh: { ...(fresh.dsh || {}), profile: { ...((fresh.dsh && fresh.dsh.profile) || {}), bundles: [...keptFresh, ...restoredBundles] } }
        };
        try { writeJson(pkgPath, nextPkg); touched = true; } catch (e) { log('restore package.json failed:', e.message); }
        if (skippedHere.length) out.skipped.push(...skippedHere);
      }
    }

    // cordis.patch.yml: restore the preserved text, entry-disable any entries
    // matching skipNames (the culprit stays out).
    const patchText = item.patch;
    if (patchText != null) {
      const patchPath = path.join(dir, 'cordis.patch.yml');
      try { fs.copyFileSync(patchPath, patchPath + '.restore.bak'); out.rollback.push(patchPath + '.restore.bak'); } catch {}
      try {
        fs.writeFileSync(patchPath, patchText, 'utf8');
        touched = true;
        const skippedIds = (parseHomePatchBlocks(patchText) || []).flatMap((b) => b.entries.filter((e) => isSkipped(e.name || e.id)).map((e) => e.id));
        if (skippedIds.length) {
          const res = disablePatchEntriesInFile(patchPath, skippedIds);
          out.skipped.push(...(res.disabled || []));
        }
      } catch (e) { log('restore profile patch failed:', e.message); }
    }

    if (touched) { out.restored.push(item.profile); out.files.push(path.join('profiles', item.profile)); }
  }
  if (out.restored.length) log(`auto-restored third-party registrations: ${out.restored.join(', ')} (skipped ${out.skipped.length}: ${out.skipped.join(', ')})`);
  return out;
}

/** Undo restoreProfileRegistrations by copying the .restore.bak files back. */
function rollbackProfileRestore(home, registryFile) {
  if (!registryFile || !fs.existsSync(registryFile)) return;
  let registry = [];
  try { registry = readJson(registryFile, []); } catch { return; }
  if (!Array.isArray(registry)) return;
  for (const item of registry) {
    if (!item || !item.profile) continue;
    const dir = path.join(home, 'profiles', item.profile);
    if (!fs.existsSync(dir)) continue;
    for (const f of ['package.json', 'cordis.patch.yml']) {
      const bak = path.join(dir, f + '.restore.bak');
      if (fs.existsSync(bak)) {
        try { fs.copyFileSync(bak, path.join(dir, f)); log(`rolled back ${item.profile}/${f}`); } catch (e) { log('rollback failed:', e.message); }
      }
    }
  }
}

/**
 * Boot-time recovery of an INTERRUPTED plugin isolation: if the app died mid
 * round-test, the home patch is left in "everything commented" state — which
 * used to read as "清了就不管" for all third-party plugins. Completes the
 * isolation from the saved state: entries recorded as failed stay disabled;
 * every other entry is restored. No-op when no state file exists or the patch
 * was already restored.
 */
function recoverInterruptedIsolation() {
  const state = readJson(pluginIsolationStatePath(), null);
  const p = P();
  if (!state || !state.original) return { active: false };
  // The isolation COMPLETED normally (finishPluginIsolation stamps finishedAt):
  // its result is already reflected in the live patch — nothing to recover.
  if (state.finishedAt) {
    clearPluginIsolation();
    return { active: true, finished: true };
  }
  const live = readPatchText(p.dshHome);
  if (live == null) return { active: false };
  if (live === state.original) {
    clearPluginIsolation();
    return { active: true, alreadyRestored: true };
  }
  const entries = state.entries || [];
  const failed = new Set(entries.filter((e) => e.status === 'failed').map((e) => e.index));
  const all = new Set(entries.map((e) => e.index));
  const good = new Set([...all].filter((i) => !failed.has(i)));
  const text = commentPatchEntries(state.original, good);
  writePatchText(p.dshHome, text);
  const statusMap = new Map(entries.map((e) => [e.index, e]));
  const result = {
    ...state, finishedAt: new Date().toISOString(), recovered: true,
    entries: entries.map((e) => ({ ...e, status: failed.has(e.index) ? 'failed' : e.status || 'ok' }))
  };
  writeJson(pluginIsolationStatePath(), result);
  log(`recovered interrupted plugin isolation: ${failed.size} failed kept disabled, ${good.size} restored`);
  return { active: true, recovered: true, failed: [...failed], restored: [...good] };
}

// --------------------------------------------------------------------------
// Safe mode: a tray-accessible repair channel. The Electron shell (tray +
// settings window) always works even when the GUI or backend is bricked; safe
// mode reduces the profile to ONLY the core bundles and comments the whole
// home patch, so a broken third-party plugin tree can never prevent the GUI
// from booting again. Originals are stored in safe-mode.json and restored
// byte-exact on exit — or automatically on the next NORMAL launch, so a crash
// inside safe mode can never strand the machine in a stripped state.
// --------------------------------------------------------------------------
function safeModeStatePath() { return path.join(P().root, 'safe-mode.json'); }
function safeModeActive() {
  const st = readJson(safeModeStatePath(), null);
  return !!(st && st.active);
}

function enterSafeMode() {
  const p = P();
  const webDir = path.join(p.dshHome, 'profiles', 'web');
  const webPkgPath = path.join(webDir, 'package.json');
  if (!fs.existsSync(webPkgPath)) return { ok: false, msg: 'profiles/web/package.json 不存在，无法进入安全模式' };
  const readTxt = (f) => { try { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
  const homePatchPath = path.join(p.dshHome, 'cordis.patch.yml');
  const webPatchPath = path.join(webDir, 'cordis.patch.yml');
  const saved = {
    webPkg: readTxt(webPkgPath),
    webPatch: readTxt(webPatchPath),
    homePatch: readTxt(homePatchPath)
  };
  try { writeJson(safeModeStatePath(), { active: true, enteredAt: new Date().toISOString(), saved }); }
  catch (e) { return { ok: false, msg: '写入安全模式状态失败: ' + e.message }; }

  // Minimize the profile to core bundles only (keep dependencies — the
  // installed packages stay valid, they just won't be loaded as bundles).
  let pkg = null;
  try { pkg = JSON.parse(saved.webPkg); } catch { pkg = { name: 'dsh-profile-web', private: true }; }
  const next = {
    ...pkg,
    dsh: { ...(pkg.dsh || {}), profile: { ...((pkg.dsh && pkg.dsh.profile) || {}), bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
  };
  try { writeJson(webPkgPath, next); } catch (e) { return { ok: false, msg: '写安全模式 package.json 失败: ' + e.message }; }

  // Comment every home-patch plugin entry (insert lines too — commentPatchEntries
  // handles blocks whose entries are all commented).
  try {
    if (saved.homePatch != null && saved.homePatch.trim() !== '') {
      writePatchText(p.dshHome, commentPatchEntries(saved.homePatch, null));
    }
  } catch (e) { return { ok: false, msg: '注释家级补丁失败: ' + e.message }; }
  // Profile patch → empty.
  try {
    if (saved.webPatch != null) fs.writeFileSync(webPatchPath, '[]\n', 'utf8');
  } catch {}

  log('entered safe mode (core bundles only, home patch commented)');
  return { ok: true, active: true };
}

function exitSafeMode() {
  const p = P();
  const st = readJson(safeModeStatePath(), null);
  if (!st || !st.saved) return { ok: false, msg: '无安全模式状态可恢复' };
  const saved = st.saved || {};
  const webDir = path.join(p.dshHome, 'profiles', 'web');
  const restored = [];
  if (saved.webPkg != null) {
    try { mkdirp(webDir); fs.writeFileSync(path.join(webDir, 'package.json'), saved.webPkg, 'utf8'); restored.push('profiles/web/package.json'); }
    catch (e) { log('exitSafeMode restore pkg failed:', e.message); }
  }
  if (saved.webPatch != null) {
    try { fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), saved.webPatch, 'utf8'); restored.push('profiles/web/cordis.patch.yml'); }
    catch (e) { log('exitSafeMode restore web patch failed:', e.message); }
  }
  if (saved.homePatch != null) {
    try { writePatchText(p.dshHome, saved.homePatch); restored.push('home cordis.patch.yml'); }
    catch (e) { log('exitSafeMode restore home patch failed:', e.message); }
  }
  try { fs.unlinkSync(safeModeStatePath()); } catch {}
  log('exited safe mode; restored: ' + restored.join(', '));
  return { ok: true, restored };
}

/**
 * Boot-time safe-mode resolution. `--safe-mode` in argv keeps the reduced
 * profile (entering it first if the marker is missing — e.g. the tray relaunch
 * raced ahead). A NORMAL launch while a safe-mode marker exists restores the
 * saved originals, so a crash inside safe mode never strands the machine.
 */
function applySafeModeBoot(argv = []) {
  const requested = Array.isArray(argv) && argv.includes('--safe-mode');
  if (requested) {
    if (!safeModeActive()) enterSafeMode();
    return { active: true, requested: true };
  }
  if (safeModeActive()) {
    const res = exitSafeMode();
    return { active: false, exited: true, restored: (res && res.restored) || [] };
  }
  return { active: false };
}

function pluginEntries(home) {
  const patchPath = path.join(home, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) return [];
  let text; try { text = fs.readFileSync(patchPath, 'utf8'); } catch { return []; }
  const blocks = parseHomePatchBlocks(text);
  const list = [];
  for (const b of blocks) {
    for (const e of b.entries) {
      if (e && e.name) list.push({ name: e.name, id: e.id, available: pluginSourceAvailable(home, e) });
    }
  }
  return list;
}
function snapshotPluginState() {
  const p = P();
  const snapshot = { backend: currentVersions().dsh, createdAt: new Date().toISOString(), plugins: pluginEntries(p.dshHome) };
  writeJson(p.pluginSnapshot, snapshot);
  return snapshot;
}
function pluginCompatibilityReport(home, backendVersion) {
  return pluginEntries(home).map((plugin) => ({ ...plugin, compatible: plugin.available, reason: plugin.available ? null : '插件源文件不存在或不可加载' }));
}
function disableIncompatiblePlugins(home, report) {
  const broken = report.filter((p) => !p.compatible);
  if (!broken.length) return { disabled: [], backup: null };
  return disableBrokenPatchPlugins(home, broken.map((p) => ({ id: p.name, name: p.name })));
}
function pluginIsolationStatePath() { return path.join(P().root, 'plugin-isolation.json'); }
function readPatchText(home) { try { return fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8'); } catch { return null; } }
function writePatchText(home, text) { const file = path.join(home, 'cordis.patch.yml'); mkdirp(path.dirname(file)); fs.writeFileSync(file, ensurePatchArrayText(text), 'utf8'); }
function patchBlocks(home) {
  const text = readPatchText(home); return text == null ? { text: null, blocks: [] } : { text, blocks: parseHomePatchBlocks(text) };
}
function commentPatchBlocks(text, selected = null) {
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  const blocks = parseHomePatchBlocks(text);
  for (let i = 0; i < blocks.length; i++) {
    if (selected && !selected.has(i)) {
      for (let j = blocks[i].start; j < blocks[i].end; j++) {
        if (lines[j].trim() && !lines[j].startsWith('#')) lines[j] = '# ' + lines[j];
      }
    }
  }
  return ensurePatchArrayText(lines.join(eol), eol);
}
function preparePluginIsolation() {
  const p = P(); const parsed = patchBlocks(p.dshHome);
  if (parsed.text == null || !parsed.blocks.length) return { active: false, plugins: [], entries: [] };
  // ENTRY-level granularity: every plugin entry is tested and released
  // individually, so one broken plugin can no longer take its whole block
  // (a "class" of plugins) down with it.
  const entries = [];
  parsed.blocks.forEach((block, blockIndex) => {
    block.entries.forEach((e) => {
      entries.push({ index: entries.length, blockIndex, id: e.id, name: e.name, lineStart: e.lineStart, lineEnd: e.lineEnd, status: 'pending' });
    });
  });
  const state = {
    original: parsed.text, createdAt: new Date().toISOString(), granularity: 'entry',
    plugins: parsed.blocks.map((block, index) => ({ index, ids: block.entries.map((e) => e.id), names: block.entries.map((e) => e.name), status: 'pending' })),
    entries
  };
  writeJson(pluginIsolationStatePath(), state);
  const backup = path.join(p.dshHome, `cordis.patch.yml.isolation-${formatDateTimestamp()}.bak`);
  fs.copyFileSync(path.join(p.dshHome, 'cordis.patch.yml'), backup);
  writePatchText(p.dshHome, commentPatchEntries(parsed.text, null)); // comment ALL entries
  return { active: true, backup, plugins: state.plugins, entries };
}

/**
 * Comment entry ranges of a patch text. `selected` = Set(entry indexes) to KEEP
 * active; null comments everything. A block's `- insert:` line is only commented
 * when EVERY entry in it is commented (a bare insert would be a null insert).
 */
function commentPatchEntries(text, selected) {
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  const blocks = parseHomePatchBlocks(text);
  let entryIndex = 0;
  for (const block of blocks) {
    let commentedInBlock = 0;
    for (const entry of block.entries) {
      if (!(selected && selected.has(entryIndex))) {
        for (let j = entry.lineStart; j < entry.lineEnd; j++) {
          if (lines[j].trim() && !lines[j].startsWith('#')) lines[j] = '#' + lines[j];
        }
        commentedInBlock++;
      }
      entryIndex++;
    }
    if (block.entries.length > 0 && commentedInBlock === block.entries.length) {
      const l = lines[block.start];
      if (l && !l.trimStart().startsWith('#')) lines[block.start] = '#' + l;
    }
  }
  // CRITICAL: a patch file that is left with nothing but comments parses as
  // YAML `null`, and the upstream loader rejects it with "must be a top-level
  // YAML array of loader patch entries" — which used to make safe mode (it
  // comments EVERY entry) corrupt the very file it was meant to neutralize,
  // turning the repair entry point into a harder crash. Always keep a valid
  // empty array in that case.
  return ensurePatchArrayText(lines.join(eol), eol);
}

/**
 * Guarantee the patch text still parses as a top-level YAML array: when no
 * active (uncommented) content is left, append an explicit `[]`.
 */
function ensurePatchArrayText(text, eolHint) {
  const eol = eolHint || (String(text).includes('\r\n') ? '\r\n' : '\n');
  const lines = String(text).split(/\r?\n/);
  const hasActive = lines.some((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (hasActive) return text;
  const tail = text.endsWith(eol) || text === '' ? '' : eol;
  return text + tail + '[]' + eol;
}

/**
 * Structural check that a patch file still is a top-level YAML array — the
 * exact contract the upstream loader enforces before it will boot
 * ("must be a top-level YAML array of loader patch entries"). Cheap and
 * dependency-free: the loader only accepts either an explicit flow array
 * (`[]`) or a block sequence, so the first ACTIVE line must open one.
 * Returns { file, exists, valid, reason, activeLines, firstActive }.
 */
function validatePatchFile(patchPath) {
  const res = { file: patchPath, exists: false, valid: true, reason: null, activeLines: 0, firstActive: null };
  let text;
  try {
    if (!fs.existsSync(patchPath)) return res; // absent is legal (no patch layer)
    res.exists = true;
    text = fs.readFileSync(patchPath, 'utf8');
  } catch (e) {
    res.valid = false; res.reason = '无法读取补丁文件: ' + e.message; return res;
  }
  const active = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  res.activeLines = active.length;
  res.firstActive = active[0] || null;
  if (active.length === 0) {
    res.valid = false;
    res.reason = '文件只剩注释，YAML 会解析成 null（上游要求顶层必须是数组）';
    return res;
  }
  const first = active[0].trim();
  if (!(first.startsWith('- ') || first === '-' || first.startsWith('['))) {
    res.valid = false;
    res.reason = `顶层不是 YAML 数组（首个有效行是「${first.slice(0, 40)}」，应以「- 」或「[」开头）`;
  }
  return res;
}

/**
 * Repair an invalid patch file WITHOUT losing user configuration:
 *   1. comment-only file  → append `[]` (keeps every commented line intact)
 *   2. otherwise          → restore the newest *.bak that validates
 *   3. last resort        → reset to `[]` (original kept as .broken-<ts>.bak)
 * The pre-repair file is always backed up first. Returns
 * { repaired, strategy, backup, restoredFrom, reason }.
 */
function repairPatchFile(patchPath) {
  const check = validatePatchFile(patchPath);
  if (!check.exists || check.valid) return { repaired: false, strategy: 'none', reason: check.reason };

  let text = '';
  try { text = fs.readFileSync(patchPath, 'utf8'); } catch {}
  const ts = formatDateTimestamp();
  const backup = patchPath + `.broken-${ts}.bak`;
  try { fs.writeFileSync(backup, text, 'utf8'); }
  catch (e) { log('backup broken patch failed:', e.message); return { repaired: false, strategy: 'none', reason: '备份失败: ' + e.message }; }

  // 1) Comment-only: keep every line, just restore the empty-array contract.
  if (check.activeLines === 0) {
    try {
      fs.writeFileSync(patchPath, ensurePatchArrayText(text), 'utf8');
      log(`repaired patch (appended []): ${patchPath}`);
      return { repaired: true, strategy: 'append-empty-array', backup, reason: check.reason };
    } catch (e) { log('append [] failed:', e.message); }
  }

  // 2) Newest backup that actually validates.
  try {
    const dir = path.dirname(patchPath);
    const base = path.basename(patchPath);
    const cands = fs.readdirSync(dir)
      .filter((f) => f.startsWith(base) && f !== base && /\.bak$/i.test(f) && !f.includes(`.broken-${ts}.`))
      .map((f) => { const full = path.join(dir, f); let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {} return { full, f, mtime }; })
      .sort((a, b) => b.mtime - a.mtime);
    for (const c of cands) {
      if (validatePatchFile(c.full).valid) {
        fs.copyFileSync(c.full, patchPath);
        log(`repaired patch by restoring backup: ${c.f}`);
        return { repaired: true, strategy: 'restore-backup', backup, restoredFrom: c.f, reason: check.reason };
      }
    }
  } catch (e) { log('backup scan failed:', e.message); }

  // 3) Last resort — bootable empty patch layer; user config preserved in backup.
  try {
    fs.writeFileSync(patchPath, '[]\n', 'utf8');
    log(`repaired patch by reset to []: ${patchPath} (original: ${backup})`);
    return { repaired: true, strategy: 'reset-empty', backup, reason: check.reason };
  } catch (e) {
    return { repaired: false, strategy: 'none', backup, reason: '写入失败: ' + e.message };
  }
}

/**
 * Pre-flight over EVERY patch layer the loader will read (home + each
 * profile), repairing invalid ones. Returns [{ file, ...repairResult }].
 */
function validateAndRepairPatchLayers() {
  const home = dshHome();
  const files = [path.join(home, 'cordis.patch.yml')];
  try {
    const profilesDir = path.join(home, 'profiles');
    for (const d of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'node_modules') continue;
      files.push(path.join(profilesDir, d.name, 'cordis.patch.yml'));
    }
  } catch {}
  const out = [];
  for (const f of files) {
    const check = validatePatchFile(f);
    if (!check.exists || check.valid) continue;
    const fix = repairPatchFile(f);
    out.push({ file: f, ...fix });
  }
  if (out.length) log('patch layer repairs:', out.map((r) => `${path.basename(path.dirname(r.file))}:${r.strategy}`).join(', '));
  return out;
}

/** Enable ONE plugin entry alone: comment everything except `entryIndex`. */
function enablePluginIsolationEntry(entryIndex) {
  const p = P(); const state = readJson(pluginIsolationStatePath(), null);
  if (!state || !state.original || !state.entries) return false;
  writePatchText(p.dshHome, commentPatchEntries(state.original, new Set([entryIndex])));
  return true;
}

/** Legacy BLOCK-level enable (kept for compatibility; main.js uses entry-level). */
function enablePluginIsolationBlock(index) {
  const p = P(); const state = readJson(pluginIsolationStatePath(), null);
  if (!state || !state.original) return false;
  const blocks = parseHomePatchBlocks(state.original);
  const selected = new Set((state.entries || []).filter((e) => e.blockIndex === index).map((e) => e.index));
  writePatchText(p.dshHome, commentPatchEntries(state.original, selected));
  return !!blocks[index];
}

/**
 * Finish: restore the original patch with ONLY the failed entries commented —
 * every entry that passed stays active. statuses carry ENTRY indexes.
 */
function finishPluginIsolation(statuses = []) {
  const p = P(); const state = readJson(pluginIsolationStatePath(), null); if (!state || !state.original) return null;
  const failed = new Set((statuses || []).filter((s) => s.status === 'failed').map((s) => s.index));
  const entries = state.entries || [];
  const allIdx = new Set(entries.map((e) => e.index));
  const good = new Set([...allIdx].filter((i) => !failed.has(i)));
  const statusMap = new Map((statuses || []).map((s) => [s.index, s]));
  const result = {
    ...state, finishedAt: new Date().toISOString(),
    plugins: (state.plugins || []).map((blk) => ({ ...blk, status: 'done' })),
    entries: entries.map((e) => ({ ...e, ...(statusMap.get(e.index) || {}) }))
  };
  writePatchText(p.dshHome, commentPatchEntries(state.original, good));
  writeJson(pluginIsolationStatePath(), result); return result;
}
function clearPluginIsolation() { try { fs.unlinkSync(pluginIsolationStatePath()); } catch {} }
// --------------------------------------------------------------------------
// The user's HOME-level cordis.patch.yml (dsh-home/cordis.patch.yml) may inject
// third-party plugins (e.g. the 0.3.3 extension set) that the installed shell
// does not ship. If such a plugin's source is missing (deleted file, junction
// target gone), the backend fails to boot with ERR_MODULE_NOT_FOUND and the
// generic escalations (profile quarantine / Node repair) cannot help. We parse
// the failure logs, match them to patch entries, back up the patch file,
// comment out just those entries, notify the user, and retry once.

/** Normalize a module specifier for matching: file:// URLs -> decoded path, strip ?v=N query, lowercase, forward slashes. */
function normalizeSpecifier(spec) {
  let s = String(spec || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    const rest = s.slice('file://'.length).replace(/^\/+/, ''); // file:///C:/... -> C:/...
    try { s = decodeURIComponent(rest); } catch { s = rest; }
  }
  s = s.split('?')[0];
  s = s.replace(/:\d+(?::\d+)?$/, ''); // strip :line[:col] suffixes from error URLs
  return s.replace(/\\/g, '/').toLowerCase();
}

/**
 * Collect failing module/package specifiers from backend log text.
 * Returns { specifiers: Set, pluginTree: bool, cannotFind: bool }.
 * - specifiers: normalized module references named in error lines
 * - pluginTree: whether the log states the plugin tree itself failed to load
 *   (a plugin module CRASHED on load — SyntaxError/missing export/etc.), the
 *   signal that gates crash-mode attribution
 * - cannotFind: whether a plain "Cannot find package/module" pattern matched
 */
function failingSpecifiersFromLogs(logText) {
  const out = new Set();
  if (!logText) return { specifiers: out, pluginTree: false, cannotFind: false };
  const add = (s) => { const n = normalizeSpecifier(s); if (n) out.add(n); };

  // 1) Cannot find package/module 'X' (missing source — existing behavior).
  let cannotFind = false;
  for (const re of [/Cannot find (?:package|module) '([^']+)'/g, /Cannot find '([^']+)'/g]) {
    let m;
    while ((m = re.exec(logText)) !== null) { cannotFind = true; add(m[1]); }
  }

  // 2) Loader/plugin-tree failure signals.
  const pluginTree = /plugin tree failed to load/i.test(logText) ||
    /The following plugins? (?:were unable to load|failed to load)/i.test(logText) ||
    /failed to (?:load|mount|apply loader entry)/i.test(logText);

  // 3) Error lines that name the crashing module (file:// URL, quoted token,
  //    path-like spec, or kebab-case bare name). Attribution happens against
  //    patch entry names later, so over-collection is harmless.
  const errLineRe = /^.*\b(?:SyntaxError|TypeError|ReferenceError|ERR_[A-Z0-9_]+|is not a function|is not defined|does not provide an export named|failed to (?:load|mount)|unable to load|Cannot (?:find|read|resolve|parse)|no such file|Cannot find module).*$/gim;
  let line;
  while ((line = errLineRe.exec(logText)) !== null) {
    const l = line[0];
    for (const u of l.matchAll(/file:\/\/[^\s'"()]+/gi)) add(u[0]);
    for (const q of l.matchAll(/['"]([\w@./:\\-]+)['"]/g)) add(q[1]);
    for (const p of l.matchAll(/\b(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:mjs|js|cjs|ts|tsx|jsx)\b/gi)) add(p[0]);
    for (const k of l.matchAll(/\b(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+(?:-[a-z0-9_-]+)+\b/g)) add(k[0]);
    // Unquoted loader names: "loader entry pet", "plugin pet" (covers bare
    // names without hyphens that the kebab pattern above cannot see).
    for (const b of l.matchAll(/(?:loader entry|plugin)\s+([A-Za-z0-9@_.\/-]+)/gi)) add(b[1]);
  }

  return { specifiers: out, pluginTree, cannotFind };
}

/**
 * Parse a cordis.patch.yml into top-level `- insert:` blocks, each with
 * sub-entries [{ id, name, lineStart, lineEnd }] where lineStart/lineEnd are
 * 0-based line indexes covering exactly that entry (its id/name/config lines,
 * NOT the whole block). Returns [] if nothing can be parsed.
 */
function parseHomePatchBlocks(yamlText) {
  const lines = String(yamlText || '').split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- insert:/.test(lines[i])) {
      if (cur) blocks.push(cur);
      cur = { start: i, end: lines.length, entries: [] };
      continue;
    }
    if (!cur) continue;
    const idm = /^\s*-\s+id:\s*(\S+)/.exec(lines[i]);
    if (idm) {
      // Close the previous entry's range at this entry's first line.
      if (cur.entries.length) cur.entries[cur.entries.length - 1].lineEnd = i;
      cur.entries.push({ id: idm[1], name: null, lineStart: i, lineEnd: lines.length });
    } else if (cur.entries.length) {
      const last = cur.entries[cur.entries.length - 1];
      if (last.name === null) {
        const nm = /^\s*name:\s*(.+)$/.exec(lines[i]);
        if (nm) last.name = nm[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
  if (cur) blocks.push(cur);
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].end = i + 1 < blocks.length ? blocks[i + 1].start : lines.length;
  }
  // Trim each entry's range to its last meaningful line (drop trailing blank
  // lines and foreign comment banners so disabling never touches more than
  // the entry itself).
  const meaningful = (l) => l && l.trim() !== '' && !l.trimStart().startsWith('#');
  for (const block of blocks) {
    for (const entry of block.entries) {
      entry.lineEnd = Math.min(entry.lineEnd, block.end);
      while (entry.lineEnd > entry.lineStart + 1 && !meaningful(lines[entry.lineEnd - 1])) entry.lineEnd--;
    }
  }
  return blocks;
}

/** Convert a patch entry `name` to a filesystem path for file:// names (or null). */
function specToPath(name) {
  let s = String(name || '').trim();
  if (!/^file:/i.test(s)) return null;
  if (s.startsWith('file://')) {
    const rest = s.slice('file://'.length).replace(/^\/+/, ''); // file:///C:/... -> C:/...
    try { s = decodeURIComponent(rest); } catch { s = rest; }
  } else {
    try { s = decodeURIComponent(s.slice('file:'.length)); } catch {}
  }
  return s.split('?')[0];
}

/**
 * Whether a patch entry's source is currently loadable:
 *  - file:// name -> the referenced file must exist on disk
 *  - bare name   -> a valid junction/package must exist in one of the profile
 *    layers or the home-level node_modules (upward resolution order)
 */
function pluginSourceAvailable(home, entry) {
  const name = entry && entry.name;
  if (!name) return false;
  if (/^file:/i.test(name)) {
    const p = specToPath(name);
    return !!(p && fs.existsSync(p));
  }
  const bare = name.split('?')[0]; // tolerate a ?v=N cache buster on bare names
  const candidates = ['profiles/web/node_modules', 'profiles/node_modules', 'node_modules'];
  for (const rel of candidates) {
    const link = path.join(home, rel, bare);
    let st;
    try { st = fs.lstatSync(link); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    try { fs.realpathSync(link); return true; } catch { continue; }
  }
  return false;
}

/**
 * Analyze backend failure logs against the home-level patch config.
 * Returns { failing: [specifiers], broken: [{ id, name, reason }] } where
 * `broken` lists patch entries the failure logs point at:
 *  - "Cannot find package/module" mode: entry name matches AND its source is
 *    genuinely unavailable (the direct boot blocker);
 *  - plugin-tree crash mode (the log says the plugin tree failed to load):
 *    entry name matches ANY failing specifier, regardless of source presence —
 *    a plugin whose module CRASHES on load (SyntaxError, missing export,
 *    TypeError during import) is just as much a boot blocker, and was the
 *    class that used to slip past into whole-profiles quarantine.
 */
function analyzeBackendFailure(home, logText) {
  const result = { failing: [], broken: [] };
  const patchPath = path.join(home, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) return result;
  const parsed = failingSpecifiersFromLogs(logText);
  const failing = parsed.specifiers;
  result.failing = [...failing];
  if (!failing.size) return result;

  let yamlText;
  try { yamlText = fs.readFileSync(patchPath, 'utf8'); } catch (e) { log('read patch failed:', e.message); return result; }
  // Crash-mode attribution is only trusted when the log itself says the
  // plugin tree failed; otherwise keep the conservative missing-source rule.
  const useAll = parsed.cannotFind || parsed.pluginTree;
  const seen = new Set();
  for (const block of parseHomePatchBlocks(yamlText)) {
    for (const entry of block.entries) {
      if (!entry.name || seen.has(entry.id)) continue;
      const norm = normalizeSpecifier(entry.name);
      const filePath = specToPath(entry.name);
      const isFailing = failing.has(norm) || (!!filePath && failing.has(normalizeSpecifier(filePath)));
      if (!isFailing) continue;
      const available = pluginSourceAvailable(home, entry);
      if (!useAll && !available) continue; // cannot-find mode: require missing source
      seen.add(entry.id);
      result.broken.push({
        id: entry.id, name: entry.name,
        reason: available ? '插件源码加载时出错（plugin tree failed to load）' : '插件源文件缺失或不可加载'
      });
    }
  }
  return result;
}

/**
 * Detect home-level patch entries that CONFLICT at the Cordis loader level:
 *   1. "duplicate loader entry id: <id>" — the id already exists in dsh-base's
 *      built-in patch (or twice in the user patch). The user-side entry must go.
 *   2. "package <pkg> resolves from multiple active Loader sources" — a bare
 *      package-name entry duplicates a file:// host entry whose package.json
 *      already provides the same client package. The bare-name entry must go.
 * These are config conflicts, not missing sources: profile quarantine and
 * Node repair can never fix them. Returns [{ id, name, reason }].
 */
function analyzeConfigEntryConflicts(home, logText) {
  const out = [];
  if (!logText) return out;
  const patchPath = path.join(home, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) return out;
  let yamlText;
  try { yamlText = fs.readFileSync(patchPath, 'utf8'); } catch { return out; }

  const dupIds = new Set();
  const multiPkgs = new Set();
  let m;
  const dupRe = /duplicate loader entry id:\s*(\S+)/g;
  while ((m = dupRe.exec(logText)) !== null) dupIds.add(m[1]);
  const multiRe = /package (\S+) resolves from multiple active Loader sources/g;
  while ((m = multiRe.exec(logText)) !== null) multiPkgs.add(m[1]);
  if (!dupIds.size && !multiPkgs.size) return out;

  const seen = new Set();
  for (const block of parseHomePatchBlocks(yamlText)) {
    for (const entry of block.entries) {
      if (!entry.id || seen.has(entry.id)) continue;
      let reason = null;
      if (dupIds.has(entry.id)) {
        reason = `loader 条目 id「${entry.id}」与内置或已有条目重复`;
      } else if (entry.name) {
        const bare = entry.name.split('?')[0].replace(/^['"]|['"]$/g, '');
        if (multiPkgs.has(bare)) reason = `前端包「${bare}」被多个加载源同时提供`;
      }
      if (reason) { seen.add(entry.id); out.push({ id: entry.id, name: entry.name, reason }); }
    }
  }
  if (out.length) log('config entry conflicts detected:', out.map((e) => e.id).join(', '));
  return out;
}

/**
 * Comment out ONLY the given plugin entry id(s) inside a cordis.patch.yml —
 * entry-level granularity: sibling entries in the same `- insert:` block are
 * left untouched. Backs the file up first. Returns
 * { disabled: [ids], backup: <path|null> }.
 */
function disablePatchEntriesInFile(patchPath, ids) {
  if (!ids || !ids.length || !fs.existsSync(patchPath)) return { disabled: [], backup: null };

  let yamlText;
  try { yamlText = fs.readFileSync(patchPath, 'utf8'); } catch (e) { log('read patch failed:', e.message); return { disabled: [], backup: null }; }
  const eol = yamlText.includes('\r\n') ? '\r\n' : '\n';
  const lines = yamlText.split(/\r?\n/);
  const blocks = parseHomePatchBlocks(yamlText);
  const want = new Set(ids);
  const hit = new Set();

  for (const block of blocks) {
    let disabledInBlock = 0;
    for (const entry of block.entries) {
      if (!want.has(entry.id)) continue;
      hit.add(entry.id);
      disabledInBlock++;
      for (let i = entry.lineStart; i < entry.lineEnd; i++) {
        const l = lines[i];
        if (l.trimStart().startsWith('#')) continue;
        lines[i] = l.trim() === '' ? '#' : '#' + l; // keep indentation for easy manual restore
      }
    }
    // If EVERY active entry of the block got disabled, comment the block's
    // `- insert:` line too — a bare `- insert:` with nothing under it would
    // become a null insert for the loader.
    if (block.entries.length > 0 && disabledInBlock === block.entries.length) {
      const l = lines[block.start];
      if (l && !l.trimStart().startsWith('#')) lines[block.start] = '#' + l;
    }
  }

  if (!hit.size) return { disabled: [], backup: null };

  const ts = formatDateTimestamp();
  const backup = patchPath + `.disabled-${ts}.bak`;
  try { fs.copyFileSync(patchPath, backup); } catch (e) { log('backup patch failed:', e.message); return { disabled: [], backup: null }; }

  let out = lines.join(eol);
  if (!lines.some((l) => /^\s*- insert:/.test(l))) out += eol + '[]' + eol; // keep a valid (empty) patch array
  try { fs.writeFileSync(patchPath, out); } catch (e) { log('write patch failed:', e.message); return { disabled: [], backup: null }; }

  log(`disabled patch entries in ${path.basename(path.dirname(patchPath))}: ${[...hit].join(', ')} (backup: ${backup})`);
  return { disabled: [...hit], backup };
}

/**
 * Comment out the given plugin entries in the HOME-level cordis.patch.yml
 * (entry-level granularity), after backing the file up.
 */
function disableBrokenPatchPlugins(home, brokenEntries) {
  const patchPath = path.join(home, 'cordis.patch.yml');
  const ids = (brokenEntries || []).map((e) => e && e.id).filter(Boolean);
  return disablePatchEntriesInFile(patchPath, ids);
}

// --------------------------------------------------------------------------
// boot-time pre-flight: ONE-PASS loader id conflict scan
// The Cordis loader fails fast on the FIRST duplicate id it meets, so healing
// via crash-retry surfaces one conflict per boot (2026-09-08 incident:
// web-fetch-http on first boot, comfyui-bridge only on retry). This scan
// catches every future cold-start conflict up front, before the first spawn.
// --------------------------------------------------------------------------

/** Entry ids declared by the ACTIVE dsh-base bundle patch (the builtin set). */
function builtinPatchIds() {
  const ids = new Set();
  try {
    // P().dshPkg = <backend>/dsh/node_modules/@deepseek-ai/dsh/package.json
    // dsh-base is a SIBLING package of dsh under the same @deepseek-ai scope.
    const basePatch = path.join(path.dirname(path.dirname(P().dshPkg)), 'dsh-base', 'cordis.patch.yml');
    if (fs.existsSync(basePatch)) {
      const text = fs.readFileSync(basePatch, 'utf8');
      for (const m of text.matchAll(/^\s*-\s+id:\s*(\S+)/gm)) ids.add(m[1]);
    }
  } catch (e) { log('read base patch failed:', e.message); }
  return ids;
}

/** Bundles registered per profile: Map(profileName -> Set(packageName)). */
function profileBundles(home) {
  const out = new Map();
  const profilesDir = path.join(home, 'profiles');
  let dirs = [];
  try { dirs = fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const name of dirs) {
    if (name === 'node_modules') continue;
    const pkg = readJson(path.join(profilesDir, name, 'package.json'), null);
    const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (bundles.length) out.set(name, new Set(bundles.map(String)));
  }
  return out;
}

/**
 * Pre-flight scan for loader id conflicts that WILL crash the next cold start:
 *   a) patch entry id already declared builtin by the active dsh-base patch
 *      (e.g. web-fetch-http after dsh-base absorbed it)
 *   b) the same id declared twice in one patch file
 *   c) a patch entry whose package name is ALSO registered as a profile
 *      bundle — double registration via manual patch + official
 *      `dsh plugin add` (e.g. comfyui-bridge incident)
 * Home-patch entries are checked against every profile's bundles (the home
 * patch applies to all profiles); a profile patch only against its own.
 * Returns [{ file, id, name, reason }].
 */
function findLoaderIdConflicts() {
  const out = [];
  const home = dshHome();
  const baseIds = builtinPatchIds();
  const bundles = profileBundles(home);
  const allBundlePkgs = new Set();
  for (const set of bundles.values()) for (const b of set) allBundlePkgs.add(b);
  const homePatchPath = path.join(home, 'cordis.patch.yml');
  const profilesDir = path.join(home, 'profiles');

  const patchFiles = [homePatchPath];
  try {
    for (const d of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'node_modules') continue;
      patchFiles.push(path.join(profilesDir, d.name, 'cordis.patch.yml'));
    }
  } catch {}

  for (const patchPath of patchFiles) {
    if (!fs.existsSync(patchPath)) continue;
    let yamlText;
    try { yamlText = fs.readFileSync(patchPath, 'utf8'); } catch { continue; }
    const isHome = patchPath === homePatchPath;
    const profileName = isHome ? null : path.basename(path.dirname(patchPath));
    const ownBundles = isHome ? allBundlePkgs : (bundles.get(profileName) || new Set());
    const seenInFile = new Map();
    for (const block of parseHomePatchBlocks(yamlText)) {
      for (const entry of block.entries) {
        if (!entry.id) continue;
        const prev = (seenInFile.get(entry.id) || 0) + 1;
        seenInFile.set(entry.id, prev);
        if (baseIds.has(entry.id)) {
          out.push({ file: patchPath, id: entry.id, name: entry.name, reason: `条目 id「${entry.id}」已由 DSH 内置提供，重复声明会让启动直接失败` });
        } else if (prev > 1) {
          out.push({ file: patchPath, id: entry.id, name: entry.name, reason: `条目 id「${entry.id}」在同一文件里声明了两次` });
        } else if (entry.name) {
          const bare = entry.name.split('?')[0].replace(/^['"]|['"]$/g, '');
          if (bare && ownBundles.has(bare)) {
            out.push({ file: patchPath, id: entry.id, name: entry.name, reason: `插件「${bare}」已通过官方通道安装（profile bundle），补丁里再注册一次会冲突` });
          }
        }
      }
    }
  }
  if (out.length) log('pre-flight loader id conflicts:', out.map((c) => `${c.id}(${c.reason})`).join(' | '));
  return out;
}

/**
 * Apply entry-level disables for pre-flight conflicts, grouped per file.
 * Returns { fixed: [{ file, ids, backup }] }.
 */
function applyLoaderConflictFixes(conflicts) {
  const byFile = new Map();
  for (const c of conflicts || []) {
    if (!c || !c.file || !c.id) continue;
    if (!byFile.has(c.file)) byFile.set(c.file, new Set());
    byFile.get(c.file).add(c.id);
  }
  const fixed = [];
  for (const [file, ids] of byFile) {
    const res = disablePatchEntriesInFile(file, [...ids]);
    if (res.disabled.length) fixed.push({ file, ids: res.disabled, backup: res.backup });
  }
  return { fixed };
}

/**
 * Node-style upward resolution check: does <name> exist as a directory in any
 * node_modules on the walk-up chain from `dir`? This is the necessary
 * condition for `import '<name>'` to resolve — if no such directory exists
 * anywhere, the import is guaranteed to fail with ERR_MODULE_NOT_FOUND (no
 * false positives; package.json/exports subtleties are out of scope).
 */
function resolvesFromDir(dir, name) {
  const segs = String(name).split('/');
  let cur = path.resolve(dir);
  for (;;) {
    let st = null;
    try { st = fs.statSync(path.join(cur, 'node_modules', ...segs)); } catch {}
    if (st && st.isDirectory()) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/**
 * Find a REAL directory (not a link) directly under modulesDir whose
 * package.json declares the given package name — i.e. a hand-copied install
 * whose directory name does not match its package name.
 */
function findRealDirByPackageName(modulesDir, pkgName) {
  let entries;
  try { entries = fs.readdirSync(modulesDir); } catch { return null; }
  for (const entry of entries) {
    if (entry.startsWith('@')) continue;
    const full = path.join(modulesDir, entry);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const pj = readJson(path.join(full, 'package.json'), null);
    if (pj && typeof pj.name === 'string' && pj.name === pkgName) return full;
  }
  return null;
}

/**
 * Pre-flight: verify every active patch entry that references a package by
 * BARE NAME actually resolves from the profile directories. An unresolvable
 * bare name is a guaranteed cold-start crash (ERR_MODULE_NOT_FOUND → plugin
 * tree failed to load — the 9/8 15:32 bot-gateway incident: a local tgz
 * install had copied the plugin to a real dir named `bot-gateway` while the
 * patch entry referenced the bare package name `dsh-bot-gateway`).
 *
 * Auto-repair: when the package exists as a misnamed real directory under
 * home node_modules, create a correctly-named junction — the plugin keeps
 * working instead of being disabled. Otherwise the entry is reported broken
 * (the caller disables it entry-level, with backup).
 *
 * Returns { repaired: [{id, name, junction, target}], broken: [{file, id, name, reason}] }.
 */
function preflightBareNameResolution() {
  const out = { repaired: [], broken: [] };
  const home = dshHome();
  const homePatchPath = path.join(home, 'cordis.patch.yml');
  const profilesDir = path.join(home, 'profiles');

  // Profile directories the loader imports from (must contain package.json).
  const profileDirs = [];
  try {
    for (const d of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'node_modules') continue;
      const dir = path.join(profilesDir, d.name);
      if (fs.existsSync(path.join(dir, 'package.json'))) profileDirs.push(dir);
    }
  } catch {}
  if (!profileDirs.length) return out;

  // Active entries with bare package names from home + profile patches.
  // file:// URLs and scheme forms (npm:…) are not bare imports — skip them.
  const entries = [];
  for (const patchPath of [homePatchPath, ...profileDirs.map((d) => path.join(d, 'cordis.patch.yml'))]) {
    if (!fs.existsSync(patchPath)) continue;
    let yamlText;
    try { yamlText = fs.readFileSync(patchPath, 'utf8'); } catch { continue; }
    for (const block of parseHomePatchBlocks(yamlText)) {
      for (const e of block.entries) {
        if (!e.name) continue;
        const n = String(e.name).trim();
        if (!n || n.includes(':') || n.includes('?') || n.startsWith('.') || n.startsWith('/') || n.startsWith('\\')) continue;
        entries.push({ file: patchPath, id: e.id, name: n });
      }
    }
  }

  for (const e of entries) {
    if (profileDirs.some((dir) => resolvesFromDir(dir, e.name))) continue;
    // Unresolvable — try to auto-repair from a misnamed real-dir install.
    const junctionPath = path.join(home, 'node_modules', e.name);
    if (!fs.existsSync(junctionPath)) {
      const realDir = findRealDirByPackageName(path.join(home, 'node_modules'), e.name);
      if (realDir) {
        try {
          fs.symlinkSync(realDir, junctionPath, 'junction');
          out.repaired.push({ id: e.id, name: e.name, junction: junctionPath, target: realDir });
          log(`pre-flight auto-repair: junction ${e.name} -> ${realDir} (directory name did not match package name)`);
          continue;
        } catch (err) {
          log(`pre-flight auto-repair failed for ${e.name}: ${err.message}`);
        }
      }
    }
    out.broken.push({ file: e.file, id: e.id, name: e.name, reason: `包「${e.name}」在 node_modules 解析链里不存在，冷启动必然失败` });
  }
  if (out.broken.length) log('pre-flight unresolvable bare names:', out.broken.map((b) => b.name).join(', '));
  return out;
}

/**
 * Compare a version string's leading major.minor.patch against [maj, min, pat].
 * Prerelease tags are ignored ("0.1.3-alpha.2" counts as 0.1.3).
 */
function versionAtLeast(v, want) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  if (!m) return false;
  const a = [+m[1], +m[2], +m[3]];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== want[i]) return a[i] > want[i];
  }
  return true;
}

/**
 * dsh 0.1.3-alpha changed the @deepseek-ai/dsh-persona config contract: the
 * old `text:` field was replaced by a REQUIRED `prefix:` (plus optional
 * `suffix:`). Agent presets written for the old schema then fail to mount
 * with `$.prefix missing required value`, breaking session resume until the
 * files are edited by hand (9/8 17:xx incident). This migration renames
 * `text:` to `prefix:` inside dsh-persona entries of the home dir's custom
 * agent presets — line-based (indentation and block-scalar style preserved),
 * per-file backup, idempotent. Only runs when the ACTIVE backend ships the
 * new contract (dsh-persona >= 0.1.3).
 * Returns { migrated: [files], backups: {file: backup} }.
 */
function migrateAgentPresetPersonaText() {
  const out = { migrated: [], backups: {} };
  const home = dshHome();

  let personaVersion = '';
  try {
    const pj = readJson(path.join(path.dirname(path.dirname(P().dshPkg)), 'dsh-persona', 'package.json'), null);
    if (pj && typeof pj.version === 'string') personaVersion = pj.version;
  } catch {}
  if (!versionAtLeast(personaVersion, [0, 1, 3])) {
    log(`agent-preset persona migration skipped: backend dsh-persona ${personaVersion || 'unknown'} predates the prefix contract`);
    return out;
  }

  const presetsDir = path.join(home, '.agent-presets');
  let dirs = [];
  try { dirs = fs.readdirSync(presetsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  const ts = formatDateTimestamp();
  for (const name of dirs) {
    const file = path.join(presetsDir, name, 'agent.cordis.yml');
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);

    // Walk loader entries; inside a dsh-persona entry's config block, rename
    // the old `text:` key (a direct child of config:) to `prefix:`.
    let entryIndent = -1;
    let inPersona = false;
    let configIndent = -1;
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*#/.test(l) || l.trim() === '') continue;
      const indent = l.length - l.trimStart().length;
      const entryStart = /^(\s*)-\s+(?:id|name):\s/.exec(l);
      if (entryStart) {
        entryIndent = indent;
        inPersona = /@deepseek-ai\/dsh-persona\b/.test(l);
        configIndent = -1;
        continue;
      }
      if (indent === entryIndent + 2) {
        const nameM = /^\s*name:\s*(.+)$/.exec(l);
        if (nameM && /@deepseek-ai\/dsh-persona\b/.test(nameM[1])) { inPersona = true; continue; }
        if (inPersona && /^\s*config:\s*$/.test(l)) { configIndent = indent; continue; }
      }
      if (inPersona && configIndent >= 0 && indent === configIndent + 2) {
        if (/^(\s*)text:\s/.test(l)) {
          lines[i] = l.replace(/^(\s*)text:/, '$1prefix:');
          changed = true;
        }
      }
    }

    if (!changed) continue;
    const backup = file + `.persona-migrate-${ts}.bak`;
    try {
      fs.copyFileSync(file, backup);
      fs.writeFileSync(file, lines.join(eol));
      out.migrated.push(file);
      out.backups[file] = backup;
      log(`migrated agent preset persona text->prefix: ${name} (backup: ${backup})`);
    } catch (e) {
      log(`agent preset migration write failed ${file}: ${e.message}`);
    }
  }
  return out;
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
async function stageDsh(callbacks = {}, requestedVersion = null) {
  const p = P();
  const say = (m) => callbacks.onLog && callbacks.onLog(m);
  const info = requestedVersion ? { version: requestedVersion, source: 'github', changes: [] } : await latestDshInfo();
  const latest = info.version;
  // 显式指定版本：先校核 npm 是否已发布该版本，避免必然失败的下载。
  if (requestedVersion) {
    let published = null;
    try { published = await npmDshPublished(); } catch (e) { say(`npm 版本校核失败（${e.message}），仍将尝试下载…`); }
    if (published && !published.versions.includes(requestedVersion)) {
      throw new Error(`版本 ${requestedVersion} 尚未发布到 npm 镜像（npm 当前最新 ${published.latest}），无法下载安装。`);
    }
  }
  const staged = stagedVersions().dsh;
  if (staged && compareSemver(staged, latest) >= 0) {
    log(`dsh version ${staged} is already staged (latest=${latest}); reusing`);
    say(`最新 DSH 后端 (${staged}) 已在暂存区，无需重复下载。`);
    return { version: staged, reused: true, changes: info.changes || [] };
  }
  if (!fs.existsSync(p.nodeExe) || !fs.existsSync(p.npmCli)) throw new Error('缺少 node/npm，无法更新后端。');
  rimraf(p.dshNew); mkdirp(p.dshNew);
  writeJson(path.join(p.dshNew, 'package.json'), { name: 'dsh-active-backend', version: '0.0.0', private: true, dependencies: { '@deepseek-ai/dsh': latest } });
  say(`正在下载并安装 DSH 后端 ${latest}（${info.source === 'github' ? 'GitHub 版本，npm 下载' : 'npm'}，依赖较多，请稍候）…`);
  try {
    await run(p.nodeExe, [p.npmCli, 'install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${npmRegistryUrl()}`, '--no-bin-links'], {
      cwd: p.dshNew,
      env: buildDedicatedEnv(),
      onOutput: (s) => { const l = s.trim(); if (l && l.includes('packages')) say(l); }
    });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/ETARGET|No matching version found/i.test(msg)) {
      // 2026-09-08 晚上事故：dsh@0.1.5-alpha.1 在 npmmirror 上存在，但其依赖
      // dsh-fs-local@^0.1.5-alpha.1 尚未同步 → ETARGET → 整个安装回滚。给出可
      // 操作的提示，而不是一句冷冰冰的 npm 报错。
      throw new Error('下载失败：当前更新路线「' + registryInfo().label + '」尚未同步该版本的完整依赖（ETARGET）。\n' +
        '可在托盘「设置」中把更新路线切换到「官方站（npmjs）」后重试，或稍等镜像同步（通常几小时）后再试。\n\n' + msg);
    }
    throw e;
  }
  const newBin = path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(newBin)) { rimraf(p.dshNew); throw new Error('后端暂存安装后未找到 dsh，已放弃（当前版本不受影响）。'); }
  const ver = readJson(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {}).version || null;
  log('staged dsh', ver);
  return { version: ver, reused: false, changes: info.changes || [], source: info.source };
}

/**
 * List every installable Node version for rollback/selection: same pinned major
 * (native-module ABI alignment) and at least DSH's minimum requirement.
 */
async function listNodeVersions() {
  const idx = await fetchJson(`${nodeDistBase()}/index.json`);
  const min = minNodeForDsh();
  const re = new RegExp(`^v${PINNED_NODE_MAJOR}\\.\\d+\\.\\d+$`);
  return (Array.isArray(idx) ? idx : [])
    .filter((e) => e && e.version && re.test(e.version))
    .map((e) => e.version.slice(1))
    .filter((v) => nodeMeetsRequirement(v, min))
    .sort((a, b) => compareSemver(b, a));
}

/**
 * DSH 后端某版本声明的 Node 运行时要求（feature3 用）：engines.node 缺失时
 * 回退 FALLBACK_MIN_NODE。返回 { version, required, declared, source, current, ok }。
 */
async function backendEnginesFor(version) {
  let declared = null; let source = 'fallback';
  try {
    const doc = await fetchJson(`${npmRegistryUrl()}/@deepseek-ai%2Fdsh/${encodeURIComponent(version)}`);
    declared = doc && doc.engines && typeof doc.engines.node === 'string' ? doc.engines.node : null;
    source = declared ? 'engines' : 'fallback';
  } catch { source = 'fallback'; }
  const nums = [...String(declared || '').matchAll(/(\d+)\.(\d+)\.(\d+)/g)].map((x) => `${x[1]}.${x[2]}.${x[3]}`);
  const required = highestSemver([...nums, FALLBACK_MIN_NODE]);
  const current = nodeVersion(P().nodeExe);
  return { version, required, declared, source, current, ok: nodeMeetsRequirement(current, required) };
}

/** npm 上全部已发布版本（倒序）+ 最新 + 各版本 engines.node 声明。 */
async function npmDshVersionsAll() {
  const { versions, latest, engines } = await npmDshPublished();
  return { all: [...versions].sort((a, b) => compareSemver(b, a)), latest, engines: engines || {} };
}

async function stageNode(callbacks = {}, requestedVersion = null) {
  const p = P();
  const say = (m) => callbacks.onLog && callbacks.onLog(m);
  const progress = (f) => callbacks.onProgress && callbacks.onProgress(f);
  const latest = requestedVersion || await latestNodeVersion();
  if (requestedVersion) {
    const allowed = await listNodeVersions();
    if (!allowed.includes(requestedVersion)) {
      throw new Error(`Node v${requestedVersion} 不在可安装列表（需为 Node v${PINNED_NODE_MAJOR}.x 且 ≥ ${minNodeForDsh()}）。可选：${allowed.slice(0, 6).join(', ')}${allowed.length > 6 ? ' …' : ''}`);
    }
  }
  const staged = stagedVersions().node;
  if (!requestedVersion && staged && compareSemver(staged, latest) >= 0) {
    log(`node version ${staged} is already staged (latest=${latest}); reusing`);
    say(`最新 Node 运行时 (${staged}) 已在暂存区，无需重复下载。`);
    return { version: staged, reused: true };
  }
  const zipName = `node-v${latest}-win-x64.zip`;
  const url = `${nodeDistBase()}/v${latest}/${zipName}`;
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

// --------------------------------------------------------------------------
// BACKEND VERSION SELECTION & ROLLBACK ANALYSIS (0.3.31)
// --------------------------------------------------------------------------
/** npm 包型插件的本机 manifest（file:// 本地 .mjs 插件无 manifest）。 */
function pluginManifestOf(name, home) {
  const bare = String(name || '').split('?')[0].trim();
  if (!bare || /^file:/i.test(bare)) return null;
  const candidates = [path.join(home, 'profiles', 'web', 'node_modules'), path.join(home, 'profiles', 'node_modules'), path.join(home, 'node_modules')];
  for (const rel of candidates) {
    const link = path.join(rel, bare);
    let st; try { st = fs.lstatSync(link); } catch { continue; }
    let real;
    try { real = st.isSymbolicLink() ? fs.realpathSync(link) : link; } catch { continue; }
    try {
      const m = readJson(path.join(real, 'package.json'), null);
      if (m) return { dir: real, manifest: m };
    } catch {}
  }
  return null;
}

/** plugins-store/plugin-manager.json 记录（entryId → 插件版本/安装时间）。 */
function readPluginManager(home) {
  try {
    const list = readJson(path.join(home, 'plugins-store', 'plugin-manager.json'), []);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/**
 * 分析把后端回退到 targetVersion 时各插件的可用性（feature4）。
 * 判定口径（如实分级，绝不臆断）：
 *  - 源文件缺失 → 不可用（硬性）
 *  - 插件 manifest 声明了对 dsh 的版本约束（dshVersion / peerDependencies.dsh /
 *    dependencies.dsh）且目标不满足 → 不兼容（声明违反）
 *  - 目标 === 当前版本 → 兼容
 *  - 其余（无声明约束且目标≠当前）→ 未验证（兼容性未知，诚实提示）
 */
async function analyzeBackendRollback(targetVersion) {
  const home = dshHome();
  const current = currentVersions().dsh;
  let targetEngines = null;
  try { targetEngines = await backendEnginesFor(targetVersion); } catch {}
  const manager = readPluginManager(home);
  const rows = pluginEntries(home).map((e) => {
    const rec = manager.find((r) => (r.entryId && e.id && r.entryId === e.id) || (r.packageName && r.packageName === String(e.name).split('?')[0]));
    const pkg = pluginManifestOf(e.name, home);
    const m = pkg && pkg.manifest;
    // 可用性判定：file:// 看文件是否存在；裸名看能否解析到 manifest（真实目录与
    // junction 均算可用——2026-09-08 布局修复后 home/node_modules 下以真实目录
    // 存放，pluginSourceAvailable 只认 junction 会误报缺失）。
    let srcExists = false;
    if (/^file:/i.test(String(e.name))) {
      const sp = specToPath(e.name);
      srcExists = !!(sp && fs.existsSync(sp));
    } else {
      srcExists = !!pkg;
    }
    let compatible = null; let reason = '';
    if (!srcExists) {
      compatible = false; reason = '插件源文件缺失或不可加载';
    } else {
      const dshConst = m && (m.dshVersion || (m.peerDependencies && m.peerDependencies['@deepseek-ai/dsh']) || (m.dependencies && m.dependencies['@deepseek-ai/dsh']));
      if (dshConst) {
        const want = String(dshConst).replace(/^[<>=^~ ]+/, '');
        const okVer = compareSemver(targetVersion, want) >= 0;
        compatible = okVer; reason = okVer ? `声明要求 dsh ≥ ${want}，目标满足` : `声明要求 dsh ≥ ${want}，目标 ${targetVersion} 不满足`;
      } else if (targetVersion === current) {
        compatible = true; reason = '目标即当前版本';
      } else {
        compatible = null; reason = '未声明 dsh 版本约束，与目标版本的兼容性未经验证';
      }
    }
    return {
      name: e.name, id: e.id, available: srcExists,
      installed: rec ? { version: rec.version, installedAt: rec.installedAt } : null,
      nodeEngine: m && m.engines && m.engines.node ? m.engines.node : null,
      compatible, reason
    };
  });
  const summary = {
    total: rows.length,
    incompatible: rows.filter((r) => r.compatible === false).length,
    unverified: rows.filter((r) => r.compatible === null).length,
    compatible: rows.filter((r) => r.compatible === true).length
  };
  return { target: targetVersion, current, analyzedAt: new Date().toISOString(), targetEngines, summary, rows };
}

/** 把兼容性分析结果导出到桌面（一次一文件，时间戳命名）。 */
function exportBackendCompatReport(plan) {
  const desktop = require('./diag-log').desktopDir();
  mkdirp(desktop);
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 17);
  const file = path.join(desktop, `DSH-Desktop-回退兼容报告-${plan.target}-${stamp}.txt`);
  const lines = [];
  lines.push('DSH 后端回退兼容性报告');
  lines.push('='.repeat(46));
  lines.push(`目标后端版本：${plan.target}`);
  lines.push(`当前后端版本：${plan.current || '未知'}`);
  lines.push(`分析时间：${plan.analyzedAt}`);
  if (plan.targetEngines) {
    lines.push(`目标后端 Node 要求：${plan.targetEngines.declared ? plan.targetEngines.declared : `（未声明，按兜底 ≥ ${plan.targetEngines.required}）`}；当前 Node ${plan.targetEngines.current || '无'}${plan.targetEngines.ok ? ' 满足' : ' 不满足（建议先更新 Node）'}`);
  }
  lines.push(`插件数：${plan.summary.total}（可用 ${plan.summary.compatible} / 不可用 ${plan.summary.incompatible} / 未验证 ${plan.summary.unverified}）`);
  lines.push('-' .repeat(46));
  const stateLabel = (r) => (r.compatible === false ? '不可用' : r.compatible === null ? '未验证' : '兼容');
  for (const r of plan.rows) {
    lines.push(`[${stateLabel(r)}] ${r.name}${r.installed ? ` (v${r.installed.version}, ${String(r.installed.installedAt || '').slice(0, 10)}安装)` : ''}`);
    lines.push(`    ${r.reason}${r.nodeEngine ? `；插件声明 Node ≥ ${r.nodeEngine}` : ''}`);
  }
  lines.push('');
  lines.push('说明：仅有明确声明约束的违例判为「不可用」；「未验证」表示插件未声明对 dsh 版本的依赖，回退后可能需要验证。');
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return file;
}

function rollbackDsh() {
  const p = P();
  if (!fs.existsSync(path.join(p.dshPrevious, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return false;
  const failed = path.join(p.root, 'dsh.failed');
  rimraf(failed);
  if (fs.existsSync(p.dshDir)) fs.renameSync(p.dshDir, failed);
  fs.renameSync(p.dshPrevious, p.dshDir);
  rimraf(failed);
  const cur = currentVersions();
  writeJson(p.versionsJson, { ...readJson(p.versionsJson, {}), ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v)) });
  log('rolled back dsh to', cur.dsh);
  return true;
}

// Apply anything staged. Runs BEFORE the backend is spawned (so nothing is locked).
function applyStaged() {
  const p = P();
  const applied = { dsh: null, node: null };
  const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

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
      rimraf(p.nodeNew); // discard staging only after a confirmed successful apply
    } catch (e) {
      // Keep node.new so the update is retried on the next launch.
      log('apply staged node failed (node.new kept for next launch):', e.message);
    }
  }

  // Dsh backend: swap dshDir with dshNew. Retried because a just-killed
  // backend (or antivirus) can transiently hold locks on the old tree.
  if (fs.existsSync(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    let swapped = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 4 && !swapped; attempt++) {
      try {
        const oldBackup = path.join(p.root, 'dsh.old');
        rimraf(oldBackup);
        if (fs.existsSync(p.dshDir)) fs.renameSync(p.dshDir, oldBackup);
        try {
          fs.renameSync(p.dshNew, p.dshDir);
        } catch (midSwap) {
          // Restore the first rename so the next attempt starts from a clean state.
          if (!fs.existsSync(p.dshDir) && fs.existsSync(oldBackup)) fs.renameSync(oldBackup, p.dshDir);
          throw midSwap;
        }
        swapped = true;
        // Retain the previous version for rollback after startup health checks.
        rimraf(p.dshPrevious);
        if (fs.existsSync(oldBackup)) { try { fs.renameSync(oldBackup, p.dshPrevious); } catch { rimraf(oldBackup); } }
      } catch (e) {
        lastErr = e;
        log(`apply staged dsh attempt ${attempt} failed: ${e.message}`);
        if (attempt < 4) sleepSync(900);
      }
    }
    if (!swapped) {
      // Last resort: copy new over old. dsh.new is kept if this fails too.
      try {
        copyDir(p.dshNew, p.dshDir);
        rimraf(p.dshNew);
        swapped = true;
        log('applied staged dsh via copy fallback');
      } catch (e) {
        log('apply staged dsh failed; dsh.new kept for next launch:', (e && e.message) || (lastErr && lastErr.message));
      }
    }
    if (swapped) { applied.dsh = dshVersion(); log('applied staged dsh', applied.dsh); }
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
  const requested = requestedBackendVersion();
  const cur = currentVersions();
  const staged = stagedVersions();
  const result = { current: cur, latest: { npm: cur.npm }, updates: [], pending: [], errors: [], changes: {} };
  const tasks = [
    { key: 'dsh', fn: latestDshVersion }
  ];
  if (includeNode) {
    tasks.push({ key: 'node', fn: latestNodeVersion });
  }
  await Promise.all(tasks.map(async (t) => {
    try {
      const details = t.key === 'dsh' ? (requested ? { version: requested, changes: [], source: 'installer-selection' } : await latestDshInfo()) : { version: await t.fn(), changes: [] };
      const latest = details.version;
      result.latest[t.key] = latest;
      result.changes[t.key] = details.changes || [];
      const currentVer = cur[t.key] || null;
    if (requested && t.key === 'dsh' && currentVer && compareSemver(requested, currentVer) === 0) {
      result.latest[t.key] = requested;
      result.changes[t.key] = [];
      return;
    }
    if (!currentVer || compareSemver(latest, currentVer) > 0) {
        const stagedVer = staged[t.key];
        if (stagedVer && compareSemver(stagedVer, latest) >= 0) {
          result.pending.push({ component: t.key, current: currentVer, latest, staged: stagedVer });
        } else {
          result.updates.push({ component: t.key, current: currentVer, latest, changes: details.changes || [] });
        }
      }
    } catch (e) { result.errors.push({ component: t.key, error: e.message }); }
  }));
  return result;
}

// --------------------------------------------------------------------------
// PLUGIN INSTALL / TERMINAL WIRING / LEGACY HOME IMPORT (0.3.32)
//
// 问题背景：桌面版把后端隔离在 userData/dsh-home（buildDedicatedEnv 会主动剥离
// 继承的 DSH_HOME），而用户在普通终端里跑的 `dsh`（npm 全局装）默认 DSH_HOME 是
// ~/.dsh。照 README 直接敲 `dsh plugin --profile web add X` 会装进旧 home，桌面版
// 永远加载不到。这里提供三条根治通道 + 一条止血通道：
//   ① installPluginViaCli()  —— 应用内安装，用桌面自带 node+dsh+dedicated env，
//      DSH_HOME 天然正确，分发用户无需装 CLI、无需碰终端。
//   ② writeWrapperScripts()  —— 生成 dsh-desktop.cmd / dsh.cmd 到 userData/bin，
//      脚本内部固定 DSH_HOME 并调用桌面版 node + dsh 入口；可加入用户 PATH。
//   ③ DSH_HOME 用户级环境变量（智能默认）—— 无旧 ~/.dsh 的干净机器首启自动写入，
//      让 README 原文命令也落到桌面 home；已有旧 home 的机器只在设置窗给开关。
//   ④ scanLegacyHome()/importLegacyPlugins() —— 扫描旧 home 中桌面版看不见的插件，
//      勾选后走 ① 的正规流程装进桌面 home（一次性止血）。
// --------------------------------------------------------------------------

/** 旧 CLI 默认 home（~/.dsh）。 */
function legacyHomePath() {
  const profile = process.env.USERPROFILE || os.homedir();
  return path.join(profile, '.dsh');
}

/** profile 的 package.json 路径（web / 其他 profile 同构）。 */
function profilePkgPath(home, profile = 'web') {
  return path.join(home, 'profiles', profile, 'package.json');
}

/**
 * 读取某个 home 的插件注册表。dsh plugin add 实际写两处：
 *   dependencies（pnpm 装包）与 dsh.profile.bundles（加载登记）——
 * 后者才决定"会不会被加载"，所以以 bundles 为准，dependencies 提供版本号。
 */
function readProfileRegistry(home, profile = 'web') {
  const pkg = readJson(profilePkgPath(home, profile), null);
  if (!pkg) return null;
  const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : [];
  return { pkg, bundles, deps: pkg.dependencies || {} };
}

/** dsh 自带的基础 bundle，不属于"用户安装的插件"，扫描时排除。 */
const BASE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

/**
 * 扫描旧 home（默认 ~/.dsh）里桌面版看不到的插件。
 * 返回 { exists, home, profile, orphans: [{ name, version, spec, kind, installed }], total }
 * kind: 'npm'（可正常重装）| 'link'（link:/file: 本地依赖，需用户自行处理）
 */
function scanLegacyHome(legacyHome = null, profile = 'web') {
  const home = legacyHome || legacyHomePath();
  const out = { exists: false, home, profile, orphans: [], total: 0, sameAsDesktop: false };
  const desktopHome = dshHome();
  if (path.resolve(home).toLowerCase() === path.resolve(desktopHome).toLowerCase()) {
    out.sameAsDesktop = true;
    return out;
  }
  if (!fs.existsSync(home)) return out;
  out.exists = true;
  const legacy = readProfileRegistry(home, profile);
  if (!legacy) return out;
  const desktop = readProfileRegistry(desktopHome, profile) || { bundles: [], deps: {} };
  const have = new Set(desktop.bundles.map((b) => String(b)));
  for (const name of legacy.bundles) {
    const bare = String(name);
    if (BASE_BUNDLES.has(bare) || have.has(bare)) continue;
    const declared = legacy.deps[bare] ? String(legacy.deps[bare]) : '';
    const isLink = /^(link:|file:)/i.test(declared);
    // 已装在旧 home 的实际版本（优先读包自己的 package.json，最准）
    let installed = null;
    try {
      const m = readJson(path.join(home, 'profiles', profile, 'node_modules', bare, 'package.json'), null);
      if (m && m.version) installed = String(m.version);
    } catch {}
    out.orphans.push({
      name: bare,
      version: installed || declared.replace(/^[\^~]/, '') || null,
      declared: declared || null,
      spec: isLink ? declared : (installed ? `${bare}@${installed}` : bare),
      kind: isLink ? 'link' : 'npm',
      installable: !isLink
    });
  }
  out.total = out.orphans.length;
  return out;
}

/** 旧 home 是否"有人在用"（决定 DSH_HOME 环境变量的智能默认）。 */
function legacyHomeInUse() {
  const home = legacyHomePath();
  if (!fs.existsSync(home)) return false;
  // 有注册过插件、有会话、或有凭据 → 视为用户在独立使用 CLI，不擅自改其 DSH_HOME
  try {
    const reg = readProfileRegistry(home, 'web');
    if (reg && reg.bundles.some((b) => !BASE_BUNDLES.has(String(b)))) return true;
  } catch {}
  for (const rel of ['sessions', '.credentials.yaml', 'settings.yaml']) {
    try {
      const full = path.join(home, rel);
      if (!fs.existsSync(full)) continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) { if (fs.readdirSync(full).length > 0) return true; }
      else if (st.size > 0) return true;
    } catch {}
  }
  return false;
}

// ---- 用户级环境变量（HKCU\Environment）读写 -------------------------------
function regQueryUserEnv(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      // 变量不存在时 reg.exe 会往 stderr 打印本地化错误（GBK 编码，在 Electron
      // 控制台显示为乱码）——那是正常的"未设置"信号而非故障，吞掉 stderr。
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    // 形如：    DSH_HOME    REG_SZ    C:\path
    const m = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toUpperCase().startsWith(name.toUpperCase() + ' '));
    if (!m) return null;
    const parts = m.split(/\s{2,}/);
    if (parts.length < 3) return null;
    return { type: parts[1], value: parts.slice(2).join('    ') };
  } catch { return null; }
}

function regSetUserEnv(name, value, type = 'REG_SZ') {
  execFileSync('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', type, '/d', value, '/f'], { encoding: 'utf8', windowsHide: true });
  broadcastEnvChange();
}

function regDeleteUserEnv(name) {
  try {
    execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    if (!/找不到|cannot find|unable to find/i.test(String(e && (e.stderr || e.message)))) throw e;
  }
  broadcastEnvChange();
}

/**
 * 广播 WM_SETTINGCHANGE，让新开的终端/资源管理器立刻看到环境变量变化
 * （不广播的话只有重启后的进程才能看到）。失败不影响写入本身。
 */
function broadcastEnvChange() {
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "$s='using System;using System.Runtime.InteropServices;public class DshEnv{[DllImport(\"user32.dll\",SetLastError=true,CharSet=CharSet.Auto)]public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,UIntPtr wParam,string lParam,uint fuFlags,uint uTimeout,out UIntPtr lpdwResult);public static void Broadcast(){UIntPtr r;SendMessageTimeout((IntPtr)0xffff,0x1A,UIntPtr.Zero,\"Environment\",2,1000,out r);}}';Add-Type -TypeDefinition $s;[DshEnv]::Broadcast()"
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  } catch (e) { log('broadcast env change failed (harmless):', e && e.message); }
}

/** DSH_HOME 用户级环境变量当前状态 + 智能默认建议。 */
function dshHomeEnvStatus() {
  const desired = dshHome();
  const cur = regQueryUserEnv('DSH_HOME');
  const legacyBusy = legacyHomeInUse();
  const pointsHere = !!(cur && path.resolve(cur.value).toLowerCase() === path.resolve(desired).toLowerCase());
  return {
    desired,
    current: cur ? cur.value : null,
    set: !!cur,
    pointsHere,
    legacyHome: legacyHomePath(),
    legacyInUse: legacyBusy,
    // 智能默认：干净机器（无旧 home 在用）才自动写入
    autoEligible: !legacyBusy,
    autoApplied: !!readSettings().dshHomeEnvAutoApplied
  };
}

/** 写入/移除 DSH_HOME 用户级环境变量（显式操作，来自设置窗）。 */
function setDshHomeEnv(enabled) {
  if (enabled) {
    regSetUserEnv('DSH_HOME', dshHome());
    writeSettings({ dshHomeEnv: true });
    log('user env DSH_HOME set to', dshHome());
  } else {
    regDeleteUserEnv('DSH_HOME');
    writeSettings({ dshHomeEnv: false });
    log('user env DSH_HOME removed');
  }
  return dshHomeEnvStatus();
}

/**
 * 智能默认：干净机器（没有在用的 ~/.dsh）首次启动时自动写入 DSH_HOME，
 * 让分发用户照 README 敲命令就落在桌面 home。只做一次（记在 settings.json），
 * 用户在设置窗关掉后不会被重新打开。
 */
function preseedDshHomeEnv() {
  try {
    const s = readSettings();
    if (s.dshHomeEnvAutoApplied || s.dshHomeEnv === false) return { applied: false, reason: 'already-decided' };
    const st = dshHomeEnvStatus();
    if (!st.autoEligible) {
      writeSettings({ dshHomeEnvAutoApplied: true });
      return { applied: false, reason: 'legacy-home-in-use' };
    }
    if (st.pointsHere) {
      writeSettings({ dshHomeEnvAutoApplied: true, dshHomeEnv: true });
      return { applied: false, reason: 'already-correct' };
    }
    regSetUserEnv('DSH_HOME', st.desired);
    writeSettings({ dshHomeEnvAutoApplied: true, dshHomeEnv: true });
    log('preseeded user env DSH_HOME =', st.desired);
    return { applied: true, value: st.desired };
  } catch (e) {
    log('preseed DSH_HOME failed:', e && e.message);
    return { applied: false, reason: (e && e.message) || 'error' };
  }
}

// ---- 终端包装器脚本 -------------------------------------------------------
/**
 * 生成 dsh-desktop.cmd / dsh-desktop.ps1 / dsh.cmd 到 userData/bin。
 * 脚本内部固定 DSH_HOME + 用桌面版 node 跑桌面版 dsh 入口 —— 与应用内安装
 * 完全等价，因此终端里怎么敲都不会再装错 home。
 */
function writeWrapperScripts() {
  const p = P();
  mkdirp(p.binDir);
  const home = p.dshHome;
  const cmd = [
    '@echo off',
    'rem DSH Desktop 终端包装器 —— 由桌面版自动生成，请勿手工编辑。',
    'rem 固定 DSH_HOME 指向桌面版 home，并用桌面版自带 Node 运行桌面版 dsh 入口。',
    'setlocal',
    `set "DSH_HOME=${home}"`,
    `set "PATH=${p.root};%PATH%"`,
    `if not exist "${p.dshBin}" (`,
    '  echo [dsh-desktop] 后端尚未初始化：请先启动一次 DSH Desktop。 1>&2',
    '  exit /b 1',
    ')',
    `"${p.nodeExe}" "${p.dshBin}" %*`,
    'endlocal & exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n');
  const ps1 = [
    '# DSH Desktop 终端包装器（PowerShell）—— 由桌面版自动生成，请勿手工编辑。',
    `$env:DSH_HOME = '${home.replace(/'/g, "''")}'`,
    `$env:PATH = '${p.root.replace(/'/g, "''")}' + ';' + $env:PATH`,
    `if (-not (Test-Path -LiteralPath '${p.dshBin.replace(/'/g, "''")}')) {`,
    "  Write-Error '[dsh-desktop] 后端尚未初始化：请先启动一次 DSH Desktop。'; exit 1",
    '}',
    `& '${p.nodeExe.replace(/'/g, "''")}' '${p.dshBin.replace(/'/g, "''")}' @args`,
    'exit $LASTEXITCODE',
    ''
  ].join('\r\n');
  const written = [];
  for (const name of ['dsh-desktop.cmd', 'dsh.cmd']) {
    const file = path.join(p.binDir, name);
    fs.writeFileSync(file, cmd, 'utf8');
    written.push(file);
  }
  const ps1File = path.join(p.binDir, 'dsh-desktop.ps1');
  fs.writeFileSync(ps1File, ps1, 'utf8');
  written.push(ps1File);
  log('wrote terminal wrappers into', p.binDir);
  return { dir: p.binDir, files: written };
}

/** 用户 PATH 里是否已包含包装器目录。 */
function userPathStatus() {
  const p = P();
  const cur = regQueryUserEnv('Path');
  const entries = cur ? String(cur.value).split(';').map((s) => s.trim()).filter(Boolean) : [];
  const target = path.resolve(p.binDir).toLowerCase();
  return {
    dir: p.binDir,
    inPath: entries.some((e) => { try { return path.resolve(e).toLowerCase() === target; } catch { return false; } }),
    exists: fs.existsSync(path.join(p.binDir, 'dsh-desktop.cmd')),
    type: cur ? cur.type : null,
    entries: entries.length
  };
}

/**
 * 把包装器目录加入/移出用户 PATH。追加在**末尾** —— 绝不抢占用户可能已有的
 * 全局 dsh（他们的 dsh 依然优先，dsh-desktop 是无歧义的新命令）。
 */
function setUserPathEntry(enabled) {
  const p = P();
  if (enabled) writeWrapperScripts();
  const cur = regQueryUserEnv('Path');
  const type = (cur && cur.type) || 'REG_EXPAND_SZ';
  const entries = cur ? String(cur.value).split(';').map((s) => s.trim()).filter(Boolean) : [];
  const target = path.resolve(p.binDir).toLowerCase();
  const without = entries.filter((e) => { try { return path.resolve(e).toLowerCase() !== target; } catch { return true; } });
  const next = enabled ? [...without, p.binDir] : without;
  if (!next.length) { regDeleteUserEnv('Path'); }
  else { regSetUserEnv('Path', next.join(';'), type); }
  log(enabled ? 'added wrapper dir to user PATH' : 'removed wrapper dir from user PATH');
  return userPathStatus();
}

// ---- 应用内插件安装 -------------------------------------------------------
/**
 * 在桌面版自己的环境里跑 `dsh plugin --profile <profile> add <spec>`。
 * 这是唯一保证 DSH_HOME 正确的安装通道：node/dsh 都用桌面版自带的，
 * env 走 buildDedicatedEnv()（其中 DSH_HOME 被强制为 userData/dsh-home）。
 * 返回 { ok, code, log, spec }；callbacks.onLog 可实时接收输出行。
 */
function installPluginViaCli(spec, options = {}) {
  const { profile = 'web', timeoutMs = 600000, onLog = null, action = 'add' } = options;
  const p = P();
  const clean = String(spec || '').trim();
  if (!clean) return Promise.resolve({ ok: false, code: -1, log: '未提供插件名。', spec: clean });
  if (!fs.existsSync(p.nodeExe) || !fs.existsSync(p.dshBin)) {
    return Promise.resolve({ ok: false, code: -1, log: '后端尚未初始化（缺少 node.exe 或 dsh 入口），请先正常启动一次。', spec: clean });
  }
  const args = [p.dshBin, 'plugin'];
  if (profile) args.push('--profile', profile);
  args.push(action, clean);
  const env = buildDedicatedEnv();
  log(`plugin ${action} via desktop CLI:`, clean, 'profile=', profile, 'DSH_HOME=', env.DSH_HOME);
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const say = (chunk) => {
      const text = String(chunk);
      out += text;
      if (onLog) text.split(/\r?\n/).filter((l) => l.trim()).forEach((l) => onLog(l));
    };
    let child;
    try {
      child = spawn(p.nodeExe, args, { cwd: p.dshHome, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, code: -1, log: `启动安装进程失败：${e && e.message}`, spec: clean });
    }
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch {}
      done = true;
      resolve({ ok: false, code: -1, log: out + `\n[超时] 安装超过 ${Math.round(timeoutMs / 1000)}s，已中止。`, spec: clean, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', say);
    child.stderr.on('data', say);
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, code: -1, log: out + `\n[错误] ${e && e.message}`, spec: clean });
    });
    child.on('exit', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, log: out, spec: clean });
    });
  });
}

/**
 * 批量把旧 home 的插件导入桌面 home（逐个走 installPluginViaCli）。
 * link:/file: 形态的本地依赖不能盲目重装，直接标记跳过并说明原因。
 */
async function importLegacyPlugins(items, options = {}) {
  const { profile = 'web', onLog = null } = options;
  const results = [];
  for (const it of (items || [])) {
    const name = typeof it === 'string' ? it : (it && it.name);
    const spec = typeof it === 'string' ? it : (it && (it.spec || it.name));
    const kind = typeof it === 'string' ? 'npm' : ((it && it.kind) || 'npm');
    if (!name) continue;
    if (kind === 'link') {
      results.push({ name, spec, ok: false, skipped: true, reason: '本地 link:/file: 依赖，需按原路径手工安装（源码目录可能已不存在）' });
      onLog && onLog(`[跳过] ${name} —— 本地 link 依赖，需手工处理`);
      continue;
    }
    onLog && onLog(`[开始] ${name} → ${spec}`);
    const r = await installPluginViaCli(spec, { profile, onLog });
    results.push({ name, spec, ok: r.ok, code: r.code, reason: r.ok ? '安装成功' : (r.timedOut ? '安装超时' : '安装失败，详见日志'), log: r.log });
    onLog && onLog(`[${r.ok ? '成功' : '失败'}] ${name}`);
  }
  return {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    results
  };
}

/** 把导入结果导出到桌面（与回退兼容报告同一套路）。 */
function exportLegacyImportReport(scan, summary) {
  const desktop = require('./diag-log').desktopDir();
  mkdirp(desktop);
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 17);
  const file = path.join(desktop, `DSH-Desktop-插件迁移报告-${stamp}.txt`);
  const lines = [];
  lines.push('DSH 插件迁移报告（旧 CLI Home → 桌面版 Home）');
  lines.push('='.repeat(52));
  lines.push(`旧 Home：${scan && scan.home}`);
  lines.push(`桌面 Home：${dshHome()}`);
  lines.push(`Profile：${(scan && scan.profile) || 'web'}`);
  lines.push(`时间：${new Date().toISOString()}`);
  if (summary) lines.push(`结果：共 ${summary.total} 项 —— 成功 ${summary.ok} / 失败 ${summary.failed} / 跳过 ${summary.skipped}`);
  lines.push('-'.repeat(52));
  if (summary && summary.results) {
    for (const r of summary.results) {
      lines.push(`[${r.skipped ? '跳过' : r.ok ? '成功' : '失败'}] ${r.name}${r.spec && r.spec !== r.name ? `  (${r.spec})` : ''}`);
      lines.push(`    ${r.reason}`);
    }
  } else if (scan && scan.orphans) {
    for (const o of scan.orphans) {
      lines.push(`[待导入] ${o.name}${o.version ? ' v' + o.version : ''}${o.kind === 'link' ? '（本地 link 依赖，需手工）' : ''}`);
    }
  }
  lines.push('');
  lines.push('说明：桌面版把后端隔离在自己的 DSH_HOME，终端里 npm 全局装的 dsh 默认用 ~/.dsh，');
  lines.push('      所以照 README 直接敲命令会装进旧 home。设置窗「插件安装与终端」区已提供');
  lines.push('      应用内安装、dsh-desktop 包装器与 DSH_HOME 环境变量三条正确通道。');
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return file;
}

module.exports = {
  P, activeRoot, dshHome, requestedBackendVersion, clearRequestedBackendVersion,
  ensureSeeded, migrateProjectionCache, applyStaged, ensureNodeMeetsRequirement,
  repairProfileJunctions, quarantineProfiles, repairNodeForBackendFailure, nodeRequirement,
  analyzeBackendFailure, disableBrokenPatchPlugins, analyzeConfigEntryConflicts,
  findLoaderIdConflicts, applyLoaderConflictFixes, disablePatchEntriesInFile,
  validatePatchFile, repairPatchFile, validateAndRepairPatchLayers, ensurePatchArrayText,
  preflightBareNameResolution, migrateAgentPresetPersonaText,
  // main.js spawns the backend with this dedicated/isolated environment.
  buildDedicatedEnv, describeEnvIsolation, enableCorepack,
  currentVersions, stagedVersions, checkForUpdates,
  snapshotPluginState, pluginCompatibilityReport, disableIncompatiblePlugins, rollbackDsh,
  preparePluginIsolation, enablePluginIsolationBlock, enablePluginIsolationEntry, finishPluginIsolation, clearPluginIsolation,
  recoverInterruptedIsolation,
  collectProfileRegistrations, restoreProfileRegistrations, rollbackProfileRestore,
  readSettings, writeSettings, npmRegistryUrl, registryInfo, nodeDistInfo,
  safeModeActive, enterSafeMode, exitSafeMode, applySafeModeBoot,
  stageDsh, stageNode,
  listNodeVersions, npmDshVersionsAll, backendEnginesFor,
  analyzeBackendRollback, exportBackendCompatReport,
  // 0.3.32 插件安装 / 终端接线 / 旧 home 迁移
  legacyHomePath, scanLegacyHome, legacyHomeInUse, readProfileRegistry,
  dshHomeEnvStatus, setDshHomeEnv, preseedDshHomeEnv,
  writeWrapperScripts, userPathStatus, setUserPathEntry,
  installPluginViaCli, importLegacyPlugins, exportLegacyImportReport,
  latestDshVersion, latestDshInfo, latestNodeVersion, minNodeForDsh, nodeMeetsRequirement,
  compareSemver
};
