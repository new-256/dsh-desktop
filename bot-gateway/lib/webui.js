/**
 * @file lib/webui.js
 * @description WebUI 状态页路由挂载、全量设置 API 与 NapCat 一键托管处理（前缀 /bot-gateway/）。
 *              包含三层安全防护（Loopback校验、Host端口比对、CSRF防御）、
 *              服务端状态缓存（防NapCat风暴）与运行时热生效前端交互。
 */

import { createLogger } from './util.js?v=10';

// 服务端缓存数据
let napcatStatusCache = { data: null, expiresAt: 0 };
let qrUrlCache = { data: null, expiresAt: 0 };

/**
 * 安全校验：Loopback、Host 端口与 CSRF 防御
 */
function validateRequestSecurity(req) {
  // 1. Loopback 地址校验
  const remoteAddr = req.socket.remoteAddress || '';
  const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  if (!isLoopback) {
    return { ok: false, status: 403, message: 'Forbidden: Direct access denied (loopback only)' };
  }

  // 2. Host 端口校验
  const hostHeader = req.headers.host || '';
  const localPort = req.socket.localPort;
  if (localPort) {
    const hostPortMatch = hostHeader.match(/:(\d+)$/);
    const hostPort = hostPortMatch ? Number(hostPortMatch[1]) : (req.socket.encrypted ? 443 : 80);
    if (hostPort !== localPort) {
      return { ok: false, status: 403, message: `Forbidden: Host port mismatch (expected ${localPort})` };
    }
  }

  // 3. CSRF 防护 (仅 POST 请求)
  if (req.method === 'POST') {
    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite) {
      if (secFetchSite !== 'same-origin') {
        return { ok: false, status: 403, message: 'Forbidden: CSRF blocked (sec-fetch-site)' };
      }
    } else {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originUrl = new URL(origin);
          if (originUrl.host !== hostHeader) {
            return { ok: false, status: 403, message: 'Forbidden: CSRF origin mismatch' };
          }
        } catch {
          return { ok: false, status: 403, message: 'Forbidden: Invalid Origin header' };
        }
      }
      // 注：对于无 Sec-Fetch-Site 且无 Origin 的纯工具请求 (如 curl / script) 放行
    }
  }

  return { ok: true };
}

/**
 * 读取 HTTP 请求 Body JSON
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error(`JSON 格式非法: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 挂载 WebUI 路由处理函数
 * @param {object} options
 * @param {function(): import('./core.js').Gateway} [options.getGateway]
 * @param {function(): import('./napcat.js').NapCatClient} [options.getNapcatClient]
 * @param {object} [options.napcatProc]
 * @param {object} [options.settingsStore]
 * @param {function(object): Promise<void>} [options.reconfigure]
 * @param {function(): object} [options.getEffectiveConfig]
 * @param {function(): Promise<void>} [options.onNapcatInstalled] - NapCat 安装完成后的回调
 * @param {import('./core.js').Gateway} [options.gateway] - 兼容旧接口
 * @param {import('./napcat.js').NapCatClient} [options.napcatClient] - 兼容旧接口
 */
export function createWebuiHandler(options) {
  const log = createLogger('webui');

  const getGateway = options.getGateway || (() => options.gateway);
  const getNapcatClient = options.getNapcatClient || (() => options.napcatClient);
  const { napcatProc, settingsStore, reconfigure, getEffectiveConfig } = options;

  return async function handleWebuiRequest(req, res) {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    // 安全防护校验
    const secCheck = validateRequestSecurity(req);
    if (!secCheck.ok) {
      log.warn(`安全拦截 (${pathname}): ${secCheck.message}`);
      res.writeHead(secCheck.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(secCheck.message);
      return;
    }

    try {
      // 1. GET /bot-gateway/ 或 /bot-gateway -> 状态 HTML 页
      if (pathname === '/bot-gateway' || pathname === '/bot-gateway/') {
        const html = renderStatusPageHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      // 2. GET /bot-gateway/api/status -> 状态 JSON API
      if (pathname === '/bot-gateway/api/status') {
        const gateway = getGateway();
        const napcatClient = getNapcatClient();
        const statusData = await getCachedStatusData(gateway, napcatClient, napcatProc);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(statusData));
        return;
      }

      // 3. GET /bot-gateway/api/settings -> 获取全量可编辑配置
      if (pathname === '/bot-gateway/api/settings' && req.method === 'GET') {
        const effectiveConfig = getEffectiveConfig ? getEffectiveConfig() : (getGateway()?.getSanitizedConfig() || {});
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, config: effectiveConfig }));
        return;
      }

      // 4. POST /bot-gateway/api/settings -> 保存设置并触发热生效 (reconfigure)
      if (pathname === '/bot-gateway/api/settings' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          if (typeof reconfigure === 'function') {
            await reconfigure(body);
          } else if (settingsStore) {
            await settingsStore.save(body);
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          log.error('保存设置失败:', e);
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 5. POST /bot-gateway/api/napcat/install -> 触发 NapCat 安装
      if (pathname === '/bot-gateway/api/napcat/install' && req.method === 'POST') {
        if (!napcatProc) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'NapCat 进程管理器未开启' }));
          return;
        }
        // 异步执行，立即返回；安装成功后回调 onNapcatInstalled 触发 reconfigure + 自动启动
        napcatProc.install()
          .then(() => (typeof options.onNapcatInstalled === 'function' ? options.onNapcatInstalled() : undefined))
          .catch((e) => log.error('后台 NapCat 安装失败:', e));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: 'NapCat 安装任务已在后台启动' }));
        return;
      }

      // 6. POST /bot-gateway/api/napcat/start -> 启动 NapCat 进程
      if (pathname === '/bot-gateway/api/napcat/start' && req.method === 'POST') {
        if (!napcatProc) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'NapCat 进程管理器未开启' }));
          return;
        }
        try {
          await napcatProc.start();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 7. POST /bot-gateway/api/napcat/stop -> 停止 NapCat 进程
      if (pathname === '/bot-gateway/api/napcat/stop' && req.method === 'POST') {
        if (!napcatProc) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'NapCat 进程管理器未开启' }));
          return;
        }
        try {
          await napcatProc.stop();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 8. GET /bot-gateway/api/qr/onebot11/image -> 二维码代理 (10s 缓存)
      if (pathname === '/bot-gateway/api/qr/onebot11/image') {
        const napcatClient = getNapcatClient();
        if (!napcatClient || !napcatClient.isConfigured) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('NapCat WebUI 未配置');
          return;
        }

        const now = Date.now();
        let qrInfo = qrUrlCache.data;
        if (!qrInfo || now > qrUrlCache.expiresAt) {
          qrInfo = await napcatClient.GetQQLoginQrcode().catch(() => null);
          qrUrlCache = { data: qrInfo, expiresAt: now + (qrInfo ? 10000 : 4000) };
        }

        if (!qrInfo || !qrInfo.qrcodeUrl) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('无法获取二维码');
          return;
        }

        const imgRes = await fetch(qrInfo.qrcodeUrl).catch(() => null);
        if (!imgRes || !imgRes.ok) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('代理获取二维码图片失败');
          return;
        }

        const contentType = imgRes.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'max-age=10' });
        res.end(buffer);
        return;
      }

      // 9. POST /bot-gateway/api/qr/onebot11/refresh -> 清缓存并重新拉取二维码
      if (pathname === '/bot-gateway/api/qr/onebot11/refresh' && req.method === 'POST') {
        const napcatClient = getNapcatClient();
        if (!napcatClient || !napcatClient.isConfigured) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'NapCat 未配置' }));
          return;
        }
        qrUrlCache = { data: null, expiresAt: 0 };
        const result = await napcatClient.GetQQLoginQrcode().catch((e) => ({ error: e.message }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      // 10. POST /bot-gateway/api/quick-login -> 触发快速登录
      if (pathname === '/bot-gateway/api/quick-login' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const uin = body.uin;
          const napcatClient = getNapcatClient();
          if (!uin || !napcatClient) throw new Error('缺少 uin 参数或 NapCat 未配置');
          await napcatClient.SetQuickLogin(uin);
          napcatStatusCache = { data: null, expiresAt: 0 };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (e) {
      log.error('WebUI 路由处理报错:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Internal Server Error: ${e.message}`);
      }
    }
  };
}

/**
 * 带 4 秒缓存机制的状态数据获取
 */
async function getCachedStatusData(gateway, napcatClient, napcatProc) {
  const adapters = gateway ? gateway.getAdapterStatuses() : [];
  const tasks = gateway ? gateway.getRecentTasks(20) : [];
  const config = gateway ? gateway.getSanitizedConfig() : {};

  const now = Date.now();
  let napcatInfo = napcatStatusCache.data;

  if (!napcatInfo || now > napcatStatusCache.expiresAt) {
    napcatInfo = { configured: false, isLogin: false };
    if (napcatClient && napcatClient.isConfigured) {
      napcatInfo.configured = true;
      try {
        const status = await napcatClient.CheckLoginStatus();
        napcatInfo.isLogin = status.isLogin;
        napcatInfo.uin = status.uin;

        if (!status.isLogin) {
          napcatInfo.quickLoginList = await napcatClient.GetQuickLoginList().catch(() => []);
        }
      } catch (e) {
        napcatInfo.error = e.message;
      }
    }
    napcatStatusCache = { data: napcatInfo, expiresAt: now + 4000 };
  }

  const napcatProcStatus = napcatProc ? napcatProc.status() : null;

  return {
    pluginVersion: gateway?.version || 'unknown',
    adapters,
    napcat: napcatInfo,
    napcatProc: napcatProcStatus,
    tasks,
    config,
    now,
  };
}

/**
 * 渲染 WebUI 状态与设置页 HTML
 */
function renderStatusPageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>DSH Bot Gateway — 看板与设置</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
    h2 { font-size: 18px; margin-top: 24px; margin-bottom: 12px; color: #e2e8f0; border-bottom: 1px solid #334155; padding-bottom: 6px; }
    .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .badge { background: #0284c7; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
    .card h3 { margin: 0 0 12px 0; font-size: 16px; display: flex; justify-content: space-between; align-items: center; }
    .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
    .dot-connected { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
    .dot-starting { background: #eab308; }
    .dot-reconnecting { background: #f97316; }
    .dot-error { background: #ef4444; }
    .dot-disabled { background: #64748b; }
    .dot-waiting-login { background: #a855f7; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; font-weight: 600; background: #0f172a; }
    tr:hover { background: #334155; }
    .qr-box { margin-top: 12px; text-align: center; background: #0f172a; padding: 12px; border-radius: 6px; }
    .qr-img { width: 160px; height: 160px; border: 2px solid #38bdf8; border-radius: 4px; }
    .btn { background: #0284c7; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; }
    .btn:hover { background: #0369a1; }
    .btn-secondary { background: #475569; }
    .btn-secondary:hover { background: #334155; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .notice { background: #1e293b; border-left: 4px solid #38bdf8; padding: 12px; margin-top: 24px; font-size: 13px; color: #94a3b8; }
    
    /* 进度条与表单样式 */
    .progress-bar-bg { background: #334155; border-radius: 4px; height: 12px; width: 100%; overflow: hidden; margin-top: 8px; }
    .progress-bar-fill { background: #38bdf8; height: 100%; width: 0%; transition: width 0.3s; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 13px; color: #cbd5e1; margin-bottom: 4px; }
    .form-control { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #334155; color: #f8fafc; padding: 8px; border-radius: 4px; font-size: 13px; }
    .form-control:focus { outline: none; border-color: #38bdf8; }
    textarea.form-control { resize: vertical; min-height: 50px; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
    details { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    summary { cursor: pointer; font-size: 16px; font-weight: 600; color: #38bdf8; outline: none; }
  </style>
</head>
<body>
  <h1>DSH Bot Gateway <span class="badge" id="version-tag">Stage C</span></h1>
  <div class="subtitle">IM 跨平台接入状态、 NapCat 进程托管与热生效设置</div>

  <!-- 适配器卡片区 -->
  <h2>适配器与托管状态</h2>
  <div class="grid" id="adapters-grid">
    <div class="card">加载中...</div>
  </div>

  <!-- NapCat 专属安装托管卡片 -->
  <div id="napcat-card-container"></div>

  <!-- 全量设置面板 (默认可折叠) -->
  <details id="settings-details">
    <summary>⚙️ 全部平台与通用参数设置 (点击展开/折叠)</summary>
    <form id="settings-form" style="margin-top: 16px;">
      
      <!-- NapCat 托管设置 -->
      <div class="card" style="margin-bottom: 16px;">
        <h3>🐱 NapCat 进程托管设置</h3>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom:0;">
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="cfg-napcat-enabled" /> 启用 NapCat 托管
            </label>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" id="cfg-napcat-autoStart" /> 自动启动已安装的 NapCat
            </label>
          </div>
          <div class="form-group">
            <label>下载镜像前缀 (可选)</label>
            <input type="text" class="form-control" id="cfg-napcat-mirror" placeholder="例: https://ghproxy.cn/" />
          </div>
          <div class="form-group">
            <label>自定版本号 (留空自动最新)</label>
            <input type="text" class="form-control" id="cfg-napcat-version" placeholder="例: 4.18.19" />
          </div>
          <div class="form-group">
            <label>WS 服务端口 (wsPort)</label>
            <input type="number" class="form-control" id="cfg-napcat-wsPort" value="3001" />
          </div>
          <div class="form-group">
            <label>WebUI 端口 (webuiPort)</label>
            <input type="number" class="form-control" id="cfg-napcat-webuiPort" value="6099" />
          </div>
        </div>
      </div>

      <!-- 5 大 IM 平台卡片 -->
      <h2>IM 平台适配器接入配置</h2>
      <div class="grid">
        <!-- OneBot11 -->
        <div class="card">
          <h3>OneBot 11 (QQ 个人号)</h3>
          <div class="form-group">
            <label class="checkbox-label"><input type="checkbox" id="cfg-ob11-enabled" /> 启用 OneBot11</label>
          </div>
          <div class="form-group">
            <label>连接模式</label>
            <select class="form-control" id="cfg-ob11-mode">
              <option value="forward-ws">正向 WebSocket (forward-ws)</option>
              <option value="reverse-ws">反向 WebSocket (reverse-ws)</option>
            </select>
          </div>
          <div class="form-group">
            <label>WS URL (正向)</label>
            <input type="text" class="form-control" id="cfg-ob11-url" placeholder="ws://127.0.0.1:3001" />
          </div>
          <div class="form-group">
            <label>监听端口 (反向)</label>
            <input type="number" class="form-control" id="cfg-ob11-listenPort" value="3002" />
          </div>
          <div class="form-group">
            <label>Access Token</label>
            <input type="text" class="form-control" id="cfg-ob11-accessToken" placeholder="无" />
          </div>
          <div class="form-group">
            <label>允许用户 (allowUsers 每行或逗号分隔)</label>
            <textarea class="form-control" id="cfg-ob11-allowUsers" placeholder="QQ号，例: 10001"></textarea>
          </div>
          <div class="form-group">
            <label>允许群组 (allowGroups 每行或逗号分隔)</label>
            <textarea class="form-control" id="cfg-ob11-allowGroups" placeholder="QQ群号，例: 88888"></textarea>
          </div>
        </div>

        <!-- QQ 官方 -->
        <div class="card">
          <h3>QQ 官方机器人</h3>
          <div class="form-group">
            <label class="checkbox-label"><input type="checkbox" id="cfg-qqofficial-enabled" /> 启用 QQ 官方</label>
          </div>
          <div class="form-group">
            <label>App ID</label>
            <input type="text" class="form-control" id="cfg-qqofficial-appId" />
          </div>
          <div class="form-group">
            <label>Client Secret</label>
            <input type="password" class="form-control" id="cfg-qqofficial-clientSecret" />
          </div>
          <div class="form-group">
            <label class="checkbox-label"><input type="checkbox" id="cfg-qqofficial-sandbox" /> 启用沙盒环境</label>
          </div>
          <div class="form-group">
            <label>允许用户 (allowUsers)</label>
            <textarea class="form-control" id="cfg-qqofficial-allowUsers" placeholder="OpenID，每行一个"></textarea>
          </div>
        </div>

        <!-- Telegram -->
        <div class="card">
          <h3>Telegram Bot</h3>
          <div class="form-group">
            <label class="checkbox-label"><input type="checkbox" id="cfg-tg-enabled" /> 启用 Telegram</label>
          </div>
          <div class="form-group">
            <label>Bot Token</label>
            <input type="password" class="form-control" id="cfg-tg-token" placeholder="123456:ABC-DEF..." />
          </div>
          <div class="form-group">
            <label>API Base</label>
            <input type="text" class="form-control" id="cfg-tg-apiBase" value="https://api.telegram.org" />
          </div>
          <div class="form-group">
            <label>允许用户 (allowUsers)</label>
            <textarea class="form-control" id="cfg-tg-allowUsers" placeholder="User ID，每行一个"></textarea>
          </div>
        </div>

        <!-- 飞书 -->
        <div class="card">
          <h3>飞书 (Feishu)</h3>
          <div class="form-group">
            <label class="checkbox-label"><input type="checkbox" id="cfg-fs-enabled" /> 启用飞书长连接</label>
          </div>
          <div class="form-group">
            <label>App ID</label>
            <input type="text" class="form-control" id="cfg-fs-appId" />
          </div>
          <div class="form-group">
            <label>App Secret</label>
            <input type="password" class="form-control" id="cfg-fs-appSecret" />
          </div>
          <div class="form-group">
            <label>允许用户 (allowUsers)</label>
            <textarea class="form-control" id="cfg-fs-allowUsers" placeholder="Open ID，每行一个"></textarea>
          </div>
        </div>

        <!-- 钉钉 -->
        <div class="card">
          <h3>钉钉 (DingTalk)</h3>
          <div class="form-group">
            <label class="checkbox-label"><input type="checkbox" id="cfg-dt-enabled" /> 启用钉钉 Stream</label>
          </div>
          <div class="form-group">
            <label>Client ID (AppKey)</label>
            <input type="text" class="form-control" id="cfg-dt-clientId" />
          </div>
          <div class="form-group">
            <label>Client Secret (AppSecret)</label>
            <input type="password" class="form-control" id="cfg-dt-clientSecret" />
          </div>
          <div class="form-group">
            <label>允许用户 (allowUsers)</label>
            <textarea class="form-control" id="cfg-dt-allowUsers" placeholder="Staff ID，每行一个"></textarea>
          </div>
        </div>
      </div>

      <!-- 通用设置 -->
      <div class="card" style="margin-top: 16px;">
        <h3>🌐 网关通用与 AI Agent 设置</h3>
        <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 0;">
          <div class="form-group">
            <label>Model Provider (留空跟随系统)</label>
            <input type="text" class="form-control" id="cfg-model-provider" placeholder="例: anthropic" />
          </div>
          <div class="form-group">
            <label>Model ID (留空跟随系统)</label>
            <input type="text" class="form-control" id="cfg-model-name" placeholder="例: claude-3-5-sonnet" />
          </div>
          <div class="form-group">
            <label>Agent Preset 预设名称</label>
            <input type="text" class="form-control" id="cfg-agentPreset" placeholder="例: default" />
          </div>
          <div class="form-group">
            <label>文本分块长度 (replyChunkChars)</label>
            <input type="number" class="form-control" id="cfg-replyChunkChars" value="1800" />
          </div>
          <div class="form-group">
            <label>进度通知间隔 ms (progressIntervalMs)</label>
            <input type="number" class="form-control" id="cfg-progressIntervalMs" value="180000" />
          </div>
          <div class="form-group">
            <label class="checkbox-label" style="margin-top: 24px;">
              <input type="checkbox" id="cfg-turnStartNotify" /> 开启回合启动通知
            </label>
          </div>
        </div>
      </div>

      <div style="margin-top: 16px; text-align: right;">
        <button type="button" class="btn" style="padding: 10px 24px; font-size: 15px;" onclick="saveSettings()">💾 保存设置并应用（热生效）</button>
      </div>
    </form>
  </details>

  <!-- 最近任务列表 -->
  <h2>最近任务列表</h2>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Task ID</th>
          <th>适配器</th>
          <th>Chat / 用户</th>
          <th>标题</th>
          <th>状态</th>
          <th>工作目录</th>
        </tr>
      </thead>
      <tbody id="tasks-table">
        <tr><td colspan="6">暂无任务</td></tr>
      </tbody>
    </table>
  </div>

  <div class="notice">
    <strong>安全提醒：</strong> Bot Gateway 远程任务继承全局权限。请务必检查凭证与 <code>allowUsers</code>，仅添加信任的社交账号。
  </div>

  <script>
    let lastAdapterSignature = '';
    let isFormPopulated = false;

    async function updateDashboard() {
      try {
        const res = await fetch('/bot-gateway/api/status');
        const data = await res.json();

        if (data.pluginVersion) {
          document.getElementById('version-tag').textContent = 'v' + data.pluginVersion;
        }

        const signature = JSON.stringify(data.adapters) + JSON.stringify(data.napcat) + JSON.stringify(data.napcatProc);
        if (signature !== lastAdapterSignature) {
          lastAdapterSignature = signature;
          renderAdapters(data);
          renderNapCatCard(data.napcatProc);
        }

        renderTasks(data.tasks);

        if (!isFormPopulated) {
          fetchSettings();
        }
      } catch (e) {
        console.error('更新看板失败:', e);
      }
    }

    function renderAdapters(data) {
      const grid = document.getElementById('adapters-grid');
      grid.innerHTML = '';

      data.adapters.forEach(a => {
        const card = document.createElement('div');
        card.className = 'card';

        const stateMap = {
          connected: 'dot-connected',
          starting: 'dot-starting',
          reconnecting: 'dot-reconnecting',
          error: 'dot-error',
          disabled: 'dot-disabled',
          'waiting-login': 'dot-waiting-login'
        };
        const dotClass = stateMap[a.state] || 'dot-disabled';

        let extraHtml = '';
        if (a.kind === 'onebot11' && data.napcat && data.napcat.configured) {
          if (data.napcat.isLogin) {
            extraHtml = \`<div style="margin-top:8px;color:#22c55e;font-size:13px;">✅ WebUI 已登录 (QQ: \${data.napcat.uin || '已连上'})\</div>\`;
          } else {
            extraHtml = \`
              <div class="qr-box">
                <div style="font-size:12px;margin-bottom:6px;color:#cbd5e1;">扫码登录 QQ</div>
                <img class="qr-img" src="/bot-gateway/api/qr/onebot11/image?t=\${Date.now()}" alt="登录二维码" />
                <div><button class="btn" onclick="refreshQr()">刷新二维码</button></div>
              </div>
            \`;
            if (data.napcat.quickLoginList && data.napcat.quickLoginList.length > 0) {
              extraHtml += '<div style="margin-top:8px;font-size:12px;">快速登录：';
              data.napcat.quickLoginList.forEach(q => {
                extraHtml += \`<button class="btn" style="margin-right:4px;" onclick="quickLogin('\${q.uin}')">\${q.nickName || q.uin}</button>\`;
              });
              extraHtml += '</div>';
            }
          }
        }

        card.innerHTML = \`
          <h3>
            <span>\${a.kind.toUpperCase()}</span>
            <span><span class="status-dot \${dotClass}"></span>\${a.state}</span>
          </h3>
          <div style="font-size:13px;color:#94a3b8;">\${a.detail || ''}</div>
          \${a.selfId ? \`<div style="font-size:12px;color:#64748b;margin-top:4px;">Bot ID: \${a.selfId}</div>\` : ''}
          \${extraHtml}
        \`;
        grid.appendChild(card);
      });
    }

    function renderNapCatCard(proc) {
      const container = document.getElementById('napcat-card-container');
      if (!proc) {
        container.innerHTML = '';
        return;
      }

      let btnHtml = '';
      if (!proc.installed) {
        btnHtml = \`<button class="btn" onclick="installNapCat()">🚀 一键安装 NapCat (自包含 Node+QQNT)</button>\`;
      } else {
        if (proc.running) {
          btnHtml = \`<button class="btn btn-danger" onclick="stopNapCat()">🛑 停止 NapCat 进程 (PID: \${proc.pid})</button>\`;
        } else {
          btnHtml = \`<button class="btn" onclick="startNapCat()">▶️ 启动 NapCat 进程</button>\`;
        }
      }

      let progressHtml = '';
      if (proc.installing || proc.progress.phase !== 'idle') {
        const p = proc.progress;
        let percent = 0;
        if (p.total > 0) percent = Math.min(100, Math.floor((p.bytes / p.total) * 100));
        const loadedMb = (p.bytes / 1024 / 1024).toFixed(1);
        const totalMb = p.total > 0 ? (p.total / 1024 / 1024).toFixed(1) : '?';

        progressHtml = \`
          <div style="margin-top: 12px; font-size: 13px; color: #38bdf8;">
            状态: <strong>\${p.phase}</strong> \${p.phase === 'downloading' ? \`(\${loadedMb}MB / \${totalMb}MB - \${percent}%)\` : ''}
            <div class="progress-bar-bg">
              <div class="progress-bar-fill" style="width: \${percent}%"></div>
            </div>
          </div>
        \`;
      }

      let errorHtml = '';
      if (proc.lastError) {
        errorHtml = \`<div style="margin-top:8px; color:#ef4444; font-size:13px;">❌ 异常: \${proc.lastError}</div>\`;
      }

      container.innerHTML = \`
        <div class="card" style="margin-bottom: 24px; border-color: #0284c7;">
          <h3>
            <span>🐱 NapCatQQ 进程托管中心</span>
            <span class="badge" style="background:\${proc.running ? '#22c55e' : proc.installed ? '#0284c7' : '#64748b'}">
              \${proc.running ? '运行中 (PID ' + proc.pid + ')' : proc.installed ? '已安装 v' + (proc.version||'') : '未安装'}
            </span>
          </h3>
          <div style="font-size: 13px; color: #94a3b8;">
            目录: <code>\${proc.installDir}</code>
          </div>
          \${progressHtml}
          \${errorHtml}
          <div style="margin-top: 12px; display: flex; gap: 12px; align-items: center;">
            \${btnHtml}
          </div>
        </div>
      \`;
    }

    function renderTasks(tasks) {
      const tbody = document.getElementById('tasks-table');
      if (tasks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:#64748b;text-align:center;">暂无任务</td></tr>';
      } else {
        tbody.innerHTML = '';
        tasks.forEach(t => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><code>\${t.id}</code></td>
            <td>\${t.adapter}</td>
            <td>\${t.chatId}</td>
            <td>\${t.title}</td>
            <td><span class="badge" style="background:\${t.status === 'running' ? '#0284c7' : t.status === 'error' ? '#ef4444' : '#64748b'}">\${t.status}</span></td>
            <td style="font-size:12px;color:#94a3b8;">\${t.workspaceDir}</td>
          \`;
          tbody.appendChild(tr);
        });
      }
    }

    async function installNapCat() {
      try {
        const res = await fetch('/bot-gateway/api/napcat/install', { method: 'POST' });
        const data = await res.json();
        if (data.ok) alert('NapCat 一键安装任务已启动，请关注下方进度条！');
        else alert('安装发起失败: ' + data.error);
        lastAdapterSignature = '';
        updateDashboard();
      } catch (e) { alert('请求报错: ' + e.message); }
    }

    async function startNapCat() {
      try {
        const res = await fetch('/bot-gateway/api/napcat/start', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) alert('启动失败: ' + data.error);
        lastAdapterSignature = '';
        updateDashboard();
      } catch (e) { alert('请求报错: ' + e.message); }
    }

    async function stopNapCat() {
      try {
        const res = await fetch('/bot-gateway/api/napcat/stop', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) alert('停止失败: ' + data.error);
        lastAdapterSignature = '';
        updateDashboard();
      } catch (e) { alert('请求报错: ' + e.message); }
    }

    async function refreshQr() {
      await fetch('/bot-gateway/api/qr/onebot11/refresh', { method: 'POST' });
      lastAdapterSignature = '';
      updateDashboard();
    }

    async function quickLogin(uin) {
      await fetch('/bot-gateway/api/quick-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uin })
      });
      lastAdapterSignature = '';
      updateDashboard();
    }

    async function fetchSettings() {
      try {
        const res = await fetch('/bot-gateway/api/settings');
        const data = await res.json();
        if (data.ok && data.config) {
          populateForm(data.config);
          isFormPopulated = true;
        }
      } catch (e) {
        console.error('获取 settings 失败:', e);
      }
    }

    function populateForm(cfg) {
      const nap = cfg.napcat || {};
      document.getElementById('cfg-napcat-enabled').checked = nap.enabled !== false;
      document.getElementById('cfg-napcat-autoStart').checked = nap.autoStart !== false;
      document.getElementById('cfg-napcat-mirror').value = nap.mirror || '';
      document.getElementById('cfg-napcat-version').value = nap.version || '';
      document.getElementById('cfg-napcat-wsPort').value = nap.wsPort || 3001;
      document.getElementById('cfg-napcat-webuiPort').value = nap.webuiPort || 6099;

      const ad = cfg.adapters || {};
      const ob = ad.onebot11 || {};
      document.getElementById('cfg-ob11-enabled').checked = ob.enabled !== false;
      document.getElementById('cfg-ob11-mode').value = ob.mode || 'forward-ws';
      document.getElementById('cfg-ob11-url').value = ob.url || 'ws://127.0.0.1:3001';
      document.getElementById('cfg-ob11-listenPort').value = ob.listenPort || 3002;
      document.getElementById('cfg-ob11-accessToken').value = ob.accessToken || '';
      document.getElementById('cfg-ob11-allowUsers').value = Array.isArray(ob.allowUsers) ? ob.allowUsers.join('\n') : '';
      document.getElementById('cfg-ob11-allowGroups').value = Array.isArray(ob.allowGroups) ? ob.allowGroups.join('\n') : '';

      const qq = ad.qqofficial || {};
      document.getElementById('cfg-qqofficial-enabled').checked = !!qq.enabled;
      document.getElementById('cfg-qqofficial-appId').value = qq.appId || '';
      document.getElementById('cfg-qqofficial-clientSecret').value = qq.clientSecret || '';
      document.getElementById('cfg-qqofficial-sandbox').checked = !!qq.sandbox;
      document.getElementById('cfg-qqofficial-allowUsers').value = Array.isArray(qq.allowUsers) ? qq.allowUsers.join('\n') : '';

      const tg = ad.telegram || {};
      document.getElementById('cfg-tg-enabled').checked = !!tg.enabled;
      document.getElementById('cfg-tg-token').value = tg.token || '';
      document.getElementById('cfg-tg-apiBase').value = tg.apiBase || 'https://api.telegram.org';
      document.getElementById('cfg-tg-allowUsers').value = Array.isArray(tg.allowUsers) ? tg.allowUsers.join('\n') : '';

      const fs = ad.feishu || {};
      document.getElementById('cfg-fs-enabled').checked = !!fs.enabled;
      document.getElementById('cfg-fs-appId').value = fs.appId || '';
      document.getElementById('cfg-fs-appSecret').value = fs.appSecret || '';
      document.getElementById('cfg-fs-allowUsers').value = Array.isArray(fs.allowUsers) ? fs.allowUsers.join('\n') : '';

      const dt = ad.dingtalk || {};
      document.getElementById('cfg-dt-enabled').checked = !!dt.enabled;
      document.getElementById('cfg-dt-clientId').value = dt.clientId || '';
      document.getElementById('cfg-dt-clientSecret').value = dt.clientSecret || '';
      document.getElementById('cfg-dt-allowUsers').value = Array.isArray(dt.allowUsers) ? dt.allowUsers.join('\n') : '';

      document.getElementById('cfg-model-provider').value = cfg.model?.provider || '';
      document.getElementById('cfg-model-name').value = cfg.model?.name || '';
      document.getElementById('cfg-agentPreset').value = cfg.agentPreset || '';
      document.getElementById('cfg-replyChunkChars').value = cfg.replyChunkChars || 1800;
      document.getElementById('cfg-progressIntervalMs').value = cfg.progressIntervalMs || 180000;
      document.getElementById('cfg-turnStartNotify').checked = cfg.turnStartNotify !== false;
    }

    function parseList(val) {
      if (!val) return [];
      return val.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    }

    async function saveSettings() {
      const payload = {
        napcat: {
          enabled: document.getElementById('cfg-napcat-enabled').checked,
          autoStart: document.getElementById('cfg-napcat-autoStart').checked,
          mirror: document.getElementById('cfg-napcat-mirror').value.trim(),
          version: document.getElementById('cfg-napcat-version').value.trim(),
          wsPort: Number(document.getElementById('cfg-napcat-wsPort').value) || 3001,
          webuiPort: Number(document.getElementById('cfg-napcat-webuiPort').value) || 6099,
        },
        replyChunkChars: Number(document.getElementById('cfg-replyChunkChars').value) || 1800,
        progressIntervalMs: Number(document.getElementById('cfg-progressIntervalMs').value) || 180000,
        turnStartNotify: document.getElementById('cfg-turnStartNotify').checked,
        agentPreset: document.getElementById('cfg-agentPreset').value.trim(),
        model: {
          provider: document.getElementById('cfg-model-provider').value.trim(),
          name: document.getElementById('cfg-model-name').value.trim(),
        },
        adapters: {
          onebot11: {
            enabled: document.getElementById('cfg-ob11-enabled').checked,
            mode: document.getElementById('cfg-ob11-mode').value,
            url: document.getElementById('cfg-ob11-url').value.trim(),
            listenPort: Number(document.getElementById('cfg-ob11-listenPort').value) || 3002,
            accessToken: document.getElementById('cfg-ob11-accessToken').value.trim(),
            allowUsers: parseList(document.getElementById('cfg-ob11-allowUsers').value),
            allowGroups: parseList(document.getElementById('cfg-ob11-allowGroups').value),
          },
          qqofficial: {
            enabled: document.getElementById('cfg-qqofficial-enabled').checked,
            appId: document.getElementById('cfg-qqofficial-appId').value.trim(),
            clientSecret: document.getElementById('cfg-qqofficial-clientSecret').value.trim(),
            sandbox: document.getElementById('cfg-qqofficial-sandbox').checked,
            allowUsers: parseList(document.getElementById('cfg-qqofficial-allowUsers').value),
          },
          telegram: {
            enabled: document.getElementById('cfg-tg-enabled').checked,
            token: document.getElementById('cfg-tg-token').value.trim(),
            apiBase: document.getElementById('cfg-tg-apiBase').value.trim(),
            allowUsers: parseList(document.getElementById('cfg-tg-allowUsers').value),
          },
          feishu: {
            enabled: document.getElementById('cfg-fs-enabled').checked,
            appId: document.getElementById('cfg-fs-appId').value.trim(),
            appSecret: document.getElementById('cfg-fs-appSecret').value.trim(),
            allowUsers: parseList(document.getElementById('cfg-fs-allowUsers').value),
          },
          dingtalk: {
            enabled: document.getElementById('cfg-dt-enabled').checked,
            clientId: document.getElementById('cfg-dt-clientId').value.trim(),
            clientSecret: document.getElementById('cfg-dt-clientSecret').value.trim(),
            allowUsers: parseList(document.getElementById('cfg-dt-allowUsers').value),
          }
        }
      };

      try {
        const res = await fetch('/bot-gateway/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
          alert('✅ 设置已成功保存并同步热生效！');
          lastAdapterSignature = '';
          updateDashboard();
        } else {
          alert('❌ 保存失败: ' + data.error);
        }
      } catch (e) {
        alert('❌ 保存请求异常: ' + e.message);
      }
    }

    updateDashboard();
    setInterval(updateDashboard, 3000);
  </script>
</body>
</html>`;
}
