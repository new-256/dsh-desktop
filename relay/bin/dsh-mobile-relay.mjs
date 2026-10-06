#!/usr/bin/env node
/**
 * bin/dsh-mobile-relay.mjs — dsh-mobile-relay 命令行入口。
 *
 * 用法：
 *   npx dsh-mobile-relay --port 8443 --key <强密钥>
 *   npx dsh-mobile-relay --port 8443 --key <强密钥> --tls-cert cert.pem --tls-key key.pem
 *
 * 无证书时默认使用明文 ws/http，便于反代/隧道场景；公网部署建议置于 HTTPS
 * 反代之后。
 */

import { createRelay } from '../lib/relay.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--key') out.key = argv[++i]
    else if (a === '--tls-cert') out.tlsCert = argv[++i]
    else if (a === '--tls-key') out.tlsKey = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(`dsh-mobile-relay [选项]

选项：
  --port <n>      监听端口（默认 8443）
  --host <ip>     监听地址（默认 0.0.0.0）
  --key <secret>  隧道接入密钥（必须设置，否则拒绝所有隧道）
  --tls-cert <p>  TLS 证书路径
  --tls-key <p>   TLS 私钥路径
  --help, -h      显示帮助
`)
      process.exit(0)
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const log = console

  const relay = await createRelay({
    port: args.port || 8443,
    host: args.host || '0.0.0.0',
    key: args.key,
    tlsCert: args.tlsCert,
    tlsKey: args.tlsKey,
    log,
  })

  const protocol = args.tlsCert && args.tlsKey ? 'wss/https' : 'ws/http'
  const displayHost = args.host || '0.0.0.0'
  log.info(`dsh-mobile-relay 已启动: ${protocol}://${displayHost}:${relay.port}`)
  if (!args.tlsCert) {
    log.info('提示：未使用 TLS，建议通过 HTTPS/WSS 反代暴露公网。')
  }

  const graceful = () => {
    log.info('收到退出信号，正在关闭...')
    relay.close().then(() => process.exit(0)).catch(() => process.exit(1))
  }
  process.on('SIGINT', graceful)
  process.on('SIGTERM', graceful)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
