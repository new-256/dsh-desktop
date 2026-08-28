/**
 * @file test/settings-test.mjs
 * @description SettingsStore, NapCatProcessManager 配置文件生成与 reconfigure 流程的单元测试。
 */

function assertStrict(condition, msg) {
  if (!condition) {
    console.error(`  ❌ 断言失败: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function runAsyncTest(name, fn) {
  console.log(`\n--- 测试: ${name} ---`);
  try {
    await fn();
    console.log(`  ✅ ${name} 验证成功！`);
  } catch (e) {
    console.error(`  ❌ ${name} 验证失败:`, e);
    throw e;
  }
}
import { SettingsStore, deepMerge } from '../lib/settings.js?v=10';
import { createNapCatProcessManager } from '../lib/napcat-process.js?v=10';
import { apply } from '../index.mjs';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

console.log('[settings-test] 🚀 开始新功能 (Settings, NapCatConfig, Reconfigure) 单元测试...');

const testDir = join(tmpdir(), 'dsh-bot-gateway-test-' + Date.now());
await mkdir(testDir, { recursive: true });

// --- 测试 1: SettingsStore 深合并与原子写盘 ---
await runAsyncTest('SettingsStore 深合并与原子写盘', async () => {
  const settingsPath = join(testDir, 'settings.json');
  const store = new SettingsStore({ settingsPath });

  const initial = await store.load();
  assertStrict(Object.keys(initial).length === 0, '新建 SettingsStore 初始应为空对象');

  // 保存第一版配置
  await store.save({
    replyChunkChars: 2000,
    adapters: {
      onebot11: { enabled: true, url: 'ws://127.0.0.1:3001' }
    }
  });

  assertStrict(existsSync(settingsPath), 'settings.json 应被物理写入磁盘');

  // 保存第二版增量配置（深合并测试）
  await store.save({
    adapters: {
      onebot11: { accessToken: 'secret123' },
      telegram: { enabled: true, token: 'tg_token' }
    }
  });

  const updated = store.getSettings();
  assertStrict(updated.replyChunkChars === 2000, '原始字段 replyChunkChars 应保持 2000');
  assertStrict(updated.adapters.onebot11.enabled === true, 'onebot11.enabled 应保持 true');
  assertStrict(updated.adapters.onebot11.accessToken === 'secret123', 'onebot11.accessToken 应更新为 secret123');
  assertStrict(updated.adapters.telegram.enabled === true, 'telegram.enabled 应更新为 true');
});

// --- 测试 2: NapCatProcessManager 配置文件生成与幂等性 ---
await runAsyncTest('NapCatProcessManager 配置文件生成与端口/token 规则', async () => {
  const napcatDir = join(testDir, 'napcat');
  await mkdir(napcatDir, { recursive: true });

  const mockConfig = {
    napcat: {
      installDir: napcatDir,
      wsPort: 3005,
      webuiPort: 6098
    },
    adapters: {
      onebot11: { napcatWebui: { url: 'http://127.0.0.1:6098', token: '' } }
    }
  };

  const store = new SettingsStore({ settingsPath: join(testDir, 'settings.json') });

  const manager = createNapCatProcessManager({
    getConfig: () => mockConfig,
    settingsStore: store
  });

  // 1. 首次调用 ensureConfigs
  await manager.ensureConfigs();

  const webuiPath = join(napcatDir, 'napcat', 'config', 'webui.json');
  const ob11Path = join(napcatDir, 'napcat', 'config', 'onebot11.json');

  assertStrict(existsSync(webuiPath), 'webui.json 应成功生成');
  assertStrict(existsSync(ob11Path), 'onebot11.json 应成功生成');

  const webuiJson = JSON.parse(await readFile(webuiPath, 'utf8'));
  const ob11Json = JSON.parse(await readFile(ob11Path, 'utf8'));

  assertStrict(webuiJson.host === '127.0.0.1', 'webui.json host 必须为 127.0.0.1');
  assertStrict(webuiJson.port === 6098, 'webui.json port 应匹配 6098');
  assertStrict(typeof webuiJson.token === 'string' && webuiJson.token.length > 0, 'webui.json 应随机生成非空 token');

  assertStrict(ob11Json.network.websocketServers[0].port === 3005, 'onebot11.json wsPort 应匹配 3005');

  // 校验同步回 settingsStore
  const savedSettings = store.getSettings();
  assertStrict(savedSettings.adapters.onebot11.napcatWebui.url === 'http://127.0.0.1:6098', 'napcatWebui.url 应同步写回 settingsStore');
  assertStrict(savedSettings.adapters.onebot11.napcatWebui.token === webuiJson.token, 'napcatWebui.token 应同步写回 settingsStore');

  // 2. 幂等性与端口热更新测试
  mockConfig.napcat.wsPort = 3006;
  await manager.ensureConfigs();

  const ob11JsonUpdated = JSON.parse(await readFile(ob11Path, 'utf8'));
  assertStrict(ob11JsonUpdated.network.websocketServers[0].port === 3006, '更新配置后 onebot11.json 应更新为 3006');
});

// --- 测试 3: apply() 入口与 reconfigure 状态流测试 ---
const pluginDisposers = []; // 捕获 apply() 注册的清理函数，测试结束统一释放
await runAsyncTest('reconfigure 运行时热生效全流程', async () => {
  let webHandler = null;

  const mockCtx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            webHandler = route.handler;
            return () => { webHandler = null; };
          }
        };
      }
      return null;
    },
    on() { return () => {}; },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') pluginDisposers.push(cleanup);
      return cleanup;
    }
  };

  const settingsPath = join(testDir, 'reconfig-settings.json');
  const rawConfig = {
    settingsPath,
    adapters: {
      onebot11: { enabled: false }
    }
  };

  apply(mockCtx, rawConfig);
  assertStrict(typeof webHandler === 'function', 'webui 路由应成功挂载');

  // 构造模拟 GET /bot-gateway/api/settings 请求
  const mockReqGet = {
    url: '/bot-gateway/api/settings',
    method: 'GET',
    headers: { host: '127.0.0.1:80' },
    socket: { remoteAddress: '127.0.0.1', localPort: 80 }
  };
  let resStatus = null;
  let resBody = '';
  const mockResGet = {
    writeHead(status, headers) { resStatus = status; },
    end(body) { resBody = body; }
  };

  await webHandler(mockReqGet, mockResGet);
  assertStrict(resStatus === 200, 'GET /api/settings 返回码应为 200');
  const getJson = JSON.parse(resBody);
  assertStrict(getJson.ok === true, 'GET /api/settings 状态应为 ok');

  // 构造 POST /bot-gateway/api/settings 触发 reconfigure
  // (telegram 用本地拒绝端口，避免单测访问真实外网)
  const postData = JSON.stringify({
    replyChunkChars: 2500,
    adapters: {
      telegram: { enabled: true, token: '12345:test_token', apiBase: 'http://127.0.0.1:9' }
    }
  });

  const mockReqPost = {
    url: '/bot-gateway/api/settings',
    method: 'POST',
    headers: { host: '127.0.0.1:80', 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1', localPort: 80 },
    on(event, cb) {
      if (event === 'data') cb(postData);
      if (event === 'end') cb();
    }
  };

  let postStatus = null;
  let postResBody = '';
  const mockResPost = {
    writeHead(status) { postStatus = status; },
    end(body) { postResBody = body; }
  };

  await webHandler(mockReqPost, mockResPost);
  assertStrict(postStatus === 200, 'POST /api/settings 应成功返回 200');
  const postJson = JSON.parse(postResBody);
  assertStrict(postJson.ok === true, 'POST /api/settings 返回结果应为 ok: true');

  // 验证重新 GET 查看是否已更新
  resStatus = null; resBody = '';
  await webHandler(mockReqGet, mockResGet);
  const updatedJson = JSON.parse(resBody);
  assertStrict(updatedJson.config.replyChunkChars === 2500, 'reconfigure 后 replyChunkChars 应更新为 2500');
  assertStrict(updatedJson.config.adapters.telegram.enabled === true, 'reconfigure 后 telegram 应变为启用');
});

// 清理测试临时目录
await rm(testDir, { recursive: true, force: true }).catch(() => {});

// 释放插件注册的句柄（适配器定时器、NapCat 管理器等），保证进程能自然退出
for (const dispose of pluginDisposers.reverse()) {
  try { await dispose(); } catch {}
}

console.log('🎉 所有 settings, NapCatConfig 和 reconfigure 测试用例全部通过！');

// 保险：若仍有顽固句柄（如外网请求重试），1.5s 后强制退出
setTimeout(() => process.exit(0), 1500).unref();
