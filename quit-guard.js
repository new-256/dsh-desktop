'use strict';

/**
 * 退出前确认（0.3.42 · 对齐官方 apps/desktop/src/quit-confirmation.ts）
 *
 * ## 为什么需要
 *
 * 官方在退出前会向 Host 查询「这次退出会中断什么」（运行中的 agent、排队消息、
 * 定时任务），**两秒超时按"有任务"处理**，然后弹原生确认框让用户决定。
 *
 * 我们此前**完全没有这个机制**：main.js 里只有一个从未被读取的常量
 * `QUIT_INSPECT_DEADLINE_MS = 2000` 和一句注释，6 个退出口全部无条件杀后端。
 * 用户正在跑长任务时点「退出」，任务无声消失，没有任何提示。
 *
 * ## 与官方的差异（保守版）
 *
 * 官方有结构化的 `quit-inspection` IPC 请求/应答（host-process.ts 的 control()），
 * 我们跑的是标准 `dsh web` CLI，**没有任何任务状态接口**。因此这里采用保守语义：
 *
 *   - 后端进程存在且曾成功就绪 ⇒ 视为"可能有任务"，需要确认
 *   - 后端不存在 / 从未就绪 / 已在退出中 ⇒ 直接放行（不打扰用户）
 *
 * 宁可多问一次，也不能让用户在不知情的情况下丢掉正在跑的任务。这与官方
 * quit-confirmation.ts:15-16 的取向一致（unknown → 按有任务处理）。
 *
 * ## 边界（对齐官方 :52-55、:70）
 *
 *   - 防重入：确认框显示期间再次请求退出，合并到同一次询问，不叠弹窗
 *   - 已有确认结果后不再询问（用户已表态）
 *   - 「记住我的选择」可让本次会话内不再询问
 *   - 无窗口/无 UI 环境下不阻塞退出
 */

const QUIT_CONFIRM_DEADLINE_MS = 2000;

/**
 * 退出意图的判定与询问编排。
 *
 * @param {object} opts
 * @param {() => boolean} opts.hasInterruptibleWork 是否有「可能有任务」的后端
 * @param {(reason: string) => Promise<boolean>} opts.confirm 显示确认框，true=继续退出
 * @param {() => void} opts.now 立即执行退出
 * @param {(msg: string) => void} [opts.log] 诊断日志
 */
function createQuitGuard(opts) {
  const log = opts.log || (() => {});
  /** 询问进行中：合并重复的退出请求（官方 :52-55）。 */
  let asking = false;
  /** 用户已明确表态"退出"：本次会话内不再询问。 */
  let confirmed = false;
  /** 用户选了"不再询问"。 */
  let suppressed = false;

  /**
   * 请求退出。返回 true 表示退出已被安排（或已在安排中）。
   * @param {string} origin 触发来源（诊断用）
   */
  async function requestQuit(origin) {
    if (confirmed || suppressed) { opts.now(); return true; }
    if (asking) {
      // 确认框已开着：不叠第二个弹窗，也不重复杀后端。
      log(`退出请求（${origin}）已合并到进行中的确认`);
      return true;
    }
    if (!opts.hasInterruptibleWork()) {
      log(`退出请求（${origin}）：无可能中断的任务，直接退出`);
      confirmed = true;
      opts.now();
      return true;
    }
    asking = true;
    try {
      const proceed = await opts.confirm(origin);
      if (proceed) {
        confirmed = true;
        opts.now();
      } else {
        log(`退出请求（${origin}）：用户取消`);
      }
      return proceed;
    } catch (e) {
      // 确认失败（无 UI 等）：不能因此卡住退出，按放行处理并记日志。
      log(`退出确认失败（${origin}）：${e && e.message ? e.message : e}`);
      confirmed = true;
      opts.now();
      return true;
    } finally {
      asking = false;
    }
  }

  return {
    requestQuit,
    /** 本次会话内不再询问（对齐官方「记住」语义）。 */
    suppress() { suppressed = true; },
    get asking() { return asking; },
    get settled() { return confirmed || suppressed; },
    _reset() { asking = false; confirmed = false; suppressed = false; }
  };
}

module.exports = { createQuitGuard, QUIT_CONFIRM_DEADLINE_MS };
