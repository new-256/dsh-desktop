// web-search — host half（家级 cordis.patch.yml 的 file:// 行加载，?v=N 热加载）。
//
// 注册内容：
//   1. 模型工具 web_search_multi —— 38 引擎/渠道搜索（8 大类）：
//      【通用网页】auto（默认，语言感知回退链）/ ddg-html / bing / baidu / so360 /
//      brave / ddg-api / wikipedia（语言感知）/ marginalia / serper / tavily /
//      brave-api / exa（后四个 API-key 型）
//      【聚合】aggregate（并行多引擎 + RRF 融合去重；复合语法 aggregate:子集）
//      【学术文献】arxiv / openalex / crossref / pubmed / europepmc / dblp
//      【开发者】github / npm / crates / dockerhub / stackexchange / mdn / csdn
//      【新闻与社区】news / hn
//      【媒体娱乐】youtube / bilibili / images / itunes
//      【中文内容】wechat / zhidao
//      【资料参考】wikidata / books / archive / maps
//      横切能力：freshness 时效过滤（day/week/month/year）、复合聚合、语言感知。
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
 * extraHeaders 允许引擎追加 Referer/Cookie/Accept 等（bilibili 等站点需要）。
 * @returns {Promise<{ok: boolean, statusCode: number, content: string, error?: string}>}
 */
async function httpGet(url, { timeoutMs, userAgent, signal, headers }) {
  const ctrl = new AbortController()
  const t = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined
  const onOuter = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onOuter, { once: true })
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent || DEFAULT_UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(headers || {}),
      },
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
async function httpGetJson(url, headers, { timeoutMs, signal, userAgent }) {
  const ctrl = new AbortController()
  const t = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined
  const onOuter = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onOuter, { once: true })
  }
  try {
    // 默认 UA + Accept: application/json（部分 API 拒绝无 UA 请求，如 Nominatim）；
    // 调用方可通过 headers 覆盖（如 Crossref polite pool 的 mailto UA）。
    const res = await fetch(url, { headers: { 'User-Agent': userAgent || DEFAULT_UA, Accept: 'application/json', ...(headers || {}) }, signal: ctrl.signal, redirect: 'follow' })
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
async function httpPostJson(url, body, headers, { timeoutMs, signal, userAgent }) {
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
      headers: { 'User-Agent': userAgent || DEFAULT_UA, 'Content-Type': 'application/json', ...headers },
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

/** Atom XML（arXiv API）：<entry> → {url, title, snippet(日期+摘要)}。 */
function parseAtomEntries(xml) {
  const sources = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]
    const id = (e.match(/<id>([^<]+)<\/id>/) || [])[1]
    const title = stripTags((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')
    const summary = stripTags((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '')
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1]
    if (id && title) {
      sources.push({ url: id, title, snippet: [published ? published.slice(0, 10) : '', summary.slice(0, 200)].filter(Boolean).join(' · ') || undefined })
    }
  }
  return sources
}

/**
 * RSS XML（新闻引擎）：<item> → {url, title, snippet(日期+描述)}。
 * decodeBingLink=true 时把 Bing apiclick.aspx 重定向里的 url= 参数解码为真实 URL。
 */
function parseRssItems(xml, { decodeBingLink = false } = {}) {
  const sources = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]
    let link = decodeEntities((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim()
    if (decodeBingLink && link) {
      const u = link.match(/[?&]url=([^&]+)/)
      if (u) {
        try {
          const real = decodeURIComponent(u[1])
          if (/^https?:\/\//i.test(real)) link = real
        } catch { /* 保留原链接 */ }
      }
    }
    const title = stripTags((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')
    const desc = stripTags((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '')
    const date = (it.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1]
    if (link && title) {
      sources.push({ url: link, title, snippet: [date ? date.slice(0, 16) : '', desc.slice(0, 180)].filter(Boolean).join(' · ') || undefined })
    }
  }
  return sources
}

/**
 * 搜狗微信（微信公众号文章）：<div class="txt-box"> 里 <h3><a> 标题链接 +
 * <p class="txt-info"> 摘要。链接是 sogou /link 重定向（有时效，点击可用）。
 */
function parseSogouWechat(html) {
  const sources = []
  const seen = new Set()
  const boxes = html.split(/(?=<div class="txt-box")/).filter((s) => s.startsWith('<div class="txt-box'))
  for (const b of boxes) {
    const a = b.match(/<h3>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!a) continue
    let href = decodeEntities(a[1])
    if (href.startsWith('/link') || href.startsWith('/link?')) href = 'https://weixin.sogou.com' + href
    if (!/^https?:\/\//i.test(href)) continue
    const title = stripTags(a[2])
    if (!title) continue
    const key = `${title}|${href}`
    if (seen.has(key)) continue
    seen.add(key)
    const p = b.match(/<p[^>]*class="txt-info"[^>]*>([\s\S]*?)<\/p>/)
    const snippet = p ? stripTags(p[1]) : undefined
    const account = b.match(/<a[^>]*class="account"[^>]*>([\s\S]*?)<\/a>/)
    const accountName = account ? stripTags(account[1]) : ''
    sources.push({ url: href, title, snippet: [accountName ? `公众号: ${accountName}` : '', snippet || ''].filter(Boolean).join(' · ') || undefined })
  }
  return sources
}

/**
 * 引擎表。每个引擎: { id, label, run(query, max, opts) → {sources, content?} }
 * label 用于工具输出与诊断。
 */
/** URL 归一化（聚合去重键）：小写协议/主机、去 www.、去 hash、去常见跟踪参数、去尾斜杠。 */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    const params = [...u.searchParams].filter(([k]) => !/^(utm_|spm|from|vd_source|ref|referrer|si)/i.test(k))
    const qs = params.map(([k, v]) => `${k}=${v}`).join('&')
    return `${host}${path}${qs ? '?' + qs : ''}`
  } catch {
    return String(raw || '').toLowerCase()
  }
}

// ── 时效过滤（freshness）→ 各引擎原生参数映射 ─────────────────────────────────
// 支持的引擎在 URL 上追加原生参数；不支持的原样忽略。值：day/week/month/year。
const FRESHNESS_MS = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 }

/** DDG HTML：df=d/w/m/y。 */
function freshnessDdg(f) {
  return f === 'day' ? 'd' : f === 'week' ? 'w' : f === 'month' ? 'm' : f === 'year' ? 'y' : undefined
}

/** Brave：tf=pd/pw/pm/py。 */
function freshnessBrave(f) {
  return ({ day: 'pd', week: 'pw', month: 'pm', year: 'py' })[f]
}

/** 百度：gpc=stf=<start>,<end>（unix 秒）。 */
function freshnessBaiduParam(f) {
  const ms = FRESHNESS_MS[f]
  if (!ms) return undefined
  const end = Math.floor(Date.now() / 1000)
  const start = end - Math.floor(ms / 1000)
  return `stf=${start},${end}`
}

/** Google News RSS：query 追加 when:1d/7d/30d/365d。 */
function freshnessGnewsSuffix(f) {
  return ({ day: '1d', week: '7d', month: '30d', year: '365d' })[f]
}

/**
 * 百度知道：结果条目为 <a href="http://zhidao.baidu.com/question/ID.html"
 * data-log="fm:as,pos:ti,...">标题</a>，摘要在其后 800 字符内的 answer 类元素里。
 */
function parseZhidaoHtml(html) {
  const sources = []
  const seen = new Set()
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/zhidao\.baidu\.com\/question\/[^"?]+)[^"]*"[^>]*data-log="fm:as,pos:ti[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = m[1]
    if (seen.has(url)) continue
    seen.add(url)
    const title = stripTags(m[2])
    if (!title) continue
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 800)
    const am = after.match(/<(?:dd|div|p)[^>]*class="[^"]*answer[^"]*"[^>]*>([\s\S]*?)<\/(?:dd|div|p)>/)
    const snippet = am ? stripTags(am[1]) : undefined
    sources.push({ url, title, snippet: snippet || undefined })
  }
  return sources
}

// ── 引擎分类（设置卡片分组 / 工具描述 / 健康端点用）─────────────────────────────
const ENGINE_CATEGORY = {
  // 通用网页（auto 链与显式通用）
  'ddg-html': 'general', bing: 'general', baidu: 'general', so360: 'general', brave: 'general',
  'ddg-api': 'general', wikipedia: 'general', marginalia: 'general',
  serper: 'general', tavily: 'general', 'brave-api': 'general', exa: 'general',
  // 聚合
  aggregate: 'aggregate',
  // 学术文献
  arxiv: 'academic', openalex: 'academic', crossref: 'academic', pubmed: 'academic', europepmc: 'academic', dblp: 'academic',
  // 开发者
  github: 'dev', npm: 'dev', crates: 'dev', dockerhub: 'dev', stackexchange: 'dev', mdn: 'dev', csdn: 'dev',
  // 新闻与社区
  news: 'news', hn: 'news',
  // 媒体娱乐
  youtube: 'media', bilibili: 'media', images: 'media', itunes: 'media',
  // 中文内容
  wechat: 'chinese', zhidao: 'chinese',
  // 资料参考
  wikidata: 'reference', books: 'reference', archive: 'reference', maps: 'reference',
}
/** 分类 → 中文标签。 */
const CATEGORY_LABELS = {
  general: '通用网页',
  aggregate: '聚合',
  academic: '学术文献',
  dev: '开发者',
  news: '新闻与社区',
  media: '媒体娱乐',
  chinese: '中文内容',
  reference: '资料参考',
}

function makeEngines(readSettings) {
  const engines = {
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
        const df = freshnessDdg(opts.freshness)
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${df ? `&df=${df}` : ''}`
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
      label: 'Wikipedia API（语言感知：中文查询→zh，其他→en）',
      async run(query, max, opts) {
        // 查询含 CJK → 中文维基，否则英文维基（两站 API 同构）
        const lang = /[\u4e00-\u9fff]/.test(query) ? 'zh' : 'en'
        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srsearch=${encodeURIComponent(query)}&srlimit=${Math.min(max, 50)}`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        let data
        try { data = JSON.parse(res.content) } catch { throw new Error('Wikipedia API 返回非 JSON') }
        const hits = (data && data.query && data.query.search) || []
        const sources = hits.map((item) => ({
          url: `https://${lang}.wikipedia.org/?curid=${item.pageid}`,
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
        const gpc = freshnessBaiduParam(opts.freshness)
        const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${clampInt(max, 10, 10, 20)}${gpc ? `&gpc=${encodeURIComponent(gpc)}` : ''}`
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
        const tf = freshnessBrave(opts.freshness)
        const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}${tf ? `&tf=${tf}` : ''}`
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
    // ── 垂直渠道引擎（不参与 auto 链，需显式指定 engine=<id>）─────────────────
    arxiv: {
      label: 'arXiv（学术论文）',
      vertical: true,
      async run(query, max, opts) {
        // https + 描述性 UA（http 或浏览器 UA 偶发超时）
        const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${Math.min(max, 20)}`
        const res = await httpGet(url, { ...opts, headers: { 'User-Agent': 'dsh-web-search/1.0 (https://github.com/new-256/dsh-web-search)' } })
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const sources = parseAtomEntries(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('arXiv 无结果')
        return { sources }
      },
    },
    github: {
      label: 'GitHub（代码仓库）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(max, 20)}`
        const res = await httpGetJson(url, { Accept: 'application/vnd.github+json' }, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.items) || []
        if (hits.length === 0) throw new Error('GitHub 无结果（未认证限 10 次/分钟）')
        return {
          sources: hits.map((h) => ({
            url: h.html_url,
            title: `${h.full_name} ★${h.stargazers_count}${h.language ? ` [${h.language}]` : ''}`,
            snippet: h.description || undefined,
          })),
        }
      },
    },
    stackexchange: {
      label: 'Stack Overflow（编程问答）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${Math.min(max, 30)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.items) || []
        if (hits.length === 0) throw new Error('Stack Overflow 无结果')
        return {
          sources: hits.map((h) => ({
            url: h.link,
            title: stripTags(h.title),
            snippet: `score ${h.score} · ${h.answer_count} 回答 · ${(h.tags || []).slice(0, 5).join(',')}`,
          })),
        }
      },
    },
    hn: {
      label: 'Hacker News（科技社区）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(max, 30)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.hits) || []
        if (hits.length === 0) throw new Error('Hacker News 无结果')
        return {
          sources: hits.map((h) => ({
            url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
            title: h.title || h.story_title || `HN 讨论 ${h.objectID}`,
            snippet: `${h.points ?? '?'} 分 · ${h.num_comments ?? '?'} 评论 · 作者 ${h.author || '?'}`,
          })),
        }
      },
    },
    news: {
      label: '新闻（Bing News RSS → Google News RSS 兜底）',
      vertical: true,
      async run(query, max, opts) {
        // 主：Bing 新闻 RSS（真实 URL 可从 url= 参数解码）
        try {
          const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`
          const res = await httpGet(url, opts)
          if (res.ok && !res.error) {
            const sources = parseRssItems(res.content, { decodeBingLink: true }).slice(0, max)
            if (sources.length > 0) return { sources }
          }
        } catch { /* 落到 Google News */ }
        // 兜底：Google News RSS（链接是 google 重定向，点击可用；支持 when: 时效）
        const w = freshnessGnewsSuffix(opts.freshness)
        const q2 = w ? `${query} when:${w}` : query
        const url2 = `https://news.google.com/rss/search?q=${encodeURIComponent(q2)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`
        const res2 = await httpGet(url2, opts)
        if (!res2.ok || res2.error) throw new Error(res2.error || `HTTP ${res2.statusCode}`)
        const sources = parseRssItems(res2.content).slice(0, max)
        if (sources.length === 0) throw new Error('新闻引擎无结果')
        return { sources }
      },
    },
    marginalia: {
      label: 'Marginalia（独立小众索引）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}`
        // Marginalia 冷查询慢（单人维护的服务），内部保底 30s
        const res = await httpGetJson(url, {}, { ...opts, timeoutMs: Math.max(opts.timeoutMs, 30000) })
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.results) || []
        if (hits.length === 0) throw new Error('Marginalia 无结果')
        return { sources: hits.slice(0, max).map((h) => ({ url: h.url, title: h.title, snippet: h.description || undefined })) }
      },
    },
    bilibili: {
      label: '哔哩哔哩（视频）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`
        const res = await httpGetJson(url, { Referer: 'https://www.bilibili.com/', Cookie: 'buvid3=infoc' }, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const code = res.data && res.data.code
        if (code !== 0) throw new Error(`B 站 API code=${code}（${(res.data && res.data.message) || '可能需要更完整的 cookie'}）`)
        const blocks = ((res.data && res.data.data && res.data.data.result) || []).filter((b) => b.result_type === 'video')
        const videos = blocks.flatMap((b) => b.data || []).slice(0, max)
        if (videos.length === 0) throw new Error('B 站无视频结果')
        return {
          sources: videos.map((v) => ({
            url: `https://www.bilibili.com/video/${v.bvid}`,
            title: stripTags(v.title || ''),
            snippet: [v.author ? `UP: ${v.author}` : '', v.description ? String(v.description).slice(0, 100) : ''].filter(Boolean).join(' · ') || undefined,
          })),
        }
      },
    },
    wechat: {
      label: '微信公众号文章（搜狗微信）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        if (/antispider/i.test(res.content)) throw new Error('搜狗微信触发反爬')
        const sources = parseSogouWechat(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('微信公众号无结果')
        return { sources }
      },
    },
    // ── 学术/开发/媒体垂直（第二轮扩展）───────────────────────────────────────
    openalex: {
      label: 'OpenAlex（学术全景索引，2.5 亿作品）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${Math.min(max, 25)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.results) || []
        if (hits.length === 0) throw new Error('OpenAlex 无结果')
        return {
          sources: hits.slice(0, max).map((h) => ({
            url: h.doi || h.id,
            title: h.title || h.display_name || 'Untitled',
            snippet:
              [
                h.publication_year ? String(h.publication_year) : '',
                h.cited_by_count != null ? `被引 ${h.cited_by_count}` : '',
                h.primary_location && h.primary_location.source ? h.primary_location.source.display_name : '',
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          })),
        }
      },
    },
    crossref: {
      label: 'Crossref（DOI/学术元数据）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${Math.min(max, 20)}&select=title,URL,container-title,issued`
        // Crossref polite pool：UA 带 mailto
        const res = await httpGetJson(url, { 'User-Agent': 'dsh-web-search/1.0 (mailto:lcl19950110@outlook.com)' }, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const items = (res.data && res.data.message && res.data.message.items) || []
        if (items.length === 0) throw new Error('Crossref 无结果')
        return {
          sources: items.slice(0, max).map((h) => ({
            url: h.URL,
            title: stripTags((h.title && h.title[0]) || ''),
            snippet:
              [
                (h['container-title'] && h['container-title'][0]) || '',
                h.issued && h.issued['date-parts'] && h.issued['date-parts'][0] && h.issued['date-parts'][0][0] ? String(h.issued['date-parts'][0][0]) : '',
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          })),
        }
      },
    },
    npm: {
      label: 'npm（Node 包搜索）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${Math.min(max, 25)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const objects = (res.data && res.data.objects) || []
        if (objects.length === 0) throw new Error('npm 无结果')
        return {
          sources: objects.slice(0, max).map((o) => {
            const p = o.package || {}
            return {
              url: (p.links && p.links.npm) || `https://www.npmjs.com/package/${p.name}`,
              title: `${p.name || '?'}@${p.version || '?'}`,
              snippet: p.description || undefined,
            }
          }),
        }
      },
    },
    csdn: {
      label: 'CSDN（中文技术博客）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://so.csdn.net/api/v3/search?q=${encodeURIComponent(query)}&t=all&p=1&s=0&tm=0&v=3&size=${Math.min(max * 2, 30)}`
        const res = await httpGetJson(url, { Referer: 'https://so.csdn.net/' }, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const items = (res.data && res.data.result_vos) || []
        const sources = items
          .map((vo) => ({ vo, url: typeof vo.url === 'string' ? vo.url.split('?')[0] : '' }))
          .filter((x) => /^https?:\/\//i.test(x.url))
          .slice(0, max)
          .map((x) => ({
            url: x.url,
            title: stripTags(x.vo.title || ''),
            snippet: stripTags(x.vo.description || x.vo.digest || '') || undefined,
          }))
        if (sources.length === 0) throw new Error('CSDN 无结果')
        return { sources }
      },
    },
    youtube: {
      label: 'YouTube（视频）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
        const res = await httpGet(url, { ...opts, headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        // 提取页面内嵌 ytInitialData JSON（花括号配对扫描，页面 1MB+）
        const idx = res.content.indexOf('ytInitialData')
        if (idx < 0) throw new Error('YouTube 页面结构变化（未找到 ytInitialData）')
        const start = res.content.indexOf('{', res.content.indexOf('=', idx))
        let depth = 0
        let end = -1
        let inStr = false
        let esc = false
        for (let i = start; i < res.content.length; i++) {
          const c = res.content[i]
          if (esc) {
            esc = false
            continue
          }
          if (c === '\\') {
            esc = true
            continue
          }
          if (inStr) {
            if (c === '"') inStr = false
            continue
          }
          if (c === '"') {
            inStr = true
            continue
          }
          if (c === '{') depth++
          else if (c === '}') {
            depth--
            if (depth === 0) {
              end = i + 1
              break
            }
          }
        }
        if (end < 0) throw new Error('ytInitialData 提取失败')
        let data
        try {
          data = JSON.parse(res.content.slice(start, end))
        } catch {
          throw new Error('ytInitialData JSON 解析失败')
        }
        const sectionList = (((data.contents || {}).twoColumnSearchResultsRenderer || {}).primaryContents || {}).sectionListRenderer
        const first = ((sectionList && sectionList.contents) || [])[0]
        const items = (((first && first.itemSectionRenderer) || {}).contents) || []
        const vids = items
          .map((c) => c.videoRenderer)
          .filter(Boolean)
          .slice(0, max)
        if (vids.length === 0) throw new Error('YouTube 无结果')
        return {
          sources: vids.map((v) => ({
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
            title: (v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text) || '',
            snippet:
              [
                v.ownerText && v.ownerText.runs && v.ownerText.runs[0] ? v.ownerText.runs[0].text : '',
                v.lengthText && v.lengthText.simpleText,
                v.viewCountText && v.viewCountText.simpleText,
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          })),
        }
      },
    },
    images: {
      label: '图片搜索（Bing Images）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`
        const res = await httpGet(url, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        // 每张图是一张 <a class="iusc" m="{...}"> 卡片，m 属性 HTML 转义的 JSON：
        // murl=图片直链 purl=来源页 t=标题
        const sources = []
        const seen = new Set()
        for (const m of res.content.matchAll(/<a[^>]*class="iusc"[^>]*\sm="([^"]+)"/g)) {
          let j
          try {
            j = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
          } catch {
            continue
          }
          if (!j.murl || seen.has(j.murl)) continue
          seen.add(j.murl)
          sources.push({
            url: j.murl,
            title: stripTags(j.t || ''),
            snippet: j.purl ? `来源页: ${j.purl}` : undefined,
          })
          if (sources.length >= max) break
        }
        if (sources.length === 0) throw new Error('图片搜索无结果')
        return { sources }
      },
    },
    // ── 生活/知识垂直（第三轮扩展）────────────────────────────────────────────
    pubmed: {
      label: 'PubMed（生物医学文献）',
      vertical: true,
      async run(query, max, opts) {
        // 两步：esearch 拿 PMID 列表 → esummary 拿标题/期刊/日期（限 3 次/秒，两步串行没问题）
        const n = Math.min(max, 20)
        const r1 = await httpGetJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=${n}`, {}, opts)
        if (!r1.ok || r1.error) throw new Error(r1.error || `HTTP ${r1.statusCode}`)
        const ids = (r1.data && r1.data.esearchresult && r1.data.esearchresult.idlist) || []
        if (ids.length === 0) throw new Error('PubMed 无结果')
        const r2 = await httpGetJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`, {}, opts)
        if (!r2.ok || r2.error) throw new Error(r2.error || `HTTP ${r2.statusCode}`)
        const result = (r2.data && r2.data.result) || {}
        const sources = ids
          .map((id) => result[id])
          .filter(Boolean)
          .map((a, i) => ({
            url: `https://pubmed.ncbi.nlm.nih.gov/${ids[i]}/`,
            title: a.title || `PMID ${ids[i]}`,
            snippet:
              [
                a.source,
                a.pubdate,
                Array.isArray(a.authors) ? a.authors.slice(0, 3).map((x) => x.name).join(', ') : '',
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          }))
        if (sources.length === 0) throw new Error('PubMed 摘要获取失败')
        return { sources }
      },
    },
    books: {
      label: 'Open Library（图书）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${Math.min(max, 20)}&fields=title,author_name,first_publish_year,key`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const docs = (res.data && res.data.docs) || []
        if (docs.length === 0) throw new Error('Open Library 无结果')
        return {
          sources: docs.slice(0, max).map((d) => ({
            url: `https://openlibrary.org${d.key}`,
            title: d.title || 'Untitled',
            snippet:
              [
                Array.isArray(d.author_name) ? d.author_name.slice(0, 3).join(', ') : '',
                d.first_publish_year ? `初版 ${d.first_publish_year}` : '',
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          })),
        }
      },
    },
    itunes: {
      label: 'iTunes（音乐/电影/播客/应用）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&limit=${Math.min(max, 25)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const results = (res.data && res.data.results) || []
        if (results.length === 0) throw new Error('iTunes 无结果')
        const KIND_ZH = {
          song: '歌曲',
          'feature-movie': '电影',
          podcast: '播客',
          'podcast-episode': '播客单集',
          software: '应用',
          ebook: '电子书',
          audiobook: '有声书',
          'music-video': 'MV',
          'tv-episode': '剧集',
        }
        return {
          sources: results.slice(0, max).map((r) => ({
            url: r.trackViewUrl,
            title: r.trackName || r.collectionName || '?',
            snippet:
              [
                KIND_ZH[r.kind] || r.kind || '',
                r.artistName || '',
                r.releaseDate ? String(r.releaseDate).slice(0, 10) : '',
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          })),
        }
      },
    },
    maps: {
      label: 'OpenStreetMap 地点搜索',
      vertical: true,
      async run(query, max, opts) {
        const lang = /[\u4e00-\u9fff]/.test(query) ? 'zh' : 'en'
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=${Math.min(max, 10)}&accept-language=${lang}`
        let res = await httpGetJson(url, {}, opts)
        // Nominatim 限 1 请求/秒：403/429 时退避 1.5s 重试一次
        if ((!res.ok || res.error) && (res.statusCode === 403 || res.statusCode === 429)) {
          await new Promise((r) => setTimeout(r, 1500))
          res = await httpGetJson(url, {}, opts)
        }
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const items = Array.isArray(res.data) ? res.data : []
        if (items.length === 0) throw new Error('地点搜索无结果')
        return {
          sources: items.slice(0, max).map((p) => ({
            url: `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`,
            title: String(p.display_name || '').split(',').slice(0, 2).join(','),
            snippet: `坐标 ${p.lat},${p.lon} · ${p.class}/${p.type}`,
          })),
        }
      },
    },
    // ── 终轮扩展（学术 2 / 开发 4 / 中文 1 / 参考 2）────────────────────────────
    dblp: {
      label: 'dblp（计算机科学文献库）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(query)}&format=json&h=${Math.min(max, 30)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.result && res.data.result.hits && res.data.result.hits.hit) || []
        if (hits.length === 0) throw new Error('dblp 无结果')
        return {
          sources: hits.slice(0, max).map((h) => {
            const info = h.info || {}
            const authors = info.authors && info.authors.author
            const authorText = Array.isArray(authors) ? authors.map((a) => a.text).join(', ') : authors && authors.text ? authors.text : ''
            return {
              url: info.url || `https://dblp.org/search?q=${encodeURIComponent(query)}`,
              title: info.title || 'Untitled',
              snippet: [info.venue, info.year, authorText].filter(Boolean).join(' · ') || undefined,
            }
          }),
        }
      },
    },
    europepmc: {
      label: 'Europe PMC（生物医学+预印本）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${Math.min(max, 25)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.resultList && res.data.resultList.result) || []
        if (hits.length === 0) throw new Error('Europe PMC 无结果')
        return {
          sources: hits.slice(0, max).map((h) => ({
            url: h.id ? `https://europepmc.org/article/${h.source}/${h.id}` : 'https://europepmc.org/',
            title: h.title || 'Untitled',
            snippet: [h.journalTitle, h.pubYear].filter(Boolean).join(' · ') || undefined,
          })),
        }
      },
    },
    crates: {
      label: 'crates.io（Rust 包）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${Math.min(max, 25)}`
        const res = await httpGetJson(url, { Accept: 'application/json' }, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.crates) || []
        if (hits.length === 0) throw new Error('crates.io 无结果')
        return {
          sources: hits.slice(0, max).map((c) => ({
            url: `https://crates.io/crates/${c.name}`,
            title: `${c.name}@${c.max_stable_version || c.max_version || '?'}`,
            snippet: [c.description, c.downloads != null ? `${c.downloads} 下载` : ''].filter(Boolean).join(' · ') || undefined,
          })),
        }
      },
    },
    dockerhub: {
      label: 'Docker Hub（容器镜像）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(query)}&page_size=${Math.min(max, 25)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.results) || []
        if (hits.length === 0) throw new Error('Docker Hub 无结果')
        return {
          sources: hits.slice(0, max).map((r) => ({
            url: r.repo_name && r.repo_name.includes('/') ? `https://hub.docker.com/r/${r.repo_name}` : `https://hub.docker.com/_/${r.repo_name}`,
            title: `${r.repo_name || '?'}${r.is_official ? ' [official]' : ''}${r.star_count != null ? ` ★${r.star_count}` : ''}`,
            snippet: r.short_description || undefined,
          })),
        }
      },
    },
    mdn: {
      label: 'MDN（Web 开发文档）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const docs = (res.data && res.data.documents) || []
        if (docs.length === 0) throw new Error('MDN 无结果')
        return {
          sources: docs.slice(0, max).map((d) => ({
            url: `https://developer.mozilla.org${d.mdn_url}`,
            title: d.title || 'Untitled',
            snippet: d.summary || undefined,
          })),
        }
      },
    },
    zhidao: {
      label: '百度知道（中文问答）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://zhidao.baidu.com/search?word=${encodeURIComponent(query)}`
        let res = await httpGet(url, opts)
        // 百度知道连续快速请求偶发 5xx 限流：退避 1.5s 重试一次
        if ((!res.ok || res.error) && res.statusCode >= 500) {
          await new Promise((r) => setTimeout(r, 1500))
          res = await httpGet(url, opts)
        }
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        if (/antispider/i.test(res.content)) throw new Error('百度知道触发反爬')
        const sources = parseZhidaoHtml(res.content).slice(0, max)
        if (sources.length === 0) throw new Error('百度知道无结果')
        return { sources }
      },
    },
    wikidata: {
      label: 'Wikidata（结构化实体）',
      vertical: true,
      async run(query, max, opts) {
        const lang = /[\u4e00-\u9fff]/.test(query) ? 'zh' : 'en'
        const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${lang}&format=json&limit=${Math.min(max, 50)}`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const hits = (res.data && res.data.search) || []
        if (hits.length === 0) throw new Error('Wikidata 无结果')
        return {
          sources: hits.slice(0, max).map((h) => ({
            url: h.concepturi || `https://www.wikidata.org/wiki/${h.id}`,
            title: `${h.label || h.id} (${h.id})`,
            snippet: h.description || undefined,
          })),
        }
      },
    },
    archive: {
      label: 'Internet Archive（档案资料）',
      vertical: true,
      async run(query, max, opts) {
        const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&rows=${Math.min(max, 25)}&output=json`
        const res = await httpGetJson(url, {}, opts)
        if (!res.ok || res.error) throw new Error(res.error || `HTTP ${res.statusCode}`)
        const docs = (res.data && res.data.response && res.data.response.docs) || []
        if (docs.length === 0) throw new Error('Internet Archive 无结果')
        return {
          sources: docs.slice(0, max).map((d) => ({
            url: `https://archive.org/details/${d.identifier}`,
            title: d.title || d.identifier,
            snippet: Array.isArray(d.description) ? d.description[0] : d.description || undefined,
          })),
        }
      },
    },
  }

  // ── 聚合引擎（并行多引擎 + RRF 融合去重；闭包引用上方引擎表）───────────────
  // 支持复合语法：engine="aggregate:a,b,c" 时聚合指定引擎子集（runSearch 解析
  // 后经 opts.aggregateList 传入）；默认聚合启用的免费通用引擎。
  engines.aggregate = {
    label: '聚合搜索（并行多引擎 + RRF 融合去重）',
    vertical: true,
    async run(query, max, opts) {
      const s = resolvedSettings()
      const requested = Array.isArray(opts.aggregateList) ? opts.aggregateList.filter((id) => engines[id] && id !== 'aggregate') : []
      const candidates = (requested.length > 0
        ? requested
        : ['bing', 'ddg-html', 'brave', 'baidu', 'so360']
      ).filter((id) => engines[id] && engineEnabled(id, s))
      if (candidates.length < 1) throw new Error('聚合搜索无可用引擎（子引擎被禁用或无效）')
      // 每个子引擎多取一些结果给融合排序留量；API-key 子引擎补 apiKey
      const per = Math.min(Math.max(max * 2, 10), 20)
      const results = await Promise.allSettled(
        candidates.map((id) => {
          const subOpts = engines[id].needsKey ? { ...opts, apiKey: apiKeyFor(id, s) } : opts
          return engines[id].run(query, per, subOpts)
        })
      )
      const K = 60 // Reciprocal Rank Fusion 常数
      const seen = new Map()
      const errors = []
      let okCount = 0
      results.forEach((r, i) => {
        const id = candidates[i]
        if (r.status !== 'fulfilled' || !r.value || !Array.isArray(r.value.sources)) {
          errors.push(`${id}: ${r.status === 'rejected' ? String((r.reason && r.reason.message) || r.reason) : '无结果'}`)
          return
        }
        okCount++
        r.value.sources.forEach((src, rank) => {
          if (!src || !src.url) return
          const key = normalizeUrl(src.url)
          const prev = seen.get(key)
          if (prev) {
            prev.score += 1 / (K + rank + 1)
            prev.from.push(id)
            if (!prev.entry.title && src.title) prev.entry.title = src.title
            if (!prev.entry.snippet && src.snippet) prev.entry.snippet = src.snippet
          } else {
            seen.set(key, { entry: { url: src.url, title: src.title, snippet: src.snippet }, score: 1 / (K + rank + 1), from: [id] })
          }
        })
      })
      if (okCount === 0) throw new Error(`聚合搜索全部失败：${errors.join('；')}`)
      const merged = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, max)
      return {
        sources: merged.map((e) => ({
          url: e.entry.url,
          title: e.entry.title,
          snippet: [e.from.length > 1 ? `[${e.from.length} 引擎命中]` : '', e.entry.snippet].filter(Boolean).join(' '),
        })),
      }
    },
  }

  return engines
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
    enableArxiv: s.enableArxiv !== false,
    enableGithub: s.enableGithub !== false,
    enableStackexchange: s.enableStackexchange !== false,
    enableHn: s.enableHn !== false,
    enableNews: s.enableNews !== false,
    enableMarginalia: s.enableMarginalia !== false,
    enableBilibili: s.enableBilibili !== false,
    enableWechat: s.enableWechat !== false,
    enableOpenalex: s.enableOpenalex !== false,
    enableCrossref: s.enableCrossref !== false,
    enableNpm: s.enableNpm !== false,
    enableCsdn: s.enableCsdn !== false,
    enableYoutube: s.enableYoutube !== false,
    enableImages: s.enableImages !== false,
    enableAggregate: s.enableAggregate !== false,
    enablePubmed: s.enablePubmed !== false,
    enableBooks: s.enableBooks !== false,
    enableItunes: s.enableItunes !== false,
    enableMaps: s.enableMaps !== false,
    enableDblp: s.enableDblp !== false,
    enableEuropepmc: s.enableEuropepmc !== false,
    enableCrates: s.enableCrates !== false,
    enableDockerhub: s.enableDockerhub !== false,
    enableMdn: s.enableMdn !== false,
    enableZhidao: s.enableZhidao !== false,
    enableWikidata: s.enableWikidata !== false,
    enableArchive: s.enableArchive !== false,
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
  // 垂直渠道引擎
  if (id === 'arxiv') return s.enableArxiv
  if (id === 'github') return s.enableGithub
  if (id === 'stackexchange') return s.enableStackexchange
  if (id === 'hn') return s.enableHn
  if (id === 'news') return s.enableNews
  if (id === 'marginalia') return s.enableMarginalia
  if (id === 'bilibili') return s.enableBilibili
  if (id === 'wechat') return s.enableWechat
  if (id === 'openalex') return s.enableOpenalex
  if (id === 'crossref') return s.enableCrossref
  if (id === 'npm') return s.enableNpm
  if (id === 'csdn') return s.enableCsdn
  if (id === 'youtube') return s.enableYoutube
  if (id === 'images') return s.enableImages
  if (id === 'aggregate') return s.enableAggregate
  if (id === 'pubmed') return s.enablePubmed
  if (id === 'books') return s.enableBooks
  if (id === 'itunes') return s.enableItunes
  if (id === 'maps') return s.enableMaps
  if (id === 'dblp') return s.enableDblp
  if (id === 'europepmc') return s.enableEuropepmc
  if (id === 'crates') return s.enableCrates
  if (id === 'dockerhub') return s.enableDockerhub
  if (id === 'mdn') return s.enableMdn
  if (id === 'zhidao') return s.enableZhidao
  if (id === 'wikidata') return s.enableWikidata
  if (id === 'archive') return s.enableArchive
  // API 型引擎：有 key 即启用
  if (['serper', 'tavily', 'brave-api', 'exa'].includes(id)) return Boolean(apiKeyFor(id, s))
  return false
}

// ── 搜索执行 ────────────────────────────────────────────────────────────────

/**
 * 执行一次搜索。engine 为 'auto' 时按语言感知链在已启用引擎间回退。
 * engine 支持复合聚合语法 "aggregate:<id1>,<id2>,..."（聚合指定引擎子集）。
 * freshness（day/week/month/year）由支持时效过滤的引擎原生翻译（其余忽略）。
 * @returns {Promise<{content?: string, sources: Array, truncated: boolean, engine: string, attempts: Array}>}
 */
async function runSearch(query, engineArg, maxResultsArg, signal, freshness) {
  const s = resolvedSettings()
  if (!s.enabled) {
    return { sources: [], truncated: false, engine: 'none', attempts: [], error: '网页搜索已在设置中禁用（设置→插件→网页搜索）' }
  }
  const engines = makeEngines(s)
  const max = clampInt(maxResultsArg ?? s.maxResults, s.maxResults, 1, 50)
  const opts = { timeoutMs: s.timeoutMs, userAgent: s.userAgent, signal, freshness: FRESHNESS_MS[freshness] ? freshness : undefined }

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

  // 复合聚合语法："aggregate:arxiv,openalex,crossref" → 引擎 aggregate + 子集列表
  let aggregateList
  if (typeof engineArg === 'string' && engineArg.startsWith('aggregate:')) {
    const subs = engineArg
      .slice('aggregate:'.length)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 6)
    const bad = subs.filter((x) => !engines[x] || x === 'aggregate' || x === 'auto')
    if (subs.length === 0 || bad.length > 0) {
      return {
        sources: [],
        truncated: false,
        engine: engineArg,
        attempts: [],
        error: `聚合子引擎无效：${bad.join(', ') || '(空)'}。语法 aggregate:<id1>,<id2>（可用引擎：${ALL_ENGINES.join(', ')}）`,
      }
    }
    aggregateList = subs
    engineArg = 'aggregate'
    opts.aggregateList = aggregateList
  }

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
          enableWikipedia: Schema.boolean().default(true).description('启用 Wikipedia API（语言感知：中文查询→zh.wikipedia；部分地区网络不可达）'),
          enableArxiv: Schema.boolean().default(true).description('启用 arXiv 学术论文 API（垂直渠道，显式指定 engine=arxiv）'),
          enableGithub: Schema.boolean().default(true).description('启用 GitHub 仓库搜索 API（垂直渠道，engine=github；未认证限 10 次/分钟）'),
          enableStackexchange: Schema.boolean().default(true).description('启用 Stack Overflow 编程问答 API（垂直渠道，engine=stackexchange）'),
          enableHn: Schema.boolean().default(true).description('启用 Hacker News 搜索（Algolia API，垂直渠道，engine=hn）'),
          enableNews: Schema.boolean().default(true).description('启用新闻搜索（Bing News RSS → Google News RSS 兜底，垂直渠道，engine=news）'),
          enableMarginalia: Schema.boolean().default(true).description('启用 Marginalia 独立小众索引 API（垂直渠道，engine=marginalia）'),
          enableBilibili: Schema.boolean().default(true).description('启用哔哩哔哩视频搜索 API（垂直渠道，engine=bilibili）'),
          enableWechat: Schema.boolean().default(true).description('启用微信公众号文章搜索（搜狗微信抓取，垂直渠道，engine=wechat）'),
          enableOpenalex: Schema.boolean().default(true).description('启用 OpenAlex 学术全景索引 API（垂直渠道，engine=openalex，2.5 亿学术作品）'),
          enableCrossref: Schema.boolean().default(true).description('启用 Crossref DOI/学术元数据 API（垂直渠道，engine=crossref）'),
          enableNpm: Schema.boolean().default(true).description('启用 npm 包搜索 API（垂直渠道，engine=npm）'),
          enableCsdn: Schema.boolean().default(true).description('启用 CSDN 中文技术博客搜索（垂直渠道，engine=csdn）'),
          enableYoutube: Schema.boolean().default(true).description('启用 YouTube 视频搜索（垂直渠道，engine=youtube；部分地区需代理）'),
          enableImages: Schema.boolean().default(true).description('启用 Bing 图片搜索（垂直渠道，engine=images，返回图片直链）'),
          enableAggregate: Schema.boolean().default(true).description('启用聚合搜索（engine=aggregate：并行多引擎 + RRF 融合去重，查全率最高但请求多；支持复合语法 aggregate:引擎1,引擎2 聚合任意子集）'),
          enablePubmed: Schema.boolean().default(true).description('启用 PubMed 生物医学文献搜索（垂直渠道，engine=pubmed）'),
          enableBooks: Schema.boolean().default(true).description('启用 Open Library 图书搜索（垂直渠道，engine=books）'),
          enableItunes: Schema.boolean().default(true).description('启用 iTunes 媒体搜索（垂直渠道，engine=itunes；音乐/电影/播客/应用）'),
          enableMaps: Schema.boolean().default(true).description('启用 OpenStreetMap 地点搜索（垂直渠道，engine=maps；返回坐标与 OSM 链接）'),
          enableDblp: Schema.boolean().default(true).description('启用 dblp 计算机科学文献库（垂直渠道，engine=dblp）'),
          enableEuropepmc: Schema.boolean().default(true).description('启用 Europe PMC 生物医学+预印本（垂直渠道，engine=europepmc）'),
          enableCrates: Schema.boolean().default(true).description('启用 crates.io Rust 包搜索（垂直渠道，engine=crates）'),
          enableDockerhub: Schema.boolean().default(true).description('启用 Docker Hub 镜像搜索（垂直渠道，engine=dockerhub）'),
          enableMdn: Schema.boolean().default(true).description('启用 MDN Web 开发文档搜索（垂直渠道，engine=mdn）'),
          enableZhidao: Schema.boolean().default(true).description('启用百度知道中文问答搜索（垂直渠道，engine=zhidao）'),
          enableWikidata: Schema.boolean().default(true).description('启用 Wikidata 结构化实体搜索（垂直渠道，engine=wikidata；语言感知）'),
          enableArchive: Schema.boolean().default(true).description('启用 Internet Archive 档案资料搜索（垂直渠道，engine=archive）'),
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
            '多渠道网页搜索（38 引擎，8 大类，按类选用）。【通用网页】auto（默认，语言感知回退链：中文 Bing→百度→360→DDG，英文 DDG HTML→Bing→Brave；key 引擎优先）/ ddg-html / bing / baidu / so360 / brave / ddg-api（事实快答）/ wikipedia（语言感知）/ marginalia / serper·tavily·brave-api·exa（API-key 型）。【聚合】aggregate（并行多引擎 + RRF 融合去重；复合语法 aggregate:引擎1,引擎2 聚合任意子集，如 aggregate:arxiv,openalex,crossref）。【学术文献】arxiv / openalex / crossref / pubmed / europepmc / dblp。【开发者】github / npm / crates（Rust）/ dockerhub / stackexchange / mdn / csdn。【新闻与社区】news（Bing/Google News RSS）/ hn。【媒体娱乐】youtube / bilibili / images（图片直链）/ itunes。【中文内容】wechat（微信公众号）/ zhidao（百度知道）。【资料参考】wikidata / books / archive / maps。freshness 可选 day/week/month/year 时效过滤（ddg-html/brave/baidu/news/aggregate 原生支持，其余忽略）。返回 sources（url/title/snippet）。当内置 web_search 结果不足、需要特定渠道或事实快答时优先使用本工具。配置见 设置→插件→网页搜索。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['query'],
            properties: {
              query: { type: 'string', description: '搜索关键词。' },
              engine: { type: 'string', description: '搜索引擎/渠道（默认 auto；支持复合聚合语法 aggregate:<id1>,<id2>；38 引擎分 8 类，详见工具描述）' },
              maxResults: { type: 'integer', description: '返回条数上限（1-50，默认取设置值）。' },
              freshness: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时效过滤：仅返回该时间窗口内的结果（ddg-html/brave/baidu/news/aggregate 原生支持，其他引擎忽略）。' },
            },
          },
          output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderSearchOutput(value) }] },
          timeoutMs: 90000,
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const query = String(args.query || '').trim()
            if (!query) return { sources: [], truncated: false, engine: 'none', error: 'query is required' }
            return await runSearch(query, args.engine, args.maxResults, exec && exec.signal, args.freshness)
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
            '- web_search_multi: multi-channel web search (38 engines in 8 categories). [General web] engine="auto" (default; language-aware fallback chain: Chinese queries Bing→Baidu→So360→DDG, others DDG HTML→Bing→Brave; API-key engines first when configured), plus explicit "ddg-api"/"ddg-html"/"bing"/"baidu"/"so360"/"brave"/"wikipedia" (language-aware)/"marginalia", and API-key engines "serper"/"tavily"/"brave-api"/"exa". [Aggregate] "aggregate" runs engines in PARALLEL with Reciprocal Rank Fusion dedup; composite syntax "aggregate:<id1>,<id2>" aggregates ANY subset (e.g. aggregate:arxiv,openalex,crossref). [Academic] "arxiv"/"openalex"/"crossref"/"pubmed"/"europepmc"/"dblp". [Developer] "github"/"npm"/"crates" (Rust)/"dockerhub"/"stackexchange"/"mdn"/"csdn". [News & community] "news" (news RSS)/"hn". [Media] "youtube"/"bilibili"/"images" (direct image URLs)/"itunes". [Chinese content] "wechat" (WeChat articles)/"zhidao" (Baidu Q&A). [Reference] "wikidata"/"books" (Open Library)/"archive" (Internet Archive)/"maps" (OSM places).',
            'Optional freshness="day"/"week"/"month"/"year" filters recency (supported natively by ddg-html/brave/baidu/news/aggregate; others ignore it).',
            'Pick engines by task: broad recall → aggregate; papers → arxiv/openalex/crossref/dblp (biomedical → pubmed/europepmc; or aggregate:arxiv,openalex,crossref); code & packages → github/npm/crates/dockerhub; web-dev docs → mdn; programming errors → stackexchange (csdn for Chinese); tech discussion → hn; current events → news (+freshness); images → images; music/movies → itunes; books → books; places → maps; entities/facts → wikidata/ddg-api; Chinese Q&A/articles → zhidao/wechat; Chinese videos → bilibili; archived material → archive.',
            '- web_fetch_url: fetch any public URL and return text (HTML converted to markdown).',
            'Use web_search_multi when the built-in web_search returns insufficient results, when a specific engine/channel is needed, or for quick fact lookups; use web_fetch_url to read a source page after searching. Results carry url/title/snippet — cite URLs as markdown links.',
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
              // 按分类组织的引擎清单（含启用状态）
              const enginesByCategory = {}
              for (const id of Object.keys(ENGINE_CATEGORY)) {
                const cat = ENGINE_CATEGORY[id]
                if (!enginesByCategory[cat]) enginesByCategory[cat] = { label: CATEGORY_LABELS[cat] || cat, engines: [] }
                enginesByCategory[cat].engines.push({ id, enabled: engineEnabled(id, s) })
              }
              const body = JSON.stringify(
                {
                  ok: true,
                  engineCount: Object.keys(ENGINE_CATEGORY).length,
                  categories: enginesByCategory,
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
