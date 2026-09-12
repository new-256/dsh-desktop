## DSH 手机伴侣 · dsh-mobile-companion

**网页版 DSH 通用手机接入插件** —— 扫码即用，本地优先，零修改 DSH 本体。

### 特点

- 完全自包含：不改 DSH 任何源文件，仅通过 `cordis.patch.yml` 挂载
- 同源同权：手机端与桌面端共用同一套 `/api/*` 通道与认证
- 设备生命周期：注册 / 列表 / 撤销 / 离线续期
- 纯 ES 模块，零构建链，零 npm 依赖

> **开发纪律**：遵循[开发-制品闭环](../DEV-DISCIPLINE.md)——本插件以目录拷贝部署于 `dsh-home\node_modules\dsh-mobile-companion`，更新时按闭环流程重装并核验与源码一致性。
- HMAC-SHA256 离线续期，Cookie 过期无需重新扫码
- 多设备并发（默认上限 20 台）
- **智能局域网探测**：自动剔除代理 TUN 假 IP、VPN、Hyper-V/WSL 虚拟网卡

### 安装

```bash
# 1. 放置插件（真实目录，防清扫）
#    <dsh-home>/node_modules/dsh-mobile-companion/

# 2. 在 <dsh-home>/cordis.patch.yml 注册
```

```yaml
- insert:
    - id: mobile-companion
      name: dsh-mobile-companion
      config:
        dataPath: 'C:/Users/<你>/AppData/Roaming/DSH Desktop/dsh-home/mobile-companion'
        # lanIps: ['192.168.5.124']   # 可选：强制指定局域网地址
```

改 `index.mjs` / `lib/` 后需**重启 DSH**（ESM 模块缓存无法热替换）；改 `mobile/` 前端文件只需刷新浏览器。

### 使用

| 平台 | 用法 |
|---|---|
| 手机浏览器 | 访问 `http://<LAN_IP>:<port>/m/`，扫码完成配对 |
| Android APK | 安装 `dsh-mobile-v0.1.0-release.apk`，扫码或手填地址 |
| HarmonyOS | ArkWeb 加载同一地址（见 `docs/PLATFORM-COMPATIBILITY.md`） |
| iOS | Capacitor `@capacitor/ios`，同一份 `www/`（同上文档） |

### 路由契约

| 路由 | 方法 | 认证 | 用途 |
|---|---|---|---|
| `/m/` | GET | 无 | 移动端 UI 静态资源 |
| `/api/mobile/pair-info` | GET | Cookie | 配对信息 JSON |
| `/api/mobile/qr.svg` | GET | Cookie | 配对二维码 SVG |
| `/api/mobile/devices` | GET | Cookie | 已配对设备列表 |
| `/api/mobile/devices/enroll` | POST | Cookie | 新设备注册 |
| `/api/mobile/devices/revoke` | POST | Cookie | 撤销设备 |
| `/api/mobile/net-check` | GET | Cookie | 网络诊断 + 冲突告警 |
| `/mobile/renew` | POST | HMAC | 离线续期 Cookie |
| `/mobile/unregister` | POST | HMAC | 设备自注销 |

### 安全模型

| 议题 | 处置 |
|---|---|
| 未授权访问 | 401 + Host/Origin 栅栏 |
| 配对 token | 一次性，不落 URL 日志 |
| 设备凭证 | 每设备独立 256-bit HMAC 密钥 |
| 重放攻击 | nonce 5 分钟缓存 + 时钟偏差 ±5 分钟 |
| 时序侧信道 | `crypto.timingSafeEqual` |
| 撤销语义 | 立即阻断续期 |

详见 `docs/SECURITY.md`。

### 代理软件冲突

本机若运行 Clash / Mihomo / sing-box / Tailscale / WARP / Radmin / Hyper-V / WSL，插件会自动剔除其虚拟网卡地址，只把真实局域网地址写进二维码。

自检：

```powershell
node -e "import('./lib/pairing.mjs').then(m=>{console.log('选中:',m.sampleLanIps());console.table(m.diagnoseInterfaces())})"
```

或访问 `/api/mobile/net-check` 查看 `chosen` / `interfaces` / `warnings`。

**仍连不上的两个高频原因**（需手动处理）：

1. 网卡被 Windows 判定为 **Public** → 防火墙拦入站，需改 Private
2. 代理 TUN 接管全部流量 → 需加局域网直连/绕过规则

完整排障流程见 **`docs/PROXY-CONFLICT.md`**。

### 测试

```bash
npm test        # 全套 4 个套件
```

| 套件 | 覆盖 |
|---|---|
| `test-qr.mjs` | 二维码编码 16 例（v1–13 边界，jsQR 交叉验证） |
| `test-devices.mjs` | 设备注册表 + HMAC 生命周期 |
| `test-netconflict.mjs` | 局域网选址 / 代理冲突识别 9 例 |
| `test-smoke.mjs` | 端到端冒烟（复刻宿主路由匹配语义） |

### 文档

| 文档 | 内容 |
|---|---|
| `docs/PROXY-CONFLICT.md` | 代理/虚拟网卡冲突排查（含完整排障流程） |
| `docs/SECURITY.md` | 安全模型、威胁分析、应急响应 |
| `docs/PLATFORM-COMPATIBILITY.md` | Android / HarmonyOS / iOS 扩展方案 |
| `docs/DESKTOP-SHELL-HANDOVER.md` | 与 DSH Desktop 壳的零侵入边界说明 |

### 与 DSH 本体的边界

| DSH 文件 | 是否修改 |
|---|---|
| `main.js` | 否 |
| `settings.html` / `settings-preload.js` | 否 |
| `updater-backend.js` | 否 |
| `package.json` / `CHANGELOG.md` | 否 |

唯一接触点：`<dsh-home>/cordis.patch.yml` 的一条 `insert` 记录。

### 版本

**v0.1.2**
- 智能局域网探测：剔除代理 TUN 假 IP（198.18/19）、CGNAT（100.64/10）、link-local（169.254/16）及 15 类虚拟接口名
- `/api/mobile/net-check` 新增 `chosen` / `interfaces` / `warnings` 诊断字段
- `sampleLanIps()` / `diagnoseInterfaces()` 支持注入接口表（可测试）
- 新增 `test-netconflict.mjs`（9 例）与统一入口 `test/run-all.mjs`
- 新增 `docs/PROXY-CONFLICT.md`

**v0.1.0** — 首个可用版本：配对、设备管理、移动 UI、HMAC 续期

### 路线图

- **M2**：中继服务（公网无固定 IP）+ FCM/APNs 推送 + 附件上传
- **M3**：多实例互联

### License

MIT
