/**
 * @file lib/adapters/onebot11.js
 * @description OneBot v11 适配器（QQ 个人号），支持 forward-ws 客户端与 reverse-ws 服务器模式、
 *              自动学习 selfId、消息切块与发送、@ 触发解析。
 */

import { createLogger, createBackoffScheduler, splitText, createWsServer } from '../util.js?v=10';

/**
 * 工厂函数：创建 OneBot v11 适配器
 * @param {string} kind - 'onebot11'
 * @param {object} adapterConfig - onebot11 配置
 * @param {object} deps - { log, core, config }
 */
export function createAdapter(kind, adapterConfig, deps) {
  const log = deps.log || createLogger('onebot11');
  const core = deps.core;

  let state = 'starting'; // starting | connected | reconnecting | error | disabled
  let detail = '初始化中';
  let selfId = String(adapterConfig.selfId || '0');

  let wsClient = null; // forward-ws client
  let wsServerObj = null; // reverse-ws server
  let activeConn = null; // 当前活跃的 WS 连接 (forward 或 reverse)
  let scheduler = null;
  let isStopped = false;

  const echoCallbacks = new Map();

  function updateStatus(newState, newDetail) {
    state = newState;
    detail = newDetail;
    log.info(`状态变更为: ${state} (${detail})`);
  }

  /**
   * 清洗与解析包含 CQ 码或数组形式的 OneBot 消息
   */
  function extractMessageText(rawMsg) {
    if (typeof rawMsg === 'string') {
      // 剥离 CQ 码 [CQ:at,qq=123] 等
      return rawMsg.replace(/\[CQ:[^\]]+\]/g, '').trim();
    }
    if (Array.isArray(rawMsg)) {
      let text = '';
      for (const seg of rawMsg) {
        if (seg.type === 'text') {
          text += seg.data?.text || '';
        }
      }
      return text.trim();
    }
    return '';
  }

  /**
   * 检查群聊消息是否触发，并剥离 @/前缀 提取纯文本
   */
  function checkGroupTrigger(rawMsg, msgText) {
    const trigger = adapterConfig.groupTrigger || 'mention';
    const prefix = adapterConfig.groupPrefix || '/bot';

    if (trigger === 'prefix') {
      if (msgText.startsWith(prefix)) {
        return { triggered: true, text: msgText.slice(prefix.length).trim() };
      }
      return { triggered: false, text: '' };
    }

    // mention (@) 模式
    let isAtMe = false;
    if (Array.isArray(rawMsg)) {
      isAtMe = rawMsg.some((seg) => seg.type === 'at' && String(seg.data?.qq) === String(selfId));
    } else if (typeof rawMsg === 'string') {
      isAtMe = rawMsg.includes(`[CQ:at,qq=${selfId}]`) || rawMsg.includes(`@${selfId}`);
    }

    if (isAtMe) {
      return { triggered: true, text: msgText };
    }

    return { triggered: false, text: '' };
  }

  /**
   * 处理 OneBot 接收到的 JSON 事件包
   */
  function handleOneBotEvent(event, sendRaw) {
    if (!event || typeof event !== 'object') return;

    // 处理 API 回包 echo 匹配
    if (event.echo && echoCallbacks.has(event.echo)) {
      const cb = echoCallbacks.get(event.echo);
      echoCallbacks.delete(event.echo);
      cb(event);
      return;
    }

    // 元事件：生命周期学习 selfId
    if (event.post_type === 'meta_event') {
      if (event.self_id) {
        selfId = String(event.self_id);
        log.info(`自动学习获得机器人 selfId: ${selfId}`);
      }
      return;
    }

    // 消息事件
    if (event.post_type === 'message') {
      const isGroup = event.message_type === 'group';
      const userId = String(event.user_id || '');
      const chatId = isGroup ? String(event.group_id || '') : userId;
      const userName = event.sender?.card || event.sender?.nickname || userId;

      if (event.self_id) {
        selfId = String(event.self_id);
      }

      const rawMsg = event.message;
      const fullText = extractMessageText(rawMsg);

      let textToProcess = fullText;
      if (isGroup) {
        const check = checkGroupTrigger(rawMsg, fullText);
        if (!check.triggered) return; // 未触发 @ 或 前缀
        textToProcess = check.text;
      }

      log.info(`收到消息 (${isGroup ? '群聊' : '私聊'} ${chatId} / 用户 ${userId}): ${textToProcess}`);

      // 触发 core 核心路由
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
  }

  /**
   * 向 外部/客户端 发送原始 JSON 包
   */
  function sendJson(action, params) {
    return new Promise((resolve) => {
      if (!activeConn) {
        log.warn('无法发送 WS 消息：连接未就绪');
        resolve({ status: 'failed', retcode: -1, message: 'WS not connected' });
        return;
      }

      const echo = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const payload = JSON.stringify({ action, params, echo });

      echoCallbacks.set(echo, resolve);

      // 设置 10 秒超时清理回调
      setTimeout(() => {
        if (echoCallbacks.has(echo)) {
          echoCallbacks.delete(echo);
          resolve({ status: 'timeout', retcode: -1 });
        }
      }, 10000);

      try {
        if (activeConn.send) {
          activeConn.send(payload);
        } else if (activeConn.socket) {
          activeConn.send(payload);
        }
      } catch (e) {
        log.error('发送 OneBot WS 消息失败:', e);
        echoCallbacks.delete(echo);
        resolve({ status: 'error', retcode: -1, error: String(e) });
      }
    });
  }

  /**
   * 启动 forward-ws 模式 (全局 WebSocket 客户端)
   */
  function startForwardWs() {
    if (isStopped) return;

    let url = adapterConfig.url || 'ws://127.0.0.1:3001';
    if (adapterConfig.accessToken) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}access_token=${encodeURIComponent(adapterConfig.accessToken)}`;
    }

    updateStatus('starting', `连接中 ${adapterConfig.url}`);

    try {
      wsClient = new WebSocket(url);

      wsClient.onopen = () => {
        if (isStopped) {
          wsClient.close();
          return;
        }
        updateStatus('connected', `已连接到 NapCat/OneBot (${url})`);
        scheduler.reset();

        activeConn = {
          send: (msg) => wsClient.send(msg),
          close: () => wsClient.close(),
        };

        // 发送 get_login_info 自动学习 selfId
        sendJson('get_login_info', {}).then((res) => {
          if (res?.data?.user_id) {
            selfId = String(res.data.user_id);
            log.info(`API 获取 selfId: ${selfId}`);
          }
        });
      };

      wsClient.onmessage = (evt) => {
        try {
          const event = JSON.parse(evt.data);
          handleOneBotEvent(event);
        } catch (e) {
          log.error('解析 OneBot 事件 JSON 失败:', e);
        }
      };

      wsClient.onclose = (evt) => {
        activeConn = null;
        if (!isStopped) {
          updateStatus('reconnecting', `连接断开 (code: ${evt.code})，准备重连...`);
          scheduler.schedule();
        }
      };

      wsClient.onerror = (err) => {
        log.error('WebSocket 客户端报错:', err);
      };

    } catch (err) {
      log.error('创建 WebSocket 客户端抛错:', err);
      updateStatus('error', err.message || '连接错误');
      scheduler.schedule();
    }
  }

  /**
   * 启动 reverse-ws 模式 (服务器模式)
   */
  function startReverseWs() {
    const port = adapterConfig.listenPort || 3002;
    const host = adapterConfig.listenHost || '127.0.0.1';

    updateStatus('starting', `监听端口 ${host}:${port}`);

    wsServerObj = createWsServer({
      port,
      host,
      onConnection(conn) {
        // 校验 access_token (如果有配置)
        if (adapterConfig.accessToken) {
          const reqUrl = conn.req.url || '';
          const tokenMatch = reqUrl.match(/access_token=([^&]+)/);
          const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : '';
          if (token !== adapterConfig.accessToken) {
            log.warn('反向 WS 鉴权失败，拒绝连接');
            conn.close(4001, 'Unauthorized token');
            return;
          }
        }

        log.info('反向 WS 收到客户端连接');
        activeConn = conn;
        updateStatus('connected', `客户端已连接至反向 WS (端口 ${port})`);
      },
      onMessage(conn, data) {
        try {
          const event = JSON.parse(data);
          handleOneBotEvent(event);
        } catch (e) {
          log.error('反向 WS 解析事件失败:', e);
        }
      },
      onClose(conn) {
        if (activeConn === conn) {
          activeConn = null;
          updateStatus('starting', `反向 WS 等待客户端连接 (端口 ${port})`);
        }
      },
      onError(err) {
        log.error('反向 WS 服务器报错:', err);
        updateStatus('error', err.message || 'WS 服务器错误');
      }
    });
  }

  /**
   * 发送文本消息（自动切块）
   */
  async function sendText(target, text, opts = {}) {
    if (!text) return;

    const maxChars = Math.min(1800, deps.config?.replyChunkChars || 1800);
    const chunks = splitText(text, maxChars);

    const targetType = typeof target === 'string' ? 'private' : (target.type || 'private');
    const targetId = typeof target === 'string' ? target : String(target.id || '');

    for (const chunk of chunks) {
      if (!chunk) continue;
      const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params = targetType === 'group'
        ? { group_id: targetId, message: [{ type: 'text', data: { text: chunk } }] }
        : { user_id: targetId, message: [{ type: 'text', data: { text: chunk } }] };

      await sendJson(action, params);
    }
  }

  return {
    kind,
    deps,
    get selfId() { return selfId; },

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
          if (adapterConfig.mode === 'forward-ws') {
            startForwardWs();
          }
        }
      });

      if (adapterConfig.mode === 'reverse-ws') {
        startReverseWs();
      } else {
        startForwardWs();
      }
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
      if (wsServerObj) {
        try { await wsServerObj.close(); } catch {}
        wsServerObj = null;
      }
      activeConn = null;
      updateStatus('disabled', '已停止');
    },

    status() {
      return { state, detail, selfId };
    },

    sendText,
  };
}
