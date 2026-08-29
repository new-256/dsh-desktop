# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

## [0.3.4] - 2026-08-29

外壳自愈加固：修复"插件源缺失时反复隔离 profiles / 重装 Node 仍启动失败"的死循环（0.3.3 为内部误构建，混入插件开发项目，未发布；本版本为 0.3.2 的直接后继）。

### 新增

- **自定义插件 junction 自动重建**：`repairProfileJunctions` 现在会把 `dsh-home/node_modules` 家级插件 junction（如 bot-gateway、dsh-model-status）镜像到 `profiles/node_modules` 与 `profiles/web/node_modules`，隔离重建 profiles 后裸包名插件仍可解析；外来链接清理会豁免家级 junction 目标，避免重建结果被下一轮清理误删。
- **家级补丁坏条目自动禁用**：后端反复启动失败时解析 `ERR_MODULE_NOT_FOUND` 日志，匹配 `dsh-home/cordis.patch.yml` 中源文件缺失的插件条目——先备份（`cordis.patch.yml.disabled-<时间戳>.bak`）再注释禁用，弹窗告知用户后重试一次，不再死循环。

### 变更

- 自愈阶梯调整为：隔离重建 profiles → 插件 junction 修复 / 坏条目禁用 → Node 运行时修复。

## [0.3.2] - 2026-08-28

安装器体验重做，修复"安装一小时不完成"问题：

### 修复

- **安装长时间无响应**：经排查，根因是旧版卸载器执行异常 + 模板对非静默安装强制 `SetDetailsPrint none`（进度条冻住、无法判断死活）+ 模态重试框可能弹在安装窗口背后。本次：
  - 移除 `customCheckAppRunning` 末尾的 `MessageBox` 模态重试框：多次重试仍无法结束进程时，改为在详情面板打印中文警告并继续安装，杜绝"窗口背后有弹窗却看不见"的假死。
  - 详情面板默认展开（`SetDetailsView show` + `SetDetailsPrint both` 运行时覆盖模板的 `SetDetailsPrint none`），每个阶段打印中文进度：结束进程 / 卸载旧版本 / 写入程序文件 / 创建快捷方式 / 完成。

### 新增

- **安装权限提升**：`perMachine: true`，安装器启动即请求管理员权限，不再安装中途协商提权。
- **多线程解压**：出厂后端不再以约 3.2 万个散文件打入安装包，而是由 `scripts/pack-vendor.js` 按**文件数**均衡打包为 8 个 LZMA2 分卷（`build/payload/vendor-*.7z`），安装器只写约 80 个文件；首次启动时 `ensureSeeded` 用捆绑的 7za **并发解压全部分卷**（实测 11.6 秒 vs 单包 80–85 秒，约 7 倍）。
- 安装包体积 152.8 MB → 129.5 MB。

### 变更

- `ensureSeeded` 优先走分卷解压；保留旧散目录布局作为 `npm start` 源码模式的回退。
- 修正 `Start-Process -ArgumentList` 数组拼接不加引号导致带空格路径下解压静默失败的问题（生产路径 `C:\Program Files\DSH Desktop\…` 与 `%APPDATA%\DSH Desktop\backend` 均含空格）。

## [0.3.1] - 2026-08-28

- 安装顺序固化为「先结束进程 → 再卸载旧版 → 再安装」，默认保留用户数据（`deleteAppDataOnUninstall: false`，升级路径固定传 `--updated`）。
- 进程结束按**可执行文件路径**精确匹配（`*\DSH Desktop\backend\node.exe`），绝不误杀用户系统其他 `node.exe`；安装目录清扫使用进程名白名单，卸载器不会杀死自己。
- 环境变量净化：剥离 `NODE_OPTIONS`、`NODE_PATH`、`NPM_TOKEN` 等劫持/注入变量，保留并规范化代理与自定义证书配置，PATH 过滤外部 Node/npm/dsh。
- `dsh-home/profiles/node_modules` junction 自动修复（清理真实目录、外国链接、失效死链接）。
- 更新策略重做：dsh 后端每 6 小时及启动时静默检测（下次启动生效）；Node 仅按需拉取；外壳更新默认禁用。

## [0.3.0] - 2026-08-28

初始版本：DSH Desktop——`dsh web` 的 Electron 包装器。

- 独立窗口加载本地 DSH Web GUI，无需浏览器。
- 可安装 exe（electron-builder + NSIS），自动创建桌面/开始菜单快捷方式。
- 自带独立 Node v24 + npm + 完整 dsh 后端，目标机器无需预装任何环境。
- 启动自检自愈：无网络 Node 门禁 → junction 修复 → 后端阶梯式自愈（清 profile / 修复 Node）。
- 独立 `DSH_HOME` 数据目录，与命令行 `~/.dsh` 完全隔离。
- 静默更新、重启生效。
