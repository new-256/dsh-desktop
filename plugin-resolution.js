'use strict';

/**
 * 裸包名的运行时解析根模型 —— 0.3.46 新增（本次事故的直接修复点）。
 *
 * ── 运行时到底怎么解析裸包名（2026-10-20 实测取证）──
 *
 * 1) Cordis loader 对补丁条目的裸 `name` 执行：
 *      cordis-plugin-loader/src/config/tree.ts:121-122
 *        if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {})
 *    `loader.internal` 来自 src/index.ts:85 `ModuleLoader.fromInternal()`。
 *    本机 Node 24.21 实测：internal/modules/esm/loader 的 **cascaded loader**
 *    上有 getOrCreateModuleJob ⇒ 形状 v2 ⇒ internal **可用**
 *    （注意：形状判定看的是 cascaded loader 对象，不是模块命名空间 ——
 *      看命名空间会误判成「不可用」）。
 *
 * 2) `ctx.baseUrl` = 根 Include 配置文件的目录 ⇒
 *      dsh-app-boot/lib/index.js:4525 → cordis-plugin-include → <profile>/
 *    家级补丁 / profile 补丁 / bundle 补丁被 readProfilePatches 合成**同一棵树**
 *    ⇒ 同一个 baseUrl。
 *
 * 3) 但 DSH 还装了**运行时解析拦截**（dsh-app-boot installRuntimeInterception，
 *    由 PluginPackages 安装）：裸包名先走 routeScoped 路由，命中
 *    **installation scope**（以官方后端安装树 backend\dsh\node_modules 为根，
 *    installAnchor = backend\dsh\node_modules\@deepseek-ai\dsh\package.json）
 *    时改用 entry.declarer 作父路径解析。官方权威口径是
 *    `pluginPackages.packageOf(name, parentURL)`。
 *
 * 实测铁证（backend\node.exe）：
 *    无拦截：@deepseek-ai/dsh-mcp-client 与 dsh-mcp-resources **都** ERR_MODULE_NOT_FOUND
 *    有拦截：两者**都** OK，resolution.entries = 539 条 installation scope
 *
 * ── 旧模型错在哪 ──
 *
 * 0.3.45 及以前的 preflightBareNameResolution 只从
 * `<dsh-home>/profiles/<profile>` 向上做纯 Node walk-up。而
 * `backend\dsh\node_modules` 与 `dsh-home\profiles\<profile>` 是**兄弟目录、
 * 不是祖先** ⇒ walk-up 永远看不到官方包 ⇒ 把明明装着的
 * @deepseek-ai/dsh-mcp-client 判成「冷启动必然失败」并自动禁用：
 *   · 2026-09-10 03:20  误伤 3 条
 *   · 2026-10-15 01:00  误伤 4 条
 *   · 2026-10-20 19:59  误伤 1 条（mcp-cli-bridge-global）→ 弹窗
 *
 * ── 本模型的口径 ──
 *
 * 两个作用域，与 DSH 运行时一致：
 *   ① installation scope：官方后端安装树（Node 自己的 resolve.paths 链）
 *   ② local scope：profile 目录向上 walk-up（家级 node_modules 也在这条链上）
 * 口径取**保守放行**：看得见就不禁。误禁的代价（功能静默消失、用户以为
 * 装坏了）远大于误放行（真失败时 DSH 启动自检会给出权威诊断）。
 */

const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const { parseHomePatchBlocks, isBarePackageName, barePackageName } = require('./patch-file');

/** loader 包名（Cordis 插件加载器）。 */
const LOADER_PACKAGE = 'cordis-plugin-loader';

/**
 * installation scope 的 node_modules 链。
 *
 * 用 Node 自己的 `require.resolve.paths()` 从**官方安装锚点**取 ——
 * 与 DSH 运行时的 installAnchor（backend\dsh\node_modules\@deepseek-ai\dsh\
 * package.json）同源，也与 dsh-app-boot 的 packageDirFromAnchor 同源。
 *
 * @param {string} dshPkgPath <backend>/dsh/node_modules/@deepseek-ai/dsh/package.json
 * @returns {string[]} node_modules 目录链（近 → 远）
 */
function installScopePaths(dshPkgPath) {
  if (!dshPkgPath) return [];
  try {
    const req = createRequire(dshPkgPath);
    const paths = req.resolve.paths('dsh-resolution-probe');
    return Array.isArray(paths) ? paths.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * loader 自身的安装目录 —— 裸 import 的兜底基准。
 *
 * loader.internal 可用时走 internal.import(name, ctx.baseUrl)，由 DSH 的解析
 * 拦截兜住；万一将来 internals 不可用，loader 会退回普通 `await import(name)`，
 * 那时解析基准就是 loader 包所在目录。这条根留着作为**兜底**，不作为主口径。
 */
function loaderBaseDirs(backendDshDir) {
  const out = [];
  if (!backendDshDir) return out;
  const scopeDir = path.join(backendDshDir, 'node_modules', '@deepseek-ai');
  const loaderPkg = path.join(scopeDir, LOADER_PACKAGE);
  const treeDir = path.join(loaderPkg, 'lib', 'config');
  if (fs.existsSync(treeDir)) out.push(treeDir);
  else if (fs.existsSync(loaderPkg)) out.push(loaderPkg);
  return out;
}

/**
 * 组装运行时解析根清单。
 *
 * @param {object} opts
 * @param {string} opts.dshPkgPath      官方安装锚点（package.json 路径）
 * @param {string} opts.backendDshDir   <backend>/dsh
 * @param {string} opts.dshHome         家级 DSH_HOME
 * @param {string[]} opts.profileDirs   profile 目录
 * @returns {Array<{why: string, dir?: string, paths?: string[]}>}
 */
function resolutionRoots({ dshPkgPath, backendDshDir, dshHome, profileDirs } = {}) {
  const roots = [];
  const pushDir = (dir, why) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    if (roots.some((r) => r.dir === abs)) return;
    roots.push({ why, dir: abs });
  };

  // ① installation scope：官方后端安装树（DSH 运行时解析拦截的作用域）
  const scope = installScopePaths(dshPkgPath);
  if (scope.length) roots.push({ why: 'install-scope', paths: scope });
  // ② loader 兜底基准（internals 不可用时的普通 import 路径）
  for (const d of loaderBaseDirs(backendDshDir)) pushDir(d, 'loader-tree');
  // ③ local scope：profile 目录 —— 家级 node_modules 也在这条 walk-up 链上
  for (const d of profileDirs || []) pushDir(d, 'profile');
  if (dshHome) pushDir(dshHome, 'dsh-home');

  return roots;
}

/**
 * Node 风格的上行解析：<name> 是否存在于从 dir 向上走链的某个 node_modules 里。
 * 用 statSync（跟随 junction）—— Windows 上的 junction 对 Node 而言就是目录。
 */
function resolvesFromDir(dir, name) {
  const segs = String(name).split('/').filter(Boolean);
  if (!segs.length) return false;
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

/** <modulesDir>/<name> 是否是一个真实可用的包目录（存在且 package.json 可读）。 */
function packageDirExists(modulesDir, name) {
  const segs = String(name).split('/').filter(Boolean);
  if (!segs.length) return false;
  const full = path.join(modulesDir, ...segs);
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  return st.isDirectory();
}

/**
 * 在根清单里解析一个裸包名。
 * @returns {{resolved: boolean, root: string|null, why: string|null}}
 */
function resolveBareName(roots, name) {
  const bare = barePackageName(name);
  if (!bare) return { resolved: false, root: null, why: null };
  for (const r of roots || []) {
    if (Array.isArray(r.paths)) {
      for (const p of r.paths) {
        if (packageDirExists(p, bare)) return { resolved: true, root: p, why: r.why };
      }
      continue;
    }
    if (r.dir && resolvesFromDir(r.dir, bare)) return { resolved: true, root: r.dir, why: r.why };
  }
  return { resolved: false, root: null, why: null };
}

/**
 * 自校验锚点：内置 dsh-base 补丁里声明的裸包名。
 *
 * 这些包由官方后端自带、**已知可用**，因此它们必须能在根集合里解析到。
 * 若一个都解析不到 ⇒ 根集合本身错了 ⇒ 此时任何「包不存在」的判定都不可信，
 * 必须拒绝执行（2026-10-20 事故就是这种情形：锚点 @deepseek-ai/dsh-mcp-resources
 * 在 installation scope 里明明存在）。
 */
function controlBareNames(backendDshDir) {
  if (!backendDshDir) return [];
  const basePatch = path.join(backendDshDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml');
  let yamlText;
  try { yamlText = fs.readFileSync(basePatch, 'utf8'); } catch { return []; }
  const names = [];
  for (const block of parseHomePatchBlocks(yamlText)) {
    for (const entry of block.entries) {
      if (!entry.name || !isBarePackageName(entry.name)) continue;
      const bare = barePackageName(entry.name);
      if (bare && !names.includes(bare)) names.push(bare);
    }
  }
  return names;
}

/**
 * 根集合是否可信。
 *
 * @returns {{trusted: boolean, reason: string, anchorResolved: string[]}}
 */
function verifyRoots({ roots, anchorNames } = {}) {
  const list = roots || [];
  const anchors = anchorNames || [];
  const resolved = anchors.filter((n) => resolveBareName(list, n).resolved);
  const hasInstallScope = list.some((r) => r.why === 'install-scope');
  if (anchors.length) {
    if (resolved.length) return { trusted: true, reason: `锚点包 ${resolved.join(', ')} 可解析`, anchorResolved: resolved };
    return {
      trusted: false,
      reason: `内置锚点包（${anchors.join(', ')}）在候选解析根里一个都解析不到 —— 根集合不可信`,
      anchorResolved: [],
    };
  }
  if (hasInstallScope) return { trusted: true, reason: '无内置锚点，但 installation scope 已定位', anchorResolved: [] };
  return { trusted: false, reason: '既无内置锚点可校验，也未定位到 installation scope', anchorResolved: [] };
}

/** 把根清单渲染成一行人类可读的说明（进日志与弹窗）。 */
function describeRoots(roots) {
  const parts = [];
  for (const r of roots || []) {
    if (Array.isArray(r.paths)) parts.push(`${r.paths[0]} …（${r.why}，共 ${r.paths.length} 层）`);
    else parts.push(`${r.dir}（${r.why}）`);
  }
  return parts.join('、') || '（无）';
}

module.exports = {
  LOADER_PACKAGE,
  installScopePaths,
  loaderBaseDirs,
  resolutionRoots,
  resolvesFromDir,
  packageDirExists,
  resolveBareName,
  controlBareNames,
  verifyRoots,
  describeRoots,
};
