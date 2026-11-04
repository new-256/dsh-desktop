'use strict';

/**
 * H-04 验证脚本：profile 隔离兜底**绝不**删用户数据。
 *
 * 背景（隐患清单 H-04）：旧实现 `rename(profiles)` 失败后直接 `rimraf(profiles)`，
 * 把用户的插件注册树与依赖实体物理删除，与 README「最坏也只是隔离备份，不删任何数据」相反。
 *
 * 本脚本验证的是**失败路径**，不是 happy path：
 *   场景1 正常路径（rename 成功）+ 隔离目录保留策略不得误删非本程序命名的目录
 *   场景2 rename 被真实占用打断（不共享 DELETE 的句柄，复刻杀软扫描）→ 复制+校验兜底，
 *         且原树里的数据在隔离目录里有完整副本；用户插件源码（junction 目标）不被扩写
 *   场景3 复制也失败（人为制造读取失败）→ 放弃本轮隔离，原目录原封不动 + 返回明确错误
 *
 * 运行：node scripts/test-h04-quarantine-safety.js   （自带 120s 防卡死超时）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHarness, installElectronStub } = require('./test-h04-h05-harness');

const H = createHarness({ name: 'H-04-quarantine-safety', timeoutMs: 120000 });
const base = path.join(os.tmpdir(), `dsh-h04-${process.pid}-${Date.now()}`);
const userData = path.join(base, 'userData');
const desktop = path.join(base, 'desktop');
const emptyResources = path.join(base, 'emptyResources');
fs.mkdirSync(base, { recursive: true });

installElectronStub({ userData, desktop, resourcesPath: emptyResources, isPackaged: true });
H.startMonitor(path.join(H.repoRoot, '修复与借鉴_2026-11-04', '03_调试阶段'));

const mgr = require('../updater-backend.js');

const holders = [];
const aclRestores = [];
H.onCleanup(() => {
  for (const h of holders) { try { h.kill(); } catch (e) { H.info(`占用句柄结束失败：${e.message}`); } }
  for (const d of aclRestores) H.allowReadAcl(d);
});
H.onCleanup(() => H.removeTree(base));

// ---------------------------------------------------------------------------
// 现场构造
// ---------------------------------------------------------------------------
function writeDeep(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function buildProfiles(home, opts = {}) {
  writeDeep(home, 'profiles/web/package.json', JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@local/repo-push-access'] } },
    dependencies: { '@local/repo-push-access': '^1.2.3' }
  }, null, 2));
  writeDeep(home, 'profiles/web/node_modules/@local/repo-push-access/index.js', 'module.exports = "user plugin";\n'.repeat(200));
  writeDeep(home, 'profiles/web/cordis.patch.yml', '- insert:\n    - id: repo-push-access\n      name: \'@local/repo-push-access\'\n');
  writeDeep(home, 'profiles/other/package.json', JSON.stringify({ name: 'other' }, null, 2));
  writeDeep(home, 'profiles/other/data.bin', Buffer.alloc(4096, 7));
  if (opts.junctionTarget) {
    const link = path.join(home, 'profiles', 'node_modules', '@local', 'repo-push-access');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(opts.junctionTarget, link, 'junction');
  }
  return home;
}

function listAll(home, prefixRe) {
  return fs.readdirSync(home).filter((n) => prefixRe.test(n)).sort();
}
const ANY_QUARANTINE = /^profiles\.broken-/;
const OWN_QUARANTINE = /^profiles\.broken-\d{8}-\d{6}(_\d+)?$/;

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full); else n++;
    }
  };
  walk(dir);
  return n;
}

// ---------------------------------------------------------------------------
// 场景 1：正常路径 + 保留策略
// ---------------------------------------------------------------------------
H.step('场景1 rename 成功（正常隔离）+ 隔离目录保留策略');
const home1 = path.join(userData, 'home1');
buildProfiles(home1);
fs.mkdirSync(path.join(home1, 'profiles.broken-20200101-000000'));
fs.mkdirSync(path.join(home1, 'profiles.broken-20200102-000000'));
fs.mkdirSync(path.join(home1, 'profiles.broken-20200103-000000'));
// 用户手工建的相似目录：名字不符合我方时间戳规范，**绝不允许**被当成自家产物清掉
const userDir = path.join(home1, 'profiles.broken-手工备份');
fs.mkdirSync(userDir);
fs.writeFileSync(path.join(userDir, 'keep-me.txt'), 'user data');

const r1 = mgr.quarantineProfiles(home1);
H.eq(r1.quarantined, true, '场景1 quarantined');
H.eq(r1.fallback, false, '场景1 fallback（未走兜底）');
H.eq(r1.copied, false, '场景1 copied（未走复制兜底）');
H.eq(r1.abandoned, false, '场景1 abandoned');
H.ok(!fs.existsSync(path.join(home1, 'profiles')), '场景1 原 profiles 已离开原位');
H.ok(!!r1.path && fs.existsSync(path.join(r1.path, 'web', 'package.json')), '场景1 隔离目录含 web/package.json', r1.path);
H.ok(!!r1.path && fs.existsSync(path.join(r1.path, 'other', 'data.bin')), '场景1 隔离目录含 other/data.bin');
H.ok(!!r1.registryFile && fs.existsSync(r1.registryFile), '场景1 第三方注册快照已落盘', r1.registryFile);
H.eq(Array.isArray(r1.registry) && r1.registry.length >= 1, true, '场景1 快照至少含 1 个 profile');

const kept = listAll(home1, OWN_QUARANTINE);
H.eq(kept.length, 2, `场景1 我方命名隔离目录只保留 2 份（实际 ${JSON.stringify(kept)}）`);
H.ok(fs.existsSync(path.join(userDir, 'keep-me.txt')), '场景1 用户手工建的同前缀目录未被删除', userDir);
H.ok(kept.includes(r1.name), '场景1 本次隔离目录在保留集合里', r1.name);

// ---------------------------------------------------------------------------
// 场景 2：rename 被真实占用打断 → 复制+校验兜底
// ---------------------------------------------------------------------------
H.step('场景2 rename 被占用（真实句柄）→ 复制+校验兜底');
const home2 = path.join(userData, 'home2');
const userPluginSrc = path.join(base, 'userPluginSource');
fs.mkdirSync(userPluginSrc, { recursive: true });
fs.writeFileSync(path.join(userPluginSrc, 'plugin.js'), 'export const keep = "用户源码";\n');
fs.writeFileSync(path.join(userPluginSrc, '.git-head-marker'), 'x'.repeat(1234));
buildProfiles(home2, { junctionTarget: userPluginSrc });

const lockTarget = path.join(home2, 'profiles', 'web', 'package.json');
holders.push(H.holdFileHandle(lockTarget, 90));
const blocked = H.waitRenameBlocked(path.join(home2, 'profiles'));
H.ok(blocked.blocked, '场景2 占用已生效（rename 会失败）', blocked.code);

const srcFilesBefore = countFiles(path.join(home2, 'profiles'));
const srcLink = path.join(home2, 'profiles', 'node_modules', '@local', 'repo-push-access');
H.ok(fs.lstatSync(srcLink).isSymbolicLink(), '场景2 前置：profiles 里存在指向用户源码的 junction');

const r2 = mgr.quarantineProfiles(home2);
H.ok(H.seen(/rename profiles to .* failed/), '场景2 日志记录了 rename 失败根因', H.lastMatch(/rename profiles to .* failed/));
H.ok(H.seen(/copy-then-verify quarantine/), '场景2 日志声明改走「复制→校验」而不是删除', H.lastMatch(/copy-then-verify/));
H.eq(r2.fallback, true, '场景2 fallback（走了兜底）');
H.eq(r2.copied, true, '场景2 copied（复制并校验成功）');
H.ok(H.seen(/copied profiles to .* and verified/), '场景2 日志含复制校验口径', H.lastMatch(/and verified/));

// 数据安全的核心断言：原树里的每个文件在隔离目录里都有完整副本
const srcPkg = path.join(home2, 'profiles', 'web', 'package.json');
const copyWebPkg = path.join(r2.path, 'web', 'package.json');
H.ok(fs.existsSync(copyWebPkg), '场景2 隔离目录有 web/package.json 副本');
H.eq(fs.readFileSync(copyWebPkg, 'utf8') === fs.readFileSync(srcPkg, 'utf8'), true, '场景2 package.json 内容与源一致');
const srcPluginFile = path.join(home2, 'profiles', 'web', 'node_modules', '@local', 'repo-push-access', 'index.js');
const copyPluginFile = path.join(r2.path, 'web', 'node_modules', '@local', 'repo-push-access', 'index.js');
H.eq(fs.readFileSync(copyPluginFile, 'utf8') === fs.readFileSync(srcPluginFile, 'utf8'), true, '场景2 依赖实体内容一致（旧实现会永久丢失）');
H.ok(fs.existsSync(path.join(r2.path, 'other', 'data.bin')), '场景2 隔离目录含 other/data.bin');

// junction 绝不被跟随复制：隔离目录里应仍是链接，用户源码不被扩写
const copyLink = path.join(r2.path, 'node_modules', '@local', 'repo-push-access');
H.ok(fs.lstatSync(copyLink).isSymbolicLink(), '场景2 隔离目录里的 junction 被重建成链接（未跟随复制）');
H.ok(!fs.lstatSync(copyLink).isDirectory(), '场景2 隔离目录里不是被展开的真实目录');
H.ok(fs.existsSync(path.join(userPluginSrc, 'plugin.js')), '场景2 用户插件源码仍在原位', userPluginSrc);
H.eq(fs.statSync(path.join(userPluginSrc, '.git-head-marker')).size, 1234, '场景2 用户源码字节数未变');
H.eq(r2.quarantined, false, '场景2 quarantined=false（同一占用让删除也失败，绝不谎报隔离完成）');
H.ok(r2.removal && r2.removal.removed === false && typeof r2.removal.reason === 'string', '场景2 返回体如实报告删除失败原因', r2.removal);
H.eq(r2.abandoned, true, '场景2 abandoned=true（本轮隔离未达成）');
H.ok(typeof r2.reason === 'string' && /还原/.test(r2.reason), '场景2 返回体说明「已用副本还原」', r2.reason);
H.ok(r2.restore && r2.restore.ok === true, '场景2 原树已从校验副本还原成功', r2.restore);
H.ok(H.seen(/restoring it from the verified copy/), '场景2 日志声明用副本还原原树', H.lastMatch(/restoring it from the verified copy/));
// 还原后原树必须与隔离副本逐项一致（半删状态不允许留下）
const liveFiles = countFiles(path.join(home2, 'profiles'));
H.eq(liveFiles, srcFilesBefore, `场景2 还原后原树文件数回到删除前（实际 ${liveFiles}）`);
H.ok(fs.existsSync(path.join(home2, 'profiles', 'web', 'node_modules', '@local', 'repo-push-access', 'index.js')), '场景2 被半删的依赖实体已补回');
H.ok(fs.lstatSync(srcLink).isSymbolicLink(), '场景2 junction 已补回为链接');
H.info(`场景2 源目录文件数=${srcFilesBefore} 删除结果=${JSON.stringify(r2.removal)} 还原=${JSON.stringify(r2.restore)}`);
H.ok(fs.existsSync(srcPkg), '场景2 被占用文件在原树中仍然存在（复制前绝不删）');

for (const h of holders) { try { h.kill(); } catch (e) { H.info(e.message); } }
holders.length = 0;

// ---------------------------------------------------------------------------
// 场景 3：复制也失败 → 放弃隔离，原目录原封不动
// ---------------------------------------------------------------------------
H.step('场景3 复制失败（人为制造读取失败）→ 放弃隔离、保留原目录');
const home3 = path.join(userData, 'home3');
buildProfiles(home3);
const webDir = path.join(home3, 'profiles', 'web');
const otherData = path.join(home3, 'profiles', 'other', 'data.bin');
const before = {
  webPkg: fs.readFileSync(path.join(webDir, 'package.json'), 'utf8'),
  otherDataSize: fs.statSync(otherData).size
};
H.denyReadAcl(webDir);          // 人为让复制在 web 子目录上读失败
aclRestores.push(webDir);       // 清理顺序：先释放占用、撤销 ACL，最后才删临时目录
holders.push(H.holdFileHandle(otherData, 90));   // 同时占用，保证 rename 也失败
const blocked3 = H.waitRenameBlocked(path.join(home3, 'profiles'));
H.ok(blocked3.blocked, '场景3 前置：rename 会失败', blocked3.code);

const r3 = mgr.quarantineProfiles(home3);
H.eq(r3.abandoned, true, '场景3 abandoned（放弃本轮隔离）');
H.eq(r3.quarantined, false, '场景3 quarantined=false（原目录没被移走）');
H.eq(r3.copied, false, '场景3 copied=false（复制未成功）');
H.ok(typeof r3.reason === 'string' && r3.reason.length > 0, '场景3 返回体带明确失败原因（上层看得见）', r3.reason);
H.ok(H.seen(/copy-based quarantine to .* failed/), '场景3 日志记录了复制失败根因', H.lastMatch(/copy-based quarantine .* failed/));
H.eq(listAll(home3, ANY_QUARANTINE).length, 0, '场景3 失败后不留下半成品隔离目录');
H.ok(fs.existsSync(path.join(webDir, 'package.json')), '场景3 原目录仍在');
H.eq(fs.readFileSync(path.join(webDir, 'package.json'), 'utf8'), before.webPkg, '场景3 原 package.json 内容未变');
H.eq(fs.statSync(otherData).size, before.otherDataSize, '场景3 其它 profile 数据未变');

for (const h of holders) { try { h.kill(); } catch (e) { H.info(e.message); } }
holders.length = 0;
H.allowReadAcl(webDir);
H.eq(listAll(home3, ANY_QUARANTINE).length, 0, '场景3 撤销 ACL 后仍无半成品目录');

// ---------------------------------------------------------------------------
// 场景 4：源码结构断言（证明「先复制校验、后删除」的顺序没被写反）
// ---------------------------------------------------------------------------
H.step('场景4 源码结构断言：复制校验在前、删除在后');
const src = fs.readFileSync(path.join(H.repoRoot, 'updater-backend.js'), 'utf8');
const iFallback = src.indexOf('copyRes = quarantineProfilesByCopy(');
const iDelete = src.indexOf('removal = removeOwnedDirectory(prof)');
H.ok(iFallback > 0, '场景4 兜底分支调用 quarantineProfilesByCopy', iFallback);
H.ok(iDelete > iFallback, '场景4 删除原树发生在复制校验之后', { iFallback, iDelete });
H.ok(!/falling back to rimraf/.test(src), '场景4 旧的 rimraf 兜底文案已消失');
const iRimrafProf = src.indexOf('rimraf(prof)');
H.ok(iRimrafProf === -1, '场景4 兜底分支不再直接 rimraf(profiles)', iRimrafProf);
H.ok(/QUARANTINE_NAME_RE = \/\^profiles\\\.broken-\\d/.test(src), '场景4 保留策略只认我方时间戳命名');

H.finish();
