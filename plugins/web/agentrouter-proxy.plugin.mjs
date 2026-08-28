/**
 * agentrouter 反向代理 —— DSH 宿主插件。
 *
 * 为什么需要它：DSH 在 `@deepseek-ai/dsh-llm/types/attribution.js` 里把 User-Agent 硬编码为
 * `deepseek-harness/<ver> (+https://github.com/deepseek-ai/deepseek-harness)`，而
 * `llm-pi-ai` 的 `requestHeaders()` 会主动剥离 provider 配置里自定义的 `user-agent`
 * 再强制覆盖（源码注释：nothing can suppress attribution entirely）。agentrouter.org 用
 * UA 白名单做客户端准入，非白名单客户端一律 401 `unauthorized_client_error`。
 * 因此改写只能发生在 DSH 进程的 HTTP 边界之外 —— 也就是这个本地反代。
 *
 * 为什么放在宿主组合（host composition）而不是 agent preset：它是一个跨会话共享的网络
 * 监听器，生命周期应与进程一致；每个会话起一份会造成 EADDRINUSE。它不发布任何 Cordis
 * 服务，所以不需要 isolate realm。
 *
 * 只绑 127.0.0.1：本代理会给经过它的任何请求附上白名单客户端标识，不可暴露到局域网。
 *
 * @module agentrouter-proxy
 */

import http from 'node:http'
import https from 'node:https'

export const name = 'agentrouter-proxy'

/** 逐跳头部（RFC 9110 §7.6.1）不能转发给上游。 */
const HOP_BY_HOP = ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']

const DEFAULTS = {
  port: 8787,
  upstream: 'https://agentrouter.org',
  userAgent: 'claude-cli/1.0.60 (external, cli)',
  verbose: false,
}

/**
 * 解析并校验行配置，非法值直接抛错让 mount 失败 —— 静默回退到默认端口会让
 * provider 指向一个没人监听的地址，报错反而更难查。
 */
function resolveConfig(config = {}) {
  const merged = { ...DEFAULTS, ...config }
  const port = Number(merged.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`agentrouter-proxy: port 必须是 1-65535 的整数，收到 ${JSON.stringify(merged.port)}`)
  }
  let upstream
  try {
    upstream = new URL(merged.upstream)
  } catch {
    throw new Error(`agentrouter-proxy: upstream 不是合法 URL：${JSON.stringify(merged.upstream)}`)
  }
  if (upstream.protocol !== 'https:') {
    throw new Error(`agentrouter-proxy: upstream 必须是 https，收到 ${upstream.protocol}`)
  }
  if (typeof merged.userAgent !== 'string' || merged.userAgent.length === 0) {
    throw new Error('agentrouter-proxy: userAgent 不能为空')
  }
  return { port, upstream, userAgent: merged.userAgent, verbose: Boolean(merged.verbose) }
}

export function apply(ctx, config) {
  const { port, upstream, userAgent, verbose } = resolveConfig(config)

  // agent loop 请求密集，复用 TLS 连接避免每次重新握手。
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64 })
  const sockets = new Set()
  let seq = 0

  const server = http.createServer((req, res) => {
    const id = ++seq

    const headers = { ...req.headers }
    for (const h of HOP_BY_HOP) delete headers[h]

    // 关键改写。HTTP 头名大小写不敏感，先逐个删净再写入，
    // 否则可能出现两个 user-agent 头，上游取到哪个不确定。
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'user-agent') delete headers[key]
    }
    headers['user-agent'] = userAgent
    // host 必须换成上游主机，否则 One-API 侧路由与证书校验失败。
    headers.host = upstream.host

    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'anthropic-version')) {
      headers['anthropic-version'] = '2023-06-01'
    }

    const upstreamReq = https.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 443,
        method: req.method,
        // 上游可能挂在子路径下；去掉尾斜杠避免拼出双斜杠。
        path: upstream.pathname.replace(/\/+$/, '') + req.url,
        headers,
        agent,
      },
      (upstreamRes) => {
        if (verbose) {
          ctx.logger.info(`[${id}] ${upstreamRes.statusCode} ${req.method} ${req.url}`)
        } else if ((upstreamRes.statusCode ?? 0) >= 400) {
          // 默认只记错误：401 说明 UA 白名单又变了，402 说明上游额度耗尽，
          // 这两个是最需要能一眼看到的失败。
          ctx.logger.warn(`[${id}] ${upstreamRes.statusCode} ${req.method} ${req.url}`)
        }

        const out = { ...upstreamRes.headers }
        for (const h of HOP_BY_HOP) delete out[h]
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        // 直接管道透传，不缓冲 —— SSE 必须逐块下发，否则 agent loop 会卡到超时。
        upstreamRes.pipe(res)
      },
    )

    upstreamReq.on('error', (error) => {
      ctx.logger.warn(`[${id}] upstream 失败 ${req.method} ${req.url}: ${error.message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: `upstream: ${error.message}` } }))
    })

    // 客户端提前断开（用户打断回答）时同步中止上游请求，避免连接泄漏。
    res.on('close', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy()
    })

    req.pipe(upstreamReq)
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  server.on('clientError', (error, socket) => {
    ctx.logger.warn(`client error: ${error.message}`)
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  // listen 失败（最常见是 EADDRINUSE）必须让插件激活失败并报出来，
  // 否则 provider 会指向一个无人监听的端口，表现为一堆难以归因的连接错误。
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      server.on('error', (error) => ctx.logger.error(error))
      ctx.logger.info(`反代已就绪 http://127.0.0.1:${port} -> ${upstream.origin}（UA 改写为 ${userAgent}）`)
      resolve()
    })
  })

  // 注册反向清理：卸载/重载/进程退出时关闭监听并断开在途连接，
  // 保证同一端口可以立即被下一代实例重新绑定。
  ctx.effect(() => async () => {
    const closed = new Promise((resolve) => server.close(() => resolve()))
    for (const socket of sockets) socket.destroy()
    await closed
    agent.destroy()
    ctx.logger.info('反代已关闭')
  }, 'agentrouter-proxy.listen')

  return listening
}
