'use strict';

/**
 * 0.3.41 凭据预校验与自愈护栏测试。
 *
 * 覆盖 2026-10-11 事故的三段链路：
 *   1. 预校验器精确找出非法凭证键（并给出正确行号）
 *   2. 修复器按 dsh 规则规范化（冒号→斜杠、非法字符→短横线），备份 + 原子写
 *   3. 日志归因器认出"凭据导致启动失败"，从而拦住 profile 隔离（护栏）
 * 另断言：修复**绝不改动任何密钥值**、不误伤合法键与结构键。
 *
 * 用法：node scripts/test-041.js
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
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-041-'));
require.cache[STUB_ID] = {
  id: STUB_ID, filename: STUB_ID, loaded: true,
  exports: { app: { getPath: () => path.join(TMP_ROOT, 'userData'), isPackaged: false, getVersion: () => '0.3.41-test' } }
};

const mgr = require('../updater-backend.js');

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }

const p = mgr.P();
const home = p.dshHome;
fs.mkdirSync(home, { recursive: true });
const credFile = path.join(home, '.credentials.yaml');

// 真实事故文件的精简复刻：结构键 + 合法键 + 非法键（冒号分隔）+ 值
const ORIGINAL = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-CANARY-REF-VALUE',
  'records:',
  '  - kind: apikey',
  '    payload:',
  '      version: 1',
  '      secret: CANARY-SECRET-VALUE',
  'repo-push-access:github.com:',           // 非法：冒号分隔（行 9）
  '  kind: token',
  '  payload:',
  '    token: CANARY-TOKEN-VALUE',
  '  repo-push-access:registry.npmjs.org:',  // 非法：冒号分隔（行 13）
  '    kind: token',
  '    payload:',
  '      token: CANARY-NPM-TOKEN',
  'repo-push-access/already-good:',          // 合法：必须原样保留（行 17）
  '  kind: token',
  'settings:',
  '  some/legal-key:',
  '    note: keep-me'
].join('\n');

section('1. 预校验：精确找出非法键 + 行号');
fs.writeFileSync(credFile, ORIGINAL, 'utf8');
const v = mgr.validateCredentialsDocument(home);
ok(v.present === true, '识别出文件存在');
ok(v.ok === false, '判定为不合法文档');
ok(v.problems.length === 2, `恰好 2 条非法键（实际 ${v.problems.length}）`);
const p0 = v.problems.find((x) => x.line === 9);
ok(!!p0 && p0.key === 'repo-push-access:github.com', '行 9 · repo-push-access:github.com');
const p1 = v.problems.find((x) => x.line === 13);
ok(!!p1 && p1.key === 'repo-push-access:registry.npmjs.org', '行 13 · repo-push-access:registry.npmjs.org');
ok(/冒号分隔/.test(p1.reason), '给出"冒号分隔"原因');
ok(!v.problems.some((x) => x.key === 'version' || x.key === 'refs' || x.key === 'records'), '结构键未被误判');
ok(!v.problems.some((x) => x.key === 'repo-push-access/already-good'), '合法 <scope>/<id> 未被误判');
ok(!v.problems.some((x) => x.key === 'some/legal-key'), '合法的 some/legal-key 未被误判');

section('2. 修复：规范化 + 备份 + 原子写');
const fix = mgr.repairCredentialKeys(home, v.problems);
ok(fix.changed.length === 2, '修复 2 条键');
ok(!!fix.backup && fs.existsSync(fix.backup), '已生成备份文件');
const fixedText = fs.readFileSync(credFile, 'utf8');
ok(fixedText.includes('repo-push-access/github-com:'), 'github.com 的点号与冒号规范为短横线');
ok(fixedText.includes('repo-push-access/registry-npmjs-org:'), 'registry.npmjs.org 同样规范化');
ok(!fixedText.includes('repo-push-access:registry'), '原非法形态已消失');
ok(fixedText.includes('repo-push-access/already-good:'), '原本合法的键原样保留');
const backed = fs.readFileSync(fix.backup, 'utf8');
ok(backed === ORIGINAL, '备份是改动前的完整原文（可回滚）');

section('3. 隐私纪律：绝不改动任何值');
ok(fixedText.includes('sk-CANARY-REF-VALUE'), 'refs 的值原样');
ok(fixedText.includes('CANARY-SECRET-VALUE'), 'record secret 原样');
ok(fixedText.includes('CANARY-TOKEN-VALUE'), 'token 原样');
ok(fixedText.includes('CANARY-NPM-TOKEN'), '被修复记录的 token 值也原样');
ok(fixedText.includes('note: keep-me'), '无关字段原样');
const origLines = ORIGINAL.split('\n');
const fixedLines = fixedText.split('\n');
ok(origLines.length === fixedLines.length, '行数不变（只改键，不增删）');
let valueChanges = 0;
for (let i = 0; i < origLines.length; i++) {
  if (origLines[i] === fixedLines[i]) continue;
  // 允许变化的行：只应是含非法键的那两行（行 9 与行 13）
  if (!/^(\s*)repo-push-access:/.test(origLines[i])) valueChanges++;
}
ok(valueChanges === 0, '除非法键行外无任何行被改动');

section('4. 幂等：修好后再校验通过，重复修复无事发生');
const v2 = mgr.validateCredentialsDocument(home);
ok(v2.ok === true && v2.problems.length === 0, '修复后校验通过');
const fix2 = mgr.repairCredentialKeys(home, v2.problems);
ok(fix2.changed.length === 0 && fix2.backup === null, '无问题时不产生备份、不写文件');

section('5. 日志归因：认出凭据故障（护栏的依据）');
const realLog = [
  'dsh: startup failed: 1 required plugin did not activate',
  '',
  'Failed plugins (1):',
  '  credentials',
  '    Package: @deepseek-ai/dsh-credentials-local',
  '    TypeError: credential key "repo-push-access:github.com" must be "<scope>/<id>"',
  '        at parseCredentialKey (file:///.../dsh-credentials/lib/index.js:70:72)',
  '',
  'Plugins waiting for services (9):',
  '  connection (required)  credentials'
].join('\n');
const a = mgr.analyzeCredentialFailure(realLog);
ok(a.credentials === true, '判定为凭据故障（→ 护栏将阻止 profile 隔离）');
ok(a.keys.length === 1 && a.keys[0] === 'repo-push-access:github.com', '从日志提取出非法键原文');
ok(a.pluginCount === 1, '解析出失败插件数 1');

section('6. 归因不误报：普通插件失败不触发护栏');
const otherLog = [
  'dsh: startup failed: 1 required plugin did not activate',
  '',
  'Failed plugins (1):',
  '  pet',
  '    Package: dsh-pet',
  '    SyntaxError: Unexpected token }',
  '',
  'Plugins waiting for services (0):'
].join('\n');
ok(mgr.analyzeCredentialFailure(otherLog).credentials === false, '插件语法错误不判为凭据故障');
ok(mgr.analyzeCredentialFailure('').credentials === false, '空日志不误报');
ok(mgr.analyzeCredentialFailure('backend ready at http://127.0.0.1:1234').credentials === false, '正常日志不误报');

section('7. 边界：斜杠超过两段 / 缺文件 / 空文件');
fs.writeFileSync(credFile, 'a/b/c:\n  kind: token\n', 'utf8');
const v3 = mgr.validateCredentialsDocument(home);
ok(v3.ok === false && v3.problems.length === 1, '捕获 3 段斜杠键');
const f3 = mgr.repairCredentialKeys(home, v3.problems);
ok(f3.changed.length === 1 && f3.changed[0].to === 'a/b-c', '多段合并为 <scope>/<id>（a/b-c）');
fs.unlinkSync(credFile);
ok(mgr.validateCredentialsDocument(home).present === false, '文件缺失时 present=false 且不报错');
fs.writeFileSync(credFile, '', 'utf8');
ok(mgr.validateCredentialsDocument(home).ok === true, '空文件视为正常（无键可查）');

section('8. 护栏接线契约（源码级断言，防将来被改坏）');
{
  // 核心保证：main.js 里 credentialHandled 必须真正短路 quarantineProfiles。
  // 这是"根因在 home 层 → 永不隔离 profiles"的机械保证，一旦有人重构掉它，
  // 2026-10-11 事故就会原样重演。用源码断言把这个不变量钉住。
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/credentialHandled\s*=\s*true/.test(mainSrc), 'main.js 设有 credentialHandled 标志');
  // 0.3.42：护栏载荷从"单一布尔"升级为"原因集合"。不变量本身不变 ——
  // 只要有任一归因证明根因在 profiles 之外，quarantineProfiles 就必须被短路。
  // 0.3.43：短路机制进一步收敛为"阶梯纪律"（ladder-policy.attemptStage），
  // 断言随之改为检查**行为不变量**：隔离只在裁决允许时才执行，且裁决必须
  // 拿到 guardReasons。这样既覆盖旧护栏语义，也不钉死具体实现形态。
  ok(/const qRes = quarantineVerdict\.allowed \? mgr\.quarantineProfiles\(p\.dshHome\) : null/.test(mainSrc),
    'quarantineProfiles 仅在阶梯裁决允许时执行（护栏生效点）');
  ok(/attemptStage\('2-quarantine-profiles', \{[\s\S]{0,300}?guardReasons: Array\.from\(guardReasons\)/.test(mainSrc),
    '隔离裁决确实拿到了护栏原因集合（归因可一票否决）');
  ok(/const guardReasons = new Set\(\)/.test(mainSrc), '护栏原因集合已声明');
  ok(/guardReasons\.add\(/.test(mainSrc), '至少一种归因登记到护栏集合');
  ok(/if \(guardReasons\.size\) \{[\s\S]{0,400}?已跳过 profile 隔离/.test(mainSrc),
    '短路时向用户说明跳过原因');
  ok(/mgr\.analyzeCredentialFailure\(backendLogs\.join\(''\)\)/.test(mainSrc),
    '护栏基于真实后端日志归因');
  ok(/validateCredentialsDocument\(credHome\)/.test(mainSrc), '启动前预校验已接入（步骤 4.8）');
  ok(/repairCredentialKeys\(credHome, credCheck\.problems\)/.test(mainSrc), '预校验发现问题时走修复');
  ok(/bak-before-keyscope-/.test(fs.readFileSync(path.join(__dirname, '..', 'updater-backend.js'), 'utf8')),
    '修复前生成 keyscope 备份（可回滚）');
}

try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
