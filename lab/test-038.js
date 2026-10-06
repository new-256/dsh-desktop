'use strict';

/**
 * 0.3.38 新功能测试：更新 journal（三态+上限）、版本耦合软闸门、Python 检测。
 * 复用 test-manifest-verify 的 electron 桩：P().root 落在系统临时目录，不碰真实
 * 用户数据；测完清理。
 *
 * 用法：node scripts/test-038.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const STUB_ID = '\0electron-stub';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return STUB_ID;
  return origResolve.call(this, request, ...rest);
};
require.cache[STUB_ID] = {
  id: STUB_ID,
  filename: STUB_ID,
  loaded: true,
  exports: { app: { isPackaged: false, getPath: () => os.tmpdir(), getVersion: () => '0.3.38' } }
};

const mgr = require('../updater-backend.js');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }

// 固定一个隔离的 P().root，测完整目录删除。
const p = mgr.P();
try { fs.rmSync(p.root, { recursive: true, force: true }); } catch {}
fs.mkdirSync(p.root, { recursive: true });

// ── 1. UPDATE JOURNAL ──────────────────────────────────────────────────────
section('1. update journal：三态流转');
mgr.journalAdd('dsh', 'staged', { from: '0.1.6', to: '0.1.7' });
mgr.journalAdd('dsh', 'applied', { to: '0.1.7' });
let j = mgr.readUpdateJournal();
ok(j.entries.length === 2, '追加 2 条');
ok(j.entries[0].state === 'staged' && j.entries[1].state === 'applied', '状态正确');
ok(mgr.journalUnverified().length === 1, '未验证集合含 applied 1 条');

const n = mgr.journalMarkVerified();
ok(n === 1, 'applied → verified 推进 1 条（staged 不动）');
j = mgr.readUpdateJournal();
ok(j.entries[0].state === 'staged' && j.entries[1].state === 'verified', '推进后状态正确');
ok(mgr.journalUnverified().length === 0, '未验证集合清空');
ok(mgr.journalMarkVerified() === 0, '再次推进为 0（幂等）');

section('1b. journal 失败条目与上限 30');
mgr.journalAdd('node', 'failed', { reason: 'boom' });
j = mgr.readUpdateJournal();
ok(j.entries[2].state === 'failed' && /UNCLASSIFIED: boom/.test(j.entries[2].reason), 'failed 条目记录原因（0.3.39 起带错误码前缀）');
for (let i = 0; i < 40; i++) mgr.journalAdd('node', 'staged', { to: '1.0.' + i });
j = mgr.readUpdateJournal();
ok(j.entries.length === 30, '条目上限 30（追加 43 条后截断）');

// ── 2. 版本耦合软闸门 ──────────────────────────────────────────────────────
section('2. 版本耦合软闸门');
// P().dshPkg 在临时 root 下不存在 → dsh=null → 未验证
let gate = mgr.comboGateCheck('0.3.38');
ok(gate.validated === false, '无 dsh 时未验证');
ok(gate.shouldPrompt === true, '首次应提示');
ok(gate.combo === '0.3.38__none', '组合指纹正确');

// 放一个已验证版本的 dsh（package.json + bin.js，currentVersions 两者都查）
const dshPkgDir = path.dirname(p.dshPkg);
fs.mkdirSync(dshPkgDir, { recursive: true });
const putDsh = (ver) => {
  fs.writeFileSync(p.dshPkg, JSON.stringify({ name: '@deepseek-ai/dsh', version: ver }));
  fs.mkdirSync(path.dirname(p.dshBin), { recursive: true });
  fs.writeFileSync(p.dshBin, '// dsh bin');
};
putDsh('0.1.7-alpha.2');
gate = mgr.comboGateCheck('0.3.38');
ok(gate.validated === true && gate.shouldPrompt === false, '已验证版本（0.1.7-alpha.2）直接放行');

// 未验证版本
putDsh('9.9.9');
gate = mgr.comboGateCheck('0.3.38');
ok(gate.validated === false && gate.combo === '0.3.38__9.9.9', '未知版本未验证，指纹含版本');
mgr.dismissComboPrompt(gate.combo);
gate = mgr.comboGateCheck('0.3.38');
ok(gate.shouldPrompt === false, '用户「不再提醒」后不再提示该组合');

// ── 3. PYTHON 检测（本机真实环境）──────────────────────────────────────────
section('3. Python 检测（隔离环境 + 本机）');
const info = mgr.detectPythonRuntime();
ok(info && typeof info.available === 'boolean', '返回结构完整');
if (info.available) {
  ok(/^\d+\.\d+\.\d+$/.test(info.version), '版本可解析：' + info.version);
  ok(Array.isArray(info.authoring) && info.authoring.length === 6, '6 个编写库探测');
  ok(info.meetsMinimum === true, 'Python 满足 3.9+');
  console.log('     编写库：' + info.authoring.map((a) => a.name + (a.ok ? '✓' : '✗')).join(' '));
} else {
  ok(/找不到 python|失败/.test(info.reason), '无 Python 时给出原因：' + info.reason);
}

// pythonBootCheck 的状态写回（good 路径）
const bc = mgr.pythonBootCheck();
ok(bc && (bc.shouldPrompt === true || bc.shouldPrompt === false), 'boot 检查返回');

// ── 收尾 ───────────────────────────────────────────────────────────────────
try { fs.rmSync(p.root, { recursive: true, force: true }); } catch {}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
