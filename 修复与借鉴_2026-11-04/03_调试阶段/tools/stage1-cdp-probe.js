'use strict';

const fs = require('fs');
const path = require('path');

/**
 * stage1-cdp-probe —— 无依赖的 Chrome DevTools Protocol 探针（证书/渲染侧取证用）。
 *
 * 为什么需要它：
 *   1) **sandbox:true 是否真的生效**：从外面看进程树看不出来，必须在渲染进程里读
 *      `typeof require` / `typeof process`。阶段一已经吃过"dev 通过、打包失效"的亏，
 *      所以沙箱这类改动必须以**成品运行时的渲染侧事实**为准。
 *   2) **cookie 清理的副作用**：H-01/B-01 要清"旧后端源"的 cookie，绝不能顺手把用户在
 *      partition 内其它站点的登录态清掉。要做这个断言，必须先能"种一个外站 cookie"、
 *      重启后再"读回来"——这正是 CDP 的 Network.setCookie / getCookies。
 *
 * 依赖：只用 Node 24 自带的 fetch 与全局 WebSocket（不装 puppeteer / ws）。
 *
 * 用法（目标进程需带 `--remote-debugging-port=<port>` 启动）：
 *   node stage1-cdp-probe.js --port 9333 list
 *   node stage1-cdp-probe.js --port 9333 eval "typeof require + '|' + typeof process"
 *   node stage1-cdp-probe.js --port 9333 set-cookie --url https://example.com --name probe --value 1
 *   node stage1-cdp-probe.js --port 9333 get-cookies --url https://example.com
 *   退出码：0=成功；1=协议/断言失败；2=用法或连接失败。
 */

// 参数解析：选项可以出现在命令前后（早期版本把 argv[2] 当成命令，导致 `--port 9333 list` 解析失败）。
const opts = { port: 9222, url: 'https://example.com', name: 'dsh_probe', value: String(Date.now()), out: null, meta: null, minNodes: 150 };
const positionals = [];
(() => {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port') opts.port = Number(a[++i]);
    else if (a[i] === '--url') opts.url = a[++i];
    else if (a[i] === '--name') opts.name = a[++i];
    else if (a[i] === '--value') opts.value = a[++i];
    else if (a[i] === '--out') opts.out = a[++i];
    else if (a[i] === '--meta') opts.meta = a[++i];
    else if (a[i] === '--min-nodes') opts.minNodes = Number(a[++i]);
    else positionals.push(a[i]);
  }
})();

const targetPort = opts.port;

function argOf(name, dflt = null) {
  return Object.prototype.hasOwnProperty.call(opts, name) ? opts[name] : dflt;
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${targetPort}/json/list`);
  if (!res.ok) throw new Error('CDP /json/list HTTP ' + res.status);
  return res.json();
}

/** 找一个可 eval 的页面目标（优先 Web UI / 设置窗；跳过 devtools 自身）。 */
async function pickPage() {
  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''));
  if (!pages.length) throw new Error('没有可用的 page target（可能窗口还没起来）');
  // 优先选 http(s) 页面（主窗加载的是后端 Web UI），其次 file://（设置窗）
  pages.sort((a, b) => {
    const rank = (u) => (/^https?:/.test(u) ? 0 : /^file:/.test(u) ? 1 : 2);
    return rank(a.url || '') - rank(b.url || '');
  });
  return pages[0];
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }

  close() { try { this.ws.close(); } catch { /* 已关闭 */ } }
}

async function connect() {
  const page = await pickPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  return { session: new CdpSession(ws), page };
}

async function main() {
  const cmd = positionals[0];
  if (!cmd) { console.error('用法：node stage1-cdp-probe.js --port <p> list|eval|set-cookie|get-cookies'); process.exit(2); }

  if (cmd === 'list') {
    const targets = await listTargets();
    console.log(JSON.stringify(targets.map((t) => ({ type: t.type, title: t.title, url: t.url })), null, 2));
    return 0;
  }

  const { session, page } = await connect();

  if (cmd === 'eval') {
    const expr = positionals[1];
    if (!expr) throw new Error('eval 需要一个表达式参数');
    await session.send('Runtime.enable');
    const r = await session.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      console.error('页面内异常：' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      session.close();
      return 1;
    }
    console.log(JSON.stringify({ target: page.url, value: r.result && r.result.value }, null, 2));
    session.close();
    return 0;
  }

  if (cmd === 'set-cookie') {
    const url = argOf('url');
    const name = argOf('name');
    const value = argOf('value');
    await session.send('Network.enable');
    const r = await session.send('Network.setCookie', { name, value, url, path: '/', secure: true, sameSite: 'None' });
    console.log(JSON.stringify({ set: r.success, url, name, value }, null, 2));
    session.close();
    return r.success ? 0 : 1;
  }

  if (cmd === 'get-cookies') {
    const url = argOf('url', 'https://example.com');
    await session.send('Network.enable');
    const r = await session.send('Network.getCookies', { urls: [url] });
    console.log(JSON.stringify({ url, cookies: (r.cookies || []).map((c) => ({ name: c.name, value: c.value, domain: c.domain })) }, null, 2));
    session.close();
    return 0;
  }

  if (cmd === 'storage-keys') {
    await session.send('Runtime.enable');
    const r = await session.send('Runtime.evaluate', { expression: 'JSON.stringify({ls:Object.keys(localStorage),name:location.href})', awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify({ target: page.url, value: r.result && r.result.value }, null, 2));
    session.close();
    return 0;
  }

  /**
   * screenshot —— **target 级**截图（`Page.captureScreenshot`），并强制落元数据。
   *
   * 为什么不能用全桌面截屏：用 CopyFromScreen 抓的是"屏幕上当时最上层的东西"，
   * 应用不在前台时会抓到别的程序 —— 本仓库真发生过：两张名为"首帧"的截图分别是
   * 一个游戏画面和一个播放器窗口（已作废，见 03_调试阶段/视觉验收_0.3.49_首帧.json 的说明）。
   * 那比不截图更糟：它会让视觉验收变成形式主义，还可能掩盖真白屏。
   *
   * 纪律（不满足就不落盘、直接 exit 1）：
   *   1) 目标必须是 http://127.0.0.1:<port>/ 页面（不是 splash.html，不是 devtools）；
   *   2) 抓前断言 document.readyState === 'complete' 且 DOM 有实质内容（节点数/文本长度）；
   *   3) 落一张 PNG 的同时落同名 .json 元数据（captureMethod / targetUrl / viewport / assertions）；
   *   4) 顺带收集 Console/Log 的 error 级事件，供"挑刺式"视觉检查引用。
   */
  if (cmd === 'screenshot') {
    const out = argOf('out') || null;
    const meta = argOf('meta') || (out ? out.replace(/\.png$/i, '') + '.json' : null);
    const minNodes = Number(argOf('min-nodes') || 150);
    if (!out) { console.error('screenshot 需要 --out <png 路径>'); session.close(); return 2; }

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Log.enable').catch(() => { /* Log 域可选 */ });

    const probe = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const q = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
        const txt = (document.body && document.body.innerText || '').trim();
        return JSON.stringify({
          readyState: document.readyState,
          title: document.title || '',
          url: location.href,
          nodes: document.querySelectorAll('*').length,
          bodyTextLen: txt.length,
          bodyTextHead: txt.slice(0, 200),
          inputs: q('textarea, input[type="text"], input:not([type]), [contenteditable="true"]'),
          buttons: q('button'),
          svgIcons: q('svg'),
          errorish: (txt.match(/Failed to fetch|Cannot read propert|Uncaught|TypeError|白屏/gi) || []).slice(0, 5),
          dpr: window.devicePixelRatio || 1
        });
      })()`,
      returnByValue: true
    });
    const p = JSON.parse(probe.result.value);
    // 语义化断言（不是"正文长度 ≥ N"）：首页可能还没选工作区，正文只有几十字符，
    // 用长度阈值会误报。改为要求**命中若干关键 UI 锚点**，并且没有报错文案。
    const ANCHORS = ['新会话', '插件', '工作区', '自动化任务', '选择工作区', '探索未至之境', '标准模式', '预览版'];
    const anchorsHit = ANCHORS.filter((k) => (p.bodyTextHead || '').includes(k));
    const assertions = {
      readyState: p.readyState,
      readyStateOk: p.readyState === 'complete',
      urlIsLocalBackend: /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url),
      nodes: p.nodes,
      nodesOk: p.nodes >= minNodes,
      bodyTextLen: p.bodyTextLen,
      anchorsHit,
      // 语义化：至少命中 3 个关键锚点，且没有 error 级文案
      anchorsOk: anchorsHit.length >= 3,
      errorishEmpty: (p.errorish || []).length === 0,
      interactivePresent: p.inputs > 0 || p.buttons > 0
    };
    const failedAssertions = [];
    if (!assertions.readyStateOk) failedAssertions.push('readyStateOk');
    if (!assertions.urlIsLocalBackend) failedAssertions.push('urlIsLocalBackend');
    if (!assertions.nodesOk) failedAssertions.push('nodesOk');
    if (!assertions.anchorsOk) failedAssertions.push('anchorsOk');
    if (!assertions.errorishEmpty) failedAssertions.push('errorishEmpty');
    if (!assertions.interactivePresent) failedAssertions.push('interactivePresent');

    // 抓图（只截 target 的可见区域，必然属于该页面）
    await new Promise((r) => setTimeout(r, 1500)); // 留时间收集 console 事件
    const metrics = await session.send('Page.getLayoutMetrics').catch(() => null);
    const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });

    const consoleErrors = session.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params && e.params.entry && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text)
      .concat(session.events
        .filter((e) => e.method === 'Runtime.exceptionThrown')
        .map((e) => (e.params.exceptionDetails && e.params.exceptionDetails.text) || 'exception'))
      .slice(0, 20);

    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const pngBuf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.resolve(out), pngBuf);

    // 落盘后立刻读回校验：确认真的写出了 PNG（不是 0 字节、不是被截断的 base64）。
    // 本仓库出过"只有 json 没有 png"的事故（失败分支把图删了），所以这里自己先自证一次。
    const magicOk = pngBuf.length > 8 && pngBuf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const imagePixelSize = magicOk && pngBuf.toString('ascii', 12, 16) === 'IHDR'
      ? { width: pngBuf.readUInt32BE(16), height: pngBuf.readUInt32BE(20) }
      : null;

    const metaObj = {
      capturedAt: new Date().toISOString(),
      captureMethod: 'cdp-page-captureScreenshot',
      targetUrl: p.url,
      targetTitle: p.title,
      viewport: {
        width: metrics && metrics.cssVisualViewport ? metrics.cssVisualViewport.clientWidth : null,
        height: metrics && metrics.cssVisualViewport ? metrics.cssVisualViewport.clientHeight : null
      },
      devicePixelRatio: p.dpr || null,
      imagePixelSize,
      pngBytes: pngBuf.length,
      pngMagicOk: magicOk,
      assertions,
      failedAssertions,
      domProbe: { inputs: p.inputs, buttons: p.buttons, svgIcons: p.svgIcons, bodyTextHead: p.bodyTextHead, errorish: p.errorish },
      consoleErrors,
      note: '本图由 CDP Page.captureScreenshot 采集（target 级），不可能是其它程序的窗口；无本 .json 的截图不得作为验收证据。'
    };
    if (meta) {
      fs.mkdirSync(path.dirname(path.resolve(meta)), { recursive: true });
      fs.writeFileSync(path.resolve(meta), JSON.stringify(metaObj, null, 2) + '\n');
    }
    console.log(JSON.stringify(metaObj, null, 2));
    session.close();
    // 断言失败时不认这张图（文件保留供诊断，但 exit 1 让调用方无法当成"通过"）
    return failedAssertions.length ? 1 : 0;
  }

  console.error('未知命令：' + cmd);
  session.close();
  return 2;
}

main().then((code) => process.exit(code || 0)).catch((err) => {
  console.error('CDP 探针失败：' + (err && err.message || err));
  process.exit(2);
});
