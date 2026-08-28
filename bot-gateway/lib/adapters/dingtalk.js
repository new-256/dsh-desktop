/**
 * @file lib/adapters/dingtalk.js
 * @description 钉钉 Stream 模式适配器，实现 /v1.0/gateway/connections/open 建立长连接、
 *              SYSTEM 心跳/断开 ACK 应答、CALLBACK 机器人消息处理与 sessionWebhook 临时回复。
 */

import { createLogger, createBackoffScheduler, splitText, fetchJson } from '../util.js?v=10';

/**
 * 工厂函数：创建钉钉 Stream 模式适配器
 * @param {string} kind - 'dingtalk'
 * @param {object} adapterConfig - 配置对象
 * @param {object} deps - { log, core, config }
 */
export function createAdapter(kind, adapterConfig, deps) {
  const log = deps.log || createLogger('dingtalk');
  const core = deps.core;

  let state = 'starting'; // starting | connected | reconnecting | error | disabled
  let detail = '初始化中';

  let wsClient = null;
  let scheduler = null;
  let isStopped = false;

  // 临时 sessionWebhook 记录: chatId -> { webhook, expiredAt }
  const webhookContexts = new Map();

  function updateStatus(newState, newDetail) {
    state = newState;
    detail = newDetail;
    log.info(`状态变更为: ${state} (${detail})`);
  }

  /**
   * 清理过期的 sessionWebhook
   */
  function cleanExpiredWebhooks() {
    const now = Date.now();
    for (const [chatId, info] of webhookContexts.entries()) {
      if (now >= info.expiredAt) {
        webhookContexts.delete(chatId);
      }
    }
  }

  /**
   * 请求钉钉网关开启连接
   */
  async function openConnection() {
    const clientId = adapterConfig.clientId;
    const clientSecret = adapterConfig.clientSecret;

    if (!clientId || !clientSecret) {
      throw new Error('未配置 clientId 或 clientSecret');
    }

    const url = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        subscriptions: [
          { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`connections/open 失败 HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (!data.endpoint || !data.ticket) {
      throw new Error(`connections/open 返回异常: ${JSON.stringify(data)}`);
    }

    return {
      endpoint: data.endpoint,
      ticket: data.ticket,
    };
  }

  /**
   * 发送钉钉 Stream 帧 ACK 应答
   */
  function sendStreamAck(messageId, responseData = null) {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;

    try {
      const ackObj = {
        code: 200,
        headers: {
          contentType: 'application/json',
          messageId: messageId,
        },
        message: 'OK',
        data: responseData !== null ? responseData : undefined,
      };

      wsClient.send(JSON.stringify(ackObj));
    } catch (e) {
      log.error('发送钉钉 Stream ACK 失败:', e);
    }
  }

  /**
   * 处理钉钉 Stream 收到的文本 JSON 帧
   */
  function handleStreamFrame(frame) {
    if (!frame || typeof frame !== 'object') return;

    const type = frame.type;
    const headers = frame.headers || {};
    const messageId = headers.messageId;

    // 1. SYSTEM 心跳与通知
    if (type === 'SYSTEM') {
      if (headers.topic === 'ping') {
        sendStreamAck(messageId, frame.data);
        return;
      }
      if (headers.topic === 'disconnect') {
        sendStreamAck(messageId, frame.data);
        log.warn('收到钉钉服务端 disconnect 指令，关闭连接准备重连...');
        if (wsClient) wsClient.close();
        return;
      }
      if (headers.topic === 'CONNECTED' || headers.topic === 'REGISTERED') {
        log.info(`钉钉 Stream 状态通知: ${headers.topic}`);
        return;
      }
    }

    // 2. CALLBACK 机器人消息推送
    if (type === 'CALLBACK' && headers.topic === '/v1.0/im/bot/messages/get') {
      // 必须给服务端回发成功的 ACK 数据包
      const ackData = JSON.stringify({ response: { status: 'SUCCESS', message: 'ok' } });
      sendStreamAck(messageId, ackData);

      let msgData = {};
      try {
        msgData = typeof frame.data === 'string' ? JSON.parse(frame.data) : (frame.data || {});
      } catch (e) {
        log.error('解析 RobotTextMessage 失败:', e);
        return;
      }

      const conversationType = msgData.conversationType; // '1' 单聊 / '2' 群聊
      const isGroup = conversationType === '2';
      const chatId = String(msgData.conversationId || '');
      const userId = String(msgData.senderStaffId || msgData.senderId || '');
      const userName = msgData.senderNick || userId;
      const rawText = (msgData.text?.content || '').trim();

      if (!rawText) return;

      // 记录/更新临时 sessionWebhook
      if (msgData.sessionWebhook && chatId) {
        cleanExpiredWebhooks();
        const expireTime = Number(msgData.sessionWebhookExpiredTime || (Date.now() + 90 * 60 * 1000));
        webhookContexts.set(chatId, {
          webhook: msgData.sessionWebhook,
          expiredAt: expireTime,
        });
      }

      log.info(`收到钉钉消息 (${isGroup ? '群聊' : '单聊'} ${chatId}): ${rawText}`);

      core.onMessage({
        adapter: kind,
        chatId,
        userId,
        userName,
        text: rawText,
        isGroup,
        reply: async (replyText) => {
          await sendText({ type: isGroup ? 'group' : 'private', id: chatId }, replyText);
        }
      });
    }
  }

  /**
   * 建立钉钉 Stream WebSocket 连接
   */
  async function connectWs() {
    if (isStopped) return;

    if (!adapterConfig.clientId || !adapterConfig.clientSecret) {
      updateStatus('error', '未配置凭证 (clientId / clientSecret)');
      return;
    }

    updateStatus('starting', '连接中...');

    try {
      const { endpoint, ticket } = await openConnection();
      const wsUrl = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;

      wsClient = new WebSocket(wsUrl);

      wsClient.onopen = () => {
        if (isStopped) {
          wsClient.close();
          return;
        }
        updateStatus('connected', '已连接至钉钉 Stream 网关');
        scheduler.reset();
      };

      wsClient.onmessage = (evt) => {
        try {
          const frame = JSON.parse(evt.data);
          handleStreamFrame(frame);
        } catch (e) {
          log.error('解析钉钉 Stream 帧 JSON 失败:', e);
        }
      };

      wsClient.onclose = (evt) => {
        wsClient = null;
        if (!isStopped) {
          updateStatus('reconnecting', `连接断开 (code: ${evt.code})，准备重连...`);
          scheduler.schedule();
        }
      };

      wsClient.onerror = (err) => {
        log.error('钉钉 WebSocket 异常:', err);
      };

    } catch (e) {
      log.error('建立钉钉 Stream 连接抛错:', e);
      updateStatus('error', e.message);
      scheduler.schedule();
    }
  }

  /**
   * 发送 REST 文本消息 (使用 sessionWebhook 临时地址，支持 Markdown 分块)
   */
  async function sendText(target, text, opts = {}) {
    if (!text) return;

    const targetId = typeof target === 'string' ? target : String(target.id || '');

    cleanExpiredWebhooks();
    const webhookInfo = webhookContexts.get(targetId);

    if (!webhookInfo || Date.now() >= webhookInfo.expiredAt) {
      log.warn(`钉钉 sessionWebhook 已过期或不存在，提示用户重发。`);
      // 如果触发 core reply 提示
      if (deps.core && typeof deps.core.onMessage === 'function') {
        log.error(`会话 webhook 已过期，请重新发送一条消息`);
      }
      return;
    }

    const chunks = splitText(text, 3000);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;

      const title = chunks.length > 1 ? `DSH 任务 (${i + 1}/${chunks.length})` : 'DSH 任务';
      await sendWebhookMsg(webhookInfo.webhook, title, chunk);
    }
  }

  /**
   * 向 sessionWebhook 发送 POST Markdown 消息
   */
  async function sendWebhookMsg(webhookUrl, title, markdownText) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: {
            title,
            text: markdownText,
          }
        })
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        log.error(`发送钉钉 sessionWebhook 消息失败 HTTP ${res.status}: ${errText}`);
      }
    } catch (e) {
      log.error('发送钉钉 sessionWebhook 消息抛错:', e);
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
        minDelay: 2000,
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
      if (wsClient) {
        try { wsClient.close(); } catch {}
        wsClient = null;
      }
      webhookContexts.clear();
      updateStatus('disabled', '已停止');
    },

    status() {
      return { state, detail };
    },

    sendText,
  };
}
