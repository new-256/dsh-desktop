/**
 * lib/ws.mjs — 零依赖 WebSocket 帧编解码与握手辅助（Node 内置实现）。
 *
 * 协议摘要：
 *   - 数据帧：二进制 [0x01, sid 4 字节 BE, payload...]
 *   - 控制帧：JSON 文本，opcode = 1（text）
 *   - ping/pong：标准 WS ping/pong 帧（opcode 9/10）
 *
 * 多路复用控制帧类型：open / head / end / reset / ping（见 README 与 relay.mjs）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { request } from 'node:http'
import { request as sRequest } from 'node:https'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 生成 base64 随机 Sec-WebSocket-Key */
export function wsKey() {
  return randomBytes(16).toString('base64')
}

/** 计算 Sec-WebSocket-Accept */
export function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** 解析握手请求头中的 key */
export function getHandshakeKey(headers) {
  const raw = headers['sec-websocket-key'] || headers['Sec-WebSocket-Key']
  return typeof raw === 'string' ? raw : ''
}

/** 构造服务端 101 响应字节 */
export function serverHandshakeResponse(key) {
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
    '\r\n'
  )
}

/**
 * 从 socket 读取 HTTP 握手头，返回 { method, url, headers, buffer, head }。
 * 这是一个轻量解析器，只处理 upgrade 请求。
 */
export function parseHandshake(buffer) {
  const end = buffer.indexOf('\r\n\r\n')
  if (end === -1) return null
  const headerBytes = buffer.slice(0, end)
  const head = buffer.slice(end + 4)
  const lines = headerBytes.toString('utf8').split('\r\n')
  const first = lines[0]
  const parts = first.split(' ')
  const method = parts[0]
  const url = parts[1]
  const headers = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const k = line.slice(0, colon).trim().toLowerCase()
    const v = line.slice(colon + 1).trim()
    if (headers[k] !== undefined) {
      if (!Array.isArray(headers[k])) headers[k] = [headers[k]]
      headers[k].push(v)
    } else {
      headers[k] = v
    }
  }
  return { method, url, headers, head }
}

/**
 * 编码一条 WS 帧。
 * @param {number} opcode WS opcode
 * @param {Buffer} payload
 * @param {object} [opts]
 * @param {boolean} [opts.mask=false]
 * @returns {Buffer}
 */
export function encodeWSFrame(opcode, payload, { mask = false } = {}) {
  const len = payload.length
  let headerLen = 2
  if (len >= 65536) headerLen += 8
  else if (len >= 126) headerLen += 2
  if (mask) headerLen += 4
  const frame = Buffer.allocUnsafe(headerLen + len)
  frame[0] = 0x80 | (opcode & 0x0f)
  let off = 2
  if (len >= 65536) {
    frame[1] = (mask ? 0x80 : 0) | 127
    frame.writeBigUInt64BE(BigInt(len), 2)
    off = 10
  } else if (len >= 126) {
    frame[1] = (mask ? 0x80 : 0) | 126
    frame.writeUInt16BE(len, 2)
    off = 4
  } else {
    frame[1] = (mask ? 0x80 : 0) | len
  }
  if (mask) {
    const key = randomBytes(4)
    key.copy(frame, off)
    for (let i = 0; i < len; i++) {
      frame[off + 4 + i] = payload[i] ^ key[i % 4]
    }
  } else {
    payload.copy(frame, off)
  }
  return frame
}

/** 编码文本帧 */
export function encodeText(text) {
  return encodeWSFrame(0x01, Buffer.from(text, 'utf8'))
}

/** 编码二进制帧 */
export function encodeBinary(payload) {
  return encodeWSFrame(0x02, Buffer.isBuffer(payload) ? payload : Buffer.from(payload))
}

/** 编码 ping */
export function encodePing(payload = Buffer.alloc(0)) {
  return encodeWSFrame(0x09, payload)
}

/** 编码 pong */
export function encodePong(payload = Buffer.alloc(0)) {
  return encodeWSFrame(0x0a, payload)
}

/** 编码 close 帧 */
export function encodeClose(code = 1000, reason = '') {
  const rbuf = Buffer.from(reason, 'utf8')
  const payload = Buffer.allocUnsafe(2 + rbuf.length)
  payload.writeUInt16BE(code, 0)
  rbuf.copy(payload, 2)
  return encodeWSFrame(0x08, payload)
}

/**
 * 持续从 buffer 中解析 WS 帧，返回 { frames, rest }。
 * 每个帧：{ fin, opcode, masked, maskKey, payload }。
 */
export function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let len = second & 0x7f
    let headerLen = 2
    if (len === 126) {
      if (offset + 4 > buffer.length) break
      len = buffer.readUInt16BE(offset + 2)
      headerLen = 4
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break
      len = Number(buffer.readBigUInt64BE(offset + 2))
      headerLen = 10
    }
    let maskKey = null
    if (masked) {
      if (offset + headerLen + 4 > buffer.length) break
      maskKey = buffer.slice(offset + headerLen, offset + headerLen + 4)
      headerLen += 4
    }
    if (offset + headerLen + len > buffer.length) break
    let payload = buffer.slice(offset + headerLen, offset + headerLen + len)
    if (masked && maskKey) {
      payload = Buffer.from(payload) // copy
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4]
      }
    }
    frames.push({ fin, opcode, masked, maskKey, payload })
    offset += headerLen + len
  }
  return { frames, rest: buffer.slice(offset) }
}

/** 创建带自动成帧/拆帧的 socket 包装 */
export function wrapSocket(socket, { onText, onBinary, onPing, onPong, onClose, onError }) {
  let buffer = Buffer.alloc(0)
  let closed = false

  function sendText(text) {
    if (closed) return
    socket.write(encodeText(text))
  }

  function sendBinary(payload) {
    if (closed) return
    socket.write(encodeBinary(payload))
  }

  function sendPing(payload = Buffer.alloc(0)) {
    if (closed) return
    socket.write(encodePing(payload))
  }

  function sendClose(code = 1000, reason = '') {
    if (closed) return
    closed = true
    socket.write(encodeClose(code, reason))
  }

  socket.on('data', (chunk) => {
    if (closed) return
    buffer = Buffer.concat([buffer, chunk])
    const { frames, rest } = parseFrames(buffer)
    buffer = rest
    for (const f of frames) {
      if (f.opcode === 0x01) {
        onText?.(f.payload.toString('utf8'))
      } else if (f.opcode === 0x02) {
        onBinary?.(f.payload)
      } else if (f.opcode === 0x08) {
        closed = true
        let code = 1005
        let reason = ''
        if (f.payload.length >= 2) {
          code = f.payload.readUInt16BE(0)
          reason = f.payload.slice(2).toString('utf8')
        }
        onClose?.(code, reason)
      } else if (f.opcode === 0x09) {
        socket.write(encodePong(f.payload))
        onPing?.(f.payload)
      } else if (f.opcode === 0x0a) {
        onPong?.(f.payload)
      }
    }
  })

  socket.on('close', () => {
    closed = true
    onClose?.(1006, '')
  })

  socket.on('error', (err) => {
    onError?.(err)
    closed = true
  })

  return { sendText, sendBinary, sendPing, sendClose, close: sendClose }
}

/**
 * 客户端 WS 握手：outbound TCP + 手写 upgrade 请求。
 * @param {string} url ws:// 或 wss:// URL
 * @param {string} [path] 握手路径（缺省从 url.pathname 取）
 * @param {object} [extraHeaders]
 * @returns {Promise<{socket, sendText, sendBinary, sendPing, sendClose, close}>}
 */
export function clientWSConnect(url, extraHeaders = {}) {
  const u = new URL(url)
  const isSecure = u.protocol === 'wss:'
  const key = wsKey()
  const headers = {
    'Host': u.host,
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13',
    ...extraHeaders,
  }
  const path = u.pathname + u.search

  return new Promise((resolve, reject) => {
    const req = (isSecure ? sRequest : request)({
      hostname: u.hostname,
      port: u.port || (isSecure ? 443 : 80),
      method: 'GET',
      path,
      headers,
      createConnection: (opts) => connect({ host: opts.hostname, port: opts.port }),
    })

    req.on('error', reject)
    req.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept']
      if (accept !== wsAccept(key)) {
        socket.destroy()
        return reject(new Error('Sec-WebSocket-Accept 不匹配'))
      }
      const wrap = wrapSocket(socket, {})
      if (head && head.length) socket.unshift(head)
      resolve({ socket, ...wrap })
    })

    req.on('response', (res) => {
      reject(new Error(`WS 握手收到非 101 响应: ${res.statusCode}`))
    })

    req.end()
  })
}
