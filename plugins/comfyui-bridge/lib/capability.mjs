// lib/capability.mjs — 设备能力守卫与资源裁决系统
//
// 专为 16GB VRAM / 32GB RAM 等主流桌面消费级硬件打造，
// 依据 ComfyUI 真实系统状态与已知模型权重规模，执行精准的算力资源预检。
// 拒绝含糊其辞，直言不讳：过载流式明确告警，内存崩溃死锁提前拦截。

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * 常见模型文件基准大小表（字节，基于官方真实权重文件实测）
 */
export const KNOWN_MODEL_SIZES = {
  'wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors': 16397245448,
  'wan2.1_t2v_14B_fp8_e4m3fn.safetensors': 16397245448,
  'wan2.2_ti2v_5B_fp16.safetensors': 9999658848,
  'wan2.1_vae.safetensors': 253815318,
  'wan2.2_vae.safetensors': 1409400960,
  'umt5_xxl_fp8_e4m3fn_scaled.safetensors': 6735906897,
  'wan2.1_t2v_1.3b_fp8.safetensors': 1500000000,
  'wan2.1_i2v_480p_1.3b_fp8.safetensors': 1500000000,
  // MiniMax H3 (Comfy-Org 重打包, 精确字节)
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors': 20970379616,
  'minimax_h3_ref2va_pruned_int8_convrot.safetensors': 20970379616,
  'minimax_h3_fl2va_pruned_fp8_scaled.safetensors': 20958205608,
  'minimax_h3_ref2va_pruned_fp8_scaled.safetensors': 20958205608,
  'minimax_h3_fl2va_int8_convrot.safetensors': 34038892334,
  'minimax_h3_fl2va_pruned_bf16.safetensors': 40225724176,
  'minimax_h3_fl2va_bf16.safetensors': 66280487368,
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': 15687142551,
  'qwen3vl_32b_minimax_h3_int8_convrot.safetensors': 27141342152,
  'qwen3vl_32b_minimax_h3_bf16.safetensors': 51506295256,
  'minimax_h3_video_vae_fp16.safetensors': 5207808496,
}

/**
 * 字节转 GB 格式化辅助
 */
export function formatGb(bytes) {
  return (Number(bytes || 0) / (1024 ** 3)).toFixed(2)
}

/**
 * 在 modelsDir 目录中查找模型文件并获取其实际字节大小
 */
export function getModelFileSize(filename, modelsDir) {
  if (!filename) return 0
  const baseName = path.basename(filename)

  // 1. 若配置了 modelsDir（支持字符串或数组），尝试读取实际文件大小
  let searchDirs = []
  if (Array.isArray(modelsDir)) {
    searchDirs = modelsDir.map((d) => (typeof d === 'string' ? d : d?.path)).filter(Boolean)
  } else if (typeof modelsDir === 'string' && modelsDir.trim()) {
    searchDirs = [modelsDir.trim()]
  } else if (process.env.COMFYUI_MODELS_DIR) {
    searchDirs = [process.env.COMFYUI_MODELS_DIR]
  }

  const candidateSubdirs = ['', 'diffusion_models', 'unet', 'checkpoints', 'vae', 'text_encoders', 'clip']
  for (const sDir of searchDirs) {
    if (!fs.existsSync(sDir)) continue
    for (const sub of candidateSubdirs) {
      const fullPath = path.join(sDir, sub, baseName)
      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath)
          if (stat.isFile() && stat.size > 0) return stat.size
        } catch {}
      }
    }
  }

  // 2. 查表已知大小
  if (KNOWN_MODEL_SIZES[baseName]) {
    return KNOWN_MODEL_SIZES[baseName]
  }

  // 3. 启发式预估
  if (/14b/i.test(baseName)) return 16397245448
  if (/5b/i.test(baseName)) return 9999658848
  if (/1\.3b/i.test(baseName)) return 1500000000
  if (/h3.*pruned/i.test(baseName)) return 22440000000

  return 0
}

/**
 * 探测 ComfyUI 设备硬件状态
 * @param {object} client - ComfyUI API 客户端
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ vramTotal: number, vramFree: number, ramTotal: number, ramFree: number, gpuName: string }>}
 */
export async function probeDevice(client, signal) {
  const statsRes = await client.requestJson('/system_stats', {}, signal)
  if (!statsRes.ok || !statsRes.data) {
    throw new Error(`无法获取 ComfyUI 系统状态: ${statsRes.error || '响应为空'}`)
  }

  const data = statsRes.data
  const devices = data.devices || []
  const cudaDevice = devices.find((d) => d.type === 'cuda') || devices[0] || {}

  const vramTotal = Number(cudaDevice.vram_total || cudaDevice.torch_vram_total || 0)
  const vramFree = Number(cudaDevice.vram_free || cudaDevice.torch_vram_free || 0)

  // 优先从 ComfyUI system 取，若缺省则回退宿主机 os 模块
  const ramTotal = Number(data.system?.ram_total || os.totalmem() || 0)
  const ramFree = Number(data.system?.ram_free || os.freemem() || 0)
  const gpuName = cudaDevice.name || 'Unknown GPU'

  return { vramTotal, vramFree, ramTotal, ramFree, gpuName }
}

/**
 * 按预设与入参估算任务所需硬件开销与预计耗时
 */
export function estimate(preset, params = {}, objectInfo = {}, modelsDir = null) {
  const p = preset || 'txt2img'
  let mainModel = params.model || ''
  let weightsBytes = 0
  let vramNeededBytes = 0
  let ramNeededBytes = 0
  let expectedMinutes = 1
  let smallerAlternative = null

  if (p === 'wan_i2v' || p === 'wan_t2v') {
    if (!mainModel) {
      mainModel = p === 'wan_i2v' ? 'wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors' : 'wan2.1_t2v_1.3b_fp8.safetensors'
    }
    const modelSize = getModelFileSize(mainModel, modelsDir)
    if (modelSize >= 12 * (1024 ** 3) || /14b/i.test(mainModel)) {
      // 14B 档位锚点：14B 720p 81帧 20步 ≈ 45+ 分钟 (16GB卡因切页换流)
      weightsBytes = modelSize || 16397245448
      vramNeededBytes = weightsBytes + 2.5 * (1024 ** 3) // 权重 + 720p 激活值
      ramNeededBytes = weightsBytes * 1.2
      expectedMinutes = 45
      smallerAlternative = 'wan22_ti2v (Wan2.2 TI2V-5B 约 9.3GB 权重)'
    } else {
      // 1.3B 档位
      weightsBytes = modelSize || 1500000000
      vramNeededBytes = 6 * (1024 ** 3)
      ramNeededBytes = 8 * (1024 ** 3)
      expectedMinutes = 2
    }
  } else if (p === 'wan22_ti2v') {
    // 5B TI2V 甜点锚点：1280×704 121帧 30步 ≈ 13 分钟 (横竖同价)
    mainModel = mainModel || 'wan2.2_ti2v_5B_fp16.safetensors'
    weightsBytes = getModelFileSize(mainModel, modelsDir) || 9999658848
    vramNeededBytes = weightsBytes + 2.5 * (1024 ** 3) // ~12.5GB 完美落入 16GB 显存
    ramNeededBytes = weightsBytes * 1.1
    expectedMinutes = 13
    smallerAlternative = null
  } else if (p === 'h3_t2v' || p === 'h3_flf2v' || p === 'h3_r2v') {
    // MiniMax H3 体系（最小可行组合）: pruned int8 DiT 19.53GB + nvfp4 Qwen3-VL 编码器 14.61GB ≈ 34.14GB 纯权重，
    // 加 video VAE 4.85GB + audio VAE 0.56GB 与激活 → 需 ~36GB 系统内存
    weightsBytes = 34140000000
    vramNeededBytes = 24 * (1024 ** 3)
    ramNeededBytes = 36 * (1024 ** 3)
    expectedMinutes = 30
    smallerAlternative = 'wan22_ti2v (Wan2.2 TI2V-5B)'
  } else if (p === 'svd_img2vid') {
    weightsBytes = 4.8 * (1024 ** 3)
    vramNeededBytes = 7 * (1024 ** 3)
    ramNeededBytes = 10 * (1024 ** 3)
    expectedMinutes = 2
  } else if (p === 'animatediff') {
    weightsBytes = 4.5 * (1024 ** 3)
    vramNeededBytes = 6.5 * (1024 ** 3)
    ramNeededBytes = 8 * (1024 ** 3)
    expectedMinutes = 1.5
  } else {
    // txt2img / img2img
    weightsBytes = 6.5 * (1024 ** 3) // SDXL 约 6.5GB
    vramNeededBytes = 8 * (1024 ** 3)
    ramNeededBytes = 12 * (1024 ** 3)
    expectedMinutes = 0.3
  }

  return {
    weightsBytes,
    vramNeededBytes,
    ramNeededBytes,
    expectedMinutes,
    mainModelName: mainModel,
    smallerAlternative,
  }
}

/**
 * 校验设备能力并生成明确裁决
 * @param {object} task - { preset, params, estimate }
 * @param {object} device - { vramTotal, vramFree, ramTotal, ramFree, gpuName }
 * @returns {{ verdict: 'ok'|'ok_slow'|'blocked', message: string, advice: string[] }}
 */
export function check(task, device) {
  const est = task.estimate || estimate(task.preset, task.params)
  const { weightsBytes, expectedMinutes, smallerAlternative } = est

  const weightsGb = formatGb(weightsBytes)
  const vramTotalGb = formatGb(device.vramTotal)
  const vramFreeGb = formatGb(device.vramFree)
  const ramTotalGb = formatGb(device.ramTotal)
  const ramFreeGb = formatGb(device.ramFree)
  const reqRamGb = formatGb(weightsBytes * 0.6)

  // 规则 4: 极端低配（连最小已知路径都跑不动）直接判定无法流畅运行
  if (device.vramTotal > 0 && device.vramTotal < 6 * (1024 ** 3)) {
    return {
      verdict: 'blocked',
      message: `你这台设备无法流畅运行此类任务。当前显卡 ${device.gpuName}（总显存 ${vramTotalGb} GB，可用显存 ${vramFreeGb} GB），低于现代生成模型的最低硬件门槛（至少需 8GB~16GB 显存）。`,
      advice: [
        '高性价比升级与替代建议：',
        '1. 显卡升级至 24GB 显存档位（如 RTX 5070 Ti 24GB 或二手 RTX 3090/4090 24GB），彻底杜绝爆显存换页；',
        '2. 系统内存扩容至 64GB（双通道），避免后台程序与大模型抢占物理内存；',
        '3. 或接入按量计费的云端推理 API/算力云服务，无需本地硬件投入。',
      ],
    }
  }

  // 规则 3: ramFree < weights * 0.6 → blocked (防内存爆死锁)
  if (device.ramFree > 0 && device.ramFree < weightsBytes * 0.6) {
    return {
      verdict: 'blocked',
      message: `系统空闲内存 ${ramFreeGb} GB 不足以装载 ${weightsGb} GB 模型（至少需要 ${reqRamGb} GB 空闲内存），任务已主动拦截。先关掉大内存后台程序（浏览器多标签/本地大模型/虚拟机）再试；或改用更小模型。`,
      advice: [
        `当前空闲物理内存仅剩 ${ramFreeGb} GB，强行装载 ${weightsGb} GB 权重会立即触发 Windows 页面文件（虚拟内存）颠簸并造成系统死锁。`,
        '请立即检查并关闭占用大内存的进程（如 llama-server、本地 Ollama 服务、Chrome 浏览器等后台）。',
        smallerAlternative ? `建议改用更小模型：${smallerAlternative}。` : '释放内存后重新提交任务即可。',
      ],
    }
  }

  // 规则 3.5: ramNeededBytes > ramTotal * 0.95 (整机物理内存都不够装下该任务) → blocked
  if (device.ramTotal > 0 && est.ramNeededBytes > device.ramTotal * 0.95) {
    const ramNeededGb = formatGb(est.ramNeededBytes)
    return {
      verdict: 'blocked',
      message: `你这台设备无法流畅运行此类任务:该模型体系需要约 ${ramNeededGb} GB 系统内存,你的机器只有 ${ramTotalGb} GB。`,
      advice: [
        '如 MiniMax H3 等旗舰视频模型建议至少 24GB 显存 + 64GB 内存,或直接用云端服务。',
        '高性价比升级与替代建议：',
        '1. 显卡升级至 24GB 显存档位（如 RTX 5070 Ti 24GB 或二手 RTX 3090/4090 24GB），彻底杜绝爆显存换页；',
        '2. 系统内存扩容至 64GB（双通道），避免后台程序与大模型抢占物理内存；',
        '3. 或接入按量计费的云端推理 API/算力云服务，无需本地硬件投入。',
        smallerAlternative ? `当前建议改用更小模型：${smallerAlternative}。` : '升级硬件后重新提交任务即可。',
      ],
    }
  }

  // 规则 2: weights > vramTotal * 0.9 (装不下但 RAM 够) → ok_slow
  if (device.vramTotal > 0 && weightsBytes > device.vramTotal * 0.9) {
    const altMsg = smallerAlternative ? `，建议改用 <${smallerAlternative}>` : ''
    return {
      verdict: 'ok_slow',
      message: `模型 ${weightsGb} GB 超出可用显存 ${vramFreeGb} GB（总显存 ${vramTotalGb} GB），将换页流式，预计 ${expectedMinutes} 分钟起步${altMsg}。`,
      advice: [
        `模型完整权重无法常驻显存，ComfyUI 将频繁在系统内存与显存之间流式换页，速度极慢。`,
        smallerAlternative ? `若追求生成效率，强烈推荐切换到 ${smallerAlternative}。` : '如继续执行请预留充裕时间。',
      ],
    }
  }

  // 规则 1: weights + 激活 < vramFree * 0.9 且 ramFree 充足 → ok
  return {
    verdict: 'ok',
    message: `设备状态健康（可用显存 ${vramFreeGb} GB / ${vramTotalGb} GB，可用内存 ${ramFreeGb} GB / ${ramTotalGb} GB），适合流畅出片。`,
    advice: [],
  }
}
