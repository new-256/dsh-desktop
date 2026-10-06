# DSH 移动端 (Capacitor 混合客户端)

DSH（桌面 AI 工作台）手机移动端外壳工程。基于 [Capacitor](https://capacitorjs.com/) 构建，连接在局域网或云端私有服务器运行的 DSH 后端 Web 服务。

---

## 一、架构定位与设计理念

本应用采用**「引导外壳 + 远程微前端」**架构：
1. **外壳职责**：负责初次配对凭证交换、多实例管理（切换/注销）、HMAC 设备鉴权续期以及底层容器级能力。
2. **核心业务 UI 托管**：手机端核心操作界面位于 DSH 服务端的 `<origin>/m/` 路径，由后端的移动伴侣插件统一提供与渲染。
3. **零重复打包**：后端插件功能迭代或 AI 工作流扩展时，手机端无需重新编译发布 APK/IPA，刷新即可享受最新能力。

---

## 二、目录结构说明

```text
mobile-app/
├── package.json          # 应用元信息与 Capacitor 依赖声明
├── capacitor.config.ts   # Capacitor 配置（AppID、HTTP 导航白名单等）
├── icon.png              # 客户端应用图标（自适应启动与应用图标）
├── README.md             # 本说明文档
└── www/                  # 纯静态引导应用（原生 JS，零框架无构建包依赖）
    ├── index.html        # 实例列表视图与配对视图入口
    ├── app.js            # 配对协议解析、HMAC 计算、Token 交换、续期流程
    └── style.css         # 移动端自适应样式（支持 prefers-color-scheme 暗黑/明亮模式）
```

---

## 三、首次配对的三种方式

移动客户端支持通过以下三种载荷格式快速建立信任绑定：

### 1. 桌面端设置页二维码
- 在 PC 桌面端 DSH 中打开 **「设置 → 移动配对」**；
- 界面将展示配对二维码，其内容即为 `dshpair://<base64url(JSON)>` 深链格式；
- 可直接使用扫码工具复制或通过后续版本的内置相机识别直接导入。

### 2. 机器人网关（Bot Gateway）`/pair` 命令
- 在绑定的 Telegram / 飞书 / 钉钉 / QQ 机器人私聊窗口发送 `/pair`；
- 机器人将回复结构化的配对载荷 JSON 或配对深链；
- 复制内容后在 App 配对页点击「从剪贴板粘贴」即可快速解析。

### 3. 手动复制带 Token 的 URL
- 在 PC 终端启动日志或桌面端复制手机访问 URL（如 `http://192.168.1.100:47896/?token=xxx`）；
- 粘贴至 App 输入框中，应用会自动识别主机、端口并抽取一次性交换 Token。

---

## 四、开发与构建指南

本项目脚手架源码完整，无需预先安装 Android/iOS 复杂 SDK 即可查验与阅读代码；若需打包原生应用，遵循以下标准流程：

### 1. 环境准备
- Node.js 18.0 或更高版本
- Android 开发需安装 Android Studio 与 Android SDK（API 30+）
- iOS 开发需在 macOS 上安装 Xcode 与 CocoaPods

### 2. 初始化与依赖安装
```bash
# 进入工程目录
cd mobile-app

# 安装 Capacitor 依赖
npm install
```

### 3. Android 平台构建与打包
```bash
# 添加 Android 原生工程（首次执行）
npx cap add android

# 同步静态 web 资源与配置至原生工程
npx cap sync android

# 在 Android Studio 中打开原生工程进行调试与构建 APK
npx cap open android
```
> 在 Android Studio 中点击菜单栏 **Build → Build Bundle(s) / APK(s) → Build APK(s)** 即可生成安装包。

### 4. iOS 平台构建（仅限 macOS）
```bash
# 添加 iOS 原生工程（首次执行）
npx cap add ios

# 同步静态资源
npx cap sync ios

# 在 Xcode 中打开工程进行证书签名与真机调试
npx cap open ios
```

---

## 五、认证与安全机制

1. **Token 一次性凭证交换**：
   - 配对时提供的 Token 仅用于换取 30 天有效期的 HttpOnly 安全 Cookie。
   - 客户端通过隔离的隐藏 `<iframe>` 载入 Token URL，完成后即刻销毁 iframe 节点，避免 Token 在客户端长期滞留。
2. **HMAC-SHA256 设备续期协议**：
   - 每次连接已保存实例时，App 使用配对阶段生成的 32 字节私有密钥 `deviceSecret` 对请求负载进行数字签名：
     $$\text{HMAC-SHA256}(\text{deviceSecretHex}, \text{deviceId} + \text{'\textbackslash n'} + \text{ts} + \text{'\textbackslash n'} + \text{nonce} + \text{'\textbackslash nrenew-v1'})$$
   - 后端校验签名通过后返回最新的一次性换票 URL，防止重放攻击与非法设备仿冒。
3. **网络信任域建议**：
   - 当前版本通信采用 HTTP 明文传输，建议仅在家庭局域网、公司可信内网或通过 WireGuard/Tailscale 等加密 VPN 通道下连接。

---

## 六、版本演进路线（Roadmap）

- [ ] **原生扫码配对**：集成 `@capacitor-mlkit/barcode-scanning`，支持应用内直接调用摄像头扫码配对。
- [ ] **FCM / APNs 离线通知**：当后台任务完成或 AI 会话产生响应时，向手机发送即时通知。
- [ ] **Relay 中继代理通道**：支持在无公网 IP 和无局域网直连环境下，通过安全的 WebSocket Relay 服务反向穿透连接。
