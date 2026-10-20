# 现场记录：0.3.46 恢复的 5 条 MCP 条目**无需重启**即被热加载（2026-10-21 00:2x）

## 结论先说

用户暂时无法重启 DSH。核查发现：**这 5 条条目在 21:08:53 就已经被运行中的后端热加载挂载了** —— 触发点就是 0.3.46 现场修复写回补丁文件的那一刻。

## 机制（读源码得出）

`dsh-hmr/lib/index.js:849-873`：

```js
const manifestPath = join(profile.dir, "package.json");
const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];
...
for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false));
```

- HMR 服务**监听家级补丁文件**（`dsh-home/cordis.patch.yml`）与 profile 补丁；
- 文件一变 → `refresh()` → 比对内容（`inputs` 变了才动）→ `reconcileProfile()`
  → `readProfilePatches()` **重新读盘** → `recomposeProfile()` 重新组合并挂载。

所以「改补丁文件 → 生效」在**家级补丁层**是支持的（补丁文件里那句"改此条目后需重启 DSH"
针对的是**插件源码**改动与 host 组合变更的旧结论，对本例不成立）。

## 实证

| 事实 | 值 |
|---|---|
| 补丁文件写回时刻 | 21:08:51 |
| 5 个 MCP server 子进程启动时刻 | **21:08:53 / 21:08:54** |
| 后端进程启动时刻 | 20:00:10（本次实例） |
| 日志中该窗口的报错 | **0 条**（无 "already registered" / 无导入失败） |

5 个子进程的命令行与 5 条家级条目的 `command`/`args` **逐一对应**：

| 条目 id | serverName | MCP server | 工具数 |
|---|---|---|---|
| mcp-agy-global | agy | `dsh-home/bin/agy-mcp-server.mjs`（v1.7.0） | 4：agy_run/continue/status/quota |
| mcp-codebuddy-global | codebuddy | `dsh-home/bin/codebuddy-mcp-server.mjs`（v1.6.2） | 3：codebuddy_run/continue/status |
| mcp-playwright-global | playwright | `plugins/playwright-mcp/.../@playwright/mcp/cli.js`（v1.63.0-alpha） | 25：browser_* |
| mcp-cli-bridge-global | cli | `profiles/web/node_modules/@luchenglong/cli-bridge/mcp/cli-bridge-mcp.mjs`（v0.2.13） | 19：agy/codebuddy/opencode/claude/codex 的 run/continue/status(+models) |
| mcp-mimo-global | mimo | `dsh-home/bin/mimo-mcp/mcp/mimo-mcp-server.mjs`（v1.2.8） | **0**（见下） |

在线调用抽检（当前会话实调）：
- `mcp__cli__mimo_status` → `mimo status: idle` ✓
- `mcp__cli__agy_status` → `agy status: idle` ✓
- `mcp__codebuddy__codebuddy_status` → `codebuddy status: idle` ✓

## 一个附带发现：mimo 条目的工具面是 0 —— 与条目无关

`mimo-mcp-server.mjs:403`：

```js
const liveTools = filterTools('mimo', TOOLS);   // 每次现读
```

`filterTools` 来自 `dsh-home/bin/cli-bridge-scheduling.mjs`，读的是
`dsh-home/cli-bridge-settings.json` 的 `_scheduling.enabled`：

```json
"_scheduling": { "enabled": ["agy","codebuddy","opencode","claude","codex"], ... }
```

**mimo 不在 enabled 列表里** ⇒ 独立 mimo MCP server 的工具面为空（它自己会回
"mimo is disabled by CLI Bridge scheduling"）。这是**用户自己的调度开关**，
不是补丁条目或解析根的问题；而且 mimo 能力本来就能从聚合 'cli' 通道
（`mcp__cli__mimo_*`）拿到。**未擅自改这个开关** —— 要放开的话在
设置→插件→CLI Bridge 面板里把 mimo 勾上即可。

## 复现/验证工具

- `lab/tests/probe-bare-resolution.mjs` —— 裸包名解析根探针
- `lab/tests/probe-mcp-tools.mjs` —— 直接以 MCP stdio 问服务器要工具清单
  （用法：`node probe-mcp-tools.mjs <server.mjs> [args...]`；`tools/list` 不会启动浏览器）
