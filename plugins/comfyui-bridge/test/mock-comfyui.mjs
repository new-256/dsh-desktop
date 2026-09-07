// mock-comfyui.mjs — 独立的轻量 ComfyUI HTTP Mock 服务器
//
// 零外部依赖，使用纯 node:http 实现。既可在测试中以模块形式导入启动，
// 也可以作为独立进程运行：node test/mock-comfyui.mjs [port] [--fail-video] [--api-prefix-only] [--no-h3]

import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

// 有效的 8x8 纯色 PNG 图片 Base64
export const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR42mNk+M9QzwAEjDAGUAAAoB8B8U3Z55kAAAAASUVORK5CYII=',
  'base64'
)

// 16 字节虚拟 WEBM/视频二进制
export const DUMMY_VIDEO_BUFFER = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
])

// Mock 节点元数据（object_info）
export const MOCK_OBJECT_INFO = {
  CheckpointLoaderSimple: {
    input: {
      required: {
        ckpt_name: [['sd_xl_base_1.0.safetensors', 'v1-5-pruned-emaonly.safetensors', 'svd_xt_1.1.safetensors']],
      },
    },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  ImageOnlyCheckpointLoader: {
    input: {
      required: {
        ckpt_name: [['svd_xt_1.1.safetensors', 'sd_xl_base_1.0.safetensors']],
      },
    },
    output: ['MODEL', 'CLIP_VISION', 'VAE'],
  },
  CLIPTextEncode: {
    input: {
      required: {
        text: ['STRING', { multiline: true }],
        clip: ['CLIP'],
      },
    },
    output: ['CONDITIONING'],
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ['INT', { default: 512, min: 64, max: 8192 }],
        height: ['INT', { default: 512, min: 64, max: 8192 }],
        batch_size: ['INT', { default: 1, min: 1, max: 64 }],
      },
    },
    output: ['LATENT'],
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        seed: ['INT', { default: 0 }],
        steps: ['INT', { default: 20 }],
        cfg: ['FLOAT', { default: 8.0 }],
        sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m']],
        scheduler: [['normal', 'simple', 'karras']],
        denoise: ['FLOAT', { default: 1.0 }],
      },
    },
    output: ['LATENT'],
  },
  VAEDecode: {
    input: {
      required: {
        samples: ['LATENT'],
        vae: ['VAE'],
      },
    },
    output: ['IMAGE'],
  },
  VAEEncode: {
    input: {
      required: {
        pixels: ['IMAGE'],
        vae: ['VAE'],
      },
    },
    output: ['LATENT'],
  },
  SaveImage: {
    input: {
      required: {
        images: ['IMAGE'],
      },
      optional: {
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
      },
    },
    output: [],
  },
  LoadImage: {
    input: {
      required: {
        image: ['STRING'],
      },
    },
    output: ['IMAGE', 'MASK'],
  },
  UNETLoader: {
    input: {
      required: {
        unet_name: [
          [
            'wan2.1_t2v_1.3b_fp8.safetensors',
            'wan2.1_i2v_480p_1.3b_fp8.safetensors',
            'wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors',
            'wan2.2_ti2v_5B_fp16.safetensors',
            'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
            'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
          ],
        ],
        weight_dtype: [['default', 'fp8_e4m3fn']],
      },
    },
    output: ['MODEL'],
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [
          [
            'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
            'clip_l.safetensors',
            'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
            'qwen3vl_32b_minimax_h3_nvfp4_awq_abliterated.safetensors',
          ],
        ],
      },
      optional: {
        type: [['minimax', 'wan', 'sdxl', 'sd3']],
        device: [['default', 'cpu']],
      },
    },
    output: ['CLIP'],
  },
  VAELoader: {
    input: {
      required: {
        vae_name: [
          [
            'wan_2.1_vae.safetensors',
            'wan2.2_vae.safetensors',
            'vae-ft-mse-840000-ema-pruned.safetensors',
            'minimax_h3_video_vae_fp16.safetensors',
            'minimax_h3_audio_vae_fp32.safetensors',
          ],
        ],
      },
    },
    output: ['VAE'],
  },
  ModelSamplingSD3: {
    input: {
      required: {
        model: ['MODEL'],
        shift: ['FLOAT', { default: 3.0 }],
      },
    },
    output: ['MODEL'],
  },
  EmptyHunyuanLatentVideo: {
    input: {
      required: {
        width: ['INT', { default: 832 }],
        height: ['INT', { default: 480 }],
        length: ['INT', { default: 81 }],
        batch_size: ['INT', { default: 1 }],
      },
    },
    output: ['LATENT'],
  },
  Wan22ImageToVideoLatent: {
    input: {
      required: {
        vae: ['VAE'],
        width: ['INT', { default: 1280 }],
        height: ['INT', { default: 704 }],
        length: ['INT', { default: 121 }],
        batch_size: ['INT', { default: 1 }],
      },
      optional: {
        start_image: ['IMAGE'],
      },
    },
    output: ['LATENT'],
  },
  WanImageToVideo: {
    input: {
      required: {
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        vae: ['VAE'],
        width: ['INT', { default: 832 }],
        height: ['INT', { default: 480 }],
        length: ['INT', { default: 81 }],
        batch_size: ['INT', { default: 1 }],
        start_image: ['IMAGE'],
      },
    },
    output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
  },
  SVD_img_to_vid_Conditioning: {
    input: {
      required: {
        clip_vision_output: ['CLIP_VISION'],
        init_image: ['IMAGE'],
        vae: ['VAE'],
        width: ['INT', { default: 1024 }],
        height: ['INT', { default: 576 }],
        video_frames: ['INT', { default: 25 }],
        motion_bucket_id: ['INT', { default: 127 }],
        fps: ['INT', { default: 8 }],
        augmentation_level: ['FLOAT', { default: 0.0 }],
      },
    },
    output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
  },
  VideoLinearCFGGuidance: {
    input: {
      required: {
        model: ['MODEL'],
        min_cfg: ['FLOAT', { default: 1.0 }],
      },
    },
    output: ['MODEL'],
  },
  ADE_AnimateDiffLoaderGen1: {
    input: {
      required: {
        model: ['MODEL'],
        model_name: [['v3_sd15_mm.safetensors', 'mm_sd_v15_v2.ckpt']],
        context_length: ['INT', { default: 16 }],
      },
    },
    output: ['MODEL'],
  },
  VideoTriangleCFGGuidance: {
    input: {
      required: {
        model: ['MODEL'],
        min_cfg: ['FLOAT', { default: 1.0 }],
      },
    },
    output: ['MODEL'],
  },
  SaveVideo: {
    input: {
      required: {
        format: [['auto', 'video/h264-mp4', 'video/vp9-webm']],
        codec: [['auto', 'h264', 'vp9', 'av1']],
      },
      optional: {
        images: ['IMAGE'],
        video: ['VIDEO'],
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
        fps: ['FLOAT', { default: 16 }],
        video_format: [['video/h264-mp4', 'video/vp9-webm']],
      },
    },
    output: [],
  },
  SaveWEBM: {
    input: {
      required: {
        images: ['IMAGE'],
      },
      optional: {
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
        fps: ['FLOAT', { default: 16 }],
        codec: [['vp9', 'av1']],
        crf: ['FLOAT', { default: 32.0 }],
      },
    },
    output: [],
  },
  SaveAnimatedWEBM: {
    input: {
      required: {
        images: ['IMAGE'],
      },
      optional: {
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
        fps: ['FLOAT', { default: 8 }],
      },
    },
    output: [],
  },
  SaveAnimatedPNG: {
    input: {
      required: {
        images: ['IMAGE'],
      },
      optional: {
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
        fps: ['FLOAT', { default: 8 }],
      },
    },
    output: [],
  },
  LoraLoader: {
    input: {
      required: {
        model: ['MODEL'],
        clip: ['CLIP'],
        lora_name: [
          [
            'detail_tweaker.safetensors',
            'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
          ],
        ],
        strength_model: ['FLOAT', { default: 1.0 }],
        strength_clip: ['FLOAT', { default: 1.0 }],
      },
    },
    output: ['MODEL', 'CLIP'],
  },
  UpscaleModelLoader: {
    input: {
      required: {
        model_name: [['4x_NMKD_Superscale_SP_178000_G.pth']],
      },
    },
    output: ['UPSCALE_MODEL'],
  },

  // ── MiniMax H3 官方节点集合 ───────────────────────────────────────────────
  MiniMaxH3ImageToVideo: {
    input: {
      required: {
        clip: ['CLIP'],
        vae: ['VAE'],
        prompt: ['STRING', { multiline: true }],
        width: ['INT', { default: 1344 }],
        height: ['INT', { default: 768 }],
        length: ['INT', { default: 124 }],
      },
      optional: {
        first_frame: ['IMAGE'],
        last_frame: ['IMAGE'],
      },
    },
    output: ['CONDITIONING', 'LATENT'],
  },
  MiniMaxH3ReferenceToVideo: {
    input: {
      required: {
        clip: ['CLIP'],
        vae: ['VAE'],
        prompt: ['STRING', { multiline: true }],
        width: ['INT', { default: 1344 }],
        height: ['INT', { default: 768 }],
        length: ['INT', { default: 124 }],
        ref_image_size: [['match', 'max']],
      },
      optional: {
        audio_vae: ['VAE'],
        ref_image_0: ['IMAGE'],
      },
    },
    output: ['CONDITIONING', 'LATENT'],
  },
  LoraLoaderModelOnly: {
    input: {
      required: {
        model: ['MODEL'],
        lora_name: [
          [
            'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
            'other_lora.safetensors',
          ],
        ],
        strength_model: ['FLOAT', { default: 1.0 }],
      },
    },
    output: ['MODEL'],
  },
  RandomNoise: {
    input: {
      required: {
        noise_seed: ['INT', { default: 0 }],
      },
    },
    output: ['NOISE'],
  },
  KSamplerSelect: {
    input: {
      required: {
        sampler_name: [['res_multistep', 'euler', 'dpmpp_2m']],
      },
    },
    output: ['SAMPLER'],
  },
  BasicScheduler: {
    input: {
      required: {
        model: ['MODEL'],
        scheduler: [['simple', 'karras']],
        steps: ['INT', { default: 20 }],
        denoise: ['FLOAT', { default: 1.0 }],
      },
    },
    output: ['SIGMAS'],
  },
  BasicGuider: {
    input: {
      required: {
        model: ['MODEL'],
        conditioning: ['CONDITIONING'],
      },
    },
    output: ['GUIDER'],
  },
  SamplerCustomAdvanced: {
    input: {
      required: {
        noise: ['NOISE'],
        guider: ['GUIDER'],
        sampler: ['SAMPLER'],
        sigmas: ['SIGMAS'],
        latent_image: ['LATENT'],
      },
    },
    output: ['LATENT', 'LATENT'],
  },
  VAEDecodeAudio: {
    input: {
      required: {
        samples: ['LATENT'],
        vae: ['VAE'],
      },
    },
    output: ['AUDIO'],
  },
  CreateVideo: {
    input: {
      required: {
        images: ['IMAGE'],
        fps: ['FLOAT', { default: 24.0 }],
      },
      optional: {
        audio: ['AUDIO'],
      },
    },
    output: ['VIDEO'],
  },
}

/**
 * 创建 Mock ComfyUI HTTP Server 实例
 */
export function createMockComfyServer(options = {}) {
  const failVideo = Boolean(options.failVideo || process.env.MOCK_FAIL_VIDEO === '1')
  const apiPrefixOnly = Boolean(options.apiPrefixOnly || process.env.MOCK_API_PREFIX_ONLY === '1')
  const noH3 = Boolean(options.noH3 || process.env.MOCK_NO_H3 === '1')
  const completeDelayMs = options.completeDelayMs ?? 200

  const history = new Map()
  const queueRunning = []
  const queuePending = []
  const uploadedFiles = []
  let promptCounter = 0
  let interruptCalls = 0
  let freeCalls = 0
  let freeLastBody = null

  // 依据 noH3 选项构建 live object_info
  const getLiveObjectInfo = () => {
    const info = JSON.parse(JSON.stringify(MOCK_OBJECT_INFO))
    if (noH3) {
      delete info.MiniMaxH3ImageToVideo
      delete info.MiniMaxH3ReferenceToVideo
      delete info.LoraLoaderModelOnly
      delete info.RandomNoise
      delete info.KSamplerSelect
      delete info.BasicScheduler
      delete info.BasicGuider
      delete info.SamplerCustomAdvanced
      delete info.CreateVideo
      delete info.SaveVideo
    }
    if (typeof options.objectInfoModifier === 'function') {
      options.objectInfoModifier(info)
    }
    return info
  }

  const server = http.createServer(async (req, res) => {
    // 仅向 stderr 记录请求日志
    console.error(`[MockComfyUI] ${req.method} ${req.url}`)

    let rawPath = req.url || '/'
    const parsedUrl = new URL(rawPath, 'http://127.0.0.1')
    let pathname = parsedUrl.pathname

    // 如果启用了仅 /api 前缀测试模式
    if (apiPrefixOnly) {
      if (!pathname.startsWith('/api/') && pathname !== '/api') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found (prefix mode required)' }))
        return
      }
      pathname = pathname.slice(4) // 移除 /api
    }

    // 辅助工具：返回 JSON
    const sendJson = (statusCode, obj) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }

    // 辅助工具：读取 Body
    const readBody = () =>
      new Promise((resolve) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks)))
      })

    try {
      // 1. GET /system_stats
      if (req.method === 'GET' && pathname === '/system_stats') {
        if (options.systemStats) {
          sendJson(200, options.systemStats)
          return
        }
        sendJson(200, {
          system: {
            comfyui_version: '0.3.10',
            pytorch_version: '2.5.1+cu124',
            os: 'windows',
            uptime: 3600.0,
            ram_total: 68719476736, // 64 GB
            ram_free: 51539607552,  // 48 GB
            ...(options.mockSystem || {}),
          },
          devices: options.mockDevices || [
            {
              name: 'NVIDIA GeForce RTX 5060 Ti',
              type: 'cuda',
              vram_total: 17179869184, // 16 GB
              vram_free: 15032385536,  // ~14 GB
              torch_device_name: 'cuda:0',
            },
          ],
        })
        return
      }

      // 2. GET /queue
      if (req.method === 'GET' && pathname === '/queue') {
        sendJson(200, {
          queue_running: queueRunning,
          queue_pending: queuePending,
        })
        return
      }

      // 3. GET /object_info or /object_info/{className}
      if (req.method === 'GET' && pathname.startsWith('/object_info')) {
        const liveInfo = getLiveObjectInfo()
        const sub = pathname.slice('/object_info'.length).replace(/^\/+/, '')
        if (!sub) {
          sendJson(200, liveInfo)
          return
        }
        if (liveInfo[sub]) {
          sendJson(200, { [sub]: liveInfo[sub] })
        } else {
          sendJson(404, {})
        }
        return
      }

      // 4. POST /prompt
      if (req.method === 'POST' && pathname === '/prompt') {
        const bodyBuf = await readBody()
        let parsed
        try {
          parsed = JSON.parse(bodyBuf.toString('utf-8'))
        } catch {
          sendJson(400, { error: 'Invalid JSON payload' })
          return
        }

        const promptGraph = parsed.prompt
        if (!promptGraph || typeof promptGraph !== 'object') {
          sendJson(400, { error: 'Missing prompt field in body' })
          return
        }

        // 严格模拟 ComfyUI 校验：检查节点 required 字段是否全部提供
        const liveInfo = getLiveObjectInfo()
        for (const [nodeId, node] of Object.entries(promptGraph)) {
          const classType = node?.class_type
          const spec = liveInfo[classType]
          if (spec && spec.input && spec.input.required) {
            const nodeInputs = node.inputs || {}
            for (const reqKey of Object.keys(spec.input.required)) {
              if (!(reqKey in nodeInputs) || nodeInputs[reqKey] === undefined) {
                sendJson(400, {
                  error: `prompt_outputs_failed_validation, node ${nodeId} (${classType}): Required input is missing: ${reqKey}`,
                  node_errors: {
                    [nodeId]: {
                      errors: [{ message: `Required input is missing: ${reqKey}`, type: 'prompt_outputs_failed_validation' }],
                    },
                  },
                })
                return
              }
            }
          }
        }

        const promptId = crypto.randomUUID()
        promptCounter++

        const promptItem = [promptCounter, promptId, promptGraph, parsed.extra_data || {}, []]
        queueRunning.push(promptItem)

        // 异步推进任务状态
        setTimeout(() => {
          // 从队列中移除
          const idx = queueRunning.findIndex((it) => it[1] === promptId)
          if (idx !== -1) queueRunning.splice(idx, 1)

          // 检测是否包含视频类或 Wan/SVD 节点
          let isVideoTask = false
          let hasMiniMaxH3 = false

          for (const node of Object.values(promptGraph)) {
            const ct = node.class_type
            if (
              [
                'SaveVideo',
                'SaveWEBM',
                'SaveAnimatedWEBM',
                'SaveAnimatedPNG',
                'WanImageToVideo',
                'SVD_img_to_vid_Conditioning',
                'ADE_AnimateDiffLoaderGen1',
              ].includes(ct)
            ) {
              isVideoTask = true
            }
            if (ct && ct.startsWith('MiniMaxH3')) {
              hasMiniMaxH3 = true
              isVideoTask = true
            }
          }

          if (options.stallWait) {
            return
          }

          if (failVideo && isVideoTask) {
            history.set(promptId, {
              prompt: promptItem,
              outputs: {},
              status: {
                status_str: 'error',
                completed: true,
                messages: [
                  [
                    'execution_error',
                    {
                      node_id: '10',
                      node_type: 'SaveVideo',
                      exception_type: 'torch.cuda.OutOfMemoryError',
                      exception_message: 'CUDA out of memory during video encode',
                      traceback: [
                        'Traceback (most recent call last):',
                        '  File "comfy/model_management.py", line 42, in encode',
                        '  File "comfy/video_nodes.py", line 120, in save',
                        'RuntimeError: CUDA out of memory',
                      ],
                    },
                  ],
                ],
              },
            })
          } else {
            // 成功输出
            const outputs = {}
            if (hasMiniMaxH3) {
              // MiniMax H3 视频生成完成：在 images 键下输出 mp4 并附带 animated: true 标记
              let saverNodeId = '14'
              for (const [nid, node] of Object.entries(promptGraph)) {
                if (node.class_type === 'SaveVideo') {
                  saverNodeId = nid
                  break
                }
              }
              outputs[saverNodeId] = {
                images: [{ filename: 'MiniMax_H3_00001_.mp4', subfolder: '', type: 'output' }],
                animated: [true],
              }
            } else {
              for (const [nid, node] of Object.entries(promptGraph)) {
                const ct = node.class_type
                if (ct === 'SaveImage') {
                  outputs[nid] = {
                    images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }],
                  }
                } else if (['SaveVideo', 'SaveWEBM', 'SaveAnimatedWEBM', 'SaveAnimatedPNG'].includes(ct)) {
                  // 使用 gifs 字段存储 webm 视频，验证输出键名自适应遍历能力
                  outputs[nid] = {
                    gifs: [{ filename: 'ComfyUI_00002_.webm', subfolder: '', type: 'output' }],
                  }
                }
              }
            }

            history.set(promptId, {
              prompt: promptItem,
              outputs,
              status: {
                status_str: 'success',
                completed: true,
                messages: [],
              },
            })
          }
        }, completeDelayMs)

        sendJson(200, {
          prompt_id: promptId,
          number: promptCounter,
          node_errors: {},
        })
        return
      }

      // 5. GET /history or /history/{id}
      if (req.method === 'GET' && pathname.startsWith('/history')) {
        const sub = pathname.slice('/history'.length).replace(/^\/+/, '')
        if (!sub) {
          const maxItems = Number(parsedUrl.searchParams.get('max_items')) || 10
          const out = {}
          let count = 0
          for (const [k, v] of Array.from(history.entries()).reverse()) {
            if (count >= maxItems) break
            out[k] = v
            count++
          }
          sendJson(200, out)
          return
        }

        if (history.has(sub)) {
          sendJson(200, { [sub]: history.get(sub) })
        } else {
          // 正在排队或不存在返回空对象
          sendJson(200, {})
        }
        return
      }

      // 6. GET /view
      if (req.method === 'GET' && pathname === '/view') {
        const filename = parsedUrl.searchParams.get('filename') || ''
        if (filename.endsWith('.webm')) {
          res.writeHead(200, { 'Content-Type': 'video/webm' })
          res.end(DUMMY_VIDEO_BUFFER)
          return
        }
        if (filename.endsWith('.mp4')) {
          res.writeHead(200, { 'Content-Type': 'video/mp4' })
          res.end(DUMMY_VIDEO_BUFFER)
          return
        }
        // 默认返回 8x8 PNG
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(TINY_PNG_BUFFER)
        return
      }

      // 7. POST /upload/image
      if (req.method === 'POST' && pathname === '/upload/image') {
        const bodyBuf = await readBody()
        const bodyStr = bodyBuf.toString('binary')

        // 简易提取 multipart 文件名
        const fnMatch = bodyStr.match(/filename="([^"]+)"/)
        const filename = fnMatch ? fnMatch[1] : 'uploaded.png'
        uploadedFiles.push({ filename, size: bodyBuf.length })

        sendJson(200, {
          name: filename,
          subfolder: '',
          type: 'input',
        })
        return
      }

      // 8. POST /interrupt
      if (req.method === 'POST' && pathname === '/interrupt') {
        interruptCalls++
        sendJson(200, {})
        return
      }

      // 9. POST /free
      if (req.method === 'POST' && pathname === '/free') {
        freeCalls++
        const bodyBuf = await readBody()
        try {
          freeLastBody = JSON.parse(bodyBuf.toString('utf8'))
        } catch {}
        sendJson(200, {})
        return
      }

      // 兜底 404
      sendJson(404, { error: `Not found: ${pathname}` })
    } catch (err) {
      sendJson(500, { error: String(err && err.message) })
    }
  })

  return {
    server,
    history,
    uploadedFiles,
    get interruptCalls() {
      return interruptCalls
    },
    get freeCalls() {
      return freeCalls
    },
    get freeLastBody() {
      return freeLastBody
    },
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address()
          const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port
          resolve(actualPort)
        })
        server.on('error', reject)
      })
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

// ── 独立运行入口 ────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let portArg = 8188
  for (const a of args) {
    if (/^\d+$/.test(a)) portArg = parseInt(a, 10)
  }
  const failVideo = args.includes('--fail-video')
  const apiPrefixOnly = args.includes('--api-prefix-only')
  const noH3 = args.includes('--no-h3')

  const instance = createMockComfyServer({ failVideo, apiPrefixOnly, noH3 })
  instance.listen(portArg).then((actualPort) => {
    // 关键输出供测试脚本或外部程序读取
    console.log(`MOCK_COMFYUI_PORT: ${actualPort}`)
    console.error(
      `Mock ComfyUI Server running at http://127.0.0.1:${actualPort} (failVideo=${failVideo}, apiPrefixOnly=${apiPrefixOnly}, noH3=${noH3})`
    )
  })
}
