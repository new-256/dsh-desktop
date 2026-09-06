// web-search — host half（家级 cordis.patch.yml 的 file:// 行加载，?v=N 热加载）。
//
// 注册内容：
//   1. 模型工具 web_search_multi —— 11 引擎搜索，engine 可选 auto（默认，
//      语言感知回退链）/ ddg-api / ddg-html / bing / baidu / so360 / brave /
//      wikipedia / brave-api / tavily / serper / exa（后四个 API-key 型）。
//   2. 模型工具 web_fetch_url —— 经 ctx.web.fetch() 抓取任意 URL（由家级
//      web-fetch-http 行提供的官方 provider 执行，SSRF 防护/字节上限）。
//   3. 11 个搜索引擎 provider 注册进 ctx.web。host 的 web 行仍把
//      searchProvider 钉在 deepseek-official，产品 web_search 不受影响；
//      想在产品工具里换引擎时在家级 patch 覆写 web 行 config.searchProvider。
//   4. settings namespace "web-search"（settings.yaml 持久化、热生效）：
//      总开关 / 各引擎开关 / API key / 默认引擎 / maxResults / timeoutMs / UA。
//      设置页：设置→插件→网页搜索（client 半边的卡片，见 lib/client.js）。
//   5. systemPrompt 引导段 + 诊断路由（/web-search/health、/web-search/test）。
//
// 依赖纪律：本文件位于 dsh-home 下，Node 向上找不到 harness 的包，所以不
// import 任何 @deepseek-ai/*；schemastery / turndown 经 createRequire 从
// 主进程脚本位置（harness 安装内）解析，升级换目录后依然有效。
// 搜索引擎抓取用 host realm 的全局 fetch（与 dsh-web-search-deepseek 同权）。

import { createRequire } from 'node:module'

export const name = 'web-search'
export const inject = ['web', 'tools', 'systemPrompt']

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const SETTINGS_NS = 'web-search'

// ── harness 依赖解析（createRequire 从主脚本位置向上走 node_modules）───────

function harnessRequire(id) {
  for (const base of [process.argv[1], process.argv[0]]) {
    if (typeof base !== 'string' || base.length === 0) continue
    try {
      return createRequire(base)(id)
    } catch {
      // 换下一个候选
    }
  }
  return undefined
}

/** schemastery（settings schema 用），失败则降级为无 schema 注册。 */
const Schema = harnessRequire('@deepseek-ai/schemastery')

/** turndown + gfm（HTML→markdown），失败则降级为粗剥离标签。 */
const turndown = (() => {
  try {
    const TurndownService = harnessRequire('turndown')
    const gfm = harnessRequire('@joplin/turndown-plugin-gfm')?.gfm
    if (typeof TurndownService !== 'function') return undefined
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    if (gfm) td.use(gfm)
    return td
  } catch {
    return undefined
  }
})()

// ── HTML 工具 ────────────────────────────────────────────────────────────────

function decodeEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

function stripTags(str) {
  return decodeEntities(String(str).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** b64 带 padding 解码（Bing 重定向 u=a1<base64>）。 */
function decodeB64UrlParam(param) {
  try {
    let b64 = param
    if (b64.startsWith('a1')) b64 = b64.slice(2)
    const pad = b64.length % 4 === 2 ? '==' : b64.length % 4 === 3 ? '=' : ''
    if (typeof Buffer !== 'undefined') return Buffer.from(b64 + pad, 'base64').toString('utf8')
    if (typeof atob === 'function') {
      const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad)
      // latin1 → utf8
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder('utf-8').decode(bytes)
    }
    return undefined
  } catch {
    return undefined
  }
}

// ── HTTP 抓取（host realm 全局 fetch）───────────────────────────────────────

/**
 * 抓一个 URL 返回文本。signal 与 timeoutMs 组合：任一触发即中止。
 * @returns {Promise<{ok: boolean, statusCode: number, content: string, error?: string}>}
 */
async function httpGet(url, { timeoutMs, userAgent, signal }) {
  const ctrl = new AbortController()
  const t = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined
  const onOuter = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onOuter, { once: true })
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent || DEFAULT_UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    const content = await res.text()
    return { ok: res.status >= 200 && res.status < 300, statusCode: res.status, content }
  } catch (e) {
    const aborted = signal && signal.aborted
    return { ok: false, statusCode: 0, content: '', error: aborted ? 'aborted' : String((e && e.cause && e.cause.message) || (e && e.message) || e) }
  } finally {
    if (t !== undefined) clearTimeout(t)
    if (signal) signal.removeEventListener('abort', onOuter)
  }
}

/**
 * GET 请求带自定义头 + JSON 解析（API 型引擎用），返回 {ok, statusCode, data?, error?}。
 */
async function httpGetJson(url, headers, { timeoutMs, signal }) {
  const ctrl = new AbortController()
  const t = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined
  const onOuter = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onOuter, { once: true })
  }
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' })
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = undefined }
    if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status, data }
    const apiErr = data && (data.detail || data.message || data.error)
    return { ok: false, statusCode: res.status, data, error: apiErr ? `${apiErr} (HTTP ${res.status})` : `HTTP ${res.status}` }
  } catch (e) {
    const aborted = signal && signal.aborted
    return { ok: false, statusCode: 0, error: aborted ? 'aborted' : String((e && e.cause && e.cause.message) || (e && e.message) || e) }
  } finally {
    if (t !== undefined) clearTimeout(t)
    if (signal) signal.removeEventListener('abort', onOuter)
  }
}

/**
 * POST JSON（API 型引擎用），返回 {ok, statusCode, data?, error?}。
 */
async function httpPostJson(url, body, headers, { timeoutMs, signal }) {
  const ctrl = new AbortController()
  const t = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined
  const onOuter = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onOuter, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'follow',
    })
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = undefined }
    if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status, data }
    const apiErr = data && (data.detail || data.message || data.error)
    return { ok: false, statusCode: res.status, data, error: apiErr ? `${apiErr} (HTTP ${res.status})` : `HTTP ${res.status}` }
  } catch (e) {
    const aborted = signal && signal.aborted
    return { ok: false, statusCode: 0, error: aborted ? 'aborted' : String((e && e.cause && e.cause.message) || (e && e.message) || e) }
  } finally {
    if (t !== undefined) clearTimeout(t)
    if (signal) signal.removeEventListener('abort', onOuter)
  }
}

// ── 搜索引擎 ────────────────────────────────────────────────────────────────

/** 每引擎最近一次错误（诊断用）。 */
const lastErrors = Object.create(null)
/** 每引擎累计调用/成功次数（诊断用）。 */
const stats = Object.create(null)

function noteEngine(id, error) {
  if (error) lastErrors[id] = { at: new Date().toISOString(), error: String(error).slice(0, 300) }
  else delete lastErrors[id]
  const s = (stats[id] ??= { calls: 0, ok: 0 })
  s.calls += 1
  if (!error) s.ok += 1
}

function parseDdgApi(data, query) {
  const sources = []
  if (data.AbstractText && data.AbstractURL) {
    sources.push({
      url: data.AbstractURL,
      title: data.Heading || data.AbstractSource || 'DuckDuckGo Answer',
      snippet: data.AbstractText,
    })
  }
  if (data.Answer) {
    sources.push({
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      title: 'DuckDuckGo Answer',
      snippet: String(data.Answer),
    })
  }
  for (const topic of data.RelatedTopics || []) {
    if (topic.Text && topic.FirstURL) {
      sources.push({ url: topic.FirstURL, title: String(topic.Text).split(' - ')[0] || 'Related', snippet: topic.Text })
    }
    for (const sub of topic.Topics || []) {
      if (sub.Text && sub.FirstURL) {
        sources.push({ url: sub.FirstURL, title: String(sub.Text).split(' - ')[0] || 'Related', snippet: sub.Text })
      }
    }
  }
  return { sources, content: data.AbstractText || (data.Answer ? String(data.Answer) : undefined) }
}

function parseDdgHtml(html) {
  const sources = []
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const links = []
  const snips = []
  let m
  while ((m = linkRe.exec(html)) !== null) {
    let href = decodeEntities(m[1])
    const uddg = href.match(/[?&]uddg=([^&]+)/)
    if (uddg) {
      try { href = decodeURIComponent(uddg[1]) } catch { /* 保留原样 */ }
    }
    if (!/^https?:\/\//i.test(href)) continue
    links.push({ url: href, title: stripTags(m[2]) })
  }
  while ((m = snipRe.exec(html)) !== null) snips.push(stripTags(m[1]))
  for (let i = 0; i < links.length; i++) {
    sources.push({ url: links[i].url, title: links[i].title || undefined, snippet: snips[i] || undefined })
  }
  return sources
}

function parseBingHtml(html) {
  const sources = []
  // <h2><a href="...">title</a></h2>；Bing 的 href 多为 /ck/a 重定向，真实 URL
  // 在 u=a1<base64> 参数里；也有少数直链。
  const itemRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/gi
  const capRe = /<p[^>]*>([\s\S]*?)<\/p>/
  let m
  while ((m = itemRe.exec(html)) !== null) {
    let url = decodeEntities(m[1])
    const u = url.match(/[?&]u=a1([A-Za-z0-9_-]+)/)
    if (u) {
      const real = decodeB64UrlParam(u[1])
      if (real && /^https?:\/\//i.test(real)) url = real
    }
    if (!/^https?:\/\//i.test(url)) continue
    const title = stripTags(m[2])
    const capMatch = m[3].match(capRe)
    const snippet = capMatch ? stripTags(capMatch[1]) : undefined
    sources.push({ url, title: title || undefined, snippet: snippet || undefined })
  }
  return sources
}

/**
 * 百度：容器 <div class="result c-container ..." mu="真实URL">，标题在 <h3>，
 * 摘要在 class 含 summary 的元素里。无 mu 的容器（广告/推荐）跳过。
 */
function parseBaiduHtml(html) {
  const sources = []
  const seen = new Set()
  const containers = html.split(/(?=<div class="result c-container)/).filter((s) => s.startsWith('<div class="result c-container'))
  for (const c of containers) {
    const mu = (c.match(/ mu="([^"]+)"/) || [])[1]
    if (!mu || !/^https?:\/\//i.test(mu)) continue
    if (seen.has(mu)) continue
    seen.add(mu)
    const h3 = c.match(/<h3[\s\S]*?<\/h3>/)
    const title = h3 ? stripTags(h3[0]) : ''
    const sum = c.match(/class="[^"]*\bsummary[^"]*"[^>]*>([\s\S]{0,400}?)<\/(?:span|div|p)>/)
    const snippet = sum ? stripTags(sum[1]) : undefined
    if (!title) continue
    sources.push({ url: mu, title, snippet: snippet || undefined })
  }
  return sources
}

/**
 * 360 搜索（so.com）：<li class="res-list" ...>，真实 URL 在 data-mdurl
 * 属性（href 是 so.com/link 重定向），标题 <h3><a>，摘要 best-effort。
 */
function parseSo360Html(html) {
  const sources = []
  const seen = new Set()
  const items = html.split(/(?=<li class="res-list)/).filter((s) => s.startsWith('<li class="res-list'))
  for (const c of items) {
    const url = (c.match(/data-mdurl="([^"]+)"/) || [])[1]
    if (!url || !/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const a = c.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)
    const title = a ? stripTags(a[1]) : ''
    if (!title) continue
    const d = c.match(/class="[^"]*(?:res-desc|rich-text|brief)[^"]*"[^>]*>([\s\S]{0,400}?)</)
    const snippet = d ? stripTags(d[1]) : undefined
    sources.push({ url, title, snippet: snippet || undefined })
  }
  return sources
}

/**
 * Brave：<div class="snippet ..." data-type="web">，首个 <a href> 是真实 URL，
 * 标题在 <div class="title..." title="...">，摘要在 class 含 content 的 div。
 * 只取 data-type="web" 的块（视频/新闻卡结构不同）。
 */
function parseBraveHtml(html) {
  const sources = []
  const seen = new Set()
  const items = html.split(/(?=<div class="snippet)/).filter((s) => s.startsWith('<div class="snippet'))
  for (const c of items) {
    if (!/data-type="web"/.test(c)) continue
    const href = (c.match(/<a[^>]*href="(https?:\/\/[^"]+)"/) || [])[1]
    if (!href) continue
    let host = ''
    try { host = new URL(href).hostname } catch { continue }
    if (/(^|\.)search\.brave\.com$/i.test(host)) continue
    if (seen.has(href)) continue
    seen.add(href)
    const t = c.match(/<div class="title[^"]*"[^>]*>/)
    const title = t ? stripTags(c.slice(t.index, t.index + 400).split('</div>')[0]) : ''
    if (!title) continue
    const d = c.match(/class="content[^"]*"[^>]*>([\s\S]{0,500}?)<\/div>/)
    const snippet = d ? stripTags(d[1]) : undefined
    sources.push({ url: href, title, snippet: snippet || undefined })
  }
  return sources
}

/**
 * 引擎表。每个引擎: { id, label, run(query, max, opts) → {sources, content?} }
 * label 用于工具输出与诊断。
 */
function makeEngines(readSettings) {
  return {
    'ddg-api': {
      label: 'DuckDuckGo Instant Answer API',
      async run(query, max, opts) {
        // 注意：DDG IA 正常时也可能回 202（Accepted），所以接受一切 2xx。
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        let data
        try { data = JSON.parse(res.content) } catch { throw new Error('DDG API 返回非 JSON') }
        const parsed = parseDdgApi(data, query)
        if (parsed.sources.length === 0) throw new Error('DDG IA 无结果（该引擎只覆盖实体/事实类查询）')
        return parsed
      },
    },
    'ddg-html': {
      label: 'DuckDuckGo HTML',
      async run(query, max, opts) {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const sources = parseDdgHtml(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('DDG HTML 未解析到结果（可能被风控页拦截）')
        return { sources }
      },
    },
    bing: {
      label: 'Bing',
      async run(query, max, opts) {
        const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(Math.max(max, 10), 30)}&setlang=zh-hans`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const sources = parseBingHtml(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('Bing 未解析到结果')
        return { sources }
      },
    },
    wikipedia: {
      label: 'Wikipedia API',
      async run(query, max, opts) {
        const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srsearch=${encodeURIComponent(query)}&srlimit=${Math.min(max, 50)}`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        let data
        try { data = JSON.parse(res.content) } catch { throw new Error('Wikipedia API 返回非 JSON') }
        const hits = (data && data.query && data.query.search) || []
        const sources = hits.map((item) => ({
          url: `https://en.wikipedia.org/?curid=${item.pageid}`,
          title: item.title,
          snippet: item.snippet ? stripTags(item.snippet) : undefined,
        }))
        if (sources.length === 0) throw new Error('Wikipedia 无结果')
        return { sources }
      },
    },
    baidu: {
      label: '百度',
      async run(query, max, opts) {
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${clampInt(max, 10, 10, 20)}`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const sources = parseBaiduHtml(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('百度未解析到结果（可能触发反爬）')
        return { sources }
      },
    },
    so360: {
      label: '360 搜索',
      async run(query, max, opts) {
        const url = `https://www.so.com/s?q=${encodeURIComponent(query)}&rn=${clampInt(max, 10, 10, 20)}`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const sources = parseSo360Html(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('360 未解析到结果')
        return { sources }
      },
    },
    brave: {
      label: 'Brave',
      async run(query, max, opts) {
        const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const sources = parseBraveHtml(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('Brave 未解析到结果')
        return { sources }
      },
    },
    // ── API-key 型引擎（key 在 设置→插件→网页搜索 配置，存本机 settings.yaml）──
    serper: {
      label: 'Serper.dev（Google 结果 API）',
      needsKey: 'serperApiKey',
      async run(query, max, opts) {
        const res = await httpPostJson('https://google.serper.dev/search', { q: query, num: Math.min(max, 20) }, { 'X-API-KEY': opts.apiKey }, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.organic) || []
        if (hits.length === 0) throw new Error('Serper 无结果')
        return { sources: hits.map((h) => ({ url: h.link, title: h.title, snippet: h.snippet })) }
      },
    },
    tavily: {
      label: 'Tavily API',
      needsKey: 'tavilyApiKey',
      async run(query, max, opts) {
        const res = await httpPostJson(
          'https://api.tavily.com/search',
          { query, max_results: Math.min(max, 20), search_depth: 'basic', include_answer: false },
          { Authorization: `Bearer ${opts.apiKey}` },
          opts
        )
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.results) || []
        if (hits.length === 0) throw new Error('Tavily 无结果')
        return { sources: hits.map((h) => ({ url: h.url, title: h.title, snippet: h.content })) }
      },
    },
    'brave-api': {
      label: 'Brave Search API',
      needsKey: 'braveApiKey',
      async run(query, max, opts) {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(Math.max(max, 1), 20)}`
        const res = await httpGetJson(url, { 'X-Subscription-Token': opts.apiKey, Accept: 'application/json' }, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.web && res.data.web.results) || []
        if (hits.length === 0) throw new Error('Brave API 无结果')
        return { sources: hits.map((h) => ({ url: h.url, title: h.title, snippet: h.description })) }
      },
    },
    exa: {
      label: 'Exa API（神经/语义搜索）',
      needsKey: 'exaApiKey',
      async run(query, max, opts) {
        const res = await httpPostJson(
          'https://api.exa.ai/search',
          { query, numResults: Math.min(max, 20) },
          { 'x-api-key': opts.apiKey },
          opts
        )
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.results) || []
        if (hits.length === 0) throw new Error('Exa 无结果')
        return { sources: hits.map((h) => ({ url: h.url, title: h.title, snippet: h.text ? String(h.text).slice(0, 300) : undefined })) }
      },
    },
  }
}

// auto 模式链（语言感知 + API 引擎优先）：
//   • 查询含 CJK → 中文链（Bing/百度/360 对中文覆盖最好）；
//   • 否则 → 英文链（DDG HTML/Bing/Brave）；
//   • 配置了 API key 且 apiInAuto 未关时，API 引擎（Serper=Google 结果、
//     Tavily、Brave API、Exa）排在最前（质量最高，消耗配额）；
//   • settings.defaultEngine 非 auto 时该引擎最先试。
const API_AUTO_ORDER = ['serper', 'tavily', 'brave-api', 'exa']
const ZH_AUTO_ORDER = ['bing', 'baidu', 'so360', 'ddg-html', 'ddg-api', 'wikipedia']
const EN_AUTO_ORDER = ['ddg-html', 'bing', 'brave', 'ddg-api', 'wikipedia']
/** auto 链总时间预算（毫秒）：超时后不再尝试剩余引擎，避免工具超时。 */
const AUTO_TIME_BUDGET_MS = 60000

// ── 设置解析 ────────────────────────────────────────────────────────────────

/** 组合行 config（BASE 层兜底）。 */
let entryConfig = {}

/** settings scope（注册成功后优先）。 */
let settingsScope = undefined

function resolvedSettings() {
  const fromScope = settingsScope ? settingsScope.get() : undefined
  const s = { ...(fromScope || entryConfig) }
  return {
    enabled: s.enabled !== false,
    defaultEngine: s.defaultEngine || 'auto',
    enableDdgApi: s.enableDdgApi !== false,
    enableDdgHtml: s.enableDdgHtml !== false,
    enableBing: s.enableBing !== false,
    enableWikipedia: s.enableWikipedia !== false,
    enableBaidu: s.enableBaidu !== false,
    enableSo360: s.enableSo360 !== false,
    enableBrave: s.enableBrave !== false,
    apiInAuto: s.apiInAuto !== false,
    tavilyApiKey: typeof s.tavilyApiKey === 'string' ? s.tavilyApiKey.trim() : '',
    serperApiKey: typeof s.serperApiKey === 'string' ? s.serperApiKey.trim() : '',
    braveApiKey: typeof s.braveApiKey === 'string' ? s.braveApiKey.trim() : '',
    exaApiKey: typeof s.exaApiKey === 'string' ? s.exaApiKey.trim() : '',
    maxResults: clampInt(s.maxResults, 10, 1, 50),
    timeoutMs: clampInt(s.timeoutMs, 20000, 3000, 90000),
    userAgent: typeof s.userAgent === 'string' && s.userAgent.trim() ? s.userAgent : DEFAULT_UA,
  }
}

function apiKeyFor(id, s) {
  if (id === 'serper') return s.serperApiKey
  if (id === 'tavily') return s.tavilyApiKey
  if (id === 'brave-api') return s.braveApiKey
  if (id === 'exa') return s.exaApiKey
  return ''
}

function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function engineEnabled(id, s) {
  if (id === 'ddg-api') return s.enableDdgApi
  if (id === 'ddg-html') return s.enableDdgHtml
  if (id === 'bing') return s.enableBing
  if (id === 'wikipedia') return s.enableWikipedia
  if (id === 'baidu') return s.enableBaidu
  if (id === 'so360') return s.enableSo360
  if (id === 'brave') return s.enableBrave
  // API 型引擎：有 key 即启用
  if (['serper', 'tavily', 'brave-api', 'exa'].includes(id)) return Boolean(apiKeyFor(id, s))
  return false
}

// ── 搜索执行 ────────────────────────────────────────────────────────────────

/**
 * 执行一次搜索。engine 为 'auto' 时按语言感知链在已启用引擎间回退。
 * @returns {Promise<{content?: string, sources: Array, truncated: boolean, engine: string, attempts: Array}>}
 */
async function runSearch(query, engineArg, maxResultsArg, signal) {
  const s = resolvedSettings()
  if (!s.enabled) {
    return { sources: [], truncated: false, engine: 'none', attempts: [], error: '网页搜索已在设置中禁用（设置→插件→网页搜索）' }
  }
  const engines = makeEngines(s)
  const max = clampInt(maxResultsArg ?? s.maxResults, s.maxResults, 1, 50)
  const opts = { timeoutMs: s.timeoutMs, userAgent: s.userAgent, signal }

  const attempts = []
  const tryEngine = async (id) => {
    const engine = engines[id]
    if (!engine) {
      attempts.push({ engine: id, ok: false, error: 'unknown engine' })
      return undefined
    }
    if (!engineEnabled(id, s)) {
      attempts.push({ engine: id, ok: false, error: 'engine disabled in settings' })
      return undefined
    }
    try {
      const engineOpts = engine.needsKey ? { ...opts, apiKey: apiKeyFor(id, s) } : opts
      const r = await engine.run(query, max, engineOpts)
      noteEngine(id, undefined)
      attempts.push({ engine: id, ok: true, count: r.sources.length })
      return r
    } catch (e) {
      const msg = String((e && e.message) || e)
      noteEngine(id, msg)
      attempts.push({ engine: id, ok: false, error: msg })
      return undefined
    }
  }

  const ALL_ENGINES = [...Object.keys(engines)]

  if (engineArg && engineArg !== 'auto') {
    if (!engines[engineArg]) {
      return { sources: [], truncated: false, engine: engineArg, attempts, error: `未知引擎 "${engineArg}"（可用：${['auto', ...ALL_ENGINES].join(', ')}）` }
    }
    if (!engineEnabled(engineArg, s)) {
      const hint = engines[engineArg].needsKey ? `（需在 设置→插件→网页搜索 配置 API key）` : '（设置→插件→网页搜索）'
      return { sources: [], truncated: false, engine: engineArg, attempts, error: `引擎 "${engineArg}" 不可用${hint}` }
    }
    const r = (await tryEngine(engineArg)) || { sources: [] }
    // 显式引擎失败时把原因提升到 error 字段（否则模型只见 "No results found."）
    const failure = r.sources.length === 0 ? attempts.filter((a) => a.engine === engineArg && !a.ok).map((a) => a.error).join('; ') : undefined
    return { ...r, sources: r.sources.slice(0, max), truncated: r.sources.length > max, engine: engineArg, attempts, error: failure || undefined }
  }

  // auto 链：defaultEngine 显式指定 → 最先；否则 API 引擎（有 key 且未关 apiInAuto）
  // → 语言感知基础链。
  const chain = []
  if (s.defaultEngine && s.defaultEngine !== 'auto' && engines[s.defaultEngine]) {
    chain.push(s.defaultEngine)
  } else if (s.apiInAuto !== false) {
    for (const id of API_AUTO_ORDER) if (apiKeyFor(id, s)) chain.push(id)
  }
  const isZh = /[\u4e00-\u9fff]/.test(query)
  for (const id of isZh ? ZH_AUTO_ORDER : EN_AUTO_ORDER) if (!chain.includes(id)) chain.push(id)

  const deadline = Date.now() + AUTO_TIME_BUDGET_MS
  for (const id of chain) {
    if (Date.now() > deadline) {
      attempts.push({ engine: '(budget)', ok: false, error: 'auto 链时间预算耗尽' })
      break
    }
    const r = await tryEngine(id)
    if (r && r.sources.length > 0) {
      return { ...r, sources: r.sources.slice(0, max), truncated: r.sources.length > max, engine: id, attempts }
    }
  }
  return {
    sources: [],
    truncated: false,
    engine: 'auto',
    attempts,
    error: attempts.length > 0 ? `所有引擎均失败：${attempts.map((a) => `${a.engine}(${a.error})`).join('; ')}` : '没有可用引擎（全部被禁用）',
  }
}

// ── 工具输出渲染 ────────────────────────────────────────────────────────────

function renderSearchOutput(value) {
  const parts = []
  if (value.error) parts.push(`⚠ ${value.error}`)
  if (value.content) parts.push(value.content)
  if (value.sources && value.sources.length > 0) {
    const lines = value.sources.map((src) => {
      const label = src.title || src.url
      const meta = src.snippet ? ` — ${src.snippet}` : ''
      return `- [${label}](${src.url})${meta}`
    })
    parts.push(`Sources (engine: ${value.engine}):\n${lines.join('\n')}`)
  } else if (!value.error) {
    parts.push('No results found.')
  }
  if (value.truncated) parts.push(`(Showing the first ${value.sources.length} sources.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

function renderFetchOutput(value) {
  if (value.error) return `⚠ ${value.error}`
  const head = `Fetched ${value.url} — HTTP ${value.statusCode}${value.truncated ? ' (truncated)' : ''}`
  const body = value.textContent || ''
  return `${head}\n\n${body}`
}

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

// ── HTML → 文本（web_fetch_url 用）─────────────────────────────────────────

function htmlToText(html) {
  if (turndown) {
    try {
      return turndown.turndown(html)
    } catch {
      // 落到粗剥离
    }
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|table|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // 组合行 config（cordis 惯例：apply 第二参数）→ settings BASE 层兜底。
  entryConfig = typeof config === 'object' && config !== null ? config : {}
  const disposers = []
  const keep = (d) => {
    disposers.push(d)
    return d
  }

  // 1. settings namespace（存在 settings 服务时注册；schema 从 harness 解析）
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings')
    if (!settings || typeof settings.register !== 'function') return
    let schema
    try {
      if (Schema) {
        schema = Schema.object({
          enabled: Schema.boolean().default(true).description('总开关：关闭后 web_search_multi 返回禁用提示'),
          defaultEngine: Schema.union(['auto', 'ddg-api', 'ddg-html', 'bing', 'baidu', 'so360', 'brave', 'wikipedia', 'brave-api', 'tavily', 'serper', 'exa']).default('auto').description('默认引擎；auto = 语言感知回退链（中文：Bing→百度→360→DDG→…；英文：DDG HTML→Bing→Brave→…；配置了 API key 的引擎优先）'),
          enableDdgApi: Schema.boolean().default(true).description('启用 DuckDuckGo Instant Answer API（事实/实体类快答）'),
          enableDdgHtml: Schema.boolean().default(true).description('启用 DuckDuckGo HTML 抓取（通用搜索）'),
          enableBing: Schema.boolean().default(true).description('启用 Bing 抓取（大陆可达的通用搜索）'),
          enableBaidu: Schema.boolean().default(true).description('启用百度抓取（中文搜索，mu 属性取真实 URL）'),
          enableSo360: Schema.boolean().default(true).description('启用 360 搜索抓取（中文，data-mdurl 取真实 URL）'),
          enableBrave: Schema.boolean().default(true).description('启用 Brave 抓取（独立索引，英文覆盖好）'),
          enableWikipedia: Schema.boolean().default(true).description('启用 Wikipedia API（部分地区网络不可达）'),
          apiInAuto: Schema.boolean().default(true).description('auto 链优先使用已配置 key 的 API 引擎（会消耗 API 配额，关闭则 auto 只用免费引擎）'),
          tavilyApiKey: Schema.string().default('').description('Tavily API key（api.tavily.com，配置后 tavily 引擎可用；获取：https://app.tavily.com）'),
          serperApiKey: Schema.string().default('').description('Serper.dev API key（google.serper.dev，Google 结果，配置后 serper 引擎可用；获取：https://serper.dev/signup）'),
          braveApiKey: Schema.string().default('').description('Brave Search API key（api.search.brave.com，配置后 brave-api 引擎可用；获取：https://brave.com/search/api/）'),
          exaApiKey: Schema.string().default('').description('Exa API key（api.exa.ai，神经/语义搜索，配置后 exa 引擎可用；获取：https://dashboard.exa.ai）'),
          maxResults: Schema.number().default(10).description('每次搜索默认返回条数（1-50）'),
          timeoutMs: Schema.number().default(20000).description('单引擎请求超时毫秒数（3000-90000）'),
          userAgent: Schema.string().default(DEFAULT_UA).description('抓取用 User-Agent'),
        })
      }
    } catch {
      schema = undefined
    }
    if (!schema) return
    try {
      settingsScope = settings.register(SETTINGS_NS, schema, {
        base: entryConfig,
        applies: 'live',
      })
    } catch (e) {
      console.error(`[web-search] settings namespace 注册失败：${(e && e.message) || e}`)
    }
  })

  // 2. 搜索引擎 provider 注册进 ctx.web（供将来把 web.search() 钉到自定义引擎用）
  try {
    const enginesForWeb = makeEngines(resolvedSettings)
    for (const id of Object.keys(enginesForWeb)) {
      const engine = enginesForWeb[id]
      keep(
        ctx.web.registerSearchProvider({
          id,
          available() {
            const s = resolvedSettings()
            return s.enabled && engineEnabled(id, s)
          },
          async search(request, signal) {
            const s = resolvedSettings()
            const r = await engine.run(request.query, request.maxResults ?? s.maxResults, {
              timeoutMs: s.timeoutMs,
              userAgent: s.userAgent,
              signal,
            })
            return { content: r.content, sources: r.sources, truncated: false }
          },
        })
      )
    }
  } catch (e) {
    console.error(`[web-search] 搜索引擎 provider 注册失败：${(e && e.message) || e}`)
  }

  // 3. 模型工具：web_search_multi
  keep(
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'web_search_multi',
          description:
            '多引擎网页搜索（11 引擎）。engine 可选：auto（默认，语言感知回退链：中文查询 Bing→百度→360→DDG，英文查询 DDG HTML→Bing→Brave；配置了 API key 的引擎优先）/ 免费抓取 ddg-api（DDG IA API 事实快答）、ddg-html、bing、baidu（百度）、so360（360）、brave（独立索引）、wikipedia / API-key 型 serper（Google 结果）、tavily、brave-api、exa（语义搜索）。返回 sources（url/title/snippet）。当内置 web_search 结果不足、需要指定引擎或事实快答时优先使用本工具。配置见 设置→插件→网页搜索。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['query'],
            properties: {
              query: { type: 'string', description: '搜索关键词。' },
              engine: { type: 'string', enum: ['auto', 'ddg-api', 'ddg-html', 'bing', 'baidu', 'so360', 'brave', 'wikipedia', 'brave-api', 'tavily', 'serper', 'exa'], description: '搜索引擎，默认 auto。' },
              maxResults: { type: 'integer', description: '返回条数上限（1-50，默认取设置值）。' },
            },
          },
          output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderSearchOutput(value) }] },
          timeoutMs: 90000,
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const query = String(args.query || '').trim()
            if (!query) return { sources: [], truncated: false, engine: 'none', error: 'query is required' }
            return await runSearch(query, args.engine, args.maxResults, exec && exec.signal)
          },
        }),
      'web-search: web_search_multi tool'
    )
  )

  // 4. 模型工具：web_fetch_url（走官方 http provider，SSRF 安全）
  keep(
    ctx.effect(
      () =>
        ctx.tools.register({
          name: 'web_fetch_url',
          description:
            '抓取一个公开网页/接口并返回文本内容（HTML 自动转 markdown）。经官方 http fetch provider 执行（SSRF 防护、同源重定向、字节上限）；非 2xx 状态码也会返回响应体。适合在 web_search_multi / web_search 之后跟进阅读具体来源页。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['url'],
            properties: {
              url: { type: 'string', description: '要抓取的 http(s) URL。' },
              maxChars: { type: 'integer', description: '返回正文字符上限（默认 20000，最大 100000）。' },
            },
          },
          output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderFetchOutput(value) }] },
          timeoutMs: 90000,
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const url = String(args.url || '').trim()
            if (!/^https?:\/\//i.test(url)) {
              return { error: `仅支持 http(s) URL，收到：${url}` }
            }
            const maxChars = clampInt(args.maxChars, 20000, 500, 100000)
            try {
              const r = await ctx.web.fetch({ url }, exec && exec.signal)
              const isHtml = r.body && r.body.kind === 'html'
              const text = isHtml ? htmlToText(r.body.content) : String((r.body && r.body.content) || '')
              const truncated = text.length > maxChars
              return {
                url: r.url,
                statusCode: r.statusCode,
                truncated,
                textContent: truncated ? text.slice(0, maxChars) : text,
              }
            } catch (e) {
              return { error: `抓取失败：${(e && e.message) || e}` }
            }
          },
        }),
      'web-search: web_fetch_url tool'
    )
  )

  // 5. systemPrompt 引导
  keep(
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'web-search:tools',
          order: 106,
          text: [
            'Enhanced web tools are available:',
            '- web_search_multi: multi-engine web search (11 engines). engine="auto" (default) uses a language-aware fallback chain (Chinese queries: Bing → Baidu → So360 → DDG; others: DDG HTML → Bing → Brave; API-key engines go first when configured). Explicit engines: "ddg-api" (fact quick answers), "ddg-html", "bing", "baidu", "so360", "brave", "wikipedia" (free); "serper" (Google results), "tavily", "brave-api", "exa" (need API keys configured in settings).',
            '- web_fetch_url: fetch any public URL and return text (HTML converted to markdown).',
            'Use web_search_multi when the built-in web_search returns insufficient results, when a specific engine is needed, or for quick fact lookups; use web_fetch_url to read a source page after searching. Results carry url/title/snippet — cite URLs as markdown links.',
          ].join('\n'),
        }),
      'web-search: system prompt section'
    )
  )

  // 6. 诊断路由（health + test，设置卡片「测试」按钮也用 /web-search/test）
  ctx.inject(['webServer'], (webCtx) => {
    const ws = webCtx.get('webServer')
    if (!ws || typeof ws.register !== 'function') return

    webCtx.effect(
      () =>
        ws.register({
          kind: 'exact',
          path: '/web-search/health',
          handler: (req, res) => {
            try {
              const s = resolvedSettings()
              // 打码 API key（health 面向本机任意浏览器，不能泄密钥）
              const redacted = {}
              for (const [k, v] of Object.entries(s)) {
                redacted[k] = k.endsWith('ApiKey') ? (v ? `***(${String(v).length} chars)` : '') : v
              }
              const body = JSON.stringify(
                {
                  ok: true,
                  settings: redacted,
                  schemaLoaded: Boolean(Schema),
                  turndownLoaded: Boolean(turndown),
                  stats,
                  lastErrors,
                },
                null,
                2
              )
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(body)
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: String((e && e.message) || e) }))
            }
          },
        }),
      'web-search: health route'
    )

    webCtx.effect(
      () =>
        ws.register({
          kind: 'exact',
          path: '/web-search/test',
          handler: (req, res) => {
            const url = new URL(req.url, 'http://localhost')
            const q = url.searchParams.get('q') || 'deepseek'
            const engine = url.searchParams.get('engine') || 'auto'
            runSearch(q, engine, 5, undefined)
              .then((r) => {
                const body = JSON.stringify({ query: q, engine: r.engine, error: r.error || null, attempts: r.attempts, count: (r.sources || []).length, sources: (r.sources || []).slice(0, 5) }, null, 2)
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
                res.end(body)
              })
              .catch((e) => {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: String((e && e.message) || e) }))
              })
          },
        }),
      'web-search: test route'
    )
  })

  // 组合行 config 作为 settings BASE 层兜底（web-search 行的 config 键）
  return function cleanup() {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 忽略 */
      }
    }
  }
}
