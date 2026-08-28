# DSH 宿主插件（Cordis Host Plugins）

本目录存放部署在 **DSH Desktop 独立数据目录** 中的自定义宿主插件源码：

```
%APPDATA%\DSH Desktop\dsh-home\profiles\web\
├── agentrouter-proxy.plugin.mjs   ← 本目录同步副本
├── session-cleaner.plugin.mjs     ← 本目录同步副本
└── cordis.patch.yml               ← 插件注册表（含上面两个条目）
```

> 仓库内是**源码正本**；部署 = 复制 `.mjs` 到上述目录 + 在 `cordis.patch.yml` 里登记条目。

---

## 1. agentrouter-proxy —— agentrouter.org 反向代理

**作用**：DSH 硬编码的 `deepseek-harness/...` User-Agent 会被 [agentrouter.org](https://agentrouter.org/) 的客户端白名单拒绝（401 `unauthorized client detected`）。本插件在 `127.0.0.1:8787` 起一个反代，把 UA 改写成白名单内的 `claude-cli/1.0.60 (external, cli)` 后转发上游，其余原样透传。

**配置**（见 `cordis.patch.example.yml` 对应条目）：

| 键 | 说明 |
|---|---|
| `port` | 本地监听端口（默认 8787） |
| `upstream` | 上游地址；大陆网络可换官方备用域名 `https://ps.air-outer.com` |
| `userAgent` | 改写后的 UA，必须是 agentrouter 白名单客户端 |
| `verbose` | true 时逐条打印请求；默认只记 4xx/5xx |

**密钥流向**：API Key 保存在 DSH 自己的 provider 配置里（`dsh-home/.credentials.yaml`），由 DSH 经 `x-api-key`/`Authorization` 头送入反代——**插件与补丁文件都不含任何密钥**。DSH 里的 provider `baseURL` 指向 `http://127.0.0.1:8787` 即可。

## 2. session-cleaner —— 会话清理（删除/回收站/恢复）

给 DSH 补上原生缺失的会话删除能力，设计为**两级可恢复删除**：

- **删除 = 移入回收站**（`dsh-home\.session-cleaner-trash\<sessionId>\`，含 `.trash-info.json` 元数据）
- **恢复**：原样搬回会话目录并重写注册表（`storages/workspace.json`、`storages/session_projcache.json`）
- **粉碎（purge）**：二级永久删除，需输入 `PURGE` 确认

### UI 集成（注入式）

- 侧边栏会话行「⋯」菜单末尾追加 **「移入回收站」**（重命名/分叉会话/归档会话之后）
- 侧边栏底部、设置行上方新增 **「回收站」入口**，直达管理页回收站区块（`/session-cleaner#trash`）
- 确认弹窗展示：标题、完整 sessionId、创建/最后活动时间、轮次、磁盘大小
- **同名会话防删错**（核心安全设计）：
  - 定位只认 sessionId：菜单打开时目标行带有唯一 `_menuOpen` 标记，从该行的 React Fiber 节点提取 `node.id`，绝不按标题匹配；提取失败则不注入菜单项
  - 存在同标题会话时弹窗内黄色警示区列出对方摘要（短 ID、创建时间、轮次）
- **活跃会话保护**：`openStep`/`pendingCalls` 非空（正在运行）的会话拒绝删除，确认按钮禁用
- 删除成功后目标行淡出移除

### HTTP API

| 端点 | 说明 |
|---|---|
| `GET /api/session-cleaner/sessions` | 全部会话（含未注册的子代理目录）；`isLive` 只看 projcache 的 openStep/pendingCalls |
| `GET /api/session-cleaner/trash` | 回收站列表 |
| `POST /api/session-cleaner/delete` | `{sessionId, confirm:"DELETE"}` 移入回收站 |
| `POST /api/session-cleaner/restore` | `{sessionId}` 恢复 |
| `POST /api/session-cleaner/purge` | `{sessionId, confirm:"PURGE"}` 永久粉碎 |
| `GET /session-cleaner` | 中文管理页（独立页面，支持 `#trash` 锚点直达） |

> 注意：`isLive` **不能**用 SessionStore 的内存加载状态判断——后端会把打开过的会话常驻内存，那样所有空闲会话都会被误判为活跃而无法删除。

### 已知边界

- 恢复的会话需**重启 DSH Desktop** 后才会重新出现在侧边栏（宿主 workspace registry 无外部收养 API）
- 有未闭合 step 的会话会被拒绝删除（防数据截断）；状态落定后自然可删

## 部署与热更新

1. 复制 `.mjs` 到 `%APPDATA%\DSH Desktop\dsh-home\profiles\web\`
2. 按 `cordis.patch.example.yml` 在同目录 `cordis.patch.yml` 中登记条目（`name` 以 `./` 开头按 profile 目录解析）
3. **修改插件代码后**：DSH 的模块缓存不会自动失效，把条目 `name` 的 query 版本号 +1（如 `?v=5` → `?v=6`）保存即可触发热加载，无需重启
4. 回收验证：`GET /api/session-cleaner/sessions` 返回 200 且 `isLive` 符合预期即已生效

## 测试

```powershell
# 会话清理插件（35 项断言，含同名隔离/回收站/恢复/粉碎/路由契约/注入清理）
node test-session-cleaner.mjs

# agentrouter 反代插件（独立 Cordis 实例加载→转发→释放端口）
$env:AGENTROUTER_API_KEY = "sk-..."   # 密钥走环境变量
node test-proxy-plugin.mjs

# agentrouter 端到端（SSE 流式 + tool_use，经本地反代）
node test-agentrouter.mjs
```
