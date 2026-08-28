/**
 * @file index.mjs
 * @description DSH Bot Gateway 宿主插件入口文件。
 *              全量集成 OneBot11、QQ 官方机器人、Telegram、飞书与钉钉 5 大平台适配器，
 *              支持 NapCatQQ 一键安装与进程托管，支持 settings.json 持久化与运行时热生效 (reconfigure)。
 *
 * ⚠️ 热重载机制（重要，改源码时必读）：
 * Node ESM 模块缓存按完整 URL（含 query）键控。cordis.patch.yml 里入口带 `?v=N`，
 * bump 入口版本只会重新求值本文件；所有 import（含 lib 内部互相 import）都必须
 * 统一携带相同的 ?v=N 才能整体绕开旧缓存。
 * 【改任何源码后的热重载步骤】把全部文件里的 `?v=N` 全局替换为 `?v=N+1`
 * （本文件 V 常量、lib/*.js 与 lib/adapters/*.js 内部的 import、cordis.patch.yml 入口），
 * 三处缺一不可。只改 config 则无需 bump，loader 自动重挂。
 */

/** 模块版本：每次修改任一源码文件后 +1（同步 bump lib 内部 import 与 patch.yml） */
const V = '10';

const { Gateway } = await import(`./lib/core.js?v=${V}`);
const { createAdapter: createOneBotAdapter } = await import(`./lib/adapters/onebot11.js?v=${V}`);
const { createAdapter: createQqOfficialAdapter } = await import(`./lib/adapters/qqofficial.js?v=${V}`);
const { createAdapter: createTelegramAdapter } = await import(`./lib/adapters/telegram.js?v=${V}`);
const { createAdapter: createFeishuAdapter } = await import(`./lib/adapters/feishu.js?v=${V}`);
const { createAdapter: createDingtalkAdapter } = await import(`./lib/adapters/dingtalk.js?v=${V}`);
const { NapCatClient } = await import(`./lib/napcat.js?v=${V}`);
const { createWebuiHandler } = await import(`./lib/webui.js?v=${V}`);
const { createLogger } = await import(`./lib/util.js?v=${V}`);
const { SettingsStore, deepMerge } = await import(`./lib/settings.js?v=${V}`);
const { createNapCatProcessManager } = await import(`./lib/napcat-process.js?v=${V}`);
import { resolve, dirname } from 'node:path';

export const name = 'bot-gateway';

/** 默认配置定义 */
const DEFAULTS = {
  settingsPath: '',
  tasksRoot: '',
  statePath: '',
  replyChunkChars: 1800,
  progressIntervalMs: 180000,
  turnStartNotify: true,
  turnTimeoutMs: 0,
  model: {},
  agentPreset: '',
  napcat: {
    enabled: true,
    autoStart: true,
    installDir: '',
    version: '',
    mirror: '',
    wsPort: 3001,
    webuiPort: 6099,
  },
  adapters: {
    onebot11: {
      enabled: true,
      mode: 'forward-ws',
      url: 'ws://127.0.0.1:3001',
      accessToken: '',
      listenPort: 3002,
      listenHost: '127.0.0.1',
      selfId: 0,
      groupTrigger: 'mention',
      groupPrefix: '/bot',
      allowUsers: [],
      allowGroups: [],
      napcatWebui: { url: 'http://127.0.0.1:6099', token: '' }
    },
    qqofficial: { enabled: false, appId: '', clientSecret: '', sandbox: false, gatewayUrl: '', allowUsers: [] },
    telegram: { enabled: false, token: '', apiBase: 'https://api.telegram.org', allowUsers: [] },
    feishu: { enabled: false, appId: '', appSecret: '', domain: 'https://open.feishu.cn', allowUsers: [] },
    dingtalk: { enabled: false, clientId: '', clientSecret: '', allowUsers: [] }
  }
};

/**
 * 校验与深度合并配置
 */
function validateAndMergeConfig(userConfig) {
  const cfg = deepMerge(DEFAULTS, userConfig || {});

  // 端口/URL 语法防错校验 (如果已启用)
  const ob11 = cfg.adapters?.onebot11;
  if (ob11?.enabled) {
    if (ob11.mode === 'forward-ws' && ob11.url) {
      try {
        new URL(ob11.url);
      } catch {
        throw new Error(`[bot-gateway] onebot11.url 非法: "${ob11.url}"`);
      }
    }
    if (ob11.mode === 'reverse-ws' && ob11.listenPort) {
      const p = Number(ob11.listenPort);
      if (!Number.isInteger(p) || p <= 0 || p > 65535) {
        throw new Error(`[bot-gateway] onebot11.listenPort 非法: "${ob11.listenPort}"`);
      }
    }
  }

  const tg = cfg.adapters?.telegram;
  if (tg?.enabled && tg.apiBase) {
    try {
      new URL(tg.apiBase);
    } catch {
      throw new Error(`[bot-gateway] telegram.apiBase 非法: "${tg.apiBase}"`);
    }
  }

  const fs = cfg.adapters?.feishu;
  if (fs?.enabled && fs.domain) {
    try {
      new URL(fs.domain);
    } catch {
      throw new Error(`[bot-gateway] feishu.domain 非法: "${fs.domain}"`);
    }
  }

  // 路径归一化：napcat.installDir 为空时跟随 statePath 所在目录。
  // （junction 挂载导致模块路径探测不到 dsh-home，必须依赖显式 statePath 锚定）
  if (cfg.statePath && !cfg.napcat?.installDir) {
    cfg.napcat.installDir = resolve(dirname(String(cfg.statePath)), 'napcat');
  }

  return cfg;
}

/**
 * 创建并挂载 Gateway 及 5 大平台适配器
 */
async function mountAdapters(ctx, config, log) {
  log.info('正在实例化与构建 Gateway 核心...');
  const gateway = new Gateway(ctx, config);
  gateway.version = V;

  const oneBotAdapter = createOneBotAdapter('onebot11', config.adapters.onebot11, {
    log: createLogger('onebot11'),
    core: gateway,
    config,
  });
  gateway.registerAdapter(oneBotAdapter);

  const qqAdapter = createQqOfficialAdapter('qqofficial', config.adapters.qqofficial, {
    log: createLogger('qqofficial'),
    core: gateway,
    config,
  });
  gateway.registerAdapter(qqAdapter);

  const tgAdapter = createTelegramAdapter('telegram', config.adapters.telegram, {
    log: createLogger('telegram'),
    core: gateway,
    config,
  });
  gateway.registerAdapter(tgAdapter);

  const fsAdapter = createFeishuAdapter('feishu', config.adapters.feishu, {
    log: createLogger('feishu'),
    core: gateway,
    config,
  });
  gateway.registerAdapter(fsAdapter);

  const dtAdapter = createDingtalkAdapter('dingtalk', config.adapters.dingtalk, {
    log: createLogger('dingtalk'),
    core: gateway,
    config,
  });
  gateway.registerAdapter(dtAdapter);

  await gateway.init();
  await oneBotAdapter.start();
  await qqAdapter.start();
  await tgAdapter.start();
  await fsAdapter.start();
  await dtAdapter.start();

  return {
    gateway,
    dispose: async () => {
      log.info('正在卸载 Gateway 与停止所有 5 大平台适配器...');
      try {
        await oneBotAdapter.stop();
        await qqAdapter.stop();
        await tgAdapter.stop();
        await fsAdapter.stop();
        await dtAdapter.stop();
        await gateway.dispose();
      } catch (e) {
        log.error('清理过程报错:', e);
      }
    }
  };
}

/**
 * Cordis 插件入口函数
 * @param {object} ctx - Cordis Context
 * @param {object} rawConfig - 原始用户配置
 */
export function apply(ctx, rawConfig) {
  const log = createLogger('plugin');
  log.info('正在挂载 DSH Bot Gateway 插件 (v' + V + ')...');

  // 1. 创建 SettingsStore
  const settingsStore = new SettingsStore({
    settingsPath: rawConfig?.settingsPath || DEFAULTS.settingsPath
  });

  let currentConfig = validateAndMergeConfig(rawConfig);
  let controller = null;

  const getConfig = () => currentConfig;

  // 2. 创建 NapCat 进程管理器 (生命周期跨 reconfigure 保持单一实例)
  const napcatProc = createNapCatProcessManager({
    log: createLogger('napcat-proc'),
    getConfig,
    settingsStore
  });

  // 3. 运行时热生效 (reconfigure)
  const reconfigure = async (patchSettings) => {
    log.info('收到配置热更新请求，正在执行 reconfigure 流程...');

    if (patchSettings) {
      await settingsStore.save(patchSettings);
    }

    const settingsJson = settingsStore.getSettings();
    const mergedConfig = validateAndMergeConfig(deepMerge(deepMerge(DEFAULTS, rawConfig || {}), settingsJson));
    currentConfig = mergedConfig;

    if (controller) {
      await controller.dispose();
      controller = null;
    }

    if (napcatProc.status().installed) {
      await napcatProc.ensureConfigs().catch((e) => log.error('ensureConfigs 过程报错:', e));
    }

    controller = await mountAdapters(ctx, currentConfig, log);
    log.info('🎉 运行时热生效 (reconfigure) 已成功完成！');
  };

  // 4. webui 路由注册 (只注册一次)
  const webServer = ctx.get('webServer');
  if (webServer && typeof webServer.register === 'function') {
    log.info('探查到 webServer 服务，挂载 /bot-gateway/ 路由看板');

    // NapCatClient 按配置缓存复用（避免每次状态轮询都新建实例重复登录 WebUI）
    let cachedClient = null;
    let cachedClientKey = '';
    const getNapcatClient = () => {
      const napcatCfg = currentConfig.adapters?.onebot11?.napcatWebui || {};
      const key = `${napcatCfg.url || ''}|${napcatCfg.token || ''}`;
      if (!cachedClient || cachedClientKey !== key) {
        cachedClient = new NapCatClient({ url: napcatCfg.url, token: napcatCfg.token });
        cachedClientKey = key;
      }
      return cachedClient;
    };

    const handler = createWebuiHandler({
      getGateway: () => controller?.gateway,
      getNapcatClient,
      napcatProc,
      settingsStore,
      reconfigure,
      getEffectiveConfig: () => currentConfig,
      onNapcatInstalled: async () => {
        // 安装完成后 token 已写入 settings.json，触发一次 reconfigure 让
        // 内存中的 currentConfig（含扫码中继配置）立即生效
        try {
          await reconfigure();
          // 安装完成后按 autoStart 决定是否直接拉起进程
          const cfg = getConfig();
          if (cfg.napcat?.enabled && cfg.napcat?.autoStart) {
            await napcatProc.start().catch((e) => log.error('NapCat 自动启动失败:', e));
          }
        } catch (e) {
          log.error('安装后 reconfigure 失败:', e);
        }
      },
    });

    ctx.effect(() => {
      return webServer.register({
        kind: 'prefix',
        path: '/bot-gateway',
        handler,
      });
    }, 'bot-gateway: webui route');
  } else {
    log.warn('未探查到 webServer 服务，降级运行：禁用状态页看板');
  }

  // 5. 异步启动全流程
  (async () => {
    try {
      const settingsJson = await settingsStore.load();
      currentConfig = validateAndMergeConfig(deepMerge(deepMerge(DEFAULTS, rawConfig || {}), settingsJson));

      // 若 napcat 已安装且设置了 autoStart
      if (currentConfig.napcat?.enabled && currentConfig.napcat?.autoStart && napcatProc.status().installed) {
        napcatProc.start().catch((e) => log.error('NapCat 自动启动失败:', e));
      }

      controller = await mountAdapters(ctx, currentConfig, log);
      log.info('DSH Bot Gateway 插件启动完毕 (Stage C 完整 5 平台 + NapCat 托管 + Settings)');
    } catch (e) {
      log.error('插件启动失败:', e);
    }
  })();

  // 6. 声明对称清理 Disposer
  ctx.effect(() => async () => {
    log.info('清理 bot-gateway 插件句柄、适配器与 NapCat 托管进程...');
    try {
      if (controller) {
        await controller.dispose();
      }
      napcatProc.dispose();
    } catch (e) {
      log.error('清理过程报错:', e);
    }
  }, 'bot-gateway: disposer');
}
