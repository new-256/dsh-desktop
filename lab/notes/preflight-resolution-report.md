# DSH Desktop 启动预检 `preflightBareNameResolution` 解析根错误 —— 调查报告

> 调查组：预检解析组（只读调查，未修改任何业务文件）
> 报告时间：2026-10-20 20:49（Asia/Shanghai；本次外网时间接口 timeapi.io / timeanddate.com / worldtimeapi.org 均被网络策略拦截，故取会话运行时时钟，已为北京时间时区）
> 调查范围：`C:\Users\<user>\Desktop\DSH`（桌面壳源码）、`C:\Users\<user>\AppData\Roaming\DSH Desktop\backend\dsh`（运行时 DSH 后端实现）、`C:\Users\<user>\AppData\Roaming\DSH Desktop\dsh-home`（运行时家目录）

---

## 0. 结论摘要（TL;DR）

**根因一句话**：`preflightBareNameResolution` 把「裸包名能否解析」建模成**从 profile 目录出发的纯 Node 向上 walk-up**；但 DSH 运行时真正解析裸包名时，除了 walk-up，还会经过 DSH 自己安装的 **runtime resolution interception（运行时解析拦截）**，其 **installation scope**（安装域）以 `backend\dsh\node_modules` 为根。`backend\dsh\node_modules` **不是** `dsh-home\profiles\<profile>` 的祖先目录，walk-up 永远看不到它 ⇒ `@deepseek-ai/dsh-mcp-client` 被判为"必然解析失败" ⇒ 2026-10-20 19:59:41 被自动注释禁用。

**关键证据（三条，互相独立）**

| # | 证据 | 位置 |
|---|---|---|
| E1 | Loader 对裸包名的**父路径**是 `ctx.baseUrl` = profile 目录 | `cordis-plugin-loader/src/config/tree.ts:121-122`；`lib/index.js:218` |
| E2 | `ctx.baseUrl` = `<profile>/`，由根 Include 配置文件目录决定 | `cordis-plugin-include/src/index.ts:188`；`dsh-app-boot/lib/index.js:4525`；`dsh/lib/profile-boot-C14i-8IN.js:289,302` |
| E3 | 运行时对裸包名安装了**解析拦截**，installation scope 覆盖 `backend\dsh\node_modules`（539 个包） | `dsh-app-boot/lib/index.js:1846, 3492-3508, 766-799, 716-760, 1613-1674` |

**实测复现（`backend\node.exe` 真实运行时，非推测）**

```
# 不装拦截（= 现有 preflight 的模型）
NATIVE import FAILED -> ERR_MODULE_NOT_FOUND  @deepseek-ai/dsh-mcp-client
NATIVE import FAILED -> ERR_MODULE_NOT_FOUND  @deepseek-ai/dsh-mcp-resources
# 装上 DSH 的拦截（= 真实运行时）
WITH INTERCEPTION import @deepseek-ai/dsh-mcp-client    => OK, exports: Config,apply,createMcpToolDefinition,inject,name
WITH INTERCEPTION import @deepseek-ai/dsh-mcp-resources => OK, exports: McpResourceRuntime,default
```

> 同一时刻、同一父路径、同一个 `loader.import()` 调用，只因是否安装 DSH 拦截而结论相反。**任何基于 walk-up 的静态判定都无法与运行时一致。**

---

## 1. 运行时解析链

### 1.1 环节 1 —— Loader 把裸包名交给 Node 时用的「父路径」= `ctx.baseUrl`

`C:\Users\<user>\AppData\Roaming\DSH Desktop\backend\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\src\config\tree.ts`

```ts
111:  /** Import a plugin module from a specifier or `cordis:` builtin. */
112:  import(name: string, getOuterStack?: () => string[]) {
113:    if (name.startsWith('cordis:')) {
114:      return this.ctx.loader.builtins[name.slice(7)]
115:    }
116:    return composeError(async (info) => {
120:      info.offset += 3
121:      if (this.ctx.loader.internal) {
122:        return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})   // ← 父路径 = ctx.baseUrl
123:      } else if (name.startsWith('.')) {
124:        return await import(/* @vite-ignore */new URL(name, this.ctx.baseUrl).href)
125:      } else {
126:        return await import(/* @vite-ignore */name)
127:      }
128:    }, getOuterStack)
129:  }
```

编译产物一致：`cordis-plugin-loader\lib\index.js:218`
```js
218:  if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
```

* `ctx.loader.internal` 何时可用：`cordis-plugin-loader\src\index.ts:85`
  `public internal = ModuleLoader.fromInternal()`；`src/internal.ts:131-143` 规定 Node ≥ 22 且能摸到 `internal/modules/esm/loader` 即返回。**实测本机 Node 24.21.0 返回 `v2`** ⇒ `internal` 分支恒成立。
* `ctx.baseUrl` 的初值：`src/index.ts:89-93`
  ```ts
  89:  constructor(ctx: Context, public config: Loader.Config = {}) {
  90:    super(ctx)
  91:    if (config.baseUrl) {
  92:      this.ctx.baseUrl = config.baseUrl
  93:    }
  ```
* 树上下文的 baseUrl 继承：`src/config/tree.ts:16` `this.ctx = ctx.extend({ baseUrl: ctx.baseUrl })`
* 谁调用 `EntryTree.import`：`src/config/entry.ts:226`
  `moduleNamespace = await this.parent.tree.import(this.options.name, this.getOuterStack)`

### 1.2 环节 2 —— `ctx.baseUrl` 最终 = 根 Include 配置文件所在目录 = profile 目录

1. `dsh-app-boot\lib\index.js:4507-4538`（`boot()`）
   ```js
   4507: async function boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl) {
   4525:   ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/";
   4535:   await ctx.plugin(Loader);
   4536:   await prepare?.(ctx);
   4538:   await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);
   ```
2. `dsh-app-boot\lib\index.js:4125-4146`（`mountRootInclude`）
   ```js
   4126:   ctx.loader.builtins.include = bareModuleBaseUrl === void 0 ? Include : class HostResolvedRootInclude extends Include {
   4134:     return internal.import(specifier, bareModuleBaseUrl, {});
   4138:   const prepared = prepareProfilePatches(ctx, [...patches], pathToFileURL(dirname(absoluteConfigPath)).href + "/", binName);
   4143:     path: pathToFileURL(absoluteConfigPath).href,
   ```
3. `cordis-plugin-include\src\index.ts`
   ```ts
   181:     this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
   188:     this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href   // ← 决定所有子条目的父路径
   ```
4. `absoluteConfigPath` 是什么：`dsh\lib\profile-boot-C14i-8IN.js`
   ```js
   120: const PROFILE_ROOT_FILENAME = "cordis.yml";
   289:   const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME);
   302:   const ctx = await boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, composed.profile), async (hostCtx) => { ... });
   ```
   ⚠ **第 5 个参数 `bareModuleBaseUrl` 没有传** ⇒ `bareModuleBaseUrl === undefined` ⇒ 走**原生 `Include`**，不启用 `HostResolvedRootInclude`（后者会用 `bareModuleBaseUrl` 作为裸包名父路径，与本机场景无关）。

**⇒ 运行时裸包名的父路径恒为：**

```
file:///C:/Users/lcl/AppData/Roaming/DSH%20Desktop/dsh-home/profiles/web/
```

### 1.3 环节 3 —— 家级补丁 / profile 补丁 / bundle 补丁共享同一个父路径

`dsh-app-boot\lib\index.js:1127-1137`
```js
1127: function readProfilePatches(binName, context, initialProfile) {
1128:   const patches = structuredClone([
1129:     ...readBundlePatches(binName, context, initialProfile),   // dsh-base / dsh-web-app 等 bundle 层
1130:     ...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [],  // profiles\web\cordis.patch.yml
1131:     ...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],         // dsh-home\cordis.patch.yml
1132:     ...context.overlays
1133:   ]);
```
这些 patch 全部作为**根 Include 的一条 patch** 应用（`dsh-app-boot:4138` + `4143-4146`），落进**同一棵 EntryTree** ⇒ **同一个 `ctx.baseUrl`**。

**⇒ `dsh-home\cordis.patch.yml`、`profiles\web\cordis.patch.yml`、`dsh-base\cordis.patch.yml` 里的行，运行时解析上下文完全相同。**

### 1.4 环节 4（决定性）—— 运行时真正的解析机制：DSH 的 runtime interception

DSH **不是**把裸包名直接丢给 Node 原生解析。它在 boot 阶段给 Node 的 ESM/CJS 解析器装了一层**路由拦截**。

**(a) 拦截的安装点**

`dsh-app-boot\lib\index.js:3492-3508`
```js
3492: var PluginPackages = class extends Service {
3497:   constructor(ctx, config = {}) {
3498:     super(ctx, "pluginPackages");
3499:     if (config.resolution === void 0) return;
3500:     this.current = config.resolution;
3501:     const interception = installRuntimeInterception(config.resolution);   // ← 装拦截
```
`dsh\lib\profile-boot-C14i-8IN.js:306`
```js
306:  await hostCtx.plugin(PluginPackages, { resolution: composed.resolution });
```
该调用发生在 `boot()` 的 `prepare` 阶段（`dsh-app-boot:4536`），**早于** `mountRootInclude`（`:4538`）⇒ **整棵插件树的挂载全程都在拦截之下**。

**(b) 解析表（resolution）的构成**

`dsh-app-boot\lib\index.js:766-799`（`createRuntimeResolution`）
```js
770:  const { packageNames, packageDirs, declarers, versions } = collectInstallationScopePackages(installAnchor, ...);  // installation scope
774:  const profilePackages = collectProfileScopePackages(profile, packageNames, profileDeclarers, profileVersions);    // profile scope
785:  entries: Object.freeze([...[...packageDirs].map(([name, packageDir]) => Object.freeze({
789:      declarer: declarers.get(name),
790:      scope: "installation"
791:    })), ...[...profilePackages].map(...)   // scope: "profile"
```
`dsh-app-boot\lib\index.js:716-760`（`collectInstallationScopePackages`）：以 installAnchor 的 manifest 为根，对 `dependencies + peerDependencies` 做 BFS（`profileDependencyNames`，`:712-714`），每个依赖的目录由 `packageDirFromAnchor`（`:976-982`，等价 `createRequire(anchor).resolve.paths(name)`）确定。

**installAnchor 是谁**：`dsh\lib\profile-boot-C14i-8IN.js:119`
```js
119: const INSTALL_ANCHOR = fileURLToPath(new URL("../package.json", import.meta.url));
```
`import.meta.url` = `…\backend\dsh\node_modules\@deepseek-ai\dsh\lib\profile-boot-C14i-8IN.js` ⇒
**`INSTALL_ANCHOR = C:\Users\<user>\AppData\Roaming\DSH Desktop\backend\dsh\node_modules\@deepseek-ai\dsh\package.json`**

**(c) 路由规则（决定裸包名最终从哪解析）**

`dsh-app-boot\lib\index.js:1613-1674`（`routeScoped`）
```js
1625:    const target = resolution.entries.get(name);
1628:    for (const searchPath of createRequire(parent).resolve.paths(name)) {
1629:      if (!searchPath.startsWith(layer.localPrefix)) break;      // 只认 profile 本地层
1631:      const candidate = localPackageCandidate(searchPath, name, flavor);
...
1664:    const route = target !== void 0 && (target.scope === "installation" || layer.active) ? {
1665:      kind: "interception",
1666:      entry: target,
1667:      after: layer.after
1668:    } : {
1669:      kind: "native-after-interception",
1670:      parent: layer.nativeAfter
1671:    };
```
命中 `interception` 后（`dsh-app-boot:1879-1889`）：
```js
1879:  const routedParent = pathToFileURL(route.kind === "interception" ? route.entry.declarer : route.parent).href;
1889:  result = native(request, routedParent, attributes);
```
⇒ **裸包名改从 `entry.declarer`（声明该依赖的 package.json）所在的 node_modules 链解析**，而不是从 profile 目录。

拦截层的归属（`dsh-app-boot:1326-1345`）：
```js
1326: function computeProfileLayer(dir, active) {
1327:   const profileParent = dirname(dir);
1331:     localPrefix: dir + sep,                        // <profile>\
1332:     nativeAfter: join(profileParent, "package.json"),
1333:     after: join(dirname(profileParent), "package.json")
1337: function findInterceptionLayer(path, resolution) { ... computeProfileLayer(dir, activeProfile !== void 0) ... }
```

**(d) 官方「这行到底能不能解析」的唯一判定 API**

`dsh-app-boot\lib\index.js:2261-2271`（`manifestOf`）
```js
2264:   const packages = ctx.get("pluginPackages");
2265:   const pkg = packages?.packageOf(specifier, parentURL);     // ← 走拦截后的路由器
2268:   if (bare !== void 0 && packages === void 0) for (const path of createRequire(parentURL).resolve.paths(bare)) { ... }
```
`dsh-app-boot\lib\index.js:3544-3555`（`packageOf`）→ `:1762-1777`（`packageDir`）→ `router.routeUrl(name, parentURL)`。

**⇒ DSH 自己判定"包在不在"的权威口径是 `pluginPackages.packageOf(name, parentURL)`，不是 walk-up。**

**(e) 顺带确认：DSH 官方预检根本不判裸包名**

`dsh-app-boot\lib\index.js:2311-2388`（`preflight`）：只做**插件兼容性**判定（`evaluatePluginCompatibility`），从不判"裸包名能否解析"；包解析失败一律交给 Loader 自己的 import 失败诊断（`dsh-app-boot:4318 importFailure`、`:4464 auditStartupEntries`）。

**⇒ 桌面的 `preflightBareNameResolution` 是桌面壳自创的检查，它必须自己承担"与运行时一致"的责任——而它没有。**

### 1.5 环节 5 —— 运行时探针实测（2026-10-20，`backend\node.exe`）

```
=== A. 不装拦截（= 现有 preflight 的模型） ===
NATIVE node_modules chain from ...\dsh-home\profiles\web
  ...\dsh-home\profiles\web\node_modules
  ...\dsh-home\profiles\node_modules
  ...\dsh-home\node_modules
  ...\DSH Desktop\node_modules
  ...\Roaming\node_modules
  ...\AppData\node_modules
  C:\Users\<user>\node_modules
  C:\Users\node_modules
  C:\node_modules
NATIVE import FAILED -> ERR_MODULE_NOT_FOUND  @deepseek-ai/dsh-mcp-client
NATIVE import FAILED -> ERR_MODULE_NOT_FOUND  @deepseek-ai/dsh-mcp-resources

=== B. 装上 DSH 拦截（= 真实运行时） ===
resolution.entries count = 539
  @deepseek-ai/dsh-mcp-client    -> scope=installation dir=...\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-client
  @deepseek-ai/dsh-mcp-resources -> scope=installation dir=...\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-resources
  @deepseek-ai/dsh-base          -> scope=installation dir=...\backend\dsh\node_modules\@deepseek-ai\dsh-base
  @luchenglong/cli-bridge        -> NOT IN TABLE
packageOf @deepseek-ai/dsh-mcp-client    => ...\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-client
packageOf @deepseek-ai/dsh-mcp-resources => ...\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-resources
packageOf @luchenglong/cli-bridge        => ...\dsh-home\profiles\web\node_modules\@luchenglong\cli-bridge
WITH INTERCEPTION import @deepseek-ai/dsh-mcp-client    => OK, exports: Config,apply,createMcpToolDefinition,inject,name
WITH INTERCEPTION import @deepseek-ai/dsh-mcp-resources => OK, exports: McpResourceRuntime,default
```

**关键点**：`@deepseek-ai/dsh-mcp-client` 与 `@deepseek-ai/dsh-mcp-resources` 在**原生**解析下**同样失败**；能成功的唯一原因是 DSH 的拦截把 `declarer` 换成了 `backend\dsh\node_modules\@deepseek-ai\dsh\package.json`。**这说明 walk-up 口径连"能正常工作的 dsh-base 条目"都会一起判死**——只是因为 dsh-base 的行不在桌面预检扫描范围内（预检只扫 `dsh-home\cordis.patch.yml` 与 `profiles\<p>\cordis.patch.yml`，见 `updater-backend.js:2959`），才没有暴露。

---

## 2. 有效解析根清单

### 2.1 运行时真实解析根集合（裸包名）

#### (A) 原生 walk-up 链（父路径 = `<profile>/`，实测 `createRequire` + Node ESM 规则）

| # | 目录 | 存在 | 内容 |
|---|---|---|---|
| A1 | `…\DSH Desktop\dsh-home\profiles\web\node_modules` | ✅ | 154 个顶层条目（见 §2.4） |
| A2 | `…\DSH Desktop\dsh-home\profiles\node_modules` | ❌ | — |
| A3 | `…\DSH Desktop\dsh-home\node_modules` | ✅ | 仅 `dsh-bot-gateway` + `.package-lock.json` |
| A4 | `…\DSH Desktop\node_modules` | ❌ | — |
| A5 | `…\AppData\Roaming\node_modules` | ❌ | — |
| A6 | `…\AppData\node_modules` | ❌ | — |
| A7 | `C:\Users\<user>\node_modules` | ✅ | 126 个顶层条目（全局残留：`codebuddy-first-bridge`、`dsh-bot-gateway`、`axios`、`vue`…） |
| A8 | `C:\Users\node_modules` | ❌ | — |
| A9 | `C:\node_modules` | ❌ | — |

#### (B) interception — **installation scope**（本报告核心）

| # | 目录 | 存在 | 内容 |
|---|---|---|---|
| B1 | `…\DSH Desktop\backend\dsh\node_modules\@deepseek-ai\dsh\node_modules` | ❌ | — |
| B2 | `…\DSH Desktop\backend\dsh\node_modules\@deepseek-ai\node_modules` | ❌ | — |
| **B3** | **`…\DSH Desktop\backend\dsh\node_modules`** | ✅ | **539 个 installation scope 包**：`@deepseek-ai/dsh-mcp-client` 0.2.1-alpha.5、`@deepseek-ai/dsh-mcp-resources` 0.2.1-alpha.5、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、… |
| B4 | `…\DSH Desktop\backend\node_modules` | ✅ | 仅 `npm` / `corepack`（非 dsh 包根，但同在 declarer 链上） |
| B5 | `…\DSH Desktop\node_modules` | ❌ | — |
| B6 | `…\AppData\Roaming\node_modules` / `…\AppData\node_modules` / `C:\Users\<user>\node_modules` / `C:\Users\node_modules` / `C:\node_modules` | 见 A5–A9 | 同 A 链 |
| B7 | `C:\Users\<user>\.node_modules` / `.node_libraries` / `…\DSH Desktop\backend\lib\node` | ❌/❌/❌ | Node 全局目录（不存在） |

B 链的实测来源：`createRequire('…\backend\dsh\node_modules\@deepseek-ai\dsh\package.json').resolve.paths('@deepseek-ai/dsh-mcp-client')`，与 `dsh-app-boot:976-982 packageDirFromAnchor` 完全同源。

**B3 就是"运行时真实解析根集合"里 desktop 预检缺失的那一个。**

#### (C) interception — profile scope

`dsh-app-boot:894-897 collectProfileScopePackages` ⇒ profile 各个 bundle（不在 installation scope 里的那些）的 `dependencies + peerDependencies` 闭包。实际落点：

| # | 目录 | 存在 | 说明 |
|---|---|---|---|
| C1 | `…\dsh-home\profiles\web\node_modules` | ✅ | profile 直接依赖 + bundle 依赖：`dsh-chrome`、`dsh-comfyui-bridge`、`dsh-kexi-crypto`、`dsh-repo-push-access`(link)、`dsh-user-rules`(link)、`web-search-panel`、`workbuddy-auth`、`@luchenglong/cli-bridge`、`@deepseek-ai/dsh-subagent-claude-code`、`@deepseek-ai/dsh-subagent-codex` |
| C2 | `…\dsh-home\profiles\web\node_modules\.pnpm` | ✅ | pnpm 虚拟store（当前仅 1 个条目） |
| C3 | `…\backend\dsh\node_modules` | ✅ | 与 B3 同一目录（bundle 依赖被提升到安装树） |

#### (D) 常见误认、实际**不是**解析根

| 目录 | 为什么不是 |
|---|---|
| `…\dsh-home\plugins\<x>\node_modules`（`playwright-mcp` 等） | 只被 `file://` 绝对路径引用，不参与裸包名解析 |
| `…\dsh-home\plugin-packages` | 只有 `dsh-kexi-crypto-1.9.22.tgz` 一个 tgz，不参与解析 |
| `…\dsh-home\plugins-store` | 插件市场缓存 |
| `…\backend\dsh.previous` | 旧后端树，未激活（`updater-backend.js:116`） |
| `…\backend\node_modules` | npm/corepack 专用（虽在 B 链上，但不是 dsh 包来源） |

### 2.2 运行时真实解析根集合（结论清单）

> 一个裸包名 `N` 在本机运行时**可解析**，当且仅当 `N` 落在下列根之一的 `node_modules\<N>` 下（且目录名 = 包名，Node 约定）：

```
R1  …\DSH Desktop\dsh-home\profiles\web\node_modules          （profile 本地层 / localPackageNames）
R2  …\DSH Desktop\dsh-home\node_modules                        （家级）
R3  C:\Users\<user>\node_modules                                  （用户级全局残留）
R4  …\DSH Desktop\backend\dsh\node_modules                     （installation scope，539 包）★ 预检缺失
R5  …\DSH Desktop\backend\node_modules                         （npm/corepack，无 dsh 包）
```

**其中 R4 是 `@deepseek-ai/dsh-mcp-client` / `@deepseek-ai/dsh-mcp-resources` 的唯一落点。**

### 2.3 关键推论：R4 对走 interception 的路径"不参与 walk-up"

`dsh-app-boot:1628-1629`
```js
for (const searchPath of createRequire(parent).resolve.paths(name)) {
  if (!searchPath.startsWith(layer.localPrefix)) break;   // 第一个不在 <profile>\ 前缀的路径就停
```
原生链在 `<profile>\node_modules` 之后立刻跳出 `localPrefix`，所以 **R4 永远不会作为 walk-up 命中**——它只能通过 `resolution.entries` 的 `declarer` 路由命中。**这正是"用 walk-up 判定"必然误判的机制性原因。**

### 2.4 `profiles\web\node_modules` 实际内容摘要

* 顶层条目 **154** 个；含 16 个 scope 目录：
  `@anthropic-ai(3) @aws(1) @aws-sdk(18) @babel(1) @deepseek-ai(7) @earendil-works(2) @google(1) @hono(1) @luchenglong(1) @modelcontextprotocol(1) @openai(2) @protobufjs(9) @smithy(6) @stablelib(1) @standard-schema(1) @types(2)`
* `@deepseek-ai` 下**恰好 7 个**：`cosmokit`、`dsh-brand`、`dsh-sdk-protocol`、`dsh-subagent-claude-code`、`dsh-subagent-codex`、`dsh-tool-subagent`、`schemastery`
  ⇒ **`@deepseek-ai/dsh-mcp-client` 不在这里**；`@deepseek-ai/dsh-mcp-resources` 也不在这里。
* 其余顶层：`dsh-chrome`、`dsh-comfyui-bridge`、`dsh-kexi-crypto`、`dsh-repo-push-access`(junction)、`dsh-user-rules`(junction)、`workbuddy-auth`、`web-search-panel`、以及 express/hono/openai/zod/ws/… 等第三方库
* 隐藏项：`.bin`、`.pnpm`、`.modules.yaml`、`.pnpm-workspace-state-v1.json`

### 2.5 复核结论（第 5 问）

| 问 | 答 | 证据 |
|---|---|---|
| `profiles\web\node_modules` 装过 `@deepseek-ai/dsh-mcp-client`？ | **否** | `@deepseek-ai` 下仅 7 个包（§2.4）；`.pnpm` store 仅 1 个条目 |
| `profiles\web\node_modules` 装过 cli-bridge 相关包？ | **是** | `@luchenglong\cli-bridge`（真实目录，非 junction） |
| `profiles\web\package.json` 里有 cli-bridge？ | **是** | `"@luchenglong/cli-bridge": "0.2.13"`（dependencies） |
| `profiles\web\pnpm-lock.yaml` 里有 cli-bridge？ | **是** | L17 `specifier: 0.2.13`；L274 `'@luchenglong/cli-bridge@0.2.13'`；L1279 快照 |
| `pnpm-lock.yaml` / `package.json` 里有 `dsh-mcp-client`？ | **否** | 全文件检索 `mcp-client` / `dsh-mcp` **零命中** |
| `profiles\web\package.json` 的 `dsh.profile.bundles` | 24 个 bundle，含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@luchenglong/cli-bridge` 等 | 见文件 |

---

## 3. preflight 应采用的根

### 3.1 现有实现的问题定位

`C:\Users\<user>\Desktop\DSH\updater-backend.js`

```js
2884: /**
2885:  * Node-style upward resolution check: does <name> exist as a directory in any
2886:  * node_modules on the walk-up chain from `dir`? ...
2891: function resolvesFromDir(dir, name) {
2892:   const segs = String(name).split('/');
2893:   let cur = path.resolve(dir);
2894:   for (;;) {
2896:     try { st = fs.statSync(path.join(cur, 'node_modules', ...segs)); } catch {}
2897:     if (st && st.isDirectory()) return true;
2898:     const parent = path.dirname(cur);
2899:     if (parent === cur) return false;
2900:     cur = parent;
2901:   }
2902: }
```

```js
2939: function preflightBareNameResolution() {
2946:   const profileDirs = [];                        // ← 起点只有 profiles\<p>
2948:     for (const d of fs.readdirSync(profilesDir, { withFileTypes: true })) {
2950:       const dir = path.join(profilesDir, d.name);
2951:       if (fs.existsSync(path.join(dir, 'package.json'))) profileDirs.push(dir);
2973:   for (const e of entries) {
2974:     if (profileDirs.some((dir) => resolvesFromDir(dir, e.name))) continue;   // ← 只查 A 链
2976:     const junctionPath = path.join(home, 'node_modules', e.name);
2978:       const realDir = findRealDirByPackageName(path.join(home, 'node_modules'), e.name);
2990:     out.broken.push({ file: e.file, id: e.id, name: e.name, reason: `包「${e.name}」在 node_modules 解析链里不存在，冷启动必然失败` });
```

**缺陷**：`profileDirs` 向上 walk 得到的链 = §2.1(A)，**永远不含 R4 `backend\dsh\node_modules`**（`backend` 与 `dsh-home` 是 `DSH Desktop` 下的**兄弟**目录，不是祖先）。
⇒ 凡是只存在于 installation scope 的官方包（`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-mcp-resources`、`@deepseek-ai/dsh-tool-*`…）**一律被判死**。

**旁证：预检的"自动修复"逻辑也暴露了同一认知偏差**
```js
2976:  const junctionPath = path.join(home, 'node_modules', e.name);
2978:  const realDir = findRealDirByPackageName(path.join(home, 'node_modules'), e.name);
2981:  fs.symlinkSync(realDir, junctionPath, 'junction');
```
它认为"包只可能装在 `dsh-home\node_modules`"，同样漏掉了 installation scope。

### 3.2 正确的判定规则（与运行时一致）

对裸包名 `N`，判定「运行时可解析」= 以下任一成立：

| 规则 | 判据 | 对应运行时机制 |
|---|---|---|
| **P1** | `N` 在 **profile 本地层**：`…\profiles\web\node_modules\<N>` 存在 | `dsh-app-boot:1628-1633`（localPrefix 命中） |
| **P2** | `N` ∈ **installation scope**：从 `INSTALL_ANCHOR`(= `P().dshPkg`) 出发的 `require.resolve.paths(N)` 中任一路径下存在 `\<N>\package.json` | `dsh-app-boot:716-760` + `:1664-1671` + `:1879-1889` |
| **P3** | `N` ∈ **profile scope**：profile 各 bundle manifest 的 `dependencies + peerDependencies` 闭包中的包 | `dsh-app-boot:894-897` |
| **P4** | `N` 在 **原生 walk-up 链**（profile 目录向上）任一 `node_modules\<N>` 下 | Node 原生（无 interception 时的兜底） |

> P2 覆盖了本次事故的全部条目：`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-mcp-resources`。

### 3.3 建议的最小改动（只改桌面预检，不动运行时）

在 `updater-backend.js` 增加 **installation scope 判定器**，并把它并入 `preflightBareNameResolution` 的判定：

```js
// ── 新增：与 DSH 运行时 installation scope 对齐的解析根 ──────────────
// 运行时 installAnchor = backend\dsh\node_modules\@deepseek-ai\dsh\package.json
// （dsh/lib/profile-boot-C14i-8IN.js:119），其依赖闭包即 installation scope
// （dsh-app-boot/lib/index.js:716-760 collectInstallationScopePackages）。
// 预检必须把这些包视为"可解析"，否则会误禁用官方包条目。
const { createRequire } = require('node:module');

/** 安装树（backend\dsh\node_modules）里是否有该裸包名。 */
function resolvesFromInstallTree(name) {
  const anchor = P().dshPkg;                       // …\backend\dsh\node_modules\@deepseek-ai\dsh\package.json
  let paths;
  try { paths = createRequire(anchor).resolve.paths(name) ?? []; } catch { return false; }
  for (const p of paths) {
    try { if (fs.statSync(path.join(p, name, 'package.json')).isFile()) return true; } catch {}
  }
  return false;
}

/** profile 依赖/bundle 依赖（profile scope）里是否有该裸包名。 */
function resolvesFromProfileScope(name) {
  const mods = path.join(dshHome(), 'profiles', 'web', 'node_modules');
  try { if (fs.statSync(path.join(mods, name, 'package.json')).isFile()) return true; } catch {}
  return false;
}
```

`preflightBareNameResolution` 的判定行改为：

```js
-    if (profileDirs.some((dir) => resolvesFromDir(dir, e.name))) continue;
+    if (profileDirs.some((dir) => resolvesFromDir(dir, e.name))) continue;   // P4 原生 walk-up
+    if (resolvesFromInstallTree(e.name)) continue;                          // P2 installation scope
+    if (resolvesFromProfileScope(e.name)) continue;                         // P3 profile scope
```

**判定口径的选择建议：保守放行（"看得见就不禁"）**
* 理由一：preflight 的动作是**禁用用户配置**（`updater-backend.js:2654-2698 disablePatchEntriesInFile`），误禁的代价（插件静默消失 + 用户配置被注释 + 需要手工恢复）远高于误放行。
* 理由二：真解析失败时，运行时自己有权威诊断：`dsh-app-boot:4318 importFailure` + `:4464 auditStartupEntries` 会把失败的 entry id / 原因打进启动日志。
* 理由三：**与 DSH 官方预检策略一致**——`dsh-app-boot:2311-2388` 的 `preflight` 从不判裸包名，只判兼容性。
* ⚠ 另需修正 `updater-backend.js:2990` 的 reason 文案「冷启动必然失败」——该断言在判定口径修正前根本不成立（`dsh-mcp-resources` 同样"走不到"却能正常加载）。建议改为「在该 profile 的解析链中找不到（安装域/本地域均已查）」。

### 3.4 修复后必须同步做的两件事

1. **恢复被误禁用的条目**（见 §4）：把 §4.1 表中 `name` 为 `@deepseek-ai/dsh-mcp-client` 的 5 个块、以及历史上被同一误判禁用的 `mcp-agy-global` / `mcp-codebuddy-global` / `mcp-playwright-global` / `mcp-mimo-global` 恢复（去掉 `# ` 前缀）。恢复源：对应的 `.disabled-*.bak` 备份。
2. **给预检补一条回归断言**：至少覆盖
   * `@deepseek-ai/dsh-mcp-client` ⇒ **不得**判 broken（installation scope）
   * `@deepseek-ai/dsh-mcp-resources` ⇒ **不得**判 broken（installation scope，且 dsh-base 已在用）
   * `@luchenglong/cli-bridge` ⇒ **不得**判 broken（profile scope）
   * `dsh-bot-gateway` ⇒ **不得**判 broken（`dsh-home\node_modules`）
   * `this-package-does-not-exist-xyz` ⇒ **必须**判 broken（真不存在）

### 3.5 一句话修复口径（可直接写进 commit）

> `preflightBareNameResolution` 的解析根集合必须等于
> `{ profile 本地层 } ∪ { profile scope } ∪ { installation scope = backend\dsh\node_modules } ∪ { 原生 walk-up 链 }`，
> 其中 installation scope 用 `createRequire(P().dshPkg).resolve.paths(name)` 枚举，与 `dsh-app-boot` 的 `packageDirFromAnchor` 同源。

---

## 4. 被误禁用条目清单

### 4.1 当前 `dsh-home\cordis.patch.yml` 的禁用/注释条目（现状快照）

文件：`C:\Users\<user>\AppData\Roaming\DSH Desktop\dsh-home\cordis.patch.yml`（482 行）

**仍生效的条目（3 条）**

| id | name | 行 |
|---|---|---|
| `session-cleaner` | `file:///C:/…/dsh-home/session-cleaner.plugin.mjs?v=9` | 13–17 |
| `local-llm-bridge` | `file:///C:/Users/lcl/Desktop/DSH/minicpm5-deploy/dsh-local-llm-bridge/index.mjs?v=7` | 40–51 |
| `bot-gateway` | `dsh-bot-gateway` | 81–94 |

**已被注释掉的条目（19 处，17 个 id）**

| id | name | 注释行范围 | 归因 |
|---|---|---|---|
| `agy-indicator` | `agy-first-bridge` | 133–135 | 人工/其它 |
| `agy-indicator-client` | `agy-indicator` | 136–150 | 人工/其它 |
| `plugin-manager` | `dsh-plugin-manager-plus` | 151–153 | 裸名，可能 preflight 误判 |
| `plugin-manager-client` | `dsh-plugin-manager-plus` | 154–191 | 人工/其它 |
| `file-reader-client` | `file-reader` | 192–214 | 人工/其它 |
| `codebuddy-indicator` | `codebuddy-indicator` | 215–217 | 裸名，可能 preflight 误判 |
| `codebuddy-indicator-client` | `codebuddy-indicator` | 218–235 | 人工/其它 |
| **`mcp-agy-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **236–260** | **preflight 误判** |
| **`mcp-codebuddy-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **261–289** | **preflight 误判** |
| `web-search` | `file:///C:/Users/lcl/Desktop/DSH/plugins/web-search/lib/index.mjs?v=8` | 290–295 | 人工（与 dsh-base 重复 id） |
| `web-search-client` | `web-search-panel` | 296–333 | 人工/其它 |
| `comfyui-bridge` | `dsh-comfyui-bridge` | 334–362 | **conflict 扫描**（与 profile bundle 重复） |
| **`mcp-playwright-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **363–379** | **preflight 误判** |
| `captain1275-dsh-pet` | `@captain1275/dsh-pet` | 380–397 | 人工/其它 |
| **`mcp-agy-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **398–409** | **preflight 误判** |
| **`mcp-codebuddy-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **410–421** | **preflight 误判** |
| **`mcp-playwright-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **422–453** | **preflight 误判** |
| **`mcp-mimo-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **454–473** | **preflight 误判** |
| **`mcp-cli-bridge-global`** | **`'@deepseek-ai/dsh-mcp-client'`** | **474–482** | **★ 2026-10-20 19:59:41 本次事故** |

### 4.2 本次事故（2026-10-20 19:59:41）精确定位

**备份文件**：`cordis.patch.yml.disabled-20261020-195941.bak`（40010 字节）
**机制**：`updater-backend.js:2654-2698 disablePatchEntriesInFile`
→ 逐行给目标条目的行加 `# ` 前缀（`:2674`），若块内全部条目被禁则连 `- insert:` 行一起注释（`:2680-2683`），先 `fs.copyFileSync` 备份为 `.disabled-<ts>.bak`（`:2689-2690`）。

**`git diff --no-index` 实测差异（备份 → 当前）**

```diff
@@ -502,13 +470,13 @@
-- insert:
-    - id: mcp-cli-bridge-global
-      name: '@deepseek-ai/dsh-mcp-client'
-      config:
-        serverName: cli
-        transport: stdio
-        command: 'C:\Users\<user>\AppData\Roaming\DSH Desktop\backend\node.exe'
-        args: ['…\dsh-home\profiles\web\node_modules\@luchenglong\cli-bridge\mcp\cli-bridge-mcp.mjs']
-        toolCallTimeoutMs: 900000
-      failOnStartupError: false
+#- insert:
+#    - id: mcp-cli-bridge-global
+#      name: '@deepseek-ai/dsh-mcp-client'
+#      config:
+#        serverName: cli
+#        transport: stdio
+#        command: 'C:\Users\<user>\AppData\Roaming\DSH Desktop\backend\node.exe'
+#        args: ['…\dsh-home\profiles\web\node_modules\@luchenglong\cli-bridge\mcp\cli-bridge-mcp.mjs']
+#        toolCallTimeoutMs: 900000
+#      failOnStartupError: false
```

**当前文件 473–482 行原文**
```yaml
473: #- insert:
474: #    - id: mcp-cli-bridge-global
475: #      name: '@deepseek-ai/dsh-mcp-client'
476: #      config:
477: #        serverName: cli
478: #        transport: stdio
479: #        command: 'C:\Users\<user>\AppData\Roaming\DSH Desktop\backend\node.exe'
480: #        args: ['C:\Users\<user>\AppData\Roaming\DSH Desktop\dsh-home\profiles\web\node_modules\@luchenglong\cli-bridge\mcp\cli-bridge-mcp.mjs']
481: #        toolCallTimeoutMs: 900000
482: #      failOnStartupError: false
```

**调用链**：`main.js:2375-2390`
```js
2375:  const preConflicts = mgr.findLoaderIdConflicts();
2376:  const preResolve = mgr.preflightBareNameResolution() || { repaired: [], broken: [] };
2378:  const allConflicts = preConflicts.concat(preResolve.broken || []);
2390:  fix = mgr.applyLoaderConflictFixes(allConflicts);   // → disablePatchEntriesInFile → 注释 + 备份
```

**该条目本应完全可加载**（实测）：
* `@deepseek-ai/dsh-mcp-client` ⇒ `backend\dsh\node_modules\@deepseek-ai\dsh-mcp-client`（installation scope，v0.2.1-alpha.5）✅
* 其 `args` 指向的 `…\profiles\web\node_modules\@luchenglong\cli-bridge\mcp\cli-bridge-mcp.mjs` ⇒ 文件存在（`@luchenglong/cli-bridge@0.2.13` 已装）✅

⇒ **本次禁用是 100% 误禁，属纯误判（无任何真实缺陷）。**

### 4.3 13 次 `.disabled-*.bak` 事件全表（2026-09-08 → 2026-10-20，跨 43 天）

目录：`C:\Users\<user>\AppData\Roaming\DSH Desktop\dsh-home\`

| # | 备份文件名 | 时间戳 | 该次事件**净禁用**的条目 | 归因 |
|---|---|---|---|---|
| 1 | `cordis.patch.yml.disabled-20260908-013423.bak` | 09-08 01:34:23 | `web-fetch-http` | **conflict 扫描**（与 dsh-base 内置行重复 id） |
| 2 | `cordis.patch.yml.disabled-20260908-015947.bak` | 09-08 01:59:47 | `web-search`、`web-search-client` | 人工（迁到标准包 `web-search-panel`） |
| 3 | `cordis.patch.yml.disabled-20260908-153412.bak` | 09-08 15:34:12 | `agentrouter-proxy`、`agy-indicator`、`codebuddy-indicator`、`comfyui-bridge`、`dsh-model-status`、`file-reader`、`mcp-agy-global`、`mcp-codebuddy-global`、`plugin-manager`、`session-cleaner` | 早于 preflight 上线（0.3.24 提交于 09-08 17:56），**非 preflight** |
| 4 | `cordis.patch.yml.disabled-20260908-153747.bak` | 09-08 15:37:47 | 净 0（随即被恢复） | 人工回滚 |
| 5 | `cordis.patch.yml.disabled-20260908-202743.bak` | 09-08 20:27:43 | 净 0（随后被恢复） | 人工 |
| 6 | `cordis.patch.yml.disabled-20260910-032032.bak` | **09-10 03:20:32** | **`mcp-agy-global`、`mcp-codebuddy-global`、`mcp-playwright-global`**（3 × `@deepseek-ai/dsh-mcp-client`） | ★ **preflight 误判** |
| 7 | `cordis.patch.yml.disabled-20260910-050112.bak` | 09-10 05:01:12 | `agy-indicator`、`codebuddy-indicator`、`comfyui-bridge` | 混合：前两者裸名（可能 preflight），`comfyui-bridge` 为 conflict 扫描 |
| 8 | `cordis.patch.yml.disabled-20260910-050522.bak` | 09-10 05:05:22 | `dsh-model-status`、`file-reader` | `file-reader` 是 `file://`（preflight 不可能命中）；`dsh-model-status` 裸名（可能 preflight） |
| 9 | `cordis.patch.yml.disabled-20260917-225806.bak` | 09-17 22:58:06 | `plugin-manager`（裸名 `dsh-plugin-manager-plus`） | 可能 preflight 误判 |
| 10 | `cordis.patch.yml.disabled-20260919-175604.bak` | 09-19 17:56:04 | `agentrouter-proxy`（`file://`） | **非 preflight**（人工/自愈） |
| 11 | `cordis.patch.yml.disabled-20261011-012324.bak` | 10-11 01:23:24 | 净 0 | — |
| 12 | `cordis.patch.yml.disabled-20261015-010021.bak` | **10-15 01:00:21** | **`mcp-agy-global`、`mcp-codebuddy-global`、`mcp-mimo-global`、`mcp-playwright-global`**（4 × `@deepseek-ai/dsh-mcp-client`） | ★ **preflight 误判** |
| 13 | `cordis.patch.yml.disabled-20261020-195941.bak` | **10-20 19:59:41** | **`mcp-cli-bridge-global`**（`@deepseek-ai/dsh-mcp-client`）；另 `mobile-companion` 整块被人工删除（非注释） | ★ **preflight 误判（本次事故）** |

**统计**

* 43 天内 13 次 `.disabled-*.bak`。
* 其中 **3 次（#6、#12、#13）直接由 `preflightBareNameResolution` 的 installation-scope 漏判造成**，共 **8 个条目实例**，**全部** `name = '@deepseek-ai/dsh-mcp-client'`。
* 该误判**反复复发 3 次**（09-10、10-15、10-20），每次都把一批用户自定义的 MCP 全局注册行注释掉，**且用户配置被永久留在注释态**（只有 `.bak` 备份可回滚）。

**preflight 上线时间点（git 取证）**
```
$ git log -S "preflightBareNameResolution" -- updater-backend.js main.js
2e79613 0.3.24: 清扫留名+豁免真实目录安装；预检新增裸包名解析检查与目录名手滑自动修复；…
$ git show -s --format="%H %ad %s" --date=iso 2e79613
2e796133d3808948bca637f0676ea6a73bd25bc5 2026-09-08 17:56:25 +0800 …
```
⇒ preflight 自 **2026-09-08 17:56** 起生效；事件 #1–#5（09-08 白天）**早于**该时间点，**不可能**由 preflight 造成；事件 #6 起才具备归因条件。

---

## 5. 附录：证据索引

| 主题 | 文件 | 行号 |
|---|---|---|
| 裸包名父路径 = `ctx.baseUrl` | `…\backend\dsh\node_modules\@deepseek-ai\cordis-plugin-loader\src\config\tree.ts` | 112–129（关键 121–122） |
| 同上（编译产物） | `…\cordis-plugin-loader\lib\index.js` | 218 |
| `loader.internal` 来源 | `…\cordis-plugin-loader\src\index.ts` | 85 |
| `ctx.baseUrl` 注入 | `…\cordis-plugin-loader\src\index.ts` | 89–93 |
| 树 baseUrl 继承 | `…\cordis-plugin-loader\src\config\tree.ts` | 16 |
| Entry 发起 import | `…\cordis-plugin-loader\src\config\entry.ts` | 226 |
| Include 决定 baseUrl | `…\cordis-plugin-loader\..\cordis-plugin-include\src\index.ts` | 181, **188** |
| `boot()` 设 baseUrl | `…\dsh-app-boot\lib\index.js` | 4507, **4525**, 4535–4538 |
| `mountRootInclude` | `…\dsh-app-boot\lib\index.js` | 4125–4146（4134 / 4138 / 4143） |
| installAnchor | `…\@deepseek-ai\dsh\lib\profile-boot-C14i-8IN.js` | **119** |
| rootConfig = profile\cordis.yml | 同上 | 120, 127, **289**, 302 |
| PluginPackages 安装拦截 | `…\dsh-app-boot\lib\index.js` | **3492–3508**（3501） |
| 拦截在 mount 之前生效 | `…\@deepseek-ai\dsh\lib\profile-boot-C14i-8IN.js` | **306**（配合 `dsh-app-boot:4536/4538`） |
| installation scope 采集 | `…\dsh-app-boot\lib\index.js` | 716–760 |
| resolution 构造 | `…\dsh-app-boot\lib\index.js` | 766–799（770/774/785–797） |
| profile scope 采集 | `…\dsh-app-boot\lib\index.js` | 894–897 |
| 依赖名口径（deps+peerDeps） | `…\dsh-app-boot\lib\index.js` | 712–714 |
| 裸包名解析路由 | `…\dsh-app-boot\lib\index.js` | 1613–1674（1625/1628/1664） |
| interception 改父路径 | `…\dsh-app-boot\lib\index.js` | 1879–1889 |
| 拦截层归属 | `…\dsh-app-boot\lib\index.js` | 1326–1345 |
| 官方"能否解析"API | `…\dsh-app-boot\lib\index.js` | 2261–2271（`manifestOf`）、3544–3555（`packageOf`）、1762–1777（`packageDir`） |
| 官方预检不判裸包名 | `…\dsh-app-boot\lib\index.js` | 2311–2388 |
| patch 层合并（家级/profile/bundle 同树） | `…\dsh-app-boot\lib\index.js` | 1118–1137 |
| 桌面预检：walk-up 判定 | `C:\Users\<user>\Desktop\DSH\updater-backend.js` | **2884–2902** |
| 桌面预检：主函数 | `C:\Users\<user>\Desktop\DSH\updater-backend.js` | **2939–2994**（2946–2953 / 2959 / 2974 / 2976–2988 / 2990） |
| 桌面：条目禁用 + 备份命名 | `C:\Users\<user>\Desktop\DSH\updater-backend.js` | 2654–2698（2674 / 2680–2683 / 2689–2690） |
| 桌面：预检调用与自动禁用 | `C:\Users\<user>\Desktop\DSH\main.js` | **2375–2390** |
| 安装锚点常量 | `C:\Users\<user>\Desktop\DSH\updater-backend.js` | 103–115（**114** `dshPkg`） |
| dsh-base 内置 mcp-resources 行 | `…\backend\dsh\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml` | **485–486** |

---

## 6. 附：关键实测输出存档

```
$ node (backend\node.exe) --input-type=module -e '<probe>'
=== A. 无拦截 ===
NATIVE node_modules chain from C:\Users\<user>\AppData\Roaming\DSH Desktop\dsh-home\profiles\web
  [ '…\dsh-home\profiles\web\node_modules', '…\dsh-home\profiles\node_modules',
    '…\dsh-home\node_modules', '…\DSH Desktop\node_modules', '…\Roaming\node_modules',
    '…\AppData\node_modules', 'C:\Users\<user>\node_modules', 'C:\Users\node_modules', 'C:\node_modules' ]
NATIVE import FAILED -> ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/dsh-mcp-client' imported from …\dsh-home\profiles\web\
NATIVE import FAILED -> ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/dsh-mcp-resources' imported from …\dsh-home\profiles\web\

=== B. 有拦截（真实运行时） ===
installAnchor = C:\Users\<user>\AppData\Roaming\DSH Desktop\backend\dsh\node_modules\@deepseek-ai\dsh\package.json
resolution.entries count = 539
  @deepseek-ai/dsh-mcp-client    -> scope=installation dir=…\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-client
  @deepseek-ai/dsh-mcp-resources -> scope=installation dir=…\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-resources
  @deepseek-ai/dsh-base          -> scope=installation dir=…\backend\dsh\node_modules\@deepseek-ai\dsh-base
  @luchenglong/cli-bridge        -> NOT IN TABLE
packageOf @deepseek-ai/dsh-mcp-client    => …\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-client
packageOf @deepseek-ai/dsh-mcp-resources => …\backend\dsh\node_modules\@deepseek-ai\dsh-mcp-resources
packageOf @luchenglong/cli-bridge        => …\dsh-home\profiles\web\node_modules\@luchenglong\cli-bridge
WITH INTERCEPTION import @deepseek-ai/dsh-mcp-client    => OK, exports: Config,apply,createMcpToolDefinition,inject,name
WITH INTERCEPTION import @deepseek-ai/dsh-mcp-resources => OK, exports: McpResourceRuntime,default

=== C. 安装锚点链（packageDirFromAnchor 同源） ===
  '…\backend\dsh\node_modules\@deepseek-ai\dsh\node_modules'   (不存在)
  '…\backend\dsh\node_modules\@deepseek-ai\node_modules'       (不存在)
  '…\backend\dsh\node_modules'                                 (存在，539 包)  ★
  '…\backend\node_modules'                                     (存在，npm/corepack)
  '…\DSH Desktop\node_modules' … 'C:\node_modules'              (均不存在)
```

---

*本报告为只读调查产出，未修改任何业务文件。修复动作（改 `updater-backend.js` 判定口径、恢复被注释的 MCP 条目、落回归断言）由统一实施方执行。*
