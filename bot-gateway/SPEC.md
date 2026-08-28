# DSH Bot Gateway — 设计规格（实现契约）

> 目标：给正在运行的 DSH（DSH Desktop，web profile）加一个**宿主插件**，把 QQ（NapCat/OneBot v11
> 个人号 + QQ 官方机器人）、Telegram、飞书、钉钉等 IM 接成 DSH 的远程入口：
> 在聊天软件里发消息即可**创建任务 / 续聊 / 查进度 / 停止任务**，任务在 DSH 会话里真实执行，
> 完成后把最终回复发回聊天软件。所有会话同时出现在 Web GUI 侧边栏，本地可全程围观。

## 0. 运行环境事实（已验证）

- DSH 后端：Node v24.20.0（`C:\Users\lcl\AppData\Roaming\DSH Desktop\backend\node.exe`），
  全局有 `WebSocket`（undici，仅客户端）、`fetch`、`TextEncoder/TextDecoder`、`crypto.randomUUID`、`Buffer`。
  **无 `ws` npm 包，不允许 npm install** —— 全部协议手写，只用 node: 内建 + 全局。
- 宿主组合：`C:\Users\lcl\AppData\Roaming\DSH Desktop\dsh-home\profiles\web\cordis.patch.yml`
  （已有 agentrouter-proxy / session-cleaner 两个本地插件先例，加载方式为 `name: './xxx.mjs'`，baseUrl = profile 目录）。
- 本插件源码目录（canonical，被 junction 到 profile）：`C:\Users\lcl\Desktop\DSH\bot-gateway\`
  → junction：`profiles\web\bot-gateway` → 上述目录；组合里引用 `./bot-gateway/index.mjs`。
- 插件**不能** import `@deepseek-ai/*` 包（不在模块解析路径上），只能用 `ctx.get(...)` 拿服务、
  node: 内建与全局。用户消息对象需要按源码形状**字面构造**（见 §3.3，实现时必须先读源码核对）。
- 改 .mjs 内容**不会热重载**；改 cordis.patch.yml 里本条目的 config 会触发该插件重载。
  插件的 `apply` 必须幂等、可清理（ctx.effect 反注册一切）。

## 1. 文件布局

```
bot-gateway/
├─ index.mjs            # 插件入口：export const name / inject / apply(ctx, config)
├─ lib/
│  ├─ util.js           # 通用：日志、重连调度、文本切块、HTTP 助手、极简 WS 服务器、CQ 码
│  ├─ core.js           # TaskManager + 会话驱动 + 命令路由 + 状态持久化
│  ├─ webui.js          # webServer 路由挂载：状态页 HTML + JSON API + 二维码中继
│  ├─ napcat.js         # NapCat WebUI API 客户端（登录态 + 二维码轮询 + 快速登录）
│  └─ adapters/
│     ├─ onebot11.js    # QQ 个人号（NapCat/LLOneBot/Lagrange，OneBot v11）
│     ├─ qqofficial.js  # QQ 官方机器人（q.qq.com）
│     ├─ telegram.js    # Telegram Bot API（long polling）
│     ├─ feishu.js      # 飞书长连接（protobuf Frame）
│     └─ dingtalk.js    # 钉钉 Stream 模式
├─ test/
│  ├─ mock-onebot.mjs   # OneBot v11 模拟客户端（连我们的反向 WS）
│  └─ smoke.mjs         # 独立冒烟：mock ctx + mock adapter 全链路
├─ README.md            # 用户文档（中文）：各平台开通步骤、命令、安全须知
└─ SPEC.md              # 本文件
```

模块间约定：全部 ESM，**无外部依赖**；每个 adapter 导出一个工厂：

```js
// 所有 adapter 的统一接口
export function createAdapter(kind, adapterConfig, deps) => ({
  kind,                    // 'onebot11' | 'qqofficial' | 'telegram' | 'feishu' | 'dingtalk'
  deps,                    // { log, core, config } 见下
  async start(),           // 建立连接并开始收发；返回后 status 应为 'connected' 或 'waiting-login'
  async stop(),            // 断开并清理；幂等
  status(),                // () => { state, detail } state ∈ starting|connected|reconnecting|error|disabled
  async sendText(target, text, opts) // target: adapter 自己识别的聊天目标描述符
})
```

`deps.core` 提供回调（core 实现向 adapter 屏蔽 DSH 细节）：
- `core.onMessage({ adapter: kind, chatId, userId, userName, text, isGroup, reply })`
  - `chatId`：稳定会话键（QQ 号/群号/openid/chat_id/StaffId 会话等）
  - `reply(text)`：往**该聊天**发文本（adapter 实现，负责分块与平台转义）
  - core 处理命令与任务，把要发的话通过 `reply` 发回去；任务结果也通过它发。

## 2. 入口插件（index.mjs）

```js
export const name = 'bot-gateway'
// 不 inject 任何 Cordis 服务（避免等待）；apply 内用 ctx.get 逐个探测：
//   'webServer'（挂状态页路由）、'agents'、'sessions'、'agentDefaultModel'、'timer'
// 任一核心服务缺失时降级：记录日志、状态页显示原因，不抛错。
export function apply(ctx, config) { ... }
```

- `config` 解析：合并 DEFAULTS（见 §6），非法值直接 throw（mount 失败优于静默错配，与 agentrouter-proxy 同策略）。
- 生命周期：`apply` 里构造 `Gateway`（core.js），注册 webServer 路由，启动各 enabled adapter；
  `ctx.effect(() => async () => { await gateway.dispose() })`，dispose 顺序：停 adapter → 停进度计时 → 释放 agent 句柄（调用其 dispose，若可用）→ 取消事件监听 → flush 状态。
- 事件监听：`ctx.on('session/event', handler)`（返回反注册函数，进 ctx.effect）。
- 目录定位：`const HERE = new URL('.', import.meta.url)`；`dshHome = ../../..`（即 profiles/web/bot-gateway → dsh-home），
  但 junction 场景下 `import.meta.url` 解析到真实路径（Node 对 junction 返回真实路径还是链接路径？**实现时必须实测**：
  在 junction 下 `import.meta.url` 可能返回 `...profiles\web\bot-gateway\index.mjs`（链接路径）——两种都正确指向 profile 目录，
  因此 dsh-home 推导是安全的；若 config 显式给了 tasksRoot/statePath 则优先）。

## 3. core.js — 任务管理与会话驱动（最重要）

### 3.1 已验证的 DSH 服务 API（agy 调查结论，实现时须再核对源码）

- `ctx.sessions`（SessionStore）：
  - `create(id?, { seed?, meta?: { cwd, agentPreset, parentSession, origin, delegationDepth } })`
  - `get(id)`、`list()`、`flush(session)`（flush 返回 Promise<boolean>）
  - `cwd 必须绝对路径`，否则抛错。
- `ctx.agents`（AgentRegistry）：
  - `await create({ sessionId, agentOptions?: { provider, model, maxTokens }, meta?: { cwd, agentPreset }, setup?, seed? })`
    → `{ agent, dispose }`
  - `agent.followup(userMessage)`：入队并唤醒下一轮；运行中调用 = 排队下一 turn。
  - `agent.cancel(cause, options?)`、`agent.steer(...)`。
  - `await agent.whenIdle()`：turn 结束回到 idle 时 resolve。
- `ctx.on('session/event', (session, event) => ...)`：event.type ∈
  `turn/start` / `turn/end` / `assistant/message` / `assistant/chunk`(data.chunk.type='text-delta') /
  `tool/call`(data.callId,data.name,data.arguments) / `tool/result` / …
- `ctx.agentDefaultModel?.currentSelection?.()` → `{ provider, model }`（settings 的默认模型）。
- 模型选择两条路（无法 import @deepseek-ai/dsh-agent 的 installModelSelection，所以）：
  **用 `agentOptions: { provider, model }`**（优先 config.model；否则 agentDefaultModel.currentSelection()）。

### 3.2 实现前必读源码（agy 在写代码前核对，防止形状偏差）

- `C:\Users\lcl\AppData\Roaming\DSH Desktop\backend\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-headless\lib\index.js`
  —— createUserMessage 的用法、agent 驱动范式（L63-L98）。
- `...\@deepseek-ai\dsh-llm\`（find lib 中 createUserMessage 定义）——**字面抄下用户消息对象形状**
  （预计 `{ content: [{type:'text',text}], source: {kind:'user'}, ... }`），在 util 里写
  `makeUserMessage(text)` 按该形状构造，不 import。
- `...\@deepseek-ai\dsh-host-apiproxy\lib\index.js` —— session.create / session.prompt 路由：
  **重点：prompt 一个已存在（重启后恢复）的 session 时如何重新 attach agent**（预计 agents.create({sessionId}) 复用已加载 session），照抄该模式。
- `...\@deepseek-ai\dsh-agent-loop\lib\index.js` L396-L465 —— followup/cancel/whenIdle 语义。
- `C:\Users\lcl\AppData\Roaming\DSH Desktop\dsh-home\profiles\web\node_modules\@noob-stupid\dsh-plugin-console\lib\index.js`
  —— **webServer 服务挂 HTTP 路由的确切 API**（照抄其用法）。

### 3.3 Task / Chat 数据模型

```js
// chatKey = `${adapter}:${chatId}`，taskId = 4 位 base36（如 'k3f9'）
Task = {
  id, chatKey, adapter, chatId, userId,
  sessionId,            // DSH session id（crypto.randomUUID()）
  title,                // 前 40 字符
  workspaceDir,         // 绝对路径
  createdAt, updatedAt,
  status,               // 'running' | 'idle' | 'error' | 'stopped'
  agent,                // 活跃 agent 句柄（不持久化）
  lastError,
  turnStartedAt,        // 进度用
  // 进度快照（由 session/event 更新）：
  currentTool,          // 'pwsh(Get-Child-item…)' 最近一次 tool/call 的 name+参数摘要
  toolCalls,            // 本 turn 计数
  todoSummary,          // '⏳3 ✅5'（解析 todo 工具调用参数；尽力而为）
  lastAssistantText,    // 最近一次 assistant/message 文本（/status 展示尾部）
}
```

持久化 `state.json`（config.statePath，默认 `<dsh-home>\bot-gateway\state.json`）：
`{ version: 1, chats: { [chatKey]: { activeTaskId } }, tasks: { [taskId]: {…Task 中可序列化字段} } }`
- 原子写（tmp+rename）；变更节流 2s；dispose 时最终写。
- 重启恢复：载入 registry；agent 句柄置空、status 归为 'idle'；下次该 chat 发消息时**惰性重挂**
  （按 apiProxy 的模式 agents.create({sessionId})）；若 session 已不存在（被用户删除）→ 清绑定并提示。

### 3.4 消息路由（onMessage 逻辑）

```
text 以 '/' 开头 → 命令解析（见 §3.5）
否则：
  chat 有活跃任务 T：
    T.status==='running' → 仍调用 T.agent.followup（排队下一轮），回复「已加入队列，当前任务完成后执行」
    否则 → 续聊：followup + whenIdle → 回复最终文本
  chat 无活跃任务 → 等同 /new
群聊门控（adapter 层已处理提及/@过滤；core 不重复过滤）
```

每条 followup 的用户消息模板（首次 /new 时前置远程上下文提示）：

```
（你正在为远程 IM 用户执行任务。交互通道是聊天软件：无法弹窗提问，
如需澄清请直接以文本提问并结束本轮；任务完成时给出简明结果摘要。）

<用户消息>
```

续聊消息不重复前缀。

### 3.5 命令集（全部平台统一，群聊允许 `/cmd@机器人` 形式——adapter 层剥掉 @）

- `/help` — 命令列表
- `/new <描述> [--cwd <绝对路径>]` — 新任务；默认 workspace = `<tasksRoot>/<日期>-<taskId>-<slug>/`（mkdir recursive）
- `/status [taskId]` — 进度：状态/时长/当前工具/工具调用数/todo/最近回复尾部 200 字
- `/list` — 本 chat 最近 10 个任务（id、标题、状态、时间）
- `/stop [taskId]` — agent.cancel('用户远程停止') + 状态 stopped，回复确认
- `/switch <taskId>` — 切换活跃任务
- `/cwd <绝对路径>` — 设置该 chat 后续 /new 的默认工作目录（存 state.json 的 chat.cwd；清空用 `/cwd reset`）
- 未识别命令 → 提示 /help

安全：命令与非命令消息一样受 allowlist 限制（见 §6）。**未在 allowlist 的用户**：仅回复一句
「未授权。你的用户标识是 <userId>，请把它加进 cordis.patch.yml 的 allowUsers。」（不执行任何任务）

### 3.6 会话驱动（runTurn）

```js
async function runTurn(task, promptText) {
  task.status = 'running'; task.turnStartedAt = Date.now(); task.toolCalls = 0
  notifyChat(task, `▶️ [${task.id}] 开始：${task.title}`)   // 可选：turnStartNotify
  try {
    task.agent.followup(makeUserMessage(promptText))
    await task.agent.whenIdle()
    await sessions.flush(task.agent.session)
    const final = extractFinalText(task.agent.session, sinceSeq)   // 扫 assistant/message 文本块
    task.status = 'idle'
    notifyChat(task, final || '（本轮无文本输出）')       // adapter 的 reply 负责分块
  } catch (e) {
    task.status = 'error'; task.lastError = String(e?.message || e)
    notifyChat(task, `❌ [${task.id}] 失败：${task.lastError}`)
  }
}
```

- `whenIdle()` 挂起期间不能阻塞 adapter 消息循环 —— runTurn 是 fire-and-forget 的 async（每任务串行：
  Task 上一个 `chain = chain.then(run)` promise 链防并发 followup 竞态）。
- 超时保护：`config.turnTimeoutMs`（默认 0=不限）可选 abort：`agent.cancel('timeout')`。
- 进度事件（全局 session/event 监听 → 按 sessionId 路由到 task）：
  - `tool/call` → task.currentTool = `${name}(${summarize(args, 40)})`；toolCalls++
  - `assistant/message` → lastAssistantText 累积
  - `turn/end` → （runTurn 的 whenIdle 也会醒，双保险）
  - 定时进度（config.progressIntervalMs，默认 180000，0=关）：running 超过该时长才发：
    `⏳ [k3f9] 已运行 12m · 工具调用 34 次 · 正在 pwsh(npm test) · todo ⏳3✅5`
- todo 解析：`tool/call` 且 name==='todo_write' 时解析 arguments.todos 统计（尽力而为，解析失败忽略）。

### 3.7 agent 创建细节

```js
const { provider, model } = config.model ?? ctx.agentDefaultModel?.currentSelection?.() ?? {}
const { agent, dispose } = await ctx.agents.create({
  sessionId: task.sessionId,
  meta: { cwd: task.workspaceDir, ...(config.agentPreset ? { agentPreset: config.agentPreset } : {}) },
  ...(provider && model ? { agentOptions: { provider, model } } : {}),
})
```

- sessions.create 先行：`ctx.sessions.create(task.sessionId, { meta: { cwd: task.workspaceDir, origin: 'bot-gateway' } })`
  （若 apiProxy 源码显示 agents.create 内部已自动建 session，则以源码为准、去掉重复调用）。
- 保留 `dispose`，任务对象上保存；gateway dispose 时统一调用。
- agentPreset 不配置 → 系统默认（settings 的 cordis-agy）→ 权限跟随 `permission.defaultPreset`
  （当前 danger-full-access，即「远程任务具有本地任务的完整权限」——文档里必须显著警告）。

## 4. adapters —— 平台协议（已验证细节全录）

### 4.1 onebot11.js（QQ 个人号；NapCat 推荐，也兼容 LLOneBot/Lagrange）

配置：
```yaml
onebot11:
  enabled: true
  mode: forward-ws          # forward-ws（我们连 NapCat 的 WS 服务器）| reverse-ws（NapCat 连我们）
  url: ws://127.0.0.1:3001  # forward-ws 用
  accessToken: ''           # OneBot access_token（query 参数传递：?access_token=）
  listenPort: 3002          # reverse-ws 用（我们起 WS 服务器）
  listenHost: 127.0.0.1
  selfId: 0                 # 机器人 QQ 号（群聊 @ 识别用；连上后可从生命周期事件自动学习）
  groupTrigger: mention     # 群聊触发：mention(@) | prefix
  groupPrefix: '/bot'       # groupTrigger=prefix 时
  allowUsers: []            # QQ 号数组；空=拒绝所有人（并提示如何加）
  allowGroups: []           # 允许的群号；空=所有 allowUsers 里用户所在群
  napcatWebui: { url: 'http://127.0.0.1:6099', token: '' }   # 扫码中继；token 空=禁用中继
```

协议要点：
- forward-ws：`new WebSocket(url + '?access_token=…')`（全局 undici WebSocket，不支持自定义 header，
  OneBot 11 规范允许 query 传 token）；收 JSON message 事件；发 `{"action": "...", "params": {...}, "echo": "<id>"}`，
  对应回包 `{status, retcode, data, echo}`（echo 匹配；不严格等待也行，fire-and-forget + 记错误）。
- reverse-ws：**手写极简 WS 服务器**（util.js：node:http `upgrade` 事件 + RFC6455 帧编解码：
  客户端→服务器帧必须 mask（解 mask）；服务器→客户端不 mask；处理 op 0x1 文本/0x2 二进制/0x8 close/0x9 ping→0xA pong；
  分片重组（FIN=0 继续）；单连接即认为是一个 OneBot 客户端）。URL 校验 accessToken query。
- 事件：`post_type==='message'`：
  - `message_type==='private'` → chatId=user_id, isGroup=false
  - `message_type==='group'` → chatId=group_id；**必须 @ 机器人**（message 数组含 `{type:'at',data:{qq:String(selfId)}}`）
    或 groupPrefix；@ 之后剥离 at 段取 text 段
  - 消息提取：message 为数组（NapCat 默认）或字符串（数组式优先，兼容两种）；
    只取 text 段（图片等忽略，拼 `[图片]` 占位可不做）
- 发送：`send_private_msg {user_id, message:{type:'text',data:{text}}}` / `send_group_msg {group_id, message}`
  （message 用数组段格式 `[{type:'text',data:{text:chunk}}]`；reply 引用可不做 v1）
- 元事件：`meta_event.lifecycle.connect` 带 `self_id` → 自动学习 selfId；`heartbeat` 忽略。
- 重连：指数退避 1s→60s（forward-ws）；reverse-ws 被动等连。
- **每 45s 发 WS 层 ping**（undici WebSocket：浏览器式 API 不暴露 ping；改为应用层无操作？
  ——不需要：NapCat 不依赖 WS ping 保活；如断开靠 close 事件重连。reverse-ws 服务器侧收到客户端 ping 帧
  应回 pong（帧层实现里处理））。

### 4.2 napcat.js（WebUI API 客户端 —— 扫码中继）

（NapCat 4.2.12 源码已核对）
- `POST {url}/api/auth/login` body `{"token": "<webui token>"}` → `{data: {Credential}}`
  （响应包 `sendSuccess` 格式：`{code:0, data, message}` 或 `{code:…}`；两种都兼容解析）
- 后续请求 header `Authorization: Bearer <Credential>`（1 小时有效，401 时重新 login）
- `POST /api/QQLogin/GetQQLoginQrcode` → `{data: {qrcode: "<url>"}}`（ptlogin2 二维码图片 URL）
- `POST /api/QQLogin/CheckLoginStatus` → `{data: {isLogin, qrcodeurl}}`
- `POST /api/QQLogin/GetQuickLoginList` → 快速登录历史账号列表（展示用）
- `POST /api/QQLogin/SetQuickLogin` `{uin}` → 快速登录
- 供 webui.js 中继：`getQr()` → {qrcodeUrl}；`check()` → {isLogin}；`getLoginInfo()` → 登录后
  `POST /api/QQLogin/…`（若 NapCat 提供 GetLoginInfo 则用，否则用 CheckLoginStatus 的 isLogin）。
- webui 状态页把 qrcodeUrl 经 `/bot-gateway/api/qr/onebot11/image` 服务器代理输出（避免跨域/防盗链），
  页面每 3s 轮询 `/bot-gateway/api/status`，未登录显示二维码、已登录显示「✅ 已登录 <uin>」。

### 4.3 qqofficial.js（QQ 官方机器人）

配置：`{ enabled, appId, clientSecret, sandbox, intents: 默认 1<<25, allowUsers: [] }`（allowUsers 匹配
member_openid/user_openid； openid 对用户不直观——提供 /whoami 命令？→ 在未授权提示里直接回显 openid 即可）

协议（已核对 nonebot adapter-qq 源码）：
- token：`POST https://api.bot.qq.com/app/getAppAccessToken` JSON `{appId, clientSecret}` →
  `{access_token, expires_in}`（秒）。缓存并在过期前 120s 刷新；401 时强制刷新重试一次。
- WS：默认 `wss://api.sgroup.qq.com/websocket`（config.gatewayUrl 可覆盖）。全局 WebSocket 连接。
- 帧格式（JSON）：
  - 收 `{"op":10,"d":{"heartbeat_interval":ms}}`（HELLO）→ 发 `{"op":2,"d":{"token":"QQBot <access_token>","intents":<int>,"shard":[0,1],"properties":{}}}`（IDENTIFY）
  - 每 heartbeat_interval 发 `{"op":1,"d":<最后收到的 s 或 null>}`；收 `{"op":11}`（ACK）
  - 收 `{"op":0,"t":"GROUP_AT_MESSAGE_CREATE"|"C2C_MESSAGE_CREATE","s":n,"d":{...}}`：
    - group：`d.content`（@ 前缀已由平台去除，首个空格 strip）、`d.group_openid`、`d.author.member_openid`、`d.id`（msg_id）
    - c2c：`d.content`、`d.author.user_openid`、`d.id`
  - `op:7`（RECONNECT）/ `op:9`（INVALID_SESSION）→ 断开重连（op9 后全新 IDENTIFY，不做 RESUME v1）
- 发消息（被动回复）：
  - `POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages` JSON
    `{msg_type:0, content, msg_id, msg_seq}`；msg_seq 对同一 msg_id 从 1 递增（每条消息一个 seq，
    5 分钟窗口内最多 5 条回复——**长回复分块时注意此限制**：块数>5 时前 4 块 + 尾块合并）
  - c2c：`POST /v2/users/{user_openid}/messages` 同形状
  - header：`Authorization: QQBot <token>`、`X-Union-Appid: <appId>`、`Content-Type: application/json`
  - 429/错误：记日志，块间 sleep 300ms 限速
- 块大小：500 字符（官方限制较紧）。

### 4.4 telegram.js

配置：`{ enabled, token, apiBase: 'https://api.telegram.org', proxy: '', allowUsers: [] }`（allowUsers 为
Telegram 数字 user id；群里用 username 提及或 /cmd@<botusername>——bot username 可从 getMe 学习）

- `getMe`（启动时，学 self.username/id）→ long polling `getUpdates?offset=&timeout=30`
  （fetch + AbortSignal.timeout(35s)；失败退避重试；proxy 场景让用户自行设系统代理或 https_proxy 环境变量——
  fetch 不走 env 代理！文档里注明大陆网络需系统级代理（如 clash TUN）或改 apiBase 为自建反代）。
- update → `message.text`；`message.chat.type==='private'` 直接处理；group 仅当 text 含 `@<botusername>` 或
  命令带 @botusername 后缀（剥离后传 core）。
- 发送：`POST /bot<token>/sendMessage` JSON `{chat_id, text, parse_mode:''（纯文本，不做 Markdown 转义）}`；
  4096 上限 → 3800 分块；429 → respect retry_after。

### 4.5 feishu.js（飞书长连接，protobuf）

配置：`{ enabled, appId, appSecret, domain: 'https://open.feishu.cn', allowUsers: [] }`（allowUsers 匹配
sender open_id / union_id；飞书单聊即 chat_id=ou_xxx 的 p2p）

协议（已核对 lark oapi-sdk-nodejs 1.73.0 bundle）：
1. `POST {domain}/callback/ws/endpoint` JSON `{AppID, AppSecret}` → `{code:0, data:{URL, ClientConfig:{PingInterval,ReconnectCount,ReconnectInterval,ReconnectNonce}}}`；URL 即 wss 连接（含 device_id/service_id query）。
2. WS 连 URL（二进制帧）。帧 = protobuf `pbbp2.Frame`：
   ```proto
   message Header { string key = 1; string value = 2; }
   message Frame {
     uint64 SeqID = 1; uint64 LogID = 2; int32 service = 3; int32 method = 4;
     repeated Header headers = 5; string payloadEncoding = 6; string payloadType = 7;
     bytes payload = 8; string LogIDNew = 9;
   }
   ```
   手写 varint 编解码（util.js：~60 行；uint64 用 Number 安全 —— 字段值小）。
   method：0=control，1=data。headers：`{key:'type',value:'event'|'ping'|'pong'}`、`message_id`、`sum`、`seq`、`trace_id`、`biz_rt`。
3. ping：每 PingInterval 秒发 control 帧 headers=[{type:ping}]、service=Number(serviceId from URL query)、SeqID/LogID=0；
   收 control type=pong（payload JSON 更新 PingInterval 等，可不处理）。
4. 收 data 帧（headers.type==='event'）：按 message_id 分片（sum/seq 从 0 起），payload 为 Uint8Array 片，
   全部到齐后拼接 → TextDecoder → JSON 事件：
   - `header.event_type==='im.message.receive_v1'` → `event.message.{chat_id, message_type, content, chat_type}`,
     `event.sender.sender_id.open_id`。content 为 JSON 字符串（text 消息 `{"text":"..."}`，含 @ 时 text 带 `@_user_1` 标记——
     只在 chat_type==='p2p' 或文本剥离 @mention 后非空时处理；群聊 @ 机器人判定：text 含 `@_user_N` 且
     mentions 数组里某 mention.name 为机器人名或 key.user_id === app bot open_id——简化：群聊仅当 mentions 非空时响应，
     剥离所有 @_user_N 标记）。
   - 处理完回 ACK：原帧 + 额外 header {key:'biz_rt', value:'0'} + payload=UTF8(JSON.stringify({code:200}))。
5. 发消息：`POST {domain}/open-apis/auth/v3/tenant_access_token/internal` JSON `{app_id, app_secret}` →
   `{tenant_access_token, expire}`（缓存提前 5 分钟刷新）；`POST {domain}/open-apis/im/v1/messages?receive_id_type=chat_id`
   header `Authorization: Bearer <tenant_access_token>` JSON `{receive_id: chat_id, msg_type:'text',
   content: JSON.stringify({text})}`。错误码 99991663/…记日志。
6. 块大小 3000。

### 4.6 dingtalk.js（钉钉 Stream）

配置：`{ enabled, clientId, clientSecret, allowUsers: [] }`（allowUsers 匹配 senderStaffId；单聊/群都来自回调）

协议（已核对 open-dingtalk/dingtalk-stream-sdk-nodejs 源码）：
1. `POST https://api.dingtalk.com/v1.0/gateway/connections/open` JSON
   `{clientId, clientSecret, subscriptions:[{type:'CALLBACK', topic:'/v1.0/im/bot/messages/get'}]}`，
   header `Accept: application/json` → `{endpoint, ticket}`；WS 连 `${endpoint}?ticket=${ticket}`。
2. 收 JSON：
   - `{type:'SYSTEM', headers:{topic:'ping', ...}, data}` → 必须回 `{code:200, headers:{contentType:'application/json', messageId: <同 messageId>}, message:'OK', data: <原 data>}`
   - `{type:'CALLBACK', headers:{topic:'/v1.0/im/bot/messages/get', messageId}, data: "<JSON 字符串>"}`：
     解析 → RobotTextMessage：`{conversationId, conversationType('1'单聊/'2'群), senderStaffId, senderNick,
     text:{content}, sessionWebhook, sessionWebhookExpiredTime, msgId, createAt}`；
     text.content 里群聊 @ 机器人文字已被去除（钉钉机器人消息只在被 @ 或单聊时推送，无需再过滤）。
     处理后回 ACK：`{code:200, headers:{contentType:'application/json', messageId}, message:'OK',
     data: JSON.stringify({response:{status:'SUCCESS', message:'ok'}})}`
3. 回复：`POST sessionWebhook`（临时 webhook，带过期时间）JSON
   `{msgtype:'markdown', markdown:{title:'DSH', text}}`（markdown 兼容长文本；或 text）。
   sessionWebhook 失效（过期）→ 若有 robotCode+access_token 也可走 REST，v1 直接报错提示用户重发消息触发新 webhook。
4. 块大小 20000（webhook 宽松），默认 3000 保守。
5. 重连：close → 重新 connections/open（退避）。

## 5. webui.js — 状态页（挂 webServer 服务）

路由前缀 `/bot-gateway/`（挂法照抄 plugin-console；若 webServer 服务 API 不匹配则降级：
不挂路由，仅日志，README 说明）。页面纯内联 HTML+JS（无构建）：

- `GET /bot-gateway/` — 状态页：
  - 适配器卡片 ×5：kind、状态灯（starting/connected/reconnecting/error/disabled/waiting-login）、
    详情（账号/错误）、OneBot11 卡片额外显示：登录态（NapCat WebUI）+ 二维码区（未登录时）
    + 快速登录账号列表按钮 + 「网络配置指引」折叠（正向 ws://127.0.0.1:3001 / 反向 ws://<host>:3002）
  - 任务表：最近 20 个任务（id、adapter、标题、状态、时长、workspace）
  - 配置摘要 + 「本页地址仅本机可访问」
  - 页面 JS 每 3s fetch `/bot-gateway/api/status` 重渲染（二维码 URL 变化时刷新 img）
- `GET /bot-gateway/api/status` — JSON：`{adapters:[{kind,state,detail,selfId?}], napcat:{configured, isLogin, uin?, quickLoginList?}, tasks:[…], config:{…脱敏}, now}`
- `GET /bot-gateway/api/qr/onebot11/image` — 服务器代理拉取 NapCat 的 qrcode URL 并透传字节（content-type: image/png）
- `POST /bot-gateway/api/qr/onebot11/refresh` — 重新 GetQQLoginQrcode（轮换二维码）

## 6. 配置（cordis.patch.yml 行，DEFAULTS 后合并）

```yaml
- insert:
    - id: bot-gateway
      name: ./bot-gateway/index.mjs
      config:
        tasksRoot: ''            # 空 = <dsh-home>/bot-gateway/tasks
        statePath: ''            # 空 = <dsh-home>/bot-gateway/state.json
        replyChunkChars: 1800    # adapter 各自上限取 min(this, 平台限制)
        progressIntervalMs: 180000
        turnStartNotify: true
        turnTimeoutMs: 0
        model: {}                # {provider, model} 空 = agentDefaultModel
        agentPreset: ''          # 空 = 系统默认预设
        adapters:
          onebot11:   { enabled: true, mode: forward-ws, url: 'ws://127.0.0.1:3001', accessToken: '', listenPort: 3002, selfId: 0, groupTrigger: mention, allowUsers: [], allowGroups: [], napcatWebui: { url: 'http://127.0.0.1:6099', token: '' } }
          qqofficial: { enabled: false, appId: '', clientSecret: '', sandbox: false, allowUsers: [] }
          telegram:   { enabled: false, token: '', apiBase: 'https://api.telegram.org', allowUsers: [] }
          feishu:     { enabled: false, appId: '', appSecret: '', allowUsers: [] }
          dingtalk:   { enabled: false, clientId: '', clientSecret: '', allowUsers: [] }
```

- 校验：enabled 且必要凭证缺失 → adapter 进入 `error` 状态并在状态页显示「未配置凭证」，
  **不抛错**（否则整个 profile 挂掉）。端口/URL 非法 → throw（配置错误应显式失败）。

## 7. 安全（README 显著章节）

- 默认 `allowUsers: []` = **所有人都不能执行任务**（会收到带自己 ID 的提示）。
- 远程任务继承全局权限预设（当前 danger-full-access = 完整权限）——allowlist 是唯一闸门，务必只加自己的账号。
- 反向 WS 监听 127.0.0.1；如需跨机请自行加 accessToken 并改 listenHost（README 说明风险）。
- 状态页只挂在本机 webServer 上。

## 8. 测试计划

1. `test/smoke.mjs`：构造 mock ctx（sessions/agents/agentDefaultModel/webServer 假实现）+ mock adapter，
   断言：命令路由、任务创建、runTurn 调用链、持久化写盘、allowlist 拒绝。
   （不连真实 DSH —— 纯逻辑验证；`node test/smoke.mjs` 退出码 0 = 通过）
2. `test/mock-onebot.mjs`：启动反向 WS 客户端模拟 NapCat：连 ws://127.0.0.1:3002，
   发私聊 message 事件（user_id=10000, text='/new 说 ok'）→ 期待收到 send_private_msg。
   用于插件挂到真实 DSH 后的端到端验证（任务真实跑 agentrouter 模型）。
3. 挂载验证：junction + cordis.patch.yml 加行（config 触发热重载）→ curl
   `http://127.0.0.1:53035/bot-gateway/api/status` 检查 200 与 adapters 状态。
4. 真平台（QQ 等）留给用户按 README 配置。

## 9. 分阶段交付

- **Stage A**：util + core + onebot11 + napcat + webui + index + smoke 测试（本文件全部规格）
- **Stage B**：qqofficial + telegram
- **Stage C**：feishu + dingtalk（含 protobuf 编解码）
- **Stage D**：junction + patch 行 + 端到端 mock 验证 + README 用户文档
