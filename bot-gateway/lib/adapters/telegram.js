/**
 * @file lib/adapters/telegram.js
 * @description Telegram Bot 适配器，实现 getMe 信息获取、Long Polling 长轮询监听、
 *              @botUsername 提及剥离、消息切块与 429/超长重试。
 */

import { createLogger, createBackoffScheduler, splitText, fetchJson } from '../util.js?v=10';

/**
 * 工厂函数：创建 Telegram Bot 适配器
 * @param {string} kind - 'telegram'
 * @param {object} adapterConfig - 配置对象
 * @param {object} deps - { log, core, config }
 */
export function createAdapter(kind, adapterConfig, deps) {
  const log = deps.log || createLogger('telegram');
  const core = deps.core;

  let state = 'starting'; // starting | connected | reconnecting | error | disabled
  let detail = '初始化中';

  let botInfo = { id: '', username: '' };
  let offset = 0;
  let isStopped = false;
  let pollAbortController = null;
  let scheduler = null;

  function updateStatus(newState, newDetail) {
    state = newState;
    detail = newDetail;
    log.info(`状态变更为: ${state} (${detail})`);
  }

  function getApiBase() {
    const base = adapterConfig.apiBase || 'https://api.telegram.org';
    return base.replace(/\/+$/, '');
  }

  /**
   * 启动时通过 getMe 获取 Bot 基本信息
   */
  async function fetchGetMe() {
    const token = adapterConfig.token;
    if (!token) {
      throw new Error('未配置 Telegram Bot Token');
    }

    const url = `${getApiBase()}/bot${token}/getMe`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`getMe 失败 HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (!data.ok || !data.result) {
      throw new Error(`getMe 返回失败: ${JSON.stringify(data)}`);
    }

    botInfo = {
      id: String(data.result.id),
      username: data.result.username || '',
    };
    log.info(`Telegram getMe 成功, Bot Username: @${botInfo.username} (ID: ${botInfo.id})`);
  }

  /**
   * 处理从 getUpdates 收到的单条 Update 记录
   */
  function handleTelegramUpdate(update) {
    if (!update || !update.message) return;
    const msg = update.message;
    const text = msg.text || '';
    if (!text.trim()) return;

    const userId = String(msg.from?.id || '');
    const chatId = String(msg.chat?.id || '');
    const userName = msg.from?.username || msg.from?.first_name || userId;
    const chatType = msg.chat?.type || 'private';
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    let textToProcess = text;

    if (isGroup) {
      const botUsername = botInfo.username;
      if (!botUsername) return; // 尚未获得 username，忽略

      const mentionTag = `@${botUsername}`;
      const hasMention = text.includes(mentionTag);
      const isCmdMention = text.match(new RegExp(`^/\\w+@${botUsername}`, 'i'));

      if (!hasMention && !isCmdMention) {
        return; // 未提及 bot，忽略
      }

      // 剥离 @<botUsername> 标记
      textToProcess = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
    }

    log.info(`收到 Telegram 消息 (${isGroup ? '群聊' : '私聊'} ${chatId} / 用户 ${userId}): ${textToProcess}`);

    core.onMessage({
      adapter: kind,
      chatId,
      userId,
      userName,
      text: textToProcess,
      isGroup,
      reply: async (replyText) => {
        await sendText({ type: isGroup ? 'group' : 'private', id: chatId }, replyText);
      }
    });
  }

  /**
   * 开启 Long Polling 长轮询循环
   */
  async function startPollingLoop() {
    const token = adapterConfig.token;

    while (!isStopped) {
      pollAbortController = new AbortController();
      // 客户端设定 35s 超时（服务器端 timeout 是 30s）
      const timer = setTimeout(() => pollAbortController.abort(), 35000);

      try {
        const url = `${getApiBase()}/bot${token}/getUpdates?timeout=30&offset=${offset}`;
        const res = await fetch(url, { signal: pollAbortController.signal });
        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          log.error(`getUpdates 失败 HTTP ${res.status}: ${errText}`);
          updateStatus('reconnecting', `HTTP ${res.status}，稍后重试`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const data = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          if (state !== 'connected') {
            updateStatus('connected', `正在长轮询 (@${botInfo.username})`);
            scheduler.reset();
          }

          for (const update of data.result) {
            if (update.update_id >= offset) {
              offset = update.update_id + 1;
            }
            handleTelegramUpdate(update);
          }
        }
      } catch (err) {
        clearTimeout(timer);
        if (isStopped) break;

        if (err.name === 'AbortError') {
          // 正常的长轮询超时或 stop 触发，继续下一轮
          continue;
        }

        log.error('Telegram 长轮询抛错:', err);
        updateStatus('reconnecting', `轮询异常: ${err.message}`);
        scheduler.schedule();
        break; // 跳出由 scheduler 重试触发 next round
      }
    }
  }

  /**
   * 发送文本消息 (支持 3800 字符分块、429 重试、超长自动二分重切)
   */
  async function sendText(target, text, opts = {}) {
    if (!text || !adapterConfig.token) return;

    const targetId = typeof target === 'string' ? target : String(target.id || '');
    const token = adapterConfig.token;
    const url = `${getApiBase()}/bot${token}/sendMessage`;

    const chunks = splitText(text, 3800);

    for (const chunk of chunks) {
      if (!chunk) continue;
      await sendSingleChunk(url, targetId, chunk, 1);
    }
  }

  /**
   * 发送单个分块并处理 429 / 消息过长异常
   */
  async function sendSingleChunk(url, chatId, textChunk, retryLeft = 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: textChunk,
        }),
      });

      if (res.status === 429 && retryLeft > 0) {
        const errJson = await res.json().catch(() => ({}));
        const retryAfter = errJson.parameters?.retry_after || 3;
        log.warn(`Telegram 触发 429 限速，等待 ${retryAfter} 秒后重试...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        return await sendSingleChunk(url, chatId, textChunk, retryLeft - 1);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // 如果遇到消息过长错误且还可以重切
        if (errText.includes('message is too long') && textChunk.length > 100) {
          log.warn('Telegram 提示消息过长，尝试切半重发...');
          const half = Math.floor(textChunk.length / 2);
          const part1 = textChunk.slice(0, half);
          const part2 = textChunk.slice(half);
          await sendSingleChunk(url, chatId, part1, retryLeft);
          await sendSingleChunk(url, chatId, part2, retryLeft);
          return;
        }
        log.error(`发送 Telegram 消息失败 HTTP ${res.status}: ${errText}`);
      }
    } catch (e) {
      log.error('发送 Telegram 消息抛错:', e);
    }
  }

  return {
    kind,
    deps,

    async start() {
      if (!adapterConfig.enabled) {
        updateStatus('disabled', '未启用');
        return;
      }

      if (!adapterConfig.token) {
        updateStatus('error', '未配置 Token');
        return;
      }

      isStopped = false;
      scheduler = createBackoffScheduler({
        minDelay: 2000,
        maxDelay: 30000,
        factor: 2,
        onRetry: async () => {
          if (isStopped) return;
          try {
            await fetchGetMe();
            startPollingLoop();
          } catch (e) {
            updateStatus('error', e.message);
            scheduler.schedule();
          }
        }
      });

      try {
        await fetchGetMe();
        startPollingLoop();
      } catch (e) {
        log.error('Telegram 启动获取 getMe 失败:', e);
        updateStatus('error', e.message);
        scheduler.schedule();
      }
    },

    async stop() {
      isStopped = true;
      if (scheduler) {
        scheduler.stop();
        scheduler = null;
      }
      if (pollAbortController) {
        try { pollAbortController.abort(); } catch {}
        pollAbortController = null;
      }
      updateStatus('disabled', '已停止');
    },

    status() {
      return {
        state,
        detail: botInfo.username ? `@${botInfo.username} (${detail})` : detail,
      };
    },

    sendText,
  };
}
