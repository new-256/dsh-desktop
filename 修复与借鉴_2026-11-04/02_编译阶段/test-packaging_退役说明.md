# `scripts/test-packaging.js` 退役说明

> 时间：2026-11-04（北京时间）｜处置人：出包验收团队（task-8）
> 处置方式：**退役（从 `scripts/` 移除）**，原文件归档到
> `02_编译阶段/evidence/retired/test-packaging.js`（SHA-256 `73B00DA4E186D5CA9E41D663670B38B3CD8B6C2AC43B0E48B8CBA83FE7A17F0A`），
> 退役前最后一次运行输出：`02_编译阶段/evidence/retired/test-packaging_退役前最后一次运行.txt`。

## 1. 为什么退役（而不是修）

它**编码的是一份已经被替换掉的旧契约**：`build.files` 从「逐个点名 12 个本地文件」改成了
`*.js` / `*.html` / `assets/**/*` 的通用通配。这个检查器的 `covered()` 只认两件事：

```js
if (includes.includes(name)) return true;              // 精确文件名
if (f.endsWith('/**/*')) { ...startsWith(prefix)... }  // 仅此一种目录通配
```

所以面对 `*.js` 它必然判"未覆盖"，于是 12 项全红。更要紧的是它的 require 扫描有个自身缺陷：

```js
let target = m[1];
if (!target.endsWith('.js')) target += '.js';   // require('./package.json') → 'package.json.js'
```

它把 `require('./package.json')` 当成模块 `package.json.js`，然后报"build.files 未包含 package.json.js"
—— 这是检查器自己造出来的假依赖，说明它无法承担"引用闭包"这件事。

**结论：这不是产品回归，是测试编码了旧契约。**（红线定性见交付清单同名条目。）

## 2. 覆盖对照：`build-files-gate.js` 是它的严格超集

| # | 旧 `test-packaging.js` 的能力 | 新 `scripts/build-files-gate.js` 的对应能力 | 关系 |
|---|---|---|---|
| 1 | 入口写死 7 个文件 | 入口 = `package.json.main` + 仓库根**全部 `.html`**，并递归 | 更强 |
| 2 | 只扫 `require('./x')`，且只补 `.js` | 扫 `require('./x')`（含子目录、`.json`/`index.js` 解析）+ `path.join(__dirname,'x')` / `__dirname+'/x'` 字面量 + html 的 `<script src>`/`<link href>`/`<img src>` | 更强 |
| 3 | `covered()`：精确名 或 `dir/**/*` | 完整 glob：`*`、`**`、`?`、目录前缀，且**否定模式优先** | 更强 |
| 4 | 逐条断言"白名单包含 X" | 闭包内每个文件与白/黑名单做匹配，缺失即点名并 `exit 1` | 等价更强 |
| 5 | 反向检查"白名单条目必须存在于磁盘" | 【3】反向体检：匹配不到任何文件的条目告警 + "点名了却没人用"告警 | 等价更强 |
| 6 | —（无） | 【4】运行期裸包依赖（`electron-updater` 是否已安装 / `node_modules` 是否被排除） | 新增 |
| 7 | —（无） | 【3b】运行期读取会被打包剥离的字段（`build`/`scripts`/`devDependencies`），**默认阻断** | 新增（已真实拦截一次） |
| 8 | 失败只打印，靠人记得跑 | 串进 `npm run dist` 前置链，红则 dist 直接失败 | 新增（机制化） |
| 9 | 无机器可读输出 | `--json` 导出闭包/缺失项/裸包，可与 asar 实物核对联动 | 新增 |

**没有丢失任何一项检查。** 另外它的历史价值已保留：0.3.46 期间它自动抓出过
`ladder-policy.js` 未加入 `build.files`（见 `CHANGELOG.md` 0.3.46 条目），这段历史在
CHANGELOG 里继续可查；退役只是把这份职责交给了更通用的机器。

## 3. 替代关系与调用点

- 新职责由 `scripts/build-files-gate.js` 承担，**已串进** `npm run dist` 前置链：
  `dist-artifact-guard pre → build-files-gate → app-identity-gate → pack-vendor → electron-builder → dist-artifact-guard post`。
- `npm run build-files-gate` 可单独运行；`--no-strict` 逃生阀会显式打印"已跳过严格模式，属已知风险"。
- 出包后的实物核对由 `02_编译阶段/tools/stage1-asar-list.js` 与
  `02_编译阶段/tools/stage1-verify-unpacked.js` 接力（asar 内逐文件对账 + 源码一致性 SHA-256）。

## 4. 退役后的门禁集合（当前事实）

| 门禁 | 用途 | 阻断性 |
|---|---|---|
| `scripts/dist-artifact-guard.js pre/post` | 防"失败却看起来像新的" | 阻断（post 校验 mtime/体积/SHA-256） |
| `scripts/build-files-gate.js` | 引用闭包 vs 打包白名单 + 裸包 + 剥离字段 | 阻断（默认 strict） |
| `scripts/app-identity-gate.js` | 随包 appId 常量 === `build.appId` 且真被使用 | 阻断 |
| `02_编译阶段/tools/stage1-compile-gate.js` | 全量 `node --check` + 13 支验证脚本（带超时、运行器自动识别） | 阻断（本人执行，不串 dist） |
| `02_编译阶段/tools/stage1-asar-list.js` / `stage1-verify-unpacked.js` | 出包后实物核对 | 阻断（交付前必须绿） |
