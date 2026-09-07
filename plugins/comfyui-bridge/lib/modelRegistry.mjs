// lib/modelRegistry.mjs — ComfyUI 官方重打包及社区主流模型注册表与本地模型库检索
//
// 专为模型自动获取设计：
// 1. 声明已知核心模型的官方权威分流源（ModelScope 镜像优先 + HF Mirror 镜像回退）；
// 2. 严格记录实测文件精确字节数（用于断点续传完整性校验）；
// 3. 遵循用户现有模型库结构，严格映射至 standard subfolder；
// 4. 提供全库扫描查重 findInLibrary，防止重复下载占用磁盘。

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * ComfyUI 规范模型子目录集合
 */
export const STANDARD_SUBFOLDERS = [
  'diffusion_models',
  'text_encoders',
  'vae',
  'loras',
  'checkpoints',
  'clip',
  'clip_vision',
  'unet',
]

/**
 * 按文件名/路径推断模型应存放的子目录（移植自 Stability Matrix 的
 * HuggingFaceFolderInference 级联,目录名改为 ComfyUI 规范）。
 * 用于自定义 URL 下载时省去 subfolder 参数、防止放错位置。
 * @param {string} nameOrPath - 文件名或含仓库路径的完整字符串
 * @returns {string} 子目录名(可能超出 STANDARD_SUBFOLDERS,如 controlnet/embeddings/upscale_models)
 */
export function inferSubfolderFromName(nameOrPath) {
  const p = String(nameOrPath || '').replace(/\\/g, '/').toLowerCase()
  if (!p) return 'checkpoints'
  const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
  const has = (...ws) => ws.some((w) => p.includes(w))
  const starts = (...ws) => ws.some((w) => base.startsWith(w))

  if (has('clip_vision', 'clip-vision', 'clipvision')) return 'clip_vision'
  if (has('controlnet', 'control_net', 'control-net', 'control_v', 'control-v')) return 'controlnet'
  if (has('t2i_adapter', 't2i-adapter')) return 't2i_adapter'
  if (has('ip-adapter', 'ip_adapter', 'ipadapter')) return 'ipadapter'
  if (
    has('text_encoder', 'text-encoder', '/clip/')
    || starts('clip_', 'clip-', 't5', 'umt5', 'byt5', 'mt5', 'llava', 'llama', 'gemma', 'qwen_3', 'qwen2', 'qwen3')
  ) return 'text_encoders'
  if (has('vae') || starts('ae.')) return 'vae'
  if (has('lora', 'loras')) return 'loras'
  if (has('embedding', 'textual_inversion', 'negative')) return 'embeddings'
  if (has('upscal', 'esrgan', 'swinir', 'realesrgan', 'ultrasharp', 'nmkd', 'remacri')) return 'upscale_models'
  if (base.endsWith('.gguf') || has('unet', 'diffusion_model', 'diffusion_models', 'transformer')) return 'diffusion_models'
  return 'checkpoints'
}

/**
 * 已知模型注册表条目：
 * filename: 文件名（basename）
 * subfolder: 规范存放子目录
 * bytes: 官方实测精确字节数
 * sources: 来源 URL 列表（顺序由优到备）
 * note: 说明备注
 */
export const KNOWN_MODELS = [
  // ── Wan2.2 TI2V 5B ────────────────────────────────────────────────────────
  {
    filename: 'wan2.2_ti2v_5B_fp16.safetensors',
    subfolder: 'diffusion_models',
    bytes: 9999658848,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/Wan_2.2_comfyui_repackaged/resolve/master/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
      'https://hf-mirror.com/Comfy-Org/Wan_2.2_comfyui_repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
    ],
    note: 'Wan2.2 TI2V-5B 极速生视频主权重（9.31GB，16GB显卡甜点）',
  },
  {
    filename: 'wan2.2_vae.safetensors',
    subfolder: 'vae',
    bytes: 1409400960,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/Wan_2.2_comfyui_repackaged/resolve/master/split_files/vae/wan2.2_vae.safetensors',
      'https://hf-mirror.com/Comfy-Org/Wan_2.2_comfyui_repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
    ],
    note: 'Wan2.2 专用高压缩比视频 VAE',
  },

  // ── Wan2.1 14B ────────────────────────────────────────────────────────────
  {
    filename: 'wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors',
    subfolder: 'diffusion_models',
    bytes: 16397245448,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/master/split_files/diffusion_models/wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors',
      'https://hf-mirror.com/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors',
    ],
    note: 'Wan2.1 图生视频 720p 14B fp8 权重',
  },
  {
    filename: 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors',
    subfolder: 'diffusion_models',
    bytes: 16397245448,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/master/split_files/diffusion_models/wan2.1_t2v_14B_fp8_e4m3fn.safetensors',
      'https://hf-mirror.com/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_14B_fp8_e4m3fn.safetensors',
    ],
    note: 'Wan2.1 文生视频 14B fp8 权重',
  },
  {
    filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    subfolder: 'text_encoders',
    bytes: 6735906897,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/master/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      'https://hf-mirror.com/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    ],
    note: 'Wan2.1 / Wan2.2 共享 UMT5 文本编码器',
  },
  {
    filename: 'wan_2.1_vae.safetensors',
    subfolder: 'vae',
    bytes: 253815318,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/master/split_files/vae/wan_2.1_vae.safetensors',
      'https://hf-mirror.com/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
    ],
    note: 'Wan2.1 视频 VAE',
  },

  // ── Z-Image 配套件(Z-Image 系 DiT-only 主模型的外挂编码器与 VAE)────────────
  {
    filename: 'qwen_3_4b_fp8_mixed.safetensors',
    subfolder: 'text_encoders',
    bytes: 5631994051,
    sources: [
      'https://hf-mirror.com/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors',
    ],
    note: 'Z-Image 官方文本编码器 Qwen3-4B fp8(Z-Image 主模型不内嵌编码器,必配;ComfyUI 按张量自动识别为 Z-Image TE)',
  },
  {
    filename: 'ae.safetensors',
    subfolder: 'vae',
    bytes: 335304388,
    sources: [
      'https://hf-mirror.com/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
    ],
    note: 'Z-Image 官方 VAE(Z-Image 主模型不内嵌 VAE,必配;注意与 Flux 的同名 ae.safetensors 是不同文件,不可混用)',
  },

  // ── Qwen-Image-Edit-2509 指令式图像编辑套件 ─────────────────────────────────
  {
    filename: 'Qwen-Image-Edit-2509-Q4_K_M.gguf',
    subfolder: 'diffusion_models',
    bytes: 13065746976,
    sources: [
      'https://hf-mirror.com/QuantStack/Qwen-Image-Edit-2509-GGUF/resolve/main/Qwen-Image-Edit-2509-Q4_K_M.gguf',
    ],
    note: '官方 Qwen-Image-Edit-2509 DiT Q4_K_M 量化(16GB 显存甜点;配套 Lightning 8步 LoRA + qwen_image_vae + qwen_2.5_vl_7b TE(device=cpu))',
  },
  {
    filename: 'Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors',
    subfolder: 'loras',
    bytes: 849608296,
    sources: [
      'https://hf-mirror.com/Osrivers/Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors/resolve/main/Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors',
    ],
    note: 'Qwen-Image-Edit-2509 Lightning 8 步蒸馏 LoRA(权重 1.0,euler+simple cfg1,40步→8步)',
  },
  {
    filename: 'qwen_image_vae.safetensors',
    subfolder: 'vae',
    bytes: 253806246,
    sources: [
      'https://hf-mirror.com/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors',
    ],
    note: '★Qwen-Image-Edit 专用 VAE — 与 Z-Image 的 ae.safetensors 不可混用(实测:混用=参考图隐编码带时间维→token×8 爆显存 + 解码棋盘伪影)',
  },
  {
    filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
    subfolder: 'text_encoders',
    bytes: 9384670680,
    sources: [
      'https://hf-mirror.com/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
    ],
    note: 'Qwen-Image-Edit 文本编码器 Qwen2.5-VL-7B fp8(CLIPLoader type=qwen_image;16GB 卡建议 device=cpu 固定内存)',
  },

  // ── SDXL NSFW 写实 / 二次元主模型 ────────────────────────────────────────
  {
    filename: 'RealVisXL_V5.0_Lightning_fp16.safetensors',
    subfolder: 'checkpoints',
    bytes: 6938065512,
    sources: [
      'https://hf-mirror.com/SG161222/RealVisXL_V5.0_Lightning/resolve/main/RealVisXL_V5.0_Lightning_fp16.safetensors',
    ],
    note: '写实摄影系 SDXL Lightning 主模型(6步 cfg2,832x1216 约 8 秒/张)',
  },
  {
    filename: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
    subfolder: 'checkpoints',
    bytes: 6938041050,
    sources: [
      'https://hf-mirror.com/LyliaEngine/Pony_Diffusion_V6_XL/resolve/main/ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
    ],
    note: '二次元 NSFW 标准主模型 Pony V6 XL(score_9 标签体系,26步 cfg7 dpmpp_2m/karras)',
  },

  // ── 黑兽(Kuroinu)系列 LoRA ──────────────────────────────────────────────
  {
    filename: 'kuroinu_pony_chloe.safetensors',
    subfolder: 'loras',
    bytes: 57430116,
    sources: [
      'https://civitai.com/api/download/models/796852?fileId=751426',
    ],
    note: '黑兽 Chloe 角色卡(Pony 底座,触发词 KJOchloe;实测角色还原度极高)',
  },
  {
    filename: 'kuroinu_pony_leona.safetensors',
    subfolder: 'loras',
    bytes: 0,
    sources: [
      'https://civitai.com/api/download/models/796499?fileId=710208',
    ],
    note: '黑兽外传 Leona 角色卡(Pony 底座,触发词 KJOLeona,狼耳白发自定义种族)',
  },
  {
    filename: 'kuroinu_pony_luca.safetensors',
    subfolder: 'loras',
    bytes: 0,
    sources: [
      'https://civitai.com/api/download/models/973109?fileId=880025',
    ],
    note: '黑兽 Luca 角色卡(Pony 底座,触发词 KJOluca,暗色肌肤黑发精灵)',
  },
  {
    filename: 'kuroinu_wan_style.safetensors',
    subfolder: 'loras',
    bytes: 306848776,
    sources: [
      'https://hf-mirror.com/NathanJosh/wan_Kuroinu_Style/resolve/main/KuroinuStyleWan-000014.safetensors',
    ],
    note: '黑兽画风 Wan 视频风格 LoRA(LoraLoaderModelOnly 串接,权重 0.7 起试)',
  },

  // ── MiniMax H3 系列（ModelScope 实测 ~28MB/s 优先，hf-mirror 兜底）───────────
  {
    filename: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    subfolder: 'diffusion_models',
    bytes: 20970379616,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      'https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    ],
    note: 'MiniMax H3 FL2VA 剪枝 INT8 权重（19.53GB）',
  },
  {
    filename: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    subfolder: 'diffusion_models',
    bytes: 20970379616,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
      'https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    ],
    note: 'MiniMax H3 Ref2VA 剪枝 INT8 权重（19.53GB）',
  },
  {
    filename: 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
    subfolder: 'diffusion_models',
    bytes: 20958205608,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
      'https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
    ],
    note: 'MiniMax H3 FL2VA 剪枝 FP8 权重（19.52GB）',
  },
  {
    filename: 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors',
    subfolder: 'diffusion_models',
    bytes: 20958205608,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors',
      'https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors',
    ],
    note: 'MiniMax H3 Ref2VA 剪枝 FP8 权重（19.52GB）',
  },
  {
    filename: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    subfolder: 'text_encoders',
    bytes: 15687142551,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
      'https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    ],
    note: 'MiniMax H3 官方绑定 Qwen3-VL-32B NVFP4-AWQ 文本编码器（14.61GB）',
  },
  {
    filename: 'minimax_h3_video_vae_fp16.safetensors',
    subfolder: 'vae',
    bytes: 5207808496,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/vae/minimax_h3_video_vae_fp16.safetensors',
      'https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors',
    ],
    note: 'MiniMax H3 原生视频 VAE（4.85GB）',
  },
  {
    filename: 'minimax_h3_audio_vae_fp32.safetensors',
    subfolder: 'vae',
    bytes: 605254808,
    sources: [
      'https://modelscope.cn/models/Comfy-Org/MiniMax-H3/resolve/master/vae/minimax_h3_audio_vae_fp32.safetensors',
      'https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors',
    ],
    note: 'MiniMax H3 32kHz 原生音频 VAE（0.56GB）',
  },
  {
    filename: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
    subfolder: 'loras',
    bytes: 1956193000,
    sources: [
      'https://hf-mirror.com/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
    ],
    note: 'MiniMax H3 8 步 Turbo 蒸馏加速 LoRA（1.82GB；lightx2v 仓库无 ModelScope 镜像）',
  },
]

/**
 * 依据文件名精确查找注册表条目
 */
export function byFilename(name) {
  if (!name || typeof name !== 'string') return null
  const base = path.basename(name).trim()
  return KNOWN_MODELS.find((item) => item.filename.toLowerCase() === base.toLowerCase()) || null
}

/**
 * 在用户的模型库目录（modelsDir，支持单一字符串或多根数组）全库扫描查重
 */
export function findInLibrary(modelsDir, filename, preferredSubfolder = null) {
  if (!modelsDir || !filename) {
    return { found: false, fullPath: null, size: 0, subfolder: null }
  }

  const baseName = path.basename(filename).trim().toLowerCase()
  if (!baseName) return { found: false, fullPath: null, size: 0, subfolder: null }

  let dirs = []
  if (Array.isArray(modelsDir)) {
    dirs = modelsDir.map((d) => (typeof d === 'string' ? d : d?.path)).filter(Boolean)
  } else if (typeof modelsDir === 'string' && modelsDir.trim()) {
    dirs = [modelsDir.trim()]
  }
  if (dirs.length === 0) return { found: false, fullPath: null, size: 0, subfolder: null }

  const searchDirs = []
  if (preferredSubfolder && STANDARD_SUBFOLDERS.includes(preferredSubfolder)) {
    searchDirs.push(preferredSubfolder)
  }
  for (const sf of STANDARD_SUBFOLDERS) {
    if (!searchDirs.includes(sf)) {
      searchDirs.push(sf)
    }
  }
  searchDirs.push('')

  for (const rootDir of dirs) {
    if (!fs.existsSync(rootDir)) continue
    for (const sub of searchDirs) {
      const candidateDir = sub ? path.join(rootDir, sub) : rootDir
      if (!fs.existsSync(candidateDir)) continue
      try {
        const entries = fs.readdirSync(candidateDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && entry.name.toLowerCase() === baseName) {
            const fullPath = path.join(candidateDir, entry.name)
            try {
              const stat = fs.statSync(fullPath)
              if (stat.size > 0) {
                return { found: true, fullPath, size: stat.size, subfolder: sub || null, root: rootDir }
              }
            } catch {}
          }
        }
      } catch {}
    }
  }
  return { found: false, fullPath: null, size: 0, subfolder: null }
}