'use strict';

/**
 * 0.3.46 回归：启动预检的裸包名解析根 + 自愈恢复 + 退出原因台账。
 *
 * 背景（2026-10-20 事故的直接缺陷）：
 *   preflightBareNameResolution 只从 <dsh-home>/profiles/* 向上找 node_modules，
 *   而 Cordis loader 对裸包名实际是以 **loader 包所在目录**
 *   （<backend>/dsh/node_modules）为基准做普通 ESM 动态 import ——
 *   于是官方后端树里明明装着的 @deepseek-ai/dsh-mcp-client 被判成
 *   「冷启动必然失败」并被自动禁用（10-15 误伤 4 条、10-20 误伤 1 条并弹窗）。
 *
 * 本测试覆盖：
 *   A. 解析根模型：只装在官方后端树里的包必须能解析（旧模型必然判失败）
 *   B. 自校验锚点：锚点解析不到 ⇒ 禁止任何破坏性禁用
 *   C. 真正装不上的包仍然会被判为 broken（修复没有把预检变成摆设）
 *   D. 禁用会写机器可读标记；恢复通道能把它撤销
 *   E. 用户自己注释掉的条目不会被自动恢复
 *   F. 退出原因台账：start/exit 记录 + 孤儿会话判定
 *
 * 用法：node scripts/test-046-preflight-resolution.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── 沙箱：把 os.tmpdir() 指到独立目录，避免碰到真实 dsh-home ───────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-046-'));
process.env.TEMP = SANDBOX;
process.env.TMP = SANDBOX;
process.env.DSH_DIAG_BASE = path.join(SANDBOX, 'diag');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(n) { console.log('\n' + n); }

// ── 目录搭建 ────────────────────────────────────────────────────────────────
const USER_DATA = path.join(SANDBOX, 'dsh-desktop');   // userDataPath() 的回退值
const HOME = path.join(USER_DATA, 'dsh-home');
const BACKEND_DSH = path.join(USER_DATA, 'backend', 'dsh');
const SCOPE = path.join(BACKEND_DSH, 'node_modules', '@deepseek-ai');

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
function makePackage(dir, name, version = '1.0.0') {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'lib/index.js' }, null, 2));
}

console.log('0.3.46 预检解析根 / 自愈恢复 / 退出台账 回归');
console.log('沙箱：' + SANDBOX);

// 官方后端树：dsh 安装锚点 + loader 包 + 被误判的官方包 + 内置 dsh-base 锚点
makePackage(path.join(SCOPE, 'dsh'), '@deepseek-ai/dsh', '0.2.1-alpha.5');
makePackage(path.join(SCOPE, 'cordis-plugin-loader'), '@deepseek-ai/cordis-plugin-loader');
fs.mkdirSync(path.join(SCOPE, 'cordis-plugin-loader', 'lib', 'config'), { recursive: true });
makePackage(path.join(SCOPE, 'dsh-mcp-client'), '@deepseek-ai/dsh-mcp-client', '0.2.1-alpha.5');
makePackage(path.join(SCOPE, 'dsh-mcp-resources'), '@deepseek-ai/dsh-mcp-resources', '0.2.1-alpha.5');
writeFile(path.join(SCOPE, 'dsh-base', 'cordis.patch.yml'), [
  '- insert:',
  '    - id: mcp-resources-global',
  "      name: '@deepseek-ai/dsh-mcp-resources'",
  '      config:',
  '        serverName: resources',
  '',
].join('\n'));

// 家级 + profile 补丁：声明一个**只装在官方后端树里**的裸包名
const HOME_PATCH = path.join(HOME, 'cordis.patch.yml');
writeFile(HOME_PATCH, [
  '# 家级补丁（测试用）',
  '- insert:',
  '    - id: mcp-cli-bridge-global',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: cli',
  '',
].join('\n'));
const PROFILE_DIR = path.join(HOME, 'profiles', 'web');
writeFile(path.join(PROFILE_DIR, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2));
writeFile(path.join(PROFILE_DIR, 'cordis.patch.yml'), [
  '- insert:',
  '    - id: profile-only',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '',
].join('\n'));

const mgr = require(path.join(ROOT, 'updater-backend.js'));
const pluginResolution = require(path.join(ROOT, 'plugin-resolution.js'));
const patchFile = require(path.join(ROOT, 'patch-file.js'));

// ── A. 解析根模型 ────────────────────────────────────────────────────────────
section('A. 解析根模型（只装在官方后端树里的包必须能解析）');
const roots = mgr.runtimeResolutionRoots(HOME);
ok(roots.some((r) => r.why === 'install-scope'), '解析根含 installation scope（官方后端安装树）');
const scopePaths = pluginResolution.installScopePaths(path.join(BACKEND_DSH, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
ok(scopePaths.some((p) => p === path.join(BACKEND_DSH, 'node_modules')), 'installation scope 覆盖 <backend>/dsh/node_modules');
ok(scopePaths.some((p) => p === path.join(USER_DATA, 'backend', 'node_modules')), 'installation scope 覆盖 <backend>/node_modules');
const hit = pluginResolution.resolveBareName(roots, '@deepseek-ai/dsh-mcp-client');
ok(hit.resolved === true, '@deepseek-ai/dsh-mcp-client 通过后端树解析成功（旧模型此处必然失败）');
ok(hit.why === 'install-scope', '解析命中的是 installation scope');

const pre = mgr.preflightBareNameResolution();
ok(Array.isArray(pre.broken) && pre.broken.length === 0, '预检不再把官方后端树里的包判成「冷启动必然失败」');
ok(pre.anchor && pre.anchor.trusted === true, '自校验锚点通过（内置 dsh-base 裸包名可解析）');
ok(pre.anchor && pre.anchor.names.includes('@deepseek-ai/dsh-mcp-resources'), '锚点取自内置 dsh-base 补丁');

// ── B. 锚点不可信 ⇒ 禁止破坏性禁用 ─────────────────────────────────────────
section('B. 自校验锚点不可信时禁止任何禁用');
// 把锚点包从后端树里移走：内置补丁仍声明它，但它解析不到 ⇒ 根集合不可信
const anchorPkg = path.join(SCOPE, 'dsh-mcp-resources');
const anchorBackup = fs.readFileSync(path.join(anchorPkg, 'package.json'), 'utf8');
fs.rmSync(anchorPkg, { recursive: true, force: true });
const preNoAnchor = mgr.preflightBareNameResolution();
ok(preNoAnchor.broken.length === 0, '锚点不可信 ⇒ 没有条目被判为 broken（不做破坏性判定）');
ok(preNoAnchor.skipped.length > 0, '锚点不可信 ⇒ 记录了 skip 原因');
ok(preNoAnchor.anchor && preNoAnchor.anchor.trusted === false, '锚点自校验判定为不可信');
fs.mkdirSync(anchorPkg, { recursive: true });
fs.writeFileSync(path.join(anchorPkg, 'package.json'), anchorBackup, 'utf8');
ok(mgr.preflightBareNameResolution().anchor.trusted === true, '锚点恢复后自校验重新通过');

// ── C. 真正装不上的包仍会被判 broken（预检没被改成摆设）─────────────────────
section('C. 真正装不上的包仍会被判 broken');
writeFile(HOME_PATCH, [
  '- insert:',
  '    - id: mcp-cli-bridge-global',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '    - id: missing-plugin',
  "      name: '@deepseek-ai/definitely-not-installed'",
  '',
].join('\n'));
const pre2 = mgr.preflightBareNameResolution();
ok(pre2.broken.length === 1, '缺失的包被正确判为 broken');
ok(pre2.broken[0] && pre2.broken[0].id === 'missing-plugin', 'broken 指向真正缺失的条目');
ok(pre2.broken[0] && /解析根/.test(pre2.broken[0].reason), 'broken 原因里写明了查过的解析根');

// ── D. 禁用写标记 + 恢复通道 ────────────────────────────────────────────────
section('D. 禁用标记与自愈恢复');
const disabled = mgr.disablePatchEntriesInFile(HOME_PATCH, ['missing-plugin'], { kind: 'bare-name-unresolvable', reason: '包无法解析' });
ok(disabled.disabled.length === 1, '条目被禁用');
ok(!!disabled.backup && fs.existsSync(disabled.backup), '禁用前留了备份');
const afterDisable = fs.readFileSync(HOME_PATCH, 'utf8');
ok(afterDisable.includes(mgr.PREFLIGHT_MARKER), '禁用后写入了机器可读标记');
ok(/kind=bare-name-unresolvable/.test(afterDisable), '标记里写明了禁用原因种类');
const commented = patchFile.parseCommentedPatchEntries(afterDisable);
ok(commented.some((c) => c.id === 'missing-plugin'), '被注释的条目可被定位');

// 恢复：missing-plugin 仍装不上 ⇒ 不应恢复
const restoreUnusable = mgr.restorePreflightDisabledEntries(HOME, { roots });
ok(restoreUnusable.restored.length === 0, '仍然装不上的条目不会被恢复');

// 把包装上（放进后端树）⇒ 应能恢复
makePackage(path.join(SCOPE, 'definitely-not-installed'), '@deepseek-ai/definitely-not-installed');
const restoreOk = mgr.restorePreflightDisabledEntries(HOME, { roots });
ok(restoreOk.restored.length === 1 && restoreOk.restored[0].id === 'missing-plugin', '包能解析后，被误禁用的条目被自动恢复');
const afterRestore = fs.readFileSync(HOME_PATCH, 'utf8');
ok(afterRestore.includes('- id: missing-plugin'), '恢复后条目重新可见');
ok(!afterRestore.includes('#    - id: missing-plugin'), '恢复后条目不再是注释状态');
ok(!afterRestore.includes(mgr.PREFLIGHT_MARKER), '恢复后标记被清掉');

// ── D2. 其它原因的禁用不在恢复范围内 ───────────────────────────────────────
section('D2. 非「裸包名不可解析」的禁用不被自动撤销');
const conflictPatch = path.join(HOME, 'cordis.patch.yml');
writeFile(conflictPatch, [
  '- insert:',
  '    - id: conflict-entry',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '',
].join('\n'));
mgr.disablePatchEntriesInFile(conflictPatch, ['conflict-entry'], { kind: 'loader-id-conflict', reason: 'id 重复' });
const restoreConflict = mgr.restorePreflightDisabledEntries(HOME, { roots });
ok(!restoreConflict.restored.some((r) => r.id === 'conflict-entry'), 'loader id 冲突导致的禁用不被自动撤销');
ok(fs.readFileSync(conflictPatch, 'utf8').includes('#    - id: conflict-entry'), '冲突禁用保持原状');

// ── E. 用户自己注释掉的条目不会被自动恢复 ──────────────────────────────────
section('E. 用户自己注释的条目不被误恢复');
const USER_PATCH = path.join(HOME, 'cordis.patch.yml');
const userText = [
  '# 我自己注释掉的条目（没有应用标记）',
  '#- insert:',
  '#    - id: hand-commented',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '',
].join('\n');
fs.writeFileSync(USER_PATCH, userText, 'utf8');
const restoreUser = mgr.restorePreflightDisabledEntries(HOME, { roots });
ok(!restoreUser.restored.some((r) => r.id === 'hand-commented'), '用户注释的条目没有被自动恢复');
ok(fs.readFileSync(USER_PATCH, 'utf8').includes('#    - id: hand-commented'), '用户注释的条目原样保留');

// ── F. 退出原因台账 ─────────────────────────────────────────────────────────
section('F. 退出原因台账（取证盲区）');
const lifecycle = require(path.join(ROOT, 'lifecycle-log.js'));
process.env.DSH_DIAG_BASE = path.join(SANDBOX, 'diag2');
lifecycle.start('test-boot', { note: 'unit test' });
ok(fs.existsSync(lifecycle.sessionFile(process.pid)), '启动后写出会话状态文件');
const sessionState = JSON.parse(fs.readFileSync(lifecycle.sessionFile(process.pid), 'utf8'));
ok(sessionState.state === 'running' && sessionState.startedAt, '会话状态含启动时间且状态为 running');
lifecycle.exit('tray-quit', '测试退出');
const sessionState2 = JSON.parse(fs.readFileSync(lifecycle.sessionFile(process.pid), 'utf8'));
ok(sessionState2.state === 'exited' && sessionState2.exitReason === 'tray-quit', '退出后状态文件带退出原因');
ok(fs.readFileSync(lifecycle.ledgerFile(), 'utf8').includes('tray-quit'), '台账里有退出原因记录');
const orphans = lifecycle.readOrphanSessions();
ok(!orphans.some((o) => o.pid === process.pid), '已正常退出的实例不算孤儿（= 外部强杀的判据）');

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────');
console.log(`断言 ${pass + failures.length} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  ✗ ' + f);
}
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(failures.length ? 1 : 0);
