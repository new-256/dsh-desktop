'use strict';

/**
 * dist-artifact-guard —— 出包产物的"防假成功"守卫（pre / post 两阶段）。
 *
 * 为什么需要：`release/` 里天然会留着上一版同名安装包（版本号不变时甚至同名）。
 * 一旦本次 `npm run dist` 中途失败（门禁红、pack-vendor 报错、electron-builder 签名/
 * 压缩失败），旧 exe 还在原地 —— 面板上看到的仍是"有这个文件"，diff 时间也可能被误读，
 * 于是"构建失败"被当成"构建成功"，把上一版甚至更早的产物当成这次的交付物发出去。
 *
 * 契约：
 *   pre   —— 先把目标安装包（及其 blockmap）移到 `release/_stale/<名字>.<时间戳>.bak`，
 *            并写下 `release/.dist-in-progress.json`（含开始时间/版本/期望文件名）。
 *            **只移动、不删除**：上一份有效产物仍可恢复。
 *   post  —— 校验目标安装包确实存在、体积合理、且 mtime 晚于 pre 时间戳，
 *            打印字节数与 SHA-256，然后清除标记。
 *            任何一条不满足 → exit 1（绝不让"看起来像新的旧文件"过门）。
 *
 * 附加纪律：若 pre 发现上一次的 in-progress 标记还在，说明上一轮 dist 中途失败过，
 * 会显式打印告警（不阻断），避免"屡次失败但以为成功"的沉默累积。
 *
 * 用法：node scripts/dist-artifact-guard.js pre|post
 * 退出码：0=OK；1=不满足契约；2=用法错误。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const STALE_DIR = path.join(RELEASE, '_stale');
const MARKER = path.join(RELEASE, '.dist-in-progress.json');
const MIN_PLAUSIBLE_BYTES = 100 * 1024 * 1024; // 本产品安装包长期在 230 MB 量级

function say(line = '') { console.log(line); }

function artifactNames(pkg) {
  const product = pkg.productName || pkg.name;
  const base = `${product} Setup ${pkg.version}.exe`;
  return { exe: base, blockmap: base + '.blockmap' };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pre() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const names = artifactNames(pkg);
  say('');
  say('══════════════════════════════════════════════════════════════════════════════');
  say('  出包前守卫（pre）：清走同版本旧产物，避免"失败却看起来像新的"');
  say(`  目标文件 : release\\${names.exe}`);
  say('══════════════════════════════════════════════════════════════════════════════');

  if (fs.existsSync(MARKER)) {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { /* 坏标记按无处理 */ }
    say('  ⚠ 发现上一次出包残留的 in-progress 标记 —— 上一次 dist 很可能中途失败过：');
    say(`      startedAt=${prev.startedAt || '?'} version=${prev.version || '?'} artifact=${prev.artifact || '?'}`);
    say('      本轮照常进行，但请确认上一轮的失败原因已解决。');
  }

  fs.mkdirSync(STALE_DIR, { recursive: true });
  const moved = [];
  for (const name of [names.exe, names.blockmap]) {
    const src = path.join(RELEASE, name);
    if (!fs.existsSync(src)) { say(`  · 不存在，无需挪走：${name}`); continue; }
    const dst = path.join(STALE_DIR, `${name}.${stamp()}.bak`);
    try {
      fs.renameSync(src, dst);
      moved.push({ from: name, to: path.relative(RELEASE, dst) });
      say(`  ✔ 已挪走旧产物：${name} → ${path.relative(RELEASE, dst)}`);
    } catch (err) {
      say(`  ✖ 挪走失败（${name}）：${err.message}`);
      process.exit(1);
    }
  }

  fs.writeFileSync(MARKER, JSON.stringify({
    startedAt: new Date().toISOString(), version: pkg.version,
    artifact: names.exe, movedFrom: moved.map((m) => m.from)
  }, null, 2) + '\n');
  say(`  ✔ 已写 in-progress 标记：${path.relative(ROOT, MARKER)}`);
  say('');
  process.exit(0);
}

function post() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const names = artifactNames(pkg);
  const target = path.join(RELEASE, names.exe);
  say('');
  say('══════════════════════════════════════════════════════════════════════════════');
  say('  出包后守卫（post）：确认产物确实是"本轮新生成"的');
  say('══════════════════════════════════════════════════════════════════════════════');

  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { /* 缺失即异常 */ }

  const problems = [];
  if (!fs.existsSync(target)) {
    problems.push(`目标安装包不存在：${target}（构建失败或未产出）`);
  } else {
    const st = fs.statSync(target);
    say(`  文件   : ${target}`);
    say(`  字节数 : ${st.size}`);
    if (st.size < MIN_PLAUSIBLE_BYTES) problems.push(`体积异常偏小：${st.size} 字节 < ${MIN_PLAUSIBLE_BYTES}`);
    if (marker && marker.startedAt) {
      const startedMs = Date.parse(marker.startedAt);
      if (Number.isFinite(startedMs) && st.mtimeMs < startedMs) {
        problems.push(`产物 mtime(${st.mtime.toISOString()}) 早于本轮开始时间(${marker.startedAt}) —— 这是旧文件，不是本轮产物`);
      }
    }
    if (marker && marker.version !== pkg.version) {
      problems.push(`in-progress 标记版本(${marker.version}) 与当前 package.json(${pkg.version}) 不一致`);
    }
    const h = sha256File(target);
    say(`  SHA-256: ${h}`);
    const blk = path.join(RELEASE, names.blockmap);
    if (fs.existsSync(blk)) say(`  blockmap: ${names.blockmap}（${fs.statSync(blk).size} 字节）`);
    else say('  ⚠ 未找到 blockmap（增量更新元数据缺失，静态更新源会受影响）');
  }

  if (problems.length) {
    say('');
    say(`  ✖ 出包后校验未通过（${problems.length} 项）：`);
    for (const p of problems) say('    - ' + p);
    // 标记留着：下一轮 pre 会据此提示"上次失败过"，不会静默。
    process.exit(1);
  }

  try { fs.unlinkSync(MARKER); } catch { /* 清理失败不影响结论 */ }
  say('  ✔ 产物存在、体积合理、且晚于本轮开始时间 —— 确认为本轮新生成。');
  say('');
  process.exit(0);
}

function main() {
  const mode = process.argv[2];
  if (mode === 'pre') pre();
  else if (mode === 'post') post();
  else { console.error('用法：node scripts/dist-artifact-guard.js pre|post'); process.exit(2); }
}

main();
