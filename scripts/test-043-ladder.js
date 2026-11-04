'use strict';

/**
 * 0.3.43 自愈阶梯纪律测试。
 *
 * 背景（2026-10-11 事故）：阶梯的 1b/1c 都是"日志能点名才生效"的归因式修复，
 * 而那次日志只有一句无名的 `1 required plugin did not activate` —— 归因全落空，
 * 阶梯直坠到最重的一级（隔离整棵 profiles），连烧 3 份 profile 且完全无效
 * （根因在 home 层的凭据文档，profiles 之外）。
 *
 * 本测试锁定的纪律：
 *   1. 不可逆级（隔离 profiles / 重装 Node）**必须有正面证据**才允许执行
 *   2. 任何"根因不在此处"的归因，必须一票否决所有非可逆级
 *   3. 未登记的自愈段一律拒绝（防止有人偷偷加一段自愈）
 *   4. 每一次裁决都留下可复盘的轨迹
 *
 * 用法：node scripts/test-043-ladder.js
 */

const path = require('path');
const fs = require('fs');

const policy = require(path.join(__dirname, '..', 'ladder-policy.js'));
const { DAMAGE, attemptStage, describeLadder, recordAttempt, STAGES } = policy;

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}
function section(n) { console.log('\n' + n); }

console.log('自愈阶梯纪律');

section('1. 登记表：每一级都声明了破坏性等级');
{
  ok(Object.keys(STAGES).length >= 6, '阶梯段已登记（' + Object.keys(STAGES).length + ' 段）');
  for (const [id, s] of Object.entries(STAGES)) {
    ok(!!s.damage && !!s.summary, `${id} 声明了 damage 与 summary`);
  }
  const irreversible = Object.entries(STAGES).filter(([, s]) => s.damage === DAMAGE.IRREVERSIBLE).map(([id]) => id);
  ok(irreversible.includes('2-quarantine-profiles'), 'profile 隔离被正确标记为不可逆');
  ok(irreversible.includes('3-node-repair'), 'Node 重装被正确标记为不可逆');
  ok(Object.values(STAGES).every((s) => s.damage !== DAMAGE.IRREVERSIBLE || !!s.proof),
    '所有不可逆级都声明了所需的证据（proof）');
}

section('2. 不可逆级：无正面证据时必须拒绝（10-11 直坠的根治）');
{
  // 这正是 10-11 的情形：某个必需插件没激活，但没有任何证据指向 profiles
  const v = attemptStage('2-quarantine-profiles', { evidence: false });
  ok(v.allowed === false, '★ 无证据时拒绝隔离 profile（旧行为会直坠执行）');
  ok(/缺少根因证据/.test(v.reason), '拒绝原因明确说明缺少根因证据');
  ok(v.damage === DAMAGE.IRREVERSIBLE, '裁决带回破坏性等级（便于审计）');

  const v2 = attemptStage('2-quarantine-profiles', { evidence: true });
  ok(v2.allowed === true, '★ 有正面证据（日志点名 profiles 路径）时允许隔离');

  const v3 = attemptStage('3-node-repair', { evidence: false });
  ok(v3.allowed === false, '无证据时拒绝重装 Node');

  const v4 = attemptStage('3-node-repair', { evidence: true });
  ok(v4.allowed === true, '有证据（node.exe 缺失）时允许重装 Node');
}

section('3. 归因否决：任何"根因不在此处"必须一票否决非可逆级');
{
  const guards = ['凭据文档故障（键：repo-push-access:github.com）'];
  const v = attemptStage('2-quarantine-profiles', { evidence: true, guardReasons: guards });
  ok(v.allowed === false, '★ 即使有证据，已知归因仍否决隔离（证据不如归因确定）');
  ok(/根因不在本级作用域/.test(v.reason), '否决原因引用了具体归因');

  const v1b = attemptStage('1b-disable-patch-entries', { evidence: true, guardReasons: guards });
  ok(v1b.allowed === false, '归因同样否决"禁用补丁条目"级');

  const v1c = attemptStage('1c-disable-bundles', { evidence: true, guardReasons: guards });
  ok(v1c.allowed === false, '归因否决"禁用 bundle"级');

  // 可逆级不受归因影响 —— 重建 junction 不会破坏任何东西，永远可以做
  const v1a = attemptStage('1a-junction-repair', { guardReasons: guards });
  ok(v1a.allowed === true, '★ 可逆级不受归因否决（重建 junction 无损，永远允许）');
}

section('4. 需点名级：没有点名就不许动用户配置');
{
  const v = attemptStage('1b-disable-patch-entries', { evidence: false });
  ok(v.allowed === false, '无点名时拒绝禁用补丁条目');
  ok(/需要日志点名/.test(v.reason), '拒绝原因说明需要点名');

  const v2 = attemptStage('1c-disable-bundles', { evidence: false });
  ok(v2.allowed === false, '无点名时拒绝禁用 bundle');
}

section('5. 可逆级：无需证据，始终允许');
{
  ok(attemptStage('1a-junction-repair', {}).allowed === true, '重建 junction：允许');
  ok(attemptStage('1d-credential-repair', {}).allowed === true, '凭据规范化：允许（有备份）');
  ok(STAGES['1d-credential-repair'].damage === DAMAGE.REVERSIBLE, '凭据修复被标记为可逆');
}

section('6. 未登记的阶梯段一律拒绝');
{
  const v = attemptStage('9-mystery-stage', { evidence: true });
  ok(v.allowed === false, '★ 未登记的自愈段被拒绝（新增自愈必须先在 STAGES 登记）');
  ok(/未登记/.test(v.reason), '拒绝原因说明未登记');
  ok(v.damage === 'unknown', '返回 unknown 等级');
}

section('7. 审计轨迹：每一次裁决都留痕');
{
  const trail = [];
  recordAttempt(trail, '1a-junction-repair', attemptStage('1a-junction-repair', {}));
  recordAttempt(trail, '2-quarantine-profiles', attemptStage('2-quarantine-profiles', { evidence: false }));
  ok(trail.length === 2, '轨迹记录了两条');
  ok(trail[0].stage === '1a-junction-repair' && trail[0].allowed === true, '第一条：执行');
  ok(trail[1].stage === '2-quarantine-profiles' && trail[1].allowed === false, '第二条：跳过');
  ok(!!trail[0].at && !isNaN(Date.parse(trail[0].at)), '带时间戳（可复盘"那一夜"）');
  ok(trail.every((t) => typeof t.damage === 'string' && typeof t.reason === 'string'), '每条都有等级与原因');
}

section('8. 可读计划（诊断用）');
{
  const txt = describeLadder(['凭据文档故障']);
  ok(/不可逆/.test(txt), '计划里标出了不可逆级');
  ok(/已被归因否决/.test(txt), '计划里标出了被归因否决的级');
  ok(txt.split('\n').length >= 7, '计划列出了全部阶梯段');
  ok(/2-quarantine-profiles/.test(txt), '含 profile 隔离段');
}

section('9. 接线：main.js 的阶梯确实经过纪律裁决');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/require\('\.\/ladder-policy'\)/.test(src), 'main.js 引入了 ladder-policy');
  ok(/attemptStage\('2-quarantine-profiles'/.test(src), '隔离级经过裁决');
  ok(/attemptStage\('3-node-repair'/.test(src), 'Node 重装级经过裁决');
  ok(/attemptStage\('1a-junction-repair'/.test(src), 'junction 修复级经过裁决');
  ok(/attemptStage\('1b-disable-patch-entries'/.test(src), '补丁条目禁用级经过裁决');
  ok(/attemptStage\('1c-disable-bundles'/.test(src), 'bundle 禁用级经过裁决');
  ok(/recordAttempt\(ladderTrail/.test(src), '裁决写入轨迹');
  ok(/logLadderTrail\(ladderTrail\)/.test(src), '轨迹落诊断日志');
  ok(!/credentialHandled \|\| guardReasons\.size/.test(src), '旧的布尔短路判定已被纪律取代');
  // 证据判定必须存在，且"日志点名 profiles 路径"是其一支
  ok(/profileLooksBroken/.test(src), '存在 profile 破损证据判定');
  ok(/profiles\[\\\\\/\]/.test(src) || /profiles\[\\\/\]/.test(src), '证据包含"日志点名 profiles 路径"');
}

console.log('\n' + '─'.repeat(60));
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过');
