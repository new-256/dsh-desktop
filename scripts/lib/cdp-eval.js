'use strict';

/**
 * cdp-eval —— 极简 Chrome DevTools Protocol 客户端（0.3.49 · B-05 真机证据用）。
 *
 * 为什么自己写：本机没有 `ws` / `playwright` / `puppeteer` 依赖，而"sandbox 是否
 * 真的生效、preload 桥是否还能用"这种事**必须**在真实 Electron 渲染进程里求值，
 * 不能靠读源码推断。CDP 的最小可用面就两件事：
 *   1. GET /json/list 拿到每个页面的 webSocketDebuggerUrl；
 *   2. 用 WebSocket 发一条 `Runtime.evaluate`（awaitPromise + returnByValue）。
 * 于是这里手写握手与帧编解码（仅客户端→服务端的文本帧、服务端→客户端的非分片帧）。
 *
 * 纪律：连不上/求值报错都**抛出**，绝不返回"看起来成功"的空结果。
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC44DF';

/** GET http://host:port/path → { status, body } */
function httpGet(port, pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(new Error(`CDP HTTP 超时（${pathname}）`)); });
    req.on('error', reject);
  });
}

/** 列出所有可调试目标（页面/worker）。 */
async function listTargets(port) {
  const res = await httpGet(port, '/json/list');
  if (res.status !== 200) throw new Error(`CDP /json/list 返回 ${res.status}`);
  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) { throw new Error('CDP /json/list 不是合法 JSON：' + e.message); }
  return Array.isArray(parsed) ? parsed : [];
}

/** 手写 WebSocket 文本帧编码（客户端必须加掩码）。 */
function encodeFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81; // FIN + text
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** 从 TCP 缓冲里切出完整帧；返回 [parsed, rest] 或 null（数据不够）。 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  if (masked) offset += 4; // 服务端一般不加掩码，这里只做兼容
  if (buf.length < offset + len) return null;
  const payload = buf.slice(offset, offset + len);
  return { opcode, payload, rest: buf.slice(offset + len) };
}

/**
 * 连到一个 target 的 WebSocket，返回 { evaluate(expr, opts), close() }。
 * @param {string} wsUrl 例如 ws://127.0.0.1:9300/devtools/page/ABC
 */
function connect(wsUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n`
        + `Host: ${u.host}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${key}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    const timer = setTimeout(() => { socket.destroy(); reject(new Error('CDP WebSocket 握手超时')); }, timeoutMs);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let seq = 0;
    const pending = new Map();

    const onMessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`CDP 错误：${msg.error.message}（code ${msg.error.code}）`));
        else res(msg.result);
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buffer.slice(0, idx).toString('latin1');
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('CDP WebSocket 升级失败：' + head.split('\r\n')[0]));
          return;
        }
        upgraded = true;
        buffer = buffer.slice(idx + 4);
        clearTimeout(timer);
        resolve({
          evaluate: (expression, opts) => {
            const id = ++seq;
            const params = Object.assign({ expression, returnByValue: true, awaitPromise: true }, opts || {});
            const payload = JSON.stringify({ id, method: 'Runtime.evaluate', params });
            socket.write(encodeFrame(payload));
            return new Promise((res, rej) => {
              const to = setTimeout(() => { pending.delete(id); rej(new Error('CDP Runtime.evaluate 超时')); }, 15000);
              pending.set(id, {
                resolve: (r) => { clearTimeout(to); res(r); },
                reject: (e) => { clearTimeout(to); rej(e); }
              });
            });
          },
          close: () => { try { socket.destroy(); } catch { /* 已断 */ } }
        });
      }
      let frame;
      while ((frame = decodeFrame(buffer)) !== null) {
        buffer = frame.rest;
        if (frame.opcode === 0x1) onMessage(frame.payload.toString('utf8'));
        else if (frame.opcode === 0x8) { socket.destroy(); return; }
        else if (frame.opcode === 0x9) { socket.write(Buffer.from([0x8a, 0x00])); } // ping → 空 pong
      }
    });

    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * 在"URL 命中 match 的页面"里求值。
 * @param {number} port
 * @param {{urlIncludes: string, expression: string, timeoutMs?: number}} opts
 * @returns {Promise<any>} Runtime.evaluate 的 result.value
 */
async function evaluateOnPage(port, opts) {
  const o = opts || {};
  const targets = await listTargets(port);
  const pages = targets.filter((t) => t.type === 'page' && String(t.url || '').indexOf(o.urlIncludes) >= 0);
  if (!pages.length) {
    throw new Error(`CDP：没有 URL 包含 ${JSON.stringify(o.urlIncludes)} 的页面；当前页面=${JSON.stringify(targets.filter((t) => t.type === 'page').map((t) => t.url))}`);
  }
  const conn = await connect(pages[0].webSocketDebuggerUrl, o.timeoutMs);
  try {
    const r = await conn.evaluate(o.expression);
    if (r && r.exceptionDetails) {
      throw new Error('CDP 求值抛出异常：' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r && r.result ? r.result.value : undefined;
  } finally {
    conn.close();
  }
}

module.exports = { listTargets, connect, evaluateOnPage, encodeFrame, decodeFrame };
