// 通过本地反代验证 agent loop 真正依赖的两个能力：SSE 流式增量、Anthropic tool_use。
// API Key 从环境变量读取，绝不硬编码：$env:AGENTROUTER_API_KEY = "sk-..."（PowerShell）
const KEY = process.env.AGENTROUTER_API_KEY
if (!KEY) {
  console.error('缺少环境变量 AGENTROUTER_API_KEY（agentrouter 的 API Key）。')
  console.error('PowerShell:  $env:AGENTROUTER_API_KEY = "sk-..."  然后重新运行。')
  process.exit(1)
}
const BASE = process.env.TEST_BASE ?? 'http://127.0.0.1:8787'
// 故意送 DSH 的真实 UA：若能通过，说明反代改写在真实链路上生效。
const UA = 'deepseek-harness/0.1.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)'

function headers() {
  return {
    'content-type': 'application/json',
    'x-api-key': KEY,
    authorization: `Bearer ${KEY}`,
    'anthropic-version': '2023-06-01',
    'user-agent': UA,
  }
}

async function testStream(model) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model,
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'Count from 1 to 5, separated by spaces. Nothing else.' }],
    }),
  })
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const events = []
  let text = ''
  let chunks = 0
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks++
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const ev = JSON.parse(payload)
        events.push(ev.type)
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text
      } catch {}
    }
  }
  const kinds = [...new Set(events)]
  // 网络分块数 > 1 才能证明是真流式下发，而不是上游/代理整体缓冲后一次性吐出。
  return `OK  网络分块=${chunks}  事件类型=${kinds.join(',')}  文本="${text.trim()}"`
}

async function testTools(model) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model,
      max_tokens: 256,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City name' } },
            required: ['city'],
          },
        },
      ],
      messages: [{ role: 'user', content: 'Use the get_weather tool to check the weather in Paris.' }],
    }),
  })
  if (!res.ok) return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
  const body = await res.json()
  const tu = (body.content ?? []).find((b) => b.type === 'tool_use')
  if (!tu) return `无 tool_use  stop=${body.stop_reason}  blocks=${(body.content ?? []).map((b) => b.type).join(',')}`
  return `OK  stop=${body.stop_reason}  工具=${tu.name}  参数=${JSON.stringify(tu.input)}`
}

for (const model of ['deepseek-v4-flash', 'glm-5.3']) {
  console.log(`\n===== ${model}`)
  console.log('  流式   :', await testStream(model).catch((e) => `ERR ${e.message}`))
  console.log('  工具调用:', await testTools(model).catch((e) => `ERR ${e.message}`))
}
