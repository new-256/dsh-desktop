# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

## [0.3.9] - 2026-09-02

### 变更

- 托盘更新状态改为三行显示：当前版本、最新版本、更新进度/状态。
- 检查和下载过程中持续刷新版本信息，下载完成后保留当前版本与待应用的最新版本。


### 新增

- 托盘右键菜单新增更新状态项，显示检查中、下载中百分比、已完成待重启和失败原因。
- 更新下载进度同步显示在托盘菜单和托盘提示文字中。


### 稳定性

- 后端更新前保存插件状态快照。
- 新后端替换时保留上一版本，支持启动失败后的安全回滚基础能力。
- 为插件提供源文件可用性报告与单独禁用接口；禁用只修改补丁配置，不删除插件源码，并自动备份原配置。


### 修复

- **后端更新源改进**：以 `deepseek-ai/deepseek-harness` 的 `master/apps/cli/package.json` 作为 DSH 版本判断来源；GitHub 不可用时回退 npm registry。
- 按 GitHub 检测到的明确版本安装 npm 包，避免 npm `latest` 标签滞后导致漏更新。
- 完善预发布版本（alpha/beta/rc）比较。

### 新增

- 后端更新完成后通过托盘气泡和运行日志告知版本变化及上游最近提交摘要；更新在下次启动时应用。


本版本不改变安装器/外壳行为，把仓库从单一 Electron 包装器扩展为「桌面外壳 + 宿主插件 + 机器人网关 + 集成测试」的完整工作区。

### 新增

- **DSH 宿主插件入库（`plugins/`）**
  - `session-cleaner`：会话清理器——侧边栏会话菜单「移入回收站」、侧边栏「回收站」入口、两级可恢复删除（回收站/粉碎）、同名会话防删错（React Fiber 精确定位 sessionId）、活跃会话保护（openStep/pendingCalls）、管理页 `/session-cleaner`（支持 `#trash` 锚点）
  - `agentrouter-proxy`：agentrouter.org 反向代理，把 DSH 的 User-Agent 改写为白名单客户端标识
  - 附部署模板 `cordis.patch.example.yml` 与 `?v=N` 热加载机制说明
- **DSH Bot Gateway 初始导入（`bot-gateway/`）**：QQ（NapCat/官方）/Telegram/飞书/钉钉多平台远程任务网关（Cordis 宿主插件源码），详见其自带 `README.md` / `SPEC.md`
- **集成测试脚本**：`test-session-cleaner.mjs`（35 项断言，含同名隔离/回收站/恢复/粉碎/路由契约）、`test-proxy-plugin.mjs`（独立 Cordis 实例生命周期）、`test-agentrouter.mjs`（SSE 流式 + tool_use 端到端）；密钥一律经环境变量 `AGENTROUTER_API_KEY` 注入
- `CHANGELOG.md` 与仓库结构文档（根 `README.md`）

### 变更

- `.gitignore`：排除 bot-gateway 研究用压缩包（`test/napcat-research/`，约 147MB）与运行时状态（`runtime-data/`）；新增本地 `.env*` 防密钥误入库
- 测试脚本中的硬编码 API Key 改为环境变量注入；插件路径按 `%APPDATA%` 解析，提升可移植性
- `test-session-cleaner.mjs` 优先测试仓库内源码副本（`plugins/web/`），无副本时回退部署位置

### 移除

- 失效的调试截图 `installer-cannot-close.png`

## [0.3.2] - 2026-08-28

安装器体验重做：一开始就请求提权（不再安装中途弹 UAC）、并行解压加速安装、每个阶段都有进度反馈；进一步细化进程结束与目录清扫的路径匹配，绝不误杀系统其他 node 进程。

## [0.3.1] - 2026-08-28

安装顺序固化为「先结束进程 → 再卸载旧版 → 再安装」，默认保留用户数据；环境变量净化、`dsh-home/profiles` junction 自动修复、两套更新策略（外壳默认禁用 / dsh 每 6 小时静默检测重启生效 / Node 仅按需拉取）。

## [0.3.0] - 2026-08-28

初始版本：DSH Desktop——`dsh web` 的 Electron 包装器。独立窗口、可安装 exe（NSIS）、自带 Node v24 + npm + 完整 dsh 后端、启动自检自愈（清 profile / 修复 Node 阶梯兜底）、独立 `DSH_HOME` 数据目录、静默更新重启生效。
