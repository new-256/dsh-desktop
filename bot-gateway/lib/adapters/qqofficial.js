/**
 * @file lib/adapters/qqofficial.js
 * @description QQ 官方机器人适配器，实现 WebSocket 长连接事件监听、AccessToken 刷新、
 *              C2C/Group 被动回复窗口管理 (5分钟/5条限制) 及 REST 消息发送。
 */

import { createLogger, createBackoffScheduler, splitText, fetchJson } from '../util.js?v=10';

/**
 * 工厂函数：创建 QQ 官方机器人适配器
 * @param {string} kind - 'qqofficial'
 * @param {object} adapterConfig - 配置对象
 * @param {object} deps - { log, core, config }
 */
export function createAdapter(kind, adapterConfig, deps) {
  const log = deps.log || createLogger('qqofficial');
  const core = deps.core;

  let state = 'starting'; // starting | connected | reconnecting | error | disabled
  let detail = '初始化中';

  let accessToken = '';
  let tokenExpiresAt = 0;

  let wsClient = null;
  let scheduler = null;
  let heartbeatTimer = null;
  let lastSequence = null;
  let isStopped = false;

  // 被动回复上下文窗口 map: chatId -> { msgId, expiresAt, seqUsed }
  const passiveContexts = new Map();

  function updateStatus(newState, newDetail) {
    state = newState;
    detail = newDetail;
    log.info(`状态变更为: ${state} (${detail})`);
  }

  function getApiBase() {
    if (adapterConfig.sandbox) {
      return 'https://sandbox.api.sgroup.qq.com';
    }
    return 'https://api.bot.qq.com';
  }

  /**
   * 获取或刷新 AccessToken (带 120s 预刷新与 401 强制刷新)
   */
  async function getAccessToken(forceRefresh = false) {
    const appId = adapterConfig.appId;
    const clientSecret = adapterConfig.clientSecret;

    if (!appId || !clientSecret) {
      throw new Error('未配置 appId 或 clientSecret');
    }

    const now = Date.now();
    if (!forceRefresh && accessToken && now < tokenExpiresAt) {
      return accessToken;
    }

    log.info('正在向 QQ 官方获取 AccessToken...');
    const url = 'https://api.bot.qq.com/app/getAppAccessToken';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`获取 AppAccessToken 失败 HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error(`获取 AppAccessToken 返回异常: ${JSON.stringify(data)}`);
    }

    accessToken = data.access_token;
    // expires_in 为秒数，提前 120s 刷新
    const expiresInMs = (data.expires_in || 7200) * 1000;
    tokenExpiresAt = Date.now() + Math.max(0, expiresInMs - 120000);
    log.info('获取 AccessToken 成功');
    return accessToken;
  }

  /**
   * 清理过期的被动回复窗口
   */
  function cleanExpiredContexts() {
    const now = Date.now();
    for (const [chatId, ctxInfo] of passiveContexts.entries()) {
      if (now >= ctxInfo.expiresAt) {
        passiveContexts.delete(chatId);
      }
    }
  }

  /**
   * 记录被动回复上下文 (5 分钟有效期)
   */
  function recordPassiveContext(chatId, msgId) {
    cleanExpiredContexts();
    passiveContexts.set(chatId, {
      msgId,
      expiresAt: Date.now() + 5 * 60 * 1000,
      seqUsed: 0,
    });
  }

  /**
   * 处理 WebSocket 发来的 JSON 协议帧
   */
  async function handleWsFrame(frame) {
    if (!frame || typeof frame !== 'object') return;

    // 记录序列号
    if (frame.s !== undefined && frame.s !== null) {
      lastSequence = frame.s;
    }

    // op 10: HELLO -> 开启心跳 & 发送 IDENTIFY
    if (frame.op === 10) {
      const interval = frame.d?.heartbeat_interval || 30000;
      log.info(`收到 HELLO 帧，心跳间隔: ${interval}ms`);

      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({ op: 1, d: lastSequence }));
        }
      }, interval);

      // 发送 IDENTIFY 帧
      await sendIdentifyFrame();
      return;
    }

    // op 11: HEARTBEAT_ACK -> 忽略
    if (frame.op === 11) {
      return;
    }

    // op 7 (RECONNECT) 或 op 9 (INVALID_SESSION) -> 断开重连
    if (frame.op === 7 || frame.op === 9) {
      log.warn(`收到 op ${frame.op} 帧，触发重新建立全新连接`);
      if (wsClient) wsClient.close();
      return;
    }

    // op 0: DISPATCH 事件分发
    if (frame.op === 0) {
      const t = frame.t;
      const d = frame.d || {};

      if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'C2C_MESSAGE_CREATE') {
        const isGroup = t === 'GROUP_AT_MESSAGE_CREATE';
        const rawContent = (d.content || '').replace(/^\s+/, '').trim();
        const msgId = d.id;

        const userId = isGroup ? String(d.author?.member_openid || '') : String(d.author?.user_openid || '');
        const chatId = isGroup ? String(d.group_openid || '') : String(d.author?.user_openid || '');
        const userName = d.author?.username || userId;

        log.info(`收到 QQ 官方消息 (${isGroup ? '群聊' : '单聊'} ${chatId}): ${rawContent}`);

        // 记录被动回复上下文
        if (msgId) {
          recordPassiveContext(chatId, msgId);
        }

        core.onMessage({
          adapter: kind,
          chatId,
          userId,
          userName,
          text: rawContent,
          isGroup,
          reply: async (replyText) => {
            await sendText({ type: isGroup ? 'group' : 'private', id: chatId }, replyText);
          }
        });
      }
    }
  }

  /**
   * 发送 IDENTIFY 身份验证帧
   */
  async function sendIdentifyFrame() {
    try {
      const token = await getAccessToken();
      const intents = adapterConfig.intents !== undefined ? adapterConfig.intents : (1 << 25);

      const identifyPayload = {
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents,
          shard: [0, 1],
          properties: {}
        }
      };

      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify(identifyPayload));
        updateStatus('connected', '已连接至 QQ 官方 Gateway');
        scheduler.reset();
      }
    } catch (e) {
      log.error('发送 IDENTIFY 帧失败:', e);
      updateStatus('error', e.message);
    }
  }

  /**
   * 连接 QQ 官方 WebSocket Gateway
   */
  async function connectWs() {
    if (isStopped) return;

    if (!adapterConfig.appId || !adapterConfig.clientSecret) {
      updateStatus('error', '未配置凭证 (appId / clientSecret)');
      return;
    }

    updateStatus('starting', '连接中...');

    try {
      let wsUrl = adapterConfig.gatewayUrl;
      if (!wsUrl) {
        wsUrl = adapterConfig.sandbox
          ? 'wss://api.sgroup.qq.com/websocket/'
          : 'wss://api.sgroup.qq.com/websocket';
      }

      wsClient = new WebSocket(wsUrl);

      wsClient.onopen = () => {
        log.info('WebSocket 物理连接建立成功');
      };

      wsClient.onmessage = (evt) => {
        try {
          const frame = JSON.parse(evt.data);
          handleWsFrame(frame);
        } catch (e) {
          log.error('解析 WS 帧失败:', e);
        }
      };

      wsClient.onclose = (evt) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        wsClient = null;
        if (!isStopped) {
          updateStatus('reconnecting', `连接断开 (code: ${evt.code})，准备重连...`);
          scheduler.schedule();
        }
      };

      wsClient.onerror = (err) => {
        log.error('WebSocket 异常:', err);
      };

    } catch (e) {
      log.error('建立 WebSocket 连接抛错:', e);
      updateStatus('error', e.message);
      scheduler.schedule();
    }
  }

  /**
   * 发送 REST 消息（被动回复，带有 5 条/5 分钟限制处理）
   */
  async function sendText(target, text, opts = {}) {
    if (!text) return;

    const targetType = typeof target === 'string' ? 'private' : (target.type || 'private');
    const targetId = typeof target === 'string' ? target : String(target.id || '');

    // 检查被动回复上下文
    cleanExpiredContexts();
    const ctxInfo = passiveContexts.get(targetId);

    if (!ctxInfo) {
      log.warn(`QQ 官方不支持主动推送消息。目标 [${targetId}] 的被动回复 5 分钟窗口已失效或不存在。`);
      return;
    }

    if (ctxInfo.seqUsed >= 5) {
      log.warn(`目标 [${targetId}] 的被动回复条数已达上线 (5条限制)，无法继续回发。`);
      return;
    }

    const remainingSeq = 5 - ctxInfo.seqUsed;
    let chunks = splitText(text, 500); // QQ 官方每块 500 字符限制

    // 如果分块数大于剩余可用 seq，把超出的块合并到最后一块，确保不超过 5 条上限
    if (chunks.length > remainingSeq) {
      const keep = chunks.slice(0, remainingSeq - 1);
      const mergedTail = chunks.slice(remainingSeq - 1).join('\n');
      chunks = [...keep, mergedTail];
    }

    const isGroup = targetType === 'group';
    const apiBase = getApiBase();
    const endpoint = isGroup
      ? `${apiBase}/v2/groups/${targetId}/messages`
      : `${apiBase}/v2/users/${targetId}/messages`;

    for (const chunk of chunks) {
      if (!chunk) continue;
      ctxInfo.seqUsed += 1;

      await sendSingleRestMsg(endpoint, {
        msg_type: 0,
        content: chunk,
        msg_id: ctxInfo.msgId,
        msg_seq: ctxInfo.seqUsed,
      });
    }
  }

  /**
   * 发送单条 REST 消息 (含 401 刷新 token 和 429 限速等待重试)
   */
  async function sendSingleRestMsg(url, bodyObj, retryCount = 1) {
    let token = await getAccessToken();

    async function doFetch() {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `QQBot ${token}`,
          'X-Union-Appid': String(adapterConfig.appId || '')
        },
        body: JSON.stringify(bodyObj)
      });
    }

    let res = await doFetch();

    // 401 凭证失效 -> 强制刷新重试 1 次
    if (res.status === 401 && retryCount > 0) {
      log.warn('QQ REST API 返回 401，强制刷新 Token 并重试...');
      token = await getAccessToken(true);
      res = await doFetch();
    }

    // 429 限速 -> 按照 retry_after 等待后重试 1 次
    if (res.status === 429 && retryCount > 0) {
      let retryAfterSec = 1;
      try {
        const errJson = await res.json();
        retryAfterSec = errJson.retry_after || errJson.d?.retry_after || 1;
      } catch {}
      log.warn(`QQ REST API 返回 429 限速，等待 ${retryAfterSec} 秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));
      return await sendSingleRestMsg(url, bodyObj, retryCount - 1);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.error(`发送 QQ 官方 REST 消息失败 HTTP ${res.status}: ${errText}`);
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

      isStopped = false;
      scheduler = createBackoffScheduler({
        minDelay: 1000,
        maxDelay: 30000,
        factor: 2,
        onRetry: () => {
          connectWs();
        }
      });

      await connectWs();
    },

    async stop() {
      isStopped = true;
      if (scheduler) {
        scheduler.stop();
        scheduler = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (wsClient) {
        try { wsClient.close(); } catch {}
        wsClient = null;
      }
      passiveContexts.clear();
      updateStatus('disabled', '已停止');
    },

    status() {
      return { state, detail };
    },

    sendText,
  };
}
