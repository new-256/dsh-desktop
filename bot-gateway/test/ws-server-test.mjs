/**
 * @file test/ws-server-test.mjs
 * @description 验证 lib/util.js 中 createWsServer 的 WebSocket 握手、解 Mask、分片重组、Ping-Pong 响应。
 */

import { createWsServer } from '../lib/util.js';
import { connect } from 'node:net';

async function runTest() {
  console.log('[test/ws-server-test] 启动测试...');
  const port = 18999;
  let serverReceived = '';
  let pongReceived = false;

  const wsServer = createWsServer({
    port,
    host: '127.0.0.1',
    onMessage(conn, data) {
      console.log('[ws-server-test] 服务器收到消息:', data);
      serverReceived = data;
    },
    onError(err) {
      console.error('[ws-server-test] 服务器报错:', err);
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  // 用原生的 net socket 发送 HTTP Upgrade 握手及 RFC6455 原始帧（测试分片帧与 ping 帧）
  const socket = connect(port, '127.0.0.1');

  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('error', reject);
  });

  const secKey = 'dGhlIHNhbXBsZSBub25jZQ=='; // 标准测试 Key
  const upgradeReq = [
    'GET / HTTP/1.1',
    'Host: 127.0.0.1:' + port,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${secKey}`,
    'Sec-WebSocket-Version: 13',
    '\r\n'
  ].join('\r\n');

  socket.write(upgradeReq);

  await new Promise((resolve) => {
    socket.once('data', (buf) => {
      const resp = buf.toString('utf8');
      if (!resp.includes('101 Switching Protocols')) {
        throw new Error('握手失败: ' + resp);
      }
      console.log('[ws-server-test] 握手成功！');
      resolve();
    });
  });

  // 测试 1：发送分片文本帧 "Hello " + "World!"
  // 帧 1: FIN=0, Opcode=0x1 (text), Masked=1, payload="Hello "
  // 帧 2: FIN=1, Opcode=0x0 (continuation), Masked=1, payload="World!"
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);

  function makeFrame(fin, opcode, payloadStr) {
    const raw = Buffer.from(payloadStr, 'utf8');
    const len = raw.length;
    const frame = Buffer.alloc(2 + 4 + len);
    frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
    frame[1] = 0x80 | (len & 0x7f); // Masked
    maskKey.copy(frame, 2);

    for (let i = 0; i < len; i++) {
      frame[6 + i] = raw[i] ^ maskKey[i % 4];
    }
    return frame;
  }

  const frame1 = makeFrame(false, 0x1, 'Hello ');
  const frame2 = makeFrame(true, 0x0, 'World!');

  socket.write(frame1);
  await new Promise((r) => setTimeout(r, 100));
  socket.write(frame2);

  await new Promise((r) => setTimeout(r, 200));

  if (serverReceived !== 'Hello World!') {
    throw new Error(`分片帧重组断言失败，期望 'Hello World!'，实际得到: '${serverReceived}'`);
  }
  console.log('[ws-server-test] ✅ 分片文本帧重组成功！');

  // 测试 2：发送 Ping 帧 0x9，断言收到 Pong 帧 0xA
  const pingPayload = Buffer.from('ping-data', 'utf8');
  const pingFrame = Buffer.alloc(2 + 4 + pingPayload.length);
  pingFrame[0] = 0x89; // FIN=1, Opcode=0x9
  pingFrame[1] = 0x80 | pingPayload.length;
  maskKey.copy(pingFrame, 2);
  for (let i = 0; i < pingPayload.length; i++) {
    pingFrame[6 + i] = pingPayload[i] ^ maskKey[i % 4];
  }

  socket.on('data', (data) => {
    const opcode = data[0] & 0x0f;
    if (opcode === 0x0a) {
      console.log('[ws-server-test] 收到服务器回复的 Pong 帧！');
      pongReceived = true;
    }
  });

  socket.write(pingFrame);
  await new Promise((r) => setTimeout(r, 300));

  if (!pongReceived) {
    throw new Error('Pong 帧接收断言失败，未收到 Pong 帧');
  }
  console.log('[ws-server-test] ✅ Ping -> Pong 验证成功！');

  // 绝收清理
  socket.destroy();
  await wsServer.close();
  console.log('[ws-server-test] 🎉 所有 WS 服务器测试通过！');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('[ws-server-test] ❌ 测试失败:', err);
  process.exit(1);
});
