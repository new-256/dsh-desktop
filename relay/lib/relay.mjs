/**
 * lib/relay.mjs — dsh-mobile-relay 核心。
 *
 * 职责：
 *   1. 接收宿主 outbound WSS 隧道连接（/tunnel?instance=<id>&key=<key>）。
 *   2. 接收手机侧 HTTP/WS 请求（/i/<instanceId>/<path>），按 instance 路由。
 *   3. 在单条 WSS 上多路复用任意数量逻辑流。
 *
 * 多路复用协议（零依赖、纯 WS）：
 *   - 控制帧：JSON 文本，opcode = text
 *     { t:'open', sid, method, path, headers }   // 中继 → 隧道：新建请求
 *     { t:'head', sid, status, headers }         // 隧道 → 中继：响应头
 *     { t:'end', sid }                           // 隧道 → 中继：响应体结束
 *     { t:'reset', sid, reason }                 // 任意方向：流产/关闭流
 *     { t:'ping' } / { t:'pong' }                // 应用层保活（可选）
 *     { t:'hello', e2e:false }                   // 预留：端到端加密握手（本轮未实现）
 *   - 数据帧：二进制，opcode = binary
 *     首字节 = 0x01，随后 4 字节 sid（大端），剩余为 payload。
 *     不使用 base64，避免膨胀。
 *   - 注意：WS 消息天然有边界，帧头与 payload 放在同一条消息里发送即可。
 *
 * 流控与清理：
 *   - sid 在每个隧道连接内单调递增。
 *   - 客户端断开、隧道断开、流超时（默认 120s 空闲）均触发 reset 并释放。
 *   - 隧道断开时把其所有在途流置错。
 *   - 同一 instance 重连时顶掉旧隧道。
 */

import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { serverHandshakeResponse, wrapSocket, encodeBinary } from './ws.mjs'

const TUNNEL_PATH = '/tunnel'
const INSTANCE_PATH = '/i/'
const IDLE_TIMEOUT_MS = 120_000

/** 创建中继服务器 */
export async function createRelay({ port = 8443, host = '0.0.0.0', key, log = console, tlsCert, tlsKey } = {}) {
  if (!key) {
    log.warn('未设置 --key，所有隧道连接将被拒绝。建议立即设置强密钥。')
  }

  const tunnels = new Map() // instanceId -> Tunnel
  let closed = false
  let server
  let byteStats = { in: 0, out: 0 }

  const requestHandler = (req, res) => {
    if (closed) {
      res.writeHead(503)
      res.end('relay closed')
      return
    }

    // 状态页
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(buildStatusPage(tunnels, byteStats))
      return
    }

    const instance = parseInstancePath(req.url)
    if (!instance) {
      res.writeHead(404)
      res.end('not found')
      return
    }

    const tunnel = tunnels.get(instance.id)
    if (!tunnel) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
      res.end(buildOfflinePage(instance.id))
      return
    }

    handleClientHttp(tunnel, req, res, instance.path, log)
  }

  const upgradeHandler = (req, socket, head) => {
    if (closed) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      return
    }

    const parsedUrl = new URL(req.url, 'http://x')
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }

    // 隧道接入端点
    if (parsedUrl.pathname === TUNNEL_PATH) {
      handleTunnelUpgrade({ req, socket, head, parsedUrl, tunnels, key, log, byteStats })
      return
    }

    // 手机侧 WS 入口
    const instance = parseInstancePath(req.url)
    if (!instance) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }

    const tunnel = tunnels.get(instance.id)
    if (!tunnel) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }

    log.info?.(`[relay] 客户端 WS 升级: ${instance.id}${instance.path}`)
    handleClientWS(tunnel, socket, head, instance.path, req.headers, log)
  }

  const tlsOptions = tlsCert && tlsKey ? {
    cert: await readFile(tlsCert),
    key: await readFile(tlsKey),
  } : undefined

  server = tlsOptions ? createSecureServer(tlsOptions, requestHandler) : createServer(requestHandler)
  server.on('upgrade', upgradeHandler)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const actualPort = server.address().port

  return {
    port: actualPort,
    url: `${tlsOptions ? 'https' : 'http'}://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    close() {
      if (closed) return Promise.resolve()
      closed = true
      for (const t of tunnels.values()) t.destroy('relay closing')
      tunnels.clear()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** 解析 /i/<instanceId>/<rest> */
function parseInstancePath(url) {
  const path = new URL(url, 'http://x').pathname
  if (!path.startsWith(INSTANCE_PATH)) return null
  const rest = path.slice(INSTANCE_PATH.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return { id: rest, path: '/' }
  return { id: rest.slice(0, slash), path: rest.slice(slash) }
}

/** 处理宿主隧道接入 */
function handleTunnelUpgrade({ req, socket, head, parsedUrl, tunnels, key, log, byteStats }) {
  const params = parsedUrl.searchParams
  const instanceId = params.get('instance')
  const providedKey = params.get('key')

  if (!instanceId) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  if (!key || providedKey !== key) {
    log.warn?.(`隧道鉴权失败 instance=${instanceId}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }

  // 顶掉旧隧道
  const old = tunnels.get(instanceId)
  if (old) old.destroy('new tunnel connected')

  const wsKey = req.headers['sec-websocket-key'] || ''
  socket.write(serverHandshakeResponse(wsKey))

  const tunnel = {
    instanceId,
    connectedAt: Date.now(),
    streams: new Map(),
    nextSid: 1,
    bytesIn: 0,
    bytesOut: 0,
    alive: true,
    _timer: null,
    _pingTimer: null,
  }
  tunnels.set(instanceId, tunnel)

  const wrap = wrapSocket(socket, {
    onText(text) {
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        log.warn?.(`收到非法 JSON 控制帧: ${text.slice(0, 80)}`)
        return
      }
      handleTunnelControl(tunnel, msg, log, byteStats)
    },
    onBinary(payload) {
      handleTunnelBinary(tunnel, payload, log, byteStats)
    },
    onClose(code, reason) {
      destroyTunnel(tunnel, tunnels, `tunnel closed ${code} ${reason}`)
    },
    onError(err) {
      log.warn?.(`隧道 socket 错误: ${err.message}`)
      destroyTunnel(tunnel, tunnels, err.message)
    },
  })

  tunnel.sendControl = (obj) => {
    if (!tunnel.alive) return
    try {
      wrap.sendText(JSON.stringify(obj))
      byteStats.out += 1
    } catch {}
  }
  tunnel.sendData = (sid, buf) => {
    if (!tunnel.alive) return
    const frame = Buffer.allocUnsafe(1 + 4 + buf.length)
    frame[0] = 0x01
    frame.writeUInt32BE(sid, 1)
    buf.copy(frame, 5)
    try {
      wrap.sendBinary(frame)
      tunnel.bytesOut += frame.length
      byteStats.out += frame.length
    } catch {}
  }
  tunnel.destroy = (reason) => {
    if (!tunnel.alive) return
    tunnel.alive = false
    clearTimeout(tunnel._timer)
    clearInterval(tunnel._pingTimer)
    for (const [sid, s] of tunnel.streams) {
      resetStream(tunnel, sid, reason || 'tunnel destroyed')
    }
    tunnels.delete(instanceId)
    try { wrap.close(1001, reason || 'closing') } catch {}
    try { socket.destroy() } catch {}
  }
  tunnel._pingTimer = setInterval(() => {
    if (!tunnel.alive) return
    try { wrap.sendPing(Buffer.from('')) } catch {}
  }, 30_000)

  // 预留 hello 帧：通知 E2E 未启用
  tunnel.sendControl({ t: 'hello', e2e: false })

  log.info?.(`隧道上线: ${instanceId}`)
}

/** 处理隧道发来的控制帧 */
function handleTunnelControl(tunnel, msg, log, byteStats) {
  if (!msg || typeof msg !== 'object' || !msg.t) return
  const sid = msg.sid
  const stream = tunnel.streams.get(sid)

  switch (msg.t) {
    case 'head': {
      if (!stream || stream.phase !== 'open') return
      stream.phase = 'body'
      clearTimeout(stream.timer)
      stream.timer = setTimeout(() => resetStream(tunnel, sid, 'idle timeout'), IDLE_TIMEOUT_MS)
      if (stream.type === 'http') {
        stream.res.writeHead(msg.status || 200, flattenHeaders(msg.headers))
      } else if (stream.type === 'ws') {
        // 把 101 响应头写成原始字节发给客户端
        const lines = [`HTTP/1.1 ${msg.status || 101} Switching Protocols\r\n`]
        const h = msg.headers || {}
        for (const [k, v] of Object.entries(h)) {
          if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}\r\n`)
          else lines.push(`${k}: ${v}\r\n`)
        }
        lines.push('\r\n')
        stream.socket.write(Buffer.from(lines.join(''), 'latin1'))
        stream.wsHandshaked = true
        for (const chunk of stream.pending) tunnel.sendData(sid, chunk)
        stream.pending = []
      }
      break
    }
    case 'end': {
      if (!stream) return
      clearTimeout(stream.timer)
      if (stream.type === 'http') {
        if (!stream.res.writableEnded) stream.res.end()
      }
      tunnel.streams.delete(sid)
      break
    }
    case 'reset': {
      if (stream) resetStream(tunnel, sid, msg.reason || 'remote reset')
      break
    }
    case 'pong':
      break
    default:
      log.warn?.(`未知控制帧类型: ${msg.t}`)
  }
}

/** 处理隧道发来的二进制数据帧 */
function handleTunnelBinary(tunnel, payload, log, byteStats) {
  if (payload.length < 5) return
  const sid = payload.readUInt32BE(1)
  const data = payload.slice(5)
  tunnel.bytesIn += payload.length
  byteStats.in += payload.length
  const stream = tunnel.streams.get(sid)
  if (!stream) return

  clearTimeout(stream.timer)
  stream.timer = setTimeout(() => resetStream(tunnel, sid, 'idle timeout'), IDLE_TIMEOUT_MS)

  if (stream.type === 'http') {
    if (!stream.res.writableEnded) stream.res.write(data)
  } else if (stream.type === 'ws') {
    if (stream.wsHandshaked) {
      try { stream.socket.write(data) } catch (e) { resetStream(tunnel, sid, e.message) }
    }
  }
}

/** 处理普通 HTTP 客户端请求 */
function handleClientHttp(tunnel, req, res, path, log) {
  const sid = allocSid(tunnel)
  const stream = {
    sid,
    type: 'http',
    phase: 'open',
    res,
    timer: setTimeout(() => resetStream(tunnel, sid, 'idle timeout'), IDLE_TIMEOUT_MS),
  }
  tunnel.streams.set(sid, stream)

  res.on('close', () => resetStream(tunnel, sid, 'client closed'))

  tunnel.sendControl({
    t: 'open',
    sid,
    method: req.method,
    path: path + (req.url.includes('?') ? '?' + new URL(req.url, 'http://x').searchParams.toString() : ''),
    headers: req.headers,
  })

  req.on('data', (chunk) => tunnel.sendData(sid, chunk))
  req.on('end', () => {
    // 通知隧道请求体已结束，目标 http.request 可 end
    tunnel.sendControl({ t: 'reqend', sid })
  })
  req.on('error', (err) => resetStream(tunnel, sid, err.message))
}

/** 处理客户端 WS 升级请求 */
function handleClientWS(tunnel, socket, head, path, headers, log) {
  const sid = allocSid(tunnel)
  const stream = {
    sid,
    type: 'ws',
    phase: 'open',
    socket,
    wsHandshaked: false,
    pending: [],
    timer: setTimeout(() => resetStream(tunnel, sid, 'idle timeout'), IDLE_TIMEOUT_MS),
  }
  tunnel.streams.set(sid, stream)

  socket.on('close', () => resetStream(tunnel, sid, 'client ws closed'))
  socket.on('error', (err) => resetStream(tunnel, sid, err.message))
  socket.on('data', (chunk) => {
    if (!stream.wsHandshaked) {
      stream.pending.push(chunk)
      return
    }
    clearTimeout(stream.timer)
    stream.timer = setTimeout(() => resetStream(tunnel, sid, 'idle timeout'), IDLE_TIMEOUT_MS)
    tunnel.sendData(sid, chunk)
  })

  tunnel.sendControl({
    t: 'open',
    sid,
    method: 'GET',
    path,
    headers,
  })
}

function allocSid(tunnel) {
  return tunnel.nextSid++
}

function resetStream(tunnel, sid, reason) {
  const stream = tunnel.streams.get(sid)
  if (!stream) return
  clearTimeout(stream.timer)
  tunnel.sendControl({ t: 'reset', sid, reason: reason || 'closed' })
  if (stream.type === 'http' && !stream.res.writableEnded) {
    try { stream.res.end() } catch {}
  }
  if (stream.type === 'ws' && !stream.socket.destroyed) {
    try { stream.socket.destroy() } catch {}
  }
  tunnel.streams.delete(sid)
}

function destroyTunnel(tunnel, tunnels, reason) {
  if (!tunnel.alive) return
  tunnel.destroy(reason)
}

/** 把 headers 对象拍平成适合 writeHead 的数组/字符串 */
function flattenHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

/** 502 中文页面 */
function buildOfflinePage(instanceId) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>宿主未连接 — DSH Mobile Relay</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f8; color: #333; margin: 0; padding: 40px 20px; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 12px; }
    p { margin: 8px 0; line-height: 1.6; color: #555; }
    code { background: #eee; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <h1>宿主未连接</h1>
  <p>实例 <code>${escapeHtml(instanceId)}</code> 当前没有在线的隧道客户端。</p>
  <p>请确认宿主机上的 DSH 插件已启用中继隧道，且 instanceId 与密钥一致。</p>
</body>
</html>`
}

/** 状态页 */
function buildStatusPage(tunnels, byteStats) {
  const rows = []
  for (const t of tunnels.values()) {
    const dur = Math.floor((Date.now() - t.connectedAt) / 1000)
    rows.push(`<tr><td>${escapeHtml(t.instanceId)}</td><td>${dur}s</td><td>${t.streams.size}</td><td>${t.bytesIn}</td><td>${t.bytesOut}</td></tr>`)
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DSH Mobile Relay 状态</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f8; color: #333; margin: 0; padding: 24px; }
    h1 { font-size: 22px; margin-bottom: 16px; }
    table { border-collapse: collapse; width: 100%; max-width: 720px; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #eee; }
    th { background: #fafafa; font-weight: 600; }
    .empty { color: #888; padding: 24px; }
  </style>
</head>
<body>
  <h1>DSH Mobile Relay 状态</h1>
  <p>在线实例数：<strong>${tunnels.size}</strong> &nbsp;|&nbsp; 总入站 ${byteStats.in} 字节 &nbsp;|&nbsp; 总出站 ${byteStats.out} 字节</p>
  ${tunnels.size === 0 ? '<p class="empty">暂无在线实例。</p>' : `
  <table>
    <thead><tr><th>实例 ID</th><th>连接时长</th><th>活跃流</th><th>入站字节</th><th>出站字节</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`}
</body>
</html>`
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
