'use strict';

/**
 * 一次性现场修复工具（0.3.46）：把被「预检误判」而禁用的插件条目恢复回来。
 *
 * 用途：本机 DSH Desktop 仍在跑 0.3.45（预检解析根错误的版本），在下一次
 * 装上 0.3.46 之前，它每次启动都会把官方后端树里的
 * @deepseek-ai/dsh-mcp-client 判成「冷启动必然失败」并再次禁用这些条目。
 * 本工具做两件事：
 *   ① 在家级 node_modules 里给该包建一个指向官方后端树的 junction
 *      —— 让**旧版**预检的 walk-up 也能看见它（旧预检只看 profiles 向上，
 *      家级 node_modules 正在那条链上），从而不再重复误禁用；
 *   ② 调用 0.3.46 新增的恢复通道，把现在能解析的条目恢复回补丁文件
 *      （依据是应用自己写下的 .disabled-<ts>.bak 快照 + 逐行内容校验）。
 *
 * 安全约束：
 *   · 写补丁文件前先留一份带时间戳的备份；
 *   · 写前检查文件自上次读取以来没有变化（并发编辑保护）；
 *   · 恢复后校验：条目确实变为活跃、同 id 没有重复、YAML 仍可解析。
 *
 * 用法：node scripts/repair-046-preflight-restore.js [--dry-run]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// ── 让 updater-backend 里的 app.getPath('userData') 指向**真实** userData ──
// （普通 node 进程里 require('electron') 只给出 exe 路径，app 是 undefined，
//   userDataPath() 会退到 os.tmpdir() —— 那不是正在运行的那个实例的家目录。）
const REAL_USER_DATA = process.env.DSH_USER_DATA
  || path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop');
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => (name === 'userData' ? REAL_USER_DATA : path.join(REAL_USER_DATA, name)),
      isPackaged: true,
      getVersion: () => '0.3.46-repair',
    },
  },
};

const mgr = require(path.join(ROOT, 'updater-backend.js'));
const pluginResolution = require(path.join(ROOT, 'plugin-resolution.js'));

const HOME = mgr.dshHome();
const PATCH = path.join(HOME, 'cordis.patch.yml');

// 桌面日志的真实位置：安装目录 \logs（普通 node 进程里 diag-log 会退到
// %APPDATA%\DSH Desktop\logs —— 那是 9-10 起就停更的死文件，取证必须用活的）
const LOG_CANDIDATES = [
  process.env.DSH_DESKTOP_LOG_FILE,
  path.join('C:\\Program Files\\DSH Desktop', 'logs', 'DSH-Desktop-日志.txt'),
  path.join(REAL_USER_DATA, 'logs', 'DSH-Desktop-日志.txt'),
].filter(Boolean);
const LOG_FILE = LOG_CANDIDATES.find((f) => { try { return fs.statSync(f).size > 0; } catch { return false; } }) || null;

function log(...a) { console.log('[repair-046]', ...a); }

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

log('userData :', REAL_USER_DATA);
log('dsh-home :', HOME);
log('patch    :', PATCH);
log('日志取证 :', LOG_FILE || '（未找到可用日志 → 不做历史取证，只认 0.3.46 起的禁用标记）');

// ── ① junction：让旧版预检也能看见官方包 ───────────────────────────────────
const pkgName = '@deepseek-ai/dsh-mcp-client';
const officialDir = path.join(
  mgr.P().dshDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client'
);
const linkPath = path.join(HOME, 'node_modules', ...pkgName.split('/'));

if (!fs.existsSync(officialDir)) {
  log('✗ 官方后端树里没有', officialDir, '—— 跳过 junction（请先确认后端已 seed）');
} else {
  const already = fs.existsSync(linkPath);
  if (already) {
    let same = false;
    try { same = fs.realpathSync(linkPath) === fs.realpathSync(officialDir); } catch {}
    log(same ? '· junction 已存在且指向官方包：' : '⚠ junction 已存在但指向别处：', linkPath);
  } else if (DRY_RUN) {
    log('[dry-run] 将建立 junction：', linkPath, '→', officialDir);
  } else {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(officialDir, linkPath, 'junction');
    log('✓ 已建立 junction：', linkPath, '→', officialDir);
  }
}

// ── ② 恢复被误禁用的条目 ───────────────────────────────────────────────────
const roots = mgr.runtimeResolutionRoots(HOME);
log('解析根：', pluginResolution.describeRoots(roots));

const before = fs.readFileSync(PATCH, 'utf8');
const beforeStat = fs.statSync(PATCH);

const result = mgr.restorePreflightDisabledEntries(HOME, { roots, dryRun: DRY_RUN, logFile: LOG_FILE });

log('恢复条目：', result.restored.length ? result.restored.map((r) => r.id).join(', ') : '（无）');
if (result.skipped.length) {
  for (const s of result.skipped) log('  跳过', s.id, '——', s.reason);
}

if (DRY_RUN) {
  log('[dry-run] 未写任何文件');
  process.exit(0);
}

// ── ③ 校验 ─────────────────────────────────────────────────────────────────
const after = fs.readFileSync(PATCH, 'utf8');
const afterStat = fs.statSync(PATCH);

function activeIds(text) {
  const ids = [];
  for (const b of require(path.join(ROOT, 'patch-file.js')).parseHomePatchBlocks(text)) {
    for (const e of b.entries) ids.push(e.id);
  }
  return ids;
}
const ids = activeIds(after);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
log('当前活跃条目：', ids.join(', ') || '（无）');
log('重复 id：', dup.length ? dup.join(', ') : '（无）✓');
for (const r of result.restored) {
  if (!ids.includes(r.id)) log('✗ 恢复失败：', r.id);
}
if (beforeStat.mtimeMs !== afterStat.mtimeMs) {
  log('✓ 补丁文件已更新（mtime', beforeStat.mtime.toISOString(), '→', afterStat.mtime.toISOString(), '）');
}
process.exit(dup.length ? 2 : 0);
