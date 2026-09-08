# web-search — DSH 网页搜索增强插件（39 引擎 · 8 大类 · auto 智能路由）

DSH（DeepSeek Harness）家级（host 层）插件：为**所有预设的新会话**注册多引擎网页搜索与 URL 抓取工具，并提供 设置→插件 页配置卡片。零依赖（单文件 ESM，host realm 全 Node 权限）。

## auto 智能路由（默认开启）

`engine=auto`（默认）时由 **DSH 分析查询特性**（语言/领域/意图/时效）自动选择合适引擎或多引擎**并行同步搜索 + RRF 融合**，模型无需手动选引擎：

| 查询特性（自动识别） | 路由 | 模式 |
|---|---|---|
| 生物医学（疾病/基因/药物/临床…） | `pubmed + europepmc` | 并行融合 |
| 计算机科学（算法/神经网络/LLM…） | `arxiv + dblp + openalex` | 并行融合 |
| 学术（论文/文献/研究…） | `openalex + crossref + arxiv` | 并行融合 |
| 报错/异常（error/traceback/报错…） | 中文 `csdn+stackexchange`；英文 `stackexchange+github` | 并行融合 |
| Web 前端（css/html/dom…） | `mdn + stackexchange` | 并行融合 |
| 包管理（npm/cargo/docker…） | `github + npm + dockerhub` | 并行融合 |
| 代码/实现（框架/语言名…） | 中文 `csdn+github+stackexchange`；英文 `github+stackexchange` | 并行融合 |
| 新闻（新闻/快讯/最新消息…） | `news`（自动推断时效：今天→day、最近→month…） | 单引擎 |
| 图片（图片/壁纸/image…） | `images` | 单引擎 |
| 视频（视频/教程/movie…） | 中文 `bilibili+youtube`；英文 `youtube` | 并行融合 |
| 地点（在哪/地图/路线…） | `maps` | 单引擎 |
| 公众号（公众号/微信文章…） | `wechat` | 单引擎 |
| 中文问答（什么是/为什么/怎么…） | `zhidao` | 单引擎 |
| 实体快查（短词无修饰） | `ddg-api + wikidata + wikipedia` | 并行融合 |
| 对比评测（对比/哪个好/best/vs…） | `aggregate`（免费通用引擎并行） | 聚合 |
| 通用查询 | 语言感知回退链（中文 Bing→百度→360→DDG；英文 DDG→Bing→Brave；key 引擎优先） | 串行链 |

- 路由引擎被禁用或无结果时**自动回退传统链**，永不空手而归
- 返回的 `engine` 字段显示实际路由（如 `smart(academic):arxiv+openalex+crossref`），多引擎交叉命中标注 `[N 引擎命中]`
- 设置页可关闭智能路由（`smartRouting` 开关）回退传统链；`defaultEngine` 显式指定非 auto 时智能路由让位

## 引擎清单（按类）

### 【通用网页】通用搜索与百科（auto 链来源）
| id | 引擎 | 方式 | 说明 |
|---|---|---|---|
| `ddg-html` | DuckDuckGo HTML | 抓取 | 通用搜索 |
| `bing` | Bing | 抓取 | 大陆可达；重定向 URL（`u=a1<base64>`）解码 |
| `baidu` | 百度 | 抓取 | 容器 `mu` 属性直取真实 URL，中文覆盖最好 |
| `so360` | 360 搜索 | 抓取 | `data-mdurl` 直取真实 URL |
| `brave` | Brave | 抓取 | 仅 `data-type="web"` 结果，独立索引 |
| `ddg-api` | DuckDuckGo IA | 开放 API | Instant Answer 事实快答（覆盖面窄，按设计如此） |
| `wikipedia` | Wikipedia | 开放 API | **语言感知**（中文查询→zh.wikipedia） |
| `marginalia` | Marginalia | 公共 API | 独立小众索引（内部保底 30s 超时；不参与 auto） |
| `anysearch` | AnySearch | 开放 API（匿名） | AI 搜索基础设施（api.anysearch.com，[官网](https://www.anysearch.com)）——匿名可用（限速低）；配置 key 后提额并进入 auto 优先链；深度网页覆盖（Reddit/仓库/垂直域），也支持 `aggregate:anysearch,...` 复合 |

### 【通用网页 · API-key 型】（可选，设置页配 key 后启用）
| id | 服务 | 获取 key | 免费额度* |
|---|---|---|---|
| `serper` | Serper.dev | https://serper.dev/signup | 注册送约 2500 次 |
| `tavily` | Tavily | https://app.tavily.com | 约 1000 次/月 |
| `brave-api` | Brave Search API | https://brave.com/search/api/ | 约 2000 次/月 |
| `exa` | Exa | https://dashboard.exa.ai | 注册送约 $10 |

\* 免费额度以各官网当前政策为准。设置页每个 key 输入框旁有「获取 key ↗」直达链接。key 仅存本机 `settings.yaml`；`/web-search/health` 对 key 打码。

### 【聚合】
| id | 说明 |
|---|---|
| `aggregate` | 并行多引擎 + Reciprocal Rank Fusion 融合去重排序，查全率最高（请求也最多）。**复合语法** `engine="aggregate:<id1>,<id2>,..."`（≤6 个）聚合任意子集，如 `aggregate:arxiv,openalex,crossref` 学术三件套、`aggregate:bing,brave,ddg-html` 通用三路；API-key 子引擎自动补 key |

### 【学术文献】
| id | 渠道 | 方式 | 说明 |
|---|---|---|---|
| `arxiv` | arXiv | Atom API | 预印本（标题/摘要/日期） |
| `openalex` | OpenAlex | REST API | 学术全景（2.5 亿作品；DOI/年份/被引/期刊） |
| `crossref` | Crossref | REST API | DOI 与学术元数据（polite pool UA） |
| `pubmed` | PubMed | eutils API | 生物医学文献（esearch→esummary 两步） |
| `europepmc` | Europe PMC | REST API | 生物医学 + 预印本（期刊/年份） |
| `dblp` | dblp | REST API | 计算机科学文献库（会议/期刊/作者/年份） |

### 【开发者】
| id | 渠道 | 方式 | 说明 |
|---|---|---|---|
| `github` | GitHub | REST API | 代码仓库（星数/语言；未认证限 10 次/分钟） |
| `npm` | npm Registry | REST API | Node 包（版本/描述） |
| `crates` | crates.io | REST API | Rust 包（版本/下载量） |
| `dockerhub` | Docker Hub | REST API | 容器镜像（星数/官方标记） |
| `stackexchange` | Stack Overflow | REST API | 编程问答（score/回答数/标签） |
| `mdn` | MDN | 官方 API | Web 开发文档 |
| `csdn` | CSDN | REST API | 中文技术博客 |

### 【新闻与社区】
| id | 渠道 | 方式 | 说明 |
|---|---|---|---|
| `news` | 新闻 | **RSS** | Bing News RSS（真实 URL 解码）→ Google News RSS 兜底（支持 `when:` 时效） |
| `hn` | Hacker News | Algolia API | 科技社区讨论（分数/评论数） |

### 【媒体娱乐】
| id | 渠道 | 方式 | 说明 |
|---|---|---|---|
| `youtube` | YouTube | 页面内嵌 JSON | `ytInitialData` 花括号配对提取（标题/频道/时长/播放量） |
| `bilibili` | 哔哩哔哩 | REST API | 视频搜索（UP主/简介） |
| `images` | Bing Images | 抓取 | 图片搜索（`iusc` 卡片 `m` 属性解码，返回**图片直链** + 来源页） |
| `itunes` | iTunes Store | Search API | 音乐/电影/播客/应用（种类中文化标注） |

### 【中文内容】
| id | 渠道 | 方式 | 说明 |
|---|---|---|---|
| `wechat` | 微信公众号 | 搜狗微信抓取 | 公众号文章（链接为 sogou 重定向，有时效） |
| `zhidao` | 百度知道 | 抓取 | 中文问答（`data-log` 结果锚点 + 邻近 answer 摘要） |

### 【资料参考】
| id | 渠道 | 方式 | 说明 |
|---|---|---|---|
| `wikidata` | Wikidata | 开放 API | 结构化实体（**语言感知**；实体 ID/描述） |
| `books` | Open Library | Search API | 图书（书名/作者/初版年份） |
| `archive` | Internet Archive | 高级搜索 API | 档案资料（图书/音视频/软件存档） |
| `maps` | OpenStreetMap | Nominatim API | 地点/地理编码（坐标 + OSM 链接；语言感知；403/429 退避重试） |

**时效过滤**：`freshness` 参数（`day`/`week`/`month`/`year`）由支持时效的引擎原生翻译——ddg-html（`df=`）、brave（`tf=`）、百度（`gpc=stf=`）、news（Google News `when:`）、aggregate（透传给子引擎）；其余引擎忽略。

## auto 引擎链（语言感知）

- **API 引擎优先**：配置了 key 且未关 `apiInAuto` 时，`serper → tavily → brave-api → exa` 排最前（消耗 API 配额，可在设置页关闭）
- **中文查询**（含 CJK）：`bing → baidu → so360 → ddg-html → ddg-api → wikipedia`
- **其他查询**：`ddg-html → bing → brave → ddg-api → wikipedia`
- **垂直渠道与 aggregate 不参与 auto**：按任务显式选（选型指引见上方各类表格）
- 显式指定 `defaultEngine` 时该引擎最先试；链上失败自动回退，总时间预算 60s
- 各引擎可在设置页独立禁用；`site:`/`filetype:` 等查询操作符由各引擎原生支持

## 注册的模型工具

- **`web_search_multi`**：多引擎搜索。参数 `query`（必填）、`engine`（默认 auto）、`maxResults`（1-50）。返回 `{sources: [{url,title,snippet}], engine, attempts, error?}`，渲染为 markdown 链接列表。
- **`web_fetch_url`**：抓取任意公开 URL。经官方 `@deepseek-ai/dsh-web-fetch-http` provider（SSRF 防护/同源重定向/字节上限），HTML 自动转 markdown（turndown + gfm，从 harness 安装解析）。参数 `url`（必填）、`maxChars`（默认 20000）。

另将 39 个引擎注册为 `ctx.web` search provider（host 的 `web` 行仍钉 `searchProvider: deepseek-official`，产品自带 `web_search` 不受影响；想切换时在家级 patch 覆写 `web` 行 config 即可）。

## 设置页

**设置 → 插件 → 网页搜索**（client 半边，`settings.plugin.item` 键控槽位）：

- 总开关 / 8 个免费通用引擎 + 27 个垂直渠道与聚合（**按 7 类分组**）独立开关 / API key（4 个，密码框）/ `apiInAuto` 开关
- 默认引擎 / 返回条数 / 单引擎超时 / User-Agent
- **测试引擎**按钮（调 `/web-search/test` 实测连通性）
- 字段级「已覆盖默认值」标记；保存 = `scope.mutate`（原子，带 revision 乐观锁）→ 写 `settings.yaml` 热生效

## 安装

### 方式一：npm 安装（推荐，一条命令）

```sh
dsh plugin --profile web add web-search-panel
```

本包自带 `dsh.bundle.patch` 声明（profile bundle），`dsh plugin` 安装后**自动**加入 `dsh.profile.bundles` 层栈并组合行——无需手改任何 YAML。重启 web 档案（或 `patchReload: live` 自动生效）即可使用：

- 模型获得 `web_search_multi`（39 引擎智能路由搜索）与 `web_fetch_url`
- 设置→插件 出现「网页搜索」配置卡片（引擎开关 / API key / 智能路由开关）

前置条件：[pnpm](https://pnpm.io) 在 PATH 上（`dsh plugin` 经 pnpm 安装；`npm i -g pnpm` 或 corepack）。更新：`dsh plugin --profile web update web-search-panel`；卸载：`dsh plugin --profile web remove web-search-panel`。

本地路径/源码安装同理：`dsh plugin --profile web add <本目录绝对路径>`。

### 方式二：手动安装（无 pnpm 备选）

在档案目录安装包并手写行（`$DSH_HOME/profiles/web`）：

```sh
cd "$DSH_HOME/profiles/web" && npm install web-search-panel
```

档案 `cordis.patch.yml`（或家级 `$DSH_HOME/cordis.patch.yml`）添加：

```yaml
- insert:
    - id: web-search
      name: web-search-panel
      config:
        maxResults: 10
        timeoutMs: 20000
```

> 单行即可：包 `main` 即 host 半边，设置卡片由包的 `dsh.client` 声明自动装载。
> **勿加**第二行裸包名 client 行——同包双源会触发新版 client-modules 的
> `multiple active Loader sources` 致命冲突。

### 开发布局（本仓库）

```
plugins/web-search/
├── package.json        # name: web-search-panel；main = host；dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml    # bundle 自带组合补丁（安装时自动生效，单行）
├── lib/index.mjs       # host 半边（main / exports "." 与 "./host"）
└── lib/client.js       # client 半边（设置卡片，exports "./client"）
```

开发安装与用户安装同一条命令：`dsh plugin --profile web add <本目录绝对路径>`——pnpm 以 `link:` 依赖直连源码，改 `lib/index.mjs` 重启 DSH 生效，改 `lib/client.js` 刷新浏览器即生效；包内 `cordis.patch.yml` / `package.json` 变更同样重启生效。发布流程：同步至 [new-256/dsh-web-search](https://github.com/new-256/dsh-web-search) 后 `npm publish`。

## 诊断

- `GET /web-search/health` — 设置（key 打码）、schema/turndown 加载状态、各引擎调用统计与最近错误
- `GET /web-search/test?q=...&engine=...` — 实测单个引擎
- 浏览器控制台 `window.__webSearchPanel` — client 半边诊断（注册/渲染计数）

## 排障

### 升级 DSH 后插件“消失”（health 404、插件清单无 web-search）

DSH 升级流程（applyStaged）会重写 `profiles/web/package.json`，可能抹掉 `dsh.profile.bundles` 登记与 `web-search-panel` 依赖——插件不报错但完全不加载。症状：

- `GET /web-search/health` → 404
- 设置→插件 清单里只剩官方内置 `web-search-deepseek`，无 `web-search → web-search-panel`
- 插件管理器「用户插件」分类为空

**恢复（一条命令，与首次安装相同；npm 已发布，直接装 registry 版）：**

```bash
dsh plugin --profile web add web-search-panel
```

> 仅当需要改源码做开发时用本地路径：`dsh plugin --profile web add <插件源码绝对路径>`（pnpm 将以 `link:` 直连源码）。

验证 `profiles/web/package.json` 恢复两项后**重启 DSH**：

```json
"dependencies": { "web-search-panel": "^1.2.0" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "web-search-panel"] } }
```

重启后 `GET /web-search/health` 应返回 `engineCount: 39`。

### 插件随其它插件一起“消失”（profile 被隔离重建）

若**另一个**插件启动失败（如引用了新版 DSH 已移除的旧 API），桌面自愈会整份隔离 `profiles/web`（移入 `profiles.broken-<时间戳>/`）再重建——`web-search-panel` 会作为“连坐”被一并清出。这是整份清理的连带效应，**不是本插件自身的错误**。判断依据：

- 隔离前的日志里无任何 web-search 报错（报错行指向别的插件包）
- `profiles.broken-*/web/package.json` 里本插件与出问题的插件“同批被清”

恢复同样一条命令即可：`dsh plugin --profile web add web-search-panel`（见上）。本插件与其它插件互不依赖，单独重装即可。

## 设计说明

- **host realm 全 Node 权限**：本插件经标准包安装（bundle 层组合，与其他插件同通道），与官方 `dsh-web-search-deepseek` 同权——抓取引擎用全局 `fetch`；`schemastery`（设置 schema）与 `turndown`（HTML→markdown）经 `createRequire(process.argv[1])` 从 harness 安装解析，升级换目录依然有效
- **DDG IA 的 202**：该 API 正常时也可能回 HTTP 202（Accepted），必须接受一切 2xx
- **单行双面结构**：唯一行 `name: web-search-panel`（裸包名），`main` 即 host 半边；客户端 bundle 由包的 `dsh.client` 声明 + `exports "./client"` 经 client-modules 从同一行服务。⚠ 勿加第二条指向本包的行（如子路径 client 行）——同包双源会触发新版 client-modules 的 `multiple active Loader sources` 致命冲突
- **工具参数用完整 JSON Schema**（非沙箱 `defineTool` DSL）
- 搜狗（antispider 拦截）、Ecosia（403）、Startpage/SearXNG 公共实例（Anubis 验证/JSON 禁用）、Mojeek（静默空结果）经实测不可用，未收录
