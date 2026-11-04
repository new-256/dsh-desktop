# plugin-journal · main.js 接线点清单（交给 task-10 owner 照抄）

> 模块：`plugin-journal.js`（0.3.49 · B-04）· 本文是**唯一接线依据**，字段取值照抄即可。
> 纪律：**只传白名单字段**；不要把 `spec` 原文、命令行、插件 stdout/stderr、token/路径里的
> 敏感段塞进来 —— 台账只记「动作 + 插件标识 + 结果码」。传进来的非白名单字段会被丢弃，
> 字符串还会兜一层凭据脱敏（`token=…` → `token=***`）。
> 模块对外永不抛错；但**不要把 `record()` 放进 try/catch 里吞掉返回值** —— 它返回
> `false` 表示排队触顶被丢弃（已在 `status()` 与日志正文计数），必要时可据此降级 UI 提示。

## 0. 一行接入

```js
const pluginJournal = require('./plugin-journal');   // 主进程顶部，与 diag-log 同一批 require

pluginJournal.record({
  action: 'install',            // 必填，见 §1 白名单
  plugin: 'dsh-chrome',         // 必填：插件名（不带版本）
  version: '0.1.3',             // 可选：版本号（未知就留空，不要编）
  source: 'registry',           // registry | local | profile | legacy | unknown
  result: 'ok',                 // 'ok' | 'fail' | { status:'fail', code:'EACCES' }
  reason: 'EACCES',             // 可选：原因码（失败时强烈建议给，便于归因）
  phase: 'running'              // startup | running | shutdown | update
});
```

字段语义：

| 字段 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `action` | string | ✅ | `install` / `enable` / `disable` / `uninstall` / `isolate` / `restore` / `startup-skip` | 其它值会记成 `unknown` 并计入 `status().invalidActions`（可见降级，不静默） |
| `plugin` | string | ✅ | 插件名 | 超 200 字符会截断并标 `truncated` |
| `version` | string | ⬜ | 版本号 | 超 64 字符截断 |
| `source` | string | ⬜ | `registry` / `local` / `profile` / `legacy` / `unknown` | **只记类别**，不要传完整路径或私有 registry URL |
| `result` | string \| object | ⬜ | `'ok'` / `'fail'` / `{status:'ok'\|'fail', code}` / `true` / `false` | 缺省按 `ok` |
| `reason` | string | ⬜ | 原因码（`EACCES`/`EISOLATE`/`EPERM`…） | 超 120 字符截断；凭据样式自动打码 |
| `phase` | string | ⬜ | `startup` / `running` / `shutdown` / `update` / `unknown` | 进程阶段 |

## 1. 必接的 6 处（按收益排序）

### ① `plugins:install` 通道 — `main.js:2747`（`handleIpc('plugins:install', …)`）

| 时刻 | 动作 | entry |
|---|---|---|
| 安装**开始前**（拿到 `spec`/`profile` 后，`mgr.installPluginViaCli` 之前） | 不记（避免与结果重复；高频动作不写两条） | — |
| `installPluginViaCli` 返回 `ok:true` | `install` | `{action:'install', plugin: <包名>, version: <解析到的版本，可留空>, source: <见下>, result:'ok', phase:'running'}` |
| 返回 `ok:false` | `install` | `result: {status:'fail', code: r.code}` + `reason: r.timedOut ? 'ETIMEDOUT' : 'EINSTALL'` |
| `catch (e)` 分支 | `install` | `result: {status:'fail', code:'ETHROW'}`，`reason: e.code \|\| 'ETHROW'` |

`source` 判定（**不要**把 spec 原文写进台账）：`spec` 以 `http`/`npm:` 开头或形如包名 → `registry`；
以 `.`/盘符/`/`/`\\`/`.tgz` 结尾 → `local`。包名从 `spec` 里取「最后一个 `/` 之后、`@版本` 之前」，
`spec` 带 `@scope/name` 时保留 scope。

### ② `plugins:import-legacy` 通道 — `main.js:2782`

| 时刻 | 动作 | entry |
|---|---|---|
| `importLegacyPlugins` 返回后，按 `summary.results[]` **逐条**记 | `install` | `{action:'install', plugin: x.name, source:'legacy', result: x.ok ? 'ok' : (x.skipped ? {status:'ok', code:'ESKIP'} : {status:'fail', code:'EIMPORT'}), phase:'running'}` |

> 注意：`ESKIP`（跳过）记 `result:'ok'` + `reason:'ESKIP'`，不要记成 fail —— 否则崩溃报告
> 里"失败"会虚高，反而误导归因。

### ③ 自愈 1c：日志点名的插件包禁用 — `main.js:919`（`mgr.disableFailingBundles`）

| 时刻 | 动作 | entry |
|---|---|---|
| `res1c.disabled.length > 0` 时，**逐条**记 | `disable` | `{action:'disable', plugin: <bundle 名>, source:'profile', result:'ok', reason:'ELOADFAIL', phase:'startup'}` |
| 若 `res1c` 抛错/为空 | 不记 | — |

### ④ 客户端注册失败的单插件禁用 — `main.js:2549`

| 时刻 | 动作 | entry |
|---|---|---|
| `mgr.disableFailingBundles(paths.dshHome, [name])` 返回且 `res.disabled.length > 0` | `disable` | `{action:'disable', plugin: name, source:'profile', result:'ok', reason:'ECLIENTREG', phase:'running'}` |

### ⑤ 启动预检：恢复此前被误禁用的条目 — `main.js:3022`

| 时刻 | 动作 | entry |
|---|---|---|
| `restored.restored` 非空时，逐条 | `restore` | `{action:'restore', plugin: <r.name 或 r.id>, source:'profile', result:'ok', reason:'EPREFLIGHT-MISFIRE', phase:'startup'}` |

### ⑥ 启动失败自愈：profile 隔离 — `main.js:1068`（`mgr.quarantineProfiles`）

| 时刻 | 动作 | entry |
|---|---|---|
| `qRes && qRes.quarantined` | `isolate` | `{action:'isolate', plugin:'(profiles)', version:'', source:'profile', result:'ok', reason: qRes.fallback ? 'EQUARANTINE-EMPTY' : 'EQUARANTINE', phase:'startup'}` |
| `quarantineVerdict.allowed === false`（护栏阻止） | `isolate` | `{action:'isolate', plugin:'(profiles)', source:'profile', result:{status:'fail', code:'EGUARD'}, reason: quarantineVerdict.reason, phase:'startup'}` |

> `isolate`/`restore` 的**失败**会被模块自动镜像到 diag-log 的 durability 层
> （`writeDurable`，返回即可读）—— 接线方不需要额外做什么，别重复记。

## 2. 建议接（不影响验收，但能显著提升归因率）

| 位置 | 动作 | 说明 |
|---|---|---|
| `main.js:807/873`（`disableBrokenPatchPlugins`） | `disable` | 逐条记被禁用的补丁条目（`reason:'EPATCHBROKEN'`） |
| `main.js:1087`（`restoreProfileRegistrations`） | `restore` | 隔离后回填注册的插件（`reason:'EQUARANTINE-RESTORE'`） |
| `main.js` 启动预检里**禁用冲突条目**的那一步（`findLoaderIdConflicts` 之后） | `startup-skip` | 逐条记 `{reason:'ELOADERID-CONFLICT', phase:'startup'}` |
| 安全模式启动（`safeMode`） | `startup-skip` | `{plugin:'(all-plugins)', source:'profile', result:'ok', reason:'ESAFEMODE', phase:'startup'}` |

## 3. 退出/崩溃路径（模块已自带，接线方**不需要**额外调用）

- `process 'exit'`、`app 'will-quit'`、包装 `app.exit`、包装 `process.exit` —— 四路钩子由模块
  自己装（阶段一实测：Electron `app.exit()` 既不触发 quit 事件也不走 Node 的 `exit`）；
- `crash-report.js` 会在写报告时自己 `flush(300ms)` 再取快照 → 崩溃现场不需要主进程手动 flush；
- 如果将来想"更新后重启前一定落盘"，可在 `restartApp()` 里加一行
  `pluginJournal.flush(pluginJournal.EXIT_FLUSH_DEADLINE_MS)`（可选，不必须）。

## 4. 排障须知

| 想知道 | 怎么查 |
|---|---|
| 台账文件在哪 | `<logs>/plugin-operations/plugin-operations-1.log`（当前段）、`-2.log`（上一段） |
| 是否丢过记录 | `pluginJournal.status()`：`dropped`（累计丢弃）、`failed`、`disabled`、`queuedBytes` |
| 台帐是否停用 | `status().disabled === true` + `status().lastError` |
| 崩溃报告里的那一段 | 标题 `recent plugin operations (context, not proof of cause)`；末尾 `[collection complete] records=… dropped=… ledger=…` |
| 不能拿它干什么 | **不能**当因果证据（标题里写死了 context, not proof of cause）；不得喂给自愈阶梯做 needs-proof 判定 |
