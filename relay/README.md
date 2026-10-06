# dsh-mobile-relay

DSH 手机伴侣自建中继服务器：让身处内网的 DSH 宿主机通过 outbound WSS 隧道被外网手机访问。

## 一分钟开始

```bash
# 1. 直接运行（Node >=20，零依赖）
npx dsh-mobile-relay --port 8443 --key "请换成强随机密钥"

# 2. 或 Docker 运行
# docker run -p 8443:8443 --rm dsh-mobile-relay --port 8443 --key "请换成强随机密钥"
```

## 多路复用协议

单条 WSS 隧道承载任意数量逻辑流。

- **控制帧**：JSON 文本（WS text）
  - `{ t:'open', sid, method, path, headers }` — 中继 → 隧道：新建请求
  - `{ t:'head', sid, status, headers }` — 隧道 → 中继：响应头
  - `{ t:'end', sid }` — 隧道 → 中继：响应体结束
  - `{ t:'reset', sid, reason }` — 任意方向：关闭/错误流
  - `{ t:'ping' }` / `{ t:'pong' }` — 保活
  - `{ t:'hello', e2e:false }` — 预留：端到端加密握手（当前未启用，后续可加）
- **数据帧**：二进制（WS binary）
  - 首字节 `0x01`，随后 4 字节 sid（大端），剩余 payload。
  - 帧头与 payload 放在同一条 WS 消息中发送。

## 部署方式

### 直接 Node

```bash
node bin/dsh-mobile-relay.mjs --port 8443 --host 0.0.0.0 --key <密钥>
```

### Docker

```bash
docker run -d --name dsh-relay -p 8443:8443 \
  --restart unless-stopped \
  dsh-mobile-relay \
  --port 8443 --key <密钥>
```

### Nginx 反代（WSS + HTTPS）

```nginx
server {
  listen 443 ssl http2;
  server_name relay.example.com;

  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;

  location / {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
  }
}
```

## 与插件对接

在 `dsh-home/cordis.patch.yml` 中配置 mobile-companion：

```yaml
plugins:
  dsh-mobile-companion:
    config:
      relay:
        enabled: true
        url: wss://relay.example.com
        key: <同中继密钥>
        instanceId: 你的实例标识
```

配对二维码/深链会自动把中继地址加入候选 URL（位于局域网代理之后），App 探测选优。

## 安全须知

- `--key` 即特权：持有密钥即可建立隧道并代理访问宿主机 DSH。请使用强随机字符串。
- 公网部署强烈建议置于 HTTPS/WSS 反代之后；直接明文暴露会泄露 HTTP/WS 内容。
- 端到端加密（E2E）当前未实现，协议已预留 `hello` 帧，后续版本可选开启。
