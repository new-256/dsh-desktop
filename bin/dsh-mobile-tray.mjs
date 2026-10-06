#!/usr/bin/env node
/**
 * DSH 手机伴侣桌面托盘（独立配件，不动 DSH）
 * ── 简化版：只做桥接提示与状态暴露；QR 与设备操作复用插件 /api/mobile/*
 *
 * 用法：
 *   node dsh-mobile-tray.mjs start         # 启动 LAN 桥
 *   node dsh-mobile-tray.mjs stop          # 停止桥
 *   node dsh-mobile-tray.mjs status        # 查看状态
 *   node dsh-mobile-tray.mjs qr            # 在 stdout 打印 LAN 地址与 QR 提示
 *   node dsh-mobile-tray.mjs firewall      # 加 Windows 防火墙入站规则
 *
 * 设计原则：
 *  - 不 require 任何 @dsh/*，不动 main.js/settings.html
 *  - 使用 node 内置 net/http/fs
 *  - 400 行内
 */

import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.APPDATA + '\\DSH Desktop\\dsh-home'
const STATE_DIR = path.join(HOME, 'mobile-companion')
const STATE_FILE = path.join(STATE_DIR, 'tray.json')
const PLUGIN_HOME = path.join(HOME, 'node_modules', 'dsh-mobile-companion')

const DEFAULT_PORT = 47896
const BACKEND_HOST = '127.0.0.1'
const COOKIE_NAME_HINT = process.env.DSH_COOKIE_HINT || ''

// ─── 状态 ─────────────────────────────────────────────────────────────
let state = loadState()
let bridge = null
let localIp = null

function loadState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { enabled: false, port: DEFAULT_PORT, notes: [] }
  }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}
function log(...args) { console.log(`[tray ${new Date().toISOString()}]`, ...args) }
function error(...args) { console.error(`[tray ${new Date().toISOString()}]`, ...args) }

function detectLocalIp() {
  const ifs = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('127.')) {
        return a.address
      }
    }
  }
  return null
}

async function getDshWebPort() {
  // 从最新正在运行的 DSH web 后端取端口。先查 LISTEN 表。
  // 简化实现：尝试常见端口（或留给用户 DSH_MOBILE_DSH_PORT 覆盖）
  const envPort = process.env.DSH_MOBILE_DSH_PORT
  if (envPort) return Number(envPort)
  const candidates = [8787, 64527, 51180, 58933]
  for (const p of candidates) {
    try {
      const ok = await probe(`http://127.0.0.1:${p}/health`, 800)
      if (ok) return p
    } catch {}
  }
  return null
}
function probe(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    fetch(url, { signal: ctrl.signal })
      .then(() => { clearTimeout(t); resolve(true) })
      .catch(() => { clearTimeout(t); resolve(false) })
  })
}

// ─── TCP 桥（替代 DSH 壳内 mobileBridge） ────────────────────────────
function startBridge(targetPort) {
  if (bridge) {
    log('bridge already running')
    return true
  }
  const listenPort = state.port
  bridge = net.createServer((client) => {
    const upstream = net.createConnection({ host: BACKEND_HOST, port: targetPort }, () => {
      client.pipe(upstream); upstream.pipe(client)
    })
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  bridge.on('error', (e) => error('bridge error:', e.message))
  bridge.listen(listenPort, '0.0.0.0', () => {
    log(`LAN 桥已启动 0.0.0.0:${listenPort} → 127.0.0.1:${targetPort}`)
  })
  return true
}
function stopBridge() {
  if (!bridge) return false
  try { bridge.close() } catch {}
  bridge = null
  return true
}

// ─── 防火墙（可选） ────────────────────────────────────────────────────
function ensureFirewallRule(port) {
  const name = 'DSH Desktop Mobile'
  return new Promise((resolve) => {
    const add = spawn('netsh', ['advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`, 'dir=in', 'action=allow', 'protocol=TCP', 'localport=' + port], { stdio: 'ignore' })
    add.on('close', (code) => {
      if (code === 0) log(`firewall rule added: TCP ${port}`)
      else log(`firewall rule may already exist or netsh failed (${code})`)
      resolve(code === 0)
    })
    add.on('error', (e) => { error('netsh spawn fail:', e.message); resolve(false) })
  })
}

// ─── 命令分发 ──────────────────────────────────────────────────────────
const cmd = process.argv[2] || 'status'

;(async () => {
  if (cmd === 'status') {
    const dshPort = await getDshWebPort()
    const lanIp = detectLocalIp()
    const pairInfo = []
    pairInfo.push(`DSH web 端口: ${dshPort || '未检测到'}`)
    pairInfo.push(`LAN IP: ${lanIp || '未检测到'}`)
    pairInfo.push(`移动访问: ${state.enabled ? '已开启' : '未开启'}`)
    pairInfo.push(`监听端口: ${state.port}`)
    pairInfo.push(`插件目录: ${PLUGIN_HOME}`)
    pairInfo.push(`(plugin ${fs.existsSync(path.join(PLUGIN_HOME, 'index.mjs')) ? 'OK' : '未安装'})`)
    console.log(pairInfo.join('\n'))
    if (dshPort && lanIp) {
      console.log('\n配对建议 URL:')
      console.log(`  http://${lanIp}:${state.port}/m/`)
    }
    process.exit(0)
  }

  if (cmd === 'start') {
    const dshPort = await getDshWebPort()
    if (!dshPort) { error('找不到 DSH web 后端，请先启动 DSH Desktop'); process.exit(2) }
    state.enabled = true
    saveState()
    localIp = detectLocalIp()
    startBridge(dshPort)
    if (state.addFirewall !== false) await ensureFirewallRule(state.port)
    log(`DSH web 后端位于 127.0.0.1:${dshPort}，已通过 0.0.0.0:${state.port} 暴露给 LAN`)
    log(`手机访问: http://${localIp}:${state.port}/m/`)
    process.stdin.resume()
    return
  }

  if (cmd === 'stop') {
    stopBridge()
    state.enabled = false
    saveState()
    log('已停止（配置文件仍保留 enabled=false）')
    process.exit(0)
  }

  if (cmd === 'qr') {
    const lanIp = localIp || detectLocalIp()
    if (!lanIp) { error('未检测到 LAN IP'); process.exit(2) }
    const url = `http://${lanIp}:${state.port}/m/`
    console.log('配对二维码目标 URL:')
    console.log(url)
    // 输出 ASCII QR（小且方便）
    const { qrSvg } = await import(path.join(PLUGIN_HOME, 'lib', 'qr.mjs'))
    const svg = qrSvg(url, { scale: 2, quiet: 1 })
    fs.writeFileSync(path.join(STATE_DIR, 'qr.svg'), svg, 'utf8')
    console.log(`QR 已写入: ${path.join(STATE_DIR, 'qr.svg')}`)
    process.exit(0)
  }

  if (cmd === 'firewall') {
    await ensureFirewallRule(state.port)
    process.exit(0)
  }

  console.log('用法: node dsh-mobile-tray.mjs [start|stop|status|qr|firewall]')
  process.exit(1)
})().catch((e) => { error(e); process.exit(1) })
