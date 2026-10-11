'use strict';

/**
 * 自愈阶梯纪律（0.3.43 · 借鉴官方 fatal-recovery.ts 的克制设计）
 *
 * ## 为什么需要"纪律"而不是更多自愈
 *
 * 官方对整个启动失败只提供**一个**恢复动作（禁用全部第三方插件）加"退出/重启"，
 * 而我们有 9 段自动阶梯。复杂度不是免费的：2026-10-11 事故里，阶梯的 1b/1c
 * 都是"日志能点名才生效"的归因式修复，而那次日志只有一句无名的
 * `1 required plugin did not activate` —— 归因全部落空，**阶梯于是直坠到最重的
 * 那一级：隔离整个 profiles**。连烧 3 份 profile 且完全无效（根因在 home 层，
 * profiles 之外），还顺带 prune 掉 3 份历史隔离备份。
 *
 * 结论不是"删掉阶梯"（它确实救过很多次真实故障），而是给阶梯加上**纪律**：
 *
 *   1. **每一级必须声明破坏性等级**（reversible / needs-proof / irreversible）。
 *   2. **不可逆级必须拿到"根因确在此处"的正面证据**才能执行；只有"没找到别的原因"
 *      这种消极证据时，禁止执行 —— 这正是 10-11 直坠的成因。
 *   3. 任何一级执行前都留下审计记录，事后能回答"那一夜它为什么烧了三次"。
 *
 * 这个模块只做**判定**，不执行任何操作；执行仍由 main.js 的阶梯代码负责，
 * 因此可以完整单测。
 */

/**
 * 破坏性等级：
 *   - reversible   ：只重建/补齐，可无损重来（如重建 junction、修复缺文件）
 *   - needs-proof  ：会改写用户配置，需要日志点名才允许（归因式禁用插件）
 *   - irreversible ：会丢弃/重建整棵配置树，**必须有根因证据**（隔离 profiles）
 */
const DAMAGE = {
  REVERSIBLE: 'reversible',
  NEEDS_PROOF: 'needs-proof',
  IRREVERSIBLE: 'irreversible'
};

/**
 * 阶梯各段的静态描述。新增自愈动作时必须在此登记，否则 resolveStage 返回
 * unknown，attemptStage 会拒绝执行 —— 让"加一段自愈"这件事无法悄悄发生。
 */
const STAGES = {
  '1a-junction-repair': {
    damage: DAMAGE.REVERSIBLE,
    summary: '重建/修复 profile 插件 junction（缺了或名字不匹配）'
  },
  '1b-disable-patch-entries': {
    damage: DAMAGE.NEEDS_PROOF,
    summary: '禁用 home 补丁里日志点名的坏插件条目',
    proof: '日志必须点名该补丁条目'
  },
  '1c-disable-bundles': {
    damage: DAMAGE.NEEDS_PROOF,
    summary: '禁用日志点名的失败 bundle',
    proof: '日志必须点名该 bundle 包'
  },
  '1d-credential-repair': {
    damage: DAMAGE.REVERSIBLE,
    summary: '规范化 .credentials.yaml 的非法键（备份 + 原子写）'
  },
  '2-quarantine-profiles': {
    damage: DAMAGE.IRREVERSIBLE,
    summary: '隔离整棵 profiles 目录并重建',
    proof: '必须有正面证据表明根因在 profiles 内（例如日志点名 profile 内包、或 profile 树本身损坏）'
  },
  '3-node-repair': {
    damage: DAMAGE.IRREVERSIBLE,
    summary: '重装 Node 运行时',
    proof: '必须确认 node.exe 缺失/损坏（非"其它原因都没找到"）'
  }
};

/**
 * 判断某一级是否允许执行。
 *
 * @param {string} stageId 阶梯段标识（STAGES 的键）
 * @param {object} ctx
 * @param {boolean} [ctx.evidence] 是否有"根因确在此处"的正面证据
 * @param {string[]} [ctx.guardReasons] 已知的"根因不在此处"的归因（命中即否决）
 * @param {(msg: string) => void} [ctx.log]
 * @returns {{allowed: boolean, reason: string, damage: string}}
 */
function attemptStage(stageId, ctx = {}) {
  const log = ctx.log || (() => {});
  const stage = STAGES[stageId];
  if (!stage) {
    return { allowed: false, reason: `未登记的阶梯段 "${stageId}"（新增自愈动作必须先在 STAGES 登记）`, damage: 'unknown' };
  }

  // 第一道闸：任何"根因不在此处"的已知归因，直接否决本该级。
  const guards = Array.isArray(ctx.guardReasons) ? ctx.guardReasons : [];
  if (guards.length && stage.damage !== DAMAGE.REVERSIBLE) {
    const reason = `已有归因指明根因不在本级作用域（${guards.join('；')}）`;
    log(`阶梯 ${stageId} 被否决：${reason}`);
    return { allowed: false, reason, damage: stage.damage };
  }

  // 第二道闸：不可逆级必须有正面证据。
  if (stage.damage === DAMAGE.IRREVERSIBLE && !ctx.evidence) {
    const reason = `不可逆操作（${stage.summary}）缺少根因证据：${stage.proof}`;
    log(`阶梯 ${stageId} 被否决：${reason}`);
    return { allowed: false, reason, damage: stage.damage };
  }

  // 第三道闸：需要点名的级必须有证据。
  if (stage.damage === DAMAGE.NEEDS_PROOF && !ctx.evidence) {
    const reason = `该级需要日志点名才能生效：${stage.proof}`;
    log(`阶梯 ${stageId} 被否决：${reason}`);
    return { allowed: false, reason, damage: stage.damage };
  }

  log(`阶梯 ${stageId} 允许执行（${stage.damage}）：${stage.summary}`);
  return { allowed: true, reason: stage.summary, damage: stage.damage };
}

/**
 * 生成一份可读的阶梯执行计划（用于诊断日志与事故复盘）。
 * @param {string[]} guardReasons
 */
function describeLadder(guardReasons = []) {
  const lines = ['自愈阶梯（按顺序）:'];
  for (const [id, s] of Object.entries(STAGES)) {
    const mark = s.damage === DAMAGE.IRREVERSIBLE ? '⚠ 不可逆' : s.damage === DAMAGE.NEEDS_PROOF ? '◇ 需点名' : '○ 可逆';
    const blocked = guardReasons.length && s.damage === DAMAGE.IRREVERSIBLE ? '  [已被归因否决]' : '';
    lines.push(`  ${mark}  ${id}：${s.summary}${blocked}`);
  }
  return lines.join('\n');
}

/**
 * 记录一次阶梯段的实际执行（审计用）。
 * @param {Array} trail 执行轨迹数组（调用方持有）
 * @param {string} stageId
 * @param {{allowed: boolean, reason: string, damage: string}} verdict
 */
function recordAttempt(trail, stageId, verdict) {
  trail.push({
    stage: stageId,
    at: new Date().toISOString(),
    allowed: verdict.allowed,
    damage: verdict.damage,
    reason: verdict.reason
  });
  return trail;
}

module.exports = { DAMAGE, STAGES, attemptStage, describeLadder, recordAttempt };
