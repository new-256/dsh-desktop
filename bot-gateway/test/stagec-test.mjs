/**
 * @file test/stagec-test.mjs
 * @description Stage C 独立测试：lib/pb.js Protobuf 编解码回环校验、
 *              飞书长连接 ACK 与分片处理、钉钉 Stream 心跳与 sessionWebhook 消息发送。
 */

import { encodeFrame, decodeFrame, encodeHeader, decodeHeader } from '../lib/pb.js';
import { createAdapter as createFeishuAdapter } from '../lib/adapters/feishu.js';
import { createAdapter as createDingtalkAdapter } from '../lib/adapters/dingtalk.js';
import { createWsServer } from '../lib/util.js';
import { createServer } from 'node:http';

async function runStageCTest() {
  console.log('[stagec-test] 🚀 开始 Stage C 协议与编解码测试...\n');

  // ==========================================
  // 测试 1: lib/pb.js Protobuf 编解码回环
  // ==========================================
  console.log('--- 测试 1: Protobuf 编解码回环 (lib/pb.js) ---');
  const originalFrame = {
    SeqID: 1001,
    LogID: 2002,
    service: 100,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'msg_001' },
      { key: 'sum', value: '1' }
    ],
    payloadEncoding: 'utf8',
    payloadType: 'json',
    payload: new TextEncoder().encode(JSON.stringify({ test: 'pb payload' })),
    LogIDNew: 'log_new_999'
  };

  const encodedU8 = encodeFrame(originalFrame);
  const decodedFrame = decodeFrame(encodedU8);

  if (decodedFrame.SeqID !== originalFrame.SeqID || decodedFrame.LogID !== originalFrame.LogID) {
    throw new Error('SeqID/LogID protobuf 解码失败');
  }
  if (decodedFrame.headers.length !== 3 || decodedFrame.headers[0].key !== 'type' || decodedFrame.headers[0].value !== 'event') {
    throw new Error('headers protobuf 解码失败');
  }
  const decodedPayloadText = new TextDecoder().decode(decodedFrame.payload);
  if (!decodedPayloadText.includes('pb payload')) {
    throw new Error('payload protobuf 解码失败');
  }
  console.log('  ✅ Protobuf 结构体编码/解码回环校验成功！');

  // Spot Check: SPEC ping 帧特征字节断言
  const pingFrame = {
    SeqID: 0,
    LogID: 0,
    service: 100,
    method: 0,
    headers: [{ key: 'type', value: 'ping' }]
  };
  const pingU8 = encodeFrame(pingFrame);
  // service=100 -> tag=(3<<3)|0 = 24 (0x18), 100 对应的 varint 为 [100] (0x64)
  if (!pingU8.includes(0x18) || !pingU8.includes(0x64)) {
    throw new Error('Ping 帧 Spot Check 校验失败');
  }
  console.log('  ✅ Ping 帧 Spot Check 特征字节校验成功！');


  // ==========================================
  // 测试 2: 飞书长连接适配器 (lib/adapters/feishu.js)
  // ==========================================
  console.log('\n--- 测试 2: 飞书长连接适配器 ---');
  let fsAckFrameReceived = null;
  let fsRestSentBody = null;

  const fsHttpPort = 18997;
  const fsWsPort = 18998;

  // Mock HTTP
  const fsHttpServer = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = req.url;
      if (url.includes('/callback/ws/endpoint')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: {
            URL: `ws://127.0.0.1:${fsWsPort}?device_id=d1&service_id=100`,
            ClientConfig: { PingInterval: 120 }
          }
        }));
        return;
      }
      if (url.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tenant_access_token: 'mock_fs_token_123', expire: 7200 }));
        return;
      }
      if (url.includes('/open-apis/im/v1/messages')) {
        try {
          fsRestSentBody = JSON.parse(body);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, msg: 'success' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => fsHttpServer.listen(fsHttpPort, '127.0.0.1', r));

  // Mock WS Server (处理 二进制 Frame)
  const fsWsServer = createWsServer({
    port: fsWsPort,
    host: '127.0.0.1',
    onConnection(conn) {
      // 客户端连上后，推送一条二进制事件数据帧
      const eventPayloadObj = {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_id: { open_id: 'fs_user_openid_1' } },
          message: {
            chat_id: 'oc_fs_chat_888',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'hello feishu stagec' })
          }
        }
      };

      const eventFrame = {
        SeqID: 100,
        LogID: 200,
        service: 100,
        method: 1,
        headers: [
          { key: 'type', value: 'event' },
          { key: 'message_id', value: 'msg_fs_1001' },
          { key: 'sum', value: '1' },
          { key: 'seq', value: '0' }
        ],
        payload: new TextEncoder().encode(JSON.stringify(eventPayloadObj))
      };

      const u8 = encodeFrame(eventFrame);
      conn.send(u8);
    },
    onMessage(conn, data, isBinary) {
      if (isBinary) {
        try {
          const u8 = new Uint8Array(data);
          const ackFrame = decodeFrame(u8);
          fsAckFrameReceived = ackFrame;
        } catch (e) {
          console.error('ACK 帧解码失败:', e);
        }
      }
    }
  });

  let fsCoreReceivedText = '';
  const mockFsCore = {
    onMessage({ adapter, chatId, userId, text, reply }) {
      fsCoreReceivedText = text;
      reply('飞书回复测试');
    }
  };

  const fsAdapterConfig = {
    enabled: true,
    appId: 'cli_fs_app_123',
    appSecret: 'fs_secret_abc',
    domain: `http://127.0.0.1:${fsHttpPort}`,
    allowUsers: ['fs_user_openid_1']
  };

  const fsAdapter = createFeishuAdapter('feishu', fsAdapterConfig, { core: mockFsCore });
  await fsAdapter.start();

  await new Promise((r) => setTimeout(r, 600));

  if (fsCoreReceivedText !== 'hello feishu stagec') {
    throw new Error(`飞书事件文本接收断言失败: "${fsCoreReceivedText}"`);
  }

  if (!fsAckFrameReceived) {
    throw new Error('飞书 ACK 帧发送断言失败 (未收到 ACK)');
  }
  const bizRtHeader = fsAckFrameReceived.headers.find(h => h.key === 'biz_rt');
  if (!bizRtHeader || bizRtHeader.value !== '0') {
    throw new Error(`飞书 ACK 帧 biz_rt 标头断言失败: ${JSON.stringify(fsAckFrameReceived.headers)}`);
  }

  const ackCodeObj = JSON.parse(new TextDecoder().decode(fsAckFrameReceived.payload));
  if (ackCodeObj.code !== 200) {
    throw new Error(`飞书 ACK payload code 200 断言失败: ${JSON.stringify(ackCodeObj)}`);
  }

  await new Promise((r) => setTimeout(r, 300));
  if (!fsRestSentBody || !fsRestSentBody.content.includes('飞书回复测试')) {
    throw new Error(`飞书 REST 发送消息断言失败: ${JSON.stringify(fsRestSentBody)}`);
  }

  console.log('  ✅ 飞书长连接与 ACK 应答全流程验证成功！');
  await fsAdapter.stop();
  await fsWsServer.close();
  await new Promise((r) => fsHttpServer.close(r));


  // ==========================================
  // 测试 3: 钉钉 Stream 模式适配器 (lib/adapters/dingtalk.js)
  // ==========================================
  console.log('\n--- 测试 3: 钉钉 Stream 模式适配器 ---');
  let dtPingAckReceived = false;
  let dtCallbackAckReceived = false;
  let dtWebhookSentBody = null;

  const dtHttpPort = 18999;
  const dtWsPort = 19000;

  // Mock HTTP
  const dtHttpServer = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = req.url;
      if (url.includes('/v1.0/gateway/connections/open')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          endpoint: `ws://127.0.0.1:${dtWsPort}`,
          ticket: 'mock_dt_ticket_999'
        }));
        return;
      }
      if (url.includes('/mock_dt_webhook')) {
        try {
          dtWebhookSentBody = JSON.parse(body);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => dtHttpServer.listen(dtHttpPort, '127.0.0.1', r));

  // Mock WS Server (处理 文本 JSON 帧)
  const dtWsServer = createWsServer({
    port: dtWsPort,
    host: '127.0.0.1',
    onConnection(conn) {
      // 1. 发送 SYSTEM ping 帧
      conn.send(JSON.stringify({
        type: 'SYSTEM',
        headers: { topic: 'ping', messageId: 'ping_msg_001' },
        data: 'ping-data'
      }));

      // 2. 发送 CALLBACK 机器人消息帧
      const robotMsg = {
        conversationType: '1', // 单聊
        conversationId: 'cid_dt_999',
        senderStaffId: 'dt_staff_123',
        senderNick: 'DingUser',
        text: { content: 'hello dingtalk stagec' },
        sessionWebhook: `http://127.0.0.1:${dtHttpPort}/mock_dt_webhook`,
        sessionWebhookExpiredTime: Date.now() + 3600000
      };

      conn.send(JSON.stringify({
        type: 'CALLBACK',
        headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'callback_msg_002' },
        data: JSON.stringify(robotMsg)
      }));
    },
    onMessage(conn, data) {
      try {
        const frame = JSON.parse(data);
        if (frame.headers?.messageId === 'ping_msg_001' && frame.code === 200) {
          dtPingAckReceived = true;
        }
        if (frame.headers?.messageId === 'callback_msg_002' && frame.code === 200) {
          dtCallbackAckReceived = true;
        }
      } catch (e) {
        console.error('钉钉 ACK 解析失败:', e);
      }
    }
  });

  let dtCoreReceivedText = '';
  const mockDtCore = {
    onMessage({ adapter, chatId, userId, text, reply }) {
      dtCoreReceivedText = text;
      reply('钉钉回复测试');
    }
  };

  const dtAdapterConfig = {
    enabled: true,
    clientId: 'ding_client_id_123',
    clientSecret: 'ding_secret_abc',
    allowUsers: ['dt_staff_123']
  };

  // 替换内部 fetch 走 Mock HTTP 地址
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let strUrl = String(url);
    if (strUrl.includes('api.dingtalk.com')) {
      strUrl = strUrl.replace('https://api.dingtalk.com', `http://127.0.0.1:${dtHttpPort}`);
    }
    return origFetch(strUrl, opts);
  };

  const dtAdapter = createDingtalkAdapter('dingtalk', dtAdapterConfig, { core: mockDtCore });
  await dtAdapter.start();

  await new Promise((r) => setTimeout(r, 600));

  if (!dtPingAckReceived) {
    throw new Error('钉钉 SYSTEM ping ACK 断言失败');
  }
  if (!dtCallbackAckReceived) {
    throw new Error('钉钉 CALLBACK ACK 断言失败');
  }
  if (dtCoreReceivedText !== 'hello dingtalk stagec') {
    throw new Error(`钉钉消息文本接收断言失败: "${dtCoreReceivedText}"`);
  }

  await new Promise((r) => setTimeout(r, 300));
  if (!dtWebhookSentBody || dtWebhookSentBody.msgtype !== 'markdown' || !dtWebhookSentBody.markdown?.text?.includes('钉钉回复测试')) {
    throw new Error(`钉钉 sessionWebhook 发送断言失败: ${JSON.stringify(dtWebhookSentBody)}`);
  }

  console.log('  ✅ 钉钉 Stream 模式全流程验证成功！');
  await dtAdapter.stop();
  await dtWsServer.close();
  await new Promise((r) => dtHttpServer.close(r));

  // 还原 fetch
  globalThis.fetch = origFetch;

  console.log('\n🎉 Stage C 所有 protobuf 编解码与飞书/钉钉适配器测试全部通过！');
  process.exit(0);
}

runStageCTest().catch((err) => {
  console.error('❌ Stage C 测试失败:', err);
  process.exit(1);
});
