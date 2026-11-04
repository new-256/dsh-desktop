'use strict';

/**
 * 0.3.40 启动卡顿修复测试：projection 迁移的幂等性/备份外置/跳过备份/保留上限/
 * 版本门控。全部用临时目录。
 *
 * 用法：node scripts/test-040.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// electron 桩：updater-backend 顶部 require('electron') 仅取 app（存在性防御）
const STUB_ID = '\0electron-stub';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-040-'));
require.cache[STUB_ID] = {
  id: STUB_ID, filename: STUB_ID, loaded: true,
  exports: { app: { getPath: () => path.join(TMP_ROOT, 'userData'), isPackaged: false, getVersion: () => '0.3.40-test' } }
};

const mgr = require('../updater-backend.js');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }

// P() 的 dshHome 落在 userData/dsh-home —— 造投影缓存目录
const p = mgr.P();
const projDir = path.join(p.dshHome, 'storages', 'session_projcache');
fs.mkdirSync(path.join(projDir, 'sessions'), { recursive: true });

function writeProj(name, withIdentity) {
  const obj = { rows: { title: { ver: 1 } } };
  if (withIdentity) obj.identity = { formatVersion: 4, isSeeded: false, inheritedEventCount: 0 };
  else obj.identity = { formatVersion: 3 }; // 旧格式：缺两个新字段
  fs.writeFileSync(path.join(projDir, 'sessions', name), JSON.stringify(obj, null, 2), 'utf8');
}

// ── 1. 迁移正确性与备份外置 ──────────────────────────────────────────────────
section('1. 迁移补字段 + 备份外置到 migration-backups/');
writeProj('a.json', false); // 缺字段 → 待迁移
writeProj('b.json', true);  // 已有字段 → 不动
const r1 = mgr.migrateProjectionCache();
ok(r1.changed === 1, '只迁移缺字段的 1 个文件');
ok(/migration-backups[\\/]session_projcache-/.test(String(r1.backup)), '备份在外置目录：' + String(r1.backup));
ok(!fs.existsSync(path.join(projDir, 'migration-backup-' + (r1.backup || '').split('-').pop())), 'dir 内不再有备份目录');
const a = JSON.parse(fs.readFileSync(path.join(projDir, 'sessions', 'a.json'), 'utf8'));
ok(a.identity.isSeeded === false && a.identity.inheritedEventCount === 0, '字段已补齐');
ok(fs.existsSync(path.join(String(r1.backup), 'sessions', 'a.json')), '备份文件内容存在（迁移前原样）');
ok(!fs.existsSync(path.join(String(r1.backup), 'sessions', 'b.json')), '未触碰的文件不进备份（只快照被改写的）');

// ── 2. 幂等：第二次跑零迁移 ──────────────────────────────────────────────────
section('2. 幂等性');
const r2 = mgr.migrateProjectionCache();
ok(r2.changed === 0, '第二次迁移 changed=0');
ok(r2.backup === null, '无事可做不产生备份目录');

// ── 3. 跳过备份目录（防自我复制的核心）──────────────────────────────────────
section('3. 收集器跳过备份目录');
// 造一个 dir 内的旧版遗留备份目录（用户机器上真实存在过的形态），里面放"缺字段"的文件
const legacy = path.join(projDir, 'migration-backup-20260901-000000');
fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'sessions', 'old.json'), JSON.stringify({ identity: { formatVersion: 2 } }), 'utf8');
const r3 = mgr.migrateProjectionCache();
ok(r3.changed === 0, '备份里的"缺字段"文件不触发迁移（旧版会全量重写再自我复制）');
const oldContent = JSON.parse(fs.readFileSync(path.join(legacy, 'sessions', 'old.json'), 'utf8'));
ok(oldContent.identity.isSeeded === undefined, '备份内容保持原样（就是备份的意义）');

// ── 4. 备份保留上限 3 份 ─────────────────────────────────────────────────────
section('4. 备份保留上限');
const backupRoot = path.join(path.dirname(projDir), 'migration-backups');
// 直接补 5 份历史备份目录，再触发一次真迁移看 prune
for (let i = 0; i < 5; i++) {
  fs.mkdirSync(path.join(backupRoot, `session_projcache-2026010${i + 1}-000000`), { recursive: true });
}
writeProj('c.json', false); // 触发一次新迁移
const r4 = mgr.migrateProjectionCache();
ok(r4.changed === 1, '触发迁移产生新备份');
const dirs = fs.readdirSync(backupRoot).filter((n) => n.startsWith('session_projcache-')).sort();
ok(dirs.length <= 4, `备份目录数 ${dirs.length} ≤ 上限3 + 新建的1（prune 已删旧的）`);
// 再跑一轮触发 prune 收敛到 3
writeProj('d.json', false);
mgr.migrateProjectionCache();
const dirs2 = fs.readdirSync(backupRoot).filter((n) => n.startsWith('session_projcache-')).sort();
ok(dirs2.length <= 3, `prune 后收敛 ≤ 3（实际 ${dirs2.length}）`);

// ── 5. 版本门控：ensureSeeded 不再每次跑迁移 ─────────────────────────────────
section('5. 版本门控（版本一致时跳过）');
// 本节在无 dsh 安装时只验证"不崩"；完整门控往返在第 6 节（造 dsh 后）测。
{
  const beforeDirs = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).filter((n) => n.startsWith('session_projcache-')).length : 0;
  mgr.ensureSeeded(); // 幂等：此时 a/e 等都已补齐字段，即使迁移跑了也是 0
  const afterDirs = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).filter((n) => n.startsWith('session_projcache-')).length : 0;
  ok(true, '无 dsh 安装时 ensureSeeded 正常完成（不崩）');
  // legacy 垃圾文件未被触碰
  ok(JSON.parse(fs.readFileSync(path.join(legacy, 'sessions', 'old.json'), 'utf8')).identity.isSeeded === undefined, '备份垃圾保持原样（不被迁移）');
}

// ── 6. 无门控时迁移仍可达（版本变化场景）───────────────────────────────────
section('6. 版本变化时迁移可达');
{
  // 造一个"版本变化"场景：versions.json 里的迁移标记与当前版本不符 → ensureSeeded 必须跑迁移。
  // tmp 环境没有 dsh 安装，currentVersions().dsh 为 null——迁移按"无版本即未知"处理，
  // 同样必须执行且标记为 null 也不写（下次装好后还会跑，正确）。这里手动放一个 dsh
  // package.json + bin 让 currentVersions() 有值，走完整的门控往返。
  fs.mkdirSync(path.dirname(p.dshPkg), { recursive: true });
  fs.mkdirSync(path.dirname(p.dshBin), { recursive: true });
  fs.writeFileSync(p.dshPkg, JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }), 'utf8');
  fs.writeFileSync(p.dshBin, '// stub\n', 'utf8');
  const curDsh = mgr.currentVersions().dsh;
  ok(curDsh === '9.9.9-test', 'currentVersions 拾取 dsh 版本（门控输入）');
  {
    // 标记与当前版本一致 → 跳过迁移
    const vj = path.join(p.root, 'versions.json');
    fs.mkdirSync(p.root, { recursive: true });
    const cur = JSON.parse(fs.readFileSync(vj, 'utf8'));
    cur.projectionMigratedForDsh = curDsh;
    fs.writeFileSync(vj, JSON.stringify(cur, null, 2));
    writeProj('e.json', false);
    const beforeDirs = fs.readdirSync(backupRoot).filter((n) => n.startsWith('session_projcache-')).length;
    mgr.ensureSeeded();
    const e = JSON.parse(fs.readFileSync(path.join(projDir, 'sessions', 'e.json'), 'utf8'));
    ok(e.identity.isSeeded === undefined, '标记匹配时 e.json 不被迁移（门控生效）');
    const afterDirs = fs.readdirSync(backupRoot).filter((n) => n.startsWith('session_projcache-')).length;
    ok(afterDirs === beforeDirs, '门控跳过时不产生备份目录');
  }
  {
    // 标记旧版本 → 迁移执行并写入新标记
    const vj = path.join(p.root, 'versions.json');
    const cur = JSON.parse(fs.readFileSync(vj, 'utf8'));
    cur.projectionMigratedForDsh = '0.0.0-old';
    fs.writeFileSync(vj, JSON.stringify(cur, null, 2));
    mgr.ensureSeeded();
    const e = JSON.parse(fs.readFileSync(path.join(projDir, 'sessions', 'e.json'), 'utf8'));
    ok(e.identity.isSeeded === false, '版本变化后 e.json 被迁移补字段');
    const cur2 = JSON.parse(fs.readFileSync(vj, 'utf8'));
    ok(cur2.projectionMigratedForDsh === '9.9.9-test', '迁移后写入新版本标记（下次启动跳过）');
  }
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
