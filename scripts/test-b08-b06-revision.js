'use strict';

/**
 * B-08 + B-06 验证脚本：
 *
 *  B-06 更新确认绑定（revision + 内容摘要）
 *   - 切更新路线/换版本 → 代次自增，旧确认作废
 *   - 同版本被"上游重发"（内容摘要变了）→ 旧确认同样作废（这是"不绑最新、绑内容"的核心）
 *   - 过期确认在**网络请求之前**就被拒绝（用不可达 registry 证明"没有起网络"）
 *
 *  B-08 干净退出才应用 + 回滚台账
 *   - 后端仍在运行 / 仍有会话写入 → 阻止应用，dsh.new 原样保留，返回"正在收尾"提示
 *   - 副本兜底路径（rename 被占用）现在会产出 dsh.previous（H-01 的素材来源）
 *   - 回滚后 journal 把坏版本的 applied 改写成 rolled-back（防止"回滚回坏版本"）、
 *     versions.json 重写、H-05 中断标记清掉
 *
 * 运行：node scripts/test-b08-b06-revision.js   （自带 120s 防卡死超时）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHarness, installElectronStub } = require('./test-h04-h05-harness');

const H = createHarness({ name: 'B-08-B-06-revision', timeoutMs: 120000 });
const base = path.join(os.tmpdir(), `dsh-b0806-${process.pid}-${Date.now()}`);
fs.mkdirSync(base, { recursive: true });

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

const holders = [];
H.onCleanup(() => { for (const h of holders) { try { h.kill(); } catch (e) { H.info(e.message); } } });
H.onCleanup(() => H.removeTree(base));

function useUserData(name) {
  env.userData = path.join(base, name);
  fs.mkdirSync(env.userData, { recursive: true });
  return mgr.P();
}
function writeDeep(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function makeDshTree(dir, version) {
  writeDeep(dir, 'node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2));
  writeDeep(dir, 'node_modules/@deepseek-ai/dsh/lib/bin.js', `// dsh ${version}\n`);
  return dir;
}
function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}
const DIST_A = { tarball: 'https://registry.example/dsh-1.2.3.tgz', integrity: 'sha512-AAA', shasum: 'a'.repeat(40) };

async function run() {
  // =========================================================================
  H.step('B-06-1 代次：切路线自增，重复写同值不自增');
  H.eq(mgr.updateRevision(), 0, '初始 revision');
  mgr.writeSettings({ npmRegistry: 'default' });      // 从"未设置"→ default，值变了
  const r1 = mgr.updateRevision();
  H.ok(r1 >= 1, `切更新路线 → 代次自增（实际 ${r1}）`, r1);
  mgr.writeSettings({ npmRegistry: 'default' });      // 同值
  H.eq(mgr.updateRevision(), r1, '重复写入相同设置 → 代次不变（不做无意义作废）');
  mgr.writeSettings({ locale: 'zh-CN' });             // 非目标键
  H.eq(mgr.updateRevision(), r1, '写与目标无关的设置 → 代次不变');

  H.step('B-06-2 令牌绑定：版本 + 代次 + 内容摘要');
  const rec = await mgr.recordUpdateCandidate({ version: '1.2.3', source: 'test' }, DIST_A);
  H.eq(rec.version, '1.2.3', '快照版本');
  H.eq(rec.revision, mgr.updateRevision(), '快照代次 = 当前代次');
  H.ok(typeof rec.digest === 'string' && rec.digest.length === 64, '内容摘要为 sha256 十六进制', rec.digest && rec.digest.slice(0, 12));
  const token = mgr.issueUpdateConfirmation();
  H.eq({ revision: token.revision, version: token.version, digest: token.digest }, { revision: rec.revision, version: '1.2.3', digest: rec.digest }, '令牌内容来自快照');
  const ok1 = mgr.assertConfirmationFresh('1.2.3', token);
  H.eq({ ok: ok1.ok, stale: ok1.stale, unbound: ok1.unbound }, { ok: true, stale: false, unbound: false }, '新鲜令牌通过');
  H.eq(mgr.checkConfirmationDigest(token, DIST_A, '1.2.3').ok, true, '内容摘要一致 → 通过');

  H.step('B-06-3 上游重发同版本（内容变了）→ 旧确认作废');
  const DIST_A2 = { ...DIST_A, integrity: 'sha512-BBB' };
  const d2 = mgr.checkConfirmationDigest(token, DIST_A2, '1.2.3');
  H.eq(d2.ok, false, '内容摘要不一致 → 拒绝');
  H.ok(/上游重发/.test(String(d2.reason)), '文案指明"上游重发"这一真实原因', d2.reason);
  H.ok(mgr.candidateDigest('1.2.3', DIST_A) !== mgr.candidateDigest('1.2.3', DIST_A2), '摘要确实随内容变化');

  H.step('B-06-4 切渠道 → 旧确认作废（revision 变化）');
  mgr.bumpUpdateRevision('channel-switch-test');
  const stale = mgr.assertConfirmationFresh('1.2.3', token);
  H.eq({ ok: stale.ok, stale: stale.stale }, { ok: false, stale: true }, '代次变化后旧令牌作废');
  H.ok(/更新路线\/版本已变更/.test(String(stale.reason)), '文案说明代次变化', stale.reason);
  H.eq(mgr.issueUpdateConfirmation(), null, '代次变化后快照被清（旧令牌无法再被重新签发）');

  H.step('B-06-5 目标版本不一致 / 未携带令牌');
  const rec2 = await mgr.recordUpdateCandidate({ version: '1.2.3', source: 'test' }, DIST_A);
  const token2 = mgr.issueUpdateConfirmation();
  const mismatch = mgr.assertConfirmationFresh('9.9.9', token2);
  H.eq(mismatch.stale, true, '令牌版本 ≠ 本次目标 → 作废');
  H.ok(/目标已变更/.test(String(mismatch.reason)), '文案提示重新确认', mismatch.reason);
  const unbound = mgr.assertConfirmationFresh('1.2.3', null);
  H.eq({ ok: unbound.ok, unbound: unbound.unbound }, { ok: true, unbound: true }, '未携带令牌：标记 unbound（不假装校验过）');
  H.eq(mgr.checkConfirmationDigest(null, DIST_A, '1.2.3').unchecked, true, '摘要校验在无令牌时显式标 unchecked');

  // =========================================================================
  H.step('B-06-6 端到端：过期确认在网络请求之前被拒绝（registry 不可达也不影响判定）');
  const pBoot = useUserData('ud-confirm');
  void pBoot;
  const prevRegistry = process.env.DSH_NPM_REGISTRY;
  process.env.DSH_NPM_REGISTRY = 'https://127.0.0.1:1/registry';   // 任何网络请求都会立刻失败
  try {
    mgr.writeSettings({ npmRegistry: 'default' });                 // route=null → 走环境变量
    await mgr.recordUpdateCandidate({ version: '2.0.0', source: 'test' }, DIST_A);
    const staleToken = mgr.issueUpdateConfirmation();
    mgr.bumpUpdateRevision('switch-before-download');              // 用户在确认之后切了渠道
    const t0 = Date.now();
    let err = null;
    try { await mgr.stageDsh({}, null, { confirmation: staleToken }); } catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    H.ok(!!err, '过期确认被拒绝（抛错）', err && err.message);
    H.ok(/目标已变更/.test(String(err && err.message)), '错误文案指向"目标已变更，请重新确认"', err && err.message.split('\n')[0]);
    H.ok(!/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket|timeout/i.test(String(err && err.message)), '不是网络错误（说明没起网络请求）', err && err.message.split('\n')[0]);
    H.ok(elapsed < 2000, `拒绝在毫秒级完成（实际 ${elapsed}ms，未等网络超时）`, elapsed);
    const j = mgr.readUpdateJournal().entries.filter((e) => e.reason === 'ERR_UPDATER_CONFIRMATION_STALE');
    H.ok(j.length >= 1, 'journal 落 ERR_UPDATER_CONFIRMATION_STALE', j.length);
  } finally {
    if (prevRegistry === undefined) delete process.env.DSH_NPM_REGISTRY;
    else process.env.DSH_NPM_REGISTRY = prevRegistry;
  }

  // =========================================================================
  H.step('B-08-1 没有暂存内容 → 不探测、不阻拦（启动常态零开销）');
  const p0 = useUserData('ud-gate-empty');
  mgr.setApplyGate(() => { throw new Error('不该被调用'); });
  const noop = mgr.applyStaged();
  H.eq(noop, { dsh: null, node: null }, '无暂存时原样返回（不触发闸门探针）');
  H.eq(noop.blocked, undefined, '没有 blocked 字段');

  H.step('B-08-2 后端仍在运行 → 阻止应用并保留暂存');
  const p1 = useUserData('ud-gate-running');
  makeDshTree(p1.dshDir, '0.3.0');
  makeDshTree(p1.dshNew, '0.3.1');
  mgr.setApplyGate(() => ({ backendRunning: true, pendingWrites: 0 }));
  const blocked1 = mgr.applyStaged();
  H.eq(blocked1.blocked, true, '被阻止（blocked=true）');
  H.eq(blocked1.dsh, null, '没有应用任何 dsh 版本');
  H.ok(blocked1.gate && blocked1.gate.reasons.join(';').includes('后端进程仍在运行'), '原因写明"后端进程仍在运行"', blocked1.gate && blocked1.gate.reasons);
  H.ok(/正在收尾，稍后自动重试/.test(String(blocked1.retryHint)), '给出"正在收尾，稍后自动重试"提示', blocked1.retryHint);
  H.eq(readVersion(p1.dshDir), '0.3.0', '活跃版本未被改动');
  H.ok(fs.existsSync(path.join(p1.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')), 'dsh.new 原样保留（下次可重试）');
  const jb = mgr.readUpdateJournal().entries.filter((e) => e.reason === 'ERR_UPDATER_BACKEND_NOT_STOPPED');
  H.eq(jb.length, 1, 'journal 落 ERR_UPDATER_BACKEND_NOT_STOPPED');

  H.step('B-08-3 仍有会话写入未落盘 → 同样阻止');
  mgr.setApplyGate(() => ({ backendRunning: false, pendingWrites: 3 }));
  const blocked2 = mgr.applyStaged();
  H.eq(blocked2.blocked, true, '被阻止');
  H.ok(blocked2.gate.reasons.join(';').includes('3 项会话写入未落盘'), '原因写明未落盘的写入数量', blocked2.gate.reasons);

  H.step('B-08-4 探针干净时闸门放行（状态可判定）');
  mgr.setApplyGate(() => ({ backendRunning: false, pendingWrites: 0 }));
  const gateOk = mgr.applyGateStatus();
  H.eq(gateOk.clean, true, 'clean=true');
  H.eq(gateOk.reasons, [], '没有阻止原因');
  mgr.setApplyGate(null);
  const realGate = mgr.applyGateStatus();
  H.eq(typeof realGate.clean, 'boolean', '未注册探针时用自带进程探针，结果仍是可判定的布尔', realGate.clean);

  // =========================================================================
  H.step('B-08-5 副本兜底路径：rename 被占用时也要产出 dsh.previous');
  const p2 = useUserData('ud-copy-path');
  makeDshTree(p2.dshDir, '0.4.0');
  makeDshTree(p2.dshNew, '0.4.1');
  mgr.setApplyGate(() => ({ backendRunning: false, pendingWrites: 0 }));
  const lockTarget = path.join(p2.dshNew, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  holders.push(H.holdFileHandle(lockTarget, 90));
  const blockedProbe = H.waitRenameBlocked(p2.dshNew);
  H.ok(blockedProbe.blocked, '前置：dsh.new 已被占用（rename 会失败）', blockedProbe.code);

  const appliedCopy = mgr.applyStaged();
  H.eq(appliedCopy.dsh, '0.4.1', '副本兜底把新版本装上了');
  H.eq(readVersion(p2.dshDir), '0.4.1', '活跃 dsh 是新版本');
  H.eq(readVersion(p2.dshPrevious), '0.4.0', '★ dsh.previous 已产出旧版本（H-01 回滚素材）');
  H.ok(!fs.existsSync(path.join(p2.root, 'dsh.old')), '没有残留 dsh.old');
  H.ok(!fs.existsSync(path.join(p2.root, 'dsh.copy')), '没有残留 dsh.copy');
  // 占用在 dsh.new 内部时连 rename dsh.new 都 EPERM（实测），所以必须靠**外部标记**作废它：
  // 否则下次启动会拿一棵缺文件的暂存树再交换一次，把好树换坏。
  const invalidMarker = path.join(p2.root, 'dsh.new.invalid.json');
  H.ok(fs.existsSync(invalidMarker), '删不净的暂存树已被标记为不可应用（dsh.new.invalid.json）');
  H.eq(mgr.stagedVersions().dsh, null, 'stagedVersions 不再报告这个坏暂存版本');
  H.eq(mgr.stagedVersions().dshInvalidated, true, 'stagedVersions 显式标记 dshInvalidated');
  const secondApply = mgr.applyStaged();   // 再次调用：模拟"下次启动"
  H.eq(secondApply.dsh, null, '★ 再次应用不会拿坏暂存去交换（dsh 保持 0.4.1）');
  H.eq(readVersion(p2.dshDir), '0.4.1', '活跃版本未被二次交换破坏');
  H.eq(readVersion(p2.dshPrevious), '0.4.0', '回滚素材没有被二次交换覆盖');
  for (const h of holders) { try { h.kill(); } catch (e) { H.info(e.message); } }
  holders.length = 0;

  // =========================================================================
  H.step('B-08-6 回滚台账：applied → rolled-back，versions.json 重写，中断标记清掉');
  const p3 = useUserData('ud-rollback');
  makeDshTree(p3.dshDir, '0.5.0');            // 当前（坏）版本
  makeDshTree(p3.dshPrevious, '0.4.9');       // 可回滚目标
  mgr.writeJson(p3.versionsJson, { dsh: '0.5.0' });
  mgr.journalAdd('dsh', 'applied', { from: '0.4.9', to: '0.5.0' });
  H.eq(mgr.journalUnverified().length, 1, '前置：journal 有 1 条 applied（坏版本未验证）');
  mgr.beginApplyInProgress({ step: 'dsh-hidden', from: '0.4.9', to: '0.5.0' });
  H.ok(!!mgr.readApplyInProgress(), '前置：存在 H-05 中断标记');

  const rb = mgr.rollbackDsh();
  H.eq(rb, true, '回滚执行成功（返回 true，main.js 契约不变）');
  H.eq(readVersion(p3.dshDir), '0.4.9', '活跃版本已回到 dsh.previous');
  H.ok(!fs.existsSync(p3.dshPrevious), 'dsh.previous 已被消费（不存在二次回滚素材）');
  H.eq(mgr.readJson(p3.versionsJson, {}).dsh, '0.4.9', 'versions.json 已按新树重写');
  H.eq(mgr.journalUnverified().length, 0, '★ 坏版本的 applied 不再算"未验证"（防止回滚回坏版本）');
  const entries = mgr.readUpdateJournal().entries.filter((e) => e.kind === 'dsh');
  const rolledBack = entries.filter((e) => e.state === 'rolled-back');
  H.ok(rolledBack.length >= 2, 'journal 里既有被改写的记录也有一条 rolled-back 结论', rolledBack.map((e) => `${e.from}→${e.to}`));
  H.eq(rolledBack.some((e) => e.from === '0.5.0' && e.to === '0.4.9'), true, '回滚记录写明 0.5.0 → 0.4.9');
  H.eq(mgr.readApplyInProgress(), null, 'H-05 中断标记已清除（回滚是最终处置）');
  H.eq(mgr.detectInterruptedApply().active, false, '回滚后不再报"更新被中断"');

  H.step('B-08-7 没有可回滚目标时如实拒绝');
  const p4 = useUserData('ud-rollback-none');
  makeDshTree(p4.dshDir, '0.6.0');
  H.eq(mgr.rollbackDsh(), false, 'dsh.previous 缺失 → 返回 false（不假装成功）');
  H.eq(readVersion(p4.dshDir), '0.6.0', '活跃版本原样保留');

  H.finish();
}

run().catch((e) => {
  console.error('脚本异常：', e && e.stack ? e.stack : e);
  process.exitCode = 2;
  H.finish();
});
