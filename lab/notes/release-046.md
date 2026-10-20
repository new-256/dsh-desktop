## 0.3.46：启动预检的解析根修正 + 退出原因台账

**如果你是 0.3.45 用户，请务必更新。** 0.3.45 的启动预检会把**官方后端里明明装着的包**判成"装不上"，并自动禁用你的插件配置 —— 2026-10-20 19:59 那次弹窗就是这么来的。

### 一句话根因

预检判断"裸包名能不能解析"时，只从 `<dsh-home>/profiles/<profile>` 向上找 `node_modules`；而 DSH 运行时对裸包名还有一层**解析拦截**，其作用域是官方后端安装树 `<backend>/dsh/node_modules`。

这两个目录是**兄弟、不是祖先** ⇒ 纯 walk-up 永远看不见官方包 ⇒ 官方包一律被判死。

```
❌ 旧口径（只看这里）        ✅ 运行时真实口径
<dsh-home>/profiles/web/     <backend>/dsh/node_modules/   ← 被漏掉的那一棵
  └ node_modules               └ @deepseek-ai/dsh-mcp-client ✔
```

### 被误伤的三次（全部是同一个包名 `@deepseek-ai/dsh-mcp-client`）

| 时间 | 被禁用的条目 | 后果 |
|---|---|---|
| 2026-09-10 03:20 | mcp-agy / mcp-codebuddy / mcp-playwright-global | 3 条通道消失 |
| 2026-10-15 01:00 | 同上 4 条 + mcp-mimo-global | 4 条通道消失 |
| 2026-10-20 19:59 | mcp-cli-bridge-global | 18 个 `mcp__cli__*` 工具消失 + 弹窗 |

43 天内 13 次 `.disabled-*.bak` 里，这 3 次是**同一个缺陷**造成的（共 8 个条目实例）。

### 铁证

- 同名包 `@deepseek-ai/dsh-mcp-resources` 声明在**内置** `dsh-base` 补丁里，一直正常加载 —— 内置补丁位于 `<backend>/dsh/node_modules/@deepseek-ai/dsh-base/`，恰好证明"官方树里的裸包名是可解析的"。
- 实测（`backend\node.exe`）：**无拦截**时 `dsh-mcp-client` 与 `dsh-mcp-resources` **都** `ERR_MODULE_NOT_FOUND`；**有拦截**时两者**都 OK**，installation scope 有 539 个包。
- `loader.internal` 的形状判定看的是 **cascaded loader 对象**（本机 v2 恒成立），不是模块命名空间 —— 看命名空间会误判成"不可用"。

### 这次改了什么

1. **解析根模型重写**（新增 `plugin-resolution.js`）
   - installation scope：直接取 Node 自己的 `require.resolve.paths()`（与 DSH 的 `installAnchor` 同源）
   - local scope：profile 目录向上 walk-up
   - 口径取**保守放行**：看得见就不禁（误禁代价 ≫ 误放行；真失败时 DSH 启动自检会给权威诊断）
2. **自校验锚点**（防复发）
   - 用内置 `dsh-base` 补丁里的裸包名当锚点；锚点解析不到 ⇒ 根集合不可信 ⇒ **拒绝任何破坏性禁用**，只报告不删除
   - 这条直接堵死"解析根模型再错一次就又误伤"的类
3. **自愈对称化**（新增恢复通道）
   - 禁用时在条目上方写机器可读标记（`dsh-desktop:preflight-disabled … kind=…`）
   - 启动时把**自己造成的、且现在能解析的**条目自动恢复；其它原因的禁用（loader id 冲突等）不动
   - 历史条目用**桌面日志取证**：只有 reason 含"冷启动必然失败"的那几条才算受害者
4. **退出原因台账**（新增 `lifecycle-log.js`）
   - 每次启动写 `start`、每条退出路径写带原因的 `exit`；**有 start 无 exit ⇒ 外部强杀/断电**
   - 覆盖托盘退出、窗口关闭、启动失败、更新重启、系统关机、渲染层崩溃、单实例、异常兜底
5. **弹窗不再指死文件**
   - 弹窗里的"详情见桌面日志：DSH-Desktop-日志.txt"改成**绝对路径**（本机同时存在一个 9-10 起就停更的同名死文件，那是本次前期走偏的根源之一）
6. **渲染层取证**（对齐官方 `main.ts:1110-1118`）
   - 补 `render-process-gone` / `preload-error` / `unresponsive` 监听：渲染进程被 OOM 或被杀，此前**一点痕迹都不留**

### 现场已修好

- 本机 `dsh-home/cordis.patch.yml` 的 5 条被误禁条目**已恢复**（写前留 `.restore-*.bak` 备份，YAML 校验通过、无重复 id）
- 家级 `node_modules` 里补了 `@deepseek-ai/dsh-mcp-client` → 官方后端树的 junction：**在 0.3.46 装上之前，0.3.45 的旧预检也不会再误禁用**

> 恢复的条目要**重启 DSH** 才会重新挂载（host 组合变更不可热加载）。

### 顺带修的可复现性缺陷

`scripts/install-backend.js` 的默认后端版本此前是 `latest` —— 同一份代码今天打包与明天打包会得到两个不同后端，而且 npm 各子包的 `latest` 严重不一致（`dsh-app-boot` 的 latest 还停在 `0.1.0-rc.6`）。现已钉死为精确版本 `0.2.1-alpha.5`（本壳真机验证过的版本）；升级官方版本走应用内静默更新通道（有 journal + 回滚），不悄悄改打包产物。

### 验证

- 新增 `scripts/test-046-preflight-resolution.js`：**34 项断言，0 失败**（含"只装在官方后端树里的包必须能解析"、"锚点不可信时禁止禁用"、"真缺包仍判 broken"、"只有裸包名类误伤才恢复"、"用户自己注释的不被恢复"、"退出台账"）
- 既有回归全绿：040(20) / 041(45) / 042(66) / 043(31) / 043-ladder(50) / 044(66) / 045(48) / manifest(30)
- 现场修复后：补丁文件 YAML 解析通过（8 个块、无重复 id）；旧预检口径实测已能解析该包

### 安装

下载 `DSH-Desktop-Setup-0.3.46.exe` 覆盖安装即可。已安装 0.3.45 的用户也会通过应用内更新通道收到提示。
