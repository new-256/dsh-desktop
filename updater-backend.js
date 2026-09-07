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
const UPSTREAM_GITHUB_RAW = process.env.DSH_UPSTREAM_GITHUB_RAW || 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master';
const UPSTREAM_GITHUB_API = process.env.DSH_UPSTREAM_GITHUB_API || 'https://api.github.com/repos/deepseek-ai/deepseek-harness';
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
    pnpmHome: path.join(root, '.pnpm')
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
  const registry = REGISTRY;
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
  const doc = await fetchJson(`${REGISTRY}/@deepseek-ai%2Fdsh`);
  const versions = Object.keys((doc && doc.versions) || {});
  if (!versions.length) throw new Error('npm registry returned no versions');
  return { versions, latest: highestSemver(versions) };
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
  const version = (await fetchJson(`${REGISTRY}/@deepseek-ai%2Fdsh/latest`)).version;
  return { version, source: 'npm', changes: [], fallback: githubErr || npmErr };
}
async function latestDshVersion() { return (await latestDshInfo()).version; }
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
  const customTargets = new Set(
    collectJunctionSources(path.join(home, 'node_modules'))
      .map((s) => { try { return fs.realpathSync(s.target).toLowerCase(); } catch { return null; } })
      .filter(Boolean)
  );
  let removed = 0;

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
        return;
      }

      if (st.isSymbolicLink()) {
        let targetPath;
        try {
          targetPath = fs.realpathSync(itemPath);
        } catch {
          rimraf(itemPath);
          brokenLinks++;
          return;
        }

        if (!isInsideActiveRoot(targetPath, root) && !customTargets.has(targetPath.toLowerCase())) {
          rimraf(itemPath);
          foreignLinks++;
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
      log(`repaired profile entries under ${modulesDir}: ${details.join(', ')}`);
    }
  }

  const rebuilt = rebuildCustomPluginJunctions(home);
  const total = removed + rebuilt;
  if (total > 0) log(`profile junction heal total: removed=${removed}, rebuilt=${rebuilt}`);
  return total;
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

  return { quarantined, name: targetName, path: targetPath, fallback };
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
function writePatchText(home, text) { const file = path.join(home, 'cordis.patch.yml'); mkdirp(path.dirname(file)); fs.writeFileSync(file, text, 'utf8'); }
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
  return lines.join(eol);
}
function preparePluginIsolation() {
  const p = P(); const parsed = patchBlocks(p.dshHome);
  if (parsed.text == null || !parsed.blocks.length) return { active: false, plugins: [] };
  const state = { original: parsed.text, createdAt: new Date().toISOString(), plugins: parsed.blocks.map((block, index) => ({ index, ids: block.entries.map((e) => e.id), names: block.entries.map((e) => e.name), status: 'pending' })) };
  writeJson(pluginIsolationStatePath(), state);
  const backup = path.join(p.dshHome, `cordis.patch.yml.isolation-${formatDateTimestamp()}.bak`);
  fs.copyFileSync(path.join(p.dshHome, 'cordis.patch.yml'), backup);
  writePatchText(p.dshHome, commentPatchBlocks(parsed.text));
  return { active: true, backup, plugins: state.plugins };
}
function enablePluginIsolationBlock(index) {
  const p = P(); const state = readJson(pluginIsolationStatePath(), null); if (!state || !state.original) return false;
  const blocks = parseHomePatchBlocks(state.original); const selected = new Set([index]);
  writePatchText(p.dshHome, commentPatchBlocks(state.original, selected)); return !!blocks[index];
}
function finishPluginIsolation(statuses = []) {
  const p = P(); const state = readJson(pluginIsolationStatePath(), null); if (!state || !state.original) return null;
  const failed = new Set(statuses.filter((s) => s.status === 'failed').map((s) => s.index));
  const good = new Set(state.plugins.map((item) => item.index).filter((index) => !failed.has(index)));
  const result = { ...state, plugins: state.plugins.map((item) => ({ ...item, ...(statuses.find((s) => s.index === item.index) || {}) })), finishedAt: new Date().toISOString() };
  writePatchText(p.dshHome, commentPatchBlocks(state.original, good));
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
  return s.replace(/\\/g, '/').toLowerCase();
}

/** Collect failing module/package specifiers from backend log text. */
function failingSpecifiersFromLogs(logText) {
  const out = new Set();
  if (!logText) return out;
  const patterns = [
    /Cannot find (?:package|module) '([^']+)'/g,
    /Cannot find '([^']+)'/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(logText)) !== null) out.add(normalizeSpecifier(m[1]));
  }
  return out;
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
 * Returns { failing: [specifiers], broken: [{ id, name }] } where `broken`
 * lists patch entries that both appear in the failure logs and whose source is
 * genuinely unavailable (i.e. they are the direct boot blocker).
 */
function analyzeBackendFailure(home, logText) {
  const result = { failing: [], broken: [] };
  const patchPath = path.join(home, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) return result;
  const failing = failingSpecifiersFromLogs(logText);
  result.failing = [...failing];
  if (!failing.size) return result;

  let yamlText;
  try { yamlText = fs.readFileSync(patchPath, 'utf8'); } catch (e) { log('read patch failed:', e.message); return result; }
  const seen = new Set();
  for (const block of parseHomePatchBlocks(yamlText)) {
    for (const entry of block.entries) {
      if (!entry.name || seen.has(entry.id)) continue;
      if (!failing.has(normalizeSpecifier(entry.name))) continue;
      seen.add(entry.id);
      if (!pluginSourceAvailable(home, entry)) {
        result.broken.push({ id: entry.id, name: entry.name });
      }
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
  await run(p.nodeExe, [p.npmCli, 'install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${REGISTRY}`, '--no-bin-links'], {
    cwd: p.dshNew,
    env: buildDedicatedEnv(),
    onOutput: (s) => { const l = s.trim(); if (l && l.includes('packages')) say(l); }
  });
  const newBin = path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(newBin)) { rimraf(p.dshNew); throw new Error('后端暂存安装后未找到 dsh，已放弃（当前版本不受影响）。'); }
  const ver = readJson(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {}).version || null;
  log('staged dsh', ver);
  return { version: ver, reused: false, changes: info.changes || [], source: info.source };
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

module.exports = {
  P, activeRoot, dshHome, requestedBackendVersion, clearRequestedBackendVersion,
  ensureSeeded, migrateProjectionCache, applyStaged, ensureNodeMeetsRequirement,
  repairProfileJunctions, quarantineProfiles, repairNodeForBackendFailure, nodeRequirement,
  analyzeBackendFailure, disableBrokenPatchPlugins, analyzeConfigEntryConflicts,
  findLoaderIdConflicts, applyLoaderConflictFixes, disablePatchEntriesInFile,
  // main.js spawns the backend with this dedicated/isolated environment.
  buildDedicatedEnv, describeEnvIsolation, enableCorepack,
  currentVersions, stagedVersions, checkForUpdates,
  snapshotPluginState, pluginCompatibilityReport, disableIncompatiblePlugins, rollbackDsh,
  preparePluginIsolation, enablePluginIsolationBlock, finishPluginIsolation, clearPluginIsolation,
  stageDsh, stageNode,
  latestDshVersion, latestDshInfo, latestNodeVersion, minNodeForDsh, nodeMeetsRequirement,
  compareSemver
};
