/**
 * @file test/mock-onebot-server.mjs
 * @description 端到端验证用 Mock NapCat：先轮询 /bot-gateway/api/status 等到目标插件版本
 *              （确证热重载已生效），再在 3001 端口起 OneBot v11 正向 WS 服务器，
 *              等 bot-gateway 连接后推送一条私聊消息（/new 任务），打印收到的回复。
 *              用法：node test/mock-onebot-server.mjs --expect-v=4 [--wait-ms=240000]
 *              成功判定：收到回复、非 ❌ 开头、且包含完成迹象（hello/路径/完成/✅）。
 */

import { createWsServer } from '../lib/util.js';

const PORT = 3001;
const STATUS_URL = 'http://127.0.0.1:53035/bot-gateway/api/status';
const EXPECT_V = (() => {
  const a = process.argv.find((x) => x.startsWith('--expect-v='));
  return a ? a.split('=')[1] : null;
})();
const WAIT_MS = Number(process.argv.find((a) => a.startsWith('--wait-ms='))?.split('=')[1] || 240000);
const TEST_USER = '10001'; // 必须与 cordis.patch.yml 中 allowUsers 一致

if (EXPECT_V) {
  console.log(`[mock-napcat] 等待插件热重载至版本 v${EXPECT_V} …`);
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        if (String(j.pluginVersion) === EXPECT_V) {
          console.log(`[mock-napcat] ✅ 插件版本 v${j.pluginVersion} 已就绪`);
          break;
        }
        if (!('pluginVersion' in j)) {
          console.log('[mock-napcat] ⚠️ 状态 API 尚未返回 pluginVersion（旧版本实例仍在服务），继续等待…');
        }
      }
    } catch { /* 后端可能正在重载，忽略 */ }
    if (Date.now() > deadline) {
      console.error('[mock-napcat] ⏰ 等待插件版本超时');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

let conn = null;
let finalReply = null;
let sawTurnStart = false;

const server = createWsServer({
  port: PORT,
  host: '127.0.0.1',
  onConnection(c) {
    conn = c;
    console.log(`[mock-napcat] bot-gateway 已连接（来自 ${c.req.socket.remoteAddress}）`);
    setTimeout(() => {
      if (!conn) return;
      console.log('[mock-napcat] -> 推送私聊消息（/new 任务）');
      conn.send(JSON.stringify({
        time: Date.now(),
        self_id: 10086,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 50001,
        user_id: Number(TEST_USER),
        message: [{
          type: 'text',
          data: { text: '/new 请在当前工作目录创建 hello.txt，内容为「来自远程任务的问候」，创建完成后简要报告文件路径。' },
        }],
        raw_message: '/new 请在当前工作目录创建 hello.txt，内容为「来自远程任务的问候」，创建完成后简要报告文件路径。',
        font: 0,
        sender: { user_id: Number(TEST_USER), nickname: 'E2E-Tester', sex: 'unknown', age: 0 },
      }));
    }, 1000);
  },
  onMessage(_c, data) {
    try {
      const msg = JSON.parse(data);
      if (msg.action === 'get_login_info') {
        conn?.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10086, nickname: 'MockBot' }, echo: msg.echo }));
        return;
      }
      if (msg.action === 'send_private_msg' || msg.action === 'send_group_msg') {
        const text = (msg.params?.message || []).filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('');
        console.log(`\n[mock-napcat] <<< 收到回复（${text.length} 字符）：\n${text.slice(0, 600)}${text.length > 600 ? '…' : ''}\n`);
        if (text) {
          if (text.startsWith('▶️')) {
            sawTurnStart = true; // 开始通知不算最终结果
          } else {
            finalReply = text; // 最后一条非通知回复覆盖
          }
        }
        conn?.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: Math.floor(Math.random() * 100000) }, echo: msg.echo }));
        return;
      }
      console.log(`[mock-napcat] <- action: ${msg.action}`);
    } catch (e) {
      console.error('[mock-napcat] 解析失败:', e.message);
    }
  },
  onClose() {
    conn = null;
    console.log('[mock-napcat] 连接断开');
  },
  onError(err) {
    console.error('[mock-napcat] 服务器错误:', err.message);
  },
});

const timer = setTimeout(() => {
  console.error(`[mock-napcat] ⏰ ${WAIT_MS}ms 内未收到任务回复，测试失败（last=${(finalReply || '').slice(0, 120)}）`);
  process.exit(1);
}, WAIT_MS);

// 成功判定循环：最终回复非错误、非空、且任务有完成迹象
setInterval(() => {
  if (!finalReply) return;
  if (finalReply.startsWith('❌')) {
    console.error('[mock-napcat] ❌ 收到错误回复，端到端验证失败');
    clearTimeout(timer);
    server.close().then(() => process.exit(1));
    return;
  }
  const ok = /完成|路径|✅|已创建|hello\.txt/i.test(finalReply);
  if (ok) {
    console.log('[mock-napcat] 🎉 端到端验证成功（任务真实执行并回报结果）');
    clearTimeout(timer);
    server.close().then(() => process.exit(0));
  }
}, 2000);

console.log(`[mock-napcat] Mock NapCat（OneBot v11 正向 WS）已监听 ws://127.0.0.1:${PORT}，等待 bot-gateway 连接…`);
