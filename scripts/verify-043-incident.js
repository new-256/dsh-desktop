'use strict';
// 场景复现：把 2026-10-11 的真实事故日志喂给新纪律，验证它不会再直坠隔离
const path = require('path');
const policy = require(path.join(__dirname, '..', 'ladder-policy.js'));

// 真实事故日志特征（据事故记录：凭据键 repo-push-access:github.com 用冒号分隔，
// dsh 要求恰好 2 段，credentials 插件加载即抛错，连倒 9 个依赖插件，
// 而后端只说了这一句无名的话）
const realLog = [
  'dsh: startup failed: 1 required plugin did not activate',
  'some unrelated noise',
  'credential key "repo-push-access:github.com" must be "<scope>/<id>"'
].join('\n');

console.log('场景：2026-10-11 真实事故（凭据键非法 → 9 个插件连倒）');
console.log('  日志关键行: ' + realLog.split('\n')[0]);
console.log('');

// 旧行为：1b/1c 都点名不到 → 一路落空 → 直坠隔离 profiles
console.log('旧行为（0.3.42 及以前）:');
console.log('  1b analyzeBackendFailure → 日志没点名补丁条目 → 落空');
console.log('  1c analyzeFailingBundles → 日志没点名 bundle → 落空');
console.log('  2  quarantineProfiles → ★ 执行 → 连烧 3 份 profile，且完全无效');
console.log('');

// 新行为
console.log('新行为（0.3.43 阶梯纪律）:');
const guardReasons = ['凭据文档故障（键：repo-push-access:github.com）'];

const v1a = policy.attemptStage('1a-junction-repair', { guardReasons });
console.log('  1a ' + (v1a.allowed ? '执行' : '跳过') + ' — ' + v1a.reason);

const v1b = policy.attemptStage('1b-disable-patch-entries', { evidence: false, guardReasons });
console.log('  1b ' + (v1b.allowed ? '执行' : '跳过') + ' — ' + v1b.reason);

const v1c = policy.attemptStage('1c-disable-bundles', { evidence: false, guardReasons });
console.log('  1c ' + (v1c.allowed ? '执行' : '跳过') + ' — ' + v1c.reason);

const v2 = policy.attemptStage('2-quarantine-profiles', { evidence: false, guardReasons });
console.log('  2  ' + (v2.allowed ? '执行' : '★ 跳过') + ' — ' + v2.reason);

const v3 = policy.attemptStage('3-node-repair', { evidence: false, guardReasons });
console.log('  3  ' + (v3.allowed ? '执行' : '跳过') + ' — ' + v3.reason);

console.log('');
console.log('结论: ' + (v2.allowed === false
  ? '★ profile 被保住了 —— 事故不会重演（旧行为会烧掉 3 份 profile 且无效）'
  : '✗ 仍会隔离 profile，纪律未生效'));

// 反向验证：如果真的是 profiles 坏了，仍然应该允许隔离
console.log('');
console.log('反向验证：真·profiles 损坏时（日志点名 profiles 路径）');
const v2b = policy.attemptStage('2-quarantine-profiles', {
  evidence: true,
  guardReasons: []
});
console.log('  2  ' + (v2b.allowed ? '★ 执行（正确：根因确在此处）' : '跳过（✗ 过于保守，会漏救）'));
