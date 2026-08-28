/**
 * @file lib/util.js
 * @description 通用工具模块：日志包装、指数退避重连调度器、文本按平台分块、makeUserMessage 构造器、
 *              fetchJson 助手以及基于 node:http 的极简 RFC6455 WebSocket 服务器实现。
 */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * 探查推导 DSH Home 根目录
 * @returns {string} DSH Home 绝对路径
 */
export function getDshHomeDir() {
  let baseDir = null;
  try {
    const currentFileDir = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const try1 = resolve(currentFileDir, '../../../');
    if (existsSync(join(try1, 'settings.yaml')) || existsSync(join(try1, 'sessions'))) {
      baseDir = try1;
    }
  } catch {}

  if (!baseDir) {
    try {
      const try2 = resolve(process.cwd(), '../../../');
      if (existsSync(join(try2, 'settings.yaml')) || existsSync(join(try2, 'sessions'))) {
        baseDir = try2;
      }
    } catch {}
  }

  if (!baseDir) {
    try {
      const currentFileDir = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      baseDir = resolve(currentFileDir, '../runtime-data');
    } catch {
      baseDir = resolve('./runtime-data');
    }
  }

  return baseDir;
}

/**
 * 解析 bot-gateway 相关文件/目录的存储路径
 * @param {string} [customPath] - 用户指定的路径
 * @param {string} defaultSubPath - 默认子路径或文件名 (如 'settings.json' 或 'napcat')
 * @returns {string} 解析后的绝对路径
 */
export function resolveBotGatewayPath(customPath, defaultSubPath) {
  if (customPath) return resolve(customPath);
  const dshHome = getDshHomeDir();
  if (dshHome.endsWith('runtime-data')) {
    return join(dshHome, defaultSubPath);
  }
  return join(dshHome, 'bot-gateway', defaultSubPath);
}

/**
 * 创建统一格式的日志包装器
 * @param {string} moduleName - 模块名称
 * @returns {object} log 实例 { debug, info, warn, error }
 */
export function createLogger(moduleName) {
  const prefix = `[bot-gateway:${moduleName}]`;
  return {
    debug: (...args) => console.log(prefix, '[DEBUG]', ...args),
    info: (...args) => console.log(prefix, '[INFO]', ...args),
    warn: (...args) => console.log(prefix, '[WARN]', ...args),
    error: (...args) => console.error(prefix, '[ERROR]', ...args),
  };
}

/**
 * 指数退避重连调度器
 * @param {object} options
 * @param {number} [options.minDelay=1000] - 初始重连延迟 (ms)
 * @param {number} [options.maxDelay=60000] - 最大重连延迟 (ms)
 * @param {number} [options.factor=2] - 递增因子
 * @param {function} options.onRetry - 触发重连时的回调
 * @returns {object} { schedule, reset, stop }
 */
export function createBackoffScheduler({ minDelay = 1000, maxDelay = 60000, factor = 2, onRetry }) {
  let currentDelay = minDelay;
  let timer = null;
  let stopped = false;

  return {
    schedule() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      const delay = currentDelay;
      timer = setTimeout(() => {
        timer = null;
        if (!stopped && typeof onRetry === 'function') {
          try {
            onRetry();
          } catch (e) {
            console.error('[bot-gateway:backoff] onRetry callback error:', e);
          }
        }
      }, delay);
      currentDelay = Math.min(maxDelay, Math.floor(currentDelay * factor));
    },
    reset() {
      currentDelay = minDelay;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

/**
 * 文本按平台分块（优先按换行/空格断开，保证单块字符数不超过 maxChars）
 * @param {string} text - 待切块的完整文本
 * @param {number} [maxChars=1800] - 每块最大字符数
 * @returns {string[]} 切分后的文本数组
 */
export function splitText(text, maxChars = 1800) {
  if (typeof text !== 'string') text = String(text ?? '');
  if (!text) return [''];
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    let sliceIndex = maxChars;
    // 优先在 maxChars 范围内的最后一个双换行或单换行处截断
    const lastDoubleNewline = remaining.lastIndexOf('\n\n', maxChars);
    if (lastDoubleNewline > maxChars * 0.3) {
      sliceIndex = lastDoubleNewline + 2;
    } else {
      const lastNewline = remaining.lastIndexOf('\n', maxChars);
      if (lastNewline > maxChars * 0.3) {
        sliceIndex = lastNewline + 1;
      } else {
        const lastSpace = remaining.lastIndexOf(' ', maxChars);
        if (lastSpace > maxChars * 0.3) {
          sliceIndex = lastSpace + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, sliceIndex));
    remaining = remaining.slice(sliceIndex);
  }

  return chunks;
}

/**
 * 构造与 DSH 真实运行形状一致的 UserMessage
 * @param {string} text - 用户输入的文本
 * @returns {object} DSH UserMessage 对象
 */
export function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [
      {
        type: 'text',
        text: typeof text === 'string' ? text : String(text ?? ''),
      }
    ],
    source: { kind: 'user' }
  };
}

/**
 * 归一化的 fetch 助手函数（带有超时、重试和统一错误捕获）
 * @param {string} url - 请求 URL
 * @param {object} [options={}] - 请求参数
 * @param {number} [options.timeout=10000] - 超时毫秒数
 * @param {number} [options.retries=1] - 重试次数
 * @returns {Promise<any>} 解析后的 JSON 结果
 */
export function fetchJson(url, options = {}) {
  const { timeout = 10000, retries = 1, ...fetchOpts } = options;

  async function attempt(retryLeft) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        ...fetchOpts,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }

      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (retryLeft > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return attempt(retryLeft - 1);
      }
      throw e;
    }
  }

  return attempt(retries);
}

/**
 * RFC6455 WebSocket 极简服务器实现（仅使用 node:http 与 node:crypto）
 * 支持握手、解 Mask 校验、Ping/Pong、Close、分片重组、发送文本/二进制帧
 * 
 * @param {object} options
 * @param {number} options.port - 监听端口
 * @param {string} [options.host='127.0.0.1'] - 监听 host
 * @param {function} [options.onConnection] - 连接建立回调 (conn) => void
 * @param {function} [options.onMessage] - 收到完整消息回调 (conn, messageData, isBinary) => void
 * @param {function} [options.onClose] - 连接关闭回调 (conn, code, reason) => void
 * @param {function} [options.onError] - 异常回调 (err) => void
 * @returns {object} { close: () => Promise<void>, server }
 */
export function createWsServer({ port, host = '127.0.0.1', onConnection, onMessage, onClose, onError }) {
  const log = createLogger('ws-server');
  const server = createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade Required');
  });

  const activeConnections = new Set();

  server.on('upgrade', (req, socket, head) => {
    try {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // 计算 WebSocket Accept
      const acceptValue = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue}`,
        '\r\n'
      ];
      socket.write(headers.join('\r\n'));

      // 封装 connection 对象
      const conn = {
        id: randomUUID(),
        req,
        socket,
        send(data) {
          if (socket.destroyed || !socket.writable) return;
          const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
          const opcode = typeof data === 'string' ? 0x1 : 0x2;
          sendFrame(socket, opcode, payload);
        },
        close(code = 1000, reason = '') {
          if (socket.destroyed) return;
          try {
            const reasonBuf = Buffer.from(reason, 'utf8');
            const buf = Buffer.alloc(2 + reasonBuf.length);
            buf.writeUInt16BE(code, 0);
            reasonBuf.copy(buf, 2);
            sendFrame(socket, 0x8, buf);
          } catch {
            // ignore
          } finally {
            socket.destroy();
          }
        }
      };

      activeConnections.add(conn);

      // 分片与解包缓冲
      let buffer = Buffer.alloc(0);
      let fragmentOpcode = 0;
      let fragmentBuffers = [];

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= 2) {
          const byte0 = buffer[0];
          const byte1 = buffer[1];

          const fin = (byte0 & 0x80) !== 0;
          const opcode = byte0 & 0x0f;
          const masked = (byte1 & 0x80) !== 0;
          let payloadLen = byte1 & 0x7f;

          let offset = 2;

          if (payloadLen === 126) {
            if (buffer.length < offset + 2) break;
            payloadLen = buffer.readUInt16BE(offset);
            offset += 2;
          } else if (payloadLen === 127) {
            if (buffer.length < offset + 8) break;
            // 简单处理 8 字节长度（低 32 位）
            const high = buffer.readUInt32BE(offset);
            const low = buffer.readUInt32BE(offset + 4);
            payloadLen = high * 0x100000000 + low;
            offset += 8;
          }

          let maskKey = null;
          if (masked) {
            if (buffer.length < offset + 4) break;
            maskKey = buffer.subarray(offset, offset + 4);
            offset += 4;
          }

          if (buffer.length < offset + payloadLen) {
            // 字节不够，等待后续 chunk
            break;
          }

          const rawPayload = buffer.subarray(offset, offset + payloadLen);
          buffer = buffer.subarray(offset + payloadLen);

          // 解 Mask
          const payload = Buffer.alloc(payloadLen);
          if (masked && maskKey) {
            for (let i = 0; i < payloadLen; i++) {
              payload[i] = rawPayload[i] ^ maskKey[i % 4];
            }
          } else {
            rawPayload.copy(payload);
          }

          // 处理控制帧与数据帧
          if (opcode === 0x8) {
            // Close 帧
            let code = 1000;
            let reason = '';
            if (payload.length >= 2) {
              code = payload.readUInt16BE(0);
              reason = payload.subarray(2).toString('utf8');
            }
            conn.close(code, reason);
            return;
          } else if (opcode === 0x9) {
            // Ping -> Pong
            sendFrame(socket, 0xa, payload);
          } else if (opcode === 0xa) {
            // Pong 忽略
          } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
            // 数据帧或分片
            if (opcode !== 0x0) {
              fragmentOpcode = opcode;
            }
            fragmentBuffers.push(payload);

            if (fin) {
              const fullPayload = Buffer.concat(fragmentBuffers);
              const isBinary = fragmentOpcode === 0x2;
              fragmentBuffers = [];
              fragmentOpcode = 0;

              if (typeof onMessage === 'function') {
                try {
                  const msgData = isBinary ? fullPayload : fullPayload.toString('utf8');
                  onMessage(conn, msgData, isBinary);
                } catch (e) {
                  log.error('onMessage error:', e);
                }
              }
            }
          }
        }
      });

      const cleanup = (code = 1000, reason = 'Connection closed') => {
        if (!activeConnections.has(conn)) return;
        activeConnections.delete(conn);
        if (typeof onClose === 'function') {
          try {
            onClose(conn, code, reason);
          } catch (e) {
            log.error('onClose error:', e);
          }
        }
      };

      socket.on('close', () => cleanup());
      socket.on('error', (err) => {
        if (typeof onError === 'function') onError(err);
        cleanup(1006, err?.message || 'Socket error');
      });

      if (head && head.length > 0) {
        socket.emit('data', head);
      }

      if (typeof onConnection === 'function') {
        try {
          onConnection(conn);
        } catch (e) {
          log.error('onConnection error:', e);
        }
      }

    } catch (err) {
      log.error('Upgrade handle error:', err);
      socket.destroy();
    }
  });

  server.on('error', (err) => {
    if (typeof onError === 'function') onError(err);
  });

  server.listen(port, host);

  return {
    server,
    close() {
      return new Promise((resolve) => {
        for (const conn of activeConnections) {
          conn.close(1001, 'Server shutting down');
        }
        activeConnections.clear();
        server.close(() => resolve());
      });
    }
  };
}

/**
 * 编码并向 socket 发送 RFC6455 帧（服务器发给客户端不需要 Mask）
 * @param {import('node:net').Socket} socket 
 * @param {number} opcode - 0x1 (text), 0x2 (binary), 0x8 (close), 0x9 (ping), 0xa (pong)
 * @param {Buffer} payload 
 */
function sendFrame(socket, opcode, payload) {
  if (!socket.writable) return;

  const len = payload.length;
  let headerLen = 2;
  if (len > 125 && len <= 65535) {
    headerLen = 4;
  } else if (len > 65535) {
    headerLen = 10;
  }

  const buf = Buffer.alloc(headerLen + len);
  buf[0] = 0x80 | (opcode & 0x0f); // FIN=1 + Opcode

  if (len <= 125) {
    buf[1] = len; // Mask=0
  } else if (len <= 65535) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
  } else {
    buf[1] = 127;
    // 写 64 位整型（高 32 位 0，低 32 位 len）
    buf.writeUInt32BE(0, 2);
    buf.writeUInt32BE(len, 6);
  }

  payload.copy(buf, headerLen);
  socket.write(buf);
}
