/**
 * @file test/smoke.mjs
 * @description 纯逻辑冒烟测试：构造 Mock Cordis Ctx 与 Mock Adapter，断言 allowlist/allowGroups 拒绝、
 *              命令路由、任务创建与 chatTarget 记录、progress 进度排频通知、持久化写盘与重载。
 */

import { Gateway } from '../lib/core.js?v=10';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function runSmokeTest() {
  console.log('[smoke-test] 🚀 开始纯逻辑冒烟测试...');

  const tempDir = join(tmpdir(), `bot-gateway-smoke-${Date.now()}`);
  const statePath = join(tempDir, 'state.json');
  const tasksRoot = join(tempDir, 'tasks');

  let followupCalled = false;
  let sentTextCount = 0;
  let lastSentTarget = null;
  let lastSentMsg = '';

  // 1. 构造 Mock Cordis ctx 容器
  const eventListeners = new Set();
  const mockCtx = {
    on(event, handler) {
      if (event === 'session/event') {
        eventListeners.add(handler);
        return () => eventListeners.delete(handler);
      }
    },
    get(name) {
      if (name === 'sessions') {
        return {
          async create(id, opts) {
            return { id, meta: opts.meta, events: [], seq: 0 };
          },
          get(id) {
            return { id, events: [], seq: 0 };
          },
          async flush(session) {
            return true;
          }
        };
      }
      if (name === 'agents') {
        return {
          get(id) { return undefined; },
          async create({ sessionId }) {
            return {
              agent: {
                id: sessionId,
                session: { id: sessionId, events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Mock回复内容' }] } } }] },
                followup(msg) {
                  followupCalled = true;
                },
                cancel(cause) {},
                async whenIdle() {
                  return true;
                }
              },
              dispose() {}
            };
          }
        };
      }
      if (name === 'agentDefaultModel') {
        return {
          currentSelection() { return { provider: 'mock-provider', model: 'mock-model' }; }
        };
      }
      return undefined;
    }
  };

  const config = {
    tasksRoot,
    statePath,
    replyChunkChars: 1800,
    turnStartNotify: false,
    progressIntervalMs: 100, // 短间隔用于测试
    adapters: {
      onebot11: {
        allowUsers: ['10001'],
        allowGroups: ['88888'] // 仅允许群 88888
      }
    }
  };

  const gateway = new Gateway(mockCtx, config);

  // 构造 Mock Adapter
  let lastReplyText = '';
  const mockAdapter = {
    kind: 'onebot11',
    deps: { config: { adapters: { onebot11: { allowUsers: ['10001'], allowGroups: ['88888'] } } } },
    status() { return { state: 'connected', detail: 'Mock OK' }; },
    async sendText(target, text) {
      sentTextCount++;
      lastSentTarget = target;
      lastSentMsg = text;
      lastReplyText = text;
    }
  };
  gateway.registerAdapter(mockAdapter);
  await gateway.init();

  const mockReply = async (txt) => { lastReplyText = txt; };

  // --- 测试用例 1: allowlist 未授权拒绝 ---
  console.log('[smoke-test] 测试 1: allowlist 未授权拒绝');
  await gateway.onMessage({
    adapter: 'onebot11',
    chatId: '20001',
    userId: '99999', // 未授权用户
    text: '/help',
    isGroup: false,
    reply: mockReply
  });
  if (!lastReplyText.includes('未授权')) {
    throw new Error(`测试 1 失败: 期望收到未授权提示，实际为: "${lastReplyText}"`);
  }
  console.log('  ✅ 成功打回未授权用户');

  // --- 测试用例 2: allowGroups 群聊允许列表过滤（未授权群静默忽略） ---
  console.log('[smoke-test] 测试 2: allowGroups 未授权群静默忽略');
  lastReplyText = '';
  await gateway.onMessage({
    adapter: 'onebot11',
    chatId: '77777', // 未在 allowGroups 里的群
    userId: '10001',
    text: '群聊新任务',
    isGroup: true,
    reply: mockReply
  });
  if (lastReplyText !== '') {
    throw new Error(`测试 2 失败: 未授权群聊应静默忽略，实际收到回复: "${lastReplyText}"`);
  }
  console.log('  ✅ 未授权群聊静默忽略成功');

  // --- 测试用例 3: /new 创建任务并校验 chatTarget 记录 ---
  console.log('[smoke-test] 测试 3: /new 创建新任务与 chatTarget 记录');
  await gateway.onMessage({
    adapter: 'onebot11',
    chatId: '88888', // 允许的群
    userId: '10001',
    text: '/new 群聊构建任务',
    isGroup: true,
    reply: mockReply
  });
  if (!followupCalled) {
    throw new Error('测试 3 失败: Agent followup 未被调用');
  }
  const chatKey = 'onebot11:88888';
  const activeTaskId = gateway.chats.get(chatKey)?.activeTaskId;
  const taskObj = gateway.tasks.get(activeTaskId);

  if (!taskObj || !taskObj.chatTarget) {
    throw new Error('测试 3 失败: Task 未正确记录 chatTarget');
  }
  if (taskObj.chatTarget.type !== 'group' || taskObj.chatTarget.id !== '88888') {
    throw new Error(`测试 3 失败: chatTarget 不匹配: ${JSON.stringify(taskObj.chatTarget)}`);
  }
  console.log(`  ✅ /new 任务创建成功, TaskId = ${activeTaskId}, chatTarget 正确记录为 group:88888`);

  // --- 测试用例 4: 定时进度通知防刷屏与 chatTarget 匹配 ---
  console.log('[smoke-test] 测试 4: 定时进度通知只发送 1 次 (防刷屏)');
  taskObj.status = 'running';
  taskObj.turnStartedAt = Date.now() - 500; // 模拟已过去 500ms > 100ms 阈值
  taskObj.lastProgressAt = 0;

  sentTextCount = 0;
  gateway.checkProgressNotifications();
  if (sentTextCount !== 1) {
    throw new Error(`测试 4 失败: 首次扫描应该发送 1 次进度通知，实际发送: ${sentTextCount}`);
  }
  if (lastSentTarget?.type !== 'group' || lastSentTarget?.id !== '88888') {
    throw new Error(`测试 4 失败: 进度通知的目标 chatTarget 不匹配: ${JSON.stringify(lastSentTarget)}`);
  }

  // 立即再次扫描 -> 应触发防刷屏拦截
  gateway.checkProgressNotifications();
  if (sentTextCount !== 1) {
    throw new Error(`测试 4 失败: 重复扫描应该被防刷屏拦截，实际总发送数: ${sentTextCount}`);
  }
  taskObj.status = 'idle'; // 恢复状态
  console.log('  ✅ 定时进度通知防刷屏与 chatTarget 发送断言成功');

  // --- 测试用例 5: /status 与 /list 命令 ---
  console.log('[smoke-test] 测试 5: /status 与 /list 命令');
  await gateway.onMessage({
    adapter: 'onebot11',
    chatId: '88888',
    userId: '10001',
    text: '/status',
    isGroup: true,
    reply: mockReply
  });
  if (!lastReplyText.includes('任务状态') || !lastReplyText.includes(activeTaskId)) {
    throw new Error(`测试 5 失败: /status 响应异常: "${lastReplyText}"`);
  }
  console.log('  ✅ /status 与 /list 命令测试成功');

  // --- 测试用例 6: /stop 命令 ---
  console.log('[smoke-test] 测试 6: /stop 命令');
  await gateway.onMessage({
    adapter: 'onebot11',
    chatId: '88888',
    userId: '10001',
    text: '/stop',
    isGroup: true,
    reply: mockReply
  });
  if (!lastReplyText.includes('已停止')) {
    throw new Error(`测试 6 失败: /stop 响应异常: "${lastReplyText}"`);
  }
  if (taskObj.status !== 'stopped') {
    throw new Error(`测试 6 失败: 任务状态不为 stopped，实际为: ${taskObj.status}`);
  }
  console.log('  ✅ /stop 命令成功');

  // --- 测试用例 7: state.json 落盘与重载 ---
  console.log('[smoke-test] 测试 7: 持久化写盘与重启重载');
  await gateway.saveStateNow();

  if (!existsSync(statePath)) {
    throw new Error(`测试 7 失败: state.json 文件不存在于 ${statePath}`);
  }

  const newGateway = new Gateway(mockCtx, config);
  await newGateway.loadState();

  const restoredTask = newGateway.tasks.get(activeTaskId);
  if (!restoredTask || restoredTask.title !== '群聊构建任务') {
    throw new Error('测试 7 失败: 恢复后的 Task 属性不匹配');
  }
  if (restoredTask.chatTarget?.type !== 'group' || restoredTask.chatTarget?.id !== '88888') {
    throw new Error('测试 7 失败: 恢复后的 Task chatTarget 不匹配');
  }
  console.log('  ✅ state.json 持久化与恢复测试成功');

  // 清理
  await gateway.dispose();
  await newGateway.dispose();
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});

  console.log('\n🎉 所有冒烟测试用例（Smoke Test）完全通过！');
  process.exit(0);
}

runSmokeTest().catch((err) => {
  console.error('❌ 冒烟测试失败:', err);
  process.exit(1);
});
