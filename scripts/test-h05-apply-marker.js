'use strict';

/**
 * H-05 验证脚本：`applyStaged()` 交换目录前后必须有「进行中」标记，
 * 断电/强杀后不得静默回退出厂后端版本。
 *
 * 验证点（对照隐患清单 H-05 的三条要求）：
 *   场景1 正常路径：交换前标记确实已落盘（在 `dsh.new → dsh` 的 rename 瞬间抓取内容，
 *         断言含目标版本 / 开始时间 / 步骤名），交换并校验成功后标记被清除
 *   场景2 标记写不进去：**不交换**（dsh/dsh.new 不动），journal 落
 *         ERR_UPDATER_APPLY_MARKER_FAILED —— 证明「标记先于不可逆动作」
 *   场景3 断电模拟：残留标记 + dsh 缺失 + dsh.old 存在 → 启动早期（ensureSeeded）
 *         检测到并写诊断日志 + journal，暴露可判定的故障态与恢复动作，**不自动恢复**
 *   场景4 源码结构断言 + 成功后不误报
 *
 * 运行：node scripts/test-h05-apply-marker.js   （自带 120s 防卡死超时）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHarness, installElectronStub } = require('./test-h04-h05-harness');

const H = createHarness({ name: 'H-05-apply-marker', timeoutMs: 120000 });
const base = path.join(os.tmpdir(), `dsh-h05-${process.pid}-${Date.now()}`);
fs.mkdirSync(base, { recursive: true });

// userData 可切换：每个场景一套干净的 backend/ 目录
const env = {
  userData: path.join(base, 'ud-boot'),
  desktop: path.join(base, 'desktop'),
  resourcesPath: path.join(base, 'emptyResources'),
  isPackaged: true
};
installElectronStub({
  get userData() { return env.userData; },
  get desktop() { return env.desktop; },
  get resourcesPath() { return env.resourcesPath; },
  get isPackaged() { return env.isPackaged; }
});
H.startMonitor(path.join(H.repoRoot, '修复与借鉴_2026-11-04', '03_调试阶段'));

const mgr = require('../updater-backend.js');
H.onCleanup(() => H.removeTree(base));

// ---------------------------------------------------------------------------
function writeDeep(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** 造一棵最小可用后端树（bin.js + package.json）。 */
function makeDshTree(dir, version) {
  writeDeep(dir, 'node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2));
  writeDeep(dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js', `// dsh ${version}\n`);
  writeDeep(dir, 'node_modules/@deepseek-ai/dsh/lib/deps.js', `module.exports = ${JSON.stringify(version)};\n`);
  return dir;
}

function readVersion(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return m.version || null;
  } catch { return null; }
}

function useUserData(name) {
  env.userData = path.join(base, name);
  fs.mkdirSync(env.userData, { recursive: true });
  return mgr.P();
}

// ---------------------------------------------------------------------------
// 场景 1：正常路径 —— 交换前标记已落盘且字段完整，交换校验后清除
// ---------------------------------------------------------------------------
H.step('场景1 正常路径：交换前落标记（含目标版本/开始时间/步骤名）→ 成功后清除');
const p1 = useUserData('ud1');
makeDshTree(p1.dshDir, '0.2.1-alpha.5');
makeDshTree(p1.dshNew, '0.2.2-alpha.1');
mgr.writeJson(p1.versionsJson, { dsh: '0.2.1-alpha.5' });

// 在 `dsh.new → dsh` 这个 rename 的瞬间抓取标记内容 = 交换窗口 A 内的真实现场
const markerFile = mgr.applyInProgressPath();
let capturedAtSwap = 'NOT-CAPTURED';
const realRename = fs.renameSync;
fs.renameSync = function patchedRename(from, to) {
  if (capturedAtSwap === 'NOT-CAPTURED' && /dsh\.new$/.test(String(from))) {
    capturedAtSwap = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')) : 'MISSING';
  }
  return realRename.apply(fs, arguments);
};
let res1;
try {
  res1 = mgr.applyStaged();
} finally {
  fs.renameSync = realRename;
}

H.ok(capturedAtSwap !== 'NOT-CAPTURED' && capturedAtSwap !== 'MISSING', '场景1 交换瞬间标记文件确实存在', capturedAtSwap);
if (capturedAtSwap && capturedAtSwap !== 'MISSING' && capturedAtSwap !== 'NOT-CAPTURED') {
  H.eq(capturedAtSwap.to, '0.2.2-alpha.1', '场景1 标记含目标版本');
  H.eq(capturedAtSwap.from, '0.2.1-alpha.5', '场景1 标记含来源版本');
  H.eq(capturedAtSwap.step, 'dsh-hidden', '场景1 标记含步骤名（窗口A：dsh 暂时不在原位）');
  H.ok(typeof capturedAtSwap.startedAt === 'string' && /\d{4}-\d{2}-\d{2}T/.test(capturedAtSwap.startedAt), '场景1 标记含开始时间', capturedAtSwap.startedAt);
  H.ok(typeof capturedAtSwap.operationId === 'string' && capturedAtSwap.operationId.length > 0, '场景1 标记含本次操作 id（清理可精确到次）');
}
H.eq(res1.dsh, '0.2.2-alpha.1', '场景1 applied.dsh 为新版本');
H.eq(readVersion(p1.dshDir), '0.2.2-alpha.1', '场景1 dsh 已是新版本');
H.eq(readVersion(p1.dshPrevious), '0.2.1-alpha.5', '场景1 旧版本已进 dsh.previous（回滚素材）');
H.ok(!fs.existsSync(markerFile), '场景1 校验通过后标记已清除');
H.eq(mgr.readApplyInProgress(), null, '场景1 标记读取为 null');
const j1 = mgr.readUpdateJournal().entries.filter((e) => e.kind === 'dsh');
H.eq(j1.length, 1, '场景1 journal 只有 1 条 dsh 记录');
H.eq(j1[0] && j1[0].state, 'applied', '场景1 journal 状态 applied');
H.eq(j1[0] && j1[0].to, '0.2.2-alpha.1', '场景1 journal 目标版本正确');
H.eq(mgr.detectInterruptedApply().active, false, '场景1 成功后不误报「更新被中断」');

// ---------------------------------------------------------------------------
// 场景 2：标记写不进去 → 取消交换（证明标记先于不可逆动作）
// ---------------------------------------------------------------------------
H.step('场景2 标记写不进去 → 取消本次交换，dsh/dsh.new 原样保留');
const p2 = useUserData('ud2');
makeDshTree(p2.dshDir, '0.3.0');
makeDshTree(p2.dshNew, '0.3.1');
fs.mkdirSync(mgr.applyInProgressPath());   // 目录占位 → writeJson 的原子 rename 必然失败
const res2 = mgr.applyStaged();
H.eq(res2.dsh, null, '场景2 未执行交换（applied.dsh 为 null）');
H.eq(readVersion(p2.dshDir), '0.3.0', '场景2 dsh 仍是旧版本');
H.ok(fs.existsSync(path.join(p2.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), '场景2 dsh.new 原样保留（下次启动重试）');
H.ok(!fs.existsSync(p2.dshPrevious), '场景2 没有产生 dsh.previous（交换确实没发生）');
H.ok(H.seen(/写入更新中断标记失败，取消本次 dsh 交换/), '场景2 日志明确说明取消交换的原因', H.lastMatch(/写入更新中断标记失败/));
const j2 = mgr.readUpdateJournal().entries.filter((e) => e.reason === 'ERR_UPDATER_APPLY_MARKER_FAILED');
H.eq(j2.length, 1, '场景2 journal 落 ERR_UPDATER_APPLY_MARKER_FAILED（不静默）');

// ---------------------------------------------------------------------------
// 场景 3：断电模拟（残留标记 + dsh 缺失 + dsh.old 在位）+ 启动早期检测
// ---------------------------------------------------------------------------
H.step('场景3 断电模拟：残留标记 → ensureSeeded 早期检测、暴露故障态、不自动恢复');
const p3 = useUserData('ud3');
makeDshTree(path.join(p3.root, 'dsh.old'), '0.4.0');
makeDshTree(p3.dshPrevious, '0.3.9');
fs.mkdirSync(p3.dshHome, { recursive: true });
// 窗口 A 断电后的真实现场：dsh 不在、dsh.new 已被消费、标记还在
const begun = mgr.beginApplyInProgress({ step: 'dsh-hidden', from: '0.3.9', to: '0.4.0' });
H.ok(typeof begun.operationId === 'string', '场景3 前置：标记已写入', begun.operationId);
H.ok(!fs.existsSync(p3.dshBin), '场景3 前置：dsh 缺失（正是 H-05 的断电现场）');

mgr.ensureSeeded();   // 真实调用启动第一步：seed 决定之前必须先检测
const st = mgr.interruptedApplyState();
H.eq(st.active, true, '场景3 ensureSeeded 早期检测到残留标记');
H.eq(st.step, 'dsh-hidden', '场景3 暴露步骤名');
H.eq(st.target, '0.4.0', '场景3 暴露目标版本');
H.ok(typeof st.startedAt === 'string' && st.startedAt.length > 0, '场景3 暴露开始时间', st.startedAt);
H.eq(st.live, null, '场景3 暴露当前 dsh 缺失');
H.eq(st.old && st.old.version, '0.4.0', '场景3 暴露 dsh.old 版本');
H.eq(st.previous && st.previous.version, '0.3.9', '场景3 暴露 dsh.previous 版本');
H.eq(st.recovery, 'restore-from-dsh.old', '场景3 给出恢复动作（用 dsh.old 兜底）');
H.ok(fs.existsSync(path.join(p3.root, 'dsh.old')), '场景3 未自动执行恢复：dsh.old 仍在');
H.ok(!fs.existsSync(p3.dshBin), '场景3 未自动执行恢复：dsh 仍缺失（决策权留给启动链）');
H.ok(H.seen(/检测到残留的更新中断标记/), '场景3 诊断日志记录了中断现场', H.lastMatch(/检测到残留的更新中断标记/));

const j3a = mgr.readUpdateJournal().entries.filter((e) => e.reason === 'ERR_UPDATER_APPLY_INTERRUPTED');
H.eq(j3a.length, 1, '场景3 journal 落 ERR_UPDATER_APPLY_INTERRUPTED');
const totalBefore = mgr.readUpdateJournal().entries.length;
const stAgain = mgr.detectInterruptedApply();
H.eq(stAgain.active, true, '场景3 再次检测仍为中断态');
H.eq(mgr.readUpdateJournal().entries.length, totalBefore, '场景3 同一标记不重复写 journal（不刷屏）');

// 主进程确认处理后清除 → 不再报中断
H.eq(mgr.clearApplyInProgress(), true, '场景3 主进程确认后清除标记');
H.eq(mgr.readApplyInProgress(), null, '场景3 标记文件已删除');
H.eq(mgr.detectInterruptedApply().active, false, '场景3 清除后不再报中断');

// ---------------------------------------------------------------------------
// 场景 3b：标记文件被写坏（无法解析）不得当成「没有中断」
// ---------------------------------------------------------------------------
H.step('场景3b 标记文件损坏（不可解析）→ 仍按中断处理，不静默');
const p3b = useUserData('ud3b');
makeDshTree(p3b.dshDir, '0.5.0');
fs.writeFileSync(mgr.applyInProgressPath(), '{"schemaVersion":1,"step":"dsh-sw', 'utf8');   // 半截 JSON
const st3b = mgr.detectInterruptedApply();
H.eq(st3b.active, true, '场景3b 损坏的标记仍判为中断态');
H.eq(st3b.unreadable, true, '场景3b 显式标记 unreadable');
H.eq(st3b.step, 'unreadable-marker', '场景3b 步骤名如实标注');
H.eq(st3b.recovery, 'apply-maybe-completed', '场景3b 仍给出恢复动作（dsh 在位）');
H.ok(H.seen(/标记文件内容无法解析/), '场景3b 诊断日志明确说明无法解析', H.lastMatch(/无法解析/));
H.eq(mgr.clearApplyInProgress(), true, '场景3b 损坏标记也能被确认清除');
H.eq(mgr.detectInterruptedApply().active, false, '场景3b 清除后不再报中断');

// ---------------------------------------------------------------------------
// 场景 4：源码结构断言（顺序不能再被写反）
// ---------------------------------------------------------------------------
H.step('场景4 源码结构断言：标记 → 交换 → 校验 → 清标记');
const src = fs.readFileSync(path.join(H.repoRoot, 'updater-backend.js'), 'utf8');
H.ok(/const res = applyStagedDshSwap\(p\);/.test(src), '场景4 applyStaged 把 dsh 交换交给独立函数');
const iBegin = src.indexOf('marker = beginApplyInProgress({ step: \'dsh-swap\'');
const iSwap = src.indexOf('const direct = swapDshDirectories(p);');
const iVerify = src.indexOf('const verified = verifyAppliedDsh(staged);');
const iClear = src.indexOf('clearApplyInProgress(marker.operationId)');
H.ok(iBegin > 0, '场景4 找到标记写入点', iBegin);
H.ok(iSwap > iBegin, '场景4 交换发生在标记写入之后', { iBegin, iSwap });
H.ok(iVerify > iSwap, '场景4 校验发生在交换之后', { iSwap, iVerify });
H.ok(iClear > iVerify, '场景4 清标记发生在校验之后', { iVerify, iClear });
const seedStart = src.indexOf('function ensureSeeded()');
const seedBody = src.slice(seedStart, seedStart + 1600);
H.ok(/interruptedApplyCache = detectInterruptedApply\(\);/.test(seedBody), '场景4 ensureSeeded 在 seed 决定之前调用检测');
H.ok(seedBody.indexOf('detectInterruptedApply') < seedBody.indexOf('mkdirp(p.root)'), '场景4 检测发生在创建/写入活跃目录之前（真实时序）');
H.ok(!/'applying'/.test(src), '场景4 没有另起一套 journal 状态（标记文件即信封，journal 仍是唯一台账）');

H.finish();
