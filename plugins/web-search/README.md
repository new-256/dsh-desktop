# web-search — DSH 网页搜索增强插件（30 引擎/渠道）

DSH（DeepSeek Harness）家级（host 层）插件：为**所有预设的新会话**注册多引擎网页搜索与 URL 抓取工具，并提供 设置→插件 页配置卡片。零依赖（单文件 ESM，host realm 全 Node 权限）。

## 引擎清单

### 免费抓取型（浏览器模拟）
| id | 引擎 | 说明 |
|---|---|---|
| `ddg-html` | DuckDuckGo HTML | `html.duckduckgo.com/html` 抓取，通用搜索 |
| `bing` | Bing | `www.bing.com` 抓取；重定向 URL（`/ck/a` + `u=a1<base64>`）解码为真实 URL |
| `baidu` | 百度 | `www.baidu.com/s` 抓取；容器 `mu` 属性直取真实 URL，中文覆盖最好 |
| `so360` | 360 搜索 | `www.so.com` 抓取；`data-mdurl` 属性直取真实 URL |
| `brave` | Brave | `search.brave.com` 抓取（仅 `data-type="web"` 结果），独立索引 |

### 免费开放 API 型
| id | 引擎 | 说明 |
|---|---|---|
| `ddg-api` | DuckDuckGo IA | Instant Answer API，事实/实体类快答（覆盖面窄，按设计如此） |
| `wikipedia` | Wikipedia | MediaWiki `list=search` API，**语言感知**（中文查询→zh.wikipedia，其他→en） |

### API-key 型（可选，设置页配 key 后启用）
| id | 服务 | 获取 key | 免费额度* |
|---|---|---|---|
| `serper` | Serper.dev | https://serper.dev/signup | 注册送约 2500 次 |
| `tavily` | Tavily | https://app.tavily.com | 约 1000 次/月 |
| `brave-api` | Brave Search API | https://brave.com/search/api/ | 约 2000 次/月 |
| `exa` | Exa | https://dashboard.exa.ai | 注册送约 $10 |

\* 免费额度以各官网当前政策为准。设置页每个 key 输入框旁有「获取 key ↗」直达链接。

key 仅存本机 `settings.yaml` 的 `web-search:` 节；`/web-search/health` 诊断端点对 key 打码。

### 垂直渠道与聚合（不参与 auto 链，需显式指定 `engine=<id>`）
| id | 渠道 | 方式 | 说明 |
|---|---|---|---|
| `aggregate` | **聚合搜索** | 并行 + RRF | 并行跑启用的免费通用引擎，Reciprocal Rank Fusion 融合去重排序，查全率最高（请求也最多） |
| `arxiv` | arXiv | Atom API | 学术论文（标题/摘要/日期） |
| `openalex` | OpenAlex | REST API | 学术全景索引（2.5 亿作品；DOI/年份/被引/期刊） |
| `crossref` | Crossref | REST API | DOI 与学术元数据（期刊/年份；polite pool UA） |
| `github` | GitHub | REST API | 代码仓库（星数/语言/描述；未认证限 10 次/分钟） |
| `npm` | npm Registry | REST API | Node 包搜索（版本/描述） |
| `stackexchange` | Stack Overflow | REST API | 编程问答（score/回答数/标签） |
| `csdn` | CSDN | REST API | 中文技术博客搜索 |
| `hn` | Hacker News | Algolia API | 科技社区讨论（分数/评论数） |
| `news` | 新闻 | **RSS** | Bing News RSS（真实 URL 解码）→ Google News RSS 兜底 |
| `youtube` | YouTube | 页面内嵌 JSON | `ytInitialData` 花括号配对提取（标题/频道/时长/播放量） |
| `bilibili` | 哔哩哔哩 | REST API | 视频搜索（UP主/简介） |
| `images` | Bing Images | 抓取 | 图片搜索（`iusc` 卡片 `m` 属性解码，返回**图片直链** + 来源页） |
| `maps` | OpenStreetMap | Nominatim API | 地点/地理编码搜索（坐标 + OSM 链接；语言感知） |
| `itunes` | iTunes Store | Search API | 音乐/电影/播客/应用（种类中文化标注） |
| `books` | Open Library | Search API | 图书（书名/作者/初版年份） |
| `pubmed` | PubMed | eutils API | 生物医学文献（两步：esearch→esummary，期刊/日期/作者） |
| `wechat` | 微信公众号 | 搜狗微信抓取 | 公众号文章（链接为 sogou 重定向，有时效） |
| `marginalia` | Marginalia | 公共 API | 独立小众索引，发掘非主流页面（内部保底 30s 超时） |

**复合聚合语法**：`engine="aggregate:<id1>,<id2>,..."` 聚合任意引擎子集（≤6 个），如 `aggregate:arxiv,openalex,crossref` 学术三件套并行搜索、`aggregate:bing,brave,ddg-html` 通用三路融合。

**时效过滤**：`freshness` 参数（`day`/`week`/`month`/`year`）由支持时效的引擎原生翻译——ddg-html（`df=`）、brave（`tf=`）、百度（`gpc=stf=`）、news（Google News `when:`）、aggregate（透传给子引擎）；其余引擎忽略。

## auto 引擎链（语言感知）

- **API 引擎优先**：配置了 key 且未关 `apiInAuto` 时，`serper → tavily → brave-api → exa` 排最前（消耗 API 配额，可在设置页关闭）
- **中文查询**（含 CJK）：`bing → baidu → so360 → ddg-html → ddg-api → wikipedia`
- **其他查询**：`ddg-html → bing → brave → ddg-api → wikipedia`
- **垂直渠道与 aggregate 不参与 auto**：按任务显式选——查全率→`aggregate`（并行+RRF 融合）、论文→`arxiv`/`openalex`/`crossref`、代码→`github`/`npm`、报错→`stackexchange`/`csdn`、时事→`news`、图片→`images`、中文内容→`wechat`/`bilibili`
- 显式指定 `defaultEngine` 时该引擎最先试；链上失败自动回退，总时间预算 60s
- 各引擎可在设置页独立禁用；`site:`/`filetype:` 等查询操作符由各引擎原生支持

## 注册的模型工具

- **`web_search_multi`**：多引擎搜索。参数 `query`（必填）、`engine`（默认 auto）、`maxResults`（1-50）。返回 `{sources: [{url,title,snippet}], engine, attempts, error?}`，渲染为 markdown 链接列表。
- **`web_fetch_url`**：抓取任意公开 URL。经官方 `@deepseek-ai/dsh-web-fetch-http` provider（SSRF 防护/同源重定向/字节上限），HTML 自动转 markdown（turndown + gfm，从 harness 安装解析）。参数 `url`（必填）、`maxChars`（默认 20000）。

另将 30 个引擎注册为 `ctx.web` search provider（host 的 `web` 行仍钉 `searchProvider: deepseek-official`，产品自带 `web_search` 不受影响；想切换时在家级 patch 覆写 `web` 行 config 即可）。

## 设置页

**设置 → 插件 → 网页搜索**（client 半边，`settings.plugin.item` 键控槽位）：

- 总开关 / 7 个免费引擎 + 19 个垂直渠道与聚合独立开关 / API key（4 个，密码框）/ `apiInAuto` 开关
- 默认引擎 / 返回条数 / 单引擎超时 / User-Agent
- **测试引擎**按钮（调 `/web-search/test` 实测连通性）
- 字段级「已覆盖默认值」标记；保存 = `scope.mutate`（原子，带 revision 乐观锁）→ 写 `settings.yaml` 热生效

## 安装（本仓库布局）

```
plugins/web-search/
├── package.json        # name: web-search-panel；dsh.client 声明；main = no-op 占位
├── lib/index.mjs       # host 半边（file:// 行加载）
├── lib/client.js       # client 半边（设置卡片，浏览器花名册加载）
└── lib/client-entry.mjs# 包 main 占位（防 host 半边双实例）
```

家级 `cordis.patch.yml` 添加三行（junction `dsh-home/node_modules/web-search-panel` → 本目录）：

```yaml
- insert:
    - id: web-search
      name: file:///C:/Users/<you>/Desktop/DSH/plugins/web-search/lib/index.mjs?v=1
      config:
        maxResults: 10
        timeoutMs: 20000
    - id: web-search-client
      name: web-search-panel
    - id: web-fetch-http
      name: '@deepseek-ai/dsh-web-fetch-http'
```

新增行需重启 DSH；之后改 `lib/index.mjs` bump `?v=N` 热加载，改 `lib/client.js` 刷新浏览器即生效。

## 诊断

- `GET /web-search/health` — 设置（key 打码）、schema/turndown 加载状态、各引擎调用统计与最近错误
- `GET /web-search/test?q=...&engine=...` — 实测单个引擎
- 浏览器控制台 `window.__webSearchPanel` — client 半边诊断（注册/渲染计数）

## 设计说明

- **host realm 全 Node 权限**：本插件经家级 patch 的 `file://` 行加载（非动态沙箱插件），与官方 `dsh-web-search-deepseek` 同权——抓取引擎用全局 `fetch`；`schemastery`（设置 schema）与 `turndown`（HTML→markdown）经 `createRequire(process.argv[1])` 从 harness 安装解析，升级换目录依然有效
- **DDG IA 的 202**：该 API 正常时也可能回 HTTP 202（Accepted），必须接受一切 2xx
- **双面包结构**：裸包名行（client）与 `file://` 行（host）分别加载包的两个入口，包 `main` 是 no-op 防止 host 半边被加载两次（settings namespace 重名会直接失败）
- **工具参数用完整 JSON Schema**（非沙箱 `defineTool` DSL）
- 搜狗（antispider 拦截）、Ecosia（403）、Startpage/SearXNG 公共实例（Anubis 验证/JSON 禁用）、Mojeek（静默空结果）经实测不可用，未收录
