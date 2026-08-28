# DSH Desktop（DeepSeek Harness 桌面版）

把 `dsh web` 包装成 **可安装的 Windows 桌面应用**。设计第一原则：**保证软件总能安装与启动**；在此之上做到免浏览器、自动修复、静默更新。

- 🐋 **独立窗口**：Electron 窗口加载本地 DSH Web GUI，无需浏览器；系统 WebView2 运行时会被探测（诊断用）。
- 📦 **可安装 exe**：electron-builder + NSIS，自动建桌面/开始菜单快捷方式；安装/卸载前自动结束残留进程，杜绝“无法关闭”。
- 🧩 **自带环境**：安装目录内含 **独立 Node v24 + npm + 完整 dsh 后端**，目标机器无需预装任何东西。
- 🩺 **启动自检自愈**：无网络 Node 门禁自检（满足即直通启动，不满足自动拉取）；自动修复 profile 目录的 junction 异常；后端启动失败阶梯式自愈（清 profile -> 修复 Node）。
- 🏠 **独立数据目录**：使用自己的 `DSH_HOME`，与你命令行的 `~/.dsh` 完全隔离，互不抢锁/互不污染。
- 🔄 **静默更新、重启生效**：后台高频检测 dsh 后端（每 6 小时及启动时），静默下载到暂存区，**下次启动时自动应用**；Node 仅在不满足要求或故障时按需拉取，绝不在使用中改动正在运行的文件。
- 🐳 **鲸鱼娘图标**。

## 启动顺序（可靠性核心）

应用启动时严格按以下顺序，任一步失败都有兜底：

1. **Seed**：首次把安装目录的出厂 Node/npm/dsh 复制到用户可写目录
   `%APPDATA%\DSH Desktop\backend\`（无需管理员权限）。
2. **应用暂存更新**：若上次后台下载了新版（`dsh.new` / `node.new`），此时后端尚未启动、无文件占用，统一切换。
3. **Node 门禁检查**：本地无网络极速检查当前 Node 是否满足 dsh 要求（当前 upstream 未声明 `engines`，内置最低 `22.15.0` 兜底）。满足时直接通过（0 延迟 0 网络请求）；仅当不满足时才拉取/准备合规 Node。
4. **修复 junction**：清理 `DSH_HOME/profiles/node_modules` 下任何真实目录、指向外部安装的外国链接或失效死链接（dsh 要求这些是合规 junction，异常链接会导致崩溃或依赖错乱）。
5. **启动后端**：用独立 `DSH_HOME=%APPDATA%\DSH Desktop\dsh-home` 启动 dsh web；
   若因 profile 状态失败，**自动清空 profiles 目录重试**；若再次失败，阶梯式**拉取最新 Node 运行时修复并重试**。
6. **开窗口**，随后后台进行：dsh 静默更新检测（启动后 20 秒及每 6 小时）；外壳更新检查（默认禁用，配置 `DSH_SHELL_UPDATE_URL` 时启用）。

## 环境隔离与数据安全

应用对运行环境与用户数据进行了严格隔离与保护：

- **数据持久化与安全**：用户数据（会话 `sessions/`、配置文件 `settings.yaml`、凭据 `.credentials.yaml` 等）保存在独立的 `%APPDATA%\DSH Desktop\dsh-home\` 中，为 `backend` 的同级目录。
  - 卸载或覆盖安装时绝不清理用户数据（`deleteAppDataOnUninstall` 为 `false`），出厂 seed 与应用更新仅作用于 `backend\` 目录。
  - 启动自愈机制**绝不删除**用户会话、配置与凭据；若后端启动因 profile 状态异常触发自愈，应用不会直接销毁数据，而是将旧 `profiles` 隔离备份为 `profiles.broken-<timestamp>`（仅保留最近 2 个历史备份），保证数据可恢复。
- **环境变量净化**：后端进程及其派生的子进程使用经过严格净化的环境变量：
  - **劫持变量剥离**：自动剔除 `NODE_OPTIONS`、`NODE_PATH`、`NODE_REPL_EXTERNAL_MODULE`、`NODE_ICU_DATA`、`NODE_V8_COVERAGE`、`ELECTRON_RUN_AS_NODE` 等易导致运行时崩溃或代码注入的变量。
  - **npm 配置隔离**：统一清理 ambient `npm_config_*` 及 `NPM_TOKEN`，强制应用专用的 `.npmrc`。
  - **网络与代理保留**：特例保留并规范化网络/代理相关配置（`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`NODE_EXTRA_CA_CERTS` 以及 `npm_config_proxy` / `npm_config_ca` 等），确保企业内网代理与自定义证书正常工作。
  - **PATH 净化**：以应用自建的 Node/npm 路径为最高优先级，同时自动过滤 ambient PATH 中指向外部 `node.exe`、`npm.cmd`、`npx.cmd`、`pnpm.cmd` 或 `dsh.cmd` 的路径，防止误调用全局或外部 Node/dsh 环境。
- **Junction 自动修复**：每次启动时自动检查 `dsh-home/profiles/node_modules`，清理残存的真实目录、指向外部安装路径的外国链接（Foreign links）以及失效的死链接（Broken links），由 dsh 在启动时自动重建合法链接。

## 两套更新

| 层 | 内容 | 方式 | 何时生效 |
|---|---|---|---|
| **外壳** | Electron 程序、启动/修复逻辑 | electron-updater（需配置 `DSH_SHELL_UPDATE_URL` 或发布源，默认禁用） | 下载后提示重启 |
| **dsh 后端** | dsh 后端 (`@deepseek-ai/dsh`) | 应用内高频**静默**下载到暂存区（每 6 小时及启动检测） | **下次启动自动应用** |
| **Node 运行时** | Node.exe、npm 匹配包 | 仅当不满足 dsh 版本门禁或后端启动失败时**按需**拉取 | **下次启动/修复时应用** |

- 后端/Node/npm 运行在用户可写目录，更新**不需要管理员权限**。
- **dsh 后端**：高频更新重点。 upstream 发布频繁，应用在启动 20 秒后及每 6 小时自动检测 `registry.npmmirror.com`，静默暂存最新 dsh 并在下次启动时应用。**若已成功暂存合规版本，后续检测将自动跳过重复下载，静默等待下次启动应用。**
- **Node 运行时**：不主动追新。启动时优先执行无网络门禁比对，满足即直通启动。由于 upstream `@deepseek-ai/dsh` 当前未声明 `engines` 字段，实际由内置最低版本（`22.15.0`，主版本锁定 24，可通过 `DSH_NODE_MAJOR` 调整）进行门禁。仅当门禁不满足或后端反复崩溃时才触发 Node 修复/升级。
- **npm**：不单独升级，随 Node 发行包自带的匹配版本一起更新（避免 npm/Node 版本错配）。
- **外壳更新**：默认禁用（避免轮询占位 URL）。仅当通过环境变量 `DSH_SHELL_UPDATE_URL` 配置真实 https URL 时启用，且每 24 小时检查一次。
- 下载源：dsh/npm 用 `registry.npmmirror.com`；Node 用 `cdn.npmmirror.com/binaries/node`。
- 配置/Key/会话都在独立 `DSH_HOME`，与升级隔离，不会丢失。

## 关于 WebView2 的说明

窗口层使用 Electron 内置的 **Chromium**（已实测任意机器可启动、无原生编译/ABI 风险）。
应用会探测系统 Edge WebView2 运行时（Windows 11 自带，Win10 覆盖率高）并记录版本，但不依赖它。
原因：让 Node/Electron 直接改用系统 WebView2 渲染需要原生绑定（如 webview-nodejs / .NET 宿主），
那些方案需要本机 C++ 构建工具链、且要按 Node ABI 发原生二进制，反而会损害“保证可安装可启动”这一第一目标。
如后续要切换到纯 WebView2 宿主（进一步降内存/体积），建议另建独立原生宿主工程，而不是在 Electron 内硬接。

## 目录

```
DSH/
├─ main.js                 # 主进程：启动顺序、自愈、静默更新、窗口、进程树清理
├─ updater-backend.js      # 后端/Node 管理：seed、暂存更新、Node 版本检查、junction 修复
├─ preload.js / splash.html
├─ build/installer.nsh     # NSIS：安装/卸载前 taskkill 结束残留进程树
├─ scripts/                # make-icon / install-backend / prepare-runtime
└─ vendor/{dsh,runtime}    # 出厂 dsh 后端 + Node + npm
```

运行期目录（自动创建）：

```
%APPDATA%\DSH Desktop\
├─ backend\
│  ├─ node.exe / node_modules\npm / dsh\…   # 活跃运行时与后端
│  ├─ dsh.new / node.new / downloads\        # 静默更新暂存区
│  └─ versions.json
└─ dsh-home\                                 # 独立 DSH_HOME（profiles/sessions/config）
```

## 开发 / 打包

```bat
npm install        # 自动准备 vendor 后端与 Node/npm 运行时
npm start          # 开发模式
npm run dist       # 生成 release\DSH Desktop Setup x.x.x.exe
```

## 外壳自动更新发布（默认关闭）

dsh 后端与 Node 的更新完全不依赖任何服务器，开箱即用。外壳（Electron 程序本身）更新是**可选**的：

- `package.json` 里**故意不带 `build.publish`**（原先那个 `https://example.com/...` 占位地址会让
  electron-updater 每几小时失败一次）。因此打包产物里**不会生成 `app-update.yml`**，客户端启动时
  `setupShellUpdater()` 会打出 `shell updater disabled (no release feed configured)` 后直接返回。
- 只要客户端配置环境变量 `DSH_SHELL_UPDATE_URL`（真实 https 地址）即可单独启用检查，无需重新打包。
- 要正式发布外壳更新：给 `build.publish` 填真实源（generic 静态目录或 GitHub Releases）→ 升 `version`
  → `npm run dist` → 上传 `Setup.exe`、`latest.yml`、`*.blockmap`。**注意 `latest.yml` 只在配置了
  `build.publish` 时才会由 electron-builder 生成**；没配置时 `release\` 下若残留旧 `latest.yml`，
  它的 sha512 属于上一次构建，不要拿去发布。

## 常见问题

- **安装时提示“无法关闭”**：NSIS 会在安装/卸载前 `taskkill /T /F` 结束应用与其 node 后端；如仍卡住，手动关闭 DSH Desktop 后点“重试”。
- **`is not a symlink` / profile 报错**：应用启动时自动修复；独立 `dsh-home` 与命令行 `~/.dsh` 隔离，正常不会再出现。
- **想固定 Node 主版本**：设环境变量 `DSH_NODE_MAJOR`（默认 24）。
- **换镜像**：`DSH_NPM_REGISTRY`、`DSH_NODE_DIST_BASE`。
