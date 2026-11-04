'use strict';

/**
 * B-17 验证脚本：运行期下载包的完整性校验（四条路径全走真文件，不 mock 哈希）。
 *
 *   路径1 正常    ：内容与 registry 哈希一致 → 通过，并报告用了哪个算法/来源
 *   路径2 篡改    ：改 1 字节 → **拒绝**（不是"下载失败"，是"校验不匹配"）
 *   路径3 截断    ：短 1 字节 → 拒绝，且能区分"大小不符（截断）"与"摘要不匹配"
 *   路径4 缺元数据：integrity/shasum 都没有 → **明确告知无法校验**（绝不假装通过）；
 *                   DSH_REQUIRE_INTEGRITY=1 时改为拒绝安装
 *
 * 另外覆盖：SRI 多条目按"最强算法优先"选择（sha1 写在前面也不会被降级）、sha1 shasum 退路。
 *
 * 运行：node scripts/test-b17-integrity.js   （自带 120s 防卡死超时）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createHarness, installElectronStub } = require('./test-h04-h05-harness');

const H = createHarness({ name: 'B-17-integrity', timeoutMs: 120000 });
const base = path.join(os.tmpdir(), `dsh-b17-${process.pid}-${Date.now()}`);
const userData = path.join(base, 'userData');
fs.mkdirSync(userData, { recursive: true });
installElectronStub({ userData, desktop: path.join(base, 'desktop'), resourcesPath: path.join(base, 'emptyResources'), isPackaged: true });
H.startMonitor(path.join(H.repoRoot, '修复与借鉴_2026-11-04', '03_调试阶段'));
H.onCleanup(() => H.removeTree(base));

const mgr = require('../updater-backend.js');

// ---------------------------------------------------------------------------
function writeBytes(name, buf) {
  const file = path.join(base, name);
  fs.writeFileSync(file, buf);
  return file;
}
const sha512SRI = (buf) => `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
const sha1Hex = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 造一份"像安装包"的内容（不依赖网络；真实 tarball 也是一串字节）
const GOOD = Buffer.from('fake-dsh-tarball\0'.repeat(200) + 'END', 'utf8');

// ---------------------------------------------------------------------------
H.step('路径1 正常：sha512(SRI) 匹配 → 通过，报告算法与来源');
const f1 = writeBytes('good.tgz', GOOD);
const v1 = mgr.verifyFileIntegrity(f1, { integrity: sha512SRI(GOOD), shasum: sha1Hex(GOOD) });
H.eq(v1.ok, true, 'sha512 一致 → ok');
H.eq(v1.algo, 'sha512', '优先使用 sha512（而不是 shasum/sha1）');
H.eq(v1.from, 'dist.integrity', '校验来源标记为 dist.integrity');
H.eq(v1.size, GOOD.length, '回报文件字节数');
H.eq(mgr.integrityPolicy(v1).action, 'accept', '策略动作 = accept');

H.step('路径1b sha1(shasum) 退路 + 最强算法优先');
const v1b = mgr.verifyFileIntegrity(f1, { shasum: sha1Hex(GOOD) });
H.eq(v1b.ok, true, '只有 shasum 时退到 sha1 且校验通过');
H.eq(v1b.algo, 'sha1', '退回 sha1（来自 dist.shasum）');
H.eq(v1b.from, 'dist.shasum', '来源标记为 dist.shasum');
const multi = `sha1-${crypto.createHash('sha1').update(GOOD).digest('base64')} ${sha512SRI(GOOD)}`;
H.eq(mgr.parseSri(multi), { algo: 'sha512', digestBase64: sha512SRI(GOOD).slice('sha512-'.length) }, 'sha1 写在前面也选 sha512（不降级）');
const vMulti = mgr.verifyFileIntegrity(f1, { integrity: multi });
H.eq(vMulti.ok, true, '多条目 SRI 校验通过');

// ---------------------------------------------------------------------------
H.step('路径2 篡改：改 1 字节 → 拒绝（且归因是"校验不匹配"而不是"下载失败"）');
const TAMPERED = Buffer.from(GOOD);
TAMPERED[Math.floor(TAMPERED.length / 2)] ^= 0xff;      // 中间翻一个字节
const f2 = writeBytes('tampered.tgz', TAMPERED);
const v2 = mgr.verifyFileIntegrity(f2, { integrity: sha512SRI(GOOD) });
H.eq(v2.ok, false, '篡改 1 字节 → 校验失败');
H.eq(v2.missingMetadata, undefined, '不是"缺元数据"（元数据是齐的）');
H.ok(/校验不匹配/.test(String(v2.reason)), '失败原因明确写"校验不匹配"', v2.reason);
H.eq(v2.expected, sha512SRI(GOOD).slice('sha512-'.length), '给出期望摘要（便于事后核对）');
H.ok(v2.actual !== v2.expected, '实际摘要与期望不同', { expected: v2.expected.slice(0, 16), actual: v2.actual.slice(0, 16) });
const p2 = mgr.integrityPolicy(v2);
H.eq(p2.action, 'reject', '策略动作 = reject（拒绝安装）');
H.eq(p2.code, 'ERR_UPDATER_CHECKSUM_MISMATCH', '错误码进入 journal 白名单（对齐官方）');

// ---------------------------------------------------------------------------
H.step('路径3 截断：短 1 字节 → 拒绝；有 content-length 时先报"大小不符"');
const TRUNCATED = GOOD.subarray(0, GOOD.length - 1);
const f3 = writeBytes('truncated.tgz', TRUNCATED);
const v3a = mgr.verifyFileIntegrity(f3, { integrity: sha512SRI(GOOD) });
H.eq(v3a.ok, false, '截断后摘要不匹配 → 拒绝');
H.ok(/校验不匹配/.test(String(v3a.reason)), '无大小信息时按摘要不匹配归因', v3a.reason);
const v3b = mgr.verifyFileIntegrity(f3, { integrity: sha512SRI(GOOD) }, { expectedBytes: GOOD.length });
H.eq(v3b.ok, false, '带期望大小时同样拒绝');
H.eq(v3b.truncated, true, '能明确识别为"截断/大小不符"');
H.ok(/大小不符/.test(String(v3b.reason)), '失败原因写"大小不符（可能被截断）"', v3b.reason);
H.eq(mgr.integrityPolicy(v3b).code, 'ERR_UPDATER_CHECKSUM_MISMATCH', '截断同样归入校验不匹配错误码');

// ---------------------------------------------------------------------------
H.step('路径4 缺元数据：明确告知无法校验（绝不假装通过）');
const f4 = writeBytes('nometa.tgz', GOOD);
const v4 = mgr.verifyFileIntegrity(f4, {});
H.eq(v4.ok, false, '缺元数据时 ok=false（不是"通过"）');
H.eq(v4.missingMetadata, true, '显式标记 missingMetadata');
H.ok(/未提供 dist\.integrity/.test(String(v4.reason)), '失败原因说明缺什么', v4.reason);
const p4Default = mgr.integrityPolicy(v4, { requireHash: false });
H.eq(p4Default.action, 'accept-unverified', '默认策略：记账后继续（不把用户卡死）');
H.eq(p4Default.code, 'ERR_UPDATER_INTEGRITY_METADATA_MISSING', '缺元数据有专属错误码（可归因）');
const p4Strict = mgr.integrityPolicy(v4, { requireHash: true });
H.eq(p4Strict.action, 'reject', 'DSH_REQUIRE_INTEGRITY=1 → 拒绝安装');
H.eq(p4Strict.code, 'ERR_UPDATER_INTEGRITY_METADATA_MISSING', '严格模式下错误码一致');
H.eq(mgr.integrityPolicy({ ok: true }, { requireHash: true }).action, 'accept', '有哈希且一致时严格模式也放行');

// ---------------------------------------------------------------------------
H.step('补充：sha256 清单口径（Node 侧 verifyNodeZip 用同一把尺）');
const v5 = mgr.verifyFileIntegrity(f1, { integrity: `sha256-${crypto.createHash('sha256').update(GOOD).digest('base64')}` });
H.eq(v5.ok, true, 'sha256 SRI 也能校验');
H.eq(v5.algo, 'sha256', '识别为 sha256');
H.eq(mgr.digestFileSync(f1, 'sha256').hex, sha256Hex(GOOD), 'digestFileSync 与 crypto 直算一致');
H.eq(mgr.digestFileSync(f1, 'sha512').base64, sha512SRI(GOOD).slice('sha512-'.length), 'digestFileSync base64 口径正确');
let parseBad = null;
try { parseBad = mgr.parseSri('md5-abc'); } catch (e) { parseBad = 'threw:' + e.message; }
H.eq(parseBad, null, '不支持的算法解析为 null（不猜）');

H.step('补充：错误码确实落进 journal 白名单');
const codes = mgr.readUpdateJournal ? null : null;
H.ok(typeof mgr.journalAdd === 'function', 'journalAdd 可用');
const before = mgr.readUpdateJournal().entries.length;
mgr.journalAdd('dsh', 'failed', { to: '9.9.9', reason: 'ERR_UPDATER_CHECKSUM_MISMATCH sha512 校验不匹配：期望 aaa，实际 bbb' });
const after = mgr.readUpdateJournal().entries;
H.eq(after.length, before + 1, 'journal 新增 1 条');
H.eq(after[after.length - 1].reason, 'ERR_UPDATER_CHECKSUM_MISMATCH', 'journal 只落分类码（不落原文/URL）');
H.eq(after[after.length - 1].to, '9.9.9', 'journal 记录目标版本');

H.finish();
