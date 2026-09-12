/**
 * agentrouter 反向代理 —— DSH 宿主插件。
 *
 * 【开发纪律（DEV-DISCIPLINE，必读）】本文件是部署副本，源码正本在 Desktop\DSH 仓
 * plugins\web\agentrouter-proxy.plugin.mjs。每次改动：同步双份 → bump cordis.patch.yml 的
 * ?v=N 缓存参数 → 重启 DSH Desktop 验证 → 提交仓库。详见 dsh-home\plugins\DEV-DISCIPLINE.md。
 * （2026-09-12 纪律审计发现部署副本曾长期领先正本，已回同步归位。）
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
import tls from 'node:tls'

export const name = 'agentrouter-proxy'

/** 逐跳头部（RFC 9110 §7.6.1）不能转发给上游。 */
const HOP_BY_HOP = ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']

const DEFAULTS = {
  port: 8787,
  upstream: 'https://agentrouter.org',
  userAgent: 'claude-cli/1.0.60 (external, cli)',
  proxy: '',
  resolve: {}, // DNS 覆盖表：{ 域名: ['ip1','ip2'] }，绕过 fake-ip / 污染解析
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
  let proxy = null
  if (merged.proxy) {
    try {
      proxy = new URL(merged.proxy)
    } catch {
      throw new Error(`agentrouter-proxy: proxy 不是合法 URL：${JSON.stringify(merged.proxy)}`)
    }
    if (!['http:', 'https:'].includes(proxy.protocol)) {
      throw new Error(`agentrouter-proxy: proxy 只支持 http/https，收到 ${proxy.protocol}`)
    }
  }
  const resolve = {}
  if (merged.resolve && typeof merged.resolve === 'object') {
    for (const [host, ips] of Object.entries(merged.resolve)) {
      const list = Array.isArray(ips) ? ips : [ips]
      const validated = []
      for (const ip of list) {
        if (typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) validated.push(ip)
      }
      if (validated.length) resolve[host] = validated
    }
  }
  return { port, upstream, userAgent: merged.userAgent, proxy, resolve, verbose: Boolean(merged.verbose) }
}

/**
 * 构造连接上游的 Agent。
 *
 * 两条路径：
 * 1. 直连（无 proxy）：Node 走系统 DNS。若本机有 Clash TUN + fake-ip（域名被解析到
 *    198.18.0.0/15 假 IP），Node 直连必然失败 —— 用 `resolve` 表把域名覆盖为真实 IP
 *    （如阿里云国内直连域名 ps.air-outer.com → 8.214.160.125），再配 `lookup` 返回。
 * 2. 代理隧道（有 proxy）：经 HTTP 代理 CONNECT 隧道连上游，代理侧做 DNS + 出口。
 * 保持 keep-alive：请求密集时避免每次重新握手/建隧道。
 */
function createUpstreamAgent(proxy, resolve = {}) {
  // 构造 lookup：命中 resolve 表的域名返回真实 IP（轮询），否则走系统解析
  const makeLookup = (hostname, options, callback) => {
    const ips = resolve[hostname]
    if (ips && ips.length) {
      callback(null, ips.map((address) => ({ address, family: 4 })))
      return
    }
    // 默认走 dns.lookup（保持 Node 默认行为）
    import('node:dns').then((dns) => dns.default.lookup(hostname, options, callback)).catch((error) => callback(error))
  }

  if (!proxy) {
    const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 64, timeout: 30000 })
    agent.lookup = makeLookup
    return agent
  }
  const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 64, timeout: 30000 })
  const proxyHost = proxy.hostname
  const proxyPort = Number(proxy.port || 80)
  const proxyTls = proxy.protocol === 'https:'
  agent.createConnection = (options, callback) => {
    // 关键：CONNECT 成功时 Node 触发的是 'connect' 事件而不是 'response' 回调！
    // 之前误用了 response 回调，导致 callback 从不执行、隧道从不建立、请求永远挂起。
    let done = false
    const onDone = (error, socket) => {
      if (done) return
      done = true
      callback(error, socket)
    }
    const connectOptions = {
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${options.host}:${options.port}`,
      timeout: 10000,
    }
    const requestLayer = proxyTls ? https : http
    const proxyReq = requestLayer.request(connectOptions)
    proxyReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        const error = new Error(`代理 CONNECT 失败 ${res.statusCode}`)
        error.code = 'PROXY_CONNECT_FAILED'
        onDone(error)
        return
      }
      const tlsSocket = tls.connect(
        {
          socket,
          servername: options.servername || options.host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        },
        () => onDone(null, tlsSocket),
      )
      tlsSocket.on('error', onDone)
    })
    // 代理返回非 2xx（407/403 等）时走 response 事件
    proxyReq.on('response', (res) => {
      const error = new Error(`代理 CONNECT 失败 ${res.statusCode}`)
      error.code = 'PROXY_CONNECT_FAILED'
      onDone(error)
      res.resume()
    })
    proxyReq.on('error', onDone)
    proxyReq.end()
  }
  return agent
}

export function apply(ctx, config) {
  const { port, upstream, userAgent, proxy, resolve, verbose } = resolveConfig(config)

  // agent loop 请求密集，复用 TLS 连接避免每次重新握手；空闲 socket 30s 主动断开，
  // 减少被上游 WAF 静默断开后复用产生 RST 的几率（配合下方失败重试根治）。
  const agent = createUpstreamAgent(proxy, resolve)
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

    // 客户端提前断开（用户打断回答）时中止上游。关键：Node≥18 下 close 在响应
    // 正常完成后同样触发（keep-alive 复用 / socket 回收），若无差别 destroy() 会把
    // 已完成的请求判为中止并产出「upstream: ""」空 502。所以只在响应流确实未写完时中止。
    const abortUpstream = () => {
      if (res.writableEnded || res.finished) return
      if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy()
    }
    res.on('close', abortUpstream)
    res.on('error', () => {})          // 响应流写入错误静默，交由上游 error 兜底
    req.on('aborted', abortUpstream)

    // 先缓冲请求体再发上游：agent 请求体很小（SSE 常无 body），缓冲代价可忽略，
    // 换取 stale 连接失败时能用完整 body 重试一次。
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('error', () => {})          // 客户端上传中断静默
    req.on('end', () => dispatch(Buffer.concat(chunks), 1))

    /** 拼接出永远非空的错误描述。
     *  背景：Node 在某些 destroy/连接复用失败路径上抛出 code 有值但 message 为空的 Error，
     *  直接取 error.message 会得到 `upstream: `（用户看到的空 502）。这里逐级兜底。 */
    function describeError(error) {
      const message = typeof error?.message === 'string' ? error.message.trim() : ''
      const code = error?.code ? `${error.code}` : ''
      if (message && code) return `${message} (${code})`
      if (message) return message
      if (code) return code
      return String(error)
    }

    /** 是否可安全重试：连接级重置错误且尚未向客户端发出响应头。
     *  TLS 握手阶段失败（首次连接或复用连接）都是安全的：此时请求体尚未发送到
     *  对端，重试不会产生重复请求。已发出请求体后的失败不重试（POST 有重复执行风险）。 */
    function retryable(error) {
      if (res.headersSent) return false
      const text = describeError(error)
      return /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|socket hang up|PROXY_CONNECT_FAILED/i.test(text)
    }

    let upstreamReq = null

    function dispatch(body, attempt) {
      upstreamReq = https.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || 443,
          method: req.method,
          // 上游可能挂在子路径下；去掉尾斜杠避免拼出双斜杠。
          path: upstream.pathname.replace(/\/+$/, '') + req.url,
          headers,
          // 始终走自定义 agent：直连（无 proxy）或代理隧道（有 proxy）。
          // 注意重试时不能用 agent:false —— 那会让 Node 绕过 createConnection
          // 直连上游，在 TUN/fake-ip 环境下必然撞上 198.18.x.x 假 IP 而失败。
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

          // 响应流中途断开（上游生成到一半被 RST）也要兜底，否则 SSE 会静默断流、
          // 或 error 无监听导致进程崩溃。
          upstreamRes.on('error', (e) => {
            const msg = describeError(e)
            ctx.logger.warn(`[${id}] 上游响应流中断 ${req.method} ${req.url}: ${msg}`)
            if (res.headersSent) res.destroy()
            else {
              res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: { type: 'proxy_error', message: `upstream: ${msg}` } }))
            }
          })

          const out = { ...upstreamRes.headers }
          for (const h of HOP_BY_HOP) delete out[h]
          res.writeHead(upstreamRes.statusCode ?? 502, out)
          // 直接管道透传，不缓冲 —— SSE 必须逐块下发，否则 agent loop 会卡到超时。
          upstreamRes.pipe(res)
        },
      )

      upstreamReq.on('error', (error) => {
        const msg = describeError(error)
        if (attempt < 2 && retryable(error)) {
          ctx.logger.warn(`[${id}] 连接被重置，重试一次 (${msg})`)
          dispatch(body, attempt + 1)
          return
        }
        ctx.logger.warn(`[${id}] upstream 失败 ${req.method} ${req.url}: ${msg}`)
        if (res.headersSent) res.destroy()
        else {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { type: 'proxy_error', message: `upstream: ${msg}` } }))
        }
      })

      upstreamReq.end(body)
    }
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
      const resolveDesc = Object.keys(resolve).length
        ? `，DNS 覆盖 ${Object.keys(resolve).join(',')}`
        : ''
      ctx.logger.info(
        `反代已就绪 http://127.0.0.1:${port} -> ${upstream.origin}（UA 改写为 ${userAgent}` +
          (proxy ? `，经代理 ${proxy.origin}` : '，直连') +
          resolveDesc +
          '）',
      )
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
