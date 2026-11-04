'use strict';
// 只读验证：对用户真实存在的 junction 做"干跑"，确认安全实现不会碰目标
// 用法: node scripts/verify-043-real.js   (会派发到 Electron)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.versions.electron) {
  const bin = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(bin)) { console.log('需要 Electron'); process.exit(2); }
  const r = spawnSync(bin, [__filename], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

const HOME = path.join(process.env.APPDATA, 'DSH Desktop', 'dsh-home');
console.log('真实环境检查（只读，不删除任何东西）');
console.log('  dsh-home: ' + HOME);

if (!fs.existsSync(HOME)) { console.log('  未找到 dsh-home，跳过'); process.exit(0); }

// 1) 枚举真实 junction（绝不进入目标）
const links = [];
function walk(d, depth) {
  if (depth > 7) return;
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(d, e.name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) {
      let t = '';
      try { t = fs.readlinkSync(full); } catch {}
      links.push({ link: full, target: t });
      continue; // 关键：不进入目标
    }
    if (st.isDirectory()) walk(full, depth + 1);
  }
}
walk(HOME, 0);

console.log('\n  发现的 junction: ' + links.length + ' 个');
for (const l of links) {
  const tgt = l.target.replace(/\\\\\?\\/g, '');
  const exists = fs.existsSync(tgt);
  let files = 0, hasGit = false;
  if (exists) {
    try { files = fs.readdirSync(tgt, { recursive: true }).length; } catch {}
    hasGit = fs.existsSync(path.join(tgt, '.git'));
  }
  console.log('    ' + l.link.replace(HOME, '') );
  console.log('        → ' + tgt);
  console.log('        目标存在=' + exists + '  条目数=' + files + '  git仓库=' + hasGit);
}

// 2) 判定：这些目标是否处于"会被我们删除的目录树"之内
console.log('\n  影响面判定:');
const profilesDir = path.join(HOME, 'profiles');
const inProfiles = links.filter((l) => l.link.toLowerCase().startsWith(profilesDir.toLowerCase()));
console.log('    位于 profiles 树内的 junction: ' + inProfiles.length + ' 个');
if (inProfiles.length) {
  console.log('    → 这些目标会在「profile 隔离」「junction 修复」等删除路径的范围内。');
  console.log('    → 0.3.42 及以前：一旦 rimraf 落到 fs.rmSync(recursive) 降级路径，');
  console.log('      在 Electron 下会删掉目标内容（已实测复现）。');
  console.log('    → 0.3.43：安全实现只摘链接本身，目标内容保留。');
  const atRisk = inProfiles.filter((l) => fs.existsSync(l.target.replace(/\\\\\?\\/g, '')));
  console.log('    当前真实受保护的目标: ' + atRisk.length + ' 个');
}

// 3) 用真实 junction 父目录做干跑（复制一份结构到临时区，避免动真数据）
console.log('\n  干跑验证（在临时区复刻同样的链接结构，不动真实数据）:');
const Module = require('module');
const orig = Module._resolveFilename;
const ID = '\0electron-stub';
const TMP = path.join(os.tmpdir(), 'dsh-verify-043');
Module._resolveFilename = function (r, ...a) { if (r === 'electron') return ID; return orig.call(this, r, ...a); };
require.cache[ID] = { id: ID, filename: ID, loaded: true, exports: { app: { getPath: () => TMP, isPackaged: false, getVersion: () => 't' } } };
const mgr = require('../updater-backend.js');

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'owned', 'node_modules'), { recursive: true });
const userDir = path.join(TMP, 'user-plugin');
fs.mkdirSync(path.join(userDir, '.git'), { recursive: true });
fs.writeFileSync(path.join(userDir, 'real-work.js'), 'IRREPLACEABLE');
fs.writeFileSync(path.join(userDir, '.git', 'HEAD'), 'x');
fs.symlinkSync(userDir, path.join(TMP, 'owned', 'node_modules', 'plugin-link'), 'junction');

const r = mgr.removeOwnedDirectory(path.join(TMP, 'owned'));
const intact = fs.existsSync(path.join(userDir, 'real-work.js')) && fs.existsSync(path.join(userDir, '.git', 'HEAD'));
console.log('    结果: removed=' + r.removed + '  摘除链接=' + r.linksUnlinked);
console.log('    ★ 链接目标完好: ' + intact + (intact ? '  ✓ 源码受保护' : '  ✗ 源码被删！'));
fs.rmSync(TMP, { recursive: true, force: true });
