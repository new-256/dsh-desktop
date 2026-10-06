# DSH 手机伴侣桌面托盘（移动端伴侣辅助系统）

> **路径**：`DSH/bin/dsh-mobile-tray.cmd`
> **定位**：完全独立的辅助进程；**不修改、不嵌入、不引用** DSH Desktop 任何源文件。
> **DRY 状态**：手机访问设置持久化到 `<dsh-home>\mobile-companion\tray.json`（与插件状态同源）。

## 功能对照表

| 功能 | DSH Shell 方案（已撤除） | 本 Tray CLI 方案（推荐） |
|---|---|---|
| 手机访问开关 | 改 `main.js` 监听 0.0.0.0 | Tray 简单开关 + Windows 防火墙提示 |
| 固定端口（47896） | 改 `main.js` 桥内部 TCP 桥 | Tray 独立运行小型 TCP 反向代理 |
| 防火墙规则 | Tray 调用 `netsh` | **完全等价** |
| 托盘菜单 QR 弹窗 | 改 `main.js` BrowserWindow | Tray 内置 Win32 通知 + 可选独立窗（轻量） |
| 桌面设置集成 | 改 `settings.html` | 通过 DSH 的 `/api/mobile/*` 插件 Web API 显示 |

## 使用方法（最终用户体验）

### 启动 Tray（可选，不影响 DSH 正常使用）

```cmd
:: 双击运行
DSH\bin\dsh-mobile-tray.cmd

:: 或以管理员权限启动（如需自动加防火墙规则）
DSH\bin\dsh-mobile-tray.cmd --admin
```

### Tray 提供的能力（系统托盘气泡）

- **连接状态**（手机端是否已连过）
- **开启/关闭手机访问**（一键切换 port 47896 的 TCP 桥）
- **弹出配对二维码**（不写设置页，直接以环境变量铺托 `DSH_MOBILE_URL`）

### 通过 DSH 插件 web 页管理设备地址 / 配对 / 撤销

`http://127.0.0.1:<webport>/m/`（**任何时间**可访问，不依赖 Tray）

## 设计原则

1. **代码自包含**：单文件 Node，引入 `net`+`fs`+`path`+`http`。
2. **无 DSH 依赖**：Tray 崩溃不影响 DSH；Tray 未运行不影响 DSH 启动。
3. **零污染**：不留 Windows 服务、不改注册表、只是普通用户进程。
4. **壳版本无关**：从 0.3.31 到将来任何版本都安全（插件走 `cordis.patch.yml` 注册；API 走 `/api/mobile/*`）。

## 卸载

```
:: 停止并退出 Tray
DSH\bin\dsh-mobile-tray.cmd --stop

:: 删除配置文件和残留数据（可选，撤销所有设备授权）
rmdir /S /Q "%APPDATA%\DSH Desktop\dsh-home\mobile-companion"
```

## 开发备注

- Node 版本：≥ 18 (使用内置 `fetch`)
- 不依赖 `electron`
- 不依赖 DSH 主体源码

---

下一步请创建 `dsh-mobile-tray.cmd` 占位脚本 + 用 `node bin/dsh-mobile-tray.mjs` 实现核心逻辑。
