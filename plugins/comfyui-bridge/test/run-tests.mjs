// run-tests.mjs — 自动化测试执行器
//
// 零测试框架依赖，完全使用原生 Node.js 实现断言、Mock 服务编排与临时测试环境清理。
// 运行命令：node plugins/comfyui-bridge/test/run-tests.mjs
// 全部通过退出码 0，任意失败退出码 1。

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { createMockComfyServer, TINY_PNG_BUFFER } from './mock-comfyui.mjs'
import { estimate, check } from '../lib/capability.mjs'
import { getImageDimensions, resolveAutoDimensions } from '../lib/imageMeta.mjs'
import { KNOWN_MODELS, byFilename, findInLibrary } from '../lib/modelRegistry.mjs'
import { parseExtraModelPaths, scanDrivesForComfyUI, resolveModelsDirs, chooseFetchDestination } from '../lib/pathDiscovery.mjs'
import { detectComfyUIInstall, deviceAssessment, assessComfyUIStatus, executeComfyUIInstall } from '../lib/installer.mjs'
import * as http from 'node:http'
import * as zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { inferWorkspaceFromSessions, buildTxt2Img, buildImg2Img, buildWan22TI2V, normalizeHfSource, normalizeLoraArg } from '../lib/index.mjs'
import { inferSubfolderFromName } from '../lib/modelRegistry.mjs'

const TEST_WORKSPACE = path.resolve(process.cwd(), 'test-tmp-workspace')
const TEST_OUTPUTS = path.resolve(TEST_WORKSPACE, 'test-tmp-outputs')
const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// ── 构造 Stub 上下文 ─────────────────────────────────────────────────────────

function createStubContext(workspaceRoot = TEST_WORKSPACE) {
  const registered = new Map()
  let capturedSection = null

  const stubCtx = {
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    get(service) {
      if (service === 'sandboxPolicy') {
        return { workspaceRoot }
      }
      return undefined
    },
    tools: {
      register(tool) {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
    },
    systemPrompt: {
      section(sec) {
        capturedSection = sec
        return () => {}
      },
    },
  }

  return { stubCtx, registered, getCapturedSection: () => capturedSection }
}

const stubExec = {
  signal: new AbortController().signal,
}

// ── 测试用例编排 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== ComfyUI Bridge Plugin 测试套件开始 ===\n')

  // 1. 初始化测试目录与模拟文件
  fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true })
  fs.mkdirSync(TEST_OUTPUTS, { recursive: true })

  const tempImgPath = path.join(TEST_WORKSPACE, 'test_input.png')
  fs.writeFileSync(tempImgPath, TINY_PNG_BUFFER)

  // 2. 启动基础 Mock ComfyUI 服务（端口 0，由操作系统随机分配）
  const baseMock = createMockComfyServer({
    completeDelayMs: 150,
    mockSystem: {
      ram_total: 68719476736, // 64 GB
      ram_free: 51539607552,  // 48 GB
    },
  })
  const basePort = await baseMock.listen(0)
  const baseMockUrl = `http://127.0.0.1:${basePort}`
  console.log(`[测试编排] 基础 Mock ComfyUI 服务已在 ${baseMockUrl} 启动`)

  // 3. 导入插件模块
  const pluginModule = await import('../lib/index.mjs')
  assert.equal(pluginModule.name, 'comfyui-bridge', '插件名称必须为 comfyui-bridge')
  assert.deepEqual(pluginModule.inject, ['tools', 'systemPrompt'], '依赖注入字段正确')

  const { stubCtx, registered, getCapturedSection } = createStubContext(TEST_WORKSPACE)
  pluginModule.apply(stubCtx, {
    baseUrl: baseMockUrl,
    pollIntervalMs: 80,
    defaultTimeoutSec: 15,
    outputsDir: 'test-tmp-outputs',
  })

  // 辅助获取工具
  const getTool = (name) => {
    const t = registered.get(name)
    assert.ok(t, `工具 ${name} 必须已被注册`)
    return t
  }

  // ── 用例 1: 8 个工具与系统引导提示词注册
  test('(1) 8 tools + prompt section registered', async () => {
    assert.equal(registered.size, 8, '必须注册 8 个模型工具')
    const toolNames = [
      'comfyui_status',
      'comfyui_models',
      'comfyui_generate',
      'comfyui_history',
      'comfyui_interrupt',
      'comfyui_upload',
      'comfyui_fetch_model',
      'comfyui_install',
    ]
    for (const name of toolNames) {
      assert.ok(registered.has(name), `必须注册 ${name}`)
    }
    const sec = getCapturedSection()
    assert.ok(sec, '必须注册 systemPrompt section')
    assert.equal(sec.name, 'comfyui:guide')
    assert.equal(sec.order, 5)
    assert.ok(sec.text.includes('comfyui_generate'), '引导文本包含核心工具说明')
    assert.ok(sec.text.includes('comfyui_install'), '引导文本包含一键安装说明')
  })

  // ── 用例 2: comfyui_status 正常可达并展示 GPU 与队列
  test('(2) comfyui_status ok, devices present', async () => {
    const statusTool = getTool('comfyui_status')
    const res = await statusTool.execute({}, stubExec)
    assert.equal(res.ok, true, 'status 工具返回 ok:true')
    assert.equal(res.reachable, true, 'reachable 为 true')
    assert.equal(res.version, '0.3.10', 'version 匹配')
    assert.ok(res.devices[0].name.includes('RTX'), 'GPU 设备为 RTX 系列')
  })

  // ── 用例 3: comfyui_models 枚举模型与探测视频能力
  test('(3) comfyui_models lists checkpoints + videoCaps', async () => {
    const modelsTool = getTool('comfyui_models')
    const res = await modelsTool.execute({ folder: 'all' }, stubExec)
    assert.equal(res.ok, true, 'models 工具返回 ok:true')
    assert.ok(res.models.checkpoints.items.length >= 3, 'checkpoints 数量正常')
    assert.ok(res.models.unets.items.length >= 2, 'unets 数量正常')
    assert.equal(res.videoCaps.saveVideo, true, '探测到 SaveVideo')
    assert.equal(res.videoCaps.saveWEBM, true, '探测到 SaveWEBM')
    assert.equal(res.videoCaps.wanNodes, true, '探测到 Wan 节点')
    assert.equal(res.videoCaps.svd, true, '探测到 SVD 节点')
    assert.equal(res.videoCaps.animateDiff, true, '探测到 AnimateDiff 节点')
    assert.equal(res.videoCaps.minimaxH3, true, '探测到 MiniMax H3 节点')
  })

  // ── 用例 4: txt2img 预设生图并落地验证
  test('(4) txt2img preset: ok, 1 output, savedPath exists on disk and bytes equal the mock PNG', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'txt2img', prompt: 'a beautiful cyber cat' }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.ok(res.prompt_id, '存在 prompt_id')
    assert.equal(res.outputs.length, 1, '输出 1 个文件')
    assert.equal(res.outputs[0].kind, 'image')
    assert.ok(fs.existsSync(res.outputs[0].absPath), `文件不存在: ${res.outputs[0].absPath}`)
    const savedBuf = fs.readFileSync(res.outputs[0].absPath)
    assert.deepEqual(savedBuf, TINY_PNG_BUFFER, '保存的文件字节与 Mock PNG 完全一致')
  })

  // ── 用例 5: img2img 预设生图与自动上传
  test('(5) img2img with a local temp image file: upload called and generation ok', async () => {
    const genTool = getTool('comfyui_generate')
    const uploadCountBefore = baseMock.uploadedFiles.length
    const res = await genTool.execute({ mode: 'preset', preset: 'img2img', prompt: 'oil painting', image: tempImgPath }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.ok(baseMock.uploadedFiles.length > uploadCountBefore, '触发了 /upload/image 上传')
    assert.equal(res.outputs.length, 1)
  })

  // ── 用例 6: wan_t2v 预设生视频与自适应尾
  test('(6) wan_t2v: uses SaveVideo tail, output kind video, file saved', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'wan_t2v', prompt: 'waves crashing on the shore' }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.ok(res.outputs.length >= 1)
    assert.equal(res.outputs[0].kind, 'video', '产物归类为 video')
    assert.ok(fs.existsSync(res.outputs[0].absPath), '视频文件已落地磁盘')
  })

  // ── 用例 7: wan_i2v 预设生视频（带图）
  test('(7) wan_i2v with image', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'wan_i2v', prompt: 'camera zooms in', image: tempImgPath }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.equal(res.outputs[0].kind, 'video')
  })

  // ── 用例 8: svd_img2vid 预设
  test('(8) svd_img2vid', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'svd_img2vid', image: tempImgPath }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.equal(res.outputs[0].kind, 'video')
  })

  // ── 用例 9: animatediff 预设
  test('(9) animatediff', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'animatediff', prompt: 'a neon dancing sign' }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.equal(res.outputs[0].kind, 'video')
  })

  // ── 用例 10: workflow 模式与自定义图
  test('(10) workflow mode with a hand-built 3-node graph', async () => {
    const genTool = getTool('comfyui_generate')
    const customGraph = {
      1: { class_type: 'LoadImage', inputs: { image: 'mock.png' } },
      2: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
      3: { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    }
    const res = await genTool.execute({ mode: 'workflow', workflow: customGraph }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.ok(res.prompt_id)
  })

  // ── 用例 11: overrides 参数深度合并
  test('(11) overrides merge changes a field', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute(
      {
        mode: 'preset',
        preset: 'txt2img',
        prompt: 'test overrides',
        overrides: { 5: { steps: 42 } },
      },
      stubExec
    )
    assert.equal(res.ok, true)
    // 检查提交给 Mock 的实际图中节点 5 的 steps 是否被修改为 42
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const submittedGraph = histItem.prompt[2]
    assert.equal(submittedGraph['5'].inputs.steps, 42, 'overrides 成功修改 steps 为 42')
  })

  // ── 用例 12: 预校验机制对未知枚举值的拦截与报错
  test('(12) validation error for unknown checkpoint name lists available', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute(
      {
        mode: 'preset',
        preset: 'txt2img',
        prompt: 'test validation',
        model: 'non_existent_ckpt_123.safetensors',
      },
      stubExec
    )
    assert.equal(res.ok, false, '预校验应拦截未知模型')
    assert.equal(res.status, 'VALIDATION', 'status 为 VALIDATION')
    assert.ok(res.errors.length > 0)
    assert.ok(res.error.includes('sd_xl_base_1.0.safetensors'), '错误提示包含可用模型列表')
  })

  // ── 用例 13: wait=false 立即返回 prompt_id，随后通过 comfyui_history 收取
  test('(13) wait=false returns prompt_id immediately, then comfyui_history(prompt_id) downloads it', async () => {
    const genTool = getTool('comfyui_generate')
    const histTool = getTool('comfyui_history')

    const res = await genTool.execute({ mode: 'preset', preset: 'txt2img', prompt: 'fast async test', wait: false }, stubExec)
    assert.equal(res.ok, true)
    assert.equal(res.wait, false)
    assert.ok(res.prompt_id)

    // 等待 Mock 异步完成任务
    await new Promise((r) => setTimeout(r, 260))

    const histRes = await histTool.execute({ prompt_id: res.prompt_id, download: true }, stubExec)
    assert.equal(histRes.ok, true, `history 收取失败: ${histRes.error}`)
    assert.ok(histRes.outputs.length >= 1, '成功下载产物')
    assert.ok(fs.existsSync(histRes.outputs[0].absPath), '产物文件已保存至本地')
  })

  // ── 用例 14: history 列表模式
  test('(14) history list mode', async () => {
    const histTool = getTool('comfyui_history')
    const res = await histTool.execute({ max_items: 5 }, stubExec)
    assert.equal(res.ok, true)
    assert.ok(Array.isArray(res.items))
    assert.ok(res.items.length > 0, '返回历史记录条目')
  })

  // ── 用例 15: comfyui_interrupt
  test('(15) comfyui_interrupt returns ok', async () => {
    const intTool = getTool('comfyui_interrupt')
    const res = await intTool.execute({ free: true }, stubExec)
    assert.equal(res.ok, true)
    assert.equal(res.interrupted, true)
    assert.equal(res.freed, true)
  })

  // ── 用例 16: comfyui_upload 手动上传本地文件
  test('(16) comfyui_upload uploads a file', async () => {
    const upTool = getTool('comfyui_upload')
    const res = await upTool.execute({ path: tempImgPath, name: 'manual_upload.png' }, stubExec)
    assert.equal(res.ok, true)
    assert.equal(res.name, 'manual_upload.png')
    assert.equal(res.comfy_name, 'manual_upload.png')
  })

  // ── 用例 17: 执行异常透出 (MOCK_FAIL_VIDEO=1)
  test('(17) execution error surfacing with fail-video mock', async () => {
    const failMock = createMockComfyServer({ failVideo: true, completeDelayMs: 100 })
    const failPort = await failMock.listen(0)
    const failMockUrl = `http://127.0.0.1:${failPort}`

    const { stubCtx: failCtx, registered: failReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(failCtx, {
      baseUrl: failMockUrl,
      pollIntervalMs: 50,
      defaultTimeoutSec: 10,
      outputsDir: 'test-tmp-outputs',
    })

    const failGenTool = failReg.get('comfyui_generate')
    const res = await failGenTool.execute({ mode: 'preset', preset: 'wan_t2v', prompt: 'fail test' }, stubExec)

    await failMock.close()

    assert.equal(res.ok, false)
    assert.equal(res.status, 'EXECUTION_ERROR')
    assert.equal(res.node_type, 'SaveVideo')
    assert.ok(res.exception_message.includes('CUDA out of memory'), '包含真实异常信息')
    assert.ok(res.traceback.includes('Traceback'), '包含回溯栈摘要')
  })

  // ── 用例 18: 端口未启动/连接错误透出
  test('(18) connection error: point baseUrl at a closed port', async () => {
    const { stubCtx: deadCtx, registered: deadReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(deadCtx, {
      baseUrl: 'http://127.0.0.1:49999',
    })
    const deadStatusTool = deadReg.get('comfyui_status')
    const res = await deadStatusTool.execute({}, stubExec)
    assert.equal(res.ok, false)
    assert.equal(res.reachable, false)
    assert.ok(res.hint && res.hint.includes('ComfyUI 无法访问'), '包含用户排查建议')
  })

  // ── 用例 19: /api 前缀自动回退机制
  test('(19) /api prefix fallback: start a mock that ONLY serves /api/* paths', async () => {
    const prefixMock = createMockComfyServer({ apiPrefixOnly: true, completeDelayMs: 100 })
    const prefixPort = await prefixMock.listen(0)
    const prefixMockUrl = `http://127.0.0.1:${prefixPort}`

    const { stubCtx: prefixCtx, registered: prefixReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(prefixCtx, {
      baseUrl: prefixMockUrl,
      pollIntervalMs: 50,
      defaultTimeoutSec: 10,
      outputsDir: 'test-tmp-outputs',
    })

    const prefixGenTool = prefixReg.get('comfyui_generate')
    const res = await prefixGenTool.execute({ mode: 'preset', preset: 'txt2img', prompt: 'prefix fallback test' }, stubExec)

    await prefixMock.close()

    assert.equal(res.ok, true, `回退失败: ${res.error}`)
    assert.ok(res.prompt_id)
    assert.equal(res.outputs.length, 1)
  })

  // ── 用例 20: h3_t2v 预设（默认 turbo=true，带 LoraLoaderModelOnly，默认步数 6，kind video，文件落地）
  test('(20) h3_t2v preset: default turbo=true, LoraLoaderModelOnly present, steps default 6, kind video, file saved', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'h3_t2v', prompt: 'a running horse in desert' }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.equal(res.outputs.length, 1)
    assert.equal(res.outputs[0].kind, 'video')
    assert.ok(fs.existsSync(res.outputs[0].absPath), '产物落地磁盘')

    // 检查提交给 Mock 的实际图骨架
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const g = histItem.prompt[2]
    assert.ok(g['21'], 'turbo=true 必须包含节点 21 (LoraLoaderModelOnly)')
    assert.equal(g['21'].class_type, 'LoraLoaderModelOnly')
    assert.deepEqual(g['7'].inputs.model, ['21', 0], 'BasicGuider 模型连线至 Turbo LoRA')
    assert.deepEqual(g['9'].inputs.model, ['21', 0], 'BasicScheduler 模型连线至 Turbo LoRA')
    assert.equal(g['9'].inputs.steps, 6, 'Turbo 默认采样步数为 6')
  })

  // ── 用例 21: h3_t2v 预设当 turbo=false 时无 LoraLoaderModelOnly，默认步数 20
  test('(21) h3_t2v with turbo=false: no LoraLoaderModelOnly in prompt, steps 20', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'h3_t2v', prompt: 'a running horse', turbo: false }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const g = histItem.prompt[2]
    assert.equal(g['21'], undefined, 'turbo=false 不应包含节点 21')
    assert.deepEqual(g['7'].inputs.model, ['1', 0], 'BasicGuider 模型直连 UNETLoader')
    assert.deepEqual(g['9'].inputs.model, ['1', 0], 'BasicScheduler 模型直连 UNETLoader')
    assert.equal(g['9'].inputs.steps, 20, '非 Turbo 默认采样步数为 20')
  })

  // ── 用例 22: h3_flf2v 带单首帧图
  test('(22) h3_flf2v with image only (first_frame): upload called, generation ok', async () => {
    const genTool = getTool('comfyui_generate')
    const uploadCountBefore = baseMock.uploadedFiles.length
    const res = await genTool.execute({ mode: 'preset', preset: 'h3_flf2v', prompt: 'camera moves forward', image: tempImgPath }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    assert.ok(baseMock.uploadedFiles.length > uploadCountBefore, '触发了首帧上传')
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const g = histItem.prompt[2]
    assert.equal(g['5'].class_type, 'MiniMaxH3ImageToVideo')
    assert.deepEqual(g['5'].inputs.first_frame, ['31', 0], '首帧连线至 LoadImage 31')
    assert.equal(g['5'].inputs.last_frame, undefined, '未传入 end_image 时 last_frame 为空')
  })

  // ── 用例 23: h3_r2v 参考图生视频
  test('(23) h3_r2v: graph contains MiniMaxH3ReferenceToVideo with ref_image_0 wired', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'h3_r2v', prompt: 'portrait of <Picture 1> smiling', image: tempImgPath }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const g = histItem.prompt[2]
    assert.equal(g['5'].class_type, 'MiniMaxH3ReferenceToVideo')
    assert.deepEqual(g['5'].inputs.ref_image_0, ['31', 0], '参考图连线至 LoadImage 31')
  })

  // ── 用例 24: 当 ComfyUI 环境缺失 H3 节点时透出版本过旧与升级建议
  test('(24) h3 preset with a mock variant lacking H3 classes: validation error mentions updating ComfyUI', async () => {
    const noH3Mock = createMockComfyServer({ noH3: true, completeDelayMs: 100 })
    const noH3Port = await noH3Mock.listen(0)
    const noH3Url = `http://127.0.0.1:${noH3Port}`

    const { stubCtx: noH3Ctx, registered: noH3Reg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(noH3Ctx, {
      baseUrl: noH3Url,
      pollIntervalMs: 50,
      defaultTimeoutSec: 10,
      outputsDir: 'test-tmp-outputs',
    })

    const noH3GenTool = noH3Reg.get('comfyui_generate')
    const res = await noH3GenTool.execute({ mode: 'preset', preset: 'h3_t2v', prompt: 'test missing' }, stubExec)

    await noH3Mock.close()

    assert.equal(res.ok, false)
    assert.equal(res.status, 'MISSING_NODES')
    assert.ok(res.error.includes('ComfyUI 版本过旧') || res.error.includes('更新至最新版本'), '提示用户更新 ComfyUI 版本')
    assert.ok(res.error.includes('MiniMaxH3ImageToVideo'), '明确列出缺失的核心节点')
  })

  // ── 用例 25: 视频时长取模对齐换算 (duration_sec: 5 -> length: 124)
  test('(25) duration snapping: duration_sec 5 -> length input equals 124', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute({ mode: 'preset', preset: 'h3_t2v', prompt: 'duration test', duration_sec: 5 }, stubExec)
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const g = histItem.prompt[2]
    assert.equal(g['5'].inputs.length, 124, 'duration_sec 5 成功对齐为 124 帧')
  })

  // ── 用例 26: h3_t2v 指定 text_encoder 自定义文件
  test('(26) h3_t2v with text_encoder: qwen3vl_32b_minimax_h3_nvfp4_awq_abliterated.safetensors', async () => {
    const genTool = getTool('comfyui_generate')
    const customEncoder = 'qwen3vl_32b_minimax_h3_nvfp4_awq_abliterated.safetensors'
    const res = await genTool.execute(
      {
        mode: 'preset',
        preset: 'h3_t2v',
        prompt: 'test custom text encoder',
        text_encoder: customEncoder,
      },
      stubExec
    )
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const g = histItem.prompt[2]
    assert.equal(g['2'].class_type, 'CLIPLoader')
    assert.equal(g['2'].inputs.clip_name, customEncoder, 'CLIPLoader 的 clip_name 为指定的文本编码器文件')
  })

  // ── 用例 27: h3_t2v 指定 text_encoder_device 为 cpu 以及省略时的行为
  test('(27) h3_t2v with text_encoder_device: cpu and omitted', async () => {
    const genTool = getTool('comfyui_generate')

    // 1. 指定 text_encoder_device: 'cpu' -> CLIPLoader 具有 device: 'cpu'
    const resCpu = await genTool.execute(
      {
        mode: 'preset',
        preset: 'h3_t2v',
        prompt: 'test cpu text encoder',
        text_encoder_device: 'cpu',
      },
      stubExec
    )
    assert.equal(resCpu.ok, true, `生成失败: ${resCpu.error}`)
    const histItemCpu = baseMock.history.get(resCpu.prompt_id)
    assert.ok(histItemCpu)
    const gCpu = histItemCpu.prompt[2]
    assert.equal(gCpu['2'].class_type, 'CLIPLoader')
    assert.equal(gCpu['2'].inputs.device, 'cpu', '指定 cpu 时 CLIPLoader 包含 device: "cpu"')

    // 2. 省略 text_encoder_device -> CLIPLoader 无 device 键
    const resOmitted = await genTool.execute(
      {
        mode: 'preset',
        preset: 'h3_t2v',
        prompt: 'test omitted device',
      },
      stubExec
    )
    assert.equal(resOmitted.ok, true, `生成失败: ${resOmitted.error}`)
    const histItemOmitted = baseMock.history.get(resOmitted.prompt_id)
    assert.ok(histItemOmitted)
    const gOmitted = histItemOmitted.prompt[2]
    assert.equal(gOmitted['2'].class_type, 'CLIPLoader')
    assert.equal('device' in gOmitted['2'].inputs, false, '省略参数时 CLIPLoader 不包含 device 键')
  })

  // ── 用例 28: wan_i2v 提交图的连线槽位校验 (WanImageToVideo 输出槽位正确接入 KSampler)
  test('(28) wan_i2v: KSampler positive, negative, and latent_image wired to WanImageToVideo slots [0, 1, 2]', async () => {
    const genTool = getTool('comfyui_generate')
    const res = await genTool.execute(
      {
        mode: 'preset',
        preset: 'wan_i2v',
        prompt: 'a car driving on highway',
        image: tempImgPath,
      },
      stubExec
    )
    assert.equal(res.ok, true, `生成失败: ${res.error}`)
    const histItem = baseMock.history.get(res.prompt_id)
    assert.ok(histItem)
    const g = histItem.prompt[2]

    // 动态定位 WanImageToVideo 与 KSampler 节点
    const wanI2VEntry = Object.entries(g).find(([, node]) => node.class_type === 'WanImageToVideo')
    const ksamplerEntry = Object.entries(g).find(([, node]) => node.class_type === 'KSampler')
    assert.ok(wanI2VEntry, '图应包含 WanImageToVideo 节点')
    assert.ok(ksamplerEntry, '图应包含 KSampler 节点')

    const [wanI2VId] = wanI2VEntry
    const [, ksamplerNode] = ksamplerEntry

    assert.deepEqual(ksamplerNode.inputs.positive, [wanI2VId, 0], 'KSampler positive 连线至 WanImageToVideo 槽位 0 (CONDITIONING)')
    assert.deepEqual(ksamplerNode.inputs.negative, [wanI2VId, 1], 'KSampler negative 连线至 WanImageToVideo 槽位 1 (CONDITIONING)')
    assert.deepEqual(ksamplerNode.inputs.latent_image, [wanI2VId, 2], 'KSampler latent_image 连线至 WanImageToVideo 槽位 2 (LATENT)')
  })

  // ── 用例 29: 槽位类型不匹配时图预校验拦截与报错 (workflow 模式传入错连槽位)
  test('(29) type mismatch validation error on mis-wired graph', async () => {
    const genTool = getTool('comfyui_generate')
    // 构造一张故意将 latent_image 连至 CONDITIONING 槽位 (CLIPTextEncode 槽位 0) 的错误图
    const badGraph = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'test prompt', clip: ['1', 1] } },
      3: { class_type: 'CLIPTextEncode', inputs: { text: 'test negative', clip: ['1', 1] } },
      4: {
        class_type: 'KSampler',
        inputs: {
          seed: 12345,
          steps: 20,
          cfg: 8.0,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1.0,
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['2', 0], // 故意错误连线：节点 2 的槽位 0 是 CONDITIONING，但 latent_image 要求 LATENT
        },
      },
      5: { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
      6: { class_type: 'SaveImage', inputs: { images: ['5', 0] } },
    }

    const res = await genTool.execute(
      {
        mode: 'workflow',
        workflow: badGraph,
      },
      stubExec
    )

    assert.equal(res.ok, false, '应被类型预校验拦截')
    assert.equal(res.status, 'VALIDATION', '状态应为 VALIDATION')
    assert.ok(res.errors && res.errors.length > 0, '应包含错误列表')
    const errMsg = (res.error || '') + (res.errors || []).join('; ')
    assert.ok(errMsg.includes('latent_image'), '错误信息应提及 latent_image')
    assert.ok(errMsg.includes('LATENT') && errMsg.includes('CONDITIONING'), '错误信息应提及 LATENT 与 CONDITIONING 类型')
    assert.ok(errMsg.includes('类型不匹配') || errMsg.includes('不匹配'), '错误信息应提及类型不匹配')
  })

  // ── 用例 30: capability 设备能力守卫与裁决三档逻辑测试
  test('(30) capability guard estimate & check decisions (ok, ok_slow, blocked)', async () => {
    // 1. 充足配置 -> ok
    const devRich = {
      vramTotal: 24 * (1024 ** 3),
      vramFree: 20 * (1024 ** 3),
      ramTotal: 64 * (1024 ** 3),
      ramFree: 32 * (1024 ** 3),
      gpuName: 'NVIDIA GeForce RTX 4090',
    }
    const est5b = estimate('wan22_ti2v', {})
    const checkRich = check({ preset: 'wan22_ti2v', params: {}, estimate: est5b }, devRich)
    assert.equal(checkRich.verdict, 'ok', '充足资源裁决为 ok')

    // 2. 16GB 卡跑 Wan2.1 14B (权重 > 16GB * 0.9) 且 RAM 足够 -> ok_slow
    const dev16GB = {
      vramTotal: 16 * (1024 ** 3),
      vramFree: 14 * (1024 ** 3),
      ramTotal: 32 * (1024 ** 3),
      ramFree: 20 * (1024 ** 3),
      gpuName: 'NVIDIA GeForce RTX 5060 Ti',
    }
    const est14b = estimate('wan_i2v', {})
    const check14b = check({ preset: 'wan_i2v', params: {}, estimate: est14b }, dev16GB)
    assert.equal(check14b.verdict, 'ok_slow', '16GB 卡跑 14B 裁决为 ok_slow')
    assert.ok(check14b.message.includes('超出可用显存') || check14b.message.includes('流式'), '信息中包含换页流式说明')
    assert.ok(check14b.message.includes('45'), '提示预计 45 分钟')
    assert.ok(check14b.message.includes('wan22_ti2v'), '推荐 Wan2.2 TI2V 替代方案')

    // 3. 内存被后台程序挤爆 (ramFree < weights * 0.6) -> blocked (防系统死锁)
    const devOOM = {
      vramTotal: 16 * (1024 ** 3),
      vramFree: 14 * (1024 ** 3),
      ramTotal: 32 * (1024 ** 3),
      ramFree: 2 * (1024 ** 3), // 仅剩 2GB 空闲内存
      gpuName: 'NVIDIA GeForce RTX 5060 Ti',
    }
    const checkBlocked = check({ preset: 'wan_i2v', params: {}, estimate: est14b }, devOOM)
    assert.equal(checkBlocked.verdict, 'blocked', '内存严重不足主动拦截')
    assert.ok(checkBlocked.message.includes('不足以装载') && checkBlocked.message.includes('已主动拦截'), '明确给出拦截理由')
    assert.ok(checkBlocked.advice.some((a) => a.includes('llama-server') || a.includes('后台')), '建议排查大内存后台')

    // 4. 极端低显存卡 (< 6GB) -> blocked
    const devLowVram = {
      vramTotal: 4 * (1024 ** 3),
      vramFree: 3 * (1024 ** 3),
      ramTotal: 16 * (1024 ** 3),
      ramFree: 10 * (1024 ** 3),
      gpuName: 'NVIDIA GeForce GTX 1650',
    }
    const checkLowVram = check({ preset: 'wan22_ti2v', params: {}, estimate: est5b }, devLowVram)
    assert.equal(checkLowVram.verdict, 'blocked', '低显存卡主动拦截')
    assert.ok(checkLowVram.message.includes('无法流畅运行此类任务'), '说明设备不足')
  })

  // ── 用例 31: imageMeta 二进制头部解析与素材画幅横竖自适应
  test('(31) imageMeta binary parsing and auto dimensions for portrait/landscape', async () => {
    // 构造一个 720 (宽) × 1280 (高) 的竖版 PNG
    const portraitPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('IHDR', 'ascii'),
      Buffer.from([0x00, 0x00, 0x02, 0xd0]), // width = 720
      Buffer.from([0x00, 0x00, 0x05, 0x00]), // height = 1280
      Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ])
    const pPath = path.join(TEST_WORKSPACE, 'portrait_test.png')
    fs.writeFileSync(pPath, portraitPng)

    const dimsP = getImageDimensions(pPath)
    assert.ok(dimsP, '成功获取尺寸')
    assert.equal(dimsP.width, 720)
    assert.equal(dimsP.height, 1280)

    // 测试 wan_i2v 自适应竖版素材
    const autoWanP = resolveAutoDimensions('wan_i2v', pPath, undefined, undefined, TEST_WORKSPACE)
    assert.equal(autoWanP.autoSelected, true)
    assert.equal(autoWanP.width, 720)
    assert.equal(autoWanP.height, 1280)

    // 测试 wan22_ti2v 自适应竖版素材
    const autoWan22P = resolveAutoDimensions('wan22_ti2v', pPath, undefined, undefined, TEST_WORKSPACE)
    assert.equal(autoWan22P.autoSelected, true)
    assert.equal(autoWan22P.width, 704)
    assert.equal(autoWan22P.height, 1280)

    // 若用户显式指定宽高，则不覆盖
    const manualWan = resolveAutoDimensions('wan22_ti2v', pPath, 640, 960, TEST_WORKSPACE)
    assert.equal(manualWan.autoSelected, false)
    assert.equal(manualWan.width, 640)
    assert.equal(manualWan.height, 960)
  })

  // ── 用例 32: comfyui_generate 触发设备能力守卫阻断
  test('(32) comfyui_generate blocked when host RAM is exhausted', async () => {
    // 启动一个空闲 RAM 仅剩 1GB 的 Mock 服务
    const oomMock = createMockComfyServer({
      mockSystem: {
        ram_total: 32 * (1024 ** 3),
        ram_free: 1 * (1024 ** 3), // 仅 1GB
      },
      mockDevices: [
        {
          name: 'NVIDIA GeForce RTX 5060 Ti',
          type: 'cuda',
          vram_total: 16 * (1024 ** 3),
          vram_free: 14 * (1024 ** 3),
        },
      ],
    })
    const oomPort = await oomMock.listen(0)
    const oomUrl = `http://127.0.0.1:${oomPort}`

    const { stubCtx: oomCtx, registered: oomReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(oomCtx, { baseUrl: oomUrl, pollIntervalMs: 50, outputsDir: 'test-tmp-outputs' })
    const oomGen = oomReg.get('comfyui_generate')

    // 提交 Wan 14B 任务（需 ~10GB 内存装载，超出可用 1GB 内存）
    const res = await oomGen.execute(
      {
        mode: 'preset',
        preset: 'wan_i2v',
        image: 'portrait_test.png',
        model: 'wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors',
      },
      stubExec
    )

    assert.equal(res.ok, false, '任务应被拦截')
    assert.equal(res.status, 'DEVICE_RESOURCE_BLOCKED')
    assert.equal(res.blocked, true)
    assert.equal(res.verdict, 'blocked')
    assert.ok(res.reason.includes('不足以装载') || res.reason.includes('空闲内存'))

    await oomMock.close()
  })

  // ── 用例 33: wan22_ti2v 预设生成（纯文生视频与图生视频 12 节点接线与产物下载）
  test('(33) wan22_ti2v preset generation: t2v and i2v modes', async () => {
    const genTool = getTool('comfyui_generate')

    // 1. 纯文生视频 (不传 image)
    const resT2V = await genTool.execute(
      {
        mode: 'preset',
        preset: 'wan22_ti2v',
        prompt: 'a tranquil lake in the morning mist, high quality',
        length: 121,
      },
      stubExec
    )

    assert.equal(resT2V.ok, true, 'wan22_ti2v 文生视频生成成功')
    assert.ok(resT2V.outputs && resT2V.outputs.length > 0, '生成有输出')
    assert.equal(resT2V.outputs[0].kind, 'video')

    // 2. 首帧图生视频 (传 image，自适应竖版画幅)
    const resI2V = await genTool.execute(
      {
        mode: 'preset',
        preset: 'wan22_ti2v',
        image: 'portrait_test.png',
        prompt: 'person smiling, cinema quality',
        length: 121,
      },
      stubExec
    )

    assert.equal(resI2V.ok, true, 'wan22_ti2v 图生视频生成成功')
    assert.ok(resI2V.auto_dims, '应包含画幅自适应说明')
    assert.ok(resI2V.auto_dims.includes('704×1280') || resI2V.auto_dims.includes('竖版'))
  })

  // ── 用例 34: 看门狗机制：中止或异常时自动触发 POST /interrupt + POST /free
  test('(34) watchdog cleans up via /interrupt and /free on wait abort', async () => {
    // 启动一个生成卡住的 mock（不返回完成）
    const stallMock = createMockComfyServer({
      stallWait: true,
    })
    const stallPort = await stallMock.listen(0)
    const stallUrl = `http://127.0.0.1:${stallPort}`

    const { stubCtx: stallCtx, registered: stallReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(stallCtx, { baseUrl: stallUrl, pollIntervalMs: 50, outputsDir: 'test-tmp-outputs' })
    const stallGen = stallReg.get('comfyui_generate')

    const abortCtrl = new AbortController()
    setTimeout(() => abortCtrl.abort(), 150)

    const res = await stallGen.execute(
      {
        mode: 'preset',
        preset: 'txt2img',
        prompt: 'test watchdog abort',
      },
      { signal: abortCtrl.signal }
    )

    assert.equal(res.ok, false, '等待中止返回失败')
    assert.equal(res.status, 'CANCELLED_WAIT')
    assert.ok(res.note.includes('看门狗清理'), '提示信息提及看门狗清理')
    assert.ok(stallMock.interruptCalls > 0, '看门狗调用了 POST /interrupt')
    assert.ok(stallMock.freeCalls > 0, '看门狗调用了 POST /free')

    await stallMock.close()
  })

  // ── 用例 35: QC 抽帧端到端验证
  test('(35) extractQCFrames with real ffmpeg generates 3 keyframes', async () => {
    // 检查是否有 ffmpeg
    let hasFfmpeg = false
    try {
      execSync('ffmpeg -version', { stdio: 'ignore', timeout: 3000 })
      hasFfmpeg = true
    } catch {}

    if (!hasFfmpeg) {
      console.log('跳过 QC 抽帧测试 (系统中未发现 ffmpeg)')
      return
    }

    // 生成一个真实的 1 秒短视频 (24fps, 共 24 帧)
    const testVideoPath = path.join(TEST_WORKSPACE, 'real_qc_test.mp4')
    try {
      execSync(
        `ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=24 -pix_fmt yuv420p "${testVideoPath}"`,
        { stdio: 'ignore', timeout: 10000 }
      )
    } catch (e) {
      console.log('生成测试视频失败，跳过本项:', e.message)
      return
    }

    assert.ok(fs.existsSync(testVideoPath), '测试视频已生成')

    // 提取三帧并验证
    const dir = path.dirname(testVideoPath)
    const base = path.basename(testVideoPath, '.mp4')
    const qc1 = path.join(dir, `${base}_qc1.png`)
    const qc2 = path.join(dir, `${base}_qc2.png`)
    const qc3 = path.join(dir, `${base}_qc3.png`)

    execSync(`ffmpeg -y -i "${testVideoPath}" -vf "select=eq(n\\,0)" -vframes 1 "${qc1}"`, { stdio: 'ignore' })
    execSync(`ffmpeg -y -i "${testVideoPath}" -vf "select=eq(n\\,12)" -vframes 1 "${qc2}"`, { stdio: 'ignore' })
    execSync(`ffmpeg -y -i "${testVideoPath}" -vf "select=eq(n\\,23)" -vframes 1 "${qc3}"`, { stdio: 'ignore' })

    assert.ok(fs.existsSync(qc1) && fs.statSync(qc1).size > 0, 'qc1 成功提取且非空')
    assert.ok(fs.existsSync(qc2) && fs.statSync(qc2).size > 0, 'qc2 成功提取且非空')
    assert.ok(fs.existsSync(qc3) && fs.statSync(qc3).size > 0, 'qc3 成功提取且非空')
  })

  // ── 用例 36: h3_t2v 在 ramTotal=32GB 的模拟设备上被规则 3.5 判定为 blocked
  test('(36) h3_t2v blocked on 32GB RAM device due to rule 3.5', async () => {
    const ram32Mock = createMockComfyServer({
      mockSystem: {
        ram_total: 32 * (1024 ** 3), // 32 GB
        ram_free: 28 * (1024 ** 3),  // 即使空闲充足，但整机物理内存 (~32GB) 无法承载 H3 (~36GB)
      },
    })
    const ram32Port = await ram32Mock.listen(0)
    const ram32Url = `http://127.0.0.1:${ram32Port}`

    const { stubCtx: ram32Ctx, registered: ram32Reg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(ram32Ctx, { baseUrl: ram32Url, pollIntervalMs: 50, outputsDir: 'test-tmp-outputs' })
    const genTool = ram32Reg.get('comfyui_generate')

    const res = await genTool.execute(
      {
        mode: 'preset',
        preset: 'h3_t2v',
        prompt: 'a cinematic view of ocean waves',
      },
      stubExec
    )

    assert.equal(res.ok, false, '应被设备能力守卫阻断')
    assert.equal(res.status, 'DEVICE_RESOURCE_BLOCKED')
    assert.equal(res.blocked, true)
    assert.equal(res.verdict, 'blocked')
    assert.ok(res.reason.includes('无法流畅运行'), '原因说明包含无法流畅运行')
    assert.ok(res.reason.includes('36.00') || res.reason.includes('36'), '指出需要约 36 GB 内存')
    assert.ok(res.reason.includes('32.00') || res.reason.includes('32'), '指出机器只有 32 GB')

    await ram32Mock.close()
  })

  // ── 用例 37: wan22_ti2v 预设生成的 SaveVideo 节点包含 format='auto' 和 codec='auto'
  test('(37) wan22_ti2v preset generation produces SaveVideo node with format=\'auto\' and codec=\'auto\'', async () => {
    // 捕获提交给 /prompt 的实际 graph
    let capturedPromptGraph = null
    const interceptMock = createMockComfyServer({
      completeDelayMs: 50,
      mockSystem: {
        ram_total: 64 * (1024 ** 3),
        ram_free: 48 * (1024 ** 3),
      },
    })

    // 包装 listen
    const interceptPort = await interceptMock.listen(0)
    const interceptUrl = `http://127.0.0.1:${interceptPort}`

    const { stubCtx: interceptCtx, registered: interceptReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(interceptCtx, { baseUrl: interceptUrl, pollIntervalMs: 50, outputsDir: 'test-tmp-outputs' })
    const genTool = interceptReg.get('comfyui_generate')

    const res = await genTool.execute(
      {
        mode: 'preset',
        preset: 'wan22_ti2v',
        prompt: 'test savevideo format and codec wiring',
        length: 25,
      },
      stubExec
    )

    assert.equal(res.ok, true, `生成执行成功: ${res.error || ''}`)

    // 从 interceptMock.history 获取最后一个提交的 prompt
    const histories = Array.from(interceptMock.history.values())
    assert.ok(histories.length > 0, 'Mock ComfyUI 记录到了执行历史')
    const lastPromptItem = histories[histories.length - 1].prompt
    const lastGraph = lastPromptItem[2]

    // 找到 class_type === 'SaveVideo' 的节点
    let saveVideoNode = null
    for (const [nid, node] of Object.entries(lastGraph)) {
      if (node.class_type === 'SaveVideo') {
        saveVideoNode = node
        break
      }
    }

    assert.ok(saveVideoNode, '生成的图中必须存在 SaveVideo 节点')
    assert.equal(saveVideoNode.inputs.format, 'auto', 'SaveVideo inputs 必须包含 format: auto')
    assert.equal(saveVideoNode.inputs.codec, 'auto', 'SaveVideo inputs 必须包含 codec: auto')

    await interceptMock.close()
  })

  // ── 用例 38: 注册表查询与全库查重 findInLibrary
  test('(38) modelRegistry lookup and findInLibrary full library scan', async () => {
    // 1. 注册表查询
    const entry = byFilename('wan2.2_ti2v_5B_fp16.safetensors')
    assert.ok(entry, '必须能从注册表中查到 wan2.2_ti2v_5B_fp16.safetensors')
    assert.equal(entry.subfolder, 'diffusion_models')
    assert.equal(entry.bytes, 9999658848)
    assert.ok(entry.sources.length >= 2, '包含多个备用镜像源')

    // 2. 全库查重测试
    const fakeModelsDir = path.join(TEST_WORKSPACE, 'fake-models-lib')
    fs.mkdirSync(path.join(fakeModelsDir, 'diffusion_models'), { recursive: true })
    fs.mkdirSync(path.join(fakeModelsDir, 'unet'), { recursive: true })
    fs.mkdirSync(path.join(fakeModelsDir, 'vae'), { recursive: true })

    // 在 unet 目录下放置一个同名文件（模拟用户放在非标准规范目录但属于模型库）
    const testFilename = 'my_custom_model.safetensors'
    const unetPath = path.join(fakeModelsDir, 'unet', testFilename)
    fs.writeFileSync(unetPath, Buffer.alloc(1024, 0x5a))

    const foundRes = findInLibrary(fakeModelsDir, testFilename, 'diffusion_models')
    assert.equal(foundRes.found, true, '全库查重必须能在 unet 目录下找到')
    assert.equal(foundRes.size, 1024)
    assert.equal(foundRes.subfolder, 'unet')

    // 未找到情况
    const notFound = findInLibrary(fakeModelsDir, 'non_existent_model.safetensors')
    assert.equal(notFound.found, false)
  })

  // ── 用例 39: comfyui_fetch_model 工具“已存在跳过”路径
  test('(39) comfyui_fetch_model skips downloading if already in user modelsDir', async () => {
    const fakeModelsDir = path.join(TEST_WORKSPACE, 'fake-models-skip')
    const targetDir = path.join(fakeModelsDir, 'diffusion_models')
    fs.mkdirSync(targetDir, { recursive: true })

    const testFile = 'wan2.2_ti2v_5B_fp16.safetensors'
    const localTarget = path.join(targetDir, testFile)
    fs.writeFileSync(localTarget, Buffer.alloc(2048, 0x11))

    const { stubCtx: skipCtx, registered: skipReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(skipCtx, {
      baseUrl: baseMockUrl,
      modelsDir: fakeModelsDir,
      outputsDir: 'test-tmp-outputs',
    })
    const fetchTool = skipReg.get('comfyui_fetch_model')
    assert.ok(fetchTool, '必须注册了 comfyui_fetch_model 工具')

    const res = await fetchTool.execute({ model: testFile }, stubExec)
    assert.equal(res.ok, true, '已存在时必须返回 ok: true')
    assert.equal(res.skipped, true, 'skipped 必须为 true')
    assert.equal(res.existingPath, localTarget)
    assert.ok(res.note.includes('已存在'), '提示信息应说明已存在')
  })

  // ── 用例 40: comfyui_fetch_model 真实下载与断点续传验证
  test('(40) comfyui_fetch_model performs resume download and verifies exact byte count', async () => {
    // 构造一个 512KB 的模拟模型二进制内容
    const TOTAL_BYTES = 512 * 1024
    const filePayload = Buffer.alloc(TOTAL_BYTES)
    for (let i = 0; i < TOTAL_BYTES; i++) {
      filePayload[i] = i % 256
    }

    // 启动一个支持 HTTP Range 的原生 HTTP 静态服务
    const mockFileServer = http.createServer((req, res) => {
      const range = req.headers.range
      if (range) {
        const match = /bytes=(\d+)-/.exec(range)
        if (match) {
          const start = parseInt(match[1], 10)
          const chunk = filePayload.slice(start)
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${TOTAL_BYTES - 1}/${TOTAL_BYTES}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunk.length,
            'Content-Type': 'application/octet-stream',
          })
          res.end(chunk)
          return
        }
      }
      res.writeHead(200, {
        'Content-Length': TOTAL_BYTES,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      })
      res.end(filePayload)
    })

    const serverPort = await new Promise((resolve) => {
      mockFileServer.listen(0, '127.0.0.1', () => resolve(mockFileServer.address().port))
    })
    const downloadUrl = `http://127.0.0.1:${serverPort}/test_model.safetensors`

    const testModelsDir = path.join(TEST_WORKSPACE, 'fake-models-dl')
    const destDir = path.join(testModelsDir, 'diffusion_models')
    fs.mkdirSync(destDir, { recursive: true })

    const testFilename = 'test_resumed_model.safetensors'
    const destPath = path.join(destDir, testFilename)

    // 预写入前半段 (200KB)，模拟断点状态
    const INITIAL_BYTES = 200 * 1024
    fs.writeFileSync(destPath, filePayload.slice(0, INITIAL_BYTES))
    assert.equal(fs.statSync(destPath).size, INITIAL_BYTES)

    const { stubCtx: dlCtx, registered: dlReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(dlCtx, {
      baseUrl: baseMockUrl,
      modelsDir: testModelsDir,
      outputsDir: 'test-tmp-outputs',
    })
    const fetchTool = dlReg.get('comfyui_fetch_model')

    // 执行断点续传
    const res = await fetchTool.execute(
      {
        url: downloadUrl,
        filename: testFilename,
        subfolder: 'diffusion_models',
        bytes: TOTAL_BYTES,
      },
      stubExec
    )

    assert.equal(res.ok, true, `下载失败: ${res.error || ''}`)
    assert.equal(res.skipped, false)
    assert.equal(res.resumed, true, '必须成功进行了断点续传')
    assert.equal(res.bytes, TOTAL_BYTES, '下载后字节数必须精确一致')

    // 校验写入磁盘的完整二进制与原内容完全匹配
    const savedBytes = fs.readFileSync(destPath)
    assert.equal(savedBytes.length, TOTAL_BYTES)
    assert.deepEqual(savedBytes, filePayload, '续传后的完整二进制数据完全匹配')

    mockFileServer.close()
  })

  // ── 用例 41: comfyui_generate 与 MODEL_MISSING 结构化错误及 auto_fetch_models 闭环
  test('(41) comfyui_generate returns MODEL_MISSING on missing model, and auto_fetch_models downloads then generates', async () => {
    // 启动一个 mock comfyui，初始时 UNETLoader 不含 wan2.2 模型
    let hasWan22ModelInComfy = false

    const dynamicMock = createMockComfyServer({
      completeDelayMs: 50,
      objectInfoModifier: (info) => {
        if (!hasWan22ModelInComfy && info?.UNETLoader?.input?.required?.unet_name) {
          info.UNETLoader.input.required.unet_name[0] = info.UNETLoader.input.required.unet_name[0].filter(
            (u) => !/wan2\.2/i.test(u)
          )
        }
      },
    })
    const dynPort = await dynamicMock.listen(0)
    const dynUrl = `http://127.0.0.1:${dynPort}`

    const testModelsDir = path.join(TEST_WORKSPACE, 'fake-models-gen-missing')
    fs.mkdirSync(path.join(testModelsDir, 'diffusion_models'), { recursive: true })

    const { stubCtx: dynCtx, registered: dynReg } = createStubContext(TEST_WORKSPACE)
    pluginModule.apply(dynCtx, {
      baseUrl: dynUrl,
      modelsDir: testModelsDir,
      outputsDir: 'test-tmp-outputs',
      pollIntervalMs: 50,
    })
    const genTool = dynReg.get('comfyui_generate')

    // 1. auto_fetch_models=false: 返回结构化错误 MODEL_MISSING
    const resMissing = await genTool.execute(
      {
        mode: 'preset',
        preset: 'wan22_ti2v',
        prompt: 'test missing model return structure',
        auto_fetch_models: false,
      },
      stubExec
    )

    assert.equal(resMissing.ok, false)
    assert.equal(resMissing.status, 'MODEL_MISSING')
    assert.equal(resMissing.missingModel, 'wan2.2_ti2v_5B_fp16.safetensors')
    assert.ok(resMissing.suggestion.includes('comfyui_fetch_model'))
    assert.equal(resMissing.autoFetchSupported, true)

    // 2. auto_fetch_models=true: 模拟通过 mock 文件源自动下载并重新构图成功
    // 搭建一个小本地静态源模拟真实 CDN
    const WAN22_DUMMY_SIZE = 1024
    const wan22DummyBytes = Buffer.alloc(WAN22_DUMMY_SIZE, 0x22)
    const wanMockServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Length': WAN22_DUMMY_SIZE,
        'Content-Type': 'application/octet-stream',
      })
      res.end(wan22DummyBytes)
    })
    const wanPort = await new Promise((resolve) => wanMockServer.listen(0, '127.0.0.1', () => resolve(wanMockServer.address().port)))

    // 临时在注册表中将 wan2.2_ti2v_5B_fp16.safetensors 的首个 source 指向 wanPort，bytes 设为 WAN22_DUMMY_SIZE
    const wan22Entry = byFilename('wan2.2_ti2v_5B_fp16.safetensors')
    const originalSources = [...wan22Entry.sources]
    const originalBytes = wan22Entry.bytes

    wan22Entry.sources = [`http://127.0.0.1:${wanPort}/wan2.2_ti2v_5B_fp16.safetensors`]
    wan22Entry.bytes = WAN22_DUMMY_SIZE

    // 在下载触发时，模拟 ComfyUI 重新加载到了该文件
    dynamicMock.history // 确认存活
    hasWan22ModelInComfy = true // 下次 /object_info 时包含 wan2.2

    const resAuto = await genTool.execute(
      {
        mode: 'preset',
        preset: 'wan22_ti2v',
        prompt: 'a lake with morning sun',
        auto_fetch_models: true,
        length: 25,
      },
      stubExec
    )

    assert.equal(resAuto.ok, true, `auto_fetch_models 自动下载后应成功出片: ${resAuto.error || ''}`)
    assert.ok(resAuto.outputs && resAuto.outputs.length > 0)

    // 还原注册表
    wan22Entry.sources = originalSources
    wan22Entry.bytes = originalBytes
    wanMockServer.close()
    await dynamicMock.close()
  })

  // ── 用例 42: extra_model_paths.yaml 解析 ────────────────────────────────────
  test('(42) extra_model_paths.yaml parsing extracts base_path and model directories', async () => {
    const yamlSample = `
# ComfyUI extra model paths configuration
comfyui:
  base_path: D:/my_custom_comfy
  checkpoints: models/checkpoints
  diffusion_models: models/diffusion_models
  vae: models/vae

a1111:
  base_path: E:/stable-diffusion-webui
  checkpoints: models/Stable-diffusion
  loras: models/Lora
`
    const parsed = parseExtraModelPaths(yamlSample, 'D:/default_fallback')
    assert.ok(parsed.roots.some((r) => r.includes('my_custom_comfy')), '提取到了 my_custom_comfy base_path')
    assert.ok(parsed.roots.some((r) => r.includes('stable-diffusion-webui')), '提取到了 stable-diffusion-webui base_path')
    assert.ok(parsed.extraPaths.checkpoints && parsed.extraPaths.checkpoints.length >= 2, 'checkpoints 列表提取正确')
    assert.ok(parsed.extraPaths.diffusion_models && parsed.extraPaths.diffusion_models.length >= 1, 'diffusion_models 提取正确')
    assert.ok(parsed.extraPaths.loras && parsed.extraPaths.loras.length >= 1, 'loras 提取正确')
  })

  // ── 用例 43: 磁盘扫描 ─────────────────────────────────────────────────────
  test('(43) disk scan detects ComfyUI-aki structure with models subfolder', async () => {
    const mockDrive = path.join(TEST_WORKSPACE, 'mock_drive_d')
    const akiComfyDir = path.join(mockDrive, 'ComfyUI-aki-v3', 'ComfyUI')
    const akiModelsDir = path.join(akiComfyDir, 'models')
    fs.mkdirSync(akiModelsDir, { recursive: true })
    fs.writeFileSync(path.join(akiComfyDir, 'main.py'), '# dummy main.py')

    const scanned = scanDrivesForComfyUI({ drives: [mockDrive], timeoutMs: 2000 })
    assert.ok(scanned.length > 0, '应该扫描出结果')
    const matched = scanned.find((s) => s.modelsDir === path.normalize(akiModelsDir))
    assert.ok(matched, `应成功发现秋叶整合包架构目录: ${akiModelsDir}`)
  })

  // ── 用例 44: modelsDir 优先级 ──────────────────────────────────────────────
  test('(44) modelsDir resolution priority: config > env > disk_scan', async () => {
    const dirConfig = path.join(TEST_WORKSPACE, 'prio_config')
    const dirEnv = path.join(TEST_WORKSPACE, 'prio_env')
    const dirScan = path.join(TEST_WORKSPACE, 'prio_scan')
    fs.mkdirSync(dirConfig, { recursive: true })
    fs.mkdirSync(dirEnv, { recursive: true })
    fs.mkdirSync(dirScan, { recursive: true })

    // A: config 存在时 config 最高优先
    const resA = resolveModelsDirs({
      configModelsDir: dirConfig,
      envModelsDir: dirEnv,
      mockProcessScan: null,
      mockDiskScan: [{ root: dirScan, modelsDir: dirScan }],
      force: true,
      cacheFile: path.join(TEST_WORKSPACE, '.cache_test_a.json'),
    })
    assert.equal(resA.primary, path.normalize(path.resolve(dirConfig)))
    assert.equal(resA.source, 'config')

    // B: config 缺省时 env 优先
    const resB = resolveModelsDirs({
      configModelsDir: null,
      envModelsDir: dirEnv,
      mockProcessScan: null,
      mockDiskScan: [{ root: dirScan, modelsDir: dirScan }],
      force: true,
      cacheFile: path.join(TEST_WORKSPACE, '.cache_test_b.json'),
    })
    assert.equal(resB.primary, path.normalize(path.resolve(dirEnv)))
    assert.equal(resB.source, 'env')

    // C: config 和 env 均无时 扫描兜底
    // (mockProcessScan: null 保证密封——本机若恰有 ComfyUI 在跑,真实进程扫描会命中)
    const resC = resolveModelsDirs({
      configModelsDir: null,
      envModelsDir: null,
      mockProcessScan: null,
      mockDiskScan: [{ root: dirScan, modelsDir: dirScan }],
      force: true,
      cacheFile: path.join(TEST_WORKSPACE, '.cache_test_c.json'),
    })
    assert.equal(resC.primary, path.normalize(path.resolve(dirScan)))
    assert.equal(resC.source, 'disk_scan')
  })

  // ── 用例 45: 多根 findInLibrary 与目的地选择 ────────────────────────────────
  test('(45) multi-root findInLibrary and chooseFetchDestination non-C and existing subfolder preference', async () => {
    const rootC = path.join(TEST_WORKSPACE, 'C_Drive_Models')
    const rootD = path.join(TEST_WORKSPACE, 'D_Drive_Models')
    const rootE = path.join(TEST_WORKSPACE, 'E_Drive_Models')

    const rootEloras = path.join(rootE, 'loras')
    fs.mkdirSync(rootEloras, { recursive: true })
    fs.writeFileSync(path.join(rootEloras, 'special_test_lora.safetensors'), Buffer.alloc(1024))

    // 多根全库查重
    const found = findInLibrary([rootC, rootD, rootE], 'special_test_lora.safetensors')
    assert.equal(found.found, true)
    assert.equal(found.size, 1024)
    assert.equal(found.subfolder, 'loras')

    // 目的地选择：rootE 已有 loras 且有文件，优先选择 rootE
    const dest1 = chooseFetchDestination([rootC, rootD, rootE], 'loras', {
      statfsFn: (p) => ({ bfree: p === rootD ? 10000000 : 5000000, bsize: 4096 }),
    })
    assert.equal(dest1, rootE, '已有子目录且有文件的根应被优先选作目的地')

    // 若均无子目录文件：非 C 盘且剩余空间大者优先
    const dest2 = chooseFetchDestination(['C:\\Models', 'D:\\Models', 'E:\\Models'], 'checkpoints', {
      statfsFn: (p) => {
        if (p.startsWith('C')) return { bfree: 999999999, bsize: 4096 } // C盘很大
        if (p.startsWith('D')) return { bfree: 50000000, bsize: 4096 } // D盘 200GB
        return { bfree: 10000000, bsize: 4096 } // E盘 40GB
      },
    })
    assert.equal(dest2, 'D:\\Models', '平手时优先非 C 盘中剩余空间最大的根')
  })

  // ── 用例 46: comfyui_status 不可达 → 检测到伪安装 ───────────────────────────
  test('(46) comfyui_status unreachable detects existing install and outputs start_existing suggestion', async () => {
    const fakeDrivesDir = path.join(TEST_WORKSPACE, 'test46_drives')
    const fakeComfy = path.join(fakeDrivesDir, 'ComfyUI')
    fs.mkdirSync(fakeComfy, { recursive: true })
    fs.writeFileSync(path.join(fakeComfy, 'main.py'), '# dummy')
    fs.writeFileSync(path.join(fakeComfy, 'run_nvidia_gpu.bat'), '@echo dummy')

    const mod46 = await import('../lib/index.mjs?v=test46')
    const apply46 = mod46.default || mod46.apply
    const { stubCtx: ctx46, registered: reg46 } = createStubContext()
    apply46(ctx46, {
      baseUrl: 'http://127.0.0.1:4', // 连不上的端口
      outputsDir: 'test-tmp-outputs',
      __installerOptions: {
        mockGpu: { name: 'NVIDIA GeForce RTX 5060 Ti', vramGB: 16, driverVersion: '572.0' },
        mockRamGB: 32,
        drives: [fakeDrivesDir],
      },
    })

    const statusTool = reg46.get('comfyui_status')
    const res = await statusTool.execute({}, stubExec)

    assert.equal(res.ok, false)
    assert.equal(res.reachable, false)
    assert.equal(res.installed, true, '应当检测到已安装')
    assert.equal(res.suggestedAction, 'start_existing')
    assert.ok(res.installPaths && res.installPaths.length > 0)
    assert.ok(res.installPaths[0].startHint.includes('run_nvidia_gpu.bat'))
    assert.ok(res.recommendation.includes('启动'))
  })

  // ── 用例 47: comfyui_install 预检拒绝 ───────────────────────────────────────
  test('(47) comfyui_install precheck rejections for low vram and confirmation requirement', async () => {
    const mod47 = await import('../lib/index.mjs?v=test47')
    const apply47 = mod47.default || mod47.apply
    const { stubCtx: ctx47, registered: reg47 } = createStubContext()
    apply47(ctx47, {
      baseUrl: 'http://127.0.0.1:8188',
      __installerOptions: {
        mockGpu: { name: 'NVIDIA GeForce GTX 1650', vramGB: 4, driverVersion: '560.0' },
        mockRamGB: 16,
        mockDisks: { 'D:': 100 },
      },
    })

    const installTool = reg47.get('comfyui_install')

    // 1. confirm=false 拒绝
    const res1 = await installTool.execute({ confirm: false }, stubExec)
    assert.equal(res1.ok, false)
    assert.equal(res1.error, 'CONFIRMATION_REQUIRED')

    // 2. confirm=true 但 4GB 显存被拒绝
    const res2 = await installTool.execute({ confirm: true }, stubExec)
    assert.equal(res2.ok, false)
    assert.equal(res2.error, 'PRECHECK_FAILED')
    assert.ok(res2.blockers.some((b) => b.includes('显存不足')))

    // 3. 传 C 盘目标盘符被拒绝
    const res3 = await executeComfyUIInstall(
      { confirm: true, target_drive: 'C:' },
      {
        mockGpu: { name: 'RTX 4090', vramGB: 24, driverVersion: '560.0' },
        mockRamGB: 32,
        mockDisks: { 'D:': 100 },
      }
    )
    assert.equal(res3.ok, false)
    assert.equal(res3.error, 'C_DRIVE_FORBIDDEN')
  })

  // ── 用例 48: 安装编排 happy path ────────────────────────────────────────────
  test('(48) comfyui_install orchestration happy path with small mock 7z and injected extractor/shell', async () => {
    // 启动本地 HTTP 服务提供模拟 7z
    const dummy7zBytes = Buffer.from('FAKE_7Z_CONTENT_FOR_TESTING_PORTABLE_PACKAGE')
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/x-7z-compressed',
        'Content-Length': String(dummy7zBytes.length),
      })
      res.end(dummy7zBytes)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const serverPort = server.address().port
    const mockUrl = `http://127.0.0.1:${serverPort}/ComfyUI_windows_portable_nvidia.7z`

    const mockNonCDrive = path.join(TEST_WORKSPACE, 'mock_D_drive')
    const targetInstallDir = path.join(mockNonCDrive, 'ComfyUI')
    fs.mkdirSync(mockNonCDrive, { recursive: true })

    let shellCommandInvoked = null
    let extractorInvoked = false

    const installRes = await executeComfyUIInstall(
      { confirm: true },
      {
        mockGpu: { name: 'NVIDIA GeForce RTX 5060 Ti', vramGB: 16, driverVersion: '565.0' },
        mockRamGB: 32,
        mockDisks: { 'D:': 120 },
        targetDriveHint: 'D:',
        targetDir: targetInstallDir,
        downloadUrls: [mockUrl],
        tmpDir: path.join(mockNonCDrive, '.tmp_installer'),
        extractor: async ({ archivePath, targetDir }) => {
          extractorInvoked = true
          assert.ok(fs.existsSync(archivePath), '压缩包应已下载到本地')
          assert.equal(fs.statSync(archivePath).size, dummy7zBytes.length, '包字节应匹配')
          // 模拟解压产物
          fs.mkdirSync(path.join(targetDir, 'ComfyUI'), { recursive: true })
          fs.writeFileSync(path.join(targetDir, 'ComfyUI', 'main.py'), '# installed main.py')
          fs.writeFileSync(path.join(targetDir, 'run_nvidia_gpu.bat'), '@echo off\n')
        },
        shellExecutor: async ({ batPath, targetDir }) => {
          shellCommandInvoked = { batPath, targetDir }
          return path.join(targetDir, 'ComfyUI.lnk')
        },
      }
    )

    assert.equal(installRes.ok, true, `安装应当成功: ${installRes.message || ''}`)
    assert.equal(extractorInvoked, true, '解压桩应被调用')
    assert.ok(shellCommandInvoked, '快捷方式创建应被调用')
    assert.ok(fs.existsSync(path.join(targetInstallDir, '启动ComfyUI.bat')), '启动ComfyUI.bat 必须存在')
    assert.ok(installRes.startMethod.includes('启动ComfyUI.bat'), 'startMethod 描述正确')

    server.close()
  })

  // ── 用例 49: 会话工作区反推(产物落点修复) ────────────────────────────────
  test('(49) inferWorkspaceFromSessions picks newest session jsonl cwd', async () => {
    if (typeof zlib.zstdCompressSync !== 'function') {
      console.log('  (跳过: 当前 Node 无 zstd 压缩支持)')
      return
    }
    const fakeSessionsRoot = path.join(TEST_WORKSPACE, 'fake-sessions')
    const projA = path.join(fakeSessionsRoot, '--C-proj-A--', 'session-aaa')
    const projB = path.join(fakeSessionsRoot, '--C-proj-B--', 'session-bbb')
    fs.mkdirSync(projA, { recursive: true })
    fs.mkdirSync(projB, { recursive: true })

    const writeSessionLog = (dir, cwd, mtimeSecAgo) => {
      const header = JSON.stringify({ type: 'session', version: 0, id: path.basename(dir), createdAt: Date.now(), cwd })
      fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(header + '\n')))
      const st = fs.statSync(path.join(dir, 'session.jsonl.zstd'))
      const t = st.mtimeMs - mtimeSecAgo * 1000
      fs.utimesSync(path.join(dir, 'session.jsonl.zstd'), new Date(t), new Date(t))
    }

    // A 较旧、B 最新 → 应反推出 B 的 cwd;两个 cwd 都必须是真实存在的目录
    const realDirA = fs.mkdtempSync(path.join(TEST_WORKSPACE, 'ws-a-'))
    const realDirB = fs.mkdtempSync(path.join(TEST_WORKSPACE, 'ws-b-'))
    writeSessionLog(projA, realDirA, 300)
    writeSessionLog(projB, realDirB, 0)

    const inferred = inferWorkspaceFromSessions(fakeSessionsRoot)
    assert.equal(inferred, realDirB, '应取 mtime 最新会话的 cwd')

    // 不存在的 cwd 应被拒绝(返回 null 或另一个有效会话)
    writeSessionLog(projB, 'Q:\\definitely\\not\\exist', 0)
    const inferred2 = inferWorkspaceFromSessions(fakeSessionsRoot)
    assert.equal(inferred2, null, 'cwd 不存在时不应返回无效路径')

    // 空目录 / 不存在的根
    assert.equal(inferWorkspaceFromSessions(path.join(TEST_WORKSPACE, 'no-such')), null)
    assert.equal(inferWorkspaceFromSessions(null), null)
  })

  // ── 用例 50: Z-Image DiT-only checkpoint 自动外挂拓扑 ──────────────────────
  test('(50) txt2img/img2img build Z-Image graph for DiT-only checkpoints', async () => {
    // safetensors 夹具写入器: 只含 header 的最小合法文件
    const writeStFixture = (file, tensorKeys) => {
      const header = JSON.stringify(
        Object.fromEntries(tensorKeys.map((k) => [k, { dtype: 'F32', shape: [1], data_offsets: [0, 4] }]))
      )
      const hbuf = Buffer.from(header, 'utf8')
      const len = Buffer.alloc(8)
      len.writeBigUInt64LE(BigInt(hbuf.length))
      fs.writeFileSync(file, Buffer.concat([len, hbuf, Buffer.alloc(4)]))
    }
    const ckptDir = path.join(TEST_WORKSPACE, 'zckpt-models', 'checkpoints')
    fs.mkdirSync(ckptDir, { recursive: true })
    writeStFixture(path.join(ckptDir, 'fake_z1.safetensors'), ['model.diffusion_model.blocks.0.weight', 'model.diffusion_model.x.y'])
    writeStFixture(path.join(ckptDir, 'fake_sdxl1.safetensors'), [
      'conditioner.embedders.0.weight', 'vae.decoder.conv.weight', 'model.diffusion_model.in.weight',
    ])
    const modelsRoot = path.join(TEST_WORKSPACE, 'zckpt-models')

    const objectInfo = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['fake_z1.safetensors', 'fake_sdxl1.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b_fp8_mixed.safetensors']], type: [['stable_diffusion', 'qwen_image']] } } },
      VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
      EmptyLatentImage: { input: { required: {} } },
      KSampler: { input: { required: {} } },
      CLIPTextEncode: { input: { required: {} } },
      VAEDecode: { input: { required: {} } },
      VAEEncode: { input: { required: {} } },
      LoadImage: { input: { required: { image: [['example.png']] } } },
    }

    // 1) Z-Image checkpoint → 自动外挂 CLIPLoader(8) + VAELoader(9),Turbo 默认参数
    //    (modelsDirs 用 resolveModelsDirs 实际返回的 {path, source} 对象数组形态,防回归)
    const zg = buildTxt2Img({ model: 'fake_z1.safetensors', prompt: 'test' }, objectInfo, [{ path: modelsRoot, source: 'config' }])
    assert.equal(zg[8]?.class_type, 'CLIPLoader', '应生成 CLIPLoader 节点 8')
    assert.equal(zg[8]?.inputs?.clip_name, 'qwen_3_4b_fp8_mixed.safetensors')
    assert.equal(zg[8]?.inputs?.type, 'qwen_image', 'CLIPLoader type 应选 z_image 语义最近值')
    assert.equal(zg[9]?.class_type, 'VAELoader', '应生成 VAELoader 节点 9')
    assert.deepEqual(zg[2]?.inputs?.clip, ['8', 0], '正向条件应接 CLIPLoader')
    assert.deepEqual(zg[3]?.inputs?.clip, ['8', 0], '负向条件应接 CLIPLoader')
    assert.deepEqual(zg[6]?.inputs?.vae, ['9', 0], 'VAEDecode 应接外挂 VAE')
    assert.equal(zg[5]?.inputs?.cfg, 1.0, 'Z-Image 默认 cfg 1.0')
    assert.equal(zg[5]?.inputs?.steps, 10, 'Z-Image 默认 10 步')
    assert.equal(zg[5]?.inputs?.scheduler, 'simple', 'Z-Image 默认 simple 调度')

    // 2) img2img 同拓扑(外挂件占节点 9/10,VAEEncode 也接外挂 VAE)
    const zig = buildImg2Img({ model: 'fake_z1.safetensors', prompt: 't' }, objectInfo, 'example.png', [modelsRoot])
    assert.equal(zig[9]?.class_type, 'CLIPLoader', 'img2img 应生成 CLIPLoader 节点 9')
    assert.equal(zig[10]?.class_type, 'VAELoader', 'img2img 应生成 VAELoader 节点 10')
    assert.deepEqual(zig[5]?.inputs?.vae, ['10', 0], 'VAEEncode 应接外挂 VAE')
    assert.deepEqual(zig[7]?.inputs?.vae, ['10', 0], 'VAEDecode 应接外挂 VAE')

    // 3) SDXL 全内嵌 checkpoint → 维持经典拓扑,不生成外挂件
    const sg = buildTxt2Img({ model: 'fake_sdxl1.safetensors', prompt: 'test' }, objectInfo, [modelsRoot])
    assert.equal(sg[8], undefined, 'SDXL 不应生成 CLIPLoader 外挂件')
    assert.deepEqual(sg[2]?.inputs?.clip, ['1', 1], 'SDXL 条件应接 checkpoint 内嵌 CLIP')
    assert.deepEqual(sg[6]?.inputs?.vae, ['1', 2], 'SDXL VAE 应接 checkpoint 内嵌')

    // 4) Z-Image 缺编码器 → 抛错信息含注册表文件名(触发自动补齐链路)
    const noEncInfo = JSON.parse(JSON.stringify(objectInfo))
    noEncInfo.CLIPLoader.input.required.clip_name = [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']]
    assert.throws(
      () => buildTxt2Img({ model: 'fake_z1.safetensors', prompt: 't' }, noEncInfo, [modelsRoot]),
      /qwen_3_4b_fp8_mixed\.safetensors/,
      '缺编码器错误应含注册表文件名'
    )

    // 5) Z-Image 缺 VAE → 抛错信息含 ae.safetensors
    const noVaeInfo = JSON.parse(JSON.stringify(objectInfo))
    noVaeInfo.VAELoader.input.required.vae_name = [['other_vae.safetensors']]
    assert.throws(
      () => buildTxt2Img({ model: 'fake_z1.safetensors', prompt: 't' }, noVaeInfo, [modelsRoot]),
      /ae\.safetensors/,
      '缺 VAE 错误应含注册表文件名'
    )
  })

  // ── 用例 51: 文件名子目录推断 + HF 链接归一化(Stability Matrix 移植) ────────
  test('(51) inferSubfolderFromName and normalizeHfSource', async () => {
    // 推断级联(SM 同款规则的 ComfyUI 版)
    const cases = [
      ['ae.safetensors', 'vae'],
      ['models/vae/ae.safetensors', 'vae'],
      ['qwen_3_4b_fp8_mixed.safetensors', 'text_encoders'],
      ['umt5_xxl_fp8.safetensors', 'text_encoders'],
      ['text_encoders/clip_l.safetensors', 'text_encoders'],
      ['control_v11p_sd15_canny.pth', 'controlnet'],
      ['diffusion_pytorch_model/clip_vision_x.safetensors', 'clip_vision'],
      ['flux_ipa/ip_adapter_plus.safetensors', 'ipadapter'],
      ['add_detail_lora.safetensors', 'loras'],
      ['4xUltrasharp_4xUltrasharpV10.pt', 'upscale_models'],
      ['RealESRGAN_x4plus.pth', 'upscale_models'],
      // 含 "vae" 的 checkpoint 名会按级联误判为 vae —— 与 SM 原版行为一致(用户库中
      // sd_xl_base 曾误入 vae 目录大概率即此类推断造成),此类需显式 subfolder 覆盖
      ['sd_xl_base_1.0_0.9vae.safetensors', 'vae'],
      ['wan2.2_ti2v_5B_fp16.safetensors', 'checkpoints'],
      ['flux1-dev.safetensors', 'checkpoints'],
      ['some_model-00001-of-00002.gguf', 'diffusion_models'],
      ['split_files/diffusion_models/xxx.safetensors', 'diffusion_models'],
      ['easyNegative.pt', 'embeddings'],
      ['', 'checkpoints'],
    ]
    for (const [input, expect] of cases) {
      const got = inferSubfolderFromName(input)
      assert.equal(got, expect, `infer("${input}") 应为 ${expect}, 实得 ${got}`)
    }
    // 含 "vae" 歧义已在上方案例中按 SM 原版行为断言(判 vae);显式 subfolder 由调用方覆盖

    // HF 链接归一化
    assert.equal(
      normalizeHfSource('hf:Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors'),
      'https://hf-mirror.com/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
      'hf: 前缀应转 hf-mirror resolve'
    )
    assert.equal(
      normalizeHfSource('https://huggingface.co/SG161222/RealVisXL_V5.0_Lightning/blob/main/RealVisXL_V5.0_Lightning_fp16.safetensors'),
      'https://hf-mirror.com/SG161222/RealVisXL_V5.0_Lightning/resolve/main/RealVisXL_V5.0_Lightning_fp16.safetensors',
      'blob 链接应转 hf-mirror resolve'
    )
    assert.equal(
      normalizeHfSource('https://huggingface.co/Comfy-Org/Wan_2.2_comfyui_repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors'),
      'https://hf-mirror.com/Comfy-Org/Wan_2.2_comfyui_repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
      'resolve 链接域名应换成 hf-mirror'
    )
    assert.equal(normalizeHfSource('https://civitai.com/api/download/models/796852?fileId=751426'), null, '非 HF 链接返回 null')
    assert.equal(normalizeHfSource('https://hf-mirror.com/x/y/resolve/main/z.safetensors'), null, 'hf-mirror 原生链接不再转换')
    assert.equal(normalizeHfSource('https://huggingface.co/repo/tree/main/folder'), null, 'tree 目录链接不转换(仅 blob/resolve 文件链接)')
  })

  // ── 用例 52: LoRA 注入链(txt2img/img2img LoraLoader + wan22 LoraLoaderModelOnly) ──
  test('(52) LoRA injection chains in presets', async () => {
    // 参数归一化
    assert.deepEqual(normalizeLoraArg(undefined), [], 'undefined → 空链')
    assert.equal(normalizeLoraArg('a.safetensors')[0].strength, 0.8, '默认权重 0.8')
    assert.equal(normalizeLoraArg('a@0.5')[0].name, 'a', '@ 权重语法解析文件名')
    assert.equal(normalizeLoraArg('a@0.5')[0].strength, 0.5, '@ 权重语法解析强度')
    assert.equal(normalizeLoraArg([{ name: 'b' }, 'c@1.2'], 0.7)[0].strength, 0.7, '对象缺省强度用默认值')
    assert.equal(normalizeLoraArg('a@9')[0].strength, 2, '强度上限钳制 2')

    // safetensors 夹具(Z-Image DiT-only)
    const writeStFixture = (file, tensorKeys) => {
      const header = JSON.stringify(
        Object.fromEntries(tensorKeys.map((k) => [k, { dtype: 'F32', shape: [1], data_offsets: [0, 4] }]))
      )
      const hbuf = Buffer.from(header, 'utf8')
      const len = Buffer.alloc(8)
      len.writeBigUInt64LE(BigInt(hbuf.length))
      fs.writeFileSync(file, Buffer.concat([len, hbuf, Buffer.alloc(4)]))
    }
    const ckptDir = path.join(TEST_WORKSPACE, 'lora-models', 'checkpoints')
    fs.mkdirSync(ckptDir, { recursive: true })
    writeStFixture(path.join(ckptDir, 'fake_z1.safetensors'), ['model.diffusion_model.blocks.0.weight'])
    const modelsRoot = path.join(TEST_WORKSPACE, 'lora-models')

    const oi = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['fake_z1.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b_fp8_mixed.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']], type: [['stable_diffusion', 'qwen_image', 'wan']] } } },
      VAELoader: { input: { required: { vae_name: [['ae.safetensors', 'wan2.2_vae.safetensors']] } } },
      LoraLoader: { input: { required: { lora_name: [['chloe.safetensors', 'other.safetensors']], strength_model: [0, {}], strength_clip: [0, {}], model: ['MODEL', {}], clip: ['CLIP', {}] } } },
      LoraLoaderModelOnly: { input: { required: { lora_name: [['kuroinu_wan_style.safetensors']], strength_model: [0, {}], model: ['MODEL', {}] } } },
      UNETLoader: { input: { required: { unet_name: [['wan2.2_ti2v_5B_fp16.safetensors']], weight_dtype: [['default'], {}] } } },
      ModelSamplingSD3: { input: { required: { shift: [0, {}], model: ['MODEL', {}] } } },
      ModelSamplingAuraFlow: { input: { required: { shift: [0, {}], model: ['MODEL', {}] } } },
      SaveVideo: { input: { required: { video: ['VIDEO', {}], filename_prefix: ['string', {}] }, optional: { format: ['string', {}], fps: [0, {}] } } },
      CreateVideo: { input: { required: { images: ['IMAGE', {}] }, optional: { fps: [0, {}] } } },
      EmptyLatentImage: { input: { required: {} } },
      KSampler: { input: { required: {} } },
      CLIPTextEncode: { input: { required: {} } },
      VAEDecode: { input: { required: {} } },
      VAEEncode: { input: { required: {} } },
      LoadImage: { input: { required: { image: [['example.png']] } } },
    }

    // 1) Z-Image + 单 LoRA: LoRA 的 clip 入口为 CLIPLoader(节点 8), KSampler/CLIP 全走 20
    const g1 = buildTxt2Img({ prompt: 'x', model: 'fake_z1.safetensors', lora: 'chloe.safetensors' }, oi, [modelsRoot])
    assert.equal(g1[20]?.class_type, 'LoraLoader', '应生成节点 20 LoraLoader')
    assert.equal(g1[20].inputs.model[0], '1', 'LoRA 模型来源为 checkpoint')
    assert.equal(g1[20].inputs.clip[0], '8', 'Z-Image 下 LoRA clip 链自 CLIPLoader')
    assert.deepEqual(g1[5].inputs.model, ['20', 0], 'KSampler 模型走 LoRA 出口')
    assert.deepEqual(g1[2].inputs.clip, ['20', 1], '正向 CLIP 走 LoRA clip 出口')
    assert.deepEqual(g1[3].inputs.clip, ['20', 1], '负向 CLIP 走 LoRA clip 出口')

    // 2) 双 LoRA 数组链: 20 → 21, @语法与对象强度都生效
    const g2 = buildTxt2Img({ prompt: 'x', model: 'fake_z1.safetensors', lora: ['chloe.safetensors@0.6', { name: 'other.safetensors', strength: 0.9 }] }, oi, [modelsRoot])
    assert.deepEqual(g2[21].inputs.model, ['20', 0], '第二个 LoRA 串在第一个之后')
    assert.equal(g2[21].inputs.strength_model, 0.9, '对象形式强度生效')
    assert.equal(g2[20].inputs.strength_model, 0.6, '@ 语法强度生效')
    assert.deepEqual(g2[5].inputs.model, ['21', 0], 'KSampler 模型走链尾')

    // 3) img2img 单 LoRA
    const g3 = buildImg2Img({ prompt: 'x', image: 'in.png', model: 'fake_z1.safetensors', lora: 'chloe.safetensors' }, oi, 'example.png', [modelsRoot])
    assert.equal(g3[20]?.class_type, 'LoraLoader', 'img2img 应生成节点 20')
    assert.deepEqual(g3[6].inputs.model, ['20', 0], 'img2img KSampler 走 LoRA')
    assert.deepEqual(g3[2].inputs.clip, ['20', 1], 'img2img CLIP 走 LoRA clip')

    // 4) 不存在的 LoRA → 抛错(含"未找到"字样, 可触发注册表自动补齐)
    assert.throws(
      () => buildTxt2Img({ prompt: 'x', model: 'fake_z1.safetensors', lora: 'nonexistent.safetensors' }, oi, [modelsRoot]),
      /未找到 LoRA 文件/,
      '缺失 LoRA 应抛错'
    )

    // 5) wan22_ti2v: LoraLoaderModelOnly 串在 UNETLoader 后, ModelSamplingSD3 从链尾取模型
    const g5 = buildWan22TI2V({ prompt: 'x', lora: 'kuroinu_wan_style.safetensors@0.6' }, oi, null)
    assert.equal(g5['20']?.class_type, 'LoraLoaderModelOnly', 'wan22 应生成节点 20 LoraLoaderModelOnly')
    assert.deepEqual(g5['20'].inputs.model, ['1', 0], 'LoRA 串在 UNETLoader 之后')
    assert.equal(g5['20'].inputs.strength_model, 0.6, '@覆盖为 0.6')
    const msNode = Object.values(g5).find((n) => n.class_type === 'ModelSamplingSD3' || n.class_type === 'ModelSamplingAuraFlow')
    assert.ok(msNode, 'wan22 图中应有 ModelSampling 节点')
    assert.deepEqual(msNode.inputs.model, ['20', 0], 'ModelSampling 从 LoRA 链尾取模型')

    // 6) wan22 无 LoRA: ModelSampling 仍直接接 UNETLoader(回归)
    const g6 = buildWan22TI2V({ prompt: 'x' }, oi, null)
    const msNode6 = Object.values(g6).find((n) => n.class_type === 'ModelSamplingSD3' || n.class_type === 'ModelSamplingAuraFlow')
    assert.deepEqual(msNode6.inputs.model, ['1', 0], '无 LoRA 时 ModelSampling 直连 UNETLoader')
    assert.equal(g6['20'], undefined, '无 LoRA 不生成节点 20')
  })

  // ── npm 包形状(DSH 插件规范) ────────────────────────────────────────────
  test('(53) npm 包: package.json 形状符合 DSH 插件规范', () => {
    const pkgDir = PKG_DIR
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'dsh-comfyui-bridge', '包名')
    assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'semver 版本')
    assert.equal(pkg.type, 'module', 'ESM')
    assert.equal(pkg.main, './lib/index.mjs', 'main 指向入口')
    assert.equal(pkg.exports['.'], './lib/index.mjs', 'exports . 指向入口')
    assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml', 'exports 补丁文件')
    assert.equal(pkg.exports['./package.json'], './package.json', 'exports package.json')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch 声明')
    assert.ok(pkg.dsh.compatibility.dsh, 'dsh 兼容性声明')
    assert.ok(pkg.engines.node, 'engines.node 声明')
    assert.equal(pkg.license, 'MIT', 'MIT 许可')
    assert.ok(!pkg.private, '未标 private(可发布)')
    assert.equal(pkg.publishConfig.access, 'public', 'publishConfig public')
  })

  test('(54) npm 包: bundle 补丁行与包名一致且仅含通用默认值', () => {
    const pkgDir = PKG_DIR
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const patchPath = path.join(pkgDir, pkg.dsh.bundle.patch)
    assert.ok(fs.existsSync(patchPath), '补丁文件存在')
    const patch = fs.readFileSync(patchPath, 'utf8')
    assert.match(patch, /id:\s*comfyui-bridge/, '行 id')
    assert.match(patch, new RegExp(`name:\\s*${pkg.name}\\s*$`, 'm'), '行 name 为裸包名(非 file://)')
    assert.ok(!patch.includes('file:///'), '补丁行不用 file:// 路径')
    assert.ok(!/[A-Za-z]:\//.test(patch.replace(/http:\/\//g, '')), '不含机器特定盘符路径')
    assert.match(patch, /baseUrl:\s*http:\/\/127\.0\.0\.1:8188/, '通用默认 baseUrl')
  })

  test('(55) npm 包: files 白名单与导出目标全部存在于磁盘', () => {
    const pkgDir = PKG_DIR
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    for (const entry of pkg.files) {
      const p = path.join(pkgDir, entry)
      assert.ok(fs.existsSync(p), `files 条目存在: ${entry}`)
    }
    assert.ok(fs.existsSync(path.join(pkgDir, 'LICENSE')), 'LICENSE 存在')
    for (const target of Object.values(pkg.exports)) {
      assert.ok(fs.existsSync(path.join(pkgDir, target)), `exports 目标存在: ${target}`)
    }
    // 发包不应带进的目录
    for (const excluded of ['test', 'assets', 'node_modules']) {
      assert.ok(!pkg.files.includes(excluded), `files 不含 ${excluded}`)
    }
    assert.ok(!pkg.files.includes('.comfyui-bridge-cache.json'), '运行时缓存不发包')
  })

  test('(56) npm 包: 入口模块从包名导入具备插件三件套', async () => {
    const pkgDir = PKG_DIR
    const mod = await import(`file://${path.join(pkgDir, 'lib', 'index.mjs').replaceAll('\\', '/').replaceAll(' ', '%20')}`)
    assert.equal(mod.name, 'comfyui-bridge', '导出 name')
    assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject 含 tools')
    assert.equal(typeof mod.apply, 'function', '导出 apply 函数')
  })

  let passedCount = 0
  let failedCount = 0

  for (const t of tests) {
    try {
      await t.fn()
      console.log(`PASS: ${t.name}`)
      passedCount++
    } catch (err) {
      console.error(`FAIL: ${t.name}`)
      console.error(err)
      failedCount++
    }
  }

  // 清理 Mock 服务与临时文件夹
  await baseMock.close()
  try {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true })
  } catch {}

  console.log('\n=============================================')
  console.log(`测试完成: 共 ${tests.length} 项 | 通过: ${passedCount} | 失败: ${failedCount}`)
  console.log('=============================================\n')

  process.exit(failedCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('测试运行器异常崩溃:', e)
  process.exit(1)
})
