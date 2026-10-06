/**
 * DSH 移动端引导应用 (Capacitor 壳引导脚本)
 * 包含：配对格式解析、Token 一次性交换、设备注册、HMAC-SHA256 签名续期与注销、实例管理。
 */

(() => {
  'use strict';

  /* ==========================================================================
     1. 加密与哈希工具 (Pure JS HMAC-SHA256 紧凑实现，公有领域 FIPS 180-4 / RFC 2104)
     ========================================================================== */

  function pureSha256(data) {
    function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
    function ch(x, y, z) { return (x & y) ^ (~x & z); }
    function maj(x, y, z) { return (x & y) ^ (x & z) ^ (y & z); }
    function sigma0(x) { return rotr(2, x) ^ rotr(13, x) ^ rotr(22, x); }
    function sigma1(x) { return rotr(6, x) ^ rotr(11, x) ^ rotr(25, x); }
    function gamma0(x) { return rotr(7, x) ^ rotr(18, x) ^ (x >>> 3); }
    function gamma1(x) { return rotr(17, x) ^ rotr(19, x) ^ (x >>> 10); }

    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = data.length;
    const bitLen = l * 8;
    const padLen = ((l + 8) >> 6 << 6) + 64;
    const padded = new Uint8Array(padLen);
    padded.set(data);
    padded[l] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padLen - 4, bitLen >>> 0);
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));

    const W = new Uint32Array(64);
    for (let i = 0; i < padLen; i += 64) {
      for (let t = 0; t < 16; t++) W[t] = view.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        W[t] = (gamma1(W[t - 2]) + W[t - 7] + gamma0(W[t - 15]) + W[t - 16]) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const T1 = (h + sigma1(e) + ch(e, f, g) + K[t] + W[t]) >>> 0;
        const T2 = (sigma0(a) + maj(a, b, c)) >>> 0;
        h = g; g = f; f = e; e = (d + T1) >>> 0;
        d = c; c = b; b = a; a = (T1 + T2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i]);
    return out;
  }

  function pureJsHmacSha256(keyBytes, msgBytes) {
    let k = keyBytes;
    if (k.length > 64) k = pureSha256(k);
    const keyPad = new Uint8Array(64);
    keyPad.set(k);
    const oKeyPad = new Uint8Array(64);
    const iKeyPad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      oKeyPad[i] = keyPad[i] ^ 0x5c;
      iKeyPad[i] = keyPad[i] ^ 0x36;
    }
    const inner = new Uint8Array(64 + msgBytes.length);
    inner.set(iKeyPad, 0);
    inner.set(msgBytes, 64);
    const innerHash = pureSha256(inner);

    const outer = new Uint8Array(64 + 32);
    outer.set(oKeyPad, 0);
    outer.set(innerHash, 64);
    const outerHash = pureSha256(outer);
    return Array.from(outerHash, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * HMAC-SHA256 计算入口：
   * 优先使用标准 Web Crypto API (crypto.subtle)；
   * 在非安全上下文或不受支持环境自动降级至纯 JS 实现。
   */
  async function computeHmacSha256(secretHex, message) {
    const enc = new TextEncoder();
    const msgBytes = enc.encode(message);
    const keyBytes = enc.encode(secretHex);

    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle && typeof window.crypto.subtle.importKey === 'function') {
      try {
        const cryptoKey = await window.crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const signature = await window.crypto.subtle.sign('HMAC', cryptoKey, msgBytes);
        return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
      } catch (err) {
        console.warn('[DSH] crypto.subtle 计算失败，使用纯 JS 算法回退:', err);
      }
    }
    return pureJsHmacSha256(keyBytes, msgBytes);
  }

  // 辅助随机数生成
  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function generateSecretHex(byteLen = 32) {
    const bytes = new Uint8Array(byteLen);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < byteLen; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function generateNonce() {
    return generateSecretHex(16);
  }

  function generateDefaultDeviceName() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return `Phone-${code}`;
  }

  /* ==========================================================================
     2.1 候选地址治理 (环回过滤 / 探活选优)
     ========================================================================== */

  function hostnameIsLoopback(hostname) {
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
    if (host === '0.0.0.0') return true;
    return false;
  }

  function isLoopbackOrigin(url) {
    try {
      return hostnameIsLoopback(new URL(url).hostname);
    } catch (err) {
      return hostnameIsLoopback(String(url));
    }
  }

  function isNativeRuntime() {
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  }

  /** 归一化候选地址：保留 http(s)、去重、去尾斜杠，维持载荷声明的优先级顺序。 */
  function normalizeOriginList(list) {
    const seen = new Set();
    const out = [];
    (Array.isArray(list) ? list : []).forEach((raw) => {
      const value = String(raw || '').trim().replace(/\/+$/, '');
      if (!value) return;
      let parsed;
      try {
        parsed = new URL(value);
      } catch (err) {
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      const key = parsed.origin.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(parsed.origin);
    });
    return out;
  }

  /**
   * 在真机上剔除环回候选——电脑生成的 127.0.0.1 / localhost / [::1] 指向的是电脑自己，
   * 手机上永远连不通。若候选全部是环回则原样保留（仍允许尝试），
   * 由调用方提示用户改用局域网地址。
   */
  function filterLoopbackCandidates(list) {
    const all = normalizeOriginList(list);
    if (!isNativeRuntime()) return { urls: all, candidates: all, loopbackOnly: false };
    const candidates = all.filter(url => !isLoopbackOrigin(url));
    if (candidates.length > 0) {
      return { urls: all, candidates, loopbackOnly: false };
    }
    return { urls: all, candidates: all, loopbackOnly: all.some(url => isLoopbackOrigin(url)) };
  }

  /** 对单个候选做 GET/HEAD /m/ 快速探活。 */
  async function probeOrigin(origin, timeoutMs = 2500) {
    const target = `${String(origin).replace(/\/+$/, '')}/m/`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const init = { cache: 'no-store', credentials: 'omit' };
      if (controller) init.signal = controller.signal;
      let res = await fetch(target, { ...init, method: 'HEAD' });
      // 部分服务端未实现 HEAD，回退 GET
      if (res.status === 405 || res.status === 501 || res.status >= 500) {
        res = await fetch(target, { ...init, method: 'GET' });
      }
      return res.status < 500;
    } catch (err) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 并发探活全部候选，返回载荷声明顺序中第一个可达的地址。
   * 全部不可达时回退首个候选，沿用上层原有报错逻辑。
   */
  async function pickReachableOrigin(list, timeoutMs = 2500) {
    const candidates = normalizeOriginList(list);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const results = await Promise.all(
      candidates.map(async (url) => ({ url, ok: await probeOrigin(url, timeoutMs) }))
    );
    console.log('[DSH] 候选地址探活:', results.map(r => `${r.url}=${r.ok}`).join(', '));
    const hit = results.find(item => item.ok);
    return hit ? hit.url : candidates[0];
  }

  /**
   * 把 URL 的 origin 改写为已选定的可达 origin（保留 path + query）。
   * 服务端有时按自身视角返回 127.0.0.1 / localhost 地址，手机侧无法直连。
   */
  function rewriteOrigin(url, targetOrigin) {
    try {
      const parsed = new URL(String(url), String(targetOrigin));
      const base = new URL(String(targetOrigin));
      return `${base.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (err) {
      return String(url);
    }
  }

  /* ==========================================================================
     2. 配对载荷解析器 (支持深链 / JSON / URL 三种格式)
     ========================================================================== */

  function normalizePairData(data, rawInput) {
    if (!data || typeof data !== 'object') throw new Error('解析失败：载荷非有效对象');
    const host = data.host || '';
    const port = Number(data.port) || 47896;
    const name = data.name || (host ? `${host}:${port}` : 'DSH 实例');
    const rawUrls = Array.isArray(data.urls) && data.urls.length > 0
      ? data.urls
      : (host ? [`http://${host}:${port}`] : []);

    if (rawUrls.length === 0) {
      throw new Error('未提供可访问的服务端 URL 列表');
    }

    const { urls, candidates, loopbackOnly } = filterLoopbackCandidates(rawUrls);
    if (candidates.length === 0) {
      throw new Error('未提供可用的服务端地址');
    }

    // 默认取首个优选候选；实际连接前会经探活替换为真正可达的地址
    const origin = candidates[0];
    const token = data.token || '';
    const tokenUrl = token ? `${origin}/?token=${encodeURIComponent(token)}` : origin;

    return {
      name,
      host,
      port,
      origin,
      urls,
      candidates,
      loopbackOnly,
      token,
      tokenUrl,
      relay: data.relay,
      raw: data,
      rawInput
    };
  }

  function parsePairPayload(input) {
    if (!input || typeof input !== 'string') {
      throw new Error('请输入配对内容');
    }
    const str = input.trim();

    // 格式 1: 深链形式 dshpair://<base64url(JSON)>
    if (/^dshpair:\/\//i.test(str)) {
      const rawB64 = str.replace(/^dshpair:\/\//i, '').trim();
      if (!rawB64) throw new Error('深链中无有效载荷数据');
      let b64 = rawB64.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      let jsonStr;
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        jsonStr = new TextDecoder('utf-8').decode(bytes);
      } catch (err) {
        throw new Error('Base64URL 解码失败: ' + err.message);
      }
      try {
        const parsed = JSON.parse(jsonStr);
        return normalizePairData(parsed, str);
      } catch (err) {
        throw new Error('深链中的 JSON 格式无效: ' + err.message);
      }
    }

    // 格式 2: 配对 JSON {v:1, type:'dsh-pair', ...}
    if ((str.startsWith('{') && str.endsWith('}')) || str.includes('"type":"dsh-pair"') || str.includes("'type':'dsh-pair'")) {
      try {
        const parsed = JSON.parse(str);
        return normalizePairData(parsed, str);
      } catch (err) {
        throw new Error('JSON 格式解析失败: ' + err.message);
      }
    }

    // 格式 3: 纯 http:// 或 https:// 带 token 的 URL
    if (/^https?:\/\//i.test(str)) {
      try {
        const u = new URL(str);
        const token = u.searchParams.get('token') || '';
        const host = u.hostname;
        const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
        const { urls, candidates, loopbackOnly } = filterLoopbackCandidates([u.origin]);
        return {
          name: host + (u.port ? `:${u.port}` : ''),
          host,
          port,
          origin: candidates[0] || u.origin,
          urls,
          candidates,
          loopbackOnly,
          token,
          tokenUrl: str,
          raw: null,
          rawInput: str
        };
      } catch (err) {
        throw new Error('URL 解析失败: ' + err.message);
      }
    }

    throw new Error('无法识别的内容格式，请提供 dshpair:// 深链、配对 JSON 或 http URL');
  }

  /* ==========================================================================
     3. Token 一次性交换 (隐藏 iframe 导航机制)
     ========================================================================== */

  /**
   * 在隐藏容器中创建 iframe 加载 tokenUrl 进行一次性 token 换取 Cookie
   * 采用双重等待机制：onload 触发后等待 800ms，或 2500ms 超时强制 resolve
   */
  function performTokenExchange(tokenUrl, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const host = document.getElementById('token-exchange-host');
      if (!host) {
        setTimeout(resolve, timeoutMs);
        return;
      }

      // 清理原有 iframe
      host.innerHTML = '';

      const iframe = document.createElement('iframe');
      iframe.style.width = '1px';
      iframe.style.height = '1px';
      iframe.style.display = 'none';

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        } catch (e) {}
        resolve();
      };

      const timer = setTimeout(done, timeoutMs);

      iframe.onload = () => {
        // onload 触发后再给浏览器网络层和 Cookie 写入预留 800ms 宽限期
        setTimeout(done, 800);
      };

      iframe.onerror = () => {
        done();
      };

      iframe.src = tokenUrl;
      host.appendChild(iframe);
    });
  }

  /* ==========================================================================
     3.5 凭据管理（原生交换 / 回填 WebView / 持久化）
     ========================================================================== */

  function getCapacitorHttp() {
    const cap = window.Capacitor;
    if (!cap || !cap.Plugins) return null;
    return cap.Plugins.CapacitorHttp || null;
  }

  function getCapacitorCookies() {
    const cap = window.Capacitor;
    if (!cap || !cap.Plugins) return null;
    return cap.Plugins.CapacitorCookies || null;
  }

  // 注意：cookie 名后半段是 encodeBase64Url(sha256(authority))，字符集为 [A-Za-z0-9_-]，
  // 不是十六进制——原来写成 [a-f0-9]+ 会几乎必然匹配失败（历史 bug，2026-09-19 修）。
  function isDshAuthCookieName(name) {
    return /^dsh-auth-[A-Za-z0-9_-]+$/.test(String(name || ''));
  }

  /**
   * 从 CapacitorHttp 响应 headers 中解析首个 dsh-auth-<hash> cookie。
   * 原生层把多个同名 header 用 ", " 拼接，且 Set-Cookie 的 Expires 也可能含 ", "，
   * 所以分段扫描，只认以 dsh-auth- 开头的段。
   */
  function extractDshAuthCookieFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const setCookieKey = Object.keys(headers).find(k => k.toLowerCase() === 'set-cookie');
    if (!setCookieKey) return null;
    const raw = headers[setCookieKey];
    if (!raw) return null;
    const segments = String(raw).split(/,\s*/);
    for (const segment of segments) {
      const m = segment.trim().match(/^(dsh-auth-[A-Za-z0-9_-]+)=([^;]*)/);
      if (m) return { name: m[1], value: m[2] };
    }
    return null;
  }

  /**
   * 原生层直接请求一次性 token URL，禁用自动跳转以抓取 302 响应里的 Set-Cookie。
   */
  async function exchangeTokenNative(tokenUrl) {
    const http = getCapacitorHttp();
    if (!http) {
      console.log('[DSH] CapacitorHttp 插件不可用');
      return null;
    }
    try {
      const res = await http.get({
        url: tokenUrl,
        disableRedirects: true,
        connectTimeout: 5000,
        readTimeout: 5000
      });
      console.log(`[DSH] 原生 token 交换状态: ${res.status}`);
      const cookie = extractDshAuthCookieFromHeaders(res.headers);
      if (cookie) {
        console.log(`[DSH] 原生交换取得 cookie: ${cookie.name}`);
      } else {
        console.log('[DSH] 原生交换响应中无 dsh-auth cookie');
      }
      return cookie;
    } catch (err) {
      console.warn('[DSH] 原生 token 交换异常:', err);
      return null;
    }
  }

  /**
   * 将 cookie 写回 WebView Cookie jar，供 WebSocket 与 WebView 请求携带。
   */
  async function setWebViewCookie(origin, cookieName, cookieValue) {
    const cookies = getCapacitorCookies();
    if (!cookies) {
      console.log('[DSH] CapacitorCookies 插件不可用，跳过 WebView 回填');
      return false;
    }
    try {
      await cookies.setCookie({
        url: origin,
        key: cookieName,
        value: cookieValue,
        path: '/'
      });
      console.log(`[DSH] 已回填 WebView Cookie: ${cookieName}`);
      return true;
    } catch (err) {
      console.warn('[DSH] 回填 WebView Cookie 失败:', err);
      return false;
    }
  }

  /**
   * 通过 iframe 完成 token 交换后，从 WebView Cookie jar 读取 dsh-auth cookie。
   * 仅对非 HttpOnly cookie 有效；HttpOnly 场景请依赖原生路径。
   */
  async function readDshAuthCookieFromWebView(origin) {
    const cookies = getCapacitorCookies();
    if (!cookies) return null;
    try {
      const map = await cookies.getCookies({ url: origin });
      const keys = Object.keys(map || {});
      console.log('[DSH] iframe 交换后 WebView cookies:', keys.join(', ') || '(空)');
      for (const key of keys) {
        if (isDshAuthCookieName(key)) {
          return { name: key, value: map[key] };
        }
      }
    } catch (err) {
      console.warn('[DSH] 读取 WebView Cookie 失败:', err);
    }
    return null;
  }

  /**
   * 统一会话 Cookie 获取：
   * 1) 优先用 CapacitorHttp 原生直取 Set-Cookie（可拿 HttpOnly）。
   * 2) 失败则回退到隐藏 iframe 交换 + 读取 WebView jar。
   * 两条路都失败时抛出明确中文错误。
   */
  async function exchangeSessionCookie(tokenUrl, origin) {
    let cookie = await exchangeTokenNative(tokenUrl);
    if (cookie) {
      await setWebViewCookie(origin, cookie.name, cookie.value);
      return cookie;
    }

    console.log('[DSH] 原生交换未取到 cookie，回退到隐藏 iframe 交换');
    await performTokenExchange(tokenUrl, 2500);
    cookie = await readDshAuthCookieFromWebView(origin);
    if (cookie) {
      console.log(`[DSH] iframe 回退取得 cookie: ${cookie.name}`);
      return cookie;
    }

    throw new Error('未取得会话凭证：无法从服务端获取设备授权 Cookie，请检查 token 是否已被使用或网络是否可达');
  }

  function buildCookieHeader(cookie) {
    if (!cookie || !cookie.name) return '';
    return `${cookie.name}=${cookie.value || ''}`;
  }

  function isSameOrigin(urlA, urlB) {
    try {
      return new URL(urlA).origin.toLowerCase() === new URL(urlB).origin.toLowerCase();
    } catch (err) {
      return false;
    }
  }

  /**
   * 针对实例 origin 的统一 fetch 包装：自动注入持久化的 dsh-auth Cookie。
   * 配合 CapacitorHttp 开启的场景，显式把 Cookie 带给原生 HTTP 层。
   */
  async function instanceFetch(instance, url, init = {}) {
    const headers = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([k, v]) => { headers[k] = v; });
      } else {
        Object.assign(headers, init.headers);
      }
    }

    const cookieHeader = buildCookieHeader({ name: instance.cookieKey, value: instance.cookieValue });
    if (cookieHeader && isSameOrigin(url, instance.origin)) {
      headers['Cookie'] = cookieHeader;
      console.log(`[DSH] 请求 ${url} 注入 Cookie: ${instance.cookieKey}=...`);
    }

    return fetch(url, { ...init, headers, credentials: 'omit' });
  }

  /**
   * 推送注册（M2 脚手架，特性开关）。
   * 仅当原生侧已安装 @capacitor/push-notifications（即 FCM 凭据已配置，见《配置手册》）
   * 时才工作；未安装时静默跳过，绝不阻断配对/连接流程。
   * 通知 payload 约定（由 relay/tools/dsh-push.mjs 构造）：data.url = <origin>/m/#/chat/<sessionId>
   */
  async function registerPushIfAvailable(instance, origin, deviceId) {
    try {
      const C = window.Capacitor;
      if (!C || !C.isPluginAvailable || !C.isPluginAvailable('PushNotifications')) {
        console.log('[DSH] 推送插件未安装（未配置 FCM 凭据），跳过注册');
        return { ok: false, skipped: true };
      }
      const PushNotifications = C.Plugins.PushNotifications;
      const perm = await PushNotifications.requestPermissions();
      if (!perm || perm.receive !== true) {
        console.warn('[DSH] 推送权限未授予');
        return { ok: false, reason: 'permission-denied' };
      }
      const token = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('推送注册超时')), 10000);
        PushNotifications.addListener('registration', (data) => {
          clearTimeout(timer);
          resolve(data && data.value);
        });
        try { PushNotifications.register(); } catch (e) { clearTimeout(timer); reject(e); }
      });
      if (!token) throw new Error('未取得 FCM 令牌');
      const res = await instanceFetch(instance, `${String(origin).replace(/\/+$/, '')}/api/mobile/push/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId, token, platform: 'android' }),
      });
      const data = await res.json().catch(() => null);
      if (!data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`);
      console.log('[DSH] 推送注册成功:', deviceId);
      // 通知点击：携带实例 URL + 会话 ID，点击直达对应会话
      if (PushNotifications.addListener) {
        PushNotifications.addListener('pushNotificationActionPerformed', (n) => {
          try {
            const payload = n && n.notification && n.notification.data;
            if (payload && payload.url) window.location.href = payload.url;
          } catch (e) { console.warn('[DSH] 通知点击处理失败:', e); }
        });
      }
      return { ok: true };
    } catch (e) {
      console.warn('[DSH] 推送注册失败（不影响使用）:', e && e.message ? e.message : e);
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /* ==========================================================================
     4. 设备管理与 API 交互 (Enroll, Renew, Unregister)
     ========================================================================== */

  /**
   * 发起设备注册 POST /api/mobile/devices/enroll
   * 显式注入 dsh-auth Cookie；若返回 401 则重新换取一次 Cookie 后重试。
   * 返回 { data, cookie } 以便调用方持久化最终 Cookie。
   */
  async function enrollDevice(origin, deviceId, deviceName, secretHex, tokenUrl, cookie) {
    const endpoint = `${origin.replace(/\/+$/, '')}/api/mobile/devices/enroll`;
    const payload = {
      deviceId,
      name: deviceName,
      model: navigator.userAgent.slice(0, 80),
      platform: 'capacitor',
      secret: secretHex
    };

    async function sendRequest(currentCookie) {
      const headers = { 'Content-Type': 'application/json' };
      if (currentCookie && currentCookie.name) {
        headers['Cookie'] = buildCookieHeader(currentCookie);
      }
      return fetch(endpoint, {
        method: 'POST',
        headers,
        credentials: 'omit',
        body: JSON.stringify(payload)
      });
    }

    let response;
    let currentCookie = cookie;
    try {
      response = await sendRequest(currentCookie);
      console.log(`[DSH] 设备注册首次响应: ${response.status}`);
    } catch (netErr) {
      throw new Error(`连接后端服务失败 (${netErr.message})，请检查网络与端口是否放行`);
    }

    // 401 时重新换取 Cookie 再试一次
    if (response.status === 401) {
      console.warn('[DSH] 设备注册返回 401，重新换取 Cookie 后重试...');
      updateLoadingText('正在重新同步安全凭据...', '等待服务凭据就绪');
      try {
        currentCookie = await exchangeSessionCookie(tokenUrl, origin);
      } catch (ex) {
        throw new Error('未取得会话凭证：' + ex.message);
      }

      try {
        response = await sendRequest(currentCookie);
        console.log(`[DSH] 设备注册重试响应: ${response.status}`);
      } catch (retryErr) {
        throw new Error(`重试连接后端失败: ${retryErr.message}`);
      }
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`[DSH] 设备注册失败: HTTP ${response.status}, 原因: ${errText || '无'}`);
      throw new Error(`设备注册被拒 (HTTP ${response.status}): ${errText || '服务端拒绝注册'}`);
    }

    const data = await response.json().catch(() => ({ ok: true }));
    return { data, cookie: currentCookie };
  }

  /**
   * 续期设备会话 POST /mobile/renew
   * 请求头: Authorization: DSH-Device <deviceId>:<hmacHex>
   * 签名内容: deviceId + '\n' + ts + '\n' + nonce + '\nrenew-v1'
   */
  async function renewDeviceSession(instance) {
    const origin = instance.origin.replace(/\/+$/, '');
    const endpoint = `${origin}/mobile/renew`;
    const ts = Date.now();
    const nonce = generateNonce();
    const signString = `${instance.deviceId}\n${ts}\n${nonce}\nrenew-v1`;

    const hmacHex = await computeHmacSha256(instance.deviceSecret, signString);

    let res;
    try {
      res = await instanceFetch(instance, endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `DSH-Device ${instance.deviceId}:${hmacHex}`
        },
        body: JSON.stringify({
          deviceId: instance.deviceId,
          ts,
          nonce
        })
      });
    } catch (err) {
      throw new Error(`无法连接至实例服务端 (${err.message})`);
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new Error('设备授权已失效或已被撤销，请重新配对 (HTTP ' + res.status + ')');
      }
      const text = await res.text().catch(() => '');
      throw new Error(`续期失败 (HTTP ${res.status}): ${text || '服务异常'}`);
    }

    const data = await res.json();
    if (!data.ok || !data.url) {
      throw new Error('服务端续期响应缺少有效凭证');
    }
    return data;
  }

  /**
   * 注销设备 POST /mobile/unregister
   * 签名内容: deviceId + '\n' + ts + '\n' + nonce + '\nunregister-v1'
   */
  async function unregisterDeviceSession(instance) {
    try {
      const origin = instance.origin.replace(/\/+$/, '');
      const endpoint = `${origin}/mobile/unregister`;
      const ts = Date.now();
      const nonce = generateNonce();
      const signString = `${instance.deviceId}\n${ts}\n${nonce}\nunregister-v1`;
      const hmacHex = await computeHmacSha256(instance.deviceSecret, signString);

      await instanceFetch(instance, endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `DSH-Device ${instance.deviceId}:${hmacHex}`
        },
        body: JSON.stringify({
          deviceId: instance.deviceId,
          ts,
          nonce
        })
      });
    } catch (e) {
      console.warn('[DSH] 后台注销请求失败 (可能已离线):', e);
    }
  }

  /* ==========================================================================
     5. 本地存储 (localStorage 'dsh.instances')
     ========================================================================== */

  const STORAGE_KEY = 'dsh.instances';

  function getStoredInstances() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.error('[DSH] 读取实例存储失败:', e);
      return [];
    }
  }

  function saveStoredInstances(instances) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(instances));
    } catch (e) {
      console.error('[DSH] 保存实例存储失败:', e);
    }
  }

  function upsertInstance(instance) {
    const list = getStoredInstances();
    const idx = list.findIndex(item => item.id === instance.id || (item.origin === instance.origin && item.deviceId === instance.deviceId));
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...instance, lastUsedAt: Date.now() };
    } else {
      list.unshift({ ...instance, lastUsedAt: Date.now() });
    }
    saveStoredInstances(list);
  }

  function removeInstance(id) {
    const list = getStoredInstances().filter(item => item.id !== id);
    saveStoredInstances(list);
  }

  function updateInstanceLastUsed(id) {
    const list = getStoredInstances();
    const target = list.find(item => item.id === id);
    if (target) {
      target.lastUsedAt = Date.now();
      saveStoredInstances(list);
    }
  }

  /* ==========================================================================
     6. UI 视图与交互控制器
     ========================================================================== */

  // DOM 元素引用
  const viewInstances = document.getElementById('view-instances');
  const viewPair = document.getElementById('view-pair');
  const headerTitle = document.getElementById('header-title');
  const btnHeaderAction = document.getElementById('btn-header-action');

  const instancesListEl = document.getElementById('instances-list');
  const emptyStateEl = document.getElementById('empty-state');
  const instanceCountEl = document.getElementById('instance-count');
  const btnGoPair = document.getElementById('btn-go-pair');
  const btnEmptyAdd = document.getElementById('btn-empty-add');

  const btnBackToList = document.getElementById('btn-back-to-list');
  const pairInput = document.getElementById('pair-input');
  const btnPasteClipboard = document.getElementById('btn-paste-clipboard');
  const parsePreviewBox = document.getElementById('parse-preview-box');
  const previewNameEl = document.getElementById('preview-name');
  const previewOriginEl = document.getElementById('preview-origin');
  const previewTokenStatusEl = document.getElementById('preview-token-status');
  const deviceNameInput = document.getElementById('device-name-input');
  const btnRandomName = document.getElementById('btn-random-name');
  const btnDoPair = document.getElementById('btn-do-pair');

  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingTitle = document.getElementById('loading-title');
  const loadingDesc = document.getElementById('loading-desc');
  const btnCancelLoading = document.getElementById('btn-cancel-loading');

  // 二维码识别相关元素
  const btnScanQr = document.getElementById('btn-scan-qr');
  const btnAlbumQr = document.getElementById('btn-album-qr');
  const qrFileInput = document.getElementById('qr-file-input');
  const qrScanOverlay = document.getElementById('qr-scan-overlay');
  const qrScanVideo = document.getElementById('qr-scan-video');
  const qrScanCanvas = document.getElementById('qr-scan-canvas');
  const qrScanTip = document.getElementById('qr-scan-tip');
  const btnCancelScan = document.getElementById('btn-cancel-scan');

  let currentParsedPayload = null;
  let activeOperationController = null;
  let lastLoopbackWarnInput = null;

  // 扫码会话状态
  let barcodeScannerPlugin = null;
  let scanListenerHandle = null;
  let scanResolved = false;
  let webScanStream = null;
  let webScanTimer = null;

  // 视图切换
  function switchView(viewName) {
    if (viewName === 'pair') {
      viewInstances.classList.remove('active');
      viewPair.classList.add('active');
      headerTitle.textContent = '添加新实例';
      if (!deviceNameInput.value) {
        deviceNameInput.value = generateDefaultDeviceName();
      }
      setTimeout(() => pairInput.focus(), 150);
    } else {
      viewPair.classList.remove('active');
      viewInstances.classList.add('active');
      headerTitle.textContent = 'DSH 工作台';
      renderInstanceList();
    }
  }

  // Toast 提示
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // 加载遮罩
  function showLoading(title, desc = '') {
    loadingTitle.textContent = title;
    loadingDesc.textContent = desc;
    loadingOverlay.classList.remove('hidden');
  }

  function updateLoadingText(title, desc = '') {
    loadingTitle.textContent = title;
    if (desc) loadingDesc.textContent = desc;
  }

  function hideLoading() {
    loadingOverlay.classList.add('hidden');
  }

  // 时间格式化
  function formatRelativeTime(ts) {
    if (!ts) return '从未连接';
    const now = Date.now();
    const diffSec = Math.floor((now - ts) / 1000);
    if (diffSec < 45) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    const days = Math.floor(diffSec / 86400);
    if (days === 1) return '昨天';
    if (days < 30) return `${days} 天前`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // 渲染实例列表
  function renderInstanceList() {
    const instances = getStoredInstances();
    instanceCountEl.textContent = instances.length;

    if (instances.length === 0) {
      instancesListEl.innerHTML = '';
      emptyStateEl.classList.remove('hidden');
      return;
    }

    emptyStateEl.classList.add('hidden');
    instancesListEl.innerHTML = instances.map(inst => `
      <div class="instance-card" data-id="${inst.id}">
        <div class="card-top">
          <div class="card-info">
            <div class="card-title">${escapeHtml(inst.name || 'DSH 实例')}</div>
            <div class="card-host">${escapeHtml(inst.origin)}</div>
          </div>
        </div>
        <div class="card-meta">最近使用：${formatRelativeTime(inst.lastUsedAt)}</div>
        <div class="card-actions">
          <button class="btn btn-primary btn-sm btn-connect" data-action="connect" data-id="${inst.id}">
            进入工作台
          </button>
          <button class="btn-card-del" data-action="delete" data-id="${inst.id}" title="删除此实例">
            删除
          </button>
        </div>
      </div>
    `).join('');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 连接已保存实例流程
  async function handleConnectInstance(id) {
    const instances = getStoredInstances();
    const target = instances.find(item => item.id === id);
    if (!target) {
      showToast('未找到该实例配置', 'error');
      return;
    }

    const card = document.querySelector(`.instance-card[data-id="${id}"]`);
    if (card) card.classList.add('connecting');

    showLoading('正在连接工作台...', `正在向 ${target.name || target.origin} 申请会话`);

    const cachedOrigin = String(target.origin || '');

    try {
      // 1. 确定可达地址：优先复用上次缓存的选中结果，失效则重新并发探活
      const candidates = normalizeOriginList(
        (target.candidates && target.candidates.length)
          ? target.candidates
          : (target.urls && target.urls.length ? target.urls : [cachedOrigin])
      );
      if (candidates.length === 0) throw new Error('未提供可用的服务端地址');

      let origin = candidates.indexOf(cachedOrigin) >= 0 ? cachedOrigin : candidates[0];
      if (candidates.length > 1) {
        updateLoadingText('正在选择可用地址...', `共 ${candidates.length} 个候选，选取首个可达地址`);
        if (!(await probeOrigin(origin, 1800))) {
          origin = await pickReachableOrigin(candidates);
        }
      }
      if (!origin) throw new Error('未找到可达的服务端地址');

      // 2. 选择结果缓存进实例档
      if (origin !== cachedOrigin) {
        upsertInstance({
          ...target,
          origin,
          urls: target.urls && target.urls.length ? target.urls : candidates,
          candidates,
          resolvedAt: Date.now()
        });
        target.origin = origin;
      }

      // 3. 发起 renew 请求换取最新根 token URL（自动带 Cookie）
      updateLoadingText('正在续期设备凭证...', '发送 HMAC 授权验证请求');
      const renewData = await renewDeviceSession(target);

      // 4. 用续期返回的新 tokenUrl 刷新 Cookie，回填 WebView jar 并持久化
      //    服务端返回的续期 URL 可能是其自身视角的地址（如 127.0.0.1），改写为选定的可达 origin
      updateLoadingText('正在建立会话凭证...', '同步安全 Cookie');
      let cookie;
      try {
        cookie = await exchangeSessionCookie(rewriteOrigin(renewData.url, origin), origin);
      } catch (ex) {
        throw new Error('未取得会话凭证：' + ex.message);
      }

      const updated = {
        ...target,
        origin,
        urls: target.urls && target.urls.length ? target.urls : candidates,
        candidates,
        cookieKey: cookie.name,
        cookieValue: cookie.value,
        cookieIssuedAt: Date.now(),
        resolvedAt: Date.now()
      };
      upsertInstance(updated);
      Object.assign(target, updated);

      // 5. 更新本地最近使用时间
      updateInstanceLastUsed(id);

      // 6. 跳转至后端 /m/ 移动 UI 路径
      updateLoadingText('正在进入移动工作台...', '页面跳转中');
      const targetUrl = `${origin.replace(/\/+$/, '')}/m/`;
      try { await registerPushIfAvailable(target, origin, target.deviceId || id); } catch (e) { console.warn('[DSH] 推送注册跳过:', e && e.message); }
      window.location.href = targetUrl;
    } catch (err) {
      hideLoading();
      if (card) card.classList.remove('connecting');
      console.error('[DSH] 连接失败:', err);
      showToast(err.message, 'error', 4500);
    }
  }

  // 删除实例流程
  async function handleDeleteInstance(id) {
    const instances = getStoredInstances();
    const target = instances.find(item => item.id === id);
    if (!target) return;

    const confirmed = window.confirm(`确定要移除实例【${target.name || target.origin}】吗？\n移除后若需再次使用需重新配对。`);
    if (!confirmed) return;

    // 后台静默注销
    unregisterDeviceSession(target);

    // 本地移除并刷新
    removeInstance(id);
    renderInstanceList();
    showToast('已移除该实例', 'info');
  }

  // 输入变化监听并解析
  function handlePairInputChange() {
    const val = pairInput.value.trim();
    if (!val) {
      lastLoopbackWarnInput = null;
      parsePreviewBox.classList.add('hidden');
      btnDoPair.disabled = true;
      currentParsedPayload = null;
      return;
    }

    try {
      const parsed = parsePairPayload(val);
      currentParsedPayload = parsed;
      previewNameEl.textContent = parsed.name || 'DSH 实例';
      previewOriginEl.textContent = parsed.origin;
      previewTokenStatusEl.textContent = parsed.token ? '包含有效 Token' : '未包含 Token (将尝试直连)';
      parsePreviewBox.classList.remove('hidden');
      btnDoPair.disabled = false;
      if (parsed.loopbackOnly && lastLoopbackWarnInput !== val) {
        lastLoopbackWarnInput = val;
        showToast('配对信息只含本机环回地址 (127.0.0.1 / localhost)，手机无法连接；请在电脑端改用局域网地址重新生成配对码', 'error', 6000);
      }
    } catch (e) {
      lastLoopbackWarnInput = null;
      parsePreviewBox.classList.add('hidden');
      btnDoPair.disabled = true;
      currentParsedPayload = null;
    }
  }

  // 执行配对并连接
  async function handleDoPair() {
    if (!currentParsedPayload) {
      showToast('请先输入有效的配对信息', 'error');
      return;
    }

    const payload = currentParsedPayload;
    const deviceName = (deviceNameInput.value || generateDefaultDeviceName()).trim();
    const deviceId = generateUUID();
    const deviceSecret = generateSecretHex(32);
    let cookie = null;

    showLoading('正在完成首次配对...', '步骤 1/3: 正在交换会话 Token');

    try {
      // 0. 探测可用地址：并发探活全部候选，取代无脑取 urls[0]
      const candidates = normalizeOriginList(
        payload.candidates && payload.candidates.length ? payload.candidates : payload.urls
      );
      if (candidates.length === 0) throw new Error('未提供可用的服务端地址');

      if (payload.loopbackOnly) {
        updateLoadingText('正在探测可用地址...', '配对信息只含本机环回地址，建议改用局域网地址');
      } else if (candidates.length > 1) {
        updateLoadingText('正在探测可用地址...', `共 ${candidates.length} 个候选，选取首个可达地址`);
      }
      const origin = await pickReachableOrigin(candidates);
      if (!origin) throw new Error('未提供可用的服务端地址');

      const tokenUrl = payload.token ? `${origin}/?token=${encodeURIComponent(payload.token)}` : origin;

      // 1. 会话 Cookie 获取：原生直取 Set-Cookie → 回填 WebView → 失败回退 iframe
      if (tokenUrl) {
        updateLoadingText('正在交换安全凭据...', '通过原生 HTTP 换取会话 Cookie');
        cookie = await exchangeSessionCookie(tokenUrl, origin);
      }

      // 2. 注册设备 (enroll)，显式带 Cookie
      updateLoadingText('正在登记本机设备...', '步骤 2/3: 注册至 DSH 后端');
      const enrollResult = await enrollDevice(origin, deviceId, deviceName, deviceSecret, tokenUrl, cookie);
      if (enrollResult && enrollResult.cookie) {
        cookie = enrollResult.cookie;
      }

      // 3. 保存到本地存储（含候选列表、本次选中结果与会话 Cookie）
      updateLoadingText('正在进入移动工作台...', '步骤 3/3: 配对完成，即将跳转');
      const newInstance = {
        id: deviceId,
        name: payload.name || 'DSH 实例',
        origin: origin,
        urls: payload.urls,
        candidates: candidates,
        loopbackOnly: !!payload.loopbackOnly,
        resolvedAt: Date.now(),
        deviceId: deviceId,
        deviceSecret: deviceSecret,
        cookieKey: cookie ? cookie.name : null,
        cookieValue: cookie ? cookie.value : null,
        cookieIssuedAt: cookie ? Date.now() : null,
        lastUsedAt: Date.now()
      };
      upsertInstance(newInstance);

      // 4. 跳转至 /m/ 路径
      const targetUrl = `${origin.replace(/\/+$/, '')}/m/`;
      try { await registerPushIfAvailable(newInstance, origin, deviceId); } catch (e) { console.warn('[DSH] 推送注册跳过:', e && e.message); }
      window.location.href = targetUrl;
    } catch (err) {
      hideLoading();
      console.error('[DSH] 配对失败:', err);
      showToast(err.message, 'error', 5000);
    }
  }

  /* ==========================================================================
     6.5 二维码识别（扫码配对 / 相册识别）
     ========================================================================== */

  const QR_ONLY_FORMATS = ['QR_CODE'];

  /**
   * 获取 ML Kit BarcodeScanner 插件代理。
   * 原生实现来自 @capacitor-mlkit/barcode-scanning（随 cap sync 编入），
   * 这里直接通过 Capacitor 注册代理使用，无需打包器。
   */
  function getBarcodeScanner() {
    if (barcodeScannerPlugin) return barcodeScannerPlugin;
    const cap = window.Capacitor;
    if (!cap || typeof cap.registerPlugin !== 'function') return null;
    if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('BarcodeScanner')) {
      return null;
    }
    barcodeScannerPlugin = cap.registerPlugin('BarcodeScanner');
    return barcodeScannerPlugin;
  }

  function extractBarcodeValue(barcode) {
    if (!barcode) return '';
    return barcode.rawValue || barcode.displayValue || '';
  }

  function showScanOverlay(mode, tip) {
    scanResolved = false;
    qrScanTip.textContent = tip || '正在启动相机...';
    if (mode === 'web') {
      qrScanVideo.classList.remove('hidden');
    } else {
      qrScanVideo.classList.add('hidden');
    }
    qrScanOverlay.classList.remove('hidden');
    qrScanOverlay.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('qr-scanning');
  }

  function hideScanOverlay() {
    qrScanOverlay.classList.add('hidden');
    qrScanOverlay.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('qr-scanning');
  }

  // ---------- 路径 1：ML Kit 原生相机（内置模型，离线可用，自定义取景 UI） ----------
  async function cleanupNativeScan() {
    try {
      if (scanListenerHandle && typeof scanListenerHandle.remove === 'function') {
        await scanListenerHandle.remove();
      }
    } catch (err) {
      console.warn('[DSH] 移除扫码监听失败:', err);
    }
    scanListenerHandle = null;
    if (barcodeScannerPlugin) {
      try {
        await barcodeScannerPlugin.stopScan();
      } catch (err) {
        /* 未处于扫描状态时忽略 */
      }
    }
  }

  async function scanWithMlKitCamera() {
    const scanner = getBarcodeScanner();
    if (!scanner) return false;

    const support = await scanner.isSupported();
    if (support && support.supported === false) return false;

    let status = await scanner.checkPermissions();
    if (!status || status.camera !== 'granted') {
      status = await scanner.requestPermissions();
    }
    if (!status || status.camera !== 'granted') {
      throw new Error('未获得相机权限，请在系统设置中允许 DSH 使用相机');
    }

    showScanOverlay('native', '正在启动相机...');
    try {
      scanListenerHandle = await scanner.addListener('barcodeScanned', (event) => {
        if (scanResolved) return;
        const value = extractBarcodeValue(event && event.barcode);
        if (!value) return;
        scanResolved = true;
        cleanupNativeScan();
        hideScanOverlay();
        handleScannedText(value);
      });
      await scanner.startScan({ formats: QR_ONLY_FORMATS });
      qrScanTip.textContent = '将二维码对准取景框';
      return true;
    } catch (err) {
      cleanupNativeScan();
      hideScanOverlay();
      throw err;
    }
  }

  // ---------- 路径 2：Google Code Scanner（插件内置扫码界面，需 Google Play 服务） ----------
  async function scanWithGoogleScanner() {
    const scanner = getBarcodeScanner();
    if (!scanner) throw new Error('扫码插件不可用');
    showScanOverlay('native', '正在打开扫码器...');
    try {
      const result = await scanner.scan({ formats: QR_ONLY_FORMATS });
      const list = (result && result.barcodes) || [];
      if (!list.length) throw new Error('未识别到二维码');
      return extractBarcodeValue(list[0]);
    } finally {
      hideScanOverlay();
    }
  }

  // ---------- 路径 3：getUserMedia + 内置 jsQR 纯 JS 扫码 ----------
  function stopWebScan() {
    if (webScanTimer) {
      clearTimeout(webScanTimer);
      webScanTimer = null;
    }
    if (webScanStream) {
      webScanStream.getTracks().forEach(track => track.stop());
      webScanStream = null;
    }
    qrScanVideo.srcObject = null;
  }

  function decodeVideoFrame() {
    const vw = qrScanVideo.videoWidth;
    const vh = qrScanVideo.videoHeight;
    if (!vw || !vh || typeof window.jsQR !== 'function') return null;
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    qrScanCanvas.width = w;
    qrScanCanvas.height = h;
    const ctx = qrScanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(qrScanVideo, 0, 0, w, h);
    const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
    return code && code.data ? code.data : null;
  }

  function webScanLoop() {
    if (scanResolved) return;
    if (qrScanVideo.readyState >= 2) {
      try {
        const value = decodeVideoFrame();
        if (value) {
          scanResolved = true;
          stopWebScan();
          hideScanOverlay();
          handleScannedText(value);
          return;
        }
      } catch (err) {
        console.warn('[DSH] 视频帧解码异常:', err);
      }
    }
    webScanTimer = setTimeout(webScanLoop, 130);
  }

  async function startWebScan() {
    if (typeof window.jsQR !== 'function') throw new Error('二维码解码库未加载');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前环境不支持调用相机');
    }
    showScanOverlay('web', '正在启动相机...');
    try {
      webScanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
      });
      qrScanVideo.srcObject = webScanStream;
      await qrScanVideo.play();
      qrScanTip.textContent = '将二维码对准取景框';
      webScanLoop();
    } catch (err) {
      stopWebScan();
      hideScanOverlay();
      throw err;
    }
  }

  // ---------- 相册识别 ----------
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('图片读取失败，请换一张图片重试'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败，请换一张图片重试'));
      img.src = dataUrl;
    });
  }

  function decodeImageElement(img) {
    if (typeof window.jsQR !== 'function') throw new Error('二维码解码库未加载');
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
    return code && code.data ? code.data : null;
  }

  async function handleAlbumPick(file) {
    if (!file) return;
    showLoading('正在识别二维码...', '读取并解码图片');
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const img = await loadImage(dataUrl);
      const value = decodeImageElement(img);
      hideLoading();
      if (!value) {
        showToast('未能识别到二维码，请换一张清晰的图片重试', 'error', 4000);
        return;
      }
      handleScannedText(value);
    } catch (err) {
      hideLoading();
      showToast(err.message || '图片识别失败', 'error', 4000);
    }
  }

  // ---------- 识别结果入口 ----------
  /**
   * 识别到的内容先交给 parsePairPayload：
   * 解析成功 -> 直接进入配对连接流程（扫一下即通）；
   * 解析失败 -> 回填输入框并提示用户手动处理。
   */
  function handleScannedText(text) {
    const value = String(text || '').trim();
    if (!value) {
      showToast('未能识别到二维码内容', 'error');
      return;
    }
    pairInput.value = value;
    handlePairInputChange();
    if (!currentParsedPayload) {
      showToast('识别到的内容不是有效的配对信息，请手动确认或修改', 'error', 4500);
      return;
    }
    showToast('识别成功，正在配对...', 'success', 2500);
    handleDoPair();
  }

  async function startCameraScan() {
    // 路径 1：ML Kit 原生相机
    try {
      if (await scanWithMlKitCamera()) return;
    } catch (err) {
      console.warn('[DSH] ML Kit 相机扫码失败:', err);
      if (err && err.message && err.message.indexOf('相机权限') >= 0) {
        showToast(err.message, 'error', 4000);
        return;
      }
    }

    // 路径 2：Google Code Scanner
    try {
      const value = await scanWithGoogleScanner();
      if (value) handleScannedText(value);
      return;
    } catch (err) {
      console.warn('[DSH] Google 扫码器不可用:', err);
    }

    // 路径 3：getUserMedia + jsQR
    try {
      await startWebScan();
    } catch (err) {
      hideScanOverlay();
      console.warn('[DSH] Web 扫码不可用:', err);
      showToast('无法启动相机扫码，请检查相机权限后重试', 'error', 4000);
    }
  }

  function cancelScan() {
    scanResolved = true;
    cleanupNativeScan();
    stopWebScan();
    hideScanOverlay();
    showToast('已取消扫码');
  }

  /* ==========================================================================
     7. 事件绑定与初始化
     ========================================================================== */

  function initEvents() {
    // 视图导航
    btnGoPair.addEventListener('click', () => switchView('pair'));
    btnEmptyAdd.addEventListener('click', () => switchView('pair'));
    btnBackToList.addEventListener('click', () => switchView('instances'));
    btnHeaderAction.addEventListener('click', () => {
      renderInstanceList();
      showToast('列表已刷新');
    });

    // 剪贴板粘贴
    btnPasteClipboard.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          const text = await navigator.clipboard.readText();
          if (text) {
            pairInput.value = text;
            handlePairInputChange();
            showToast('已从剪贴板读取', 'success');
          } else {
            showToast('剪贴板无内容');
          }
        } else {
          pairInput.focus();
          showToast('请直接在输入框中长按粘贴');
        }
      } catch (err) {
        pairInput.focus();
        showToast('无法访问剪贴板，请手动粘贴');
      }
    });

    // 配对输入实时监听
    pairInput.addEventListener('input', handlePairInputChange);
    pairInput.addEventListener('paste', () => setTimeout(handlePairInputChange, 50));

    // 扫码配对
    btnScanQr.addEventListener('click', () => {
      startCameraScan();
    });

    // 从相册识别二维码
    btnAlbumQr.addEventListener('click', () => {
      qrFileInput.value = '';
      qrFileInput.click();
    });
    qrFileInput.addEventListener('change', (e) => {
      const file = e.target && e.target.files && e.target.files[0];
      if (file) handleAlbumPick(file);
    });

    // 取消扫码
    btnCancelScan.addEventListener('click', cancelScan);

    // 随机设备名称
    btnRandomName.addEventListener('click', () => {
      deviceNameInput.value = generateDefaultDeviceName();
    });

    // 配对按钮
    btnDoPair.addEventListener('click', handleDoPair);

    // 取消加载
    btnCancelLoading.addEventListener('click', () => {
      hideLoading();
      showToast('已取消操作');
    });

    // 实例卡片列表操作代理 (点击连接 / 删除)
    instancesListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!id) return;

      if (action === 'connect') {
        handleConnectInstance(id);
      } else if (action === 'delete') {
        handleDeleteInstance(id);
      }
    });
  }

  // 引导启动
  document.addEventListener('DOMContentLoaded', () => {
    initEvents();
    renderInstanceList();
  });
})();
