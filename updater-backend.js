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
const crypto = require('crypto');
// 0.3.46 · 补丁解析原语与裸包名解析根模型抽成独立模块（同一套解析语义只能有一份）
const pluginResolution = require('./plugin-resolution');
const {
  parseHomePatchBlocks,
  parseCommentedPatchEntries,
  specToPath,
  normalizeSpecifier,
  isBarePackageName,
  barePackageName,
} = require('./patch-file');

// 更新路线：托盘「设置」窗可切换 'mirror'（npmmirror，国内快、同步滞后）与
// 'official'（npmjs，版本始终最新）。未设置时退回环境变量，再退回镜像站。
function settingsPath() { return path.join(userDataPath(), 'settings.json'); }
function readSettings() { try { return readJson(settingsPath(), {}); } catch { return {}; } }
/** 会改变"更新目标"的设置键：改动它们就必须作废旧确认（B-06）。 */
const TARGET_KEYS = ['npmRegistry', 'nodeDist', 'updateChannel', 'channel', 'dshVersion'];

function writeSettings(patch) {
  const prev = readSettings();
  const s = { ...prev, ...patch };
  try { writeJson(settingsPath(), s); } catch (e) { log('write settings failed:', e.message); }
  // 0.3.49 · B-06：切更新路线/换下载源 = 目标被换掉 → 代次自增，旧确认立即作废。
  // 收敛在这一处（写设置的唯一漏斗），而不是散落到每个 UI 分支里 —— 漏一处就等于没做。
  const hit = TARGET_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== prev[k]);
  if (hit.length) bumpUpdateRevision(`设置变更：${hit.join(',')}`);
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
const diagLogMod = require('./diag-log');
const diagLog = diagLogMod.write;
function log(...a) { console.log('[backend-mgr]', ...a); diagLog('[backend-mgr]', ...a); }
/**
 * 关键产物用「持久化档」重复写一条（0.3.49 · 借用阶段一的 durability 分层）。
 *
 * 为什么：隔离/回滚/应用更新这类结论是**事后唯一的证据**。普通 log 走的是攒批落盘
 * （高频日志不堵主线程的代价），崩溃/断电时最后几批可能丢。凡"事后要据此判断到底发生
 * 了什么"的结论，一律走 writeDurable（同步刷队列 + 直写）。别自己造同步写。
 */
function logDurable(...a) { console.log('[backend-mgr]', ...a); diagLogMod.writeDurable('[backend-mgr]', ...a); }
function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }
function execSync(cmd) {
  try { require('child_process').execSync(cmd, { stdio: 'ignore', shell: true }); } catch {}
}

/**
 * 删除"我们拥有的目录"，但**绝不进入链接目标**（0.3.43 · 对齐官方
 * owned-directory.ts 的 removeOwnedDirectory）。
 *
 * ## 为什么必须自己走一遍
 *
 * 官方的注释一句话点破（owned-directory.ts:19）：
 *   "Electron's recursive rm follows nested Windows junctions into installed resources."
 *
 * 这对我们不是理论风险 —— 实测用户机器 `dsh-home\profiles\web\node_modules` 里
 * 有两个 junction 指向**真实插件开发目录**（含 .git、123 个文件）：
 *
 *     @local\repo-push-access        → C:\Users\lcl\Desktop\DSH插件开发\...\repo-push-access
 *     dsh-repo-push-access           → （同上）
 *
 * 而我们旧的 rimraf 有三条会跟随链接的路径：
 *   ① fs.rmSync(d, {recursive:true})  —— Node 在 Windows 上会进入 junction 删目标内容
 *   ② rmdir /s /q                     —— cmd 同样跟随链接（最危险）
 *   ③ 删除 profiles 树时，任何嵌套 junction 都会被连带处理
 *
 * 一旦隔离/清理逻辑作用在 profiles 树上，用户的**插件源码和未提交改动**就会被删掉。
 *
 * ## 做法
 *
 * 自底向上手工遍历：遇到链接（isSymbolicLink，Windows 的 junction 也被它覆盖）
 * 就只 unlink 链接本身、**绝不递归进去**；普通目录递归；普通文件 unlink。
 * 缺根直接返回；根存在但不是目录也不是链接则报错（宁可不删，也不猜）。
 *
 * @param {string} target 我们拥有的目录或链接
 * @param {{throwOnUnexpected?: boolean}} [opts]
 * @returns {{removed: boolean, linksUnlinked: number, reason?: string}}
 */
function removeOwnedDirectory(target, opts = {}) {
  const result = { removed: false, linksUnlinked: 0 };
  let st;
  try { st = fs.lstatSync(target); } catch { return { ...result, reason: 'missing' }; }

  // 根自身是链接：只摘链接，目标内容保持原样。
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(target); return { removed: true, linksUnlinked: 1, reason: 'root-was-link' }; }
    catch (e) { return { ...result, reason: 'unlink-failed: ' + e.message }; }
  }
  if (!st.isDirectory()) {
    // 普通文件：删除它是明确的（调用方说这是"我们的目录"，却是文件 → 保守处理）
    if (opts.throwOnUnexpected) throw new Error(`removeOwnedDirectory: 路径不是目录 ${target}`);
    return { ...result, reason: 'not-a-directory' };
  }

  // 自底向上：每个子目录在自身遍历结束后立即 rmdir（对齐官方
  // owned-directory.ts:22-26 的递归结构——目录必须在递归返回后就地删除，
  // 否则上层 rmdir 会因 ENOTEMPTY 失败，留下删不干净的残树）。
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { throw new Error(`读取失败 ${dir}: ${e.message}`); }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      let cst;
      try { cst = fs.lstatSync(child); } catch { continue; }
      if (cst.isSymbolicLink()) {
        // ★ 核心保证：只摘链接本身，绝不进入目标。
        try { fs.unlinkSync(child); result.linksUnlinked++; } catch {}
        continue;
      }
      if (cst.isDirectory()) walk(child);
      else { try { fs.unlinkSync(child); } catch {} }
    }
    fs.rmdirSync(dir);
  };

  try {
    walk(target);
    result.removed = true;
  } catch (e) {
    result.reason = 'walk-failed: ' + e.message;
    // 手工遍历失败（长路径/权限/占用）时**不回退到跟随链接的删除方式**——
    // 宁可这次不删干净，也不能冒删掉用户源码的风险。交由调用方从容重试。
  }
  return result;
}

/**
 * 删除目录。默认走"不跟随链接"的安全实现。
 *
 * 旧行为（跟随链接）只在明确无害的场景保留：删除我们自己刚下载解压的
 * staging 目录（其中不可能有用户 junction）。此时传 followLinks: true 可
 * 使用更快的原生 rmSync。
 *
 * @param {string} d
 * @param {{followLinks?: boolean}} [opts]
 */
function rimraf(d, opts = {}) {
  if (!d) return;
  // 1) 空目录 / 单个文件：最简单的两条路径，天然安全。
  try { fs.rmdirSync(d); return; } catch {}
  try { fs.unlinkSync(d); return; } catch {}
  // 2) junction / symlink：只摘链接本身（rmdirSync 对目录型 junction 有效，
  //    但为明确语义这里再判一次）。
  try {
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink()) { fs.unlinkSync(d); return; }
  } catch {}
  // 3) 显式声明"这里没有用户链接"时才用原生递归删除。
  if (opts.followLinks) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); return; }
    catch { execSync(`rmdir /s /q "${d}"`); return; }
  }
  // 4) 默认：安全遍历，绝不进入链接目标。
  const r = removeOwnedDirectory(d);
  if (!r.removed) log(`rimraf(safe) 未完成 ${d}: ${r.reason || 'unknown'}（已保留现场，不会跟随链接删除）`);
}
function copyDir(src, dst) {
  mkdirp(path.dirname(dst));
  rimraf(dst);
  try { require('child_process').execSync(`robocopy "${src}" "${dst}" /E /NFL /NDL /NJH /NJS /NP /XD .git`, { stdio: 'ignore' }); }
  catch { /* robocopy success codes are non-zero */ }
}
function copyFile(src, dst) { mkdirp(path.dirname(dst)); fs.copyFileSync(src, dst); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
/**
 * 原子写 JSON（0.3.42 · 对齐官方 owned-directory 的"不留半截文件"纪律）。
 *
 * 旧实现是裸 fs.writeFileSync：进程在写入中途被杀（更新重启、断电、杀软锁文件），
 * 目标文件会留下**被截断的 JSON**。这不是理论风险 —— 被截断的 cordis.patch.yml
 * 恰好会触发我们自己的 Escalation 0a（补丁层校验失败），也就是**我们在给自己
 * 制造需要自愈的故障**。改为 temp + rename：同一卷上 rename 是原子的，读者要么
 * 看到完整旧文件、要么看到完整新文件。
 */
function writeJson(file, obj) {
  mkdirp(path.dirname(file));
  const body = JSON.stringify(obj, null, 2);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    throw e;
  }
}
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

  // 启动器命名空间保护（0.3.42 · 对齐官方 login-shell-environment.ts:17,99 的
  // LAUNCHER_OWNED_PREFIXES）。官方把 `DSH_` / `ELECTRON_` 明确定义为「启动器
  // 自己的领地」，外部环境不许覆盖。我们此前只单点保护 DSH_HOME：用户 shell 里
  // 若残留 DSH_CLIENT_VERSION 之类的变量，会**静默改变桌面版行为**，产生无法
  // 复现、也无法归因的故障。
  //
  // 做法：剥离所有来自环境的 DSH_* / ELECTRON_*，再由启动器显式重建自己需要的那几个。
  // 这样"启动器的键只有启动器能决定"，语义单一。
  const LAUNCHER_OWNED_PREFIXES = ['DSH_', 'ELECTRON_'];
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (!LAUNCHER_OWNED_PREFIXES.some((pre) => upper.startsWith(pre))) continue;
    strippedVarsSet.add(key);
    delete env[key];
  }
  // 剥离后由启动器统一重建：DSH_HOME 必须指向本应用的隔离 home。
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
/** 连接/首字节超时：服务器必须在此时限内开始回应。 */
const HTTP_CONNECT_TIMEOUT_MS = 30000;
/**
 * 空闲超时（0.3.42 · 对齐官方 update-http-executor.ts 的 "not a total download
 * deadline"）：只要**还有数据在流动**就永不超时，只有连续这么久没有任何字节
 * 到达才判定卡死。旧的 30s 总超时会在慢速/镜像限速下把 80+MB 的 node.exe
 * 下载中途 kill 掉（updater-backend.js 自己的注释就写着 node.exe 有 80+ MB），
 * 而且没有断点续传，用户只能反复重来。
 */
const HTTP_IDLE_TIMEOUT_MS = 60000;

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
    // 仅覆盖"连上并开始回应"这一段；响应体的空闲由调用方用 idle 计时器管。
    req.setTimeout(HTTP_CONNECT_TIMEOUT_MS, () => {
      const err = new Error('连接超时 ' + url);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
  });
}

/**
 * 给响应流挂一个"空闲超时"看门狗：每收到一块数据就重置计时，连续
 * HTTP_IDLE_TIMEOUT_MS 无数据才销毁。返回清除函数。
 */
function armIdleTimeout(res, url) {
  let timer = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const bump = () => {
    clear();
    timer = setTimeout(() => {
      const err = new Error('下载空闲超时（' + Math.round(HTTP_IDLE_TIMEOUT_MS / 1000) + 's 无数据）' + url);
      err.code = 'ETIMEDOUT';
      try { res.destroy(err); } catch {}
    }, HTTP_IDLE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  };
  res.on('data', bump);
  res.on('end', clear);
  res.on('close', clear);
  bump();
  return clear;
}

async function fetchJson(url) {
  const res = await httpsGet(url);
  const clearIdle = armIdleTimeout(res, url);
  let body = ''; res.setEncoding('utf8');
  try {
    for await (const c of res) body += c;
  } finally { clearIdle(); }
  return JSON.parse(body);
}
/** 取纯文本（SHASUMS256.txt 这类清单用；与 fetchJson 同一套超时纪律）。 */
async function fetchText(url) {
  const res = await httpsGet(url);
  const clearIdle = armIdleTimeout(res, url);
  let body = ''; res.setEncoding('utf8');
  try {
    for await (const c of res) body += c;
  } finally { clearIdle(); }
  return body;
}
async function downloadFile(url, dest, onProgress) {
  const res = await httpsGet(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  mkdirp(path.dirname(dest));
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  const clearIdle = armIdleTimeout(res, url);
  res.on('data', (c) => { got += c.length; if (onProgress && total && Date.now() - last > 250) { onProgress(got / total); last = Date.now(); } });
  try {
    await new Promise((resolve, reject) => { res.pipe(out); out.on('finish', resolve); out.on('error', reject); res.on('error', reject); });
  } finally { clearIdle(); }
  // 完整性检查：有 content-length 时，短读意味着连接在传输中被截断 —— 必须报错，
  // 否则会把半截文件 rename 成"下载完成"，后续解压/校验才失败，归因更难。
  if (total && got !== total) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`下载不完整：期望 ${total} 字节，实际 ${got} 字节（${url}）`);
  }
  fs.renameSync(tmp, dest); if (onProgress && total) onProgress(1);
}
// --------------------------------------------------------------------------
// 0.3.49 · B-17：运行期下载包的完整性校验
//
// 问题：构建期我们把 vendor 分卷逐个核 sha256（scripts/write-vendor-manifest.js），
// 但**运行期**从 npm/镜像下载的后端包只查了 content-length。镜像同步到一半、CDN 截断、
// 代理注入内容时，我们会把一棵坏树装进 dsh.new 然后在下次启动"应用"它 —— 归因难度
// 远高于在下载完的那一刻就判定损坏。
//
// 口径（对齐官方把 ERR_UPDATER_CHECKSUM_MISMATCH 当一等公民的做法）：
//  - registry 的 dist.integrity 是 SRI 串（`sha512-<base64>`），**sha512 优先**；
//  - 老包可能只有 dist.shasum（sha1 十六进制）→ 退到它，但要记明"用了弱校验"；
//  - 两者都缺 → 明确告知「无法校验」，绝不假装通过（是否继续由调用方按策略决定）。
//
// 边界（必须诚实）：本项防的是**传输损坏 / 截断 / 部分篡改**。它防不了"镜像站被整体
// 接管"——那种情况下元数据与 tarball 会一起被改，需要签名信任根（B-10）。别把它宣传
// 成"供应链安全已解决"。
// --------------------------------------------------------------------------
const SRI_ALGOS = ['sha512', 'sha384', 'sha256', 'sha1'];

/**
 * 解析 SRI 串（可能有多个空格分隔的条目，例如 `sha512-… sha1-…`）。
 * 按 SRI_ALGOS 的优先级挑**最强**的可用条目，而不是取第一个 —— 某些工具会把
 * 弱算法写在前面，取第一个等于自愿降级。
 * @returns {{algo: string, digestBase64: string}|null}
 */
function parseSri(integrity) {
  const text = String(integrity || '').trim();
  if (!text) return null;
  const found = new Map();
  for (const token of text.split(/\s+/)) {
    const m = /^([a-z0-9]+)-([A-Za-z0-9+/=]+)$/i.exec(token);
    if (!m) continue;
    const algo = m[1].toLowerCase();
    if (!SRI_ALGOS.includes(algo) || found.has(algo)) continue;
    found.set(algo, m[2]);
  }
  for (const algo of SRI_ALGOS) if (found.has(algo)) return { algo, digestBase64: found.get(algo) };
  return null;
}

/**
 * 从 registry 元数据里选校验口径。
 * @returns {{algo, expected, encoding, from}|null} null = 元数据里没有任何可用哈希
 */
function chooseIntegrity(meta) {
  const sri = parseSri(meta && meta.integrity);
  if (sri) return { algo: sri.algo, expected: sri.digestBase64, encoding: 'base64', from: 'dist.integrity' };
  const shasum = meta && typeof meta.shasum === 'string' ? meta.shasum.trim().toLowerCase() : '';
  if (/^[0-9a-f]{40}$/.test(shasum)) return { algo: 'sha1', expected: shasum, encoding: 'hex', from: 'dist.shasum' };
  return null;
}

/** 流式摘要（tarball 可能几十 MB，不整读进内存）。返回 base64 与 hex 两种表示。 */
function digestFileSync(file, algo) {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    try { fs.closeSync(fd); } catch (e) { log('关闭待校验文件失败:', e.message); }
  }
  const digest = h.digest();
  return { base64: digest.toString('base64'), hex: digest.toString('hex') };
}

/**
 * 校验一个已下载文件的完整性。
 *
 * @param {string} file 已落盘文件
 * @param {{integrity?:string|null, shasum?:string|null}} meta registry 的 dist 元数据
 * @param {{expectedBytes?: number|null}} [opts] 有 content-length 时先看大小，能更快给出
 *        「被截断」这种可操作结论
 * @returns {{ok: boolean, missingMetadata?: boolean, truncated?: boolean, algo, from,
 *            expected: string|null, actual: string|null, size?: number, reason: string|null}}
 */
function verifyFileIntegrity(file, meta, opts = {}) {
  const size = fs.existsSync(file) ? fs.statSync(file).size : null;
  const expectedBytes = Number(opts.expectedBytes || 0) || null;
  if (expectedBytes && size !== null && size !== expectedBytes) {
    return {
      ok: false, truncated: true, algo: null, from: null, expected: String(expectedBytes), actual: String(size), size,
      reason: `文件大小不符：期望 ${expectedBytes} 字节，实际 ${size} 字节（下载可能被截断）`
    };
  }
  const spec = chooseIntegrity(meta);
  if (!spec) {
    return {
      ok: false, missingMetadata: true, algo: null, from: null, expected: null, actual: null, size,
      reason: 'registry 元数据未提供 dist.integrity / dist.shasum，无法校验完整性'
    };
  }
  const digest = digestFileSync(file, spec.algo);
  const actual = spec.encoding === 'base64' ? digest.base64 : digest.hex;
  if (actual !== spec.expected) {
    return {
      ok: false, algo: spec.algo, from: spec.from, expected: spec.expected, actual, size,
      reason: `${spec.algo} 校验不匹配（来源 ${spec.from}）：期望 ${spec.expected}，实际 ${actual}`
    };
  }
  return { ok: true, algo: spec.algo, from: spec.from, expected: spec.expected, actual, size, reason: null };
}

function extractZip(zipPath, destDir) {  return new Promise((resolve, reject) => {
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
  // 0.3.49 · B-17/B-06：同一次 packument 里就带着 dist.integrity / dist.shasum /
  // dist.tarball —— 取它们**零额外网络**，没理由不拿来校验完整性、绑定用户确认。
  const dist = {};
  for (const v of versions) {
    const meta = doc.versions[v];
    const en = meta && meta.engines && typeof meta.engines.node === 'string' ? meta.engines.node : null;
    if (en) engines[v] = en;
    const d = meta && meta.dist;
    if (d) {
      dist[v] = {
        integrity: typeof d.integrity === 'string' ? d.integrity : null,
        shasum: typeof d.shasum === 'string' ? d.shasum : null,
        tarball: typeof d.tarball === 'string' ? d.tarball : null,
        unpackedSize: typeof d.unpackedSize === 'number' ? d.unpackedSize : null
      };
    }
  }
  lastDshDist = dist;
  return { versions, latest: highestSemver(versions), engines, dist };
}

/** 最近一次 packument 里的 dist 元数据（version → {integrity, shasum, tarball}）。 */
let lastDshDist = {};

/**
 * 取某版本的 dist 元数据。优先用最近一次 packument 的缓存（零网络）；缓存没有该版本
 * 时按版本号单查一次。**拿不到就返回 null**，由调用方决定"无哈希可用"怎么处理 ——
 * 本函数绝不编造哈希。
 */
async function dshDistMeta(version) {
  if (!version) return null;
  const cached = lastDshDist[version];
  if (cached) return cached;
  const doc = await fetchJson(`${npmRegistryUrl()}/@deepseek-ai%2Fdsh/${encodeURIComponent(version)}`);
  const d = doc && doc.dist;
  if (!d) return null;
  return {
    integrity: typeof d.integrity === 'string' ? d.integrity : null,
    shasum: typeof d.shasum === 'string' ? d.shasum : null,
    tarball: typeof d.tarball === 'string' ? d.tarball : null,
    unpackedSize: typeof d.unpackedSize === 'number' ? d.unpackedSize : null
  };
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

// --------------------------------------------------------------------------
// payload 完整性校验（vendor-manifest.json）
// --------------------------------------------------------------------------
/**
 * 借鉴官方 apps/desktop 的 desktop-runtime.json + verifyDesktopRuntime()：
 * 构建期（scripts/write-vendor-manifest.js）把关键文件的 bytes/sha256、两棵树
 * 的顶层条目、dsh 树的文件数/字节数、以及每个 payload 分卷的哈希写进
 * resources/payload/vendor-manifest.json，这里在首次解压前后各校验一次。
 *
 * 与官方的差别（有意为之）：官方对整棵运行时树逐文件哈希，启动前全量校验；
 * 这里只对 4 个「决定能否启动 / 唯一标识版本」的关键文件做哈希，加上 dsh 树的
 * 规模对账 —— 目的是把校验成本压到几百毫秒，同时仍能抓到分卷漏拷、解压中断、
 * 版本错配这三类真实故障。整棵树的逐文件哈希对桌面版是过度设计。
 *
 * 兼容性：旧安装包不带清单时全部跳过（返回 ok:true, skipped:true），
 * 行为与改动前完全一致，不会因为缺少清单而拒绝启动。
 */

/** 流式 sha256（node.exe 有 80+ MB，不能整文件读进内存）。 */
function sha256FileSync(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return h.digest('hex');
}

/**
 * 清单相对路径 → 绝对路径，拒绝一切可能逃出 root 的写法。
 * 与官方 runtime-tree.ts 的 runtimePath() 同一条纪律：绝对路径、反斜杠、
 * 盘符、空段、`.`、`..` 一律判非法。
 */
function manifestPath(root, rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.includes('\\') || rel.includes(':')) return null;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return path.join(root, ...segs);
}

/** 统计一棵树的文件数与字节数（跳过符号链接，与构建期统计口径一致）。 */
function countTree(dir) {
  let files = 0; let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(full);
      else { files++; bytes += st.size; }
    }
  }
  return { files, bytes };
}

/**
 * 解压**前**校验 payload 分卷本身（快：~137MB，约 1 秒）。
 * 分卷坏了就没必要再花 30+ 秒去解压一棵坏树。
 */
function verifyPayloadParts(p, manifest) {
  const list = Array.isArray(manifest.parts) ? manifest.parts : [];
  if (list.length === 0) return { ok: true, checked: 0 };
  for (const entry of list) {
    const name = entry && entry.file;
    // 分卷名只允许是 payload 目录下的裸文件名。
    if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name.includes(':')) {
      return { ok: false, reason: `清单中的分卷名非法：${JSON.stringify(name)}` };
    }
    const abs = path.join(p.seedPayloadDir, name);
    if (!fs.existsSync(abs)) return { ok: false, reason: `缺少分卷 ${name}` };
    const size = fs.statSync(abs).size;
    if (typeof entry.bytes === 'number' && size !== entry.bytes) {
      return { ok: false, reason: `分卷 ${name} 大小不符（期望 ${entry.bytes}，实际 ${size}）` };
    }
    if (entry.sha256) {
      const got = sha256FileSync(abs);
      if (got !== entry.sha256) {
        return { ok: false, reason: `分卷 ${name} 校验和不符（期望 ${String(entry.sha256).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）` };
      }
    }
  }
  return { ok: true, checked: list.length };
}

/** 解压**后**校验落地的后端树。 */
function verifyVendorManifest(p, manifest) {
  let checked = 0;

  // 1) 关键文件：逐字节 sha256
  for (const item of Array.isArray(manifest.critical) ? manifest.critical : []) {
    const rel = item && item.path;
    const abs = manifestPath(p.root, rel);
    if (!abs) return { ok: false, reason: `清单中的路径非法：${JSON.stringify(rel)}` };
    if (!fs.existsSync(abs)) return { ok: false, reason: `缺少关键文件 ${rel}` };
    const size = fs.statSync(abs).size;
    if (typeof item.bytes === 'number' && size !== item.bytes) {
      return { ok: false, reason: `关键文件 ${rel} 大小不符（期望 ${item.bytes}，实际 ${size}）` };
    }
    if (item.sha256) {
      const got = sha256FileSync(abs);
      if (got !== item.sha256) return { ok: false, reason: `关键文件 ${rel} 校验和不符` };
    }
    checked++;
  }

  // 2) 顶层条目：捕捉「少解压了一整个目录」
  for (const base of ['runtime', 'dsh']) {
    const baseRoot = base === 'dsh' ? p.dshDir : p.root;
    for (const name of ((manifest.topLevel && manifest.topLevel[base]) || [])) {
      if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
        return { ok: false, reason: `清单 topLevel.${base} 条目非法：${JSON.stringify(name)}` };
      }
      if (!fs.existsSync(path.join(baseRoot, name))) {
        return { ok: false, reason: `缺少顶层条目 ${base}/${name}` };
      }
      checked++;
    }
  }

  // 3) dsh 树规模：解压是否完整的最强信号。
  //    只统计 dsh 树 —— 后端根目录混有运行期的 downloads/.npm-cache/dsh.new 等，
  //    对它做全量统计既慢又会被更新暂存内容误判。
  const want = manifest.totals && manifest.totals.dsh;
  if (want && typeof want.files === 'number') {
    const got = countTree(p.dshDir);
    if (got.files !== want.files || (typeof want.bytes === 'number' && got.bytes !== want.bytes)) {
      return {
        ok: false,
        reason: `dsh 树规模不符（期望 ${want.files} 个文件 / ${want.bytes} 字节，实际 ${got.files} 个文件 / ${got.bytes} 字节）`
      };
    }
    checked++;
  }

  // 4) 版本对账：清单声明的 dsh 版本必须等于解压出来的版本
  if (manifest.dshVersion) {
    const pkg = readJson(p.dshPkg, null);
    const actual = pkg && pkg.version ? pkg.version : null;
    if (actual !== manifest.dshVersion) {
      return { ok: false, reason: `dsh 版本不符（清单 ${manifest.dshVersion}，实际 ${actual || '未知'}）` };
    }
    checked++;
  }

  return { ok: true, checked };
}

/**
 * 校验失败时清掉**刚解压出来的**两棵树，确保下次启动 needNode/needDsh 仍为真而重试。
 * 不碰 downloads/、dsh.new/、dsh.previous/、plugin-state.json —— 那些是更新暂存与
 * 用户状态，删掉会造成比校验失败更严重的后果。
 */
function quarantineSeededBackend(p) {
  try { rimraf(p.dshDir); } catch (e) { log('quarantine dshDir failed: ' + e.message); }
  try { if (fs.existsSync(p.nodeExe)) fs.unlinkSync(p.nodeExe); } catch (e) { log('quarantine node.exe failed: ' + e.message); }
  try { rimraf(p.npmDir); } catch (e) { log('quarantine npm failed: ' + e.message); }
}

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
function extractPayloadParts(p, parts) {
  mkdirp(p.root);

  if (parts.length === 1) {
    // Legacy single archive: one blocking extract, no PowerShell needed.
    // x = extract with full paths; -aoa = overwrite all; -mmt=on = multi-thread.
    execFileSync(p.seedVendor7za, ['x', parts[0], '-aoa', '-mmt=on', '-o' + p.root], { stdio: 'ignore' });
    return;
  }

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

/**
 * 解压 payload 并做完整性校验（清单存在时）。校验不过就清掉重来一次，
 * 两次都不过则判定安装包损坏并明确报错 —— 绝不把一棵坏树交给 dsh 去跑。
 */
function seedFromArchive(p) {
  const parts = discoverVendorParts(p);
  if (parts.length === 0 || !fs.existsSync(p.seedVendor7za)) return false;

  const manifest = readJson(path.join(p.seedPayloadDir, 'vendor-manifest.json'), null);
  if (manifest) {
    log(`payload 清单：dsh=${manifest.dshVersion || '未知'} node=${manifest.nodeVersion || '未知'} parts=${(manifest.parts || []).length}`);
    const pre = verifyPayloadParts(p, manifest);
    if (!pre.ok) {
      // 分卷本身坏了：解压也只会得到坏树，直接说清楚，不浪费一次解压。
      log(`payload 分卷校验失败：${pre.reason}`);
      log('安装包 payload 已损坏，请重新下载 / 重新安装。本次不再尝试解压。');
      return false;
    }
  } else {
    log('未随包提供 vendor-manifest.json（旧安装包），跳过完整性校验。');
  }

  // 清单存在时允许重试一次：首次失败更可能是解压被打断，清干净重来往往就好了；
  // 第二次仍失败即可判定 payload 损坏，不再无休止重试。
  const maxAttempts = manifest ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log(`seeding backend from ${parts.length} payload part(s) via concurrent 7za extract …（第 ${attempt}/${maxAttempts} 次）`);
      extractPayloadParts(p, parts);

      if (!fs.existsSync(p.nodeExe) || !fs.existsSync(p.dshBin)) {
        log('payload extracted but expected files missing; falling back to directory copy');
        return false;
      }

      if (!manifest) {
        log(`已并行解压 ${parts.length} 个分卷完成后端初始化`);
        return true;
      }

      const post = verifyVendorManifest(p, manifest);
      if (post.ok) {
        log(`已并行解压 ${parts.length} 个分卷，完整性校验通过（${post.checked} 项）`);
        return true;
      }

      log(`完整性校验未通过（第 ${attempt}/${maxAttempts} 次）：${post.reason}`);
      quarantineSeededBackend(p);
      if (attempt < maxAttempts) {
        log('已清除本次解压产物，重试解压…');
        continue;
      }
      log('完整性校验重试后仍失败 —— 安装包 payload 可能已损坏，请重新下载安装包。');
      return false;
    } catch (e) {
      log('payload seed failed (' + e.message + '); falling back to directory copy');
      // 半途失败的解压会留下「node.exe 在、dsh 树残缺」的假象，让下次启动
      // 误判为无需 seed 而永久卡死。清掉，保证下次启动会重试（源码检出场景
      // 下则由紧随其后的目录复制兜底）。
      quarantineSeededBackend(p);
      return false;
    }
  }
  return false;
}

// ==========================================================================
// Python 运行时检测引导 + 版本耦合软闸门（0.3.38）
//
// 官方 apps/desktop 把整套 Python + 编写库打进安装包（+150~250MB），我们不
// 照抄：dsh-skill-office 本就设计为「由部署方提供 Python」。这里改做轻量
// 探测——用后端**真实的隔离环境**判断它的子进程能否拿到 Python 3.9+ 与核心
// 编写库；拿不到就在普通启动时一次性引导，绝不静默。
// ==========================================================================
const pythonCheckStatePath = () => path.join(P().root, 'python-check.json');

function readPythonCheckState() {
  try { return JSON.parse(fs.readFileSync(pythonCheckStatePath(), 'utf8')); } catch { return {}; }
}
function writePythonCheckState(obj) {
  try { fs.writeFileSync(pythonCheckStatePath(), JSON.stringify(obj, null, 2) + '\n'); } catch (e) { log('write python-check state failed:', e.message); }
}

const PY_MIN_MAJOR = 3;
const PY_MIN_MINOR = 9;
/**
 * 编写库探针：与官方内置清单对齐。结构检查器（check_office.py）只用标准库，
 * 所以这里区分「结构检查可用（标准库够）」与「生成/编辑可用（需要这些库）」。
 */
const PY_AUTHORING_LIBS = ['docx', 'pptx', 'openpyxl', 'PIL', 'lxml', 'pandas'];

function parsePythonVersion(text) {
  const m = /Python\s+(\d+)\.(\d+)\.(\d+)/i.exec(String(text || ''));
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10), raw: `${m[1]}.${m[2]}.${m[3]}` };
}

/**
 * 用后端的**专用隔离环境**探测 Python —— 不是探测构建外壳自己的 PATH，而是探测
 * dsh 及其子进程实际拿到的环境（PATH 已剔除外来 node 目录、变量已隔离）。
 * 返回：
 *   { available, version, meetsMinimum, executable, authoring: {name,ok},
 *     missingAuthoring, checksOnly, reason }
 */
function detectPythonRuntime() {
  let env;
  try { env = buildDedicatedEnv(); } catch (e) { return { available: false, reason: '构建隔离环境失败：' + e.message }; }

  const runPy = (code) => {
    try {
      return execFileSync('python', ['-c', code], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
    } catch { return null; }
  };

  const verText = runPy('import sys; print("Python " + ".".join(str(x) for x in sys.version_info[:3]))');
  if (!verText) return { available: false, reason: '后端环境中找不到 python（未安装或未加入 PATH）' };

  const version = parsePythonVersion(verText);
  if (!version) return { available: false, reason: '无法解析 Python 版本：' + verText };

  const meetsMinimum = version.major > PY_MIN_MAJOR || (version.major === PY_MIN_MAJOR && version.minor >= PY_MIN_MINOR);
  let executable = null;
  const exeText = runPy('import sys; print(sys.executable)');
  if (exeText) executable = exeText.split(/\r?\n/).pop().trim();

  const authoring = PY_AUTHORING_LIBS.map((name) => {
    const ok = runPy(`import ${name}`) !== null;
    return { name, ok };
  });
  const missingAuthoring = authoring.filter((x) => !x.ok).map((x) => x.name);

  return {
    available: true,
    version: version.raw,
    meetsMinimum,
    executable,
    authoring,
    missingAuthoring,
    checksOnly: meetsMinimum, // 标准库在即可跑结构检查
    reason: !meetsMinimum ? `Python ${version.raw} 低于要求的 ${PY_MIN_MAJOR}.${PY_MIN_MINOR}+`
      : missingAuthoring.length ? 'Python 可用，但部分编写库缺失' : 'Python 与编写库均可用'
  };
}

/**
 * 启动期调用：探测 Python；仅当「需要提醒」且本组合还没提醒过时返回待展示信息。
 * 用户确认后写状态，同版本/同来源不再打扰。autoStartHidden 由 main.js 侧自行决定
 * 是否弹窗，这里只负责探测与状态。
 */
function pythonBootCheck() {
  const info = detectPythonRuntime();
  const state = readPythonCheckState();
  const key = info.available ? (info.executable || info.version) : 'missing';

  const needWarn = !info.available || !info.meetsMinimum || info.missingAuthoring.length > 0;
  if (!needWarn) {
    writePythonCheckState({ ...state, lastGood: { at: new Date().toISOString(), version: info.version, executable: info.executable } });
    return { info, shouldPrompt: false };
  }
  const dismissed = state.dismissed && state.dismissed.key === key;
  return { info, shouldPrompt: !dismissed, dismissKey: key };
}

/** 用户已看到引导并选择「不再提醒」时，记录当前问题指纹。 */
function dismissPythonPrompt(key) {
  const state = readPythonCheckState();
  writePythonCheckState({ ...state, dismissed: { key, at: new Date().toISOString() } });
}

// --------------------------------------------------------------------------
// 版本耦合软闸门：不硬耦合官方的 release.version 强校验，而是维护一份「已验证
// 组合」清单，未验证组合首次启动一次性提示（可继续），同组合不再烦扰。
// --------------------------------------------------------------------------
/**
 * 已验证的 dsh 后端版本（按「官方同期发布 + 本机实测可正常启动」登记）。
 * 0.1.7-alpha.2 = 当前随 0.3.38 一起验证的后端。后续每验证一个版本往这里加。
 */
const VALIDATED_DSH_VERSIONS = [
  '0.1.7-alpha.2'
];

const comboGateStatePath = () => path.join(P().root, 'combo-gate.json');
function readComboGateState() {
  try { return JSON.parse(fs.readFileSync(comboGateStatePath(), 'utf8')); } catch { return {}; }
}
function writeComboGateState(obj) {
  try { fs.writeFileSync(comboGateStatePath(), JSON.stringify(obj, null, 2) + '\n'); } catch (e) { log('write combo-gate state failed:', e.message); }
}

/**
 * 判断当前 shell × dsh 组合是否已验证。
 * 返回 { combo, validated, dshVersion, shellVersion, shouldPrompt }
 */
function comboGateCheck(shellVersion) {
  const dshVersion = currentVersions().dsh || null;
  const validated = dshVersion ? VALIDATED_DSH_VERSIONS.includes(dshVersion) : false;
  const combo = `${shellVersion}__${dshVersion || 'none'}`;
  const state = readComboGateState();
  const shouldPrompt = !validated && !(state.dismissed && state.dismissed.combo === combo);
  return { combo, validated, dshVersion, shellVersion, shouldPrompt };
}
function dismissComboPrompt(combo) {
  const state = readComboGateState();
  writeComboGateState({ ...state, dismissed: { combo, at: new Date().toISOString() } });
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
  // 0.3.40 · 备份目录外置到 dir 的同级 migration-backups/：旧版把 backupDir 建
  // 在 dir 里面，collect() 无差别收集所有 .json——每轮迁移都把上一轮的备份当
  // 待检文件再复制一份，备份套备份滚到 170 层嵌套、10078 个文件、124MB，每次
  // 启动白付 95 秒（启动卡顿的直接根因）。
  const backupRoot = path.join(path.dirname(dir), 'migration-backups');
  const backupDir = path.join(backupRoot, `session_projcache-${formatDateTimestamp()}`);
  let changed = 0; let skipped = 0;
  const files = [];
  function collect(root) {
    let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        // 跳过任何形式的备份目录（本目录内的旧版遗留 + 外置根）——备份文件保存的
        // 就是"迁移前"状态，缺字段是常态，绝不是待迁移对象。
        if (/^migration-backup/i.test(entry.name)) continue;
        collect(full);
      }
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
  if (changed) {
    log(`migrated ${changed} projection cache file(s); backups: ${backupDir}`);
    pruneMigrationBackups(backupRoot);
  } else {
    // 无事可做时清掉刚建的空备份目录。
    try { fs.rmdirSync(backupDir); } catch {}
  }
  return { changed, skipped, backup: changed ? backupDir : null };
}

/** 备份保留上限：migration-backups/ 里最多留 3 份，按名字排序删最旧。 */
const MIGRATION_BACKUPS_RETAINED = 3;
function pruneMigrationBackups(backupRoot) {
  try {
    let names; try { names = fs.readdirSync(backupRoot); } catch { return 0; }
    const dirs = names.filter((n) => /^session_projcache-/.test(n) && (() => { try { return fs.statSync(path.join(backupRoot, n)).isDirectory(); } catch { return false; } })()).sort();
    const excess = dirs.slice(0, Math.max(0, dirs.length - MIGRATION_BACKUPS_RETAINED));
    for (const name of excess) {
      try { fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true }); } catch {}
    }
    return excess.length;
  } catch { return 0; }
}

function ensureSeeded() {
  const p = P();
  let changed = false;
  // 0.3.48 · H-05：必须在**任何 seed 决定之前**看有没有「更新中断」标记 —— seed 一旦
  // 跑起来就会把出厂版本解压进 dsh，把可恢复现场（dsh.old / dsh.previous）盖成
  // 「干净的旧版」。检测只记录 + 暴露状态，不自动恢复（回滚是不可逆动作，决策权在
  // 启动链；非静默：诊断日志 + journal 各留一条）。
  interruptedApplyCache = detectInterruptedApply();
  mkdirp(p.root); mkdirp(path.join(p.root, 'node_modules'));
  // Isolated harness home (created eagerly so junction repair / first boot work even on a fresh install).
  mkdirp(p.dshHome);
  // 0.3.40 · 版本门控：projection 结构迁移只应在 backend dsh 版本变化（或首次
  // 记录）时跑一次。旧版每次启动无条件全量扫描+解析 1 万个文件——迁移早已
  // 幂等完成后依然白付 95 秒，这是"启动卡顿"的第二根因。版本没变 = 结构
  // 没变 = 无需迁移。
  try {
    const lastMigrated = readJson(p.versionsJson, {}).projectionMigratedForDsh || null;
    const curDsh = currentVersions().dsh || null;
    if (!curDsh || lastMigrated !== curDsh) {
      const t0 = Date.now();
      migrateProjectionCache();
      log(`projection migration for dsh ${curDsh} took ${Date.now() - t0}ms`);
      writeJson(p.versionsJson, { ...readJson(p.versionsJson, {}), projectionMigratedForDsh: curDsh });
    }
  } catch (e) { log('projection migration gate failed (running unconditionally):', e && e.message); migrateProjectionCache(); }

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

/** 隔离目录命名前缀与保留份数（README 承诺：保留最近 2 份，且不删任何数据）。 */
const QUARANTINE_PREFIX = 'profiles.broken-';
const QUARANTINE_KEEP = 2;
/**
 * 0.3.48 · H-04：清理只认**本程序自己生成**的隔离目录名
 * （`profiles.broken-YYYYMMDD-HHmmss` / 冲突时追加 `_N`）。
 * 旧实现用 `/^profiles\.broken-/i` 前缀匹配，用户手工建的 `profiles.broken-我的备份`
 * 也会被当成自家产物删掉 —— 清理逻辑必须只删能解析出我方时间戳的目录。
 */
const QUARANTINE_NAME_RE = /^profiles\.broken-\d{8}-\d{6}(_\d+)?$/;

/**
 * 统计一棵树（文件数 / 目录数 / 链接数 / 字节数）。
 * 与 `countTree()` 的区别是**读不到就抛错**：它服务于「复制后校验」，任何读不全的
 * 子目录都必须让校验失败，绝不允许把「读不全」当成「复制一致」。
 */
function measureTree(root) {
  const acc = { files: 0, dirs: 0, links: 0, bytes: 0 };
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) { acc.links++; continue; }
      if (st.isDirectory()) { acc.dirs++; walk(full); continue; }
      acc.files++;
      acc.bytes += st.size;
    }
  };
  walk(root);
  return acc;
}

/**
 * 复制目录树，**绝不进入链接目标**。
 *
 * 0.3.48 · H-04：profiles 树里常驻指向用户插件源码的 junction（见
 * `removeOwnedDirectory` 的注释）。跟随复制会把用户的源码/未提交改动扩进隔离目录，
 * 跟随删除则会直接删掉用户源码。所以遇到链接只在目标侧重建同名链接，其余按文件复制。
 * 读不到（EPERM/EBUSY）直接抛错，由调用方放弃隔离 —— 半份副本不算隔离成功。
 */
function copyTreePreservingLinks(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(src);
    mkdirp(path.dirname(dst));
    try {
      fs.symlinkSync(linkTarget, dst, 'junction');
    } catch (e) {
      // junction 类型只接受绝对目录目标；文件型符号链接用默认类型重建（仍是链接，不复制内容）
      try { fs.symlinkSync(linkTarget, dst); }
      catch (e2) { throw new Error(`重建链接失败 ${dst} → ${linkTarget}: ${e2.message}`); }
    }
    return;
  }
  if (!st.isDirectory()) {
    mkdirp(path.dirname(dst));
    fs.copyFileSync(src, dst);
    return;
  }
  mkdirp(dst);
  for (const name of fs.readdirSync(src)) copyTreePreservingLinks(path.join(src, name), path.join(dst, name));
}

/**
 * H-04 的隔离兜底：复制到隔离目录 → 逐项校验 → 只有校验通过才允许上层删原树。
 *
 * 触发条件：`rename(profiles)` 失败（旧后端句柄未释放 / 杀软或索引服务占用 / 目标名冲突）。
 * 可逆性：复制与校验都成功前**不删任何东西**；失败时只清理我们刚建的半成品副本。
 * 证据要求：校验口径（文件数/目录数/链接数/字节数）落诊断日志，失败原因随返回值上抛。
 *
 * @returns {{ok: boolean, verification?: object, error?: Error, cleanup?: object}}
 */
function quarantineProfilesByCopy(prof, targetPath, targetName) {
  try {
    copyTreePreservingLinks(prof, targetPath);
    const want = measureTree(prof);
    const got = measureTree(targetPath);
    const diff = ['files', 'dirs', 'links', 'bytes']
      .filter((k) => want[k] !== got[k])
      .map((k) => `${k} 期望 ${want[k]} 实得 ${got[k]}`);
    if (diff.length) throw new Error(`复制校验不一致（${diff.join('；')}）`);
    log(`copied profiles to ${targetName} and verified (${want.files} files / ${want.dirs} dirs / ${want.links} links / ${want.bytes} bytes)`);
    return { ok: true, verification: { want, got } };
  } catch (e) {
    // 只清理我们自己刚建的副本（原树自始至终没动过）
    const cleanup = removeOwnedDirectory(targetPath);
    log(`copy-based quarantine to ${targetName} failed: ${e.message}（副本清理：${cleanup.reason || 'removed'}）`);
    return { ok: false, error: e, cleanup };
  }
}

/**
 * 把「已被部分删除的原树」用校验过的副本补回原状（0.3.48 · H-04）。
 *
 * 为什么需要：rename 失败与删除失败通常来自**同一个占用**（杀软扫描 / 索引服务）。
 * 于是「复制成功 → 删除原树」很可能删到一半就被锁挡住，留下半棵 profiles 树 —— 那是
 * 比"没隔离"更糟的状态：插件目录缺文件、package.json 还在，dsh 会报一堆无从归因的错。
 * 因为副本已经过逐项校验，这里只补**缺失**的条目（被占用的文件本来就没被删，跳过），
 * 补完再比一次统计口径，让状态回到「本轮隔离被放弃、原树完好」。
 *
 * @returns {{ok: boolean, reason: string|null, restoredFiles: number, restoredLinks: number}}
 */
function restoreLiveTreeFromCopy(copyRoot, liveRoot) {
  let restoredFiles = 0;
  let restoredLinks = 0;
  const walk = (src, dst) => {
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      if (fs.existsSync(dst)) return;
      mkdirp(path.dirname(dst));
      try { fs.symlinkSync(fs.readlinkSync(src), dst, 'junction'); }
      catch (e) { fs.symlinkSync(fs.readlinkSync(src), dst); }
      restoredLinks++;
      return;
    }
    if (!st.isDirectory()) {
      if (fs.existsSync(dst)) return;
      mkdirp(path.dirname(dst));
      fs.copyFileSync(src, dst);
      restoredFiles++;
      return;
    }
    mkdirp(dst);
    for (const name of fs.readdirSync(src)) walk(path.join(src, name), path.join(dst, name));
  };
  try {
    walk(copyRoot, liveRoot);
    const want = measureTree(copyRoot);
    const got = measureTree(liveRoot);
    const diff = ['files', 'dirs', 'links', 'bytes'].filter((k) => want[k] !== got[k]);
    if (diff.length) {
      return { ok: false, reason: `还原后仍不一致（${diff.map((k) => `${k} ${want[k]}≠${got[k]}`).join('；')}）`, restoredFiles, restoredLinks };
    }
    return { ok: true, reason: null, restoredFiles, restoredLinks };
  } catch (e) {
    return { ok: false, reason: e.message, restoredFiles, restoredLinks };
  }
}

function pruneQuarantineProfiles(home) {
  try {
    const entries = fs.readdirSync(home);
    const quarantineDirs = [];
    for (const entry of entries) {
      if (!QUARANTINE_NAME_RE.test(entry)) continue;
      const full = path.join(home, entry);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory()) {
        quarantineDirs.push({ name: entry, path: full, mtime: st.mtimeMs });
      }
    }

    quarantineDirs.sort((a, b) => b.name.localeCompare(a.name) || (b.mtime - a.mtime));

    if (quarantineDirs.length > QUARANTINE_KEEP) {
      const toRemove = quarantineDirs.slice(QUARANTINE_KEEP);
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
 * 把可疑的 profiles 目录隔离成 `profiles.broken-<YYYYMMDD-HHmmss>`（保留最近 2 份）。
 *
 * 0.3.48 · H-04：rename 失败后的兜底从「rimraf 整棵树」改为「复制 → 校验 → 才删原树」。
 * 为什么这样改：旧兜底在 rename 被占用打断时直接物理删除用户的插件注册树与依赖实体，
 * 与 README「启动自愈最坏也只是隔离备份，不删任何数据」的承诺正相反；而且删完就没得救
 * （`restoreProfileRegistrations` 只能恢复 package.json 里的名字，依赖实体已不存在）。
 * 现在的失败顺序是：rename 失败 → 复制到隔离目录并校验（文件/目录/链接/字节数）→
 * 校验通过后才删原树；复制或校验失败就**放弃本轮隔离**，原树保持字节不变；删除被同一个
 * 占用挡到一半时，用校验过的副本把原树**补回原状**再放弃本轮隔离。所有结论都写诊断日志
 * 并由返回值如实上报（阶梯本身允许跳过隔离，见 ladder-policy.js:99-110）。
 *
 * @returns {{quarantined: boolean, name: string|null, path: string|null, fallback: boolean,
 *            copied: boolean, abandoned: boolean, reason: string|null, removal: object|null,
 *            restore: object|null, registryFile: string|null, registry: Array}}
 *   `quarantined` 只在「原目录确实已整体离开原位」时为 true；
 *   `fallback` 表示走了复制兜底；`abandoned` 表示本轮隔离被放弃（原目录保持/已还原）。
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

/**
 * 隔离整个 profiles 目录（核弹级动作，最后手段）。
 *
 * ⚠️ 副作用纪律（0.3.41 · 对齐官方 shell/Host 配置所有权规约）：本函数只能修
 * **profile 层**的问题。home 层文件（`.credentials.yaml`、`settings.yaml`）不在
 * profiles 里，重建 profiles 对它们 100% 无效——2026-10-11 事故中，坏键
 * `repo-push-access:github.com` 让 credentials 插件加载即抛 TypeError，报错文案
 * 只有 "1 required plugin did not activate"（无插件名），归因式升级全部落空，
 * 于是本函数被连调三次：隔离→重建→仍失败→再隔离，一夜烧掉三份 profile，还顺手
 * prune 掉三份历史隔离。
 *
 * 因此调用方必须先跑凭据归因护栏（main.js Escalation 1d + analyzeCredentialFailure）：
 * 一旦日志点名 home 级文件，就跳过本函数。官方规约原文：
 * "Ownership follows runtime dependencies" —— shell 只负责 Host 启动前/不可用时的
 * 自身配置，Host 层配置（含凭据）归 Host 所有，shell 不越权重建立。
 */
function quarantineProfiles(home) {
  const prof = path.join(home, 'profiles');
  if (!fs.existsSync(prof)) {
    return { quarantined: false, name: null, path: null, fallback: false, copied: false, abandoned: false, reason: null, removal: null, registryFile: null, registry: [] };
  }

  const timestamp = formatDateTimestamp();
  let targetName = `${QUARANTINE_PREFIX}${timestamp}`;
  let targetPath = path.join(home, targetName);

  let counter = 1;
  while (fs.existsSync(targetPath)) {
    targetName = `${QUARANTINE_PREFIX}${timestamp}_${counter++}`;
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
  let copied = false;
  let abandoned = false;
  let reason = null;
  let removal = null;
  let restore = null;

  try {
    fs.renameSync(prof, targetPath);
    quarantined = true;
    log(`quarantined broken profiles to ${targetName}`);
  } catch (e) {
    // 0.3.48 · H-04：**绝不**在 rename 失败后直接删用户数据。
    // 触发条件：旧后端句柄未释放 / 杀软或索引服务占用 / 目标名冲突后 rename 仍失败。
    // 可逆性：复制与校验都成功前不删任何东西；失败即放弃本轮隔离。
    // 证据要求：失败原因与校验口径必须进诊断日志，并通过返回值让上层看得见。
    log(`rename profiles to ${targetName} failed (${e.message}); falling back to copy-then-verify quarantine (user data is never deleted first)`);
    const copyRes = quarantineProfilesByCopy(prof, targetPath, targetName);
    if (!copyRes.ok) {
      abandoned = true;
      reason = `复制隔离失败，已放弃本轮隔离并保留原 profiles：${copyRes.error.message}`;
      log(reason);
    } else {
      copied = true;
      fallback = true;
      // 复制且校验通过 —— 此刻用户数据已有完整副本，才允许删除原树。
      removal = removeOwnedDirectory(prof);
      quarantined = !!removal.removed;
      if (quarantined) {
        log(`removed original profiles tree after verified copy (copy kept at ${targetName})`);
      } else {
        // 删除被同一个占用挡住 → 原树已被部分删除：用校验过的副本补回原状再放弃本轮隔离
        log(`original profiles tree NOT fully removed (${removal.reason || 'unknown'}); restoring it from the verified copy`);
        restore = restoreLiveTreeFromCopy(targetPath, prof);
        abandoned = true;
        reason = `删除原 profiles 未完成（${removal.reason || 'unknown'}），已用校验过的副本还原；本轮隔离放弃，副本保留在 ${targetName}`;
        if (restore.ok) log(`原 profiles 已从 ${targetName} 还原（补回 ${restore.restoredFiles} 文件 / ${restore.restoredLinks} 链接）`);
        else log(`原 profiles 还原未完成：${restore.reason}（完整副本仍在 ${targetName}，数据未丢）`);
      }
    }
  }

  if (quarantined) pruneQuarantineProfiles(home);

  return {
    quarantined,
    name: (quarantined || copied) ? targetName : null,
    path: (quarantined || copied) ? targetPath : null,
    fallback, copied, abandoned, reason, removal, restore,
    registryFile, registry
  };
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

/**
 * Normalize a module specifier for matching: file:// URLs -> decoded path, strip ?v=N query, lowercase, forward slashes.
 * （0.3.46 起实现在 patch-file.js —— 与预检/归因共用同一份语义）
 */

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

  // 2) Loader/plugin-tree failure signals. "failed to import loader entry" is
  //    cordis-plugin-loader's updateError wrapper (dsh 0.1.2-rc.1+ format) —
  //    it MUST count as a plugin-tree failure or crash-mode attribution never
  //    engages for it (the codebuddy-first-bridge@1.1.7 incident fell through
  //    the whole ladder to whole-tree safe mode precisely because of this gap).
  const pluginTree = /plugin tree failed to load/i.test(logText) ||
    /The following plugins? (?:were unable to load|failed to load)/i.test(logText) ||
    /failed to (?:load|mount|import|apply)(?: loader entry)?/i.test(logText);

  // 3) Error lines that name the crashing module (file:// URL, quoted token,
  //    path-like spec, or kebab-case bare name). Attribution happens against
  //    patch entry names later, so over-collection is harmless.
  const errLineRe = /^.*\b(?:SyntaxError|TypeError|ReferenceError|ERR_[A-Z0-9_]+|is not a function|is not defined|does not provide an export named|failed to (?:load|mount|import|apply)(?: loader entry)?|loaded without registering|unable to load|Cannot (?:find|read|resolve|parse)|no such file|Cannot find module).*$/gim;
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
    // "failed to import loader entry <hash> (<pkg>)" — the wrapper names the
    // npm package in PARENTHESES; the bare <hash> is an internal entry id
    // that maps to nothing. Extracted explicitly so scoped names (@scope/pkg
    // without a hyphen, invisible to the kebab pattern) still attribute.
    for (const e of l.matchAll(/loader entry\s+\S+\s*\(\s*([^)\s]+)\s*\)/gi)) add(e[1]);
    // dsh-client-modules combo runtime: 'bundle <pkg> loaded without registering "<pkg>"'.
    for (const w of l.matchAll(/(?:loaded without registering|failed to register)\s+["']?([A-Za-z0-9@_.\/-]+)["']?/gi)) add(w[1]);
  }

  return { specifiers: out, pluginTree, cannotFind };
}

/**
 * Parse a cordis.patch.yml into top-level `- insert:` blocks, each with
 * sub-entries [{ id, name, lineStart, lineEnd }] where lineStart/lineEnd are
 * 0-based line indexes covering exactly that entry (its id/name/config lines,
 * NOT the whole block). Returns [] if nothing can be parsed.
 *
 * 0.3.46：实现在 patch-file.js（与解析根模型共用，避免两处语义漂移）。
 */

/**
 * Whether a patch entry's source is currently loadable:
 *  - file:// name -> the referenced file must exist on disk
 *  - bare name   -> must resolve through the **runtime** resolution roots
 *    (the same model the pre-flight uses — see plugin-resolution.js).
 *
 * 0.3.46：旧实现只认 profiles/web|profiles|家级 node_modules 下的 **junction**
 * （真实目录都不算），既漏掉了官方后端安装树里的官方包，又把真实目录误判为
 * 「不可用」。归因逻辑与预检用同一套模型，才能得出互不矛盾的结论。
 */
function pluginSourceAvailable(home, entry) {
  const name = entry && entry.name;
  if (!name) return false;
  if (/^file:/i.test(name)) {
    const p = specToPath(name);
    return !!(p && fs.existsSync(p));
  }
  const bare = barePackageName(name); // tolerate a ?v=N cache buster on bare names
  if (!bare) return false;
  const roots = runtimeResolutionRoots(home);
  if (pluginResolution.resolveBareName(roots, bare).resolved) return true;
  // 家级 node_modules 下的 junction 也算可用（历史行为，保持兼容）
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
 * 0.3.41 · 启动前凭据文档结构预校验。
 *
 * 背景（2026-10-11 事故）：home 级 `.credentials.yaml` 里一条记录的键写成
 * `repo-push-access:github.com`（冒号分隔），而 dsh 的 parseCredentialKey 要求
 * 恰好两段 `<scope>/<id>`。credentials 插件加载即抛 TypeError，它是 9 个插件的
 * 依赖 → 整个后端启动失败，报 `1 required plugin did not activate`。
 *
 * 该失败与 profiles 毫无关系，但自愈阶梯的归因式升级（1b 插件条目 / 1c bundle）
 * 在日志里找不到任何**具名插件包**线索（消息只给通用"1 required plugin"），
 * 于是直接跳到核弹级 quarantineProfiles：隔离 → 重建 → 仍读坏凭据 → 再失败，
 * 一夜连烧三份 profile（并顺手 prune 掉三份历史隔离备份）。
 *
 * 本函数只做**结构扫描**：定位非法键、给出精确行号与原因，绝不读取/回显任何
 * 密钥值（隐私纪律）。返回 { ok, file, present, problems: [{ line, key, reason }] }。
 */
function validateCredentialsDocument(home) {
  const file = path.join(home, '.credentials.yaml');
  const out = { ok: true, file, present: false, problems: [] };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  out.present = true;

  const lines = text.split(/\r?\n/);
  // 凭证记录的键出现在两种形态：
  //   1) 顶层映射键（旧版扁平写法）   `repo-push-access:github.com: { ... }`
  //   2) records 列表项内 / refs 之外的键行
  // 判定只依赖 dsh 自己的规则：key.split('/') 必须恰好 2 段且都非空。
  // 已知的结构性键（version/refs/records/kind/payload/...）一律跳过。
  const STRUCTURAL = new Set([
    'version', 'refs', 'records', 'kind', 'payload', 'secret', 'id', 'v', 'sourceId',
    'account', 'scopes', 'method', 'token', 'validatedAt', 'extra', 'issuer', 'avatarUrl',
    'fineGrained', 'admin', 'delete', 'write', 'read', 'url', 'label', 'note', 'expiresAt'
  ]);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || /^\s*#/.test(raw)) continue;
    // YAML 键行 = 缩进 + 键 + 冒号（后面可为空、空格、或 {、|、> 等块标记）。
    // 关键：非法键**自身含冒号**（`repo-push-access:github.com`），所以按 dsh 自己的
    // 规则反推——先取「最后一个 : 之后不是空白也不是行尾」以外的位置。实用做法：
    // 剥掉行尾「: 值」部分后剩下的就是键；对 `a: b: c` 这种值含冒号的写法，用 dsh 的
    // 判定式去验证，能通过的就是合法键，通不过的再考虑"是不是键本身写错了"。
    const trimmed = raw.replace(/\s+$/, '');
    if (!trimmed.includes(':')) continue;

    // 候选键：优先「行尾即冒号」的写法（`key:` 或 `key: {`）——把冒号前的整段当键。
    let key = null;
    const trailingColon = /^(\s*)(.*?)\s*:\s*(?:[|>][-+]?|[[{].*|\{\}|)$/.exec(trimmed);
    if (trailingColon) {
      key = trailingColon[2];
    } else {
      // 有内联值：取第一个「: 」分隔；若前缀本身仍含冒号且不是合法键，则取最右冒号。
      const first = /^(\s*)(.*?)\s*:\s+(\S.*)$/.exec(trimmed);
      if (first) {
        key = first[2];
        if (key.includes(':') && !isCredentialKeyShape(key)) {
          const head = trimmed.replace(/^\s*/, '');
          const lc = head.lastIndexOf(':');
          const cand = head.slice(0, lc);
          if (cand && !/\s/.test(cand)) key = cand;
        }
      }
    }
    if (key === null) continue;
    key = key.trim().replace(/^["']|["']$/g, '');
    if (!key || /\s/.test(key) || STRUCTURAL.has(key)) continue;
    // 已经是合法形态 → 跳过
    if (isCredentialKeyShape(key)) continue;
    // 非法候选：必须"像一条凭证键"（冒号分隔两段，或斜杠段数不对）
    const colonForm = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.:-]+$/.test(key);
    const slashForm = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(key) && key.split('/').length > 2;
    if (!colonForm && !slashForm) continue;
    const reason = colonForm
      ? `凭证键用了冒号分隔（"${key}"），dsh 要求 "<scope>/<id>"`
      : `凭证键段数不为 2（"${key}"），dsh 要求 "<scope>/<id>"`;
    out.problems.push({ line: i + 1, key, reason });
  }
  out.ok = out.problems.length === 0;
  return out;
}

/** dsh 的判定式：split('/') 恰好 2 段且都非空。 */
function isCredentialKeyShape(key) {
  const segs = String(key).split('/');
  return segs.length === 2 && segs[0] !== '' && segs[1] !== '';
}

/**
 * 0.3.41 · 把非法凭证键规范化成 dsh 要求的 `<scope>/<id>`。
 *   - 首个冒号 → 斜杠（`repo-push-access:github.com` → `repo-push-access/github.com`）
 *   - 斜杠后的 id 段里 `.`/`:` → `-`（dsh 自己的修复产物是 `github-com`）
 *   - 斜杠超过 2 段 → 从第 2 段起合并成一个 id（多余斜杠 → `-`）
 * 只改键，绝不触碰值；写前备份、原子替换。返回 { changed: [...], backup }。
 */
function repairCredentialKeys(home, problems) {
  const file = path.join(home, '.credentials.yaml');
  const out = { changed: [], backup: null, failed: [] };
  if (!Array.isArray(problems) || !problems.length) return out;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { out.failed.push(String(e && e.message)); return out; }

  const normalize = (key) => {
    let scope; let id;
    if (key.includes(':')) {
      const at = key.indexOf(':');
      scope = key.slice(0, at);
      id = key.slice(at + 1);
    } else {
      const segs = key.split('/');
      scope = segs[0];
      id = segs.slice(1).join('-');
    }
    // scope 保留点号（与 dsh 的 scope 命名习惯一致）；id 段收敛到 [A-Za-z0-9_-]，
    // 使产物与 dsh 上游自己的修复形态一致（`github.com` → `github-com`）——
    // 避免同一逻辑键在文件里出现两种写法导致凭证被当成两条。
    scope = scope.replace(/[^A-Za-z0-9_.-]/g, '-');
    id = id.replace(/[^A-Za-z0-9_-]/g, '-');
    return `${scope}/${id}`;
  };

  const lines = text.split(/\r?\n/);
  const backups = [];
  for (const p of problems) {
    const idx = p.line - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const raw = lines[idx];
    // 键含冒号，不能用「第一个冒号」切分。改为：把已知的原键字面量视为「缩进 + 键 + 冒号」
    // 的前缀，直接按字面替换（防并发改写：字面不匹配就跳过，绝不做错误替换）。
    const indent = (raw.match(/^\s*/) || [''])[0];
    const afterIndent = raw.slice(indent.length);
    if (!afterIndent.startsWith(`${p.key}:`)) continue;
    const rest = afterIndent.slice(p.key.length); // 以 ':' 开头
    const fixed = normalize(p.key);
    backups.push({ line: p.line, from: p.key, to: fixed });
    lines[idx] = `${indent}${fixed}${rest}`;
  }
  if (!backups.length) return out;

  const stamp = formatDateTimestamp();
  const backup = `${file}.bak-before-keyscope-${stamp}`;
  try {
    fs.copyFileSync(file, backup);
    out.backup = backup;
  } catch (e) { out.failed.push(`备份失败：${e && e.message}`); return out; }

  try {
    const temp = `${file}.keyscope-${process.pid}.tmp`;
    fs.writeFileSync(temp, lines.join('\n'), 'utf8');
    fs.renameSync(temp, file);
    out.changed = backups;
  } catch (e) {
    out.failed.push(`写入失败：${e && e.message}`);
    try { fs.unlinkSync(`${file}.keyscope-${process.pid}.tmp`); } catch {}
  }
  return out;
}

/**
 * 0.3.41 · 从后端日志判定"凭据文档导致启动失败"。
 *
 * 这是自愈阶梯的**升级护栏**：命中时绝不能隔离 profiles（根因在 home 级、
 * profile 之外，隔离 100% 无效且会白烧用户的插件注册）。返回
 * { credentials: boolean, pluginCount, keys: [...] }。
 */
function analyzeCredentialFailure(logText) {
  const text = String(logText || '');
  const out = { credentials: false, pluginCount: 0, keys: [] };
  if (!text) return out;
  const keyErr = /credential key "([^"]+)" must be "<scope>\/<id>"/g;
  let m;
  while ((m = keyErr.exec(text)) !== null) {
    if (out.keys.indexOf(m[1]) === -1) out.keys.push(m[1]);
  }
  const failedCreds = /Failed plugins \(\d+\):[\s\S]{0,400}?\bcredentials\b/.test(text)
    || /Package:\s*@deepseek-ai\/dsh-credentials(?:-local)?\b/.test(text);
  const startup = /startup failed:\s*(\d+)\s+required plugin/.exec(text);
  if (startup) out.pluginCount = Number(startup[1]) || 0;
  out.credentials = (out.keys.length > 0) || (failedCreds && !!startup && out.pluginCount > 0);
  return out;
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
 * 禁用标记：预检/冲突修复禁用条目时，在被注释的条目上方留一行**机器可读**的
 * 标记。它是「这条注释是我们自动禁用留下的、可被自动恢复」的唯一凭据 ——
 * 用户自己注释掉的条目没有这行标记，因此永远不会被自动恢复。
 *
 * 0.3.46 新增：此前禁用只有整文件备份，事后无法区分「应用禁用的」与
 * 「用户注释的」，只能靠人肉比对 .disabled-*.bak。
 */
const PREFLIGHT_MARKER = 'dsh-desktop:preflight-disabled';

/** 构造一行标记（单行 YAML 注释，换行与制表符一律压平）。 */
function buildDisableMarker(id, name, kind, reason) {
  const one = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim();
  return `# ${PREFLIGHT_MARKER} id=${one(id)} name=${one(name)} kind=${one(kind || 'unknown')} at=${new Date().toISOString()} reason=${one(reason || '')}`;
}

/**
 * Comment out ONLY the given plugin entry id(s) inside a cordis.patch.yml —
 * entry-level granularity: sibling entries in the same `- insert:` block are
 * left untouched. Backs the file up first. Returns
 * { disabled: [ids], backup: <path|null> }.
 *
 * 0.3.46：每个被禁用的条目上方写一行 PREFLIGHT_MARKER 标记（可被自动恢复）。
 */
function disablePatchEntriesInFile(patchPath, ids, meta = {}) {
  if (!ids || !ids.length || !fs.existsSync(patchPath)) return { disabled: [], backup: null };

  let yamlText;
  try { yamlText = fs.readFileSync(patchPath, 'utf8'); } catch (e) { log('read patch failed:', e.message); return { disabled: [], backup: null }; }
  const eol = yamlText.includes('\r\n') ? '\r\n' : '\n';
  const lines = yamlText.split(/\r?\n/);
  const blocks = parseHomePatchBlocks(yamlText);
  const want = new Set(ids);
  const hit = new Set();

  // 先算出「哪些行要注释」以及「哪些块头要注释」，再一次性拼装输出 ——
  // 这样标记行可以插在条目正上方，且不影响其它条目的行号语义。
  const commentLines = new Set();
  const entryStarts = new Map();   // 行号 → { id, name }
  const commentBlockStarts = new Set();
  for (const block of blocks) {
    let disabledInBlock = 0;
    for (const entry of block.entries) {
      if (!want.has(entry.id)) continue;
      hit.add(entry.id);
      disabledInBlock++;
      for (let i = entry.lineStart; i < entry.lineEnd; i++) {
        const l = lines[i];
        if (l.trimStart().startsWith('#')) continue;
        commentLines.add(i);
      }
      entryStarts.set(entry.lineStart, { id: entry.id, name: entry.name });
    }
    // If EVERY active entry of the block got disabled, comment the block's
    // `- insert:` line too — a bare `- insert:` with nothing under it would
    // become a null insert for the loader.
    if (block.entries.length > 0 && disabledInBlock === block.entries.length) {
      const l = lines[block.start];
      if (l && !l.trimStart().startsWith('#')) commentBlockStarts.add(block.start);
    }
  }

  if (!hit.size) return { disabled: [], backup: null };

  const ts = formatDateTimestamp();
  const backup = patchPath + `.disabled-${ts}.bak`;
  try { fs.copyFileSync(patchPath, backup); } catch (e) { log('backup patch failed:', e.message); return { disabled: [], backup: null }; }

  const outLines = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const meta2 = entryStarts.get(i);
    if (meta2) {
      outLines.push(buildDisableMarker(meta2.id, meta2.name, meta.kind, meta.reason || meta2.name));
    }
    if (commentLines.has(i)) {
      outLines.push(l.trim() === '' ? '#' : '#' + l); // keep indentation for easy manual restore
    } else if (commentBlockStarts.has(i)) {
      outLines.push('#' + l);
    } else {
      outLines.push(l);
    }
  }

  let out = outLines.join(eol);
  if (!outLines.some((l) => /^\s*- insert:/.test(l))) out += eol + '[]' + eol; // keep a valid (empty) patch array
  try { fs.writeFileSync(patchPath, out); } catch (e) { log('write patch failed:', e.message); return { disabled: [], backup: null }; }

  log(`disabled patch entries in ${path.basename(path.dirname(patchPath))}: ${[...hit].join(', ')} (backup: ${backup})`);
  return { disabled: [...hit], backup };
}

/**
 * 把一行「原文」转成禁用后的样子（用于校验 live 文件确实是该备份禁用出来的）。
 */
function expectedDisabledLine(original) {
  if (original.trim() === '') return '#';
  if (original.trimStart().startsWith('#')) return original;
  return '#' + original;
}

/**
 * 恢复「被预检误禁用、且现在已经能解析」的条目。
 *
 * 0.3.46 新增 —— 自愈对称化：应用会自动禁用条目，就必须也能自动撤销自己的
 * 误伤。2026-10-15 / 10-20 两次把官方后端树里的 @deepseek-ai/dsh-mcp-client
 * 判成「装不上」并禁用（其中一次还弹了窗），若没有恢复通道，用户只能手工
 * 改补丁文件。
 *
 * 恢复依据与安全约束：
 *   · 依据 = 应用自己写下的 `.disabled-<ts>.bak` 快照（禁用前的原文）；
 *   · 只恢复「备份里是活跃的、live 里被注释掉的」条目 —— 用户自己注释掉的
 *     条目在备份里同样是注释，不会被误恢复；
 *   · live 的注释行必须**逐行**等于「备份原文加前缀 #」，否则跳过（说明用户
 *     在禁用之后改过文件，不能替他决定）；
 *   · 条目当前必须真的能解析（裸包名走运行时解析根 / file:// 目标存在），
 *     否则保持禁用 —— 恢复一个仍然装不上的条目只会让下次启动再崩一次；
 *   · 恢复前给 live 文件再留一份备份。
 *
 * @param {string} home dsh-home
 * @param {object} opts { roots, conflictIds:Set<string> }
 * @returns {{restored: [{file,id,name}], skipped: [{file,id,reason}]}}
 */
function restorePreflightDisabledEntries(home, opts = {}) {
  const out = { restored: [], skipped: [] };
  const roots = opts.roots || runtimeResolutionRoots(home);
  const conflictIds = opts.conflictIds || new Set();
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
    let liveText;
    try { liveText = fs.readFileSync(patchPath, 'utf8'); } catch { continue; }
    const eol = liveText.includes('\r\n') ? '\r\n' : '\n';
    let liveLines = liveText.split(/\r?\n/);
    // 历史禁用事件（桌面日志取证）—— 只在需要时读一次
    const logEvents = loggedBareNameDisableEvents(readDesktopLogTail(opts.logFile));

    // 备份按时间戳倒序（新的在前）
    let backups = [];
    try {
      const dir = path.dirname(patchPath);
      const base = path.basename(patchPath);
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(`${base}.disabled-`) || !f.endsWith('.bak')) continue;
        backups.push(path.join(dir, f));
      }
    } catch {}
    backups.sort((a, b) => b.localeCompare(a));
    if (!backups.length) continue;

    // 每次恢复都会改变行号 ⇒ 反复扫描直到不再有可恢复项
    let progress = true;
    let dirty = false;
    while (progress) {
      progress = false;
      const liveTextNow = liveLines.join(eol);
      const commented = parseCommentedPatchEntries(liveTextNow);
      if (!commented.length) break;
      // live 里当前活跃的条目 id（用于重复 id 守卫）
      const activeIds = new Set();
      for (const b of parseHomePatchBlocks(liveTextNow)) {
        for (const e of b.entries) activeIds.add(e.id);
      }
      // 我们自己写的禁用标记（0.3.46 起）—— 标记里带 kind，能区分禁用原因
      const markers = readDisableMarkers(liveTextNow);

      for (const backupPath of backups) {
        let backupText;
        try { backupText = fs.readFileSync(backupPath, 'utf8'); } catch { continue; }
        const backupLines = backupText.split(/\r?\n/);
        const backupBlocks = parseHomePatchBlocks(backupText);
        const backupEntries = new Map();
        for (const b of backupBlocks) {
          for (const e of b.entries) backupEntries.set(e.id, { entry: e, block: b });
        }

        // 受害者集合：**只撤销「裸包名不可解析」这一类误伤**。
        //   ① 0.3.46 起：条目上方有我们自己的标记，kind=bare-name-unresolvable；
        //   ② 0.3.46 之前：没有标记，靠桌面日志里的禁用事件与备份文件时间对齐取证。
        // 其它原因的禁用（loader id 冲突、插件包加载失败等）**不在恢复范围内** ——
        // 擅自恢复它们可能直接造成启动失败。
        const victims = new Set();
        for (const [id, mk] of markers) {
          if (mk.kind === 'bare-name-unresolvable') victims.add(id);
        }
        if (!victims.size && logEvents.length) {
          let stamp = backupStampMs(backupPath);
          if (!Number.isFinite(stamp)) {
            try { stamp = fs.statSync(backupPath).mtimeMs; } catch { stamp = NaN; }
          }
          for (const ev of logEvents) {
            if (ev.file !== patchPath) continue;
            if (!Number.isFinite(ev.t) || !Number.isFinite(stamp)) continue;
            if (ev.t >= stamp - 180000 && ev.t <= stamp + 60000) for (const id of ev.ids) victims.add(id);
          }
        }

        // 同 id 可能有多份副本（历史快照恢复版 vs 更早的旧版）。**较新的那份才是
        // 当前意图**（旧版是快照恢复时被取代的遗留注释），所以从后往前尝试，
        // 先命中的是最后一份副本。
        const candidates = commented.slice().sort((a, b) => b.lineStart - a.lineStart);
        for (const c of candidates) {
          if (!victims.has(c.id)) continue;            // 不是这一类误伤 ⇒ 不碰
          if (conflictIds.has(c.id)) { pushSkip(out, patchPath, c.id, '仍存在 loader id 冲突'); continue; }
          // 同一 id 在 live 里已有活跃条目 ⇒ 恢复会造成 duplicate loader entry id
          // （那是致命的启动失败）。
          if (activeIds.has(c.id)) {
            pushSkip(out, patchPath, c.id, '同 id 的条目已处于活跃状态，恢复会造成重复 id（跳过）');
            continue;
          }
          const be = backupEntries.get(c.id);
          if (!be) continue;                       // 备份里它本就不是活跃条目 → 不是我们禁用的
          const original = backupLines.slice(be.entry.lineStart, be.entry.lineEnd);
          if (!original.length) continue;

          // 逐行校验：live 必须是「原文加 # 前缀」的结果
          const livePart = liveLines.slice(c.lineStart, c.lineEnd);
          const rebuilt = [];
          let bi = 0;
          let ok = true;
          for (const ll of livePart) {
            const bl = original[bi];
            if (bl !== undefined && ll === expectedDisabledLine(bl)) { rebuilt.push(bl); bi++; continue; }
            if (bl === undefined) { rebuilt.push(ll); continue; }
            // 当前行与备份对不上：用户在禁用之后改过文件 ⇒ 不替他决定
            if (ll.trim() !== '' && !ll.trimStart().startsWith('#')) { ok = false; break; }
            rebuilt.push(ll);
          }
          if (!ok || bi !== original.length) {
            pushSkip(out, patchPath, c.id, 'live 内容与禁用前快照不一致（用户改过），不自动恢复');
            continue;
          }

          // 条目现在必须真的可用，否则保持禁用
          const name = be.entry.name;
          const usable = name
            ? (/^file:/i.test(name)
              ? !!(specToPath(name) && fs.existsSync(specToPath(name)))
              : pluginResolution.resolveBareName(roots, barePackageName(name)).resolved)
            : false;
          if (!usable) {
            pushSkip(out, patchPath, c.id, `包「${barePackageName(name)}」目前仍无法解析，保持禁用`);
            continue;
          }

          // 恢复：换回备份里的原文，并清掉我们自己写的禁用标记
          const head = liveLines.slice(0, c.lineStart);
          const tail = liveLines.slice(c.lineEnd);
          const markerLine = head.length ? head[head.length - 1] : '';
          const markerRe = new RegExp(`^\\s*#\\s*${PREFLIGHT_MARKER}\\s+id=${c.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
          if (markerRe.test(markerLine)) head.pop();
          liveLines = head.concat(rebuilt, tail);

          // 块头 `- insert:` 若当初也被注释掉了，一并恢复（**必须是本条目所属的块头**，
          // 不能取文件里第一个被注释的块头 —— 那可能属于另一个块）
          const blockBackupLine = backupLines[be.block.start];
          if (blockBackupLine && /^\s*- insert:/.test(blockBackupLine) && c.blockStart >= 0) {
            const liveBlockLine = liveLines[c.blockStart];
            if (liveBlockLine && /^\s*#\s*- insert:/.test(liveBlockLine)) liveLines[c.blockStart] = blockBackupLine;
          }

          out.restored.push({ file: patchPath, id: c.id, name });
          dirty = true;
          progress = true;
          break;
        }
        if (progress) break;
      }
    }

    if (dirty) {
      if (opts.dryRun) {
        log('[dry-run] 将恢复以下条目:', out.restored.map((r) => r.id).join(', '));
        continue;
      }
      // 并发保护：写回之前确认文件自我们读取以来没被改过（另一个会话/用户
      // 可能正在编辑补丁文件 —— 覆盖掉别人的改动是不可接受的）。
      let current = '';
      try { current = fs.readFileSync(patchPath, 'utf8'); } catch {}
      if (current !== liveText) {
        log('restore aborted: 补丁文件在处理期间被修改过（不覆盖别人的改动）', patchPath);
        out.skipped.push({ file: patchPath, id: '(全部)', reason: '文件在处理期间被修改，已放弃写回' });
        break;
      }
      const ts = formatDateTimestamp();
      const backup = patchPath + `.restore-${ts}.bak`;
      try { fs.copyFileSync(patchPath, backup); } catch (e) { log('backup before restore failed:', e.message); }
      try { fs.writeFileSync(patchPath, liveLines.join(eol)); }
      catch (e) { log('write patch (restore) failed:', e.message); }
    }
  }
  if (out.restored.length) log('pre-flight restored previously disabled entries:', out.restored.map((r) => r.id).join(', '));
  return out;
}

/** 记录一条「跳过恢复」的原因（同一条目只留一条）。 */
function pushSkip(out, file, id, reason) {
  if (out.skipped.some((s) => s.file === file && s.id === id)) return;
  out.skipped.push({ file, id, reason });
}

/**
 * 从补丁文件里读出**我们自己写的禁用标记**（0.3.46 起）。
 * @returns {Map<string, {kind: string, reason: string, at: string}>}
 */
function readDisableMarkers(liveText) {
  const map = new Map();
  const re = new RegExp(`^\\s*#\\s*${PREFLIGHT_MARKER}\\s+id=(\\S+)\\s+name=([^\\s]*)\\s+kind=(\\S+)\\s+at=([^\\s]*)\\s+reason=(.*)$`);
  for (const line of String(liveText || '').split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    map.set(m[1], { kind: m[3], reason: m[5] || '', at: m[4] });
  }
  return map;
}

/**
 * 历史取证：从桌面日志里找出「因裸包名不可解析而被禁用」的事件。
 *
 * 0.3.46 之前禁用只留整文件备份、没有原因标记，只能靠日志还原：每次禁用前
 * 都会紧跟一条「启动预检发现待处理项: {...}」JSON，其中的 reason 含
 * 「冷启动必然失败」的就是**裸包名预检**的受害者 —— loader id 冲突的原因
 * 文案（重复声明 / 已通过官方通道安装）不含这句话。
 *
 * @returns {Array<{t: number, file: string, ids: string[]}>}
 */
function loggedBareNameDisableEvents(logText) {
  const out = [];
  for (const line of String(logText || '').split(/\r?\n/)) {
    if (!line.includes('启动预检发现待处理项:')) continue;
    const ts = /^\[(\d{4}-\d{2}-\d{2}T[^Z]+Z)\]/.exec(line);
    const jsonStart = line.indexOf('启动预检发现待处理项:') + '启动预检发现待处理项:'.length;
    let payload = null;
    try { payload = JSON.parse(line.slice(jsonStart).trim()); } catch { continue; }
    const conflicts = (payload && payload.conflicts) || [];
    const hits = conflicts.filter((c) => c && c.reason && /冷启动必然失败/.test(c.reason));
    if (!hits.length) continue;
    const t = ts ? Date.parse(ts[1]) : NaN;
    const byFile = new Map();
    for (const c of hits) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file).push(c.id);
    }
    for (const [file, ids] of byFile) out.push({ t, file, ids });
  }
  return out;
}

/**
 * 备份文件名里的时间戳 → epoch 毫秒（本地时区）。
 *
 * 禁用备份的命名是 `<patch>.disabled-<YYYYMMDD-HHMMSS>.bak`，那个时间戳就是
 * **禁用发生的那一刻**。注意：不能用文件的 mtime —— Windows 的 CopyFile 会
 * 继承源文件的时间戳，备份的 mtime 其实是补丁文件上次被编辑的时间
 * （实测 10-20 的禁用备份 mtime 停在 10-19 20:44），对不上日志事件。
 */
function backupStampMs(backupPath) {
  const m = /\.disabled-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.bak$/.exec(String(backupPath));
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** 读桌面日志尾部（避免一次读进几十 MB）。 */
function readDesktopLogTail(logFile, maxBytes = 8 * 1024 * 1024) {
  try {
    const file = logFile || diagLogMod.logFile();
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } catch { return ''; }
  } catch { return ''; }
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

/**
 * Identify PROFILE BUNDLES (dsh.profile.bundles) that the backend log names as
 * failing — the codebuddy-first-bridge@1.1.7 class: a bundle whose client
 * module registers the wrong loader id fails the combo import, yet it is NOT a
 * home-patch entry, so disableBrokenPatchPlugins() has nothing to grab and the
 * ladder used to fall through to whole-tree safe mode (secondary damage: every
 * innocent plugin disappeared). Returns [{ name, reason }].
 */
function analyzeFailingBundles(home, logText) {
  const out = [];
  if (!logText) return out;
  const parsed = failingSpecifiersFromLogs(logText);
  if (!parsed.specifiers.size) return out;
  // Act only on real load/import failure signals — a package name that merely
  // appears in an informational line must never disable a bundle.
  if (!parsed.pluginTree && !parsed.cannotFind) return out;
  let reg = null;
  try { reg = readProfileRegistry(home, 'web'); } catch { return out; }
  for (const name of (reg.bundles || [])) {
    if (BASE_BUNDLES.has(name)) continue;
    if (parsed.specifiers.has(normalizeSpecifier(name))) {
      out.push({
        name,
        reason: parsed.pluginTree ? '插件树加载/导入失败，日志点名该插件包' : '插件包源文件缺失或不可加载'
      });
    }
  }
  if (out.length) log('failing profile bundles detected:', out.map((b) => b.name).join(', '));
  return out;
}

/**
 * Temporarily remove ONLY the given profile bundles from
 * dsh.profile.bundles — dependencies stay installed, so re-enabling is a
 * one-line edit against the timestamped backup. Mirrors
 * disableBrokenPatchPlugins' entry-level surgery for the bundle layer.
 * Returns { disabled: [names], backup: <path|null> }.
 */
function disableFailingBundles(home, names) {
  const want = new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean));
  if (!want.size) return { disabled: [], backup: null };
  const pkgPath = profilePkgPath(home, 'web');
  if (!fs.existsSync(pkgPath)) return { disabled: [], backup: null };
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { log('read profile pkg failed:', e.message); return { disabled: [], backup: null }; }
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
  const disabled = bundles.filter((b) => want.has(b));
  if (!disabled.length) return { disabled: [], backup: null };
  const ts = formatDateTimestamp();
  const backup = pkgPath + `.bundles-off-${ts}.bak`;
  try { fs.copyFileSync(pkgPath, backup); } catch (e) { log('backup profile pkg failed:', e.message); return { disabled: [], backup: null }; }
  pkg.dsh.profile.bundles = bundles.filter((b) => !want.has(b));
  try { fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n'); } catch (e) { log('write profile pkg failed:', e.message); return { disabled: [], backup: null }; }
  log(`disabled failing profile bundles: ${disabled.join(', ')} (backup: ${backup})`);
  return { disabled, backup };
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
          out.push({ file: patchPath, id: entry.id, name: entry.name, kind: 'loader-id-conflict', reason: `条目 id「${entry.id}」已由 DSH 内置提供，重复声明会让启动直接失败` });
        } else if (prev > 1) {
          out.push({ file: patchPath, id: entry.id, name: entry.name, kind: 'loader-id-conflict', reason: `条目 id「${entry.id}」在同一文件里声明了两次` });
        } else if (entry.name) {
          const bare = entry.name.split('?')[0].replace(/^['"]|['"]$/g, '');
          if (bare && ownBundles.has(bare)) {
            out.push({ file: patchPath, id: entry.id, name: entry.name, kind: 'loader-id-conflict', reason: `插件「${bare}」已通过官方通道安装（profile bundle），补丁里再注册一次会冲突` });
          }
        }
      }
    }
  }
  if (out.length) log('pre-flight loader id conflicts:', out.map((c) => `${c.id}(${c.reason})`).join(' | '));
  return out;
}

/**
 * Apply entry-level disables for pre-flight conflicts, grouped per file **and
 * per kind** — 禁用标记里要写清是哪种原因，恢复通道据此只撤销自己造成的
 * 那一类误伤（loader id 冲突导致的禁用不该被自动撤销）。
 * Returns { fixed: [{ file, ids, backup, kind }] }.
 */
function applyLoaderConflictFixes(conflicts, meta = {}) {
  const groups = new Map();
  for (const c of conflicts || []) {
    if (!c || !c.file || !c.id) continue;
    const kind = c.kind || meta.kind || 'loader-conflict';
    const key = `${c.file}${kind}`;
    if (!groups.has(key)) groups.set(key, { file: c.file, kind, ids: new Set() });
    groups.get(key).ids.add(c.id);
  }
  const fixed = [];
  for (const g of groups.values()) {
    const res = disablePatchEntriesInFile(g.file, [...g.ids], { kind: g.kind, reason: meta.reason || '' });
    if (res.disabled.length) fixed.push({ file: g.file, ids: res.disabled, backup: res.backup, kind: g.kind });
  }
  return { fixed };
}

/**
 * Node-style upward resolution check: does <name> exist as a directory in any
 * node_modules on the walk-up chain from `dir`? This is the necessary
 * condition for `import '<name>'` to resolve — if no such directory exists
 * anywhere, the import is guaranteed to fail with ERR_MODULE_NOT_FOUND.
 *
 * 0.3.46：实现搬到 plugin-resolution.js（预检与归因共用同一份），这里保留
 * 薄封装以兼容既有调用点。
 *
 * 注意旧注释里那句「no false positives」是错的：解析根取错就会把「装在官方
 * 后端树里」的包判成不存在（2026-10-20 事故）。根的构成见 plugin-resolution.js。
 */
function resolvesFromDir(dir, name) {
  return pluginResolution.resolvesFromDir(dir, name);
}

/**
 * Find a REAL directory (not a link) under modulesDir whose package.json
 * declares the given package name — i.e. a hand-copied install whose
 * directory name does not match its package name.
 *
 * 0.3.46：支持 scope（@scope/name）—— 旧实现直接跳过 '@' 开头的目录，
 * 于是 @deepseek-ai/* 这类包永远无法被自动修复。
 */
function findRealDirByPackageName(modulesDir, pkgName) {
  const segs = String(pkgName || '').split('/').filter(Boolean);
  if (!segs.length) return null;
  // scope 形式：<modulesDir>/@scope/<pkg>
  if (segs.length === 2) {
    const scopeDir = path.join(modulesDir, segs[0]);
    const full = path.join(scopeDir, segs[1]);
    try {
      const st = fs.lstatSync(full);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        const pj = readJson(path.join(full, 'package.json'), null);
        if (pj && pj.name === pkgName) return full;
      }
    } catch {}
    return null;
  }
  if (segs.length !== 1) return null;
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
 * 运行时解析根清单（本机 dsh-home 视角）。
 *
 * 根的构成见 plugin-resolution.js 的说明：权威根是**官方后端安装树**
 * （<backend>/dsh/node_modules），因为 Cordis loader 对裸包名执行的是
 * loader 包文件所在目录为基准的普通 ESM 动态 import。profile 目录与家级
 * DSH_HOME 也保留在清单里（loader.internal 可得时解析按补丁文件目录进行）。
 */
function runtimeResolutionRoots(home) {
  const profilesDir = path.join(home, 'profiles');
  const profileDirs = [];
  try {
    for (const d of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'node_modules') continue;
      const dir = path.join(profilesDir, d.name);
      if (fs.existsSync(path.join(dir, 'package.json'))) profileDirs.push(dir);
    }
  } catch {}
  return pluginResolution.resolutionRoots({
    dshPkgPath: P().dshPkg,
    backendDshDir: P().dshDir,
    dshHome: home,
    profileDirs,
  });
}

/**
 * Pre-flight: verify every active patch entry that references a package by
 * BARE NAME actually resolves through the **runtime** resolution roots.
 *
 * 0.3.46 · 本次事故的直接修复点
 * ──────────────────────────────────────────────────────────────
 * 旧实现只从 <dsh-home>/profiles/* 向上找 node_modules，而 Cordis loader
 * 对裸包名实际是以 **loader 包所在目录**（<backend>/dsh/node_modules）为
 * 基准做普通 ESM 动态 import —— 于是官方后端树里明明装着的
 * @deepseek-ai/dsh-mcp-client 被判成「冷启动必然失败」并自动禁用：
 *   2026-10-15 01:00 误伤 4 条、2026-10-20 19:59 误伤 1 条（并弹窗）。
 *
 * 现在的行为：
 *   1. 用 plugin-resolution.js 组装解析根清单（每条根带来源说明）；
 *   2. 用**内置 dsh-base 补丁里的裸包名**做自校验锚点 —— 锚点解析不到就
 *      判定「根集合不可信」，此时**拒绝任何破坏性的禁用**，只报告不删除；
 *   3. 只有根集合可信时，才把确实解析不到的条目判为 broken（禁用前留备份）。
 *
 * Auto-repair: when the package exists as a misnamed real directory under
 * home node_modules, create a correctly-named junction — the plugin keeps
 * working instead of being disabled.
 *
 * Returns {
 *   repaired: [{id, name, junction, target}],
 *   broken:   [{file, id, name, reason}],
 *   restored: [{file, id, name}],        // 本次一并恢复的误禁用条目
 *   skipped:  [{reason, detail}],        // 因根集合不可信而跳过的破坏性动作
 *   roots:    [{dir, why}],
 *   anchor:   {names, resolved, trusted},
 * }
 */
function preflightBareNameResolution() {
  const out = { repaired: [], broken: [], restored: [], skipped: [], roots: [], anchor: null };
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

  // 解析根清单（installation scope = 官方后端安装树）
  const roots = pluginResolution.resolutionRoots({
    dshPkgPath: P().dshPkg,
    backendDshDir: P().dshDir,
    dshHome: home,
    profileDirs,
  });
  out.roots = roots.map((r) => ({ why: r.why, dir: r.dir, paths: r.paths }));

  // 自校验锚点：内置 dsh-base 补丁里的裸包名（已知可用）
  const anchorNames = pluginResolution.controlBareNames(P().dshDir);
  const verdict = pluginResolution.verifyRoots({ roots, anchorNames });
  out.anchor = { names: anchorNames, resolved: verdict.anchorResolved, trusted: verdict.trusted, reason: verdict.reason };
  log('pre-flight 解析根:', pluginResolution.describeRoots(roots), '| 自校验:', verdict.reason);
  if (!verdict.trusted) {
    // 根集合不可信 ⇒ 「包不存在」的结论不可信 ⇒ 禁止任何禁用动作。
    log('pre-flight 解析根自校验未通过 —— 本次不做任何条目禁用（只报告）:', verdict.reason);
    out.skipped.push({ reason: 'resolution-roots-unverified', detail: verdict.reason });
    return out;
  }

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
        if (!isBarePackageName(n)) continue;
        entries.push({ file: patchPath, id: e.id, name: n });
      }
    }
  }

  for (const e of entries) {
    const bare = barePackageName(e.name);
    if (pluginResolution.resolveBareName(roots, bare).resolved) continue;
    // Unresolvable — try to auto-repair from a misnamed real-dir install.
    const junctionPath = path.join(home, 'node_modules', ...bare.split('/'));
    if (!fs.existsSync(junctionPath)) {
      const realDir = findRealDirByPackageName(path.join(home, 'node_modules'), bare);
      if (realDir) {
        try {
          fs.mkdirSync(path.dirname(junctionPath), { recursive: true });
          fs.symlinkSync(realDir, junctionPath, 'junction');
          out.repaired.push({ id: e.id, name: e.name, junction: junctionPath, target: realDir });
          log(`pre-flight auto-repair: junction ${bare} -> ${realDir} (directory name did not match package name)`);
          continue;
        } catch (err) {
          log(`pre-flight auto-repair failed for ${bare}: ${err.message}`);
        }
      }
    }
    out.broken.push({
      file: e.file,
      id: e.id,
      name: e.name,
      kind: 'bare-name-unresolvable',
      reason: `包「${bare}」在运行时解析根里不存在（已查：${pluginResolution.describeRoots(roots)}），冷启动必然失败`,
    });
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

// --------------------------------------------------------------------------
// UPDATE JOURNAL（0.3.38 / P2-1）：把每次更新的「暂存 → 应用 → 验证」三态
// 持久化到 root/update-journal.json。更新在「后端未运行」时应用，顺序本身是
// 对的；journal 补上的是崩溃/断电后的可恢复与精确归因 —— 一条 applied 却从未
// verified 的记录，下次启动一眼可见。
// --------------------------------------------------------------------------
const updateJournalPath = () => path.join(P().root, 'update-journal.json');
const JOURNAL_MAX = 30;

function readUpdateJournal() {
  try {
    const doc = JSON.parse(fs.readFileSync(updateJournalPath(), 'utf8'));
    return { entries: Array.isArray(doc.entries) ? doc.entries : [] };
  } catch { return { entries: [] }; }
}
function writeUpdateJournal(entries) {
  const keep = entries.slice(-JOURNAL_MAX);
  try { writeJson(updateJournalPath(), { schemaVersion: 1, entries: keep }); }
  catch (e) { log('write update-journal failed:', e.message); }
}
/**
 * 更新失败的白名单错误码（0.3.39 · 对齐官方 DesktopUpdateJournal 的
 * ERROR_CODES）：journal 是要长期留存的证据文件，错误**全文**可能含镜像 URL、
 * 代理地址等环境细节，落盘只保留固定分类码 + 截断摘要。
 */
const JOURNAL_ERROR_CODES = [
  'ETIMEDOUT', 'ENOSPC', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_UPDATER_INVALID_SIGNATURE',
  'ERR_UPDATER_CHECKSUM_MISMATCH', 'ETARGET', 'EADDRINUSE', 'ENOENT', 'EACCES', 'EPERM',
  // 0.3.48 · H-05：更新「应用」阶段被打断/未校验/连标记都写不进去 —— 三类都必须
  // 在 journal 里可精确归因（旧实现这一阶段一条记录都没有）。
  'ERR_UPDATER_APPLY_INTERRUPTED', 'ERR_UPDATER_APPLY_INCOMPLETE',
  'ERR_UPDATER_APPLY_UNVERIFIED', 'ERR_UPDATER_APPLY_MARKER_FAILED',
  // 0.3.49 · B-06 / B-08 / B-17：确认过期、后端未干净退出、元数据缺哈希。
  // 与官方 update-journal.ts:12-13 同类：这几类必须是一等公民错误，不能笼统一句
  // "更新失败"。
  'ERR_UPDATER_CONFIRMATION_STALE', 'ERR_UPDATER_BACKEND_NOT_STOPPED',
  'ERR_UPDATER_INTEGRITY_METADATA_MISSING'
];

/**
 * 追加一条更新记录。
 * @param {string} kind   'dsh' | 'node'
 * @param {string} state  'staged' | 'applied' | 'verified' | 'failed'
 * @param {object} extra  { from, to, reason }
 */
function journalAdd(kind, state, extra = {}) {
  const { entries } = readUpdateJournal();
  let reason = null;
  if (extra.reason) {
    const text = String(extra.reason);
    // 0.3.48 · H-05：**显式错误码优先**。调用方把分类码放在最前面时以它为准，否则会被
    // 原文里先出现的 EPERM/EACCES 抢先匹配掉（例如"标记写不进去"的真实原因是被原始
    // 系统错误串误导成权限问题），归因就错了。没有显式码时仍按白名单扫描。
    const lead = text.trim().split(/\s+/)[0];
    const code = JOURNAL_ERROR_CODES.includes(lead)
      ? lead
      : (JOURNAL_ERROR_CODES.find((c) => text.includes(c)) || 'UNCLASSIFIED');
    // 0.3.42 · 只落分类码，不再追加 120 字符原文（对齐官方 update-journal.ts:17,27
    // 的"错误全文绝不落盘"纪律）。journal 是长期留存、可能被用户分享给他人排查的
    // 证据文件；原始错误串里常带镜像 URL、代理主机名、内网路径 —— 而这些恰恰是
    // 本文件设计要避免暴露的。分类码已足够回答"卡在哪一类失败"。
    reason = code;
  }
  entries.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind, state,
    at: new Date().toISOString(),
    from: extra.from || null,
    to: extra.to || null,
    reason
  });
  writeUpdateJournal(entries);
}
/**
 * 把给定 kind 的、状态为 applied 的记录推进到 verified（后端已成功启动并加载
 * 窗口后调用）。返回推进条数。
 */
function journalMarkVerified(kind) {
  const { entries } = readUpdateJournal();
  let n = 0;
  for (const e of entries) {
    if ((!kind || e.kind === kind) && e.state === 'applied') { e.state = 'verified'; n++; }
  }
  if (n) writeUpdateJournal(entries);
  return n;
}
/**
 * 恢复检查：返回 applied 但从未 verified 的记录 —— 上次更新在验证前就崩了。
 * 调用方据此决定是否提示/回滚（当前版本只报告，不自动回滚）。
 */
function journalUnverified() {
  return readUpdateJournal().entries.filter((e) => e.state === 'applied');
}

// --------------------------------------------------------------------------
// 0.3.48 · H-05：「更新应用中」标记（root/apply-in-progress.json）
//
// 为什么需要它：`applyStaged()` 交换 dsh/dsh.new 时会经过两个**不可逆窗口** ——
//  ① 窗口 A：`dsh` 已改名成 `dsh.old`、`dsh.new` 还没顶上来 → 此刻 `dsh` 不存在；
//  ② 窗口 B：`dsh.new` 已消费、旧树还没落到 `dsh.previous`。
// 进程若在这两个窗口内死亡（断电、强杀、BSOD），下次启动 `ensureSeeded()` 依据
// `needDsh = !existsSync(dshBin)` 直接从 payload 解压**出厂版本**，用户刚更新的后端被
// 静默降级，日志里只留一行 seeding（H-05 的原貌）。
//
// 因此：交换**之前**先落标记（含目标版本 / 开始时间 / 步骤名），交换并校验成功后才清除；
// 启动早期读到残留标记时**不静默、也不自动恢复** —— 写诊断日志 + 落一条 journal 记录，
// 把可判定的故障态与建议恢复动作（用 dsh.old / dsh.previous 换回）返回给主进程启动链。
// 标记与 update-journal.json 同域同目录，journal 仍是唯一台账，本文件只是一次操作的
// 生命周期信封（写入即覆盖，天然不增长）。
// --------------------------------------------------------------------------
const APPLY_IN_PROGRESS_FILE = 'apply-in-progress.json';
const APPLY_INTERRUPTED_CODE = 'ERR_UPDATER_APPLY_INTERRUPTED';
const applyInProgressPath = () => path.join(P().root, APPLY_IN_PROGRESS_FILE);

function readApplyInProgress() {
  const doc = readJson(applyInProgressPath(), null);
  return doc && typeof doc === 'object' ? doc : null;
}

/**
 * 开始一次「更新应用」并落标记。
 * 写失败直接抛错：调用方必须据此**取消交换**（没有标记的交换被打断就是 H-05 本身）。
 */
function beginApplyInProgress(fields = {}) {
  const doc = {
    schemaVersion: 1,
    operationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    step: 'unknown',
    ...fields
  };
  writeJson(applyInProgressPath(), doc);
  return doc;
}

/** 推进同一次操作的步骤名；operationId 不匹配（已是另一次操作）时不写，返回 null。 */
function updateApplyInProgress(operationId, fields = {}) {
  const doc = readApplyInProgress();
  if (!doc || doc.operationId !== operationId) return null;
  const next = { ...doc, ...fields, updatedAt: new Date().toISOString() };
  writeJson(applyInProgressPath(), next);
  return next;
}

/**
 * 清除标记。传 operationId 时只清属于自己的那次操作（绝不抹掉别人的可归因证据）；
 * 不传则无条件清除，供主进程在「已向用户交代过」之后确认处理完毕。
 * 清不掉（非 ENOENT）直接抛错 —— 留着会让下次启动误报中断，必须让上层看见。
 */
function clearApplyInProgress(operationId = null) {
  const doc = readApplyInProgress();
  if (doc && operationId && doc.operationId !== operationId) {
    log(`apply-in-progress 标记属于另一次操作（${doc.operationId}），本次不清理`);
    return false;
  }
  try { fs.unlinkSync(applyInProgressPath()); return true; }
  catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
}

/** 探测某个后端目录里实际躺着哪个版本（bin.js 缺失即视为不可用）。 */
function probeDshTree(dir) {
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
  if (!fs.existsSync(path.join(pkgDir, 'lib', 'bin.js'))) return null;
  const pkg = readJson(path.join(pkgDir, 'package.json'), null);
  return { dir, version: pkg && pkg.version ? pkg.version : null };
}

/**
 * 启动早期检测残留的「应用中」标记（H-05 的读取端）。
 *
 * 立场：不静默（诊断日志 + 一条 journal 记录）、不自动恢复（回滚是不可逆操作，决策权
 * 属于启动链/自愈阶梯 —— main.js 的 showFatal 与 H-01 范围），只返回可判定的状态。
 *
 * @returns {{active: boolean, marker?: object, step?: string, target?: string|null,
 *            startedAt?: string|null, live?: object|null, old?: object|null,
 *            previous?: object|null, staged?: object|null, recovery?: string}}
 */
function detectInterruptedApply() {
  const p = P();
  const markerFile = applyInProgressPath();
  const marker = readApplyInProgress();
  // 文件在但解析不出来（外部改坏 / 写盘中断）同样是「上次更新被打断」的证据，
  // 绝不能当没看见（PROJECT_RULES §4 禁止静默容错）。
  if (!marker && !fs.existsSync(markerFile)) return { active: false };

  const live = probeDshTree(p.dshDir);
  const oldTree = probeDshTree(path.join(p.root, 'dsh.old'));
  const previous = probeDshTree(p.dshPrevious);
  const staged = probeDshTree(p.dshNew);

  // 恢复动作按「磁盘上还剩什么」机械推导，不猜：
  //   dsh 还在 + dsh.new 还在 → 交换大概率没发生（可安全重试）
  //   dsh 还在 + dsh.new 不在 → 交换大概率已完成，只需人工核对版本
  //   dsh 缺失 → 用 dsh.old（本次交换的旧版）兜底，其次 dsh.previous
  let recovery = 'reinstall-required';
  if (live) recovery = staged ? 'swap-maybe-not-applied' : 'apply-maybe-completed';
  else if (oldTree) recovery = 'restore-from-dsh.old';
  else if (previous) recovery = 'restore-from-dsh.previous';

  const state = {
    active: true, marker,
    unreadable: !marker,
    step: marker ? (marker.step || 'unknown') : 'unreadable-marker',
    target: marker ? (marker.to || null) : null,
    startedAt: marker ? (marker.startedAt || null) : null,
    live, old: oldTree, previous, staged,
    recovery
  };
  log('检测到残留的更新中断标记（上次应用更新在交换阶段被打断）：'
    + `步骤=${state.step} 目标=${state.target || '?'} 开始=${state.startedAt || '?'}；`
    + `dsh=${live ? live.version : '缺失'} dsh.old=${oldTree ? oldTree.version : '无'} `
    + `dsh.previous=${previous ? previous.version : '无'} dsh.new=${staged ? staged.version : '无'}；`
    + `建议恢复动作=${recovery}（不会自动执行，交给启动链决定）`
    + (state.unreadable ? '；注意：标记文件内容无法解析，按中断处理' : ''));

  // journal 只记一条同一标记（避免每次启动刷屏）；它是唯一台账，标记文件只是信封。
  const reported = readUpdateJournal().entries.some((x) =>
    x.reason === APPLY_INTERRUPTED_CODE && x.to === state.target
    && String(x.at || '') >= String(state.startedAt || ''));
  if (!reported) journalAdd('dsh', 'failed', { to: state.target, reason: `${APPLY_INTERRUPTED_CODE} step=${state.step}` });
  return state;
}

/** 最近一次检测结果（供主进程启动链读取；未检测过则现场检测一次）。 */
let interruptedApplyCache = null;
function interruptedApplyState() {
  if (!interruptedApplyCache) interruptedApplyCache = detectInterruptedApply();
  return interruptedApplyCache;
}

function stagedVersions() {
  const p = P();
  let dsh = null;
  let node = null;
  // 0.3.49：被作废的暂存树不算"待装版本"——否则 UI 会永远显示"更新已就绪"，
  // 用户点了重启也不会生效（因为 applyStaged 会主动跳过它）。
  try {
    if (dshStagingInvalidated()) return { dsh: null, node: null, dshInvalidated: true };
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
// 0.3.49 · B-06：更新确认与版本绑定（revision + 内容摘要）
//
// 问题：确认弹窗里写的是「有新版本 vX」，用户点确认之后到真正下载之间，目标可能已经
// 变了 —— 上游把同一个版本重发了一份新的 tarball（内容不同）、或者用户在设置窗切了
// 更新路线/换了后端版本。旧实现没有任何代号，弹窗的确认会按**它自己记住的版本号**
// 继续执行，于是可能"确认的是 A，装上去的是 B 的内容"。
//
// 做法（对齐官方 update-coordinator.ts:96-97,172-183 的 revision 语义）：
//  1. `revision` 是一个单调递增的代次，**只有** `bumpUpdateRevision()` 能改它，而
//     "可能换掉目标"的三类动作（切更新路线 / 换后端版本 / 换 Node 版本）都必须调它 ——
//     漏一处就退化成空转，所以收敛在唯一一个函数里。
//  2. 确认令牌 = `{ revision, version, digest }`。digest 是候选内容的摘要
//     （版本号 + tarball URL + integrity + shasum 的规范化 JSON 的 sha256）：
//     **绑定内容而不是绑定"最新"** —— 同版本重发会改 digest，从而作废旧确认。
//  3. 校验时机在 `stageDsh()` 的最前面（网络请求之前）：不新鲜就直接拒绝并给出可操作
//     文案，绝不下到一半才发现。
//
// 边界：main.js 若没有把令牌带回来（未接线），这里会**显式记一条日志**说明"本次确认
// 未绑定"，而不是假装校验过 —— 宁可留下证据，也不要虚假的安全感。
// --------------------------------------------------------------------------
let updateRevisionCounter = 0;
/** 最近一次"用户可能看到了"的候选：{ version, digest, revision, at, source }。 */
let updateCandidateSnapshot = null;

function updateRevision() { return updateRevisionCounter; }

/**
 * 递增代次并作废当前候选快照。
 * 触发条件：切更新路线 / 换后端版本 / 换 Node 版本 / 需要作废旧确认的任何动作。
 * 可逆性：不可逆（代次只增），但代价只是让用户重新确认一次。
 * @param {string} reason 记进日志的原因（排障时要能回答"谁让它过期的"）
 */
function bumpUpdateRevision(reason) {
  updateRevisionCounter += 1;
  updateCandidateSnapshot = null;
  logDurable(`更新代次 revision → ${updateRevisionCounter}（原因：${reason}）；此前的确认一律作废`);
  return updateRevisionCounter;
}

/** 候选内容摘要：版本 + tarball + 哈希的规范化 JSON。同版本重发会改变它。 */
function candidateDigest(version, dist) {
  const canonical = JSON.stringify({
    version: version || null,
    tarball: (dist && dist.tarball) || null,
    integrity: (dist && dist.integrity) || null,
    shasum: (dist && dist.shasum) || null
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** 记录"用户此刻大概率看到的候选"，供确认令牌绑定（dist 缺失时也要能算出稳定摘要）。 */
async function recordUpdateCandidate(info, distHint = null) {
  const version = (info && info.version) || null;
  if (!version) return null;
  let dist = distHint || lastDshDist[version] || null;
  if (!dist) {
    try { dist = await dshDistMeta(version); }
    catch (e) { log('候选的 dist 元数据拉取失败（摘要将不含 tarball 信息）:', e.message); }
  }
  updateCandidateSnapshot = {
    version,
    digest: candidateDigest(version, dist),
    revision: updateRevisionCounter,
    at: new Date().toISOString(),
    source: (info && info.source) || 'unknown'
  };
  log('记录更新候选（供确认绑定）', updateCandidateSnapshot);
  return { ...updateCandidateSnapshot };
}

/** 给弹窗/调用方盖确认令牌：只绑定"此刻这个目标"，不绑定"最新"。 */
function issueUpdateConfirmation() {
  if (!updateCandidateSnapshot) return null;
  const { revision, version, digest, at } = updateCandidateSnapshot;
  return { revision, version, digest, at };
}

/**
 * 校验确认令牌是否仍然新鲜（纯函数式判定，不产生任何网络/磁盘副作用）。
 *
 * @param {string} version 本次要装的目标版本
 * @param {object|null} confirmation 调用方带回来的令牌
 * @returns {{ok: boolean, stale: boolean, unbound: boolean, reason: string|null}}
 *   - `unbound=true`：没带令牌（调用方未接线），调用方自行决定是否继续
 *   - `stale=true`：目标已被换掉，必须拒绝
 */
function assertConfirmationFresh(version, confirmation) {
  if (!confirmation || typeof confirmation !== 'object') {
    return { ok: true, stale: false, unbound: true, reason: '调用方未携带确认令牌（B-06 未接线）' };
  }
  if (confirmation.version && String(confirmation.version) !== String(version)) {
    return {
      ok: false, stale: true, unbound: false,
      reason: `确认的目标是 ${confirmation.version}，本次要装的是 ${version} —— 目标已变更，请重新确认。`
    };
  }
  if (Number(confirmation.revision) !== updateRevisionCounter) {
    return {
      ok: false, stale: true, unbound: false,
      reason: `确认后更新路线/版本已变更（确认代次 ${confirmation.revision}，当前 ${updateRevisionCounter}）—— 目标可能已换，请重新确认。`
    };
  }
  const snap = updateCandidateSnapshot;
  if (!snap) {
    return {
      ok: false, stale: true, unbound: false,
      reason: '找不到与该确认匹配的候选快照（可能重启过或未重新检查更新）—— 请重新检查更新后再确认。'
    };
  }
  if (snap.version !== String(version) || snap.digest !== confirmation.digest) {
    return {
      ok: false, stale: true, unbound: false,
      reason: `候选内容已变化（版本 ${snap.version}，内容摘要 ${String(snap.digest).slice(0, 12)}… ≠ 确认时的 ${String(confirmation.digest).slice(0, 12)}…）—— 上游可能重发了该版本，请重新确认。`
    };
  }
  return { ok: true, stale: false, unbound: false, reason: null };
}

/**
 * 第二段校验：内容摘要（必须等拿到 registry 的 dist 元数据之后才能做）。
 *
 * 这一段专门对付「上游把**同一个版本号**重发了一份内容不同的包」：revision 没变、
 * 版本号也没变，只有 tarball / integrity / shasum 变了 —— 这正是"确认了 A 却装了 B"
 * 的真身。绑定"最新版本号"的写法在这里会完全失效。
 *
 * @param {object|null} confirmation 令牌
 * @param {object|null} dist 本次实际要用的 dist 元数据
 * @param {string} version 目标版本
 */
function checkConfirmationDigest(confirmation, dist, version) {
  if (!confirmation || typeof confirmation !== 'object' || !confirmation.digest) {
    return { ok: true, unchecked: true, reason: '确认令牌未携带内容摘要（B-06 未接线）' };
  }
  const actual = candidateDigest(version, dist);
  if (actual !== confirmation.digest) {
    return {
      ok: false, unchecked: false,
      reason: `上游重发了该版本（实际内容摘要 ${actual.slice(0, 12)}… ≠ 确认时的 ${String(confirmation.digest).slice(0, 12)}…）—— 请重新检查更新并确认。`
    };
  }
  return { ok: true, unchecked: false, reason: null };
}

// --------------------------------------------------------------------------
// STAGED updates — install/download to staging only; never touch running files.
// --------------------------------------------------------------------------
/**
 * 取目标版本的 dist 元数据（完整性 + 直链）。
 * 拉不到**不算错误**（私有镜像/离线测试可能没有 dist），但必须显式告知；
 * 返回 null 时调用方退回"按版本号安装"（由 npm 自己校验）。
 */
async function resolveDshInstallDist(version, say) {
  try {
    const dist = await dshDistMeta(version);
    if (!dist) logDurable(`dsh ${version} 的 registry 元数据没有 dist 字段（本次无法预校验安装包完整性）`);
    return dist || null;
  } catch (e) {
    logDurable(`拉取 dsh ${version} 的 dist 元数据失败：${e.message}`);
    say(`未能取得 ${version} 的完整性元数据（${e.message}），本次无法预校验安装包。`);
    return null;
  }
}

/**
 * 「校验结论 → 动作」的纯策略函数（抽出来是为了让它自己可单测，下载路径要起网络）。
 *
 * 纪律：**没有哈希 ≠ 校验通过**。缺元数据时默认记账后继续（官方 B-17 验收标准第 4 条：
 * 无哈希可用时不能把用户卡死），但只要 `DSH_REQUIRE_INTEGRITY=1` 就一律拒绝 —— 那是给
 * 「我在意供应链、宁可装不上」的用户/企业环境用的硬开关。
 *
 * @param {{ok?:boolean, missingMetadata?:boolean, reason?:string|null}} verification
 * @param {{requireHash?: boolean}} [opts]
 * @returns {{action:'accept'|'accept-unverified'|'reject', code:string|null, reason:string|null}}
 */
function integrityPolicy(verification, opts = {}) {
  const requireHash = typeof opts.requireHash === 'boolean'
    ? opts.requireHash
    : String(process.env.DSH_REQUIRE_INTEGRITY || '') === '1';
  if (verification && verification.ok) return { action: 'accept', code: null, reason: null };
  if (verification && verification.missingMetadata) {
    return requireHash
      ? { action: 'reject', code: 'ERR_UPDATER_INTEGRITY_METADATA_MISSING', reason: verification.reason }
      : { action: 'accept-unverified', code: 'ERR_UPDATER_INTEGRITY_METADATA_MISSING', reason: verification.reason };
  }
  return { action: 'reject', code: 'ERR_UPDATER_CHECKSUM_MISMATCH', reason: verification ? verification.reason : '校验结果缺失' };
}

/**
 * 下载安装包并按 registry 哈希校验（B-17）。
 *
 * 三条出口，一条都不许"假装通过"：
 *  - 有哈希且匹配 → 返回文件（附校验口径，供日志与 UI 汇报"用了 sha512 还是 sha1"）；
 *  - 有哈希但不匹配（含截断）→ 删包、记 ERR_UPDATER_CHECKSUM_MISMATCH、**抛错中止**；
 *  - 没有哈希 → 明确告知（日志 + 用户文案），动作由 integrityPolicy 决定。
 */
async function downloadVerifiedDshTarball(p, version, dist, say) {
  const tgz = path.join(p.downloadDir, `dsh-${version}.tgz`);
  rimraf(tgz);
  say(`正在下载 DSH 后端包 ${version} …`);
  const expectedBytes = Number(dist.size || 0) || null;
  await downloadFile(dist.tarball, tgz, () => {});
  const verification = verifyFileIntegrity(tgz, dist, { expectedBytes });
  const policy = integrityPolicy(verification);

  if (policy.action === 'accept') {
    logDurable(`dsh ${version} 安装包完整性校验通过（${verification.algo} / 来源 ${verification.from} / ${verification.size} 字节）`);
    return { file: tgz, verification, policy };
  }
  if (policy.action === 'accept-unverified') {
    logDurable(`dsh ${version} 缺少可用哈希，无法校验安装包完整性（按策略继续）：${verification.reason}`);
    journalAdd('dsh', 'failed', { to: version, reason: `${policy.code} ${verification.reason}` });
    say(`注意：该版本未提供完整性哈希，本次无法校验下载内容（${verification.reason}）。`);
    return { file: tgz, verification, policy };
  }
  rimraf(tgz);
  journalAdd('dsh', 'failed', { to: version, reason: `${policy.code} ${policy.reason}` });
  logDurable(`dsh ${version} 安装包校验被拒绝（${policy.code}）：${policy.reason}`);
  const hint = policy.code === 'ERR_UPDATER_INTEGRITY_METADATA_MISSING'
    ? '该版本没有提供完整性哈希。可尝试：在托盘「设置」里切换到另一个更新路线后重试（或临时关闭 DSH_REQUIRE_INTEGRITY）。'
    : '可尝试：在托盘「设置」里切换到另一个更新路线后重试，或稍后再试。';
  throw new Error(`DSH ${version} 安装包校验失败（${verification.algo || '大小校验'}）：${policy.reason}\n`
    + `本次更新已中止，当前后端版本未被替换。${hint}`);
}

/**
 * 把（已校验的）后端包装进 dsh.new。
 * @param {string|null} tgz 已校验的本地安装包；null = 退回按版本号在线安装
 * @returns {string} 实际装出来的版本号
 */
async function installStagedDsh(p, version, tgz, say) {
  rimraf(p.dshNew); mkdirp(p.dshNew);
  // 不在 package.json 里预先声明依赖：npm 会把它和本地 tarball 混在一起解析，
  // 可能绕过我们刚校验过的那份文件去 registry 重下一份。装完再写回版本形态。
  writeJson(path.join(p.dshNew, 'package.json'), { name: 'dsh-active-backend', version: '0.0.0', private: true });
  const args = [
    p.npmCli, 'install', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error',
    `--registry=${npmRegistryUrl()}`, '--no-bin-links',
    tgz || `@deepseek-ai/dsh@${version}`
  ];
  say(`正在安装 DSH 后端 ${version}（依赖较多，请稍候）…`);
  await run(p.nodeExe, args, {
    cwd: p.dshNew,
    env: buildDedicatedEnv(),
    onOutput: (s) => { const l = s.trim(); if (l && l.includes('packages')) say(l); }
  });
  const newBin = path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(newBin)) {
    rimraf(p.dshNew);
    throw new Error('后端暂存安装后未找到 dsh，已放弃（当前版本不受影响）。');
  }
  const installed = readJson(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), {}).version || null;
  if (!installed || compareSemver(installed, version) !== 0) {
    rimraf(p.dshNew);
    throw new Error(`暂存安装出的后端版本 ${installed || '未知'} 与目标 ${version} 不一致，已放弃（当前版本不受影响）。`);
  }
  // 装完把（可能带 file: 本地路径的）依赖声明改回版本形态，避免暂存树里留下指向
  // downloads/ 的相对路径 —— 那个路径下次启动后就不存在了。
  writeJson(path.join(p.dshNew, 'package.json'), {
    name: 'dsh-active-backend', version: '0.0.0', private: true, dependencies: { '@deepseek-ai/dsh': installed }
  });
  return installed;
}

/**
 * 暂存一个后端版本（不碰正在运行的文件）。
 *
 * 0.3.49 起多两道闸（顺序很重要，都在改磁盘上任何东西之前）：
 *  ① B-06 确认令牌新鲜度（代次 + 版本；拿到元数据后再校内容摘要）→ 目标被换掉就拒绝；
 *  ② B-17 安装包完整性（sha512 优先 / 退 sha1 / 缺失显式告知）→ 校验不过就**不建**
 *     dsh.new，原来暂存着的版本保持原样（"保留旧版"不是靠回滚，而是靠没动过）。
 *
 * @param {{onLog?:Function,onProgress?:Function}} callbacks
 * @param {string|null} requestedVersion 显式指定版本（版本列表/安装器选择）
 * @param {{confirmation?: object, dist?: object, installTargetOverride?: boolean}} [options]
 */
async function stageDsh(callbacks = {}, requestedVersion = null, options = {}) {
  const p = P();
  const say = (m) => callbacks.onLog && callbacks.onLog(m);

  // ① B-06 第一段：代次与目标版本 —— **必须在任何网络请求之前**完成。
  //   过期的确认不该先花几十秒下载元数据再告诉用户"目标变了"。
  //   没有显式版本时，用令牌自带的 version 当目标（它就是用户看到并确认的那个）。
  const declaredTarget = requestedVersion
    || (options.confirmation && options.confirmation.version ? String(options.confirmation.version) : null);
  if (options.confirmation && declaredTarget) {
    const pre = assertConfirmationFresh(declaredTarget, options.confirmation);
    if (!pre.ok) {
      journalAdd('dsh', 'failed', { to: declaredTarget, reason: `ERR_UPDATER_CONFIRMATION_STALE ${pre.reason}` });
      logDurable('拒绝执行过期的更新确认（网络请求之前）：' + pre.reason);
      throw new Error('目标已变更，请重新确认。\n\n' + pre.reason);
    }
  }

  const info = requestedVersion ? { version: requestedVersion, source: 'github', changes: [] } : await latestDshInfo();
  const latest = info.version;

  // 目标解析出来之后再校一次（覆盖"令牌里的版本"与"实际候选"不一致的情况）
  const conf = assertConfirmationFresh(latest, options.confirmation);
  if (!conf.ok) {
    journalAdd('dsh', 'failed', { to: latest, reason: `ERR_UPDATER_CONFIRMATION_STALE ${conf.reason}` });
    logDurable('拒绝执行过期的更新确认：' + conf.reason);
    throw new Error('目标已变更，请重新确认。\n\n' + conf.reason);
  }
  if (conf.unbound) log('本次 stageDsh 未携带确认令牌（B-06 未接线，目标绑定未生效）');

  // 显式指定版本：先校核 npm 是否已发布该版本，避免必然失败的下载。
  if (requestedVersion) {
    let published = null;
    try { published = await npmDshPublished(); } catch (e) { say(`npm 版本校核失败（${e.message}），仍将尝试下载…`); }
    if (published && !published.versions.includes(requestedVersion)) {
      throw new Error(`版本 ${requestedVersion} 尚未发布到 npm 镜像（npm 当前最新 ${published.latest}），无法下载安装。`);
    }
  }
  const staged = stagedVersions().dsh;
  if (!options.installTargetOverride && staged && compareSemver(staged, latest) >= 0) {
    log(`dsh version ${staged} is already staged (latest=${latest}); reusing`);
    say(`最新 DSH 后端 (${staged}) 已在暂存区，无需重复下载。`);
    return { version: staged, reused: true, changes: info.changes || [], source: info.source };
  }
  if (!fs.existsSync(p.nodeExe) || !fs.existsSync(p.npmCli)) throw new Error('缺少 node/npm，无法更新后端。');

  // ② B-17：先拿元数据（也要用它做 B-06 第二段的内容摘要校验），再下载校验，最后才装。
  const dist = options.dist || await resolveDshInstallDist(latest, say);
  const digestCheck = checkConfirmationDigest(options.confirmation, dist, latest);
  if (!digestCheck.ok) {
    journalAdd('dsh', 'failed', { to: latest, reason: `ERR_UPDATER_CONFIRMATION_STALE ${digestCheck.reason}` });
    logDurable('拒绝执行：' + digestCheck.reason);
    throw new Error('目标已变更，请重新确认。\n\n' + digestCheck.reason);
  }
  if (digestCheck.unchecked) log('确认令牌未含内容摘要（B-06 第二段校验跳过，已在日志留痕）');

  let tgz = null;
  let verification = null;
  if (dist && dist.tarball) {
    const got = await downloadVerifiedDshTarball(p, latest, dist, say);
    tgz = got.file;
    verification = got.verification;
  } else {
    logDurable(`dsh ${latest} 没有可用直链（dist.tarball），退回按版本号安装：本次无法预校验安装包完整性`);
    say(`该版本元数据未提供安装包直链，改为按版本号安装（下载内容由 npm 自身校验）。`);
  }

  let ver = null;
  try {
    ver = await installStagedDsh(p, latest, tgz, say);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    journalAdd('dsh', 'failed', { to: latest, reason: String(msg).slice(0, 300) });
    if (/ETARGET|No matching version found/i.test(msg)) {
      // 2026-09-08 晚上事故：dsh@0.1.5-alpha.1 在 npmmirror 上存在，但其依赖
      // dsh-fs-local@^0.1.5-alpha.1 尚未同步 → ETARGET → 整个安装回滚。给出可
      // 操作的提示，而不是一句冷冰冰的 npm 报错。
      throw new Error('下载失败：当前更新路线「' + registryInfo().label + '」尚未同步该版本的完整依赖（ETARGET）。\n' +
        '可在托盘「设置」中把更新路线切换到「官方站（npmjs）」后重试，或稍等镜像同步（通常几小时）后再试。\n\n' + msg);
    }
    throw e;
  } finally {
    if (tgz) rimraf(tgz);   // 下载目录不该长期堆安装包；校验结论已经落进日志与返回值
  }

  log('staged dsh', ver);
  journalAdd('dsh', 'staged', { from: currentVersions().dsh, to: ver });
  // 显式换版本 = 目标被换掉 → 作废其它挂着的确认，避免"确认的是 A、装的是 B"。
  if (requestedVersion) bumpUpdateRevision('backend-version-explicit');
  return {
    version: ver, reused: false, changes: info.changes || [], source: info.source,
    integrity: verification
      ? { verified: !!verification.ok, algo: verification.algo, from: verification.from, missingMetadata: !!verification.missingMetadata }
      : { verified: false, algo: null, from: null, missingMetadata: true, reason: '元数据无直链，未做预校验' }
  };
}

/**
 * 校验 Node 安装包（B-17 的第二个消费者）。
 *
 * 清单来源：`<nodeDist>/v<ver>/SHASUMS256.txt`（官方与 npmmirror 都有）。解析口径：
 * 每行 `<sha256>␠␠<文件名>`，只认 `node-v<ver>-win-x64.zip` 那一行 —— 不猜、不模糊匹配。
 *
 * 三种出口与 tarball 校验一致：匹配 → ok；不匹配 → bad（调用方必须中止）；清单拿不到/
 * 没有对应行 → missingMetadata（显式告知，不假装通过；默认继续，DSH_REQUIRE_INTEGRITY=1 时拒绝）。
 *
 * @returns {{ok:boolean, bad?:boolean, missingMetadata?:boolean, algo?:string, reason:string|null}}
 */
async function verifyNodeZip(zipPath, version, say) {
  const fileName = `node-v${version}-win-x64.zip`;
  const url = `${nodeDistBase()}/v${version}/SHASUMS256.txt`;
  let text = null;
  try {
    text = await fetchText(url);
  } catch (e) {
    logDurable(`无法取得 Node v${version} 的 SHASUMS256.txt（${e.message}）：本次无法校验安装包完整性`);
    say(`未能取得 Node v${version} 的校验清单（${e.message}），本次无法校验下载内容。`);
    return { ok: false, missingMetadata: true, reason: `校验清单不可用：${e.message}` };
  }
  const entry = String(text).split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, '') === fileName);
  if (!entry) {
    logDurable(`Node v${version} 的 SHASUMS256.txt 里没有 ${fileName} 这一行（无法校验）`);
    say(`校验清单里没有 ${fileName} 的条目，本次无法校验下载内容。`);
    return { ok: false, missingMetadata: true, reason: `校验清单缺少 ${fileName} 条目` };
  }
  const expected = entry[0].toLowerCase();
  const actual = digestFileSync(zipPath, 'sha256').hex;
  if (actual !== expected) {
    const reason = `sha256 不匹配：期望 ${expected}，实际 ${actual}`;
    logDurable(`Node v${version} 安装包校验失败：${reason}`);
    return { ok: false, bad: true, algo: 'sha256', reason };
  }
  logDurable(`Node v${version} 安装包校验通过（sha256）`);
  return { ok: true, algo: 'sha256', reason: null };
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
  // 0.3.49 · B-17：Node 官方/镜像都提供 SHASUMS256.txt，没有理由只查长度。
  const nodeCheck = await verifyNodeZip(zip, latest, say);
  if (nodeCheck.bad) {
    try { fs.unlinkSync(zip); } catch (e) { log('删除校验失败的 Node 包失败:', e.message); }
    journalAdd('node', 'failed', { to: latest, reason: `ERR_UPDATER_CHECKSUM_MISMATCH ${nodeCheck.reason}` });
    throw new Error(`Node v${latest} 安装包校验失败：${nodeCheck.reason}\n本次更新已中止，当前运行时未被替换。`
      + '\n可尝试：在托盘「设置」里切换 Node 下载源后重试。');
  }
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
  // 0.3.49 · B-06：显式换 Node 版本同样是"目标被换掉"，旧确认必须作废。
  if (requestedVersion) bumpUpdateRevision('node-version-explicit');
  return { version: latest, reused: false, integrity: nodeCheck.ok ? { verified: true, algo: nodeCheck.algo } : { verified: false, missingMetadata: true } };
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

/**
 * 把活跃后端换回 `dsh.previous`（不可逆：当前 dsh 会被删除）。
 *
 * 触发条件：用户手动回滚 / 连续启动失败达阈值的自动回滚（main.js `performRollback`）。
 * 可逆性：**不可逆** —— 当前 dsh 改名为 dsh.failed 后删除；补偿手段是重新暂存该版本。
 * 证据要求：dsh.previous 内必须有 bin.js；执行前后版本号、journal、versions.json 必须
 *   一致落盘（否则会出现"H-01 自动回滚把坏版本又装回来"这类二次事故）。
 *
 * 0.3.49 · B-08：三件事以前没做，现在必须做 ——
 *  ① **journal 对齐**：把坏版本那条 `applied` 改成 `rolled-back`。不这么做的话，回滚后
 *     只要有一次启动成功，`journalMarkVerified()` 就会把"坏版本"标成 verified，台账从此
 *     撒谎；更糟的是后续的自动回滚决策会以这条错误记录为依据（"回滚回坏版本"）。
 *  ② **versions.json 重写**：滚动后必须用新树的真实版本覆盖（原来就做，但只在成功路径）。
 *  ③ **清掉 H-05 的中断标记**：回滚本身就是对"上次应用被打断"的最终处置，标记必须结束，
 *     否则下次启动还会报一次中断。全部走 logDurable，断电也要留痕。
 *
 * @returns {boolean} true = 已回滚到上一个版本
 */
function rollbackDsh() {
  const p = P();
  const target = probeDshTree(p.dshPrevious);
  if (!target) {
    logDurable('回滚被拒绝：dsh.previous 里没有可用的后端（缺 lib/bin.js）');
    return false;
  }
  const fromVersion = dshVersion();
  const failed = path.join(p.root, 'dsh.failed');
  rimraf(failed);
  if (fs.existsSync(p.dshDir)) fs.renameSync(p.dshDir, failed);
  fs.renameSync(p.dshPrevious, p.dshDir);
  rimraf(failed);
  const cur = currentVersions();
  writeJson(p.versionsJson, { ...readJson(p.versionsJson, {}), ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v)) });
  const rolledBackEntries = journalMarkRolledBack(fromVersion, cur.dsh);
  try { clearApplyInProgress(); }
  catch (e) { logDurable('回滚后清理更新中断标记失败（下次启动会多报一次中断）:', e.message); }
  logDurable(`rolled back dsh: ${fromVersion || '未知'} → ${cur.dsh || '未知'}（journal 修正 ${rolledBackEntries} 条 applied 记录）`);
  return true;
}

/**
 * 把 journal 里"坏版本已 applied"的记录改成 rolled-back 并补一条回滚记录。
 *
 * 为什么不是简单删掉：台账是事后归因的唯一证据，删了就说不清"我们曾经装过一个坏版本、
 * 后来又退回去了"。改状态既保留了事实，又让 `journalUnverified()` / `journalMarkVerified()`
 * 不再把它当成"待验证的更新"（这正是"回滚回坏版本"的成因）。
 *
 * @returns {number} 被修正的记录条数
 */
function journalMarkRolledBack(badVersion, toVersion) {
  const { entries } = readUpdateJournal();
  let n = 0;
  for (const e of entries) {
    if (e.kind !== 'dsh' || e.state !== 'applied') continue;
    if (badVersion && e.to && String(e.to) !== String(badVersion)) continue;
    e.state = 'rolled-back';
    n++;
  }
  entries.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind: 'dsh', state: 'rolled-back', at: new Date().toISOString(),
    from: badVersion || null, to: toVersion || null, reason: null
  });
  writeUpdateJournal(entries);
  return n;
}

/**
 * 0.3.48 · H-05：交换完成后校验「新树真的可用」，只有校验通过才允许清除中断标记。
 * 口径：`lib/bin.js` 存在 + `package.json` 能读出与暂存版本一致的 version。
 * （交换成功但校验不过 = 现场不可信，标记必须留着让下次启动判定。）
 */
function verifyAppliedDsh(expectedVersion) {
  const p = P();
  if (!fs.existsSync(p.dshBin)) return { ok: false, version: null, reason: '交换后缺少 lib/bin.js' };
  const version = dshVersion();
  if (!version) return { ok: false, version: null, reason: '交换后无法从 package.json 读出后端版本' };
  if (expectedVersion && String(version).replace(/^v/, '') !== String(expectedVersion).replace(/^v/, '')) {
    return { ok: false, version, reason: `磁盘版本 ${version} ≠ 暂存版本 ${expectedVersion}` };
  }
  return { ok: true, version, reason: null };
}

/** 同步退避（等待被占用/被扫描的旧树释放句柄，无需事件循环）。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/**
 * 4 次 rename 重试交换 dsh 目录（后端刚被杀 / 杀软扫描会短暂占用旧树）。
 * 每次进入窗口 A（dsh → dsh.old）后立刻把标记步骤推进到 `dsh-hidden`，让断电后的
 * 现场可被精确判定（H-05 的证据要求）。
 * @returns {{swapped: boolean, lastErr: Error|null}}
 */
function swapDshDirectories(p) {
  let swapped = false;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4 && !swapped; attempt++) {
    try {
      const oldBackup = path.join(p.root, 'dsh.old');
      rimraf(oldBackup);
      if (fs.existsSync(p.dshDir)) fs.renameSync(p.dshDir, oldBackup);
      const marker = readApplyInProgress();
      if (marker && marker.operationId) {
        try { updateApplyInProgress(marker.operationId, { step: 'dsh-hidden' }); }
        catch (e) { log('更新中断标记步骤补写失败（标记仍在，判定仍可进行）：' + e.message); }
      }
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
  return { swapped, lastErr };
}

/**
 * 「dsh.new 不可再应用」标记（0.3.49）。
 *
 * 为什么需要：copy 兜底交换成功后，`dsh.new` 可能因为**同一个占用**删不净（实测：
 * 占用在 dsh.new 内部时，连重命名 dsh.new 本身都 EPERM）。若不管它，下次启动会把
 * 一棵缺文件的暂存树当成待装版本再交换一次 —— 那是把好树换坏的最短路径。
 *
 * 因此把"这棵暂存树作废了"记在 **dsh.new 之外**（root/dsh.new.invalid.json），
 * 由 applyStaged / stagedVersions 统一认；等哪次能把它删干净了再清标记。
 */
const dshStagingInvalidPath = () => path.join(P().root, 'dsh.new.invalid.json');

function dshStagingInvalidated() {
  return !!readJson(dshStagingInvalidPath(), null);
}

/** 作废当前暂存树（不可逆地"不再尝试应用"，但不动磁盘上的树，保留取证）。 */
function invalidateDshStaging(reason) {
  try {
    writeJson(dshStagingInvalidPath(), {
      schemaVersion: 1, at: new Date().toISOString(), reason: String(reason).slice(0, 300)
    });
    logDurable(`已把 dsh.new 标记为不可应用（${reason}）：下次启动不会拿它去交换`);
    return true;
  } catch (e) {
    logDurable(`标记 dsh.new 不可应用失败（下次启动可能重试应用）：${e.message}`);
    return false;
  }
}

/** 暂存树已清干净时清掉作废标记（否则会永远显示"有个坏暂存"）。 */
function clearDshStagingInvalidation() {
  try {
    fs.unlinkSync(dshStagingInvalidPath());
    logDurable('dsh.new 不可应用标记已清除（暂存目录已清干净）');
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    logDurable('清除 dsh.new 不可应用标记失败：' + e.message);
    return false;
  }
}

/**
 * 交换彻底失败后的最后手段：把 dsh.new **复制**成新树再整体换上（0.3.49 修正）。
 * 旧实现是 `copyDir(dshNew → dsh)` 后删 dsh.new —— 两个真实缺陷：
 *  ① **叠加而非替换**：新版本删掉/改名的文件会作为旧版残留留在 dsh 里，形成"新旧混合
 *     树"，而 `verifyAppliedDsh` 只看 bin.js + 版本号，看不出来；
 *  ② **不产 `dsh.previous`**：于是这条路径上的更新没有回滚素材，H-01 的自动回滚在这条
 *     路径上"无版本可退"。
 *
 * 现在的做法：先把 dsh.new 复制到 `dsh.copy`（同卷临时目录）→ 校验树完整且版本正确 →
 * 才把旧 dsh 挪到 `dsh.old`、`dsh.copy` 挪成 dsh、`dsh.old` 落到 `dsh.previous`。
 * 任何一步失败都把 dsh 还原回原位并保留 dsh.new（本次不应用，下次启动重试），绝不留下
 * "dsh 不存在"的中间态。
 *
 * @returns {boolean} true = 已换上且 dsh.previous 已就位
 */
function swapDshByCopy(p, lastErr, expectedVersion = null) {
  const copyTmp = path.join(p.root, 'dsh.copy');
  const oldBackup = path.join(p.root, 'dsh.old');
  let movedAside = false;
  try {
    rimraf(copyTmp);
    copyDir(p.dshNew, copyTmp);
    const probe = probeDshTree(copyTmp);
    if (!probe) throw new Error('复制后的树缺少 lib/bin.js');
    if (expectedVersion && probe.version && compareSemver(probe.version, expectedVersion) !== 0) {
      throw new Error(`复制后的版本 ${probe.version} ≠ 目标 ${expectedVersion}`);
    }
    rimraf(oldBackup);
    if (fs.existsSync(p.dshDir)) { fs.renameSync(p.dshDir, oldBackup); movedAside = true; }
    fs.renameSync(copyTmp, p.dshDir);
    // 旧版本落到 dsh.previous —— 这就是 H-01 自动回滚的素材来源。
    rimraf(p.dshPrevious);
    if (fs.existsSync(oldBackup)) fs.renameSync(oldBackup, p.dshPrevious);
    rimraf(p.dshNew);
    // 暂存目录若因为占用删不净，必须让它"不可再被应用"：否则下次启动会把一棵缺文件的
    // dsh.new 当成待装版本再交换一次，直接把好树换坏。
    //
    // 注意：这里**不能**靠"改名藏起来"——当占用就在 dsh.new 内部时，连 rename 它自己
    // 都会 EPERM（实测）。所以标记放在 dsh.new **外面**（root/dsh.new.invalid.json），
    // 由 applyStaged / stagedVersions 统一认这个标记。
    if (fs.existsSync(p.dshNew)) invalidateDshStaging('copy fallback 后暂存目录未删净（被占用）');
    logDurable(`applied staged dsh via copy fallback (version ${probe.version || '?'}, previous retained)`);
    return true;
  } catch (e) {
    // 已经动过 dsh 目录就尽力还原：宁可这次不更新，也不能留一个"dsh 消失"的现场。
    if (movedAside && !fs.existsSync(p.dshDir) && fs.existsSync(oldBackup)) {
      try { fs.renameSync(oldBackup, p.dshDir); }
      catch (e2) { logDurable(`复制兜底失败后还原 dsh 也失败（下次启动会按更新中断处理）：${e2.message}`); }
    }
    rimraf(copyTmp);
    logDurable(`apply staged dsh copy fallback failed；dsh.new 保留待下次启动: ${(e && e.message) || (lastErr && lastErr.message)}`);
    return false;
  }
}

/**
 * dsh 树的「标记 → 交换 → 校验 → 清标记」全过程（从 applyStaged 抽出，0.3.48 · H-05）。
 * 交换是唯一不可逆窗口，单独成函数才能把标记纪律一眼看完。
 * @returns {{applied: string|null, swapped: boolean}}
 */
function applyStagedDshSwap(p) {
  const staged = stagedVersions().dsh || null;
  const stale = readApplyInProgress();
  if (stale) {
    log(`发现上一次更新留下的中断标记（步骤=${stale.step || '?'} 开始=${stale.startedAt || '?'}）：本次应用将覆盖它，历史状态已进诊断日志`);
  }

  let marker;
  try {
    marker = beginApplyInProgress({ step: 'dsh-swap', from: currentVersions().dsh, to: staged });
  } catch (e) {
    log('写入更新中断标记失败，取消本次 dsh 交换（dsh.new 保留，下次启动重试）：' + e.message);
    journalAdd('dsh', 'failed', { to: staged, reason: `ERR_UPDATER_APPLY_MARKER_FAILED ${e.message}` });
    return { applied: null, swapped: false };
  }

  const direct = swapDshDirectories(p);
  const swapped = direct.swapped || swapDshByCopy(p, direct.lastErr, staged);

  if (!swapped) {
    log('dsh 交换未完成：保留中断标记，下次启动据此判定是否从 dsh.old / dsh.previous 恢复');
    journalAdd('dsh', 'failed', { to: staged, reason: `ERR_UPDATER_APPLY_INCOMPLETE ${(direct.lastErr && direct.lastErr.message) || ''}` });
    try { updateApplyInProgress(marker.operationId, { step: 'dsh-swap-failed' }); }
    catch (e) { log('更新中断标记步骤补写失败：' + e.message); }
    return { applied: null, swapped: false };
  }

  const verified = verifyAppliedDsh(staged);
  if (!verified.ok) {
    log('dsh 交换已完成但校验未通过，保留中断标记供下次启动判定：' + verified.reason);
    journalAdd('dsh', 'failed', { to: staged, reason: `ERR_UPDATER_APPLY_UNVERIFIED ${verified.reason}` });
    try {
      updateApplyInProgress(marker.operationId, { step: 'dsh-swap-unverified', detail: String(verified.reason).slice(0, 200), onDisk: verified.version || null });
    } catch (e) { log('更新中断标记步骤补写失败：' + e.message); }
    return { applied: verified.version || dshVersion(), swapped: true };
  }

  log('applied staged dsh', verified.version);
  journalAdd('dsh', 'applied', { from: readJson(p.versionsJson, {}).dsh, to: verified.version });
  try { clearApplyInProgress(marker.operationId); }
  catch (e) { log('清除更新中断标记失败（下次启动会按“更新被中断”处理，属如实上报）：' + e.message); }
  return { applied: verified.version, swapped: true };
}

// --------------------------------------------------------------------------
// 0.3.49 · B-08：干净退出才允许应用更新
//
// 官方 host-process.ts:363-366 的判定式是「requireGraceful && 子进程已退出且退出码 0
// 且 teardown 完成」，不满足直接抛 DesktopHostUncleanExitError。我们**不能照抄**：
// Windows 上我们已实测 SIGTERM handler 不触发（0.3.44），等价物只能是「后端进程真的
// 不在了」。
//
// 这里的纪律是「不许强杀后硬上」：检测不通过 → **不应用**（dsh.new / node.new 原样
// 留着），返回 blocked + 可操作文案，由调用方稍后重试。绝不 taskkill 完就往下走 ——
// 那会把"更新装到一半的树"和"正在退出的后端"叠在一起，是最难归因的一类现场。
// --------------------------------------------------------------------------
/** 由主进程注入的探针（它才知道 child_process 与在途会话写入的真实状态）。 */
let applyGateProbe = null;

/**
 * 注册"能不能应用更新"的探针。
 * @param {() => ({backendRunning?: boolean, pendingWrites?: number, detail?: string})} probe
 */
function setApplyGate(probe) {
  applyGateProbe = typeof probe === 'function' ? probe : null;
  log('apply 闸门探针已注册:', !!applyGateProbe);
  return true;
}

/**
 * 自带进程探针：找 `backend\node.exe` 这个**专用** node 副本的进程。
 * 用专用副本而不是 `node.exe` 通配，避免把用户自己跑的 node 当成我们的后端。
 * @returns {{running: boolean, pids: number[], error: string|null}}
 */
function scanBackendProcesses() {
  const p = P();
  const script = [
    `$p = '${String(p.nodeExe).replace(/'/g, "''")}'`,
    'try {',
    '  $list = Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq $p }',
    '  if ($list) { ($list | ForEach-Object { $_.ProcessId }) -join \',\' } else { \'\' }',
    '} catch { "ERR:" + $_.Exception.Message }'
  ].join('; ');
  try {
    const out = require('child_process').execFileSync('pwsh', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    }).trim();
    if (out.startsWith('ERR:')) return { running: false, pids: [], error: out.slice(4) };
    const pids = out ? out.split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n)) : [];
    return { running: pids.length > 0, pids, error: null };
  } catch (e) {
    // 探针自己失败 ≠ 干净。宁可判"不干净"让它稍后重试，也不要带着未知状态去改磁盘。
    return { running: false, pids: [], error: (e && e.message) || String(e) };
  }
}

/**
 * 当前是否允许应用更新。
 * @returns {{clean: boolean, reasons: string[], detail: object}}
 */
function applyGateStatus() {
  const reasons = [];
  const detail = { process: null, writer: 'not-registered', probeError: null };
  let running = null;
  let pendingWrites = null;

  if (applyGateProbe) {
    const r = applyGateProbe() || {};
    if (typeof r.backendRunning === 'boolean') running = r.backendRunning;
    if (typeof r.pendingWrites === 'number') { pendingWrites = r.pendingWrites; detail.writer = r.pendingWrites; }
    if (r.detail) detail.probeDetail = String(r.detail).slice(0, 200);
  }
  if (running === null) {
    const scan = scanBackendProcesses();
    detail.process = scan;
    if (scan.error) { detail.probeError = scan.error; reasons.push(`无法确认后端是否已退出（探针失败：${scan.error}）`); }
    running = scan.running;
  }
  if (running === true) reasons.push('后端进程仍在运行');
  if (pendingWrites && pendingWrites > 0) reasons.push(`仍有 ${pendingWrites} 项会话写入未落盘`);
  return { clean: reasons.length === 0, reasons, detail };
}

/**
 * 应用暂存更新（在启动链上、后端未运行时调用）。
 *
 * 0.3.49 · B-08：真正动手之前先过「干净退出」闸门。有东西要装时才探测（探测要起一个
 * PowerShell，几百毫秒 —— 绝大多数启动根本没有暂存更新，不该为此付代价）。
 *
 * @param {{skipGate?: boolean}} [options] skipGate 仅供测试构造（生产调用不要传）
 * @returns {{dsh: string|null, node: string|null, blocked?: boolean, gate?: object,
 *            retryHint?: string, nextRetryAtMs?: number}}
 */
function applyStaged(options = {}) {
  const p = P();
  const applied = { dsh: null, node: null };

  // 0.3.49：先处理"被作废的暂存树"。能清干净就清标记；清不干净就本次坚决跳过 ——
  // 拿一棵缺文件的 dsh.new 去交换，比不更新糟得多。
  let stagingInvalid = dshStagingInvalidated();
  if (stagingInvalid) {
    rimraf(p.dshNew);
    if (!fs.existsSync(p.dshNew)) { clearDshStagingInvalidation(); stagingInvalid = false; }
    else logDurable('dsh.new 已被标记为不可应用：本次跳过（文件仍被占用，稍后再清）');
  }

  const hasStagedNode = fs.existsSync(path.join(p.nodeNew, 'node.exe'));
  const hasStagedDsh = !stagingInvalid && fs.existsSync(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));

  // 没有暂存内容 = 无事可做。既不该探测，也不该写 journal。
  if (!hasStagedNode && !hasStagedDsh) return applied;

  if (!options.skipGate) {
    const gate = applyGateStatus();
    if (!gate.clean) {
      const reasonText = gate.reasons.join('；');
      logDurable(`已阻止本次应用更新（后端未干净退出）：${reasonText}`);
      journalAdd('dsh', 'failed', { to: stagedVersions().dsh, reason: `ERR_UPDATER_BACKEND_NOT_STOPPED ${reasonText}` });
      return {
        ...applied,
        blocked: true,
        gate,
        retryHint: '正在收尾，稍后自动重试（本次不会应用更新，已暂存的版本保持原样）',
        nextRetryAtMs: 60000
      };
    }
  }

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
      journalAdd('node', 'applied', { to: applied.node });
      try { enableCorepack(env); } catch {}
      rimraf(p.nodeNew); // discard staging only after a confirmed successful apply
    } catch (e) {
      // Keep node.new so the update is retried on the next launch.
      log('apply staged node failed (node.new kept for next launch):', e.message);
      journalAdd('node', 'failed', { reason: String(e.message).slice(0, 300) });
    }
  }

  // Dsh backend: swap dshDir with dshNew. Retried because a just-killed
  // backend (or antivirus) can transiently hold locks on the old tree.
  // 0.3.48 · H-05：交换全过程（含「进行中」标记与校验）已抽到 applyStagedDshSwap。
  if (fs.existsSync(path.join(p.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    const res = applyStagedDshSwap(p);
    if (res.applied) applied.dsh = res.applied;
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
  // 0.3.49 · B-06：只有"确实有更新可提示"时才记录候选 —— 记录的是用户**即将在弹窗里
  // 看到的那个目标**（版本 + 内容摘要），不是"最新"这个抽象概念。
  try {
    const hasDshUpdate = result.updates.some((u) => u.component === 'dsh');
    if (hasDshUpdate && !requested) await recordUpdateCandidate({ version: result.latest.dsh, source: 'check' });
    else if (requested) log('安装器指定版本模式：不记录更新候选（该路径不走确认弹窗）');
  } catch (e) { log('记录更新候选失败（确认绑定将退化为未绑定）:', e.message); }
  return result;
}

// --------------------------------------------------------------------------
// 0.3.49 · B-03：把「何时检查更新」交给 update-schedule.js（纯逻辑、可注入时钟）
//
// 旧实现是 main.js 里的 `setTimeout(5s)` + `setInterval(6h)`：无退避、无抖动、无单飞、
// 用墙钟。这里只提供**接线件**，策略全在 update-schedule.js 里（可单测）。
// --------------------------------------------------------------------------
/**
 * 创建后端更新检查的常驻节拍器。
 *
 * 语义边界：它只决定**何时**检查；检查到更新后仍然只发通知（通知制不变）。
 *
 * 接线（main.js，一行）：
 *   `const loop = mgr.createBackendUpdateLoop(); ... loop.start()` 取代原来的
 *   `setTimeout(checkBackendUpdates, 5000)` + `setInterval(checkBackendUpdates, 6h)`。
 *
 * @param {{env?: object, includeNode?: boolean, log?: Function,
 *          hrtime?: Function, random?: Function, baseMs?: number, maxBackoffMs?: number, jitter?: number}} [opts]
 */
function createBackendUpdateLoop(opts = {}) {
  const schedule = require('./update-schedule');
  const cfg = schedule.configFromEnv(opts.env || process.env, {
    baseMs: opts.baseMs, maxBackoffMs: opts.maxBackoffMs, jitter: opts.jitter
  });
  const say = opts.log || ((msg, detail) => log('[update-schedule] ' + msg, detail === undefined ? '' : detail));
  return schedule.createUpdateScheduler({
    ...cfg,
    hrtime: opts.hrtime,
    random: opts.random,
    log: (msg, detail) => say(msg, detail),
    check: async (reason) => {
      // 0.3.49 · B-03：把「检查本身」的失败也纳入退避 —— 网络错误、元数据解析失败
      // 都算失败；单靠"没发现新版本"当成功会让弱网永远按 10 分钟硬撞镜像。
      const res = await checkForUpdates({ includeNode: opts.includeNode !== false });
      const errs = Array.isArray(res.errors) ? res.errors : [];
      if (errs.length) {
        throw new Error(`更新检查有 ${errs.length} 项失败：` + errs.slice(0, 3).map((e) => `${e.component}:${e.error}`).join('; '));
      }
      log('更新检查完成', { reason, updates: res.updates.map((u) => u.component + '→' + u.latest) });
      return res;
    }
  });
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
 * 关键依赖包（0.3.42 · 借鉴官方 core-package-set.ts 的"显式必需集"抽象）。
 *
 * ## 为什么需要这个
 *
 * 10-11 事故的本质不是"凭据文件格式错了"，而是**没有任何一处代码知道
 * `credentials` 是其它 9 个插件的必需依赖**。因此当它加载失败时：
 *   - 后端只报一句无名的 `1 required plugin did not activate`
 *   - 我们的归因式自愈（1b 插件条目 / 1c bundle）想按日志点名禁用插件，点不到名字
 *   - 阶梯只能一路下坠到最重的"隔离整个 profiles"，连烧 3 份备份且完全无效
 *     （根因在 home 层，profiles 之外）
 *
 * 官方用 RELEASE_PACKAGES 显式声明"哪些包是必需的"，并进行版本绑定校验。
 * 我们这里做同一件事的最小可用版：显式声明**服务型关键包**及其依赖方数量，
 * 让失败归因从"猜日志"变成"查表"。
 *
 * 注意：这里的包名对应 dsh 内部的 bundle 包名，不是用户插件。名单只用于
 * **归因与提示**，绝不用来自动改写用户配置（所有权规约：shell 不越权重建立）。
 */
const CRITICAL_SERVICE_PACKAGES = {
  '@deepseek-ai/dsh-credentials': {
    role: '凭据服务',
    // 该包加载失败时，这些能力会一起失效（依据 10-11 事故实测的等待链）。
    dependents: [
      'model provider（模型调用）', 'account-platform（账号平台）',
      'browser-session（浏览器会话）', 'repo-push-access（仓库推送）',
      'plugin 安装与更新', 'CLI 登录态', '网络代理配置',
      '会话持久化', '遥测/诊断上报'
    ],
    hint: 'home 级 .credentials.yaml 存在结构问题（键必须形如 <scope>/<id>，用斜杠分隔）'
  }
};

/**
 * 从启动日志归因到"关键服务包失败"，返回可操作结论。
 * 与 analyzeCredentialFailure 互补：后者看的是凭据键的形态，这里看的是
 * "哪个必需服务倒了、会连带倒掉什么"。
 *
 * @returns {{ package: string|null, role: string, dependents: string[], hint: string, affectedCount: number }}
 */
function attributeCriticalFailure(logText) {
  const text = String(logText || '');
  for (const [pkg, meta] of Object.entries(CRITICAL_SERVICE_PACKAGES)) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = new RegExp(escaped).test(text);
    // 无名失败：日志只说 N 个必需插件未激活，但恰好伴随凭据键格式错误 —— 结合判定。
    const keyShapeError = /credential key "[^"]+" must be "<scope>\/<id>"/.test(text);
    const genericRequired = /startup failed:\s*\d+\s+required plugin/.test(text);
    if (named || (keyShapeError && genericRequired)) {
      return {
        package: pkg,
        role: meta.role,
        dependents: meta.dependents,
        hint: meta.hint,
        affectedCount: meta.dependents.length
      };
    }
  }
  return { package: null, role: '', dependents: [], hint: '', affectedCount: 0 };
}

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
 *
 * ⚠️ 0.3.42 · 数据安全（对齐官方 command-installation.ts 的"拒绝基于陈旧快照写入"
 * 纪律）：旧实现把 `regQueryUserEnv('Path')` 读失败（返回 null）当成"PATH 为空"，
 * 于是 entries=[]、without=[]、next=[]，走到 `regDeleteUserEnv('Path')` ——
 * **一次读取失败就抹掉用户整个用户级 PATH**。改用户 PATH 属于不可逆破坏，
 * 因此现在：读不到就中止（绝不写），写后必须回读校验，校验不符则回滚。
 */
function setUserPathEntry(enabled) {
  const p = P();
  if (enabled) writeWrapperScripts();
  const cur = regQueryUserEnv('Path');
  // 读失败 ≠ 空。宁可这次不生效，也不能拿"空快照"去覆盖真实 PATH。
  if (cur === null || typeof cur.value !== 'string') {
    log('setUserPathEntry aborted: could not read current user PATH (refusing to write from a stale snapshot)');
    return { ...userPathStatus(), ok: false, reason: 'unreadable' };
  }
  const type = cur.type || 'REG_EXPAND_SZ';
  const original = String(cur.value);
  const entries = original.split(';').map((s) => s.trim()).filter(Boolean);
  const target = path.resolve(p.binDir).toLowerCase();
  const without = entries.filter((e) => { try { return path.resolve(e).toLowerCase() !== target; } catch { return true; } });
  const next = enabled ? [...without, p.binDir] : without;

  // 安全阀：只有确定"变化仅涉及我们自己的目录"时才允许写。
  if (entries.length > 0 && without.length === 0 && next.length <= 1) {
    log(`setUserPathEntry aborted: refusing to reduce ${entries.length} PATH entries to ${next.length}`);
    return { ...userPathStatus(), ok: false, reason: 'unsafe-reduction' };
  }

  if (!next.length) { regDeleteUserEnv('Path'); }
  else { regSetUserEnv('Path', next.join(';'), type); }

  // 写后回读校验：注册表写入可能被策略/权限静默丢弃，回读能立刻发现。
  const check = regQueryUserEnv('Path');
  const expected = next.join(';');
  const actual = check && typeof check.value === 'string' ? check.value : '';
  const norm = (s) => s.split(';').map((x) => x.trim()).filter(Boolean).join(';');
  if (norm(actual) !== norm(expected)) {
    log('setUserPathEntry verification failed; restoring previous value');
    if (!entries.length) regDeleteUserEnv('Path');
    else regSetUserEnv('Path', original, type);
    return { ...userPathStatus(), ok: false, reason: 'verify-failed' };
  }

  log(enabled ? 'added wrapper dir to user PATH' : 'removed wrapper dir from user PATH');
  return { ...userPathStatus(), ok: true };
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
  // pnpm 的 auto-install-peers 会把同一 profile 内各插件声明的 peer 区间**合并**后
  // 一起解析。DSH 自家 client 包（dsh-client-locale/store/ui-* 等）只发预发布版
  // （0.1.x-rc/alpha），而合并出的区间形如 `>=0.1.1 <0.2.0-0` —— 按 semver 规则
  // **不含预发布标识的区间不匹配任何预发布版本**，于是必然 ERR_PNPM_NO_MATCHING_VERSION，
  // 导致装任何插件都可能被别的插件的 peer 声明连坐拖失败（@captain1275/dsh-pet
  // 就是这样装不上的）。这些 peer 本就由 DSH 运行时在加载期提供，不需要真的装进
  // profile，因此关掉自动装 peer 并放宽 strict-peer-dependencies。
  if (!Object.prototype.hasOwnProperty.call(env, 'NPM_CONFIG_AUTO_INSTALL_PEERS')) {
    env.NPM_CONFIG_AUTO_INSTALL_PEERS = 'false';
    env.NPM_CONFIG_STRICT_PEER_DEPENDENCIES = 'false';
  }
  Object.assign(env, options.extraEnv || {});
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
  // 0.3.41 · home 级凭据预校验（启动前纠错 + 自愈升级护栏）
  validateCredentialsDocument, repairCredentialKeys, analyzeCredentialFailure,
  // 0.3.42 · 关键服务包归因（从哪里失败 → 会连带影响什么）
  attributeCriticalFailure, CRITICAL_SERVICE_PACKAGES,
  analyzeFailingBundles, disableFailingBundles, BASE_BUNDLES,
  findLoaderIdConflicts, applyLoaderConflictFixes, disablePatchEntriesInFile,
  // 0.3.46 · 解析根模型与自愈恢复通道
  runtimeResolutionRoots, restorePreflightDisabledEntries, PREFLIGHT_MARKER,
  loggedBareNameDisableEvents, readDisableMarkers, readDesktopLogTail,
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
  compareSemver,
  // payload 完整性校验（vendor-manifest.json）：供测试与诊断调用
  verifyPayloadParts, verifyVendorManifest, quarantineSeededBackend, manifestPath, countTree,
  // 0.3.38 Python 检测引导 / 版本耦合软闸门 / 更新 journal
  detectPythonRuntime, pythonBootCheck, dismissPythonPrompt,
  comboGateCheck, dismissComboPrompt,
  journalAdd, readUpdateJournal, journalMarkVerified, journalUnverified,
  // 0.3.48 · H-05「更新应用中」标记：交换前落标记、启动早期检测残留、主进程确认后清除
  applyInProgressPath, readApplyInProgress, beginApplyInProgress, updateApplyInProgress,
  clearApplyInProgress, detectInterruptedApply, interruptedApplyState, verifyAppliedDsh,
  // 0.3.49 · B-03 更新节拍（策略在 update-schedule.js，这里只给接线件）
  createBackendUpdateLoop,
  // 0.3.49 · B-17 运行期完整性校验（供 stageDsh/stageNode 与测试/诊断调用）
  parseSri, chooseIntegrity, verifyFileIntegrity, digestFileSync, verifyNodeZip, dshDistMeta,
  integrityPolicy,
  // 0.3.49 · B-06 更新确认与版本绑定（revision + 内容摘要）
  updateRevision, bumpUpdateRevision, issueUpdateConfirmation, assertConfirmationFresh,
  checkConfirmationDigest, candidateDigest, recordUpdateCandidate,
  // 0.3.49 · B-08 干净退出闸门与回滚台账对齐
  setApplyGate, applyGateStatus, scanBackendProcesses, journalMarkRolledBack,
  // 0.3.42 原子写（供测试与诊断调用）
  writeJson, readJson,
  // 0.3.43 不跟随链接的目录删除（防 junction 删进用户源码）
  removeOwnedDirectory, rimraf,
};
