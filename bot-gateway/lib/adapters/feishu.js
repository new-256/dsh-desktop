/**
 * @file lib/adapters/feishu.js
 * @description 飞书长连接适配器，基于 protobuf Frame 消息协议接收群/私聊事件、
 *              自动发送 ACK、多分片重组、心跳保活及 tenant_access_token 管理。
 */

import { createLogger, createBackoffScheduler, splitText, fetchJson } from '../util.js?v=10';
import { encodeFrame, decodeFrame } from '../pb.js?v=10';

/**
 * 工厂函数：创建飞书长连接适配器
 * @param {string} kind - 'feishu'
 * @param {object} adapterConfig - 配置对象
 * @param {object} deps - { log, core, config }
 */
export function createAdapter(kind, adapterConfig, deps) {
  const log = deps.log || createLogger('feishu');
  const core = deps.core;

  let state = 'starting'; // starting | connected | reconnecting | error | disabled
  let detail = '初始化中';

  let tenantToken = '';
  let tokenExpiresAt = 0;

  let wsClient = null;
  let scheduler = null;
  let pingTimer = null;
  let serviceId = 0;
  let isStopped = false;

  // 消息分片缓冲: message_id -> { sum, segments: Map<seq, Uint8Array> }
  const pendingSegments = new Map();

  function updateStatus(newState, newDetail) {
    state = newState;
    detail = newDetail;
    log.info(`状态变更为: ${state} (${detail})`);
  }

  function getDomain() {
    const d = adapterConfig.domain || 'https://open.feishu.cn';
    return d.replace(/\/+$/, '');
  }

  /**
   * 获取或刷新 TenantAccessToken (缓存并在提前 300s 时刷新)
   */
  async function getTenantAccessToken(forceRefresh = false) {
    const appId = adapterConfig.appId;
    const appSecret = adapterConfig.appSecret;

    if (!appId || !appSecret) {
      throw new Error('未配置 appId 或 appSecret');
    }

    const now = Date.now();
    if (!forceRefresh && tenantToken && now < tokenExpiresAt) {
      return tenantToken;
    }

    log.info('正在向飞书获取 tenant_access_token...');
    const url = `${getDomain()}/open-apis/auth/v3/tenant_access_token/internal`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`获取 tenant_access_token 失败 HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (!data.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 返回异常: ${JSON.stringify(data)}`);
    }

    tenantToken = data.tenant_access_token;
    const expireSec = data.expire || 7200;
    tokenExpiresAt = Date.now() + Math.max(0, (expireSec - 300) * 1000);
    log.info('获取 tenant_access_token 成功');
    return tenantToken;
  }

  /**
   * 请求飞书 WebSocket 长连接 Endpoint
   */
  async function fetchWsEndpoint() {
    const appId = adapterConfig.appId;
    const appSecret = adapterConfig.appSecret;

    if (!appId || !appSecret) {
      throw new Error('未配置 appId 或 appSecret');
    }

    const url = `${getDomain()}/callback/ws/endpoint`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`获取飞书 WS endpoint 失败 HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (data.code !== 0 || !data.data?.URL) {
      throw new Error(`获取飞书 WS endpoint 异常: ${JSON.stringify(data)}`);
    }

    return {
      url: data.data.URL,
      pingInterval: data.data.ClientConfig?.PingInterval || 120,
    };
  }

  /**
   * 发送 ACK 响应给飞书长连接服务端
   */
  function sendAckFrame(rawFrame) {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;

    try {
      const ackHeaders = [
        ...(rawFrame.headers || []),
        { key: 'biz_rt', value: '0' }
      ];

      const ackPayload = new TextEncoder().encode(JSON.stringify({ code: 200 }));
      const ackFrame = {
        SeqID: rawFrame.SeqID || 0,
        LogID: rawFrame.LogID || 0,
        service: rawFrame.service || serviceId,
        method: rawFrame.method || 1,
        headers: ackHeaders,
        payloadEncoding: rawFrame.payloadEncoding || '',
        payloadType: rawFrame.payloadType || '',
        payload: ackPayload,
        LogIDNew: rawFrame.LogIDNew || ''
      };

      const ackBuf = encodeFrame(ackFrame);
      wsClient.send(ackBuf);
    } catch (e) {
      log.error('发送飞书 ACK 帧失败:', e);
    }
  }

  /**
   * 处理解包后的 Protobuf Frame
   */
  function handleProtobufFrame(frame) {
    if (frame.method === 0) {
      // control 帧：pong 忽略
      return;
    }

    if (frame.method === 1) {
      // data 帧 (包含事件推送)
      const headersMap = new Map();
      for (const h of frame.headers || []) {
        headersMap.set(h.key, h.value);
      }

      const type = headersMap.get('type');
      const messageId = headersMap.get('message_id');
      const sum = Number(headersMap.get('sum') || '1');
      const seq = Number(headersMap.get('seq') || '0');

      // 如果有事件数据，优先回发 ACK
      sendAckFrame(frame);

      if (type === 'event' && messageId) {
        // 多分片拼接重组
        if (!pendingSegments.has(messageId)) {
          pendingSegments.set(messageId, { sum, segments: new Map() });
        }
        const record = pendingSegments.get(messageId);
        record.segments.set(seq, frame.payload);

        if (record.segments.size >= record.sum) {
          // 全部分片到齐
          const sortedBufs = [];
          for (let i = 0; i < record.sum; i++) {
            sortedBufs.push(record.segments.get(i) || new Uint8Array(0));
          }
          pendingSegments.delete(messageId);

          const totalLen = sortedBufs.reduce((acc, b) => acc + b.length, 0);
          const fullBuffer = new Uint8Array(totalLen);
          let off = 0;
          for (const b of sortedBufs) {
            fullBuffer.set(b, off);
            off += b.length;
          }

          const jsonStr = new TextDecoder().decode(fullBuffer);
          try {
            const eventObj = JSON.parse(jsonStr);
            handleFeishuEvent(headersMap, eventObj);
          } catch (e) {
            log.error('解析飞书事件 JSON 失败:', e);
          }
        }
      }
    }
  }

  /**
   * 处理解析出的飞书 JSON 事件结构
   */
  function handleFeishuEvent(headersMap, eventObj) {
    const header = eventObj.header || {};
    if (header.event_type === 'im.message.receive_v1') {
      const event = eventObj.event || {};
      const msg = event.message || {};

      if (msg.message_type !== 'text') return; // 仅处理纯文本消息

      let text = '';
      try {
        text = JSON.parse(msg.content || '{}').text || '';
      } catch {
        text = msg.content || '';
      }

      if (!text.trim()) return;

      const chatId = String(msg.chat_id || '');
      const userId = String(event.sender?.sender_id?.open_id || '');
      const chatType = msg.chat_type || 'p2p';
      const isGroup = chatType === 'group';

      let cleanedText = text;
      if (isGroup) {
        // 群聊仅当有 mentions 时响应
        if (!Array.isArray(msg.mentions) || msg.mentions.length === 0) {
          return;
        }
        // 剥离所有的 @_user_1 等标记
        cleanedText = text.replace(/@_user_\d+/g, '').trim();
        if (!cleanedText) return;
      }

      log.info(`收到飞书消息 (${isGroup ? '群聊' : '单聊'} ${chatId}): ${cleanedText}`);

      core.onMessage({
        adapter: kind,
        chatId,
        userId,
        userName: userId,
        text: cleanedText,
        isGroup,
        reply: async (replyText) => {
          await sendText({ type: isGroup ? 'group' : 'private', id: chatId }, replyText);
        }
      });
    }
  }

  /**
   * 发送心跳 Ping 帧
   */
  function sendPingFrame() {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;

    try {
      const pingFrame = {
        SeqID: 0,
        LogID: 0,
        service: serviceId,
        method: 0, // control
        headers: [{ key: 'type', value: 'ping' }],
      };
      const pingBuf = encodeFrame(pingFrame);
      wsClient.send(pingBuf);
    } catch (e) {
      log.error('发送飞书心跳帧失败:', e);
    }
  }

  /**
   * 连接飞书 WebSocket 长连接
   */
  async function connectWs() {
    if (isStopped) return;

    if (!adapterConfig.appId || !adapterConfig.appSecret) {
      updateStatus('error', '未配置凭证 (appId / appSecret)');
      return;
    }

    updateStatus('starting', '连接中...');

    try {
      const { url: wsUrl, pingInterval } = await fetchWsEndpoint();

      // 解析 URL query 参数里的 service_id
      try {
        const parsedUrl = new URL(wsUrl);
        serviceId = Number(parsedUrl.searchParams.get('service_id') || 0);
      } catch {}

      wsClient = new WebSocket(wsUrl);
      wsClient.binaryType = 'arraybuffer';

      wsClient.onopen = () => {
        if (isStopped) {
          wsClient.close();
          return;
        }
        updateStatus('connected', '已建立飞书长连接');
        scheduler.reset();

        // 开启心跳定时器
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          sendPingFrame();
        }, (pingInterval || 120) * 1000);
      };

      wsClient.onmessage = (evt) => {
        try {
          const u8arr = new Uint8Array(evt.data);
          const frame = decodeFrame(u8arr);
          handleProtobufFrame(frame);
        } catch (e) {
          log.error('解码飞书 Protobuf 帧失败:', e);
        }
      };

      wsClient.onclose = (evt) => {
        if (pingTimer) clearInterval(pingTimer);
        wsClient = null;
        if (!isStopped) {
          updateStatus('reconnecting', `长连接断开 (code: ${evt.code})，准备重连...`);
          scheduler.schedule();
        }
      };

      wsClient.onerror = (err) => {
        log.error('飞书 WebSocket 异常:', err);
      };

    } catch (e) {
      log.error('建立飞书长连接抛错:', e);
      updateStatus('error', e.message);
      scheduler.schedule();
    }
  }

  /**
   * 发送 REST 文本消息 (3000 字符分块)
   */
  async function sendText(target, text, opts = {}) {
    if (!text) return;

    const targetId = typeof target === 'string' ? target : String(target.id || '');
    const chunks = splitText(text, 3000);

    for (const chunk of chunks) {
      if (!chunk) continue;
      await sendSingleRestMsg(targetId, chunk);
    }
  }

  /**
   * 发送单条 REST 消息
   */
  async function sendSingleRestMsg(chatId, textChunk, retryLeft = 1) {
    let token = await getTenantAccessToken();
    const url = `${getDomain()}/open-apis/im/v1/messages?receive_id_type=chat_id`;

    async function doFetch() {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: textChunk })
        })
      });
    }

    let res = await doFetch();

    if (res.status === 401 && retryLeft > 0) {
      log.warn('飞书 REST 返回 401，重新获取 Token 增强重试...');
      token = await getTenantAccessToken(true);
      res = await doFetch();
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.error(`发送飞书消息失败 HTTP ${res.status}: ${errText}`);
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
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (wsClient) {
        try { wsClient.close(); } catch {}
        wsClient = null;
      }
      pendingSegments.clear();
      updateStatus('disabled', '已停止');
    },

    status() {
      return { state, detail };
    },

    sendText,
  };
}
