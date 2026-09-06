# web-search — DSH 网页搜索增强插件（11 引擎）

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
| `wikipedia` | Wikipedia | MediaWiki `list=search` API，百科条目（部分地区网络不可达） |

### API-key 型（可选，设置页配 key 后启用）
| id | 服务 | 说明 |
|---|---|---|
| `serper` | [Serper.dev](https://serper.dev) | **Google 结果** API，质量最高 |
| `tavily` | [Tavily](https://tavily.com) | LLM 优化搜索 API |
| `brave-api` | [Brave Search API](https://brave.com/search/api/) | 官方 API（与抓取版独立） |
| `exa` | [Exa](https://exa.ai) | 神经/语义搜索 API |

key 仅存本机 `settings.yaml` 的 `web-search:` 节；`/web-search/health` 诊断端点对 key 打码。

## auto 引擎链（语言感知）

- **API 引擎优先**：配置了 key 且未关 `apiInAuto` 时，`serper → tavily → brave-api → exa` 排最前（消耗 API 配额，可在设置页关闭）
- **中文查询**（含 CJK）：`bing → baidu → so360 → ddg-html → ddg-api → wikipedia`
- **其他查询**：`ddg-html → bing → brave → ddg-api → wikipedia`
- 显式指定 `defaultEngine` 时该引擎最先试；链上失败自动回退，总时间预算 60s
- 各引擎可在设置页独立禁用

## 注册的模型工具

- **`web_search_multi`**：多引擎搜索。参数 `query`（必填）、`engine`（默认 auto）、`maxResults`（1-50）。返回 `{sources: [{url,title,snippet}], engine, attempts, error?}`，渲染为 markdown 链接列表。
- **`web_fetch_url`**：抓取任意公开 URL。经官方 `@deepseek-ai/dsh-web-fetch-http` provider（SSRF 防护/同源重定向/字节上限），HTML 自动转 markdown（turndown + gfm，从 harness 安装解析）。参数 `url`（必填）、`maxChars`（默认 20000）。

另将 11 个引擎注册为 `ctx.web` search provider（host 的 `web` 行仍钉 `searchProvider: deepseek-official`，产品自带 `web_search` 不受影响；想切换时在家级 patch 覆写 `web` 行 config 即可）。

## 设置页

**设置 → 插件 → 网页搜索**（client 半边，`settings.plugin.item` 键控槽位）：

- 总开关 / 7 个免费引擎独立开关 / API key（4 个，密码框）/ `apiInAuto` 开关
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
