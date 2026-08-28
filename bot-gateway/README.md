# DSH Bot Gateway — 把聊天软件变成 DSH 的远程入口

把 QQ（NapCat / OneBot v11 + QQ 官方机器人）、Telegram、飞书、钉钉接入 DSH：
在手机聊天软件里发一条消息，就能创建任务、续聊、查进度、停止任务 —— 与本地任务拥有完全相同的权限与模型能力。

```
┌─────────────┐   OneBot v11 WS    ┌──────────────────────────────────┐
│  NapCat/QQ  │◄──────────────────►│  bot-gateway (DSH 宿主插件)      │
│  Telegram   │   TG Long Poll     │   ├─ 命令路由 /new /status /stop │
│  飞书       │   飞书长连接 WS     │   ├─ TaskManager + state.json   │
│  钉钉       │   钉钉 Stream WS   │   └─ agents.create + preset 挂载 │
└─────────────┘                    └──────────────┬───────────────────┘
                                                  │ followup / whenIdle
                                                  ▼
                                    DSH Agent（工具齐全、会话持久化、
                                    独立工作目录，权限继承宿主）
```

- **源码**：`C:\Users\lcl\Desktop\DSH\bot-gateway\`（通过 junction 挂进 `dsh-home\profiles\web\`）
- **状态看板**：http://127.0.0.1:53035/bot-gateway/ （适配器状态 / 扫码登录 / 任务列表）
- **设计文档**：`SPEC.md`（协议细节、架构、测试计划）

---

## 一、支持的平台

| 平台 | 协议 | 模式 | 扫码 |
|---|---|---|---|
| QQ（NapCat/Lagrange 等） | OneBot v11 | 正向 WS（我们连 NapCat）/ 反向 WS（NapCat 连我们） | ✅ 看板扫码中继 |
| QQ 官方机器人 | QQ Bot WebSocket | 官方 wss 网关 + 被动回复 | —（后台配置） |
| Telegram | Bot API | 长轮询 getUpdates | —（@BotFather 建 bot） |
| 飞书 | 长连接 | 官方 callback/ws（protobuf 帧） | —（开放平台配置） |
| 钉钉 | Stream Mode | 官方 gateway/connections/open | —（开发者后台配置） |

---

## 二、快速开始（QQ · NapCat · 扫码）

### 1. 安装 NapCat

NapCat 是无头 QQ 客户端，提供 OneBot v11 协议。任选一种方式安装：
- 官方 release：https://github.com/NapNeko/NapCatQQ （QQNT 框架版 / Shell 版）
- NapCat Shell 版开箱即用：解压后 `napcat.mjs` 即可运行

### 2. 配置 NapCat WebUI 与 WS 服务器

NapCat 目录下 `webui.json` 记录 WebUI token（默认 6099 端口）；
`onebot11.json`（或 WebUI 界面里）配置 **网络** → **WebSocket 服务器**：

```json
{
  "network": {
    "websocketServers": [
      { "name": "dsh", "port": 3001, "enable": true, "messagePostFormat": "array" }
    ]
  }
}
```

### 3. 配置网关

编辑 `C:\Users\lcl\AppData\Roaming\DSH Desktop\dsh-home\profiles\web\cordis.patch.yml` 的 `bot-gateway` 段：

```yaml
- insert:
    - id: bot-gateway
      name: ./bot-gateway/index.mjs?v=10
      config:
        model: { provider: agentrouter, model: glm-5.3 }
        adapters:
          onebot11:
            enabled: true
            mode: forward-ws          # 连 NapCat 的 WS 服务器
            url: 'ws://127.0.0.1:3001'
            allowUsers: ['10001']     # ← 换成你自己的 QQ 号！
            napcatWebui:
              url: 'http://127.0.0.1:6099'
              token: '你的NapCat WebUI token'   # 填了才能在看板扫码
```

> `allowUsers` 是唯一安全闸门。不知道自己的 QQ 号？先随便发条消息给机器人，
> 未授权回复会把你的用户标识原样告诉你，再把它填进来。
> 留空数组 = 拒绝所有人。

### 4. 扫码登录

1. 启动 NapCat，启动 DSH Desktop（网关插件随宿主自动加载）
2. 浏览器打开 http://127.0.0.1:53035/bot-gateway/
3. 在「扫码登录」卡片点击 **刷新二维码** → 用手机 QQ 扫码 → 卡片变绿即登录成功
4. （也可用「快速登录」按钮一键登录最近账号，无需扫码）

### 5. 发消息试一试

手机 QQ 私聊机器人（或群里 @机器人）：

```
/new 帮我在桌面上创建一个 notes.txt，内容写"远程任务测试"
```

几秒后机器人回复「▶️ [xxxx] 开始执行…」，任务完成后回报结果。

---

## 三、其他平台配置速查

### QQ 官方机器人（q.qq.com 注册）

```yaml
qqofficial: { enabled: true, appId: '你的AppID', clientSecret: '你的Secret', allowUsers: [] }
```
注意：官方机器人要求被动回复（收到消息 5 分钟内、最多 5 条），网关已自动处理 msg_seq 递增。
群里使用需要开启「机器人可以被@」。

### Telegram

```yaml
telegram: { enabled: true, token: '123456:ABC-DEF...', allowUsers: [] }
```
@BotFather 创建 bot 拿 token；`allowUsers` 填你的数字 user id（给 @userinfobot 发消息可查）。
大陆网络可设 `apiBase` 指向自建反代。

### 飞书（open.feishu.cn 创建企业自建应用）

```yaml
feishu: { enabled: true, appId: 'cli_xxx', appSecret: 'xxx', allowUsers: [] }
```
开放平台 → 事件与回调 → 选择「使用长连接接收事件」，并订阅 `im.message.receive_v1`，
权限开 `im:message`、`im:message:send_as_bot`。

### 钉钉（open-dev.dingtalk.com 创建应用 + 机器人）

```yaml
dingtalk: { enabled: true, clientId: 'xxx', clientSecret: 'xxx', allowUsers: [] }
```
开发者后台 → 机器人配置 → 消息接收模式选 **Stream 模式**，无需公网 IP。

---

## 四、命令参考

| 命令 | 说明 |
|---|---|
| `/new <描述> [--cwd <绝对路径>]` | 创建新任务（不指定 cwd 时在任务专属目录里工作） |
| `/status [taskId]` | 查看任务实时状态（正在调什么工具、第几轮等） |
| `/list` | 列出本聊天最近 10 个任务 |
| `/stop [taskId]` | 停止运行中的任务 |
| `/switch <taskId>` | 切换本聊天的活跃任务 |
| `/cwd <绝对路径 \| reset>` | 设置 / 重置本聊天的默认工作目录 |
| `/help` | 命令帮助 |
| （直接发文本） | 无活跃任务时自动当新任务；有任务时作为追加指令排队 |

任务运行时每 3 分钟自动推送一条进度（`progressIntervalMs` 可调）。

**工作目录规则**（默认，符合「任务数据放 DSH 数据目录」的策略）：
`<dsh-home>\bot-gateway\tasks\<日期>-<任务id>-<标题slug>\`，互不污染；
用 `--cwd` 或 `/cwd` 可显式指定任意目录。

---

## 五、安全须知（务必阅读）

1. **远程任务继承宿主全部权限**。当前宿主是 `danger-full-access`（完整读写、任意命令），
   远程任务同样拥有。`allowUsers` 是唯一闸门 —— **只加自己的账号**。
2. 群聊默认需要 @机器人 才响应（`groupTrigger: mention`），且可再加 `allowGroups` 白名单限定群号。
3. 状态看板只监听本机回环（127.0.0.1），并有 Host/CSRF 校验，外网访问不到。
4. `state.json`（任务注册表）与任务工作区都在 `dsh-home\bot-gateway\` 下，删除该目录即清空所有远程任务痕迹。

---

## 六、改代码 & 热重载

**改 `cordis.patch.yml` 里的 config**（如换模型、换 allowUsers）：保存即自动热重载，无需动版本号。

**改 `.mjs` 源码**：Node ESM 模块缓存按「URL + query」键控，必须全局 bump 版本号绕开缓存：

1. 把 `index.mjs` 的 `const V = 'N'` 改为 `N+1`
2. 把 `lib/*.js`、`lib/adapters/*.js` 里所有 `?v=N` 改为 `?v=N+1`
3. 把 `cordis.patch.yml` 里入口 `./bot-gateway/index.mjs?v=M` 改为 `?v=M+1`
4. 等 5~10 秒（看板右上角版本号 / `api/status` 的 `pluginVersion` 变化即为生效）

诊断利器：`<dsh-home>\bot-gateway\debug.log` 记录 agent 挂载、每轮事件数、被循环吞掉的
`agent/error`——排查"任务没反应"先看它。

---

## 七、架构与扩展性

```
index.mjs              插件入口：配置合并、装配 5 适配器、注册看板路由
lib/core.js            Gateway：TaskManager、命令路由、runTurn 驱动、
                       session/event 进度通知、state.json 持久化与重启恢复
lib/util.js            日志、退避重连、消息分块、makeUserMessage、RFC6455 WS 服务器
lib/webui.js           状态看板（HTML + status/qr/quick-login API，三层安全校验）
lib/napcat.js          NapCat WebAPI 客户端（扫码中继）
lib/pb.js              飞书 pbbp2.Frame protobuf 编解码
lib/adapters/*.js      5 个平台适配器，统一工厂签名：
                       createAdapter(kind, adapterConfig, deps) →
                         { kind, start(), stop(), status(), sendText(chatTarget, text) }
```

**加新平台**只需三步：
1. 新建 `lib/adapters/<platform>.js`，实现 `createAdapter` 工厂签名（收消息 → 调
   `deps.core.onMessage({ adapter, chatId, userId, text, isGroup, reply })`，
   `reply` 是回发函数；发送 → 实现 `sendText`）
2. 在 `index.mjs` 的 `DEFAULTS.adapters` 加默认配置 + 装配注册
3. bump 版本号（见上节）

**DSH 侧接入要点**（对齐 `dsh-host-apiproxy` 的 `ensureSession` 模式）：
`agents.get(sessionId)` 活跃复用 → 持久化命中走 `agents.resume` → 全新会话走
`agents.create`（**绝不能**先 `sessions.create` 再 `agents.create`，会撞 "already exists"）。
创建时必须传 `setup: (agentCtx) => presets.mount(agentCtx, presetId)` 挂载工具集，
否则模型没有任何工具、只会空谈；setup 返回值必须是 `undefined`。

---

## 八、测试

```powershell
cd C:\Users\lcl\Desktop\DSH\bot-gateway
node test\smoke.mjs          # 冒烟：工具函数、配置合并、命令解析
node test\ws-server-test.mjs # RFC6455 WS 服务器（分片/ping/close）
node test\adapter-test.mjs   # 5 适配器协议与事件链
node test\stagec-test.mjs    # protobuf 编解码 + 飞书/钉钉适配器
# 端到端（需 DSH Desktop 运行中；起 Mock NapCat 推 /new 任务并断言完成回复）：
node test\mock-onebot-server.mjs --expect-v=<当前V> --wait-ms=300000
```

测试辅助工具：`test\inspect-session.mjs <关键词>`（查任务会话）、
`test\zcat-session.mjs <journal.zstd>`（多帧 zstd 解压会话日志）。
