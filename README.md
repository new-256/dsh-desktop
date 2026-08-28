# DSH Desktop（DeepSeek Harness 桌面版）

把 `dsh web` 包装成 **可安装的 Windows 桌面应用**。设计第一原则：**保证软件总能安装与启动**；在此之上做到免浏览器、自动修复、静默更新。

- 🐋 **独立窗口**：Electron 窗口加载本地 DSH Web GUI，无需浏览器；系统 WebView2 运行时会被探测（诊断用）。
- 📦 **可安装 exe**：electron-builder + NSIS，自动建桌面/开始菜单快捷方式；安装/卸载前自动结束残留进程，杜绝“无法关闭”。
- 🧩 **自带环境**：安装目录内含 **独立 Node v24 + npm + 完整 dsh 后端**，目标机器无需预装任何东西。
- 🩺 **启动自检自愈**：先查 Node 是否满足 dsh 版本要求（不足则自动准备合规 Node）；自动修复 profile 目录的 junction 异常（即 `is not a symlink` 那类错误）；后端启动失败自动清理重试。
- 🏠 **独立数据目录**：使用自己的 `DSH_HOME`，与你命令行的 `~/.dsh` 完全隔离，互不抢锁/互不污染。
- 🔄 **静默更新、重启生效**：后台检测并下载新版 dsh 后端与 Node 补丁到暂存区，**下次启动时自动应用**，绝不在使用中改动正在运行的文件。
- 🐳 **鲸鱼娘图标**。

## 启动顺序（可靠性核心）

应用启动时严格按以下顺序，任一步失败都有兜底：

1. **Seed**：首次把安装目录的出厂 Node/npm/dsh 复制到用户可写目录
   `%APPDATA%\DSH Desktop\backend\`（无需管理员权限）。
2. **应用暂存更新**：若上次后台下载了新版（`dsh.new` / `node.new`），此时后端尚未启动、无文件占用，统一切换。
3. **修复 junction**：清理 `DSH_HOME/profiles/node_modules` 下任何“真实目录”（dsh 要求这些是 junction，
   真实目录会导致 `exists and is not a symlink` 直接崩溃）。
4. **Node 版本检查**：读取 dsh 的 `engines.node` 要求；当前 Node 不满足时，自动应用/下载合规 Node
   （锁定主版本 24 的最新补丁，保证 node-pty 等原生模块 ABI 兼容）。
5. **启动后端**：用独立 `DSH_HOME=%APPDATA%\DSH Desktop\dsh-home` 启动 dsh web；
   若因 profile 状态失败，**自动清空 profiles 目录再重试一次**。
6. **开窗口**，随后后台进行：外壳更新检查（electron-updater）+ 后端/Node 静默更新。

## 两套更新

| 层 | 内容 | 方式 | 何时生效 |
|---|---|---|---|
| **外壳** | Electron 程序、启动/修复逻辑 | electron-updater 整包（需配置发布服务器） | 下载后提示重启 |
| **后端环境** | dsh 后端、Node、npm | 应用内**静默**下载到暂存区 | **下次启动自动应用** |

- 后端/Node/npm 运行在用户可写目录，更新**不需要管理员权限**。
- **Node** 只在主版本 24 内追最新补丁（ABI 兼容）；跨大版本随外壳更新发布。
- **npm** 不单独升级，随 Node 发行包自带的匹配版本一起更新（避免 npm/Node 版本错配）。
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

## 外壳自动更新发布

后端静默更新无需服务器即可工作；外壳 electron-updater 需配置 `package.json` 的 `build.publish`
（generic 静态目录或 GitHub Releases），发布时升 `version` → `npm run dist` → 上传 `Setup.exe`、`latest.yml`、`*.blockmap`。

## 常见问题

- **安装时提示“无法关闭”**：NSIS 会在安装/卸载前 `taskkill /T /F` 结束应用与其 node 后端；如仍卡住，手动关闭 DSH Desktop 后点“重试”。
- **`is not a symlink` / profile 报错**：应用启动时自动修复；独立 `dsh-home` 与命令行 `~/.dsh` 隔离，正常不会再出现。
- **想固定 Node 主版本**：设环境变量 `DSH_NODE_MAJOR`（默认 24）。
- **换镜像**：`DSH_NPM_REGISTRY`、`DSH_NODE_DIST_BASE`。
