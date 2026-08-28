/**
 * @file test/adapter-test.mjs
 * @description Stage B 独立测试：Mock HTTP 与 Mock WS 服务器测试 QQ 官方与 Telegram 适配器协议链。
 */

import { createAdapter as createQqAdapter } from '../lib/adapters/qqofficial.js';
import { createAdapter as createTgAdapter } from '../lib/adapters/telegram.js';
import { createWsServer } from '../lib/util.js';
import { createServer } from 'node:http';

async function runAdapterTest() {
  console.log('[adapter-test] 🚀 开始 Stage B 适配器协议测试...');

  // ==========================================
  // 测试 1: QQ 官方机器人适配器
  // ==========================================
  console.log('\n--- 测试 1: QQ 官方机器人适配器 ---');
  let qqIdentifyReceived = false;
  let qqIdentifyToken = '';
  let qqRestSentBody = null;

  // 1.1 起 Mock HTTP 服务 (模拟 token 接口与 v2/users REST 回复)
  const qqHttpPort = 18991;
  const qqHttpServer = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = req.url;
      if (url === '/app/getAppAccessToken') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'mock_qq_access_token_123', expires_in: 7200 }));
        return;
      }
      if (url.includes('/v2/users/test_qq_openid/messages')) {
        try {
          qqRestSentBody = JSON.parse(body);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'reply_msg_1' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((r) => qqHttpServer.listen(qqHttpPort, '127.0.0.1', r));

  // 1.2 起 Mock WS 服务 (模拟 QQ 官方 Gateway)
  const qqWsPort = 18992;
  const qqWsServer = createWsServer({
    port: qqWsPort,
    host: '127.0.0.1',
    onConnection(conn) {
      // 客户端连上后，主动推 HELLO 帧
      conn.send(JSON.stringify({
        op: 10,
        d: { heartbeat_interval: 10000 }
      }));
    },
    onMessage(conn, data) {
      try {
        const frame = JSON.parse(data);
        if (frame.op === 2) {
          qqIdentifyReceived = true;
          qqIdentifyToken = frame.d?.token;
          logTest('QQ IDENTIFY 帧捕获:', frame.d);

          // 发送一条模拟的 C2C 消息帧给客户端
          conn.send(JSON.stringify({
            op: 0,
            s: 1,
            t: 'C2C_MESSAGE_CREATE',
            d: {
              id: 'qq_msg_1001',
              content: '   /new 运行 QQ 官方任务   ',
              author: { user_openid: 'test_qq_openid', username: 'QQUser' }
            }
          }));
        }
      } catch (e) {
        console.error('Mock WS 解析失败:', e);
      }
    }
  });

  let qqCoreReceivedText = '';
  const mockQqCore = {
    onMessage({ adapter, chatId, userId, text, reply }) {
      qqCoreReceivedText = text;
      // 触发回复，测试 REST 发送
      reply('QQ回复测试');
    }
  };

  const qqAdapterConfig = {
    enabled: true,
    appId: '10000001',
    clientSecret: 'mock_secret',
    sandbox: false,
    gatewayUrl: `ws://127.0.0.1:${qqWsPort}`,
    allowUsers: ['test_qq_openid']
  };

  // 替换内部 fetch 走 Mock HTTP 地址（将 api.bot.qq.com 拦截映射）
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    let strUrl = String(url);
    if (strUrl.includes('api.bot.qq.com') || strUrl.includes('sandbox.api.sgroup.qq.com')) {
      strUrl = strUrl.replace(/https:\/\/(api\.bot\.qq\.com|sandbox\.api\.sgroup\.qq\.com)/, `http://127.0.0.1:${qqHttpPort}`);
    }
    return origFetch(strUrl, opts);
  };

  const qqAdapter = createQqAdapter('qqofficial', qqAdapterConfig, { core: mockQqCore });
  await qqAdapter.start();

  await new Promise((r) => setTimeout(r, 600));

  if (!qqIdentifyReceived || qqIdentifyToken !== 'QQBot mock_qq_access_token_123') {
    throw new Error(`QQ IDENTIFY 帧断言失败, token: "${qqIdentifyToken}"`);
  }
  if (qqCoreReceivedText !== '/new 运行 QQ 官方任务') {
    throw new Error(`QQ 消息剥离前导空格断言失败, 实际文本: "${qqCoreReceivedText}"`);
  }

  // 等待 REST 回复到达
  await new Promise((r) => setTimeout(r, 300));
  if (!qqRestSentBody || qqRestSentBody.content !== 'QQ回复测试' || qqRestSentBody.msg_id !== 'qq_msg_1001') {
    throw new Error(`QQ 被动回复 REST 断言失败: ${JSON.stringify(qqRestSentBody)}`);
  }

  console.log('  ✅ QQ 官方机器人适配器全流程验证成功！');
  await qqAdapter.stop();
  await qqWsServer.close();
  await new Promise((r) => qqHttpServer.close(r));


  // ==========================================
  // 测试 2: Telegram Bot 适配器
  // ==========================================
  console.log('\n--- 测试 2: Telegram Bot 适配器 ---');
  let tgSendMessageBody = null;
  let getUpdatesCount = 0;

  const tgHttpPort = 18993;
  const tgHttpServer = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = req.url;
      if (url.includes('/getMe')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { id: 9999, username: 'test_dsh_bot' } }));
        return;
      }
      if (url.includes('/getUpdates')) {
        getUpdatesCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (getUpdatesCount === 1) {
          // 第一次请求返回一条带 @ 提及的群组消息
          res.end(JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 500,
                message: {
                  message_id: 12,
                  from: { id: 6666, first_name: 'Bob' },
                  chat: { id: -100888, type: 'supergroup' },
                  text: '你好 @test_dsh_bot /new 执行任务'
                }
              }
            ]
          }));
        } else {
          // 后续长轮询返回空
          res.end(JSON.stringify({ ok: true, result: [] }));
        }
        return;
      }
      if (url.includes('/sendMessage')) {
        try {
          tgSendMessageBody = JSON.parse(body);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: 13 } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((r) => tgHttpServer.listen(tgHttpPort, '127.0.0.1', r));

  let tgCoreReceivedText = '';
  let tgCoreChatId = '';
  const mockTgCore = {
    onMessage({ adapter, chatId, userId, text, reply }) {
      tgCoreReceivedText = text;
      tgCoreChatId = chatId;
      reply('TG回复测试');
    }
  };

  const tgAdapterConfig = {
    enabled: true,
    token: 'mock_tg_token_xyz',
    apiBase: `http://127.0.0.1:${tgHttpPort}`
  };

  const tgAdapter = createTgAdapter('telegram', tgAdapterConfig, { core: mockTgCore });
  await tgAdapter.start();

  await new Promise((r) => setTimeout(r, 600));

  if (tgCoreReceivedText !== '你好  /new 执行任务') {
    throw new Error(`Telegram 群聊 @ 剥离断言失败, 实际文本: "${tgCoreReceivedText}"`);
  }
  if (tgCoreChatId !== '-100888') {
    throw new Error(`Telegram chatId 负数保留断言失败, 实际: "${tgCoreChatId}"`);
  }

  if (!tgSendMessageBody || tgSendMessageBody.chat_id !== '-100888' || tgSendMessageBody.text !== 'TG回复测试') {
    throw new Error(`Telegram sendMessage REST 断言失败: ${JSON.stringify(tgSendMessageBody)}`);
  }

  console.log('  ✅ Telegram Bot 适配器全流程验证成功！');
  await tgAdapter.stop();
  await new Promise((r) => tgHttpServer.close(r));

  // 还原 fetch
  globalThis.fetch = origFetch;

  console.log('\n🎉 Stage B 所有适配器协议与事件链测试全部通过！');
  process.exit(0);
}

function logTest(...args) {
  // console.log(...args);
}

runAdapterTest().catch((err) => {
  console.error('❌ 适配器测试失败:', err);
  process.exit(1);
});
