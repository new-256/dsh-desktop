# 官方版本比对：0.2.1-alpha.2（10-11 基线）→ 0.2.1-rc.2（10-17 最新）

> 产出：**版本比对组** · 2026-10-20
> 口径：只读调查 + 资料检索，**未修改任何业务文件**（唯一写入是本报告）。
> 证据等级：凡标「实读」的都有文件路径:行号；凡标「未验证」的表示本机读不到或无法确证。

---

## 0. 结论摘要（TL;DR）

| # | 结论 | 证据强度 |
|---|---|---|
| 1 | **本机官方后端 = `0.2.1-alpha.5`**；npm 上 `@deepseek-ai/dsh` 最新 = **`0.2.1-rc.2`**（10-17 08:36 发布，此后 3 天无新版本）。**我们落后 1 个 rc 线。** | 实读 |
| 2 | **官方 Electron 壳层（`apps/desktop/src`）从 10-11 到今天只改了 5 个文件、新增 1 个。** 壳层几乎没动；这轮的新能力**几乎全在 Web 客户端与后端包**里。 | 实读（git diff） |
| 3 | 壳层唯一的**新能力 = 更新通道（`nightly` / `latest`）**：`update-channel.ts` 新文件 + 通道进包内 manifest + `allowPrerelease` 随通道变化 + `latest` 通道拒绝预发布版本 + 强制更新策略头改用真实通道。 | 实读（行号见 §2.2） |
| 4 | **官方 DSH 没有 crash reporter，也没有 exit-reason 记录机制。** 无 crashpad、无 Electron `crashReporter`；"崩溃报告"是应用自己写的纯文本日志；退出**原因**根本不落盘。 | 实读（`git grep` + 逐文件读） |
| 5 | **我们在崩溃/退出取证上已经领先官方**：`lifecycle-log.js`（0.3.46，本轮其他组正在做）记 start/exit 原因码，还能识别「有 start 无 exit」＝外部强杀。官方这个盲区是**空的**。 | 实读 |
| 6 | 真正值得从官方补的**壳层缺口只有 2 个**：`render-process-gone` 与 `preload-error` 处理器（官方有，我们没有）——直接对应"应用静默消失/渲染层崩了没证据"。 | 实读（对比 main.ts:1110-1118 vs main.js） |
| 7 | 官方 rc.1 顺手修掉的 **Windows 保留端口段导致起不来**——**我们已天然免疫**（我们 `--port 0` 由系统分配）。 | 实读 |
| 8 | 官方**没有更新回滚**（`allowDowngrade=false`、无 rollback 路径）；**我们有**（`rollbackDsh` / `backend:rollback-to` / `stageDsh` 保留旧版本）。我们领先。 | 实读 |
| 9 | 官方托盘只有 2 项（打开/退出）；**我们的托盘是灾备控制台**（分阶段菜单、balloon、自愈入口）。我们领先，**不建议照抄官方托盘**。 | 实读 |
| 10 | **操作风险（与本次事故直接相关）**：官方 npm 的 `latest` 标签在各子包上**严重陈旧且不一致**；而我们的 `scripts/install-backend.js` **默认 `DSH_VERSION=latest`、未锁定** ⇒ 构建不可复现，且会静默吃到 rc。**建议立刻钉版本。** | 实读 |

---

## 1. 版本事实

### 1.1 本机安装的官方后端

| 项 | 值 | 来源 |
|---|---|---|
| 运行时 wrapper | `dsh-active-backend@0.0.0`（private），依赖 `@deepseek-ai/dsh: 0.2.1-alpha.5` | `C:\Users\lcl\AppData\Roaming\DSH Desktop\backend\dsh\package.json` |
| **`@deepseek-ai/dsh`** | **`0.2.1-alpha.5`** | `…\backend\dsh\node_modules\@deepseek-ai\dsh\package.json` |
| **`@deepseek-ai/dsh-base`** | **`0.2.1-alpha.5`** | 同上目录 |
| `dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-slots` | `0.2.1-alpha.2` | 同上（版本较旧，未随 alpha.5 升） |
| `dsh-hook-protocol` / `dsh-hooks-claude-code` / `dsh-hooks-codex` / `dsh-invariants` / `dsh-subagent-in-process-driver` / `dsh-webhook` / `dsh-webhook-github` / `dsh-experimental-schedule-bundle` | `0.2.0-rc.2` | 同上（rc.2 线以下，**未随 alpha.5 升**） |
| `libreoffice-kit` / `libreoffice-kit-win32-x64` | `0.1.5` | 同上 |
| `node-addon-system` | `0.1.2` | 同上 |
| `cordis` / `cordis-plugin-*` / `cosmokit` / `schemastery` | `4.0.5` / `1.0.5` / `1.0.10` / `1.0.6` / `1.1.7` / `1.8.6` / `3.18.5` | 同上 |
| `@deepseek-ai/dsh-*` 总数 | **约 240 个包，全部对齐在 `0.2.1-alpha.5`**（除上表 8 个例外） | 枚举 `node_modules\@deepseek-ai` |

**关键观察**：本机后端是 **`alpha` 通道**（npm dist-tag `alpha=0.2.1-alpha.5`），**不是** `latest`（= rc.2）。也就是说**我们跑的是官方 alpha 线，不是最新线**。而 npm 上 `latest` 现在指向的是**候选版 rc.2**。

### 1.2 npm registry 现状（`registry.npmjs.org`，2026-10-20 实查）

`@deepseek-ai/dsh`：

```
dist-tags:  latest = 0.2.1-rc.2   alpha = 0.2.1-alpha.5   next = 0.2.1-rc.2
最近一次发布: 0.2.1-rc.2  @ 2026-10-17 08:36:31
```

`@deepseek-ai/dsh-base`：

```
dist-tags:  latest = 0.0.1-rc.1   alpha = 0.2.1-alpha.5   next = 0.2.1-rc.2
最近一次发布: 0.2.1-rc.2  @ 2026-10-17 08:27:40
```

> ⚠️ **注意 `latest` 标签的语义陷阱**：对**元包** `@deepseek-ai/dsh` 而言 `latest=0.2.1-rc.2` 是对的；但对**子包**而言 `latest` 严重陈旧，见 §6 附录 B。**任何"按 latest 装子包"的做法都会拿到错版本。**

### 1.3 官方发布节奏（10-11 基线 → 10-20）

| 版本 | npm 发布时间 | GitHub Release 发布时间 | 相对基线 |
|---|---|---|---|
| `0.2.1-alpha.2` | 2026-10-09 08:18:00 | 2026-10-09 11:09:26 | ← **10-11 比对基线** |
| `0.2.1-alpha.3` | 2026-10-14 12:35:33 | 2026-10-14 13:32:15 | 新增 |
| `0.2.1-alpha.4` | 2026-10-15 13:08:08 | 2026-10-15 13:40:02 | 新增 |
| `0.2.1-alpha.5` | 2026-10-16 12:31:49 | 2026-10-16 12:23:28 | 新增（**本机当前版本**） |
| `0.2.1-rc.1` | 2026-10-17 03:17:24 | 2026-10-17 05:22:10 | 新增 |
| `0.2.1-rc.2` | 2026-10-17 08:36:31 | 2026-10-17 08:16:33 | 新增（**当前最新**） |
| — | 10-17 之后至今 | — | **无新版本**（10-18/19/20 静默） |

GitHub 仓库：`github.com/deepseek-ai/deepseek-harness`，tag 形如 `dsh-v0.2.1-rc.2`（**注意 tag 前缀是 `dsh-`**，直接用 `v0.2.1-rc.2` 查 release 会 404）。

### 1.4 ⚠️ 基线校准（重要纠错，上一轮报告的读法要改）

上一轮 `lab\official-compare\README.md` 标题写的是「**0.3.42 → 0.3.44**」。
**那是我们自己项目的版本，不是官方版本**——README 里的「0.3.42（7 项）/ 0.3.43（2 项）/ 0.3.44（5 项）」是**我们落地的修复批次**（对应我们 `package.json` 的 `dsh-desktop` 版本号；我们现在是 `0.3.45`，`main.js` 里已出现 0.3.46 的在途改动）。

**官方桌面壳包的版本号与 CLI 同线**（实测）：

| 官方 `apps/desktop/package.json`（name = `@deepseek-ai/dsh-desktop`） | version |
|---|---|
| 基线 commit `d7432673`（tag `dsh-v0.2.1-alpha.2`） | `0.2.1-alpha.2` |
| HEAD commit `687f282e`（tag `dsh-v0.2.1-rc.2`） | `0.2.1-rc.2` |

⇒ **官方桌面端 10-11 → 10-20 的跨度是 `0.2.1-alpha.2` → `0.2.1-rc.2`**，共 5 个发布。

---

## 2. 官方桌面壳层这轮到底变了什么（硬证据）

### 2.1 `apps/desktop/src` 只动了 5 个文件

```bash
git diff --stat d7432673 687f282e -- apps/desktop/src
  apps/desktop/src/main.ts                    | 7 +++++--
  apps/desktop/src/mandatory-update-policy.ts | 3 ++-
  apps/desktop/src/update-channel.ts          | 17 +++++++++++++++++   ← 新增
  apps/desktop/src/update-coordinator.ts      | 7 +++++--
  apps/desktop/src/update-dialog.ts           | 6 +++++-
```

`git diff --diff-filter=ADR`（只列新增/删除/重命名）= **仅 `A apps/desktop/src/update-channel.ts`**，无删除、无其他新增。

HEAD 时 `apps/desktop/src` 共 **69 个文件**（基线 68 个）。

> **结论**：官方 Electron 壳的主进程代码在这一轮**几乎没动**。上一轮比对报告说官方壳有 65 个 TS 模块——现在 69 个，净增 1 个。
> **这直接改变了"可借鉴性"的判断基础**：壳层能借鉴的东西这轮几乎没有；有借鉴价值的全在**后端包与 Web 客户端**（即我们通过后端升级自动获得的能力，不需要改我们的壳）。

### 2.2 唯一的新壳层能力：**更新通道（nightly / latest）**

官方新增 `apps/desktop/src/update-channel.ts`（全文 17 行）：

```ts
/** Resolve the update channel sealed into the installed application manifest. */
export type DesktopUpdateChannel = 'nightly' | 'latest'

export function desktopUpdateChannel(manifest: unknown): DesktopUpdateChannel {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  if (!('dshDesktopUpdateChannel' in manifest)) return 'nightly'      // 老 manifest 保持原行为
  const channel = manifest.dshDesktopUpdateChannel
  if (channel !== 'nightly' && channel !== 'latest') throw new Error('desktop update: invalid packaged channel')
  return channel
}
```

配套改动（行号已逐一核对）：

| 文件:行 | 内容 |
|---|---|
| `main.ts:587-588` | 启动时读 `app.getAppPath()/package.json`，`desktopUpdateChannel(manifest)` 解析通道 |
| `main.ts:642` | 把 `updateChannel` 注入 `DesktopUpdateCoordinator` 构造 |
| `update-coordinator.ts:71` | `this.updater.channel = channel`（原来是硬编码 `'nightly'`） |
| `update-coordinator.ts:72` | `this.updater.allowPrerelease = channel === 'nightly'`（`latest` 通道不再接受预发布） |
| `update-coordinator.ts:74` | `allowDowngrade = false`（保持不变，**官方仍禁止降级**） |
| `update-coordinator.ts:192` | `if (this.channel === 'latest' && version.includes('-')) throw new Error('desktop update: latest feed contains a prerelease')` ← **稳定通道拒绝预发布版本**，是一条硬闸 |
| `mandatory-update-policy.ts:162` | 强制更新策略的头从写死 `'nightly'` 改为 `this.identity.channel`（`x-client-update-channel`） |
| `update-dialog.ts:139-142` | Windows 上 `window.hide()` 先于 `window.destroy()`——**释放窗口模态**，否则别的应用无法获得前台焦点 |

**设计要点（值得抄的思想，不值得抄代码）**：
1. **通道是"封进安装包 manifest 的"**，不是运行时探测的 → 同一份安装包永远走同一通道，通道错配不会在用户机器上漂移。
2. **非法值直接 throw，绝不降级回默认通道** → 通道配置错了要炸出来，不许静默换 feed。
3. **`latest` 通道遇到预发布版本直接拒绝** → 防止"稳定通道"意外被 rc 污染。

### 2.3 这轮新增的官方包（11 个，`packages/` 树 diff）

| 仓库路径 | 推测的 npm 包名 | npm 上是否已发布 | 桌面相关性 |
|---|---|---|---|
| `packages/boot/plugin-market` | `@deepseek-ai/dsh-plugin-market` | ✅ latest=`0.2.1-alpha.4` / next=`0.2.1-rc.2` | **插件市场（启动期）** |
| `packages/client/ui-plugin-market` | `@deepseek-ai/dsh-client-ui-plugin-market` | ✅ latest=`0.2.1-alpha.4` / next=`0.2.1-rc.2` | **插件市场 UI** |
| `packages/util/plugin-market-index` | `@deepseek-ai/dsh-plugin-market-index` | ✅ | 插件索引源（自定义源） |
| `packages/experimental/plugin-market-bundle` | `@deepseek-ai/dsh-experimental-plugin-market-bundle` | ✅ | 插件市场组合包 |
| `packages/client/ui-secret-mask` | `@deepseek-ai/dsh-client-ui-secret-mask` | ✅ latest=`0.2.1-alpha.3` | **密钥/令牌脱敏 UI** |
| `packages/api/remote-access` | `@deepseek-ai/dsh-api-remote-access` | ✅ latest=`0.2.1-alpha.3` | **远程访问 API** |
| `packages/context/harness-dev-context` | `@deepseek-ai/dsh-harness-dev-context` | ✅ | 开发者上下文 |
| `packages/client/ui-deepseek-model-label-1017` | `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` | 未单独核对 | 模型标签（配合 V4.1-Flash-1017） |
| `packages/web/web-deepseek-api` | `@deepseek-ai/dsh-web-deepseek-api` | 未单独核对 | DeepSeek Search/Fetch API |
| `packages/experimental/cua` | `@deepseek-ai/dsh-experimental-cua` | ❌ **npm 上不存在** | 计算机操作（CUA），仅源码 |
| `packages/experimental/cua-macos` | `@deepseek-ai/dsh-experimental-cua-macos` | 未单独核对 | macOS CUA，仅源码 |

`packages/` 顶层目录数 **58 → 58，无删除**。

---

## 3. 桌面端相关能力逐项评估

> 评估维度：(a) 官方怎么做（包名/路径/行为）→ (b) 我们有没有 → (c) 借鉴价值 + 成本 + 优先级。
> 「我们」的现状以本轮实读为准；注意 `main.js` / `updater-backend.js` / `lifecycle-log.js` / `plugin-resolution.js` / `patch-file.js` 在 2026-10-20 20:54–20:59 之间**被其他组并发修改中**，引用行号可能随合并漂移。

### 3.1 壳层（Electron 主进程）

| # | 能力 | (a) 官方怎么做 | (b) 我们有没有 | (c) 价值/成本 | 优先级 |
|---|---|---|---|---|---|
| S1 | **更新通道 nightly/latest** | `apps/desktop/src/update-channel.ts`（新增 17 行）；`update-coordinator.ts:71-72,192`；`mandatory-update-policy.ts:162`；`main.ts:587-588,642`。通道封进安装包 manifest，非法值 throw，`latest` 拒绝预发布 | ❌ **完全没有通道概念**。`main.js:1652-1653` 只有 `autoDownload=false` / `autoInstallOnAppQuit=true` | **高**。本机后端跑的是 `alpha` 线（`0.2.1-alpha.5`），官方 `latest` 已是 rc.2——没有通道就等于"永远跟 latest 走"，吃到坏版本无法分流。<br>成本：**低-中**（壳侧约 60 行 + 打包侧 manifest 字段 + 后端打包的 tag 选择） | **A** |
| S2 | **`render-process-gone` 处理器** | `main.ts:1112-1118`：渲染进程非 `clean-exit` 消失 → `reportFatal(new Error('Desktop renderer exited: '+reason), 'renderer')`，走统一崩溃报告 + 恢复弹窗 | ❌ **没有**。`main.js:1343` 有 `console-message`、`:1427` 有 `did-fail-load`，但**渲染进程崩溃本身没有被监听** | **高**。渲染层崩了/被 OOM 杀掉时，我们目前是"窗口变白但壳不报错"，事后无证据——**这正是本次事故"应用静默消失"最可能的形态之一**。<br>成本：**极低**（一个 listener + 复用现成 `writeCrashReportBounded`） | **A** |
| S3 | **`preload-error` 处理器** | `main.ts:1110-1111`：preload 加载失败 → `reportFatal(error,'renderer')` | ❌ **没有**。我们的 `preload.js` 只有 524 字节，但一旦出错会静默 | **中**。preload 崩了等于整个 IPC 桥断掉，用户看到的是"按钮全无反应"。<br>成本：**极低**（1 个 listener） | **A** |
| S4 | **Windows 模态释放** | `update-dialog.ts:139-142`：`hide()` 先于 `destroy()` | ➖ **不适用**。我们没有独立更新窗口（用的是原生 `dialog.showMessageBox`），无模态窗口可泄漏 | 无 | **C**（仅当我们将来做更新遮罩时再想起） |
| S5 | **强制更新闸门（mandatory-update-policy）** | `mandatory-update-policy.ts`：轮询远端策略服务，可**阻断应用使用**直到更新完成；带认证与退避 | ❌ 没有。我们是"只播报、用户确认才下载"（`main.js:1650-1653`）——这是**有意的产品选择** | **低**。第三方打包壳贸然阻断用户 = 失去信任；且该机制依赖官方策略服务端，第三方无服务端。<br>成本：高（需自建策略服务） | **C（不借鉴）** |
| S6 | **托盘** | `apps/desktop/src/tray.ts`：全 33 行。**只有 2 项**（打开应用 / 退出应用）+ tooltip；图标**全程存在**（不只在窗口隐藏时）；`dispose()` 在退出确认后调用，"不让死图标比进程活得久" | ✅ **我们更丰富**：`main.js:1100-1126` 托盘图标分阶段启用、`trayMenuTemplate()` 是灾备控制台、含 `displayBalloon` 提示、后端没起来时托盘**就是**恢复入口 | **不建议抄**。我们的托盘是"后端挂掉时唯一还能自救的通道"（`main.js:1516-1531`），换成官方的 2 项菜单会**削弱**我们的事故恢复能力。<br>唯一可抄的小点：官方 `tray.dispose()` 的时机注释——我们 `main.js:203` 已经做了 | **C（不借鉴）** |
| S7 | **退出前确认（quit confirmation）** | `quit-confirmation.ts`：向 Host 发结构化 `quit-inspection`，拿 `{activeTasks, scheduledTasks}`；`unknown` 按"有任务"处理；防重入合并 | ✅ 已有且更保守：`quit-guard.js`（保守语义：后端存在且曾就绪 ⇒ 可能有任务） | 不需要抄 | **C** |
| S8 | **更新 journal** | `update-journal.ts`：每进程一个 JSONL（`<ts>-<uuid>.jsonl`），**白名单字段**（phase / targetVersion / percent / failedOperation / errorCode∈8 类白名单），`flush:true` 逐条落盘，错误全文**永不落盘** | ✅ 我们**更强**：`updater-backend.js:3339-3420` 的 `update-journal.json` 是**跨进程持久**的，还有 `staged→applied→verified` 三态，`main.js:2596-2603` 已有读取端（0.3.42 修的"只写不读"） | 不需要抄。官方 journal **没有 verified 概念**，无法回答"上次更新到底生效没有"——这正是我们 0.3.42 修过的坑 | **C** |
| S9 | **更新回滚** | **官方没有**：`allowDowngrade=false`（`update-coordinator.ts:74`），无 rollback 代码路径 | ✅ 我们有：`updater-backend.js:3685 rollbackDsh()`、`main.js:2084 backend:rollback-to`、`stageDsh` 保留上一版 | 官方无可抄 | **C** |
| S10 | **`autoInstallOnAppQuit`** | 官方 `false`（`update-coordinator.ts:70`）——下载完不会随退出自动装 | ⚠️ 我们 `main.js:1653` 是 **`true`**。但我们 `update-downloaded` 处理器里**已经**弹窗要用户确认才 `quitAndInstall()`（`:1665-1670`），所以 `autoInstallOnAppQuit=true` 在我们这儿**基本是死设置**（除非用户错过弹窗后直接退出） | **中**。建议改为 `false` 与官方一致，消除"错过弹窗即静默安装"的尾巴。<br>成本：**极低**（改 1 个字 + 回归一次） | **B** |
| S11 | **端口分配** | rc.1 修复："桌面端默认使用系统分配的端口，避免 Windows 保留端口范围导致应用无法启动" | ✅ **已天然免疫**：`main.js:417` 后端参数就是 `['web','--no-open','--port','0','--host','127.0.0.1']`，端口由系统分配 | 官方这个坑我们没有。**不需要抄**——但值得写进结论文档作为"已覆盖" | **C** |
| S12 | **崩溃报告（自写文本）** | `crash-report.ts`（本轮**未改动**）：`crash-<ISO>-<source>.log`，source ∈ `host|web-boot|renderer|main`，头部事实 + `inspect` 错误段（256KiB 上限）+ Host 诊断 + 渲染层 error 级 console 尾巴（64KiB），保留 10 份 | ✅ 已对齐：`crash-report.js`（0.3.39/0.3.42/0.3.44 三轮加固：1s 落盘上限、`wx` 不覆盖、source 白名单） | 不需要抄 | **C** |
| S13 | **原生崩溃转储** | **官方没有**：全仓 `git grep -i "crashpad|crashReporter"` 在 `apps/desktop` 与 `packages` 下**零命中** | ➖ 我们的 `lifecycle-log.js:11` 注释也写明"本机 crashpad 未启用" | **双方都没有**。若要 native dump 需自行接 `crashReporter.start()`。**不是官方做法，别指望抄** | **C** |
| S14 | **权限处理** | `microphone-permissions.ts`（本轮**未改动**）：只对 `media` 权限收紧——必须主框架 + `dsh-app://app` 源 + **仅音频**（`mediaTypes.length===1 && [0]==='audio'`）；非 media 权限 `callback(true)` 放行；macOS 额外走 `askForMediaAccess` | ✅ 已有且更完备：0.3.44 的**按敏感度分级** handler（`main.js:1265-1320`），上轮结论是"官方全盘拒绝照搬会废掉正当功能" | 官方这轮**收敛**到与我们相同的方向（按敏感度而非全盘），说明我们 0.3.44 的判断方向正确。可参考的是它的**判据**：`mediaTypes` 必须是"仅音频"（挡住摄像头/屏幕共享） | **B**（微调：我们的 handler 是否也区分 `mediaTypes` 只允许 audio？） |
| S15 | **开发者工具面板** | rc.1：实验性开发者工具组合包——会话原始日志、聊天分组 ↔ 正文双向定位、内嵌 NodeJS 调试 | ❌ 我们没有（`main.js:1361` 注释提到"不再分发 `--remote-debugging-port`"，是刻意关闭的） | **中**。会话原始日志 + 双向定位对"用户报障 → 我们定位"极有价值，且它是**插件形态**（装在后端里），**不碰我们的壳**。<br>成本：**中**（需要后端 profile 装这个实验包 + 前端入口） | **B** |

### 3.2 后端 / Web 客户端侧（我们改壳就能受益或需后端配合）

| # | 能力 | (a) 官方怎么做 | (b) 我们有没有 | (c) 价值/成本 | 优先级 |
|---|---|---|---|---|---|
| C1 | **"任务已停止"（意外退出后的任务状态）** | alpha.3 引入：应用意外退出后，未完成任务明确显示"任务已停止"而不是"正常完成"。实现在 Web 客户端 `dsh-client-ui-chat`（`lib/client.js:5358`：`node.code === "ACCOUNT_SIGNED_OUT" \|\| node.code === "INTERRUPTED"` → `t("message.taskStopped")`；中文串在 `:5879`，英文在 `:6073`） | ✅ **本机后端已包含**（alpha.5 ≥ alpha.3） | **高**——直接对冲"应用没了，任务状态说不清"。**零壳层成本**：升级后端即得。但**我们必须确认前端 locale 是否已含该串**（本机 `dsh-client-ui-chat` 已含） | **A（验证+利用）** |
| C2 | **凭据文件多余字段不再阻止启动** | alpha.3 修复 | ❓ **未验证**我们后端升级后是否已解 | **高**（启动鲁棒性）。升级后端即得，**只需验证** | **A（验证）** |
| C3 | **API Key 优先级变更** | alpha.3/rc.1：Web 端/桌面端**优先使用已保存的凭据**；headless 改用环境变量与 `.env` | ⚠️ 我们跑 `dsh web`（属 Web 端），行为会随升级改变 | **中**。需确认我们桌面端的凭据来源符合预期（避免升级后行为翻转导致"模型突然用错 Key"） | **B** |
| C4 | **插件市场 / 自定义插件索引源** | alpha.4 + rc.1：新增 `packages/boot/plugin-market`、`packages/client/ui-plugin-market`、`packages/util/plugin-market-index`；允许从"自定义插件索引源"发现并安装插件；Official 列表可按需安装与当前发布版匹配的 Claude Code / Codex 组合包 | ⚠️ 我们有自研插件安装（`updater-backend.js` 的 `plugins:install`）与 `settings.html` 插件页，但**没有"市场/索引源"概念** | **中-高**。第三方打包壳做市场 = 要自己维护源与签名，**成本高、风险大**。可低成本借鉴的是 **"组合包显示代码来源与当前版本"**（rc.1 体验优化）——我们的插件页正缺这个可追溯性 | **B（仅借鉴"来源与版本可追溯"）** |
| C5 | **插件热重载 / 依赖同步** | alpha.3 + rc.1：插件更新或重装后**不再跑旧代码**；可热重载的直接生效，不可热重载的提示重启；启用/停用/卸载/更新时同步依赖 | ⚠️ 我们有 `plugin-resolution.js`（本轮 20:54 并发新增）与 `updater-backend.js` 的插件隔离/兼容报告 | **高**（与本次事故"插件加载失败"直接相关）。rc.1 明确写了"插件包元信息不可读 → 整个 DeepSeek 请求被阻断"的修复——**这条对第三方壳尤其重要**。升级后端即得 | **A（升级后端 + 验证）** |
| C6 | **插件兼容性按 `engines.dsh` 优先判断** | alpha.4「其他变更」 | ⚠️ 我们有 `pluginCompatibilityReport` / `disableIncompatiblePlugins`（`updater-backend.js:4410`） | **中**。我们已有自己的兼容判定；官方改为"优先信 `engines.dsh`"是个更准的信号源，可作为**补充判定依据** | **B** |
| C7 | **语音输入 + 麦克风选择** | rc.1：语音输入新增麦克风选择，插件详情页可选输入设备并看**实时输入电平** | ➖ 我们壳无麦克风 UI（在后端 Web 客户端里） | **低-中**。依赖 `dsh-experimental-voice-input-bundle`（本机已有）。壳层零成本 | **C** |
| C8 | **Git Worktrees 插件** | rc.1：实验性 Git Worktrees 插件，Agent 可创建并进入独立 Git checkout | ➖ 后端侧实验包（本机已有 `dsh-experimental-tool-worktree` / `dsh-experimental-worktree`） | **中**。对我们的多智能体协作流程（子代理并行改代码）直接有用；零壳层成本 | **B** |
| C9 | **`working_directory` 工具 + SDK 读取/切换会话工作目录** | rc.1 | ➖ 后端侧（本机 alpha.5 尚未含？**未验证**） | **中**。对"子代理在独立工作树里跑"是基础设施 | **B** |
| C10 | **会话 UI：字号分档 + Cmd/Ctrl ±** | alpha.3 + rc.1：可分别设置**界面正文 / 代码与工具输出 / 侧栏终端**的字体与字号；桌面端 Cmd/Ctrl + ± 统一调整 | ❌ 我们的 Electron 壳**不接管前端缩放**（`main.js` 无 `setZoomLevel`/无 `zoomFactor` 处理） | **中**。用户抱怨"字太小"时我们目前无解。壳层可做 `webContents.setZoomLevel` 的键盘拦截，**成本低**（在 `before-input-event` 里拦 `Ctrl/Cmd + +/-`） | **B** |
| C11 | **新会话预填未发送提示 / 草稿保留文件·目录·会话引用** | rc.1 | ➖ 前端侧 | **中**。UX 改进，用户可感知 | **C** |
| C12 | **工作步骤收起时机可配置** | rc.1 | ➖ 前端侧 | **低** | **C** |
| C13 | **自动化任务改为 Web 内置能力** | rc.1「其他变更」 | ➖ 后端侧 | **中**。定时/自动化是桌面端常用场景，值得在升级后确认可用 | **C** |
| C14 | **远程访问（`dsh-api-remote-access`）+ `--public-url` / TLS 监听 / 页面内目录选择器** | rc.1：`packages/api/remote-access` 新增；Web 支持 `--public-url`（含反代路径前缀）、`--tls-cert/--tls-key` 原生 HTTPS、绑定指定 IPv4/IPv6；"允许远程主机访问的 Web 配置使用页面内目录选择器，不再在服务器上弹原生目录对话框" | ❌ 我们后端是 `dsh web --port 0 --host 127.0.0.1`，**只监听回环** | **中**。"页面内目录选择器"这条**对我们价值不大**（我们本机无远程）；`--public-url` 概念可用于将来做"局域网访问" | **C** |
| C15 | **网关授权 / API 连接** | rc.1「其他变更」：完善网关授权与连接机制，按调用方身份控制资源访问 | ➖ 后端侧 | **低-中** | **C** |
| C16 | **SSH 独立可执行 helper 运行时** | rc.1 | ➖ 后端侧 | **低**（我们是桌面本地场景） | **C** |
| C17 | **密钥/令牌自动脱敏** | alpha.3 + `dsh-client-ui-secret-mask` | ➖ 前端侧 | **中**（安全）。**注意与我们的 `assertOwnedSender` 无关**——那是来源校验，不是内容脱敏 | **B** |
| C18 | **DeepSeek-V4.1-Flash-1017 / Search & Fetch API** | rc.2 | ➖ 后端/模型侧 | **低**（与壳无关） | **C** |
| C19 | **Windows Desktop 终端退出后 PTY 后台进程未清理** | rc.1 修复 | ➖ 我们的终端由后端 `dsh-terminal-bash` 托管，**不在壳里** | **中**（后端侧，影响我们跑的 `dsh web`） | **B（升级后端即得）** |
| C20 | **Windows 持久 PowerShell 大量输出后调用不结束** | rc.1 修复 | ➖ 后端侧（`dsh-pwsh-local` / `dsh-pwsh-sandbox`） | **中**（我们 Windows 环境高发） | **B（升级后端即得）** |
| C21 | **Windows 安装器磁盘根目录校验（拒绝重复末尾分隔符）** | rc.1 修复 | ⚠️ 我们的安装器是自研 NSIS（`build/installer.nsh`），**不共用官方的** | **中**。同类校验我们自己要写（NSIS 侧） | **B** |
| C22 | **Windows Desktop 图片预览遮罩/关闭按钮与标题栏重叠** | rc.1 修复 | ➖ 前端/壳渲染层 | **低** | **C** |
| C23 | **Page Up 在右栏收起时把整个界面推向左** | alpha.5 修复（Windows/Linux） | ➖ 前端侧 | **低** | **C** |

### 3.3 明确"不值得抄"的（避免重复上轮的错误结论）

| 官方做法 | 为什么这轮也不该抄 |
|---|---|
| `ELECTRON_RUN_AS_NODE` 双树架构 | 上轮已证伪（ABI 不兼容，native 模块按 137 编译）。本轮**官方也没改**，说明它没被采纳为"更好方案" |
| `stop()` 三段式 `shutdown→SIGTERM→SIGKILL` | 上轮已证伪（Windows 上 SIGTERM/SIGKILL 等价）。本轮官方仍无改进 |
| `update-overlay` 更新遮罩（`dsh-app://` 路由 + 专用 preload） | 本轮**官方只改了它的 Windows 模态释放**，没有改架构。我们仍不需要 |
| 官方 11 个 preload 拆分 | 本轮无变化。我们的单 preload + 随机端口模型不变 |
| 官方 `core-package-set.ts` | 本轮无变化。仍是发布期签名校验器（2 个包、失败全 throw） |
| **官方托盘（2 项菜单）** | **本轮新增结论**：我们的托盘是灾备控制台，比官方强，**照抄会削弱事故恢复能力** |
| **官方更新 journal（每进程 JSONL、无 verified 态）** | **本轮新增结论**：我们的是跨进程持久 + 三态 + 已有读取端，**比官方强**，且上轮修过的"只写不读"坑我们已填 |

---

## 4. 与本次事故直接相关：官方到底有没有 crash reporter / exit-reason？

### 4.1 结论：**都没有。**

| 机制 | 官方 DSH | 我们 DSH Desktop |
|---|---|---|
| crashpad / Electron `crashReporter` | ❌ **无**。`git grep -i "crashpad\|crashReporter"` 在 `apps/desktop` + `packages` 下零命中 | ❌ 无（`lifecycle-log.js:11` 注释亦确认"本机 crashpad 未启用"） |
| 原生 minidump | ❌ 无 | ❌ 无 |
| 自写崩溃报告 | ✅ `apps/desktop/src/crash-report.ts`（纯文本，非 native dump） | ✅ `crash-report.js`（已对齐 + 三轮加固） |
| **退出原因（exit reason）落盘** | ❌ **无**。没有任何文件记录"这个进程为什么退出" | ✅ **`lifecycle-log.js`（0.3.46 在途）**：每实例 `start` + 每条退出路径 `exit(reason)`，append-only JSONL 台账 + `session-<pid>.json` 快照；`readOrphanSessions()` 识别"有 start 无 exit"＝外部强杀/断电。**已确认 `main.js` 内 19 处接线点覆盖全部退出路径**（含 `exit-event` 兜底） |
| 渲染进程崩溃监听 | ✅ `main.ts:1112` `render-process-gone` → `reportFatal(...,'renderer')` | ❌ **缺** |
| preload 崩溃监听 | ✅ `main.ts:1110` `preload-error` → `reportFatal(...,'renderer')` | ❌ **缺** |
| 退出前"有什么会被打断"检查 | ✅ `quit-confirmation.ts` → 向 Host 发 `quit-inspection`，拿 `{activeTasks, scheduledTasks}` | ✅ `quit-guard.js`（保守语义，因我们跑 `dsh web` 无结构化接口） |
| 意外退出后的任务状态 | ✅ alpha.3「任务已停止」（前端 `dsh-client-ui-chat`） | ✅ 后端已含（alpha.5），**待端到端验证** |

### 4.2 官方实际有的"退出侧"机制（细节）

1. **`quit-confirmation.ts`** — 退出前问 Host「有没有在跑的东西」。`resolveDesktopQuitPrompt(inspection)` 三个分支：`activeTasks` / `scheduledTasks` / 两者都有；**`inspection === 'unknown'`（问失败或超时）按 `quitActiveTasks` 处理**——即"拿不准就当作有任务，宁可多问一次"。防重入：`pending` promise 合并重复退出请求。
2. **`render-process-gone`（`main.ts:1112-1118`）** — `details.reason !== 'clean-exit'` 且非 quitting 时 → `reportFatal(new Error('Desktop renderer exited: '+reason), 'renderer')`。**这是官方唯一会把"崩溃"转成可归因证据的渲染层入口。**
3. **`background-notice.ts` + `background-close-confirmed` 标记文件**（`main.ts:1000`）— 记住"用户确认过关到后台"，下次启动不再重复提示。**这是状态标记，不是退出原因记录。**
4. **`platform-view.ts:104`** 注释："Sanitize persisted authentication even after an unclean previous process exit." —— 官方对**不干净退出**只做**防御性清理**，**不记录、不上报**。这坐实了 §4.1 的结论。
5. **`update-journal.ts`** — 只覆盖**更新**流程的证据（白名单字段、逐条 flush、每进程一个 JSONL）。**不是退出/崩溃台账。**

### 4.3 结论性判断（写进结论文档的话）

> 官方 DSH **没有** crash reporter（无 crashpad / 无 `crashReporter`），**也没有** exit-reason 记录机制。
> 官方"崩溃报告"是应用自己在恢复弹窗前写的**纯文本诊断文件**（`crash-report.ts`），覆盖"应用自己知道怎么死了"的情况；对**进程被外部杀死**这种它无感的情况，官方**不留任何痕迹**。
> **我们在这一点上不是"落后官方"，而是"领先官方"**——`lifecycle-log.js` 的 start/exit 台账 + 孤儿实例识别，正是官方缺失的那一环。
> 因此本次事故相关的"官方可借鉴项"应当这样表述：
> **不是**去抄官方的崩溃上报（它没有），
> **而是**补齐官方有而我们没有的**两个渲染层监听**（`render-process-gone` / `preload-error`），
> 让我们的生命周期台账能覆盖"渲染层崩了"这一类官方能覆盖、我们目前覆盖不到的死角。

---

## 5. 可借鉴特性清单（按优先级）

### A 级（建议本轮就做）

| # | 特性 | 一句话结论 | 落点 | 成本 |
|---|---|---|---|---|
| A1 | **补 `render-process-gone` 监听** | 官方 `main.ts:1112` 有、我们没有——渲染层被 OOM/崩溃杀掉时我们目前完全无证据，补上后直接写进已有崩溃报告，**是本次事故取证盲区的最小补丁** | `main.js`（`createMainWindow` 邻域，约 `:1427` `did-fail-load` 旁） | 极低（~10 行） |
| A2 | **补 `preload-error` 监听** | 同上，官方 `main.ts:1110` 有、我们没有；preload 挂掉＝IPC 桥断，用户表现为"点啥都没反应" | `main.js` 同处 | 极低（~5 行） |
| A3 | **引入更新通道（nightly/latest）** | 官方本轮唯一的新壳层能力；我们没有通道概念、默认 `DSH_VERSION=latest` 未锁定，构建不可复现且会静默吃 rc；通道应**封进安装包 manifest**、非法值 throw、`latest` 拒绝预发布 | `main.js`（updater 初始化 `:1620-1675`）+ `scripts/install-backend.js` + 打包 manifest | 低-中 |
| A4 | **把 `DSH_VERSION` 从 `latest` 钉成精确版本** | 官方 npm 各子包 `latest` 标签严重陈旧（`dsh-app-boot` 的 latest 还是 `0.1.0-rc.6`），且 `latest` 现在指向 rc；我们 `install-backend.js:38` 默认 `latest` ⇒ **同一份代码两次打包得到两个后端** | `scripts/install-backend.js:38` + 打包流水线 | 极低（改默认值 + CI 传参） |
| A5 | **升级官方后端到 `0.2.1-rc.2` 并端到端验证** | 我们落后一整条 rc 线（当前 `0.2.1-alpha.5`）；rc.1 含**直接对冲本次事故**的修复："插件包元信息不可读 → 整个 DeepSeek 请求被阻断"、"凭据多余字段阻止启动"、"Windows 终端退出后 PTY 进程未清理"、"持久 PowerShell 大量输出后不结束"、"任务已停止" | `updater-backend.js`（`stageDsh`） | 中（需回归） |
| A6 | **验证"任务已停止"链路** | 官方 alpha.3 引入，机制在 `dsh-client-ui-chat` 的 `INTERRUPTED` 分支；本机后端**已含**该包与中文串，但需确认我们壳的实际会话能正确显示——这是"应用没了任务状态说不清"的用户可见解法 | 端到端验证脚本 | 低 |

### B 级（值得排期）

| # | 特性 | 一句话结论 | 成本 |
|---|---|---|---|
| B1 | `autoInstallOnAppQuit` 改 `false` | 官方 `update-coordinator.ts:70` 是 `false`；我们 `main.js:1653` 是 `true`，虽被弹窗挡住大部分，但仍有"错过弹窗即静默安装"的尾巴 | 极低 |
| B2 | `Cmd/Ctrl + ±` 调整字号 | 官方 rc.1 桌面端支持统一调正文/代码/终端字号；我们的壳完全没接管前端缩放，`before-input-event` 拦一下即可 | 低 |
| B3 | 插件包"代码来源 + 当前版本"可追溯 | 官方 rc.1 的组合包详情页显示来源与版本；我们的插件页正缺这个可追溯性，**低成本高可信度** | 低-中 |
| B4 | 麦克风判据对齐官方 | 官方 `microphone-permissions.ts` 的判据是"主框架 + 仅音频（`mediaTypes` 只有一个且为 audio）"；核对我们 0.3.44 的分级 handler 是否也区分 `mediaTypes`（挡摄像头/屏幕共享） | 低 |
| B5 | 插件兼容判定补 `engines.dsh` 优先 | 官方 alpha.4 改为"优先按 `engines.dsh` 判断"；比我们的版本区间启发式更准，可作补充判据 | 低-中 |
| B6 | 开发者工具组合包（会话原始日志 + 双向定位） | 官方 rc.1 实验包；是**插件形态**，不碰我们的壳；"用户报障 → 精确定位"价值高 | 中 |
| B7 | 密钥/令牌自动脱敏 | 官方 alpha.3 + `dsh-client-ui-secret-mask`；后端升级即得，需验证 | 低 |
| B8 | Git Worktrees / `working_directory` 工具 | 官方 rc.1；多智能体并行改代码的基础设施，后端侧 | 中 |
| B9 | NSIS 磁盘根目录校验 | 官方 rc.1 修了"拒绝带重复末尾路径分隔符的根目录"；我们用自研 NSIS，**没有这道校验** | 低 |
| B10 | API Key 优先级变更的回归验证 | 官方改为"Web/桌面端优先用已保存凭据"，会改变我们升级后的取 Key 行为，需回归确认 | 低 |

### C 级（不借鉴 / 仅记录）

| # | 特性 | 一句话结论 |
|---|---|---|
| C1 | 官方托盘（2 项菜单） | **不抄**——我们的托盘是后端挂掉时唯一的灾备入口，官方那个更弱 |
| C2 | 官方更新 journal（每进程 JSONL） | **不抄**——我们的跨进程持久 + 三态 + 已有读取端更强 |
| C3 | 强制更新闸门（mandatory-update-policy） | **不抄**——依赖官方策略服务端，且第三方壳阻断用户得不偿失；我们维持"只播报、用户确认" |
| C4 | Windows 模态释放（`hide()` 先于 `destroy()`） | 现在不适用（我们无独立更新窗口），将来做更新遮罩时再记 |
| C5 | 语音输入麦克风选择 / 自动化任务内置化 / `--public-url` / TLS / SSH helper / 网关授权 | 后端或纯前端能力，壳层零成本、优先级低，**升级后端自然获得**，不必单独立项 |
| C6 | 原生 crashpad / minidump | **官方也没有**，不是"借鉴"范畴；若要做得自己接 `crashReporter.start()`，单独立项 |

---

## 6. 方法学、证据边界与不确定性声明

### 6.1 方法

- **官方源码**：重新拉取了稀疏检出 `github.com/deepseek-ai/deepseek-harness`（`--filter=blob:none --sparse`，仅 `apps/desktop` + `.agents`），置于 `C:\Users\lcl\AppData\Local\Temp\dsh-official-1020`。上一轮用的 `...\Temp\dsh-official` **已被系统清理**，无法复用。
  - 注：Temp 下的检出目录属**新建的临时副本**，未触碰 `C:\Users\lcl\Desktop\DSH` 下的任何业务文件。
- **版本比对**：基线 = tag `dsh-v0.2.1-alpha.2`（commit `d7432673`），最新 = tag `dsh-v0.2.1-rc.2`（commit `687f282e`）。用 `git diff --stat` / `--diff-filter=ADR` / `git ls-tree` 取证，**不依赖 changelog 描述**。
- **npm 数据**：`registry.npmjs.org` 直查 `dist-tags` + `time` 字段（2026-10-20 实查）。
- **changelog**：GitHub Releases API 取 `dsh-v*` tag 的 body（注意 tag 带 `dsh-` 前缀）。
- **我们侧**：`main.js` / `updater-backend.js` / `crash-report.js` / `quit-guard.js` / `lifecycle-log.js` / `scripts/install-backend.js` 实读 + grep 定位。

### 6.2 不确定 / 未验证（按上轮纪律显式标注）

1. **本轮 `main.js` / `updater-backend.js` / `lifecycle-log.js` / `plugin-resolution.js` / `patch-file.js` 正被其他组并发修改**（文件 mtime 落在 2026-10-20 20:54–20:59）。本报告引用的行号是**该时刻的快照**，合并后可能漂移。`lifecycle-log.js` 的内容我按"0.3.46 在途实现"处理；接线我**只做了 grep 定位，未逐行读**。
   - 已确认的接线点（`main.js` 内 **19 处** `lifecycle.*` 调用）：启动 `lifecycle.start('boot'|'boot-hidden', {...})`（`:36`）；未捕获异常 `lifecycle.crash('uncaught-exception', ...)`（`:41`）；启动致命失败 `lifecycle.crash('startup-fatal', ...)`（`:1523`）；退出路径覆盖 `tray-quit`（`:202`）、`user-exit-dialog`×4（`:581/:645/:690/:2455`）、`backend-crashed-close`（`:975`）、`quit-app`（`:1158`）、`restart`（`:2036`）、`second-instance`（`:2224`）、`quit-confirmed`（`:2649/:2650`）、`quit-no-backend`（`:2653`）、`quit-guard-error`（`:2660`）、`system-shutdown`（`:2631`）、`exit-event` 兜底（`:2667`，"进程 exit 事件（未标注更具体原因）"）。
   - ⇒ 官方**完全没有**的"退出原因记录"，我们**已覆盖到每一条退出路径**，并有 `exit-event` 兜底。这条结论比 §4.3 的表述更强。
2. **`packages/` 内部实现本轮仍读不全**：稀疏检出只含 `apps/desktop` 与 `.agents`；对 `packages/**` 只做了**目录树 diff**（新增 11 个包）与 **npm 元数据核对**，未逐文件读实现。凡涉及这些包内部行为的表述，均为**基于包名 + npm 发布事实 + changelog 措辞**的推断，**不是实读**。
3. **官方 changelog 里标 "Desktop" 的条目**，绝大多数指**桌面端用户可见的 Web 客户端能力**（字体、语音、终端），**不是 Electron 壳代码**。本报告已把它们分到 §3.2 而非 §3.1，以免误判为"要改我们的壳"。
4. **官方是否已发布 `0.2.1` 正式版**：截至 2026-10-20 20:xx 实查，npm/GitHub 均**无** `0.2.1` 正式版，最新仍是 `0.2.1-rc.2`。若报告落笔后官方发了正式版，§1.3 表需刷新。
5. **`@deepseek-ai/dsh-experimental-cua` 未发布到 npm**（实查 404）⇒ CUA 目前**不可消费**，只能读源码。
6. 本轮**未**逐字读完 `C-interaction-lifecycle.md` / `B-update-system.md` 全文（只按需检索），故对"上一轮已落地项"的复述以 `README.md` 摘要为准；凡与摘要冲突处**以本轮实读为准**。

### 6.3 与上一轮报告的关系

- 本轮**不推翻**上一轮的三条"不能照抄"结论（`ELECTRON_RUN_AS_NODE`、三段式 stop、11 preload 拆分）——官方**本轮也没动**这些点，说明它们仍是官方现状，不是我方误读。
- 本轮**新增**三条"不能照抄"：**官方托盘更弱**、**官方更新 journal 更弱**、**官方无 crash reporter / 无 exit-reason 记录**。
- 本轮**新增**一条"我们领先"：**生命周期台账**（退出原因取证）。
- 本轮**新增**两条"我们要补"：**`render-process-gone`**、**`preload-error`**。

---

## 附录 A：官方更新通道实现（可直接对照的最小代码）

```ts
// apps/desktop/src/update-channel.ts（新增，全文 17 行）
export type DesktopUpdateChannel = 'nightly' | 'latest'

export function desktopUpdateChannel(manifest: unknown): DesktopUpdateChannel {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  if (!('dshDesktopUpdateChannel' in manifest)) return 'nightly'
  const channel = manifest.dshDesktopUpdateChannel
  if (channel !== 'nightly' && channel !== 'latest') throw new Error('desktop update: invalid packaged channel')
  return channel
}
```

```ts
// apps/desktop/src/update-coordinator.ts:69-74
this.updater.autoDownload = false
this.updater.autoInstallOnAppQuit = false
this.updater.channel = channel
this.updater.allowPrerelease = channel === 'nightly'
// Selecting a channel can enable downgrade in electron-updater.
this.updater.allowDowngrade = false
```

```ts
// apps/desktop/src/update-coordinator.ts:192
if (this.channel === 'latest' && version.includes('-')) throw new Error('desktop update: latest feed contains a prerelease')
```

```ts
// apps/desktop/src/mandatory-update-policy.ts:162
'x-client-arch': this.identity.arch, 'x-client-update-channel': this.identity.channel,
```

## 附录 B：npm `dist-tag` 陈旧对照表（2026-10-20 实查）

| 包 | `latest` | `alpha` | `next` | 最后发布 |
|---|---|---|---|---|
| `@deepseek-ai/dsh` | **0.2.1-rc.2** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:36 |
| `@deepseek-ai/dsh-base` | ⚠️ **0.0.1-rc.1** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:27 |
| `@deepseek-ai/dsh-app-boot` | ⚠️ **0.1.0-rc.6** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:18 |
| `@deepseek-ai/dsh-client-ui-chat` | ⚠️ **0.1.2-alpha.2** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:37 |
| `@deepseek-ai/dsh-host-frontend-static` | ⚠️ **0.0.1-rc.3** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:35 |
| `@deepseek-ai/dsh-plugin-market` | ⚠️ **0.2.1-alpha.4** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:28 |
| `@deepseek-ai/dsh-client-ui-plugin-market` | ⚠️ **0.2.1-alpha.4** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:28 |
| `@deepseek-ai/dsh-api-remote-access` | ⚠️ **0.2.1-alpha.3** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:19 |
| `@deepseek-ai/dsh-client-ui-secret-mask` | ⚠️ **0.2.1-alpha.3** | 0.2.1-alpha.5 | 0.2.1-rc.2 | 0.2.1-rc.2 @ 10-17 08:34 |

**用法规则（建议写进我们的安装器注释）**：
1. 要装**元包** `@deepseek-ai/dsh@<精确版本>`——它会把全部子包钉在同一版本（我们本机 240 个包对齐在 `0.2.1-alpha.5` 即此机制）。
2. **绝不**单独用 `latest` 装任何 `@deepseek-ai/dsh-*` 子包——上表 9 个包里 8 个的 `latest` 是错的。

---

## 附录 C：0.3.46 的落地决议（Lead 拍板，2026-10-20）

本报告由**版本比对组**产出后，Lead 在 0.3.46 里逐条做了取舍。**已落地 / 已推迟 / 明确不抄**：

| 报告条目 | 决议 | 落地方式与理由 |
|---|---|---|
| **A1 `render-process-gone`** | ✅ 已落地 | `main.js` 新增监听：写退出原因台账（`renderer-gone`）+ 写独立崩溃报告（source=renderer）。渲染层被 OOM/被杀此前**零证据** |
| **A2 `preload-error`** | ✅ 已落地（并加一条） | 除 `preload-error` 外顺手加了 `unresponsive`（渲染层卡死），两者都进台账备注 |
| **A3 更新通道（nightly/latest）** | ⏸ 推迟 | 官方这轮唯一的**新壳层能力**。我们已有 `settings.json` 的 `npmRegistry`（mirror/official）但**没有** nightly 通道语义。推迟理由：通道切换会改变"装哪个后端"的语义，必须与 §附录B 的 dist-tag 陷阱一起设计，否则用户会静默吃到错版本 |
| **A4 后端版本钉死** | ✅ 已落地 | `scripts/install-backend.js` 默认 `DSH_VERSION` 从 `latest` 改为**精确版本 `0.2.1-alpha.5`**（本壳真机验证过的版本），并重装了 vendor 树、重新打包。理由见报告 §结论 10：`latest` 是移动靶 + 子包 dist-tag 严重不一致 ⇒ 构建不可复现 |
| **A5/A6 后端升到 `0.2.1-rc.2`** | ⏸ 推迟（**下一步**） | rc.1/rc.2 含与本次事故直接对冲的修复（插件包元信息不可读阻断请求 / 凭据多余字段阻止启动 / Windows 终端退出后 PTY 未清理 / 意外退出后任务显示"任务已停止"）。但**换后端必须单独一轮验证**：本轮正在运行的实例就是 alpha.5，不能在自测过程中换掉它。验证清单见下 |
| 官方托盘 | ❌ 明确不抄 | 官方托盘只有 2 项；我们的是灾备控制台（分阶段菜单 + balloon + 自愈入口） |
| 官方更新 journal | ❌ 明确不抄 | 官方无 `verified` 态；我们有三态跨进程持久化 |
| 官方强制更新闸门 | ❌ 明确不抄 | 依赖其私有策略服务，无法自持 |

**A5/A6（后端升 rc.2）的验证清单**（下一轮执行，本轮不夹带）：

1. 停机备份 `backend/dsh` 与 `backend/dsh.previous`；记录当前版本与 `plugin-state.json`
2. 装 `0.2.1-rc.2` → 冷启动 → 看 `dsh-home/logs/startup-*.log` 有无 fatal
3. 核对 **240 个子包是否整体对齐到 rc.2**（对齐机制靠元包；单包子包版本滞后是官方现状）
4. 回归本次事故相关的四条：`mcp-cli-bridge-global` 等 5 条家级条目是否仍能挂载、`mcp__cli__*` 18 个工具是否齐全
5. 验凭据加载（rc.1 修过"凭据多余字段阻止启动"）
6. 验任务/会话恢复（rc.1 修过"意外退出后任务显示任务已停止"）
7. 保留回滚路径：`rollbackDsh` / `backend:rollback-to` 可一键退回 alpha.5

**我们已领先、不要被"官方没做"误导的地方**（报告 §结论 4/5/8/9 实读）：

- 官方**没有** crash reporter、**没有** exit-reason 记录 —— 本轮 0.3.46 新增的 `lifecycle-log.js`（start/exit 台账 + 孤儿实例识别）是我们自己的领先项
- 官方**没有**更新回滚（`allowDowngrade=false`）—— 我们有 `rollbackDsh` / `stageDsh` 保留旧版本
- 官方保留端口段的起不来问题（rc.1 修）—— 我们 `--port 0` 由系统分配，天然免疫

3. 需要预发布时显式用 `alpha` 或 `next` tag，不要依赖 `latest` 的语义。
