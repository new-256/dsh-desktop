// 在独立 Cordis 实例里验证宿主插件：加载 → 监听 → 转发改写 → 反向清理释放端口。
// 目的是不重启 DSH 就能发现语法/生命周期/端口问题。
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import net from 'node:net'

const require = createRequire(import.meta.url)
// 插件实际部署在 DSH Desktop 的独立数据目录（DSH_HOME），按 APPDATA 解析以保持可移植。
const appData = process.env.APPDATA ?? 'C:/Users/lcl/AppData/Roaming'
const pluginPath = `${appData}/DSH Desktop/dsh-home/profiles/web/agentrouter-proxy.plugin.mjs`
const plugin = await import(`file:///${pluginPath}`)

// API Key 从环境变量读取，绝不硬编码：$env:AGENTROUTER_API_KEY = "sk-..."（PowerShell）
const KEY = process.env.AGENTROUTER_API_KEY
if (!KEY) {
  console.error('缺少环境变量 AGENTROUTER_API_KEY（agentrouter 的 API Key）。')
  console.error('PowerShell:  $env:AGENTROUTER_API_KEY = "sk-..."  然后重新运行。')
  process.exit(1)
}
const PORT = 8799 // 用非默认端口，避免和真实运行的实例抢占
const DSH_UA = 'deepseek-harness/0.1.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)'

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port })
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
}

const ctx = new Context()
console.log('1) 加载插件 ...')
const fiber = ctx.plugin(plugin, { port: PORT, verbose: true })
await fiber
console.log('   插件已激活, 端口占用 =', await portInUse(PORT))

console.log('2) 经反代发起真实请求（送 DSH 的硬编码 UA）...')
const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': KEY,
    authorization: `Bearer ${KEY}`,
    'anthropic-version': '2023-06-01',
    'user-agent': DSH_UA,
  },
  body: JSON.stringify({
    model: 'deepseek-v4-flash',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with exactly: PLUGIN-OK' }],
  }),
})
const body = await res.json()
const text = (body.content ?? []).find((b) => b.type === 'text')?.text ?? JSON.stringify(body).slice(0, 200)
console.log(`   HTTP ${res.status}  ->  "${String(text).trim()}"`)

console.log('3) 校验错误配置会让激活失败（而不是静默回退）...')
for (const bad of [{ port: 99999 }, { upstream: 'http://insecure.example' }]) {
  try {
    const f = ctx.plugin(plugin, bad)
    await f
    console.log('   !! 未按预期抛错:', JSON.stringify(bad))
  } catch (e) {
    console.log(`   OK 拒绝 ${JSON.stringify(bad)}: ${e.message}`)
  }
}

console.log('4) 卸载并确认端口释放 ...')
await fiber.dispose()
await new Promise((r) => setTimeout(r, 300))
console.log('   端口仍被占用 =', await portInUse(PORT))

process.exit(0)
