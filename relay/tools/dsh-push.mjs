#!/usr/bin/env node
/**
 * dsh-push.mjs — DSH 手机伴侣推送投递工具（M2 推送脚手架）。
 *
 * 职责：读取插件数据目录的 push.json（设备令牌 + 免打扰），向 FCM 投递一条通知。
 * 零依赖：手写 JWT(RS256) + fetch 调用 Google API。
 *
 * 两种凭据模式（二选一）：
 *   1) --fcm-server-key <旧版服务器密钥>   走 FCM legacy API（简单，建议自用）
 *   2) --service-account <JSON文件>        走 FCM HTTP v1（推荐，支持 data 负载）
 *
 * 用法示例：
 *   node dsh-push.mjs --push-file "C:/Users/lcl/AppData/Roaming/DSH Desktop/dsh-home/mobile-companion/push.json" \
 *        --service-account ./firebase-service-account.json \
 *        --title "任务完成" --body "DSH 已回复你的消息" --url "http://192.168.5.124:47896/m/#/chat/sess-xxx"
 *   node dsh-push.mjs --push-file <push.json> --fcm-server-key <key> --title ... --body ... --dry-run
 *
 * 免打扰：默认尊重 push.json 中各设备的免打扰窗口（--force 可忽略）。
 */
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** 组装 FCM HTTP v1 消息体 */
export function buildV1Message({ token, title, body, url }) {
  const message = { token, notification: { title, body } }
  if (url) message.data = { url }
  return { message }
}

/** 组装 FCM legacy 消息体 */
export function buildLegacyMessage({ token, title, body, url }) {
  const msg = { to: token, notification: { title, body }, priority: 'high' }
  if (url) msg.data = { url }
  return msg
}

/** 解析 service account JSON → 换取 OAuth access token（手写 JWT RS256） */
export async function fetchV1AccessToken(sa, fetcher = fetch) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  const jwt = `${signingInput}.${b64url(signer.sign(sa.private_key))}`
  const res = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(`OAuth 失败 HTTP ${res.status}: ${data.error_description || data.error || 'unknown'}`)
  return data.access_token
}

/**
 * 投递一条通知。
 * @param {object} opts
 * @param {object} opts.pushData   push.json 内容（{devices, dnd}）
 * @param {string[]} [opts.deviceIds] 指定设备；缺省全部
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.url]      通知点击跳转地址（<origin>/m/#/chat/<sessionId>）
 * @param {string} [opts.fcmServerKey] legacy 模式
 * @param {object} [opts.serviceAccount] HTTP v1 模式
 * @param {string} [opts.v1Token] 已取得的 OAuth token（测试注入用；缺省走 fetchV1AccessToken）
 * @param {boolean} [opts.force]    忽略免打扰
 * @param {Function} [opts.fetcher] 注入用（测试）；默认全局 fetch
 * @param {Date} [opts.now]         注入用（测试免打扰判定）
 * @returns {Promise<{sent:number, skipped:string[], results:object[]}>}
 */
export async function pushNotify(opts) {
  const { pushData, deviceIds, title, body, url, fcmServerKey, serviceAccount, v1Token: injectedV1Token, force, fetcher = fetch, now } = opts
  if (!pushData || !pushData.devices) throw new Error('push.json 内容缺失（--push-file 指向插件数据目录的 push.json）')
  const targets = Object.entries(pushData.devices)
    .filter(([id]) => !deviceIds || deviceIds.length === 0 || deviceIds.includes(id))

  let v1Token = injectedV1Token || null
  if (!v1Token && serviceAccount) v1Token = await fetchV1AccessToken(serviceAccount)

  const skipped = []
  const results = []
  for (const [deviceId, dev] of targets) {
    if (!force && pushData.dnd && pushData.dnd[deviceId]) {
      const dnd = pushData.dnd[deviceId]
      if (dnd.enabled && dnd.from && dnd.to && inDndWindowLocal(dnd, now || new Date())) {
        skipped.push(deviceId)
        continue
      }
    }
    const token = dev.token
    if (!token) { skipped.push(deviceId); continue }
    let status
    if (v1Token) {
      const projectId = serviceAccount.project_id
      const res = await fetcher(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${v1Token}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildV1Message({ token, title, body, url })),
      })
      status = res.status
    } else {
      const res = await fetcher('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: { authorization: `key=${fcmServerKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildLegacyMessage({ token, title, body, url })),
      })
      status = res.status
    }
    results.push({ deviceId, platform: dev.platform, status })
  }
  return { sent: results.filter((r) => r.status === 200).length, skipped, results }
}

/** 免打扰判定（与插件 lib/push.mjs 同口径，工具内自带以免跨包耦合） */
export function inDndWindowLocal(dnd, date) {
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }
  const now = date.getHours() * 60 + date.getMinutes()
  const from = toMin(dnd.from)
  const to = toMin(dnd.to)
  if (from < to) return now >= from && now < to
  return now >= from || now < to
}

function usage() {
  console.log(`用法：
  node dsh-push.mjs --push-file <push.json路径> (--fcm-server-key <key> | --service-account <sa.json>) \\
       --title <标题> --body <正文> [--url <点击跳转>] [--device <deviceId>]... [--force] [--dry-run]

  --push-file          插件数据目录的 push.json（默认：./push.json）
  --fcm-server-key     FCM 旧版服务器密钥（legacy API）
  --service-account    Firebase 服务账号 JSON 路径（HTTP v1，推荐）
  --title/--body       通知内容
  --url                点击通知后跳转（<origin>/m/#/chat/<sessionId>）
  --device <id>        只发给指定设备（可多次）；缺省全部
  --force              忽略免打扰窗口
  --dry-run            只打印将发给谁，不真正请求 FCM`)
}

const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : def
}
function has(name) {
  return argv.includes(`--${name}`)
}

// CLI 主体仅在直接运行时执行（被测试 import 时不得触发）
const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (isMain) {
  if (has('help') || has('h')) { usage(); process.exit(0) }

  const pushFile = arg('push-file', './push.json')
  const fcmServerKey = arg('fcm-server-key', '')
  const saPath = arg('service-account', '')
  const title = arg('title', 'DSH')
  const body = arg('body', '有新消息')
  const url = arg('url', '')
  const deviceIds = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--device') deviceIds.push(argv[i + 1])

  if (!fcmServerKey && !saPath) { console.error('错误：需要 --fcm-server-key 或 --service-account 之一'); usage(); process.exit(1) }

  const pushData = JSON.parse(readFileSync(pushFile, 'utf8'))
  const serviceAccount = saPath ? JSON.parse(readFileSync(saPath, 'utf8')) : null

  const run = async () => {
    if (has('dry-run')) {
      const targets = Object.entries(pushData.devices).filter(([id]) => !deviceIds.length || deviceIds.includes(id))
      console.log('[dry-run] 将向以下设备发送：')
      for (const [id, dev] of targets) {
        const dnd = pushData.dnd && pushData.dnd[id]
        const quiet = !has('force') && dnd && dnd.enabled && dnd.from && dnd.to && inDndWindowLocal(dnd, new Date())
        console.log(`  ${id} (${dev.platform}) token=${dev.token.slice(0, 10)}… ${quiet ? '【免打扰中，跳过】' : '将发送'}`)
      }
      console.log(`[dry-run] 消息：${title} / ${body}${url ? ' / ' + url : ''}`)
      return
    }
    const result = await pushNotify({ pushData, deviceIds, title, body, url, fcmServerKey, serviceAccount })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.sent === 0 ? 2 : 0
  }

  run().catch((e) => { console.error('发送失败：', e && e.message || e); process.exit(1) })
}
