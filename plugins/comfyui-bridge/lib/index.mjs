// comfyui-bridge — DSH 驱动本地 / 局域网 ComfyUI 生图与生视频桥接插件。
//
// 本插件为 DSH Host 侧插件（家级 cordis.patch.yml 挂载，全局层可见），让 DSH 模型工具
// 能够直接调用 ComfyUI 进行图片与视频生成，产物自动下载至工作区，便于模型通过 read_image 查看。
//
// 核心设计与特性：
//   1. 6 个模型工具注册至 global 层（全 preset / 全模式可见）：
//      - comfyui_status: 服务健康与显卡 VRAM 状态检查
//      - comfyui_models: 模型分类枚举（checkpoints / unets / vaes 等）与视频能力探测
//      - comfyui_generate: 核心生成工具（支持 preset 模板与 workflow 自由图构图）
//      - comfyui_history: 历史记录检索与产物断点续下
//      - comfyui_interrupt: 中断当前生成并支持可选显存释放
//      - comfyui_upload: 本地文件上传至 ComfyUI 输入目录
//   2. 预设工作流模板（preset 模式）与自适应机制：
//      - txt2img / img2img: 基础图文生成，支持 SD1.5 / SDXL / Flux 自动尺寸与参数启发
//      - wan_t2v / wan_i2v: 万象 Wan2.1 视频生成，自动探测 ModelSamplingSD3 移位与输入格式
//      - svd_img2vid: Stable Video Diffusion 图生视频
//      - animatediff: AnimateDiff 动态图与短视频生成
//      - h3_t2v / h3_flf2v / h3_r2v: MiniMax H3 本地开源权重高质量视频生成（支持首尾帧控制与参考图引导）
//      - 自适应视频保存尾（SaveVideo -> SaveWEBM -> SaveAnimatedWEBM -> SaveAnimatedPNG），适配各版本 ComfyUI
//   3. 健壮性与版本容错：
//      - API 路径自适应探测：优先直连根路径（如 /prompt），遇 404 自动回退并记住 /api 前缀
//      - 预校验机制：检查图中节点类与枚举参数合法性，未命中时提供近似建议或可用值列表
//      - 全程监听 exec.signal 取消信号，网络与执行错误均结构化返回，不向上抛出异常
//
// 依赖纪律：
//   不导入任何 @deepseek-ai/* 包，仅使用 Node.js 原生内置模块（node:fs, node:path, node:crypto 等）
//   与全局可用 API（fetch, FormData, Blob, AbortController）。

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as zlib from 'node:zlib'
import * as crypto from 'node:crypto'
import { execSync, execFileSync } from 'node:child_process'
import { probeDevice, estimate, check } from './capability.mjs'
import { resolveAutoDimensions, getImageDimensions } from './imageMeta.mjs'
import { KNOWN_MODELS, byFilename, findInLibrary, STANDARD_SUBFOLDERS, inferSubfolderFromName } from './modelRegistry.mjs'
import { downloadFile } from './downloader.mjs'
import { resolveModelsDirs, chooseFetchDestination } from './pathDiscovery.mjs'
import { assessComfyUIStatus, executeComfyUIInstall } from './installer.mjs'

export const name = 'comfyui-bridge'
export const inject = ['tools', 'systemPrompt']

// ── 默认配置常量 ─────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'
const DEFAULT_OUTPUTS_DIR = 'comfyui-outputs'
const DEFAULT_REQUEST_TIMEOUT_MS = 30000
const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_TIMEOUT_SEC = 1800
const DEFAULT_MAX_TIMEOUT_SEC = 3600
const DEFAULT_CLIENT_ID_PREFIX = 'dsh'
const OBJECT_INFO_CACHE_TTL_MS = 60000

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

// ── 辅助工具函数 ─────────────────────────────────────────────────────────────

/**
 * 整数钳位工具
 */
function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/**
 * 生成 yyyyMMdd-HHmmss 格式时间戳
 */
function formatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 计算 Levenshtein 编辑距离（用于类名拼写建议）
 */
function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/**
 * 在候选类名列表中寻找最相近的名称建议（最多 max 个）
 */
function findSimilarNames(target, candidates, max = 5) {
  const t = target.toLowerCase()
  return candidates
    .map((name) => {
      const n = name.toLowerCase()
      let score = levenshtein(t, n)
      if (n.includes(t) || t.includes(n)) score -= 4
      return { name, score }
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map((item) => item.name)
}

/**
 * 根据文件扩展名归类产物类型
 */
function classifyKind(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'].includes(ext)) return 'image'
  if (['.webm', '.mp4', '.mkv', '.mov', '.avi'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext)) return 'audio'
  return 'other'
}

/**
 * 对象深合并工具（用于 overrides 合并）
 */
function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target
  const out = { ...target }
  for (const key of Object.keys(source)) {
    const sVal = source[key]
    const tVal = out[key]
    if (sVal && typeof sVal === 'object' && !Array.isArray(sVal)) {
      out[key] = deepMerge(tVal && typeof tVal === 'object' && !Array.isArray(tVal) ? tVal : {}, sVal)
    } else {
      out[key] = sVal
    }
  }
  return out
}

/**
 * 可响应中止信号的延时等待
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * 将数值规整到最接近的 32 的整数倍（MiniMax H3 宽高要求）
 */
function roundTo32(val, def) {
  const v = Number(val) || def
  const rounded = Math.round(v / 32) * 32
  return Math.max(32, rounded)
}

/**
 * MiniMax H3 帧长对齐计算：最小的 n >= max(5, round(durationSec * 24)) 且 n % 17 == 5，硬顶 362
 */
function calculateH3Length(durationSec = 5) {
  const base = Math.max(5, Math.round((Number(durationSec) || 5) * 24))
  let n = base
  while (n % 17 !== 5) {
    n++
  }
  return Math.min(362, n)
}

// ── ComfyUI HTTP 客户端 ──────────────────────────────────────────────────────

class ComfyClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.headers = config.headers || {}
    this.requestTimeoutMs = config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS
    this.clientIdPrefix = config.clientIdPrefix || DEFAULT_CLIENT_ID_PREFIX
    // apiPrefix: 未探测时为 null，探测后为 '' 或 '/api'
    this.apiPrefix = null
    // object_info 内存缓存与刷新时间
    this.objectInfoCache = null
    this.objectInfoCacheTime = 0
  }

  /**
   * 发起 HTTP 请求，内置超时控制与 /api 路径回退探测
   */
  async request(pathName, options = {}, execSignal = null) {
    const method = options.method || 'GET'
    const headers = { ...this.headers, ...(options.headers || {}) }
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs

    const makeFetch = async (prefix) => {
      const fullUrl = `${this.baseUrl}${prefix}${pathName}`
      const ctrl = new AbortController()
      let timer = undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => ctrl.abort(new Error(`请求超时 (${timeoutMs}ms): ${fullUrl}`)), timeoutMs)
      }
      const onSignalAbort = () => ctrl.abort(execSignal?.reason || new Error('操作已被用户取消'))
      if (execSignal) {
        if (execSignal.aborted) ctrl.abort(execSignal.reason)
        else execSignal.addEventListener('abort', onSignalAbort, { once: true })
      }

      try {
        const fetchOpts = {
          method,
          headers,
          signal: ctrl.signal,
        }
        if (options.body !== undefined) {
          fetchOpts.body = options.body
        }
        const res = await fetch(fullUrl, fetchOpts)
        return res
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (execSignal) execSignal.removeEventListener('abort', onSignalAbort)
      }
    }

    try {
      if (this.apiPrefix !== null) {
        // 已知工作前缀，直接使用
        const res = await makeFetch(this.apiPrefix)
        return res
      }

      // 未知前缀：首先尝试原始根路径
      const res = await makeFetch('')
      if (res.status === 404) {
        // 根路径返回 404，尝试 /api 前缀回退
        try {
          const apiRes = await makeFetch('/api')
          if (apiRes.status !== 404) {
            this.apiPrefix = '/api'
            return apiRes
          }
        } catch {
          // 若 /api 探测发生网络错误，则仍保留原 404 响应
        }
        this.apiPrefix = ''
        return res
      } else {
        this.apiPrefix = ''
        return res
      }
    } catch (err) {
      const isAborted = execSignal && execSignal.aborted
      const errorMsg = isAborted ? '操作已取消' : (err && err.message) || String(err)
      const e = new Error(errorMsg)
      e.isAborted = isAborted
      e.isNetwork = !isAborted
      throw e
    }
  }

  /**
   * 发起 JSON 请求并解析结果
   */
  async requestJson(pathName, options = {}, execSignal = null) {
    const opts = { ...options }
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.body = JSON.stringify(opts.body)
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    }
    const res = await this.request(pathName, opts, execSignal)
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`ComfyUI 响应格式错误（非 JSON，HTTP ${res.status}）：${text.slice(0, 200)}`)
    }
    return { ok: res.ok, status: res.status, data }
  }

  /**
   * 获取并缓存全量 object_info
   */
  async getObjectInfo(execSignal = null, forceRefresh = false) {
    const now = Date.now()
    if (!forceRefresh && this.objectInfoCache && now - this.objectInfoCacheTime < OBJECT_INFO_CACHE_TTL_MS) {
      return this.objectInfoCache
    }
    const { ok, data, status } = await this.requestJson('/object_info', {}, execSignal)
    if (!ok) {
      throw new Error(`获取 object_info 失败 (HTTP ${status})`)
    }
    this.objectInfoCache = data
    this.objectInfoCacheTime = now
    return data
  }

  /**
   * 生成随机 client_id
   */
  generateClientId() {
    return `${this.clientIdPrefix}_${crypto.randomBytes(6).toString('hex')}`
  }
}

// ── 预设模板与节点校验 ────────────────────────────────────────────────────────

/**
 * 提取指定节点类的枚举参数列表
 */
function getEnumList(objectInfo, className, fieldName) {
  const cls = objectInfo?.[className]
  if (!cls || !cls.input) return []
  const req = cls.input.required?.[fieldName]
  if (Array.isArray(req) && Array.isArray(req[0])) return req[0]
  const opt = cls.input.optional?.[fieldName]
  if (Array.isArray(opt) && Array.isArray(opt[0])) return opt[0]
  return []
}

/**
 * 探测视频生成能力
 */
function detectVideoCaps(objectInfo) {
  return {
    saveVideo: Boolean(objectInfo?.['SaveVideo']),
    saveWEBM: Boolean(objectInfo?.['SaveWEBM']),
    saveAnimatedWEBM: Boolean(objectInfo?.['SaveAnimatedWEBM']),
    saveAnimatedPNG: Boolean(objectInfo?.['SaveAnimatedPNG']),
    wanNodes: Boolean(objectInfo?.['WanImageToVideo'] || objectInfo?.['EmptyHunyuanLatentVideo']),
    wan22Nodes: Boolean(objectInfo?.['Wan22ImageToVideoLatent']),
    svd: Boolean(objectInfo?.['SVD_img_to_vid_Conditioning'] || objectInfo?.['ImageOnlyCheckpointLoader']),
    animateDiff: Boolean(objectInfo?.['ADE_AnimateDiffLoaderGen1']),
    minimaxH3: Boolean(objectInfo?.['MiniMaxH3ImageToVideo']),
  }
}

let _hasFfmpeg = null
function getFfmpegPath() {
  if (_hasFfmpeg !== null) return _hasFfmpeg ? 'ffmpeg' : null
  try {
    execSync('ffmpeg -version', { stdio: 'ignore', timeout: 3000 })
    _hasFfmpeg = true
    return 'ffmpeg'
  } catch {
    _hasFfmpeg = false
    return null
  }
}

/**
 * 视频质检抽帧：使用 ffmpeg 抽取首/中/尾 3 帧存为 <base>_qc1/2/3.png
 */
function extractQCFrames(videoAbsPath, totalFramesHint = 81, workspaceRoot = '') {
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) return []
  const ffmpegCmd = getFfmpegPath()
  if (!ffmpegCmd) return []

  const dir = path.dirname(videoAbsPath)
  const ext = path.extname(videoAbsPath)
  const base = path.basename(videoAbsPath, ext)

  const totalFrames = Math.max(3, Number(totalFramesHint) || 81)
  const fFirst = 0
  const fMid = Math.max(1, Math.floor(totalFrames / 2))
  const fLast = Math.max(fMid + 1, totalFrames - 1)

  const targets = [
    { index: 1, frame: fFirst, fileName: `${base}_qc1.png` },
    { index: 2, frame: fMid, fileName: `${base}_qc2.png` },
    { index: 3, frame: fLast, fileName: `${base}_qc3.png` },
  ]

  const results = []
  for (const t of targets) {
    const outAbs = path.join(dir, t.fileName)
    try {
      execFileSync(
        ffmpegCmd,
        ['-y', '-i', videoAbsPath, '-vf', `select=eq(n\\,${t.frame})`, '-vframes', '1', outAbs],
        { stdio: 'ignore', timeout: 15000 }
      )
      if (fs.existsSync(outAbs) && fs.statSync(outAbs).size > 0) {
        const rel = workspaceRoot ? path.relative(workspaceRoot, outAbs).replace(/\\/g, '/') : outAbs
        results.push({ index: t.index, path: outAbs, relPath: rel })
      }
    } catch {
      // 遇到解码错误或无法抽帧静默跳过
    }
  }

  return results
}

/**
 * 看门狗清理：中止当前任务并释放 GPU 显存
 */
async function cleanupComfyUIOnAbortOrFailure(client) {
  try {
    await client.requestJson('/interrupt', { method: 'POST', body: {} })
  } catch {}
  try {
    await client.requestJson('/free', { method: 'POST', body: { unload_models: true, free_memory: true } })
  } catch {}
}

/**
 * 依据 live object_info 动态追加自适应视频保存节点
 * 优先级顺序:
 * 1. SaveVideo (新核心节点: 直接 images 或 CreateVideo -> SaveVideo)
 * 2.5 SaveWEBM (核心 SaveWEBM 节点)
 * 3. SaveAnimatedWEBM
 * 4. SaveAnimatedPNG
 */
function appendAdaptiveVideoSaverTail(graph, imagesWire, params, objectInfo, nextId) {
  const defaultFps = params.fps || 16
  const prefix = params.filename_prefix || 'ComfyUI'

  // 优先级 1: SaveVideo (新核心节点)
  if (objectInfo?.['SaveVideo']) {
    const cls = objectInfo['SaveVideo']
    const inputs = { ...(cls.input?.required || {}), ...(cls.input?.optional || {}) }

    // 辅助闭包：填充 SaveVideo 的 format 与 codec（若 schema 定义包含）
    const fillFormatAndCodec = (targetInputs) => {
      if ('format' in inputs) {
        const enumList = getEnumList(objectInfo, 'SaveVideo', 'format')
        const chosen = params.format || 'auto'
        if (enumList.length === 0 || enumList.includes(chosen)) {
          targetInputs.format = chosen
        } else if (enumList.includes('auto')) {
          targetInputs.format = 'auto'
        } else if (enumList.length > 0) {
          targetInputs.format = enumList[0]
        } else {
          targetInputs.format = chosen
        }
      }
      if ('codec' in inputs) {
        const enumList = getEnumList(objectInfo, 'SaveVideo', 'codec')
        const chosen = params.codec || 'auto'
        if (enumList.length === 0 || enumList.includes(chosen)) {
          targetInputs.codec = chosen
        } else if (enumList.includes('auto')) {
          targetInputs.codec = 'auto'
        } else if (enumList.length > 0) {
          targetInputs.codec = enumList[0]
        } else {
          targetInputs.codec = chosen
        }
      }
    }

    // 情况 1.1: 直接接收 images
    if ('images' in inputs) {
      const nodeInputs = { images: imagesWire }
      if ('filename_prefix' in inputs) nodeInputs.filename_prefix = prefix
      else if ('path_prefix' in inputs) nodeInputs.path_prefix = prefix
      if ('fps' in inputs) nodeInputs.fps = defaultFps

      const formatField = 'video_format' in inputs ? 'video_format' : ('format' in inputs ? 'format' : null)
      if (formatField && formatField !== 'format') {
        const enums = getEnumList(objectInfo, 'SaveVideo', formatField)
        if (enums.includes('video/h264-mp4')) nodeInputs[formatField] = 'video/h264-mp4'
        else if (enums.includes('video/vp9-webm')) nodeInputs[formatField] = 'video/vp9-webm'
        else if (enums.length > 0) nodeInputs[formatField] = enums[0]
      }
      fillFormatAndCodec(nodeInputs)

      graph[String(nextId)] = { class_type: 'SaveVideo', inputs: nodeInputs }
      return { tailNodeId: String(nextId), nextId: nextId + 1 }
    }

    // 情况 1.2: 接收 video 输入，需要先 CreateVideo
    if ('video' in inputs && objectInfo?.['CreateVideo']) {
      const cvCls = objectInfo['CreateVideo']
      const cvInputsDef = { ...(cvCls.input?.required || {}), ...(cvCls.input?.optional || {}) }
      const cvNodeInputs = { images: imagesWire }
      if ('fps' in cvInputsDef) cvNodeInputs.fps = defaultFps

      const cvId = String(nextId)
      graph[cvId] = { class_type: 'CreateVideo', inputs: cvNodeInputs }

      const svNodeInputs = { video: [cvId, 0] }
      if ('filename_prefix' in inputs) svNodeInputs.filename_prefix = prefix
      else if ('path_prefix' in inputs) svNodeInputs.path_prefix = prefix
      fillFormatAndCodec(svNodeInputs)

      const svId = String(nextId + 1)
      graph[svId] = { class_type: 'SaveVideo', inputs: svNodeInputs }
      return { tailNodeId: svId, nextId: nextId + 2 }
    }
  }

  // 优先级 2.5: SaveWEBM (Fix A: 新版 ComfyUI 核心的 SaveWEBM 节点)
  if (objectInfo?.['SaveWEBM']) {
    const cls = objectInfo['SaveWEBM']
    const inputs = { ...(cls.input?.required || {}), ...(cls.input?.optional || {}) }
    const nodeInputs = { images: imagesWire }
    if ('filename_prefix' in inputs) nodeInputs.filename_prefix = prefix
    if ('fps' in inputs) nodeInputs.fps = defaultFps
    if ('codec' in inputs) {
      const codecEnums = getEnumList(objectInfo, 'SaveWEBM', 'codec')
      if (codecEnums.includes('vp9')) nodeInputs.codec = 'vp9'
      else if (codecEnums.length > 0) nodeInputs.codec = codecEnums[0]
    }
    graph[String(nextId)] = { class_type: 'SaveWEBM', inputs: nodeInputs }
    return { tailNodeId: String(nextId), nextId: nextId + 1 }
  }

  // 优先级 3: SaveAnimatedWEBM
  if (objectInfo?.['SaveAnimatedWEBM']) {
    const cls = objectInfo['SaveAnimatedWEBM']
    const inputs = { ...(cls.input?.required || {}), ...(cls.input?.optional || {}) }
    const nodeInputs = { images: imagesWire }
    if ('filename_prefix' in inputs) nodeInputs.filename_prefix = prefix
    if ('fps' in inputs) nodeInputs.fps = defaultFps
    graph[String(nextId)] = { class_type: 'SaveAnimatedWEBM', inputs: nodeInputs }
    return { tailNodeId: String(nextId), nextId: nextId + 1 }
  }

  // 优先级 4: SaveAnimatedPNG
  if (objectInfo?.['SaveAnimatedPNG']) {
    const cls = objectInfo['SaveAnimatedPNG']
    const inputs = { ...(cls.input?.required || {}), ...(cls.input?.optional || {}) }
    const nodeInputs = { images: imagesWire }
    if ('filename_prefix' in inputs) nodeInputs.filename_prefix = prefix
    if ('fps' in inputs) nodeInputs.fps = defaultFps
    graph[String(nextId)] = { class_type: 'SaveAnimatedPNG', inputs: nodeInputs }
    return { tailNodeId: String(nextId), nextId: nextId + 1 }
  }

  throw new Error(
    'ComfyUI 未安装适用的视频保存节点。需要以下任意节点：SaveVideo（官方核心视频）、SaveWEBM、SaveAnimatedWEBM 或 SaveAnimatedPNG。请更新 ComfyUI 或安装 VHS 扩展包。'
  )
}

/**
 * 检查两数据类型是否兼容
 */
function areTypesCompatible(srcType, destType) {
  if (!srcType || !destType) return true
  const s = String(srcType).toUpperCase()
  const d = String(destType).toUpperCase()
  if (s === '*' || d === '*') return true
  if (s === d) return true
  if ((s === 'CLIP_VISION' || s === 'CLIP_VISION_OUTPUT') && (d === 'CLIP_VISION' || d === 'CLIP_VISION_OUTPUT')) {
    return true
  }
  return false
}

/**
 * 校验图中的所有 class_type、枚举字段值及连线槽位类型
 */
function validateGraphAgainstObjectInfo(graph, objectInfo) {
  const errors = []
  const availableClasses = Object.keys(objectInfo || {})

  for (const [nodeId, nodeDef] of Object.entries(graph)) {
    if (!nodeDef || typeof nodeDef !== 'object') {
      errors.push(`节点 "${nodeId}" 定义无效（必须为对象）`)
      continue
    }
    const classType = nodeDef.class_type
    if (!classType) {
      errors.push(`节点 "${nodeId}" 缺少 class_type 属性`)
      continue
    }

    const clsSpec = objectInfo?.[classType]
    if (!clsSpec) {
      const suggestions = findSimilarNames(classType, availableClasses, 5)
      const hint = suggestions.length > 0 ? `。您是否是指：${suggestions.join(', ')}？` : ''
      errors.push(`节点 "${nodeId}" 的类型 "${classType}" 在当前 ComfyUI 中不存在${hint}`)
      continue
    }

    const inputsDef = { ...(clsSpec.input?.required || {}), ...(clsSpec.input?.optional || {}) }
    const nodeInputs = nodeDef.inputs || {}

    for (const [paramName, paramVal] of Object.entries(nodeInputs)) {
      const fieldDef = inputsDef[paramName]

      // 若是节点连线数组形如 ["1", 0] 或 [1, 0]，执行槽位与类型校验
      if (
        Array.isArray(paramVal) &&
        paramVal.length === 2 &&
        (typeof paramVal[0] === 'string' || typeof paramVal[0] === 'number') &&
        typeof paramVal[1] === 'number'
      ) {
        const srcNodeId = String(paramVal[0])
        const srcSlotIndex = paramVal[1]
        const srcNode = graph[srcNodeId]

        if (!srcNode) {
          errors.push(`节点 "${nodeId}" (${classType}) 的输入 "${paramName}" 连接了不存在的上游节点 "${srcNodeId}"`)
          continue
        }

        const srcClassType = srcNode.class_type
        const srcSpec = objectInfo?.[srcClassType]
        // 若上游节点类或 output 定义不存在，跳过类型校验
        if (!srcSpec || !Array.isArray(srcSpec.output)) {
          continue
        }

        const srcOutputs = srcSpec.output
        if (srcSlotIndex < 0 || srcSlotIndex >= srcOutputs.length) {
          errors.push(
            `节点 "${nodeId}" (${classType}) 的输入 "${paramName}" 引用的上游节点 "${srcNodeId}" (${srcClassType}) 不存在槽位 [${srcSlotIndex}]（该节点仅有 ${srcOutputs.length} 个输出：[${srcOutputs.join(', ')}]）`
          )
          continue
        }

        const srcType = srcOutputs[srcSlotIndex]
        let destType = null
        if (Array.isArray(fieldDef) && typeof fieldDef[0] === 'string') {
          destType = fieldDef[0]
        }

        // 目标输入类型信息存在时校验兼容性；目标类型信息缺失视为通过
        if (destType && !areTypesCompatible(srcType, destType)) {
          errors.push(
            `节点 "${nodeId}" (${classType}) 的输入 "${paramName}" 要求类型 "${destType}"，但连接的上游节点 "${srcNodeId}" (${srcClassType}) 槽位 [${srcSlotIndex}] 类型为 "${srcType}"，类型不匹配。`
          )
        }
        continue
      }

      // 枚举字段校验
      if (Array.isArray(fieldDef) && Array.isArray(fieldDef[0])) {
        const enumValues = fieldDef[0]
        if (!enumValues.includes(paramVal)) {
          const topList = enumValues.slice(0, 20).join(', ')
          const overflow = enumValues.length > 20 ? ` ... (共 ${enumValues.length} 项)` : ''
          errors.push(
            `节点 "${nodeId}" (${classType}) 的参数 "${paramName}" 值 "${paramVal}" 无效。可选值：[${topList}${overflow}]`
          )
        }
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 读取 safetensors 文件头,提取张量组前缀信息(轻量: 只读 header JSON,不碰数据)。
 * 用于识别 checkpoint 是否内嵌 CLIP / VAE(Z-Image 类 DiT-only checkpoint 均不内嵌,
 * 必须外挂 CLIPLoader(qwen_3_4b) + VAELoader(ae))。
 */
export function readSafetensorsGroups(filePath) {
  const fd = fs.openSync(filePath, 'r')
  try {
    const lenBuf = Buffer.alloc(8)
    fs.readSync(fd, lenBuf, 0, 8, 0)
    const headerLen = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 64 * 1024 * 1024) return null
    const hb = Buffer.alloc(headerLen)
    fs.readSync(fd, hb, 0, headerLen, 8)
    const parsed = JSON.parse(hb.toString('utf8'))
    const keys = Object.keys(parsed).filter((k) => k !== '__metadata__')
    return {
      hasClip: keys.some((k) => /^(conditioner|clip|text_encoder)/i.test(k)),
      hasVae: keys.some((k) => /^(vae|first_stage_model)/i.test(k)),
      hasUnet: keys.some((k) => /^(model\.diffusion_model|diffusion_model|transformer\b|transformer\.|cap_embedder|context_refiner|final_layer)/i.test(k)),
    }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** checkpoint 拓扑缓存(按 modelsDir+文件名),避免每次构图重复读大文件头 */
const ckptTopologyCache = new Map()

/**
 * 检测 checkpoint 拓扑。返回 { ditOnly } — true 表示该 checkpoint 只含 DiT,
 * 不含文本编码器与 VAE(Z-Image 系),构图需外挂 CLIPLoader + VAELoader。
 * 文件找不到(网络盘/枚举来自服务器侧)时返回 null,由服务器侧报错兜底。
 */
function detectCheckpointTopology(modelsDirs, ckptName) {
  if (!ckptName) return null
  const cacheKey = `${Array.isArray(modelsDirs) ? modelsDirs.join('|') : modelsDirs}::${ckptName}`
  if (ckptTopologyCache.has(cacheKey)) return ckptTopologyCache.get(cacheKey)
  let result = null
  try {
    // findInLibrary 接受字符串/对象({path})/混合数组;一次性传入全部根
    const roots = Array.isArray(modelsDirs) ? modelsDirs : modelsDirs ? [modelsDirs] : []
    const found = findInLibrary(roots, ckptName, 'checkpoints')
    if (found?.found && found.fullPath) {
      const groups = readSafetensorsGroups(found.fullPath)
      if (groups) {
        result = { ditOnly: groups.hasUnet && !groups.hasClip && !groups.hasVae }
      }
    }
  } catch {}
  ckptTopologyCache.set(cacheKey, result)
  return result
}

/**
 * 从 objectInfo 解析 Z-Image 外挂件: qwen_3_4b 编码器 + ae VAE + CLIPLoader type。
 * 缺件时返回 missing 字段(调用方抛含注册表文件名的错误,触发自动补齐链路)。
 */
function resolveZImageCompanions(objectInfo) {
  const clipFiles = getEnumList(objectInfo, 'CLIPLoader', 'clip_name')
  const enc = clipFiles.find((f) => /qwen[_.\-]?3[_.\-]?4b/i.test(f))
  const vaes = getEnumList(objectInfo, 'VAELoader', 'vae_name')
  const vae = vaes.find((v) => /^ae\.safetensors$/i.test(v))
  const types = getEnumList(objectInfo, 'CLIPLoader', 'type')
  const type = ['z_image', 'qwen_image', 'stable_diffusion'].find((t) => types.includes(t))
  return { enc: enc || null, vae: vae || null, type: type || null }
}

/**
 * 归一化 LoRA 注入参数为 [{name, strength}] 列表。
 * 接受: "file.safetensors" / "file.safetensors@0.8" / {name, strength} /
 *       上述任意组成的数组。
 */
export function normalizeLoraArg(loraArg, defaultStrength = 0.8) {
  const out = []
  if (loraArg === undefined || loraArg === null || loraArg === '') return out
  const items = Array.isArray(loraArg) ? loraArg : [loraArg]
  for (const it of items) {
    if (typeof it === 'string') {
      const m = it.trim().match(/^(.+?)\s*@\s*([\d.]+)$/)
      if (m) {
        const st = parseFloat(m[2])
        out.push({ name: m[1].trim(), strength: Number.isFinite(st) ? Math.min(Math.max(st, 0), 2) : defaultStrength })
      } else if (it.trim()) {
        out.push({ name: it.trim(), strength: defaultStrength })
      }
    } else if (it && typeof it === 'object' && typeof it.name === 'string' && it.name.trim()) {
      const st = Number(it.strength)
      out.push({ name: it.name.trim(), strength: Number.isFinite(st) ? Math.min(Math.max(st, 0), 2) : defaultStrength })
    }
  }
  return out
}

/**
 * 构图：txt2img 预设（导出供回归测试直调）
 */
export function buildTxt2Img(params, objectInfo, modelsDirs) {
  const checkpoints = getEnumList(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name')
  let ckpt = params.model
  if (!ckpt) {
    ckpt = checkpoints.find((c) => /xl|flux/i.test(c)) || checkpoints[0]
  }
  if (!ckpt && checkpoints.length === 0) {
    throw new Error('ComfyUI 未检测到任何可用 checkpoint 模型，请先下载模型放入 models/checkpoints。')
  }

  const isFlux = /flux/i.test(ckpt || '')
  const isXL = /xl/i.test(ckpt || '')
  // Z-Image 拓扑检测:DiT-only checkpoint 需外挂编码器与 VAE,默认参数也按 Turbo 甜点
  const topo = detectCheckpointTopology(modelsDirs, ckpt)
  const isZImage = Boolean(topo?.ditOnly) || /z[_.\-]?image|beyondreality/i.test(ckpt || '')
  const defaultDim = isFlux || isXL || isZImage ? 1024 : 768

  const width = params.width || defaultDim
  const height = params.height || defaultDim
  const steps = params.steps || (isZImage ? 10 : isFlux ? 20 : 25)
  const cfg = params.cfg !== undefined ? params.cfg : isZImage ? 1.0 : isFlux ? 1.0 : 6.5
  const sampler = params.sampler || 'euler'
  const scheduler = params.scheduler || (isFlux || isZImage ? 'simple' : 'normal')
  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)

  let clipRef = ['1', 1]
  let vaeRef = ['1', 2]
  const zNodes = {}
  if (topo?.ditOnly) {
    const z = resolveZImageCompanions(objectInfo)
    if (!z.enc) {
      throw new Error(`未检测到 Z-Image 文本编码器: 该主模型 (${ckpt}) 不内嵌编码器,需要 qwen_3_4b_fp8_mixed.safetensors (放入 text_encoders 后经 CLIPLoader 加载)。`)
    }
    if (!z.vae) {
      throw new Error(`未检测到 Z-Image VAE: 该主模型 (${ckpt}) 不内嵌 VAE,需要 ae.safetensors (放入 vae 目录后经 VAELoader 加载)。`)
    }
    const clipInputs = { clip_name: z.enc }
    if (z.type) clipInputs.type = z.type
    zNodes[8] = { class_type: 'CLIPLoader', inputs: clipInputs }
    zNodes[9] = { class_type: 'VAELoader', inputs: { vae_name: z.vae } }
    clipRef = ['8', 0]
    vaeRef = ['9', 0]
  }

  // LoRA 注入链: LoraLoader 串接在模型与 CLIP 之后(节点号从 20 起)
  let modelRef = ['1', 0]
  let loraClipRef = clipRef
  const loraList = normalizeLoraArg(params.lora, 0.8)
  if (loraList.length > 0) {
    const loraEnum = getEnumList(objectInfo, 'LoraLoader', 'lora_name')
    for (const lr of loraList) {
      if (loraEnum.length > 0 && !loraEnum.includes(lr.name)) {
        throw new Error(`未找到 LoRA 文件: ${lr.name} (loras 目录枚举中不存在)。`)
      }
    }
    for (let i = 0; i < loraList.length; i++) {
      const id = String(20 + i)
      zNodes[id] = {
        class_type: 'LoraLoader',
        inputs: {
          lora_name: loraList[i].name,
          strength_model: loraList[i].strength,
          strength_clip: loraList[i].strength,
          model: modelRef,
          clip: loraClipRef,
        },
      }
      modelRef = [id, 0]
      loraClipRef = [id, 1]
    }
  }

  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || '', clip: loraClipRef } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: params.negative_prompt || '', clip: loraClipRef } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: params.batch_size || 1 } },
    5: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1.0,
        model: modelRef,
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: vaeRef } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: params.filename_prefix || 'ComfyUI', images: ['6', 0] } },
    ...zNodes,
  }
  return graph
}

/**
 * 构图：img2img 预设
 */
/**
 * 构图：img2img 预设（导出供回归测试直调）
 */
export function buildImg2Img(params, objectInfo, uploadedImage, modelsDirs) {
  if (!uploadedImage) {
    throw new Error('img2img 预设必须提供 image 输入图路径。')
  }
  const checkpoints = getEnumList(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name')
  let ckpt = params.model
  if (!ckpt) {
    ckpt = checkpoints.find((c) => /xl|flux/i.test(c)) || checkpoints[0]
  }

  const topo = detectCheckpointTopology(modelsDirs, ckpt)
  const isZImage = Boolean(topo?.ditOnly) || /z[_.\-]?image|beyondreality/i.test(ckpt || '')
  const isFlux = /flux/i.test(ckpt || '')
  const steps = params.steps || (isZImage ? 10 : isFlux ? 20 : 25)
  const cfg = params.cfg !== undefined ? params.cfg : isZImage ? 1.0 : isFlux ? 1.0 : 6.5
  const sampler = params.sampler || 'euler'
  const scheduler = params.scheduler || (isFlux || isZImage ? 'simple' : 'normal')
  const denoise = params.denoise !== undefined ? params.denoise : 0.65
  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)

  let clipRef = ['1', 1]
  let vaeRef = ['1', 2]
  const zNodes = {}
  if (topo?.ditOnly) {
    const z = resolveZImageCompanions(objectInfo)
    if (!z.enc) {
      throw new Error(`未检测到 Z-Image 文本编码器: 该主模型 (${ckpt}) 不内嵌编码器,需要 qwen_3_4b_fp8_mixed.safetensors (放入 text_encoders 后经 CLIPLoader 加载)。`)
    }
    if (!z.vae) {
      throw new Error(`未检测到 Z-Image VAE: 该主模型 (${ckpt}) 不内嵌 VAE,需要 ae.safetensors (放入 vae 目录后经 VAELoader 加载)。`)
    }
    const clipInputs = { clip_name: z.enc }
    if (z.type) clipInputs.type = z.type
    zNodes[9] = { class_type: 'CLIPLoader', inputs: clipInputs }
    zNodes[10] = { class_type: 'VAELoader', inputs: { vae_name: z.vae } }
    clipRef = ['9', 0]
    vaeRef = ['10', 0]
  }

  // LoRA 注入链(节点号从 20 起,与 Z-Image 外挂件不冲突)
  let modelRef = ['1', 0]
  let loraClipRef = clipRef
  const loraList = normalizeLoraArg(params.lora, 0.8)
  if (loraList.length > 0) {
    const loraEnum = getEnumList(objectInfo, 'LoraLoader', 'lora_name')
    for (const lr of loraList) {
      if (loraEnum.length > 0 && !loraEnum.includes(lr.name)) {
        throw new Error(`未找到 LoRA 文件: ${lr.name} (loras 目录枚举中不存在)。`)
      }
    }
    for (let i = 0; i < loraList.length; i++) {
      const id = String(20 + i)
      zNodes[id] = {
        class_type: 'LoraLoader',
        inputs: {
          lora_name: loraList[i].name,
          strength_model: loraList[i].strength,
          strength_clip: loraList[i].strength,
          model: modelRef,
          clip: loraClipRef,
        },
      }
      modelRef = [id, 0]
      loraClipRef = [id, 1]
    }
  }

  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || '', clip: loraClipRef } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: params.negative_prompt || '', clip: loraClipRef } },
    4: { class_type: 'LoadImage', inputs: { image: uploadedImage } },
    5: { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: vaeRef } },
    6: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise,
        model: modelRef,
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['5', 0],
      },
    },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: vaeRef } },
    8: { class_type: 'SaveImage', inputs: { filename_prefix: params.filename_prefix || 'ComfyUI', images: ['7', 0] } },
    ...zNodes,
  }
  return graph
}

/**
 * 构图：wan_t2v 预设
 */
function buildWanT2V(params, objectInfo) {
  const unets = getEnumList(objectInfo, 'UNETLoader', 'unet_name')
  const vaes = getEnumList(objectInfo, 'VAELoader', 'vae_name')
  const clips = getEnumList(objectInfo, 'CLIPLoader', 'clip_name')

  const unet = params.model || unets.find((u) => /wan[^/]*t2v/i.test(u)) || unets[0]
  const vae = vaes.find((v) => /wan.*vae/i.test(v)) || vaes[0]
  const clip = clips.find((c) => /umt5/i.test(c)) || clips[0]

  if (!unet) throw new Error('未检测到可用的 UNet 模型（用于 Wan2.1 文生视频）。')
  if (!vae) throw new Error('未检测到可用的 VAE 模型（用于 Wan2.1 文生视频）。')
  if (!clip) throw new Error('未检测到可用的 CLIP / Text Encoder 模型（用于 Wan2.1 文生视频）。')

  const clipInputs = { clip_name: clip }
  const clipLoaderInputs = { ...(objectInfo?.['CLIPLoader']?.input?.required || {}), ...(objectInfo?.['CLIPLoader']?.input?.optional || {}) }
  if ('type' in clipLoaderInputs) {
    clipInputs.type = 'wan'
  }

  const hasModelSamplingSD3 = Boolean(objectInfo?.['ModelSamplingSD3'])
  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)
  const steps = params.steps || 20
  const cfg = params.cfg !== undefined ? params.cfg : 1.0
  const sampler = params.sampler || 'euler'
  const scheduler = params.scheduler || 'simple'
  const denoise = params.denoise !== undefined ? params.denoise : 1.0

  const graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: clipInputs },
    3: { class_type: 'VAELoader', inputs: { vae_name: vae } },
  }

  let modelWire = ['1', 0]
  let nextNodeId = 4

  if (hasModelSamplingSD3) {
    graph[String(nextNodeId)] = { class_type: 'ModelSamplingSD3', inputs: { shift: 8.0, model: ['1', 0] } }
    modelWire = [String(nextNodeId), 0]
    nextNodeId++
  }

  const posId = String(nextNodeId++)
  const negId = String(nextNodeId++)
  const latentId = String(nextNodeId++)
  const samplerId = String(nextNodeId++)
  const decodeId = String(nextNodeId++)

  graph[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || '', clip: ['2', 0] } }
  graph[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negative_prompt || '', clip: ['2', 0] } }
  graph[latentId] = {
    class_type: 'EmptyHunyuanLatentVideo',
    inputs: {
      width: params.width || 832,
      height: params.height || 480,
      length: params.length || 81,
      batch_size: params.batch_size || 1,
    },
  }
  graph[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      denoise,
      model: modelWire,
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: [latentId, 0],
    },
  }
  graph[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: ['3', 0] } }

  appendAdaptiveVideoSaverTail(graph, [decodeId, 0], { ...params, fps: params.fps || 16 }, objectInfo, nextNodeId)
  return graph
}

/**
 * 构图：wan_i2v 预设
 */
function buildWanI2V(params, objectInfo, uploadedImage) {
  if (!uploadedImage) throw new Error('wan_i2v 预设必须提供 image 输入图路径。')

  const unets = getEnumList(objectInfo, 'UNETLoader', 'unet_name')
  const vaes = getEnumList(objectInfo, 'VAELoader', 'vae_name')
  const clips = getEnumList(objectInfo, 'CLIPLoader', 'clip_name')

  const unet = params.model || unets.find((u) => /wan.*(i2v|img)/i.test(u)) || unets[0]
  const vae = vaes.find((v) => /wan.*vae/i.test(v)) || vaes[0]
  const clip = clips.find((c) => /umt5/i.test(c)) || clips[0]

  if (!unet) throw new Error('未检测到可用的 Wan 图生视频 UNet 模型。')
  if (!vae) throw new Error('未检测到可用的 Wan VAE 模型。')
  if (!clip) throw new Error('未检测到可用的 Wan CLIP 模型。')

  const clipInputs = { clip_name: clip }
  const clipLoaderInputs = { ...(objectInfo?.['CLIPLoader']?.input?.required || {}), ...(objectInfo?.['CLIPLoader']?.input?.optional || {}) }
  if ('type' in clipLoaderInputs) clipInputs.type = 'wan'

  const hasModelSamplingSD3 = Boolean(objectInfo?.['ModelSamplingSD3'])
  const is720p = /720/i.test(unet || '')
  const width = params.width || (is720p ? 1280 : 832)
  const height = params.height || (is720p ? 720 : 480)
  const length = params.length || 81
  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)

  const graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: clipInputs },
    3: { class_type: 'VAELoader', inputs: { vae_name: vae } },
  }

  let modelWire = ['1', 0]
  let nextNodeId = 4

  if (hasModelSamplingSD3) {
    graph[String(nextNodeId)] = { class_type: 'ModelSamplingSD3', inputs: { shift: 8.0, model: ['1', 0] } }
    modelWire = [String(nextNodeId), 0]
    nextNodeId++
  }

  const posId = String(nextNodeId++)
  const negId = String(nextNodeId++)
  const loadImgId = String(nextNodeId++)
  const wanI2VId = String(nextNodeId++)
  const samplerId = String(nextNodeId++)
  const decodeId = String(nextNodeId++)

  graph[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || '', clip: ['2', 0] } }
  graph[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negative_prompt || '', clip: ['2', 0] } }
  graph[loadImgId] = { class_type: 'LoadImage', inputs: { image: uploadedImage } }
  graph[wanI2VId] = {
    class_type: 'WanImageToVideo',
    inputs: {
      positive: [posId, 0],
      negative: [negId, 0],
      vae: ['3', 0],
      width,
      height,
      length,
      batch_size: 1,
      start_image: [loadImgId, 0],
    },
  }
  graph[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps: params.steps || 20,
      cfg: params.cfg !== undefined ? params.cfg : 6.0,
      sampler_name: params.sampler || 'euler',
      scheduler: params.scheduler || 'simple',
      denoise: params.denoise !== undefined ? params.denoise : 1.0,
      model: modelWire,
      positive: [wanI2VId, 0],
      negative: [wanI2VId, 1],
      latent_image: [wanI2VId, 2],
    },
  }
  graph[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: ['3', 0] } }

  appendAdaptiveVideoSaverTail(graph, [decodeId, 0], { ...params, fps: params.fps || 16 }, objectInfo, nextNodeId)
  return graph
}

/**
 * 构图：wan22_ti2v 预设 (Wan2.2 TI2V-5B 极速视频生成，可选输入图)
 */
export function buildWan22TI2V(params, objectInfo, uploadedImage) {
  const unets = getEnumList(objectInfo, 'UNETLoader', 'unet_name')
  const vaes = getEnumList(objectInfo, 'VAELoader', 'vae_name')
  const clips = getEnumList(objectInfo, 'CLIPLoader', 'clip_name')
  const samplers = getEnumList(objectInfo, 'KSampler', 'sampler_name')

  const unet =
    params.model ||
    unets.find((u) => /wan2\.2.*ti2v/i.test(u)) ||
    unets.find((u) => /ti2v.*5b/i.test(u)) ||
    unets.find((u) => /5b/i.test(u)) ||
    null
  const vae =
    params.vae ||
    vaes.find((v) => /wan2\.2.*vae/i.test(v)) ||
    vaes.find((v) => /wan.*vae/i.test(v)) ||
    vaes[0]
  const clip =
    params.clip ||
    clips.find((c) => /umt5/i.test(c)) ||
    clips[0]

  if (!unet) throw new Error('未检测到可用的 Wan2.2 TI2V 模型。')
  if (!vae) throw new Error('未检测到可用的 Wan VAE 模型。')
  if (!clip) throw new Error('未检测到可用的 Wan CLIP 模型。')

  const clipInputs = { clip_name: clip }
  const clipLoaderInputs = { ...(objectInfo?.['CLIPLoader']?.input?.required || {}), ...(objectInfo?.['CLIPLoader']?.input?.optional || {}) }
  if ('type' in clipLoaderInputs) clipInputs.type = 'wan'

  const hasModelSamplingSD3 = Boolean(objectInfo?.['ModelSamplingSD3'])
  const width = params.width || 704
  const height = params.height || 1280
  const length = params.length || 121
  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)
  const shift = params.shift !== undefined ? params.shift : 5.0

  const defaultSampler = samplers.includes('euler2') ? 'euler2' : (samplers.includes('euler') ? 'euler' : samplers[0] || 'euler2')
  const sampler = params.sampler || defaultSampler
  const scheduler = params.scheduler || 'simple'
  const steps = params.steps || 30
  const cfg = params.cfg !== undefined ? params.cfg : 5.0
  const denoise = params.denoise !== undefined ? params.denoise : 1.0

  const graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: clipInputs },
    3: { class_type: 'VAELoader', inputs: { vae_name: vae } },
  }

  let modelWire = ['1', 0]
  let nextNodeId = 4

  // LoRA 注入链(LoraLoaderModelOnly,仅模型支路): 串在 UNETLoader 与 ModelSamplingSD3 之间
  const loraList = normalizeLoraArg(params.lora, 0.7)
  if (loraList.length > 0) {
    const loraEnum = getEnumList(objectInfo, 'LoraLoaderModelOnly', 'lora_name')
    for (const lr of loraList) {
      if (loraEnum.length > 0 && !loraEnum.includes(lr.name)) {
        throw new Error(`未找到 LoRA 文件: ${lr.name} (loras 目录枚举中不存在)。`)
      }
    }
    for (let i = 0; i < loraList.length; i++) {
      const id = String(20 + i)
      graph[id] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { lora_name: loraList[i].name, strength_model: loraList[i].strength, model: modelWire },
      }
      modelWire = [id, 0]
    }
  }

  if (hasModelSamplingSD3) {
    graph[String(nextNodeId)] = { class_type: 'ModelSamplingSD3', inputs: { shift, model: modelWire } }
    modelWire = [String(nextNodeId), 0]
    nextNodeId++
  }

  const posId = String(nextNodeId++)
  const negId = String(nextNodeId++)
  graph[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || '', clip: ['2', 0] } }
  graph[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negative_prompt || '', clip: ['2', 0] } }

  let loadImgId = null
  if (uploadedImage) {
    loadImgId = String(nextNodeId++)
    graph[loadImgId] = { class_type: 'LoadImage', inputs: { image: uploadedImage } }
  }

  const wan22LatentId = String(nextNodeId++)
  const latentInputs = {
    vae: ['3', 0],
    width,
    height,
    length,
    batch_size: 1,
  }
  if (loadImgId) {
    latentInputs.start_image = [loadImgId, 0]
  }

  graph[wan22LatentId] = {
    class_type: 'Wan22ImageToVideoLatent',
    inputs: latentInputs,
  }

  const samplerId = String(nextNodeId++)
  graph[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      seed,
      steps,
      cfg,
      sampler_name: sampler,
      scheduler,
      denoise,
      model: modelWire,
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: [wan22LatentId, 0],
    },
  }

  const decodeId = String(nextNodeId++)
  graph[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: ['3', 0] } }

  appendAdaptiveVideoSaverTail(
    graph,
    [decodeId, 0],
    { ...params, fps: params.fps || 24, filename_prefix: params.filename_prefix || 'wan22' },
    objectInfo,
    nextNodeId
  )

  return graph
}

/**
 * 构图：svd_img2vid 预设
 */
function buildSvd(params, objectInfo, uploadedImage) {
  if (!uploadedImage) throw new Error('svd_img2vid 预设必须提供 image 输入图路径。')

  const checkpoints = getEnumList(objectInfo, 'ImageOnlyCheckpointLoader', 'ckpt_name')
  const ckpt = params.model || checkpoints.find((c) => /svd/i.test(c)) || checkpoints[0]
  if (!ckpt) throw new Error('未检测到 SVD 模型 (ImageOnlyCheckpointLoader)。')

  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)
  const graph = {
    1: { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'LoadImage', inputs: { image: uploadedImage } },
    3: {
      class_type: 'SVD_img_to_vid_Conditioning',
      inputs: {
        clip_vision_output: ['1', 1],
        init_image: ['2', 0],
        vae: ['1', 2],
        width: params.width || 1024,
        height: params.height || 576,
        video_frames: params.length || 25,
        motion_bucket_id: params.motion_bucket_id || 127,
        fps: params.fps || 8,
        augmentation_level: params.augmentation_level !== undefined ? params.augmentation_level : 0.0,
      },
    },
    4: { class_type: 'VideoLinearCFGGuidance', inputs: { model: ['1', 0], min_cfg: 1.0 } },
    5: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: params.steps || 20,
        cfg: params.cfg !== undefined ? params.cfg : 1.0,
        sampler_name: params.sampler || 'euler',
        scheduler: params.scheduler || 'simple',
        denoise: params.denoise !== undefined ? params.denoise : 1.0,
        model: ['4', 0],
        positive: ['3', 0],
        negative: ['3', 1],
        latent_image: ['3', 2],
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  }

  appendAdaptiveVideoSaverTail(graph, ['6', 0], { ...params, fps: params.fps || 8 }, objectInfo, 7)
  return graph
}

/**
 * 构图：animatediff 预设
 */
function buildAnimateDiff(params, objectInfo) {
  const checkpoints = getEnumList(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name')
  const ckpt = params.model || checkpoints[0]
  if (!ckpt) throw new Error('未检测到任何可用 Checkpoint 模型用于 AnimateDiff。')

  const motionModels = getEnumList(objectInfo, 'ADE_AnimateDiffLoaderGen1', 'model_name')
  const motionModel = motionModels.find((m) => /animatediff|mm_sd/i.test(m)) || motionModels[0]
  if (!motionModel) {
    throw new Error('未检测到 AnimateDiff Motion Model，请检查 models/animatediff_models 目录并安装对应模型。')
  }

  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)
  const length = params.length || 16
  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: params.prompt || '', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: params.negative_prompt || '', clip: ['1', 1] } },
    4: {
      class_type: 'EmptyLatentImage',
      inputs: {
        width: params.width || 512,
        height: params.height || 512,
        batch_size: length,
      },
    },
    5: {
      class_type: 'ADE_AnimateDiffLoaderGen1',
      inputs: {
        model: ['1', 0],
        model_name: motionModel,
        context_length: 16,
      },
    },
    6: { class_type: 'VideoTriangleCFGGuidance', inputs: { model: ['5', 0], min_cfg: 1.0 } },
    7: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: params.steps || 20,
        cfg: params.cfg !== undefined ? params.cfg : 7.5,
        sampler_name: params.sampler || 'euler',
        scheduler: params.scheduler || 'normal',
        denoise: 1.0,
        model: ['6', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
  }

  appendAdaptiveVideoSaverTail(graph, ['8', 0], { ...params, fps: params.fps || 8 }, objectInfo, 9)
  return graph
}

/**
 * 构图：MiniMax H3 体系预设 (h3_t2v / h3_flf2v / h3_r2v)
 */
function buildH3Graph(preset, params, objectInfo, uploadedFirstImage, uploadedEndImage, uploadedRefImage) {
  // 1. 模型自动选择或校验
  const unets = getEnumList(objectInfo, 'UNETLoader', 'unet_name')
  let unet = params.model
  if (!unet) {
    if (preset === 'h3_r2v') {
      unet = unets.find((u) => /minimax[_-]?h3/i.test(u) && /ref2v/i.test(u)) || unets.find((u) => /minimax[_-]?h3/i.test(u))
    } else {
      unet = unets.find((u) => /minimax[_-]?h3/i.test(u) && /fl2v/i.test(u)) || unets.find((u) => /minimax[_-]?h3/i.test(u))
    }
  }
  if (!unet) {
    throw new Error(
      'ComfyUI 的 diffusion_models 里未找到 MiniMax H3 模型（需要 minimax_h3_fl2va_pruned_int8_convrot.safetensors 等，从 HuggingFace Comfy-Org/MiniMax-H3 下载）。'
    )
  }

  const clips = getEnumList(objectInfo, 'CLIPLoader', 'clip_name')
  let clip = params.text_encoder
  if (!clip) {
    clip = clips.find((c) => /qwen.*h3|h3.*qwen|minimax.*h3/i.test(c))
  }
  if (!clip) {
    throw new Error(
      'ComfyUI 的 text_encoders 里未找到 MiniMax H3 文本编码器模型（需要匹配 /qwen.*h3|h3.*qwen|minimax.*h3/i，如 qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors，从 HuggingFace Comfy-Org/MiniMax-H3 下载）。'
    )
  }

  const vaes = getEnumList(objectInfo, 'VAELoader', 'vae_name')
  const videoVae = vaes.find((v) => /minimax.*h3.*video/i.test(v))
  if (!videoVae) {
    throw new Error('ComfyUI 的 vae 里未找到 MiniMax H3 视频 VAE 模型（需要匹配 /minimax.*h3.*video/i，如 minimax_h3_video_vae_fp16.safetensors）。')
  }
  const audioVae = vaes.find((v) => /minimax.*h3.*audio/i.test(v))
  if (!audioVae) {
    throw new Error('ComfyUI 的 vae 里未找到 MiniMax H3 音频 VAE 模型（需要匹配 /minimax.*h3.*audio/i，如 minimax_h3_audio_vae_fp32.safetensors）。')
  }

  // 2. Turbo LoRA 探测与开关
  const allLoras = [
    ...getEnumList(objectInfo, 'LoraLoaderModelOnly', 'lora_name'),
    ...getEnumList(objectInfo, 'LoraLoader', 'lora_name'),
  ]
  const turboLora = allLoras.find((l) => /minimax.*h3.*(turbo|lightning)/i.test(l))

  let isTurbo = false
  if (params.turbo === true) {
    if (!turboLora) {
      throw new Error(
        '未检测到 MiniMax H3 Turbo LoRA 模型（需要匹配 /minimax.*h3.*(turbo|lightning)/i，如 minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors，可从 HuggingFace lightx2v/Minimax-h3-Turbo 下载）。'
      )
    }
    isTurbo = true
  } else if (params.turbo === false) {
    isTurbo = false
  } else {
    isTurbo = Boolean(turboLora)
  }

  // 3. 参数计算与规整
  const length = params.length || calculateH3Length(params.duration_sec ?? 5)
  const width = roundTo32(params.width, 1344)
  const height = roundTo32(params.height, 768)
  const steps = params.steps !== undefined ? params.steps : (isTurbo ? 6 : 20)
  const seed = params.seed !== undefined ? params.seed : crypto.randomInt(0, 2147483647)
  const prefix = params.filename_prefix || 'MiniMax_H3'

  // 4. 加载器与模型连线
  const clipLoaderInputs = { ...(objectInfo?.['CLIPLoader']?.input?.required || {}), ...(objectInfo?.['CLIPLoader']?.input?.optional || {}) }
  const clipInputs = { clip_name: clip }
  if ('type' in clipLoaderInputs) clipInputs.type = 'minimax'
  if (params.text_encoder_device && params.text_encoder_device !== 'default' && 'device' in clipLoaderInputs) {
    clipInputs.device = params.text_encoder_device
  }

  const graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: clipInputs },
    3: { class_type: 'VAELoader', inputs: { vae_name: videoVae } },
    4: { class_type: 'VAELoader', inputs: { vae_name: audioVae } },
  }

  let modelWire = ['1', 0]
  if (isTurbo) {
    graph['21'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        lora_name: turboLora,
        strength_model: 1.0,
        model: ['1', 0],
      },
    }
    modelWire = ['21', 0]
  }

  // 5. 条件编码节点变体
  if (preset === 'h3_t2v') {
    graph['5'] = {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['2', 0],
        vae: ['3', 0],
        prompt: params.prompt || '',
        width,
        height,
        length,
      },
    }
  } else if (preset === 'h3_flf2v') {
    const condInputs = {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: params.prompt || '',
      width,
      height,
      length,
      first_frame: ['31', 0],
    }
    graph['31'] = { class_type: 'LoadImage', inputs: { image: uploadedFirstImage } }
    if (uploadedEndImage) {
      condInputs.last_frame = ['32', 0]
      graph['32'] = { class_type: 'LoadImage', inputs: { image: uploadedEndImage } }
    }
    graph['5'] = { class_type: 'MiniMaxH3ImageToVideo', inputs: condInputs }
  } else if (preset === 'h3_r2v') {
    const r2vInputsDef = { ...(objectInfo?.['MiniMaxH3ReferenceToVideo']?.input?.required || {}), ...(objectInfo?.['MiniMaxH3ReferenceToVideo']?.input?.optional || {}) }
    const condInputs = {
      clip: ['2', 0],
      vae: ['3', 0],
      prompt: params.prompt || '',
      width,
      height,
      length,
      ref_image_size: params.ref_image_size || 'match',
      ref_image_0: ['31', 0],
    }
    if ('audio_vae' in r2vInputsDef) {
      condInputs.audio_vae = ['4', 0]
    }
    graph['31'] = { class_type: 'LoadImage', inputs: { image: uploadedRefImage } }
    graph['5'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: condInputs }
  }

  // 6. 采样骨架与视频组装尾部
  graph['6'] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
  graph['7'] = { class_type: 'BasicGuider', inputs: { model: modelWire, conditioning: ['5', 0] } }
  graph['8'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } }
  graph['9'] = { class_type: 'BasicScheduler', inputs: { model: modelWire, scheduler: 'simple', steps, denoise: 1.0 } }
  graph['10'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['6', 0],
      guider: ['7', 0],
      sampler: ['8', 0],
      sigmas: ['9', 0],
      latent_image: ['5', 1],
    },
  }
  graph['11'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } }
  graph['12'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4', 0] } }

  const cvInputsDef = { ...(objectInfo?.['CreateVideo']?.input?.required || {}), ...(objectInfo?.['CreateVideo']?.input?.optional || {}) }
  const cvInputs = { images: ['11', 0], fps: 24.0 }
  if ('audio' in cvInputsDef) {
    cvInputs.audio = ['12', 0]
  }
  graph['13'] = { class_type: 'CreateVideo', inputs: cvInputs }

  const svInputsDef = { ...(objectInfo?.['SaveVideo']?.input?.required || {}), ...(objectInfo?.['SaveVideo']?.input?.optional || {}) }
  const svInputs = { video: ['13', 0] }
  if ('filename_prefix' in svInputsDef) svInputs.filename_prefix = prefix
  else if ('path_prefix' in svInputsDef) svInputs.path_prefix = prefix

  if ('format' in svInputsDef) {
    const enumList = getEnumList(objectInfo, 'SaveVideo', 'format')
    if (enumList.length === 0 || enumList.includes('auto')) svInputs.format = 'auto'
    else svInputs.format = enumList[0]
  }
  if ('codec' in svInputsDef) {
    const enumList = getEnumList(objectInfo, 'SaveVideo', 'codec')
    if (enumList.length === 0 || enumList.includes('auto')) svInputs.codec = 'auto'
    else svInputs.codec = enumList[0]
  }
  graph['14'] = { class_type: 'SaveVideo', inputs: svInputs }

  return graph
}

/**
 * 模板所需类存在性预检
 */
function checkRequiredClassesForPreset(preset, objectInfo) {
  const reqMap = {
    txt2img: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'],
    img2img: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'LoadImage', 'VAEEncode', 'KSampler', 'VAEDecode', 'SaveImage'],
    wan_t2v: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'EmptyHunyuanLatentVideo', 'KSampler', 'VAEDecode'],
    wan_i2v: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'LoadImage', 'WanImageToVideo', 'KSampler', 'VAEDecode'],
    wan22_ti2v: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'Wan22ImageToVideoLatent', 'KSampler', 'VAEDecode'],
    svd_img2vid: ['ImageOnlyCheckpointLoader', 'LoadImage', 'SVD_img_to_vid_Conditioning', 'VideoLinearCFGGuidance', 'KSampler', 'VAEDecode'],
    animatediff: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'ADE_AnimateDiffLoaderGen1', 'VideoTriangleCFGGuidance', 'KSampler', 'VAEDecode'],
    h3_t2v: [
      'UNETLoader',
      'CLIPLoader',
      'VAELoader',
      'MiniMaxH3ImageToVideo',
      'RandomNoise',
      'BasicGuider',
      'KSamplerSelect',
      'BasicScheduler',
      'SamplerCustomAdvanced',
      'VAEDecode',
      'VAEDecodeAudio',
      'CreateVideo',
      'SaveVideo',
    ],
    h3_flf2v: [
      'UNETLoader',
      'CLIPLoader',
      'VAELoader',
      'MiniMaxH3ImageToVideo',
      'LoadImage',
      'RandomNoise',
      'BasicGuider',
      'KSamplerSelect',
      'BasicScheduler',
      'SamplerCustomAdvanced',
      'VAEDecode',
      'VAEDecodeAudio',
      'CreateVideo',
      'SaveVideo',
    ],
    h3_r2v: [
      'UNETLoader',
      'CLIPLoader',
      'VAELoader',
      'MiniMaxH3ReferenceToVideo',
      'LoadImage',
      'RandomNoise',
      'BasicGuider',
      'KSamplerSelect',
      'BasicScheduler',
      'SamplerCustomAdvanced',
      'VAEDecode',
      'VAEDecodeAudio',
      'CreateVideo',
      'SaveVideo',
    ],
  }

  const req = reqMap[preset] || []
  const missing = req.filter((cls) => !objectInfo?.[cls])
  return missing
}

// ── 产物下载与保存 ───────────────────────────────────────────────────────────

/**
 * 从 /history 结果中提取所有产物，通过 /view 下载到工作区
 */
async function downloadAndSaveOutputs(client, promptId, historyOutputs, outputsDirRoot, workspaceRoot, execSignal) {
  const ts = formatTimestamp(new Date())
  const folderName = `${ts}-${promptId.slice(0, 8)}`
  const runDirAbs = path.join(outputsDirRoot, folderName)

  fs.mkdirSync(runDirAbs, { recursive: true })

  const savedOutputs = []

  for (const [nodeId, nodeOutput] of Object.entries(historyOutputs || {})) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue
    for (const val of Object.values(nodeOutput)) {
      if (!Array.isArray(val)) continue
      for (const item of val) {
        if (!item || typeof item !== 'object' || !item.filename) continue

        const filename = item.filename
        const subfolder = item.subfolder || ''
        const type = item.type || 'output'

        const viewPath = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`
        const res = await client.request(viewPath, {}, execSignal)
        if (!res.ok) {
          throw new Error(`下载产物文件 ${filename} 失败 (HTTP ${res.status})`)
        }

        const buf = Buffer.from(await res.arrayBuffer())
        const targetAbs = path.join(runDirAbs, filename)
        fs.writeFileSync(targetAbs, buf)

        const savedPath = path.relative(workspaceRoot, targetAbs).replace(/\\/g, '/')
        const effectivePrefix = client.apiPrefix || ''
        const viewUrl = `${client.baseUrl}${effectivePrefix}${viewPath}`

        savedOutputs.push({
          node: nodeId,
          filename,
          subfolder,
          type,
          savedPath,
          absPath: targetAbs,
          url: viewUrl,
          kind: classifyKind(filename),
        })
      }
    }
  }

  return { runDirAbs, savedOutputs }
}

/**
 * 从 DSH 会话存储目录反推最近活跃会话的工作目录。
 * 原理:插件常挂载在 host 根作用域,看不到会话作用域的 sandboxPolicy 服务;
 * 但 sessions/<项目键>/<会话id>/session.jsonl.zstd 的首行 session 头记录了该会话
 * 的 cwd。取 mtime 最新的会话文件(zstd 解压首行)即调用方工作区。
 * @param {string} sessionsRoot - dsh-home 下的 sessions 目录
 * @returns {string|null} 工作区绝对路径,失败返回 null
 */
export function inferWorkspaceFromSessions(sessionsRoot) {
  if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return null
  let newest = null
  for (const projDir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!projDir.isDirectory()) continue
    const projPath = path.join(sessionsRoot, projDir.name)
    for (const sessDir of fs.readdirSync(projPath, { withFileTypes: true })) {
      if (!sessDir.isDirectory()) continue
      const jl = path.join(projPath, sessDir.name, 'session.jsonl.zstd')
      try {
        const st = fs.statSync(jl)
        if (st.size > 0 && (!newest || st.mtimeMs > newest.mtimeMs)) {
          newest = { file: jl, mtimeMs: st.mtimeMs }
        }
      } catch {}
    }
  }
  if (!newest) return null
  const buf = fs.readFileSync(newest.file)
  const out = zlib.zstdDecompressSync(buf)
  const head = out.toString('utf8', 0, 8192)
  const firstLine = head.split('\n', 1)[0]
  const parsed = JSON.parse(firstLine)
  if (parsed?.type === 'session' && typeof parsed.cwd === 'string' && path.isAbsolute(parsed.cwd) && fs.existsSync(parsed.cwd)) {
    return parsed.cwd
  }
  return null
}

/**
 * 归一化 HuggingFace 来源链接(参照 Stability Matrix 的 TryParseRepoId 思路):
 *   - "hf:Owner/Repo/仓库内文件路径"           → hf-mirror resolve 直链
 *   - huggingface.co/{repo}/blob/{rev}/{file}   → hf-mirror resolve 直链(国内可达)
 *   - huggingface.co/{repo}/resolve/{rev}/{file}→ 同上
 * 其余 URL 原样返回(null 表示不是 HF 链接)。
 * @param {string} u
 * @returns {string|null}
 */
export function normalizeHfSource(u) {
  const s = String(u || '').trim()
  if (!s) return null
  let m = s.match(/^hf:\s*([^/\s]+\/[^/\s]+)\/(.+)$/i)
  if (m) return `https://hf-mirror.com/${m[1]}/resolve/main/${m[2]}`
  m = s.match(/^https?:\/\/(?:www\.)?huggingface\.co\/([^/\s]+\/[^/\s]+)\/(?:blob|resolve)\/([^/\s]+)\/(\S+?)(?:\?|#|$)/i)
  if (m) return `https://hf-mirror.com/${m[1]}/resolve/${m[2]}/${m[3]}`
  return null
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const entryConfig = typeof config === 'object' && config !== null ? config : {}
  const client = new ComfyClient(entryConfig)

  // 会话工作区反推缓存:同一进程内会话切换罕见,60s TTL 足够
  let inferredWorkspaceCache = { value: null, at: 0 }

  const getWorkspaceRoot = () => {
    // 1. 显式配置的绝对路径(最优先,cordis.patch.yml config.workspaceRoot)
    if (typeof entryConfig.workspaceRoot === 'string' && path.isAbsolute(entryConfig.workspaceRoot)) {
      return entryConfig.workspaceRoot
    }
    // 2. 会话作用域可见的 sandboxPolicy 服务(预设级挂载 / 测试 stub)
    try {
      const sp = ctx.get?.('sandboxPolicy')
      if (sp?.workspaceRoot) return sp.workspaceRoot
    } catch {}
    // 3. 最近活跃会话反推(host 根作用域挂载的通用可靠途径)
    const now = Date.now()
    if (!inferredWorkspaceCache.value || now - inferredWorkspaceCache.at >= 60000) {
      let result = null
      try {
        const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
        result = inferWorkspaceFromSessions(path.join(dshHome, 'sessions'))
      } catch {
        // zstd 不可用(Node < 22.15)或会话存储结构变化:静默降级
      }
      inferredWorkspaceCache = { value: result, at: now }
    }
    if (inferredWorkspaceCache.value) return inferredWorkspaceCache.value
    // 4. 兜底(产物会落到后端进程 cwd,仅在前三者全失败时)
    return process.cwd()
  }

  const resolveOutputDir = (dirArg) => {
    const raw = dirArg || entryConfig.outputsDir || DEFAULT_OUTPUTS_DIR
    const ws = getWorkspaceRoot()
    return path.isAbsolute(raw) ? raw : path.resolve(ws, raw)
  }

  // ── 工具 1: comfyui_status ─────────────────────────────────────────────────
  const statusTool = {
    name: 'comfyui_status',
    description: '检查 ComfyUI 服务器运行状态、版本、显卡设备（VRAM 剩余/总量）及队列任务情况。排查连接与服务可用性时优先调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) {
          const lines = [`⚠ ComfyUI 连接失败 (${client.baseUrl})`]
          if (v.installed && v.installPaths?.length > 0) {
            lines.push(`💡 检测到本地已有 ComfyUI 安装:`)
            lines.push(`· 路径: ${v.installPaths[0].root}`)
            lines.push(`· 启动建议: ${v.installPaths[0].startHint}`)
          } else if (v.installOffer?.viable) {
            lines.push(`✨ 本地未安装 ComfyUI，但当前设备配置达标:`)
            lines.push(`· 设备: ${v.device?.gpuName || 'GPU'} / ${v.device?.vramGB || '?'}GB 显存 / ${v.device?.ramGB || '?'}GB 内存`)
            lines.push(`· 推荐安装盘: ${v.installOffer.targetDriveHint || 'D:'}\\ComfyUI`)
            lines.push(`💡 建议: 可使用 comfyui_install 工具一键安装官方便携版（调用前请先向用户征得确认）。`)
          } else if (v.installOffer && !v.installOffer.viable) {
            lines.push(`⚠ 设备不满足本地运行 ComfyUI 的最低门槛:`)
            for (const b of v.installOffer.blockers || []) {
              lines.push(`· ${b}`)
            }
          }
          if (v.recommendation) {
            lines.push(`\n详细建议: ${v.recommendation}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [
          `ComfyUI 状态: 正常运行 (${client.baseUrl}) [bridge v8]`,
          `版本: ${v.version || '未知'}${v.pytorch_version ? ` | PyTorch ${v.pytorch_version}` : ''}${v.python_version ? ` | Python ${v.python_version}` : ''}`,
        ]
        if (v.discovery?.primary) {
          lines.push(`模型库目录: ${v.discovery.primary} (来源: ${v.discovery.source || '未知'}${v.discovery.roots?.length > 1 ? `，共发现 ${v.discovery.roots.length} 个库` : ''})`)
        }
        if (Array.isArray(v.devices) && v.devices.length > 0) {
          lines.push('计算设备 / 显卡:')
          for (const d of v.devices) {
            const freeGb = d.vram_free ? (d.vram_free / (1024 * 1024 * 1024)).toFixed(2) : '?'
            const totalGb = d.vram_total ? (d.vram_total / (1024 * 1024 * 1024)).toFixed(2) : '?'
            lines.push(`· ${d.name || 'Device'} (${d.torch_dev || d.type || 'gpu'}): 显存剩余 ${freeGb} GB / ${totalGb} GB`)
          }
        }
        lines.push(`任务队列: 运行中 ${v.queue?.running ?? 0} 个，等待中 ${v.queue?.pending ?? 0} 个`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      try {
        const statsRes = await client.requestJson('/system_stats', {}, exec?.signal)
        if (!statsRes.ok) {
          const assessment = assessComfyUIStatus(entryConfig.__installerOptions || {})
          return {
            ok: false,
            reachable: false,
            error: `ComfyUI 返回 HTTP ${statsRes.status}`,
            hint: `请检查 ComfyUI 服务是否正常响应 (${client.baseUrl})。`,
            installed: assessment.installed,
            installPaths: assessment.installPaths,
            device: assessment.device,
            recommendation: assessment.recommendation,
            suggestedAction: assessment.suggestedAction,
            installOffer: assessment.installOffer,
          }
        }

        let queueData = { queue_running: [], queue_pending: [] }
        try {
          const qRes = await client.requestJson('/queue', {}, exec?.signal)
          if (qRes.ok) queueData = qRes.data
        } catch {
          // 队列获取失败降级为空
        }

        const sys = statsRes.data?.system || {}
        const devices = (statsRes.data?.devices || []).map((d) => ({
          name: d.name,
          type: d.type,
          vram_total: d.vram_total,
          vram_free: d.vram_free,
          torch_dev: d.torch_device_name || d.device || d.type,
        }))

        // 模型库多根自动发现
        let discovery = null
        try {
          discovery = resolveModelsDirs({
            configModelsDir: entryConfig.modelsDir,
            force: false,
          })
        } catch {}

        return {
          ok: true,
          reachable: true,
          version: sys.comfyui_version || 'unknown',
          python_version: sys.python_version ?? null,
          pytorch_version: sys.pytorch_version ?? null,
          devices,
          discovery: discovery
            ? {
                roots: discovery.roots,
                primary: discovery.primary,
                source: discovery.source,
                extraPaths: discovery.extraPaths,
              }
            : null,
          queue: {
            running: (queueData.queue_running || []).length,
            pending: (queueData.queue_pending || []).length,
          },
          apiNote: client.apiPrefix ? `工作在前缀模式 (${client.apiPrefix})` : '标准根路径',
        }
      } catch (err) {
        const assessment = assessComfyUIStatus(entryConfig.__installerOptions || {})
        return {
          ok: false,
          reachable: false,
          error: String((err && err.message) || err),
          hint: `ComfyUI 无法访问 (${client.baseUrl})。请确认 ComfyUI 是否在运行，或检查 cordis.patch.yml 中的 baseUrl 配置。`,
          installed: assessment.installed,
          installPaths: assessment.installPaths,
          device: assessment.device,
          recommendation: assessment.recommendation,
          suggestedAction: assessment.suggestedAction,
          installOffer: assessment.installOffer,
        }
      }
    },
  }

  // ── 工具 2: comfyui_models ──────────────────────────────────────────────────
  const modelsTool = {
    name: 'comfyui_models',
    description: '枚举 ComfyUI 当前已加载的模型列表（checkpoints/unets/vaes/loras/upscalers/clip）并探测视频生成节点支持情况。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        folder: {
          type: 'string',
          enum: ['checkpoints', 'vaes', 'loras', 'unets', 'upscalers', 'clip', 'all'],
          description: '要查询的模型文件夹/类别。默认为 all。',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) {
          return [{ type: 'text', text: `⚠ 模型列表获取失败: ${v.error || '未知错误'}` }]
        }
        const lines = ['ComfyUI 模型与能力快照:']
        for (const [cat, data] of Object.entries(v.models || {})) {
          if (data.available === false) {
            lines.push(`· ${cat}: 不可用 (未安装对应 Loader 节点)`)
          } else {
            const list = data.items || []
            const preview = list.slice(0, 5).join(', ')
            const more = list.length > 5 ? ` ... (共 ${data.total} 项)` : ''
            lines.push(`· ${cat} (${list.length}/${data.total}): ${preview || '(空)'}${more}`)
          }
        }
        if (v.videoCaps) {
          lines.push('视频生成能力支持:')
          lines.push(`· 核心 SaveVideo: ${v.videoCaps.saveVideo ? '可用' : '未检测到'}`)
          lines.push(`· SaveWEBM: ${v.videoCaps.saveWEBM ? '可用' : '未检测到'}`)
          lines.push(`· SaveAnimatedWEBM: ${v.videoCaps.saveAnimatedWEBM ? '可用' : '未检测到'}`)
          lines.push(`· SaveAnimatedPNG: ${v.videoCaps.saveAnimatedPNG ? '可用' : '未检测到'}`)
          lines.push(`· Wan2.1 视频节点: ${v.videoCaps.wanNodes ? '已就绪' : '缺失'}`)
          lines.push(`· Wan2.2 视频节点: ${v.videoCaps.wan22Nodes ? '已就绪' : '缺失'}`)
          lines.push(`· SVD 视频节点: ${v.videoCaps.svd ? '已就绪' : '缺失'}`)
          lines.push(`· AnimateDiff 节点: ${v.videoCaps.animateDiff ? '已就绪' : '缺失'}`)
          lines.push(`· MiniMax H3 节点: ${v.videoCaps.minimaxH3 ? '已就绪' : '缺失'}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      try {
        const folder = args?.folder || 'all'
        const objectInfo = await client.getObjectInfo(exec?.signal)

        const categoryDefs = {
          checkpoints: { node: 'CheckpointLoaderSimple', field: 'ckpt_name' },
          vaes: { node: 'VAELoader', field: 'vae_name' },
          loras: { node: 'LoraLoader', field: 'lora_name' },
          unets: { node: 'UNETLoader', field: 'unet_name' },
          upscalers: { node: 'UpscaleModelLoader', field: 'model_name' },
          clip: { node: 'CLIPLoader', field: 'clip_name' },
        }

        const models = {}
        const targetCats = folder === 'all' ? Object.keys(categoryDefs) : [folder]

        for (const cat of targetCats) {
          const def = categoryDefs[cat]
          if (!def) continue
          const cls = objectInfo?.[def.node]
          if (!cls) {
            models[cat] = { available: false, total: 0, items: [] }
            continue
          }
          const items = getEnumList(objectInfo, def.node, def.field)
          models[cat] = {
            available: true,
            total: items.length,
            items: items.slice(0, 80),
          }
        }

        const videoCaps = detectVideoCaps(objectInfo)

        return {
          ok: true,
          models,
          videoCaps,
          cached: Date.now() - client.objectInfoCacheTime > 100,
        }
      } catch (err) {
        return {
          ok: false,
          error: String((err && err.message) || err),
          hint: '无法获取模型列表。请检查 ComfyUI 是否运行且网络通畅。',
        }
      }
    },
  }

  // ── 工具 3: comfyui_generate ────────────────────────────────────────────────
  const generateTool = {
    name: 'comfyui_generate',
    description:
      '核心生图生视频工具。支持 preset 预设模式（txt2img/img2img/wan_t2v/wan_i2v/svd_img2vid/animatediff/h3_t2v/h3_flf2v/h3_r2v）与 workflow 逃生舱模式。产物自动下载至工作区。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        mode: { type: 'string', enum: ['preset', 'workflow'], description: '模式，默认 preset。' },
        preset: {
          type: 'string',
          enum: ['txt2img', 'img2img', 'wan_t2v', 'wan_i2v', 'wan22_ti2v', 'svd_img2vid', 'animatediff', 'h3_t2v', 'h3_flf2v', 'h3_r2v'],
          description:
            '预设模板名称（preset 模式必填）。wan22_ti2v: Wan2.2 TI2V-5B 极速生视频（可选输入图）；h3_t2v: MiniMax H3 文生视频；h3_flf2v: MiniMax H3 首尾帧生视频；h3_r2v: MiniMax H3 参考图生视频。',
        },
        prompt: { type: 'string', description: '正向提示词。MiniMax H3 推荐包含场景描绘、镜头运动与音频的一体化提示词。' },
        negative_prompt: { type: 'string', description: '负向提示词。' },
        model: { type: 'string', description: '指定 checkpoint 或 UNet 模型文件名。缺省自动选择。' },
        text_encoder: {
          type: 'string',
          description: '指定文本编码器模型文件名（h3_* 预设专用，覆盖自动选择，如社区量化版或去审查版；必须精确匹配 text_encoders 枚举名）。',
        },
        text_encoder_device: {
          type: 'string',
          enum: ['default', 'cpu'],
          description: '文本编码器运行设备（h3_* 预设专用，可选 default 或 cpu，默认 default；小显存配置可设为 cpu 将 ~14GB Qwen3-VL 编码器固定在 CPU 内存，节省显存供 DiT 生成）。',
        },
        image: { type: 'string', description: '输入图路径（img2img / wan_i2v / wan22_ti2v可选首帧 / svd / h3_flf2v首帧 / h3_r2v参考图，相对工作区或绝对路径，自动上传）。' },
        end_image: { type: 'string', description: '尾帧输入图路径（h3_flf2v 预设可选，指定视频最后一帧）。' },
        duration_sec: { type: 'number', description: '视频时长秒数（MiniMax H3 专用，默认 5 秒；自动按 24fps 步进取模对齐帧数）。' },
        turbo: { type: 'boolean', description: '是否启用 Turbo 8-step 加速 LoRA（MiniMax H3 专用；缺省自动探测）。' },
        ref_image_size: { type: 'string', enum: ['match', 'max'], description: '参考图尺寸处理策略（h3_r2v 专用，默认 match）。' },
        width: { type: 'integer', description: '图片或视频宽度。' },
        height: { type: 'integer', description: '图片或视频高度。' },
        steps: { type: 'integer', description: '采样步数。' },
        cfg: { type: 'number', description: 'CFG 强度。' },
        seed: { type: 'integer', description: '随机种子，缺省随机。' },
        sampler: { type: 'string', description: '采样器名称（如 euler、euler2、dpmpp_2m、res_multistep）。' },
        scheduler: { type: 'string', description: '调度器名称（如 normal、simple、karras）。' },
        denoise: { type: 'number', description: '重绘幅度 / 去噪强度（0-1，img2img 默认 0.65，其余 1.0）。' },
        batch_size: { type: 'integer', description: '生成批次数量，默认 1。' },
        length: { type: 'integer', description: '视频帧数（wan 默认 81，wan22 默认 121，svd 25，animatediff 16；H3 默认依据 duration_sec 换算）。' },
        fps: { type: 'integer', description: '视频输出帧率（wan 默认 16，wan22 默认 24，svd 8，H3 默认 24）。' },
        motion_bucket_id: { type: 'integer', description: 'SVD 运动幅度 (1-255，默认 127)。' },
        augmentation_level: { type: 'number', description: 'SVD 噪点补充程度 (默认 0.0)。' },
        extract_frames: {
          type: 'boolean',
          description: '视频生成完成后是否调用 ffmpeg 抽取首/中/尾关键帧用于多模态质检，默认 true。若系统未安装 ffmpeg 将静默跳过。',
        },
        workflow: {
          description: '自定义 API 格式的工作流图对象或 JSON 字符串（mode=workflow 必填）。',
        },
        overrides: {
          type: 'object',
          description: '深度合并进最终图的节点参数字典形如 { nodeId: { field: val } } 或 { nodeId: { inputs: { field: val } } }。',
        },
        wait: { type: 'boolean', description: '是否等待执行完成并自动下载，默认 true。若 false 则只提交返回 prompt_id。' },
        timeout_sec: { type: 'integer', description: '等待超时秒数（10-3600，默认 1800）。' },
        output_dir: { type: 'string', description: '本次生成输出子目录覆盖。' },
        filename_prefix: { type: 'string', description: '保存文件名前缀。' },
        lora: {
          description:
            'LoRA 注入(txt2img / img2img / wan22_ti2v 预设)。接受 "file.safetensors"、"file.safetensors@0.8"(权重语法)、{name,strength} 对象或其数组(多 LoRA 链式叠加)。txt2img/img2img 走 LoraLoader(模型+CLIP,默认权重 0.8),wan22_ti2v 走 LoraLoaderModelOnly(仅模型,默认 0.7)。如 lora: "kuroinu_pony_chloe.safetensors@0.8"。',
        },
        auto_fetch_models: {
          type: 'boolean',
          description: '预设生成时若检测到本地缺失特定模型（且在已知模型注册表内），是否自动从镜像源断点续传下载至用户模型库对应子目录，默认 false。',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) {
          if (v.blocked) {
            const adviceLines = (v.advice || []).map((a) => `  - ${a}`).join('\n')
            return [
              {
                type: 'text',
                text: `🛑 设备能力守卫主动拦截:\n${v.error || v.reason}${adviceLines ? '\n\n建议:\n' + adviceLines : ''}`,
              },
            ]
          }
          if (v.status === 'MODEL_MISSING') {
            return [
              {
                type: 'text',
                text: `⚠ 本地缺少必要模型 [MODEL_MISSING]: ${v.error}\n缺失模型: ${v.missingModel}\n建议操作: ${v.suggestion || '请下载模型并放入模型库相应子目录'}`,
              },
            ]
          }
          const detail = v.traceback ? `\n\n回溯栈 (前/尾摘要):\n${v.traceback}` : ''
          return [
            {
              type: 'text',
              text: `⚠ 生成失败 [${v.status || 'ERROR'}]: ${v.error || '未知错误'}${v.note ? '\n提示: ' + v.note : ''}${detail}`,
            },
          ]
        }
        if (v.wait === false) {
          return [
            {
              type: 'text',
              text: `任务已提交 (ID: ${v.prompt_id})\n队列位置: 运行中 ${v.queuePos?.running ?? 0}，等待中 ${v.queuePos?.pending ?? 0}\n提示: ${v.note || '请使用 comfyui_history(prompt_id) 稍后收取产物'}`,
            },
          ]
        }
        const lines = [`生成完成 (ID: ${v.prompt_id}，耗时: ${v.elapsedSec || 0}s):`]
        if (v.auto_dims) {
          lines.push(`· 🎯 画幅自适应: ${v.auto_dims}`)
        }
        for (const out of v.outputs || []) {
          lines.push(`· [${out.kind}] ${out.savedPath}`)
        }
        if (Array.isArray(v.qc_frames) && v.qc_frames.length > 0) {
          lines.push(`· 🎬 关键帧抽帧: 已提取 ${v.qc_frames.length} 张质检图 (${v.qc_frames.map((f) => f.relPath).join(', ')})`)
          lines.push('  提示: 可直接使用 read_image 进行多模态生成质量验收。')
        }
        if (Array.isArray(v.warnings) && v.warnings.length > 0) {
          lines.push(`· ⚠ 设备能力提示: ${v.warnings.join('; ')}`)
        }
        lines.push('图片可直接使用 read_image 查看；请在回答中向用户完整引用上述相对产物路径。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      try {
        // 浅拷贝成可变副本:工具框架可能传入冻结的 args 对象,
        // 而自动画幅判定等步骤需要往 rawArgs 上补 width/height 属性
        const rawArgs = { ...(args || {}) }
        const mode = rawArgs.mode || 'preset'
        const workspaceRoot = getWorkspaceRoot()

        // 1. 获取全量 object_info 准备构图与预校验
        let objectInfo = await client.getObjectInfo(exec?.signal)

        // 2. 设备能力守卫预检
        let capCheck = null
        try {
          const devStats = await probeDevice(client, exec?.signal)
          let modelsDirForEst = entryConfig.modelsDir || process.env.COMFYUI_MODELS_DIR
          try {
            const disc = resolveModelsDirs({ configModelsDir: entryConfig.modelsDir })
            if (disc.roots?.length > 0) modelsDirForEst = disc.roots
          } catch {}
          const est = estimate(mode === 'preset' ? rawArgs.preset : 'workflow', rawArgs, objectInfo, modelsDirForEst)
          capCheck = check({ preset: rawArgs.preset, params: rawArgs, estimate: est }, devStats)
        } catch {
          // 状态获取失败容错，不阻断执行
        }

        if (capCheck && capCheck.verdict === 'blocked') {
          return {
            ok: false,
            status: 'DEVICE_RESOURCE_BLOCKED',
            blocked: true,
            verdict: 'blocked',
            reason: capCheck.message,
            advice: capCheck.advice,
            error: `设备能力守卫主动拦截: ${capCheck.message}`,
          }
        }

        // 3. 素材画幅与分辨率自适应检测
        let autoDimsNote = null
        if (rawArgs.image && ['wan_i2v', 'wan22_ti2v', 'svd_img2vid', 'img2img', 'animatediff'].includes(rawArgs.preset)) {
          const resolved = resolveAutoDimensions(rawArgs.preset, rawArgs.image, rawArgs.width, rawArgs.height, workspaceRoot)
          if (resolved.autoSelected) {
            rawArgs.width = resolved.width
            rawArgs.height = resolved.height
            autoDimsNote = resolved.note
          }
        }

        let graph = null

        // 上传辅助函数
        const uploadImageFile = async (imgArg) => {
          const imgPath = path.isAbsolute(imgArg) ? imgArg : path.resolve(workspaceRoot, imgArg)
          if (!fs.existsSync(imgPath)) {
            throw new Error(`输入图片文件不存在: ${imgPath}`)
          }
          const fileBytes = fs.readFileSync(imgPath)
          const baseName = path.basename(imgPath)

          const fd = new FormData()
          fd.append('image', new Blob([fileBytes]), baseName)
          fd.append('overwrite', 'true')
          fd.append('type', 'input')

          const uploadRes = await client.requestJson('/upload/image', { method: 'POST', body: fd }, exec?.signal)
          if (!uploadRes.ok) {
            throw new Error(`输入图片上传至 ComfyUI 失败 (HTTP ${uploadRes.status})`)
          }
          const uData = uploadRes.data || {}
          const uploadedName = uData.subfolder ? `${uData.subfolder}/${uData.name}` : uData.name

          // 上传发生在 objectInfo 枚举抓取之后——把新文件名补进 LoadImage 的
          // image 枚举,否则第 4 步预校验会对着旧枚举误报"值无效"。
          // 注意:字段值是 [枚举列表, 选项对象] 的字段规格,要补的是第一层。
          try {
            const liField = objectInfo?.LoadImage?.input?.required?.image
            if (Array.isArray(liField) && Array.isArray(liField[0]) && !liField[0].includes(uploadedName)) {
              liField[0].push(uploadedName)
            }
          } catch {}

          return uploadedName
        }

        // 4. 构图
        if (mode === 'preset') {
          const preset = rawArgs.preset
          if (!preset) {
            return {
              ok: false,
              status: 'BAD_ARGS',
              error: 'preset 模式下必须指定 preset 参数。',
            }
          }

          // 检查该 preset 核心依赖类是否存在
          const missingClasses = checkRequiredClassesForPreset(preset, objectInfo)
          if (missingClasses.length > 0) {
            if (preset.startsWith('h3_')) {
              return {
                ok: false,
                status: 'MISSING_NODES',
                error: `当前安装的 ComfyUI 版本过旧，缺少 MiniMax H3 所需的节点类: [${missingClasses.join(', ')}]。请将 ComfyUI 更新至最新版本以支持 MiniMax H3。`,
              }
            }
            return {
              ok: false,
              status: 'MISSING_NODES',
              error: `预设 "${preset}" 所需的核心节点类缺失: [${missingClasses.join(', ')}]。请在 ComfyUI 安装对应扩展节点。`,
            }
          }

          // 处理输入图自动上传
          let uploadedImageName = null
          let uploadedFirstImage = null
          let uploadedEndImage = null
          let uploadedRefImage = null

          if (['img2img', 'wan_i2v', 'svd_img2vid'].includes(preset)) {
            if (!rawArgs.image) {
              return { ok: false, status: 'BAD_ARGS', error: `预设 "${preset}" 必须提供 image 输入图路径。` }
            }
            try {
              uploadedImageName = await uploadImageFile(rawArgs.image)
            } catch (err) {
              return { ok: false, status: 'UPLOAD_FAILED', error: err.message }
            }
          } else if (preset === 'wan22_ti2v') {
            if (rawArgs.image) {
              try {
                uploadedImageName = await uploadImageFile(rawArgs.image)
              } catch (err) {
                return { ok: false, status: 'UPLOAD_FAILED', error: err.message }
              }
            }
          } else if (preset === 'h3_flf2v') {
            if (!rawArgs.image) {
              return { ok: false, status: 'BAD_ARGS', error: 'h3_flf2v 预设必须提供 image 作为首帧图片。' }
            }
            try {
              uploadedFirstImage = await uploadImageFile(rawArgs.image)
              if (rawArgs.end_image) {
                uploadedEndImage = await uploadImageFile(rawArgs.end_image)
              }
            } catch (err) {
              return { ok: false, status: 'UPLOAD_FAILED', error: err.message }
            }
          } else if (preset === 'h3_r2v') {
            if (!rawArgs.image) {
              return { ok: false, status: 'BAD_ARGS', error: 'h3_r2v 预设必须提供 image 作为参考图。' }
            }
            try {
              uploadedRefImage = await uploadImageFile(rawArgs.image)
            } catch (err) {
              return { ok: false, status: 'UPLOAD_FAILED', error: err.message }
            }
          }

          // 模型库根(config 优先,秒回;供 Z-Image 拓扑检测读取 checkpoint 文件头)
          let genModelsDirs = []
          try {
            const disc = resolveModelsDirs({ configModelsDir: entryConfig.modelsDir, force: false })
            genModelsDirs = disc?.roots || []
          } catch {}

          // 辅助构图闭包
          const buildGraphForPreset = (p, currentObjectInfo) => {
            switch (p) {
              case 'txt2img':
                return buildTxt2Img(rawArgs, currentObjectInfo, genModelsDirs)
              case 'img2img':
                return buildImg2Img(rawArgs, currentObjectInfo, uploadedImageName, genModelsDirs)
              case 'wan_t2v':
                return buildWanT2V(rawArgs, currentObjectInfo)
              case 'wan_i2v':
                return buildWanI2V(rawArgs, currentObjectInfo, uploadedImageName)
              case 'wan22_ti2v':
                return buildWan22TI2V(rawArgs, currentObjectInfo, uploadedImageName)
              case 'svd_img2vid':
                return buildSvd(rawArgs, currentObjectInfo, uploadedImageName)
              case 'animatediff':
                return buildAnimateDiff(rawArgs, currentObjectInfo)
              case 'h3_t2v':
              case 'h3_flf2v':
              case 'h3_r2v':
                return buildH3Graph(p, rawArgs, currentObjectInfo, uploadedFirstImage, uploadedEndImage, uploadedRefImage)
              default:
                throw new Error(`不支持的预设模板: ${p}`)
            }
          }

          // 解析预设可能缺失的已知核心模型文件名
          const deduceMissingModelName = (p, errMessage) => {
            const msg = String(errMessage || '')
            if (p === 'txt2img' || p === 'img2img') {
              if (msg.includes('Z-Image 文本编码器')) return 'qwen_3_4b_fp8_mixed.safetensors'
              if (msg.includes('Z-Image VAE')) return 'ae.safetensors'
            }
            if (p === 'wan22_ti2v') {
              if (msg.includes('TI2V') || msg.includes('UNet')) return 'wan2.2_ti2v_5B_fp16.safetensors'
              if (msg.includes('VAE')) return 'wan2.2_vae.safetensors'
              if (msg.includes('CLIP') || msg.includes('Text Encoder')) return 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
            }
            if (p === 'wan_t2v') {
              if (msg.includes('UNet')) return 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors'
              if (msg.includes('VAE')) return 'wan_2.1_vae.safetensors'
              if (msg.includes('CLIP')) return 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
            }
            if (p === 'wan_i2v') {
              if (msg.includes('UNet')) return 'wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors'
              if (msg.includes('VAE')) return 'wan_2.1_vae.safetensors'
              if (msg.includes('CLIP')) return 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
            }
            if (p.startsWith('h3_')) {
              if (msg.includes('Turbo LoRA')) return 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
              if (msg.includes('文本编码器')) return 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
              if (msg.includes('视频 VAE')) return 'minimax_h3_video_vae_fp16.safetensors'
              if (msg.includes('音频 VAE')) return 'minimax_h3_audio_vae_fp32.safetensors'
              if (msg.includes('diffusion_models')) {
                return p === 'h3_r2v'
                  ? 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'
                  : 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
              }
            }
            // 兜底：从错误信息中匹配注册表已知文件名
            for (const km of KNOWN_MODELS) {
              if (msg.includes(km.filename)) return km.filename
            }
            return null
          }

          try {
            graph = buildGraphForPreset(preset, objectInfo)
          } catch (buildErr) {
            if (!/未检测到|未找到/i.test(buildErr.message)) throw buildErr
            const firstMissing = deduceMissingModelName(preset, buildErr.message)
            if (!firstMissing || !byFilename(firstMissing)) throw buildErr

            if (rawArgs.auto_fetch_models !== true) {
              return {
                ok: false,
                status: 'MODEL_MISSING',
                missingModel: firstMissing,
                error: buildErr.message,
                suggestion: `调用 comfyui_fetch_model({ model: '${firstMissing}' }) 下载到你的模型库，或在本次生成参数中传入 auto_fetch_models: true。`,
                autoFetchSupported: true,
              }
            }

            // 自动补齐循环(Z-Image 等多件缺失场景,最多连环补 3 件)
            let lastErr = buildErr
            let lastMissing = firstMissing
            let graphBuilt = false
            for (let attempt = 0; attempt < 3; attempt++) {
              const fetchRes = await executeFetchModel({ model: lastMissing }, exec)
              if (!fetchRes.ok) {
                return {
                  ok: false,
                  status: 'MODEL_FETCH_FAILED',
                  error: `自动获取缺失模型 "${lastMissing}" 失败: ${fetchRes.error}`,
                  missingModel: lastMissing,
                  progress: fetchRes,
                }
              }
              objectInfo = await client.getObjectInfo(exec?.signal, true)
              try {
                graph = buildGraphForPreset(preset, objectInfo)
                graphBuilt = true
                break
              } catch (retryErr) {
                lastErr = retryErr
                const nextMissing = deduceMissingModelName(preset, retryErr.message)
                if (!nextMissing || !byFilename(nextMissing)) break
                lastMissing = nextMissing
              }
            }
            if (!graphBuilt) {
              return {
                ok: false,
                status: 'MODEL_MISSING',
                missingModel: lastMissing,
                error: lastErr.message,
                suggestion: `已尝试自动补齐模型,但仍缺件。请调用 comfyui_status 检查模型库,或手动获取 "${lastMissing}"。`,
                autoFetchSupported: true,
              }
            }
          }
        } else if (mode === 'workflow') {
          if (!rawArgs.workflow) {
            return { ok: false, status: 'BAD_ARGS', error: 'workflow 模式下必须提供 workflow 图定义。' }
          }
          if (typeof rawArgs.workflow === 'string') {
            try {
              graph = JSON.parse(rawArgs.workflow)
            } catch (err) {
              return { ok: false, status: 'JSON_PARSE_ERROR', error: `workflow 参数必须为合法严格 JSON: ${err.message}` }
            }
          } else if (typeof rawArgs.workflow === 'object' && rawArgs.workflow !== null) {
            graph = JSON.parse(JSON.stringify(rawArgs.workflow))
          } else {
            return { ok: false, status: 'BAD_ARGS', error: 'workflow 参数类型无效（需对象或 JSON 字符串）。' }
          }
        } else {
          return { ok: false, status: 'BAD_ARGS', error: `未知模式: ${mode}（仅支持 preset 或 workflow）` }
        }

        // 3. 应用 overrides
        if (rawArgs.overrides && typeof rawArgs.overrides === 'object') {
          for (const [nodeId, overrideVal] of Object.entries(rawArgs.overrides)) {
            if (!overrideVal || typeof overrideVal !== 'object') continue
            if (!graph[nodeId]) {
              graph[nodeId] = { class_type: overrideVal.class_type, inputs: {} }
            }
            if (overrideVal.inputs && typeof overrideVal.inputs === 'object') {
              graph[nodeId].inputs = deepMerge(graph[nodeId].inputs || {}, overrideVal.inputs)
            } else {
              const { class_type, ...flatInputs } = overrideVal
              if (class_type) graph[nodeId].class_type = class_type
              graph[nodeId].inputs = deepMerge(graph[nodeId].inputs || {}, flatInputs)
            }
          }
        }

        // 4. 预校验
        const valResult = validateGraphAgainstObjectInfo(graph, objectInfo)
        if (!valResult.ok) {
          return {
            ok: false,
            status: 'VALIDATION',
            errors: valResult.errors,
            error: `图预校验失败:\n${valResult.errors.join('\n')}`,
          }
        }

        // 5. 提交 POST /prompt
        const clientId = client.generateClientId()
        const promptPayload = {
          prompt: graph,
          client_id: clientId,
        }

        const promptRes = await client.requestJson('/prompt', { method: 'POST', body: promptPayload }, exec?.signal)
        if (!promptRes.ok) {
          return {
            ok: false,
            status: 'PROMPT_FAILED',
            error: `提交任务失败 (HTTP ${promptRes.status})：${JSON.stringify(promptRes.data)}`,
          }
        }

        const promptData = promptRes.data || {}
        if (promptData.node_errors && Object.keys(promptData.node_errors).length > 0) {
          return {
            ok: false,
            status: 'NODE_ERRORS',
            node_errors: promptData.node_errors,
            error: `ComfyUI 节点参数校验失败: ${JSON.stringify(promptData.node_errors)}`,
          }
        }

        const promptId = promptData.prompt_id
        if (!promptId) {
          return { ok: false, status: 'NO_PROMPT_ID', error: 'ComfyUI 未返回 prompt_id' }
        }

        // 6. wait === false: 立刻返回
        const wait = rawArgs.wait !== false
        if (!wait) {
          let qPos = null
          try {
            const q = await client.requestJson('/queue', {}, exec?.signal)
            if (q.ok) {
              const running = (q.data.queue_running || []).length
              const pending = (q.data.queue_pending || []).length
              qPos = { running, pending }
            }
          } catch {}
          return {
            ok: true,
            wait: false,
            prompt_id: promptId,
            queuePos: qPos,
            note: '用 comfyui_history(prompt_id) 收结果',
          }
        }

        // 7. wait === true: 轮询等待
        const maxTimeout = entryConfig.maxTimeoutSec || DEFAULT_MAX_TIMEOUT_SEC
        const defTimeout = entryConfig.defaultTimeoutSec || DEFAULT_TIMEOUT_SEC
        const timeoutSec = clampInt(rawArgs.timeout_sec, defTimeout, 10, maxTimeout)
        const pollIntervalMs = entryConfig.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS
        const startTime = Date.now()
        let pollCount = 0
        let lastQueuePos = null

        while (true) {
          if (exec?.signal?.aborted) {
            await cleanupComfyUIOnAbortOrFailure(client)
            return {
              ok: false,
              status: 'CANCELLED_WAIT',
              prompt_id: promptId,
              note: '等待已中止，已触发看门狗清理（中断任务并释放显存）。可通过 comfyui_history 稍后收取产物。',
            }
          }

          const elapsedSec = (Date.now() - startTime) / 1000
          if (elapsedSec > timeoutSec) {
            await cleanupComfyUIOnAbortOrFailure(client)
            return {
              ok: false,
              status: 'TIMEOUT',
              prompt_id: promptId,
              elapsedSec: Math.round(elapsedSec),
              note: '已达到本次超时等待上限，已触发看门狗清理（中断任务并释放显存）。',
            }
          }

          pollCount++
          if (pollCount % 5 === 0) {
            try {
              const q = await client.requestJson('/queue', {}, exec?.signal)
              if (q.ok) {
                lastQueuePos = {
                  running: (q.data.queue_running || []).length,
                  pending: (q.data.queue_pending || []).length,
                }
              }
            } catch {}
          }

          // 查询 /history/{promptId}
          let histRes
          try {
            histRes = await client.requestJson(`/history/${promptId}`, {}, exec?.signal)
          } catch (err) {
            if (err?.isAborted) {
              await cleanupComfyUIOnAbortOrFailure(client)
              return {
                ok: false,
                status: 'CANCELLED_WAIT',
                prompt_id: promptId,
                note: '等待已中止，已触发看门狗清理（中断任务并释放显存）。',
              }
            }
          }

          if (histRes?.ok && histRes.data && histRes.data[promptId]) {
            const histItem = histRes.data[promptId]
            const st = histItem.status || {}
            const statusStr = st.status_str

            if (statusStr === 'error') {
              // 提取 execution_error
              let nodeType = 'unknown'
              let nodeId = 'unknown'
              let exMsg = '执行发生未知错误'
              let exType = 'Error'
              let tbSnippet = ''

              for (const msg of st.messages || []) {
                if (Array.isArray(msg) && typeof msg[0] === 'string' && msg[0].startsWith('execution_error')) {
                  const payload = msg[1] || {}
                  nodeType = payload.node_type || nodeType
                  nodeId = payload.node_id || nodeId
                  exMsg = payload.exception_message || exMsg
                  exType = payload.exception_type || exType
                  if (Array.isArray(payload.traceback)) {
                    tbSnippet = payload.traceback.slice(-8).join('\n')
                  }
                  break
                }
              }

              await cleanupComfyUIOnAbortOrFailure(client)

              return {
                ok: false,
                status: 'EXECUTION_ERROR',
                prompt_id: promptId,
                node_type: nodeType,
                node_id: nodeId,
                exception_type: exType,
                exception_message: exMsg,
                traceback: tbSnippet,
                error: `节点 ${nodeId} (${nodeType}) 执行出错: ${exMsg}`,
              }
            }

            if (statusStr === 'success' || st.completed || histItem.outputs) {
              // 成功完成，下载产物
              const outputsDirRoot = resolveOutputDir(rawArgs.output_dir)
              const { runDirAbs, savedOutputs } = await downloadAndSaveOutputs(
                client,
                promptId,
                histItem.outputs,
                outputsDirRoot,
                workspaceRoot,
                exec?.signal
              )

              // 视频质检抽帧（默认开启，可用 extract_frames: false 禁用）
              let qcFrames = []
              if (rawArgs.extract_frames !== false) {
                const videoOutput = savedOutputs.find((o) => /\.(mp4|webm|mkv|mov)$/i.test(o.absPath || o.path || ''))
                if (videoOutput) {
                  const vPath = videoOutput.absPath || (workspaceRoot ? path.resolve(workspaceRoot, videoOutput.path) : videoOutput.path)
                  qcFrames = extractQCFrames(vPath, rawArgs.length, workspaceRoot)
                }
              }

              const elapsedTotalSec = Math.round((Date.now() - startTime) / 100) / 10
              const manifest = {
                prompt_id: promptId,
                timestamp: new Date().toISOString(),
                elapsedSec: elapsedTotalSec,
                args: rawArgs,
                outputs: savedOutputs,
                qc_frames: qcFrames,
              }
              fs.writeFileSync(path.join(runDirAbs, 'run.json'), JSON.stringify(manifest, null, 2), 'utf-8')

              const ret = {
                ok: true,
                prompt_id: promptId,
                elapsedSec: elapsedTotalSec,
                queuePosLast: lastQueuePos,
                outputs: savedOutputs,
                outputsDir: path.relative(workspaceRoot, runDirAbs).replace(/\\/g, '/'),
              }
              if (qcFrames.length > 0) {
                ret.qc_frames = qcFrames
              }
              if (autoDimsNote) {
                ret.auto_dims = autoDimsNote
              }
              if (capCheck && capCheck.verdict === 'ok_slow') {
                ret.warnings = [capCheck.message, ...(capCheck.advice || [])]
              }
              return ret
            }
          }

          // 尚未就绪，休眠后重试
          await abortableSleep(pollIntervalMs, exec?.signal)
        }
      } catch (err) {
        await cleanupComfyUIOnAbortOrFailure(client)
        if (err?.isAborted || exec?.signal?.aborted) {
          return {
            ok: false,
            status: 'CANCELLED_WAIT',
            note: '等待已中止，已触发看门狗清理（中断任务并释放显存）。',
          }
        }
        return {
          ok: false,
          status: 'ERROR',
          error: String((err && err.message) || err),
        }
      }
    },
  }

  // ── 工具 4: comfyui_history ─────────────────────────────────────────────────
  const historyTool = {
    name: 'comfyui_history',
    description: '查询 ComfyUI 生成任务历史，或针对指定的 prompt_id 断点下载产物。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        prompt_id: { type: 'string', description: '任务 ID。如果省略则返回最近任务列表。' },
        max_items: { type: 'integer', description: '列表模式下返回的最大条数，默认 5。' },
        download: { type: 'boolean', description: '指定 prompt_id 时是否下载产物到本地工作区，默认 true。' },
        output_dir: { type: 'string', description: '下载时覆盖的目标产物根目录。' },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) {
          return [{ type: 'text', text: `⚠ 历史查询失败: ${v.error || '未知错误'}` }]
        }
        if (v.items) {
          const lines = ['ComfyUI 最近任务列表:']
          for (const it of v.items) {
            lines.push(`· [${it.prompt_id.slice(0, 8)}] 状态: ${it.status_str} | 产物数: ${it.outputCount}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [`任务 [${v.prompt_id}] 状态: ${v.status}`]
        if (v.outputs && v.outputs.length > 0) {
          lines.push('产物列表:')
          for (const o of v.outputs) {
            lines.push(`· [${o.kind}] ${o.savedPath || o.filename}`)
          }
          lines.push('图片可使用 read_image 查看；请在回答中引用路径。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      try {
        const promptId = args?.prompt_id
        const workspaceRoot = getWorkspaceRoot()

        // 列表模式
        if (!promptId) {
          const maxItems = clampInt(args?.max_items, 5, 1, 50)
          const { ok, data, status } = await client.requestJson(`/history?max_items=${maxItems}`, {}, exec?.signal)
          if (!ok) return { ok: false, error: `查询历史列表失败 (HTTP ${status})` }

          const items = []
          for (const [id, item] of Object.entries(data || {})) {
            let outputCount = 0
            for (const v of Object.values(item.outputs || {})) {
              if (Array.isArray(v)) outputCount += v.length
            }
            items.push({
              prompt_id: id,
              status_str: item.status?.status_str || 'unknown',
              completed: Boolean(item.status?.completed),
              outputCount,
            })
          }
          return { ok: true, items }
        }

        // 详情 / 下载模式
        const { ok, data, status } = await client.requestJson(`/history/${promptId}`, {}, exec?.signal)
        if (!ok) return { ok: false, error: `查询任务历史失败 (HTTP ${status})` }

        const entry = data?.[promptId]
        if (!entry) {
          // 检查队列中是否存在
          try {
            const q = await client.requestJson('/queue', {}, exec?.signal)
            if (q.ok) {
              const inRunning = (q.data.queue_running || []).some((r) => r[1] === promptId)
              const inPending = (q.data.queue_pending || []).some((p) => p[1] === promptId)
              if (inRunning || inPending) {
                return {
                  ok: true,
                  prompt_id: promptId,
                  status: inRunning ? 'RUNNING' : 'PENDING',
                  note: '任务仍在 ComfyUI 队列中尚未完成，请稍后再试。',
                }
              }
            }
          } catch {}
          return { ok: false, status: 'NOT_FOUND', prompt_id: promptId, error: `未找到任务 ID ${promptId} 的历史记录` }
        }

        const download = args?.download !== false
        if (download && entry.outputs && Object.keys(entry.outputs).length > 0) {
          const outputsDirRoot = resolveOutputDir(args?.output_dir)
          const { runDirAbs, savedOutputs } = await downloadAndSaveOutputs(
            client,
            promptId,
            entry.outputs,
            outputsDirRoot,
            workspaceRoot,
            exec?.signal
          )
          return {
            ok: true,
            prompt_id: promptId,
            status: entry.status?.status_str || 'success',
            outputs: savedOutputs,
            outputsDir: path.relative(workspaceRoot, runDirAbs).replace(/\\/g, '/'),
          }
        }

        return {
          ok: true,
          prompt_id: promptId,
          status: entry.status?.status_str || 'success',
          outputs: [],
        }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    },
  }

  // ── 工具 5: comfyui_interrupt ───────────────────────────────────────────────
  const interruptTool = {
    name: 'comfyui_interrupt',
    description: '中断当前正在执行的 ComfyUI 生成任务。可选择同时清空等待队列、释放显存并卸载模型。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        free: { type: 'boolean', description: '是否同时卸载模型并释放显存，默认 false。' },
        clear_queue: { type: 'boolean', description: '是否同时清空待处理队列(POST /queue clear)，默认 false。' },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) return [{ type: 'text', text: `⚠ 中断请求失败: ${v.error || '未知错误'}` }]
        const lines = [
          'ComfyUI 中断请求成功。',
          `当前任务已被中止${v.freed ? '，且已执行模型卸载与显存清理' : ''}${v.queueCleared ? '，待处理队列已清空' : ''}。`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      try {
        const res = await client.request('/interrupt', { method: 'POST' }, exec?.signal)
        if (!res.ok) {
          return { ok: false, error: `中断请求失败 (HTTP ${res.status})` }
        }

        let freed = false
        if (args?.free) {
          try {
            const freeRes = await client.requestJson(
              '/free',
              { method: 'POST', body: { unload_models: true, free_memory: true } },
              exec?.signal
            )
            freed = freeRes.ok
          } catch {}
        }

        let queueCleared = false
        let pendingCleared = 0
        if (args?.clear_queue) {
          try {
            const qBefore = await client.requestJson('/queue', { method: 'GET' }, exec?.signal)
            pendingCleared = (qBefore.data?.queue_pending || []).length
            const clearRes = await client.requestJson(
              '/queue',
              { method: 'POST', body: { clear: true } },
              exec?.signal
            )
            queueCleared = clearRes.ok
          } catch {}
        }

        return {
          ok: true,
          interrupted: true,
          freed,
          queueCleared,
          pendingCleared,
          note: queueCleared ? `已中断当前任务并清空待处理队列 (${pendingCleared} 个)。` : '只中断当前执行；排队任务若需清除请传 clear_queue: true。',
        }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    },
  }

  // ── 工具 6: comfyui_upload ──────────────────────────────────────────────────
  const uploadTool = {
    name: 'comfyui_upload',
    description: '将本地文件（图片、遮罩等）上传至 ComfyUI 输入目录，供后续工作流复用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: '本地文件路径（工作区相对路径或绝对路径）。' },
        name: { type: 'string', description: '上传后在 ComfyUI 侧保存的文件名（可选，默认同原文件名）。' },
        overwrite: { type: 'boolean', description: '若同名是否覆盖，默认 true。' },
        type: { type: 'string', enum: ['input', 'temp', 'output'], description: '目录类型，默认 input。' },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) return [{ type: 'text', text: `⚠ 上传失败: ${v.error || '未知错误'}` }]
        return [
          {
            type: 'text',
            text: `文件上传成功:\n· 远程文件名: ${v.comfy_name}\n· 类别: ${v.type || 'input'}\n· 可在 comfyui_generate 的 image 参数中直接使用。`,
          },
        ]
      },
    },
    async execute(args, exec) {
      try {
        if (!args?.path) return { ok: false, error: '缺少 path 参数' }
        const workspaceRoot = getWorkspaceRoot()
        const localPath = path.isAbsolute(args.path) ? args.path : path.resolve(workspaceRoot, args.path)

        if (!fs.existsSync(localPath)) {
          return { ok: false, error: `文件未找到: ${localPath}` }
        }

        const bytes = fs.readFileSync(localPath)
        const fileName = args.name || path.basename(localPath)

        const fd = new FormData()
        fd.append('image', new Blob([bytes]), fileName)
        fd.append('overwrite', String(args.overwrite !== false))
        fd.append('type', args.type || 'input')

        const res = await client.requestJson('/upload/image', { method: 'POST', body: fd }, exec?.signal)
        if (!res.ok) {
          return { ok: false, error: `上传失败 (HTTP ${res.status})` }
        }

        const data = res.data || {}
        const comfyName = data.subfolder ? `${data.subfolder}/${data.name}` : data.name

        return {
          ok: true,
          name: data.name,
          subfolder: data.subfolder || '',
          comfy_name: comfyName,
          type: data.type || 'input',
        }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    },
  }

  // ── 核心模型下载与查重执行逻辑 ─────────────────────────────────────────────
  const executeFetchModel = async (args, exec) => {
    const rawArgs = args || {}

    // 自动发现模型库目录（支持多根）
    const discovery = resolveModelsDirs({
      configModelsDir: entryConfig.modelsDir,
      force: false,
    })
    const allRoots = discovery.roots || []

    if (allRoots.length === 0) {
      return {
        ok: false,
        status: 'MODELS_DIR_NOT_CONFIGURED',
        error:
          '未检测到 ComfyUI 模型库目录。为尊重用户现有模型库结构，模型下载必须明确放置于用户现有模型库对应子目录中。请先启动 ComfyUI（插件将自动发现其模型库），或在 cordis.patch.yml 的 comfyui-bridge 插件 config 中添加 modelsDir，或设置环境变量 COMFYUI_MODELS_DIR。',
        hint: '例如: modelsDir: "D:/ComfyUI/models"',
      }
    }

    let targetFilename = null
    let targetSubfolder = null
    let targetBytes = 0
    let targetSources = []

    // 模式 1: 注册表已知模型
    if (rawArgs.model) {
      const regEntry = byFilename(rawArgs.model)
      if (regEntry) {
        targetFilename = regEntry.filename
        targetSubfolder = regEntry.subfolder
        targetBytes = regEntry.bytes
        targetSources = [...regEntry.sources]
      } else {
        // 未在注册表中，回退检查是否提供了自定义 url
        if (!rawArgs.url) {
          const knownList = KNOWN_MODELS.map((m) => m.filename).slice(0, 15).join(', ')
          return {
            ok: false,
            status: 'UNKNOWN_MODEL',
            error: `未知模型名称 "${rawArgs.model}"。若要下载注册表外模型，请同时传入 url, filename 与 subfolder 参数。已知支持自动获取的模型包括: [${knownList}...]`,
          }
        }
      }
    }

    // 模式 2: 自定义通用模式
    if (!targetFilename && rawArgs.url) {
      if (!rawArgs.filename) {
        return { ok: false, status: 'BAD_ARGS', error: '自定义下载模式必须提供 filename 参数。' }
      }
      targetFilename = path.basename(rawArgs.filename).trim()
      // HF 链接归一化: hf:repo/file 或 huggingface.co blob/resolve 链接 → hf-mirror 直链
      const rawSources = Array.isArray(rawArgs.url) ? rawArgs.url : [rawArgs.url]
      targetSources = rawSources.map((u) => normalizeHfSource(u) || u)
      // subfolder 未指定时按文件名+来源路径推断(Stability Matrix 式关键词级联)
      const inferFrom = targetFilename + ' ' + rawSources.join(' ')
      targetSubfolder = rawArgs.subfolder || inferSubfolderFromName(inferFrom)
      targetBytes = Number(rawArgs.bytes) || 0
    }

    if (!targetFilename) {
      return { ok: false, status: 'BAD_ARGS', error: '必须提供 model 参数（注册表文件名）或 url+filename+subfolder 组合。' }
    }

    // source_hint 排序微调
    if (rawArgs.source_hint === 'hf-mirror' && targetSources.length > 1) {
      targetSources.sort((a, b) => (b.includes('hf-mirror') ? 1 : 0) - (a.includes('hf-mirror') ? 1 : 0))
    } else if (rawArgs.source_hint === 'modelscope' && targetSources.length > 1) {
      targetSources.sort((a, b) => (b.includes('modelscope') ? 1 : 0) - (a.includes('modelscope') ? 1 : 0))
    }

    // 查重 1: 在整个 modelsDir 模型库多根中全库查找（优先对应子目录，再扫全部标准子目录）
    // 设计原则：已有即跳过，绝不重复占用磁盘；自定义下载模式（指定 url）若存在未完成文件则走断点续传
    const existing = findInLibrary(allRoots, targetFilename, targetSubfolder)
    const isCustomResume = Boolean(rawArgs.url) && targetBytes > 0 && existing.size < targetBytes
    if (existing.found && !isCustomResume) {
      return {
        ok: true,
        skipped: true,
        filename: targetFilename,
        subfolder: existing.subfolder,
        existingPath: existing.fullPath,
        size: existing.size,
        note: `模型已存在于模型库中 (${existing.fullPath})，无需重复下载。ComfyUI 会在下次 object_info 枚举时自动识别新模型，无需重启。`,
      }
    }

    // 目的地优选：若显式配置了 modelsDir 则绝对尊重显式配置；缺省时在自动发现的多根中根据已有文件/非C盘/空间优选
    const finalSubfolder = targetSubfolder || 'checkpoints'
    const chosenBaseDir = entryConfig.modelsDir || chooseFetchDestination(allRoots, finalSubfolder) || discovery.primary
    const targetDir = path.join(chosenBaseDir, finalSubfolder)
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }
    const destPath = path.join(targetDir, targetFilename)

    // 执行单连接流式下载 + 断点续传 + 字节校验
    let lastProgressInfo = null
    const timeoutSec = Number(rawArgs.timeout_sec) || 3600
    const downloadCtrl = new AbortController()
    const timer = setTimeout(() => downloadCtrl.abort(new Error(`下载超时 (${timeoutSec}秒)`)), timeoutSec * 1000)

    const onAbort = () => downloadCtrl.abort(exec?.signal?.reason || new Error('下载已被用户中止'))
    if (exec?.signal) {
      if (exec.signal.aborted) downloadCtrl.abort(exec.signal.reason)
      else exec.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const dlRes = await downloadFile({
        urls: targetSources,
        dest: destPath,
        expectedBytes: targetBytes,
        signal: downloadCtrl.signal,
        onProgress: (p) => {
          lastProgressInfo = p
        },
      })

      // 下载成功后清除 ComfyClient 的 object_info 缓存，确保下一次构图能枚举到新模型
      client.objectInfoCache = null
      client.objectInfoCacheTime = 0

      return {
        ok: true,
        skipped: false,
        filename: targetFilename,
        subfolder: finalSubfolder,
        path: dlRes.path,
        bytes: dlRes.bytes,
        mbps: dlRes.mbps,
        resumed: dlRes.resumed,
        note: '下载完成并已通过字节校验。ComfyUI 会在下次 object_info 枚举时自动识别新模型，无需重启。',
      }
    } catch (dlErr) {
      return {
        ok: false,
        status: 'DOWNLOAD_FAILED',
        filename: targetFilename,
        destPath,
        error: dlErr.message,
        progress: lastProgressInfo,
      }
    } finally {
      clearTimeout(timer)
      if (exec?.signal) exec.signal.removeEventListener('abort', onAbort)
    }
  }

  // ── 工具 7: comfyui_fetch_model ─────────────────────────────────────────────
  const fetchModelTool = {
    name: 'comfyui_fetch_model',
    description:
      '模型获取工具。尊重用户现有模型库结构，自动检索已知模型镜像源（ModelScope / HF-Mirror）或自定义 URL，单连接断点续传下载至 modelsDir 对应子目录并执行精确字节校验。已有即跳过。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        model: {
          type: 'string',
          description:
            '已知模型文件名（如 wan2.2_ti2v_5B_fp16.safetensors、wan2.2_vae.safetensors、umt5_xxl_fp8_e4m3fn_scaled.safetensors 等）。若在已知注册表中可直接以此参数下载。',
        },
        url: {
          type: 'string',
          description:
            '下载源 URL（支持字符串或多个 URL 备用）。自定义模型模式必填。支持 HuggingFace 简写: "hf:Owner/Repo/仓库内文件路径" 或 huggingface.co 的 blob/resolve 链接,将自动转为 hf-mirror 国内直链; CivitAI NSFW 模型可用 civitai.red 域名。',
        },
        filename: {
          type: 'string',
          description: '保存的文件名（如 my_model.safetensors）。自定义模型模式必填。',
        },
        subfolder: {
          type: 'string',
          enum: [...STANDARD_SUBFOLDERS, 'controlnet', 'embeddings', 'upscale_models', 'ipadapter', 't2i_adapter'],
          description:
            '模型存放子目录。缺省时按文件名/来源路径自动推断(Stability Matrix 式关键词级联: vae/encoder/t5/qwen 前缀、controlnet、lora、upscaler、gguf/DiT 等)。',
        },
        bytes: {
          type: 'integer',
          description: '期望文件字节数（用于下载完成后的严格完整性校验；0 则跳过校验）。',
        },
        source_hint: {
          type: 'string',
          enum: ['modelscope', 'hf-mirror'],
          description: '镜像源偏好排序提示，默认优先国内 ModelScope 镜像源。',
        },
        timeout_sec: {
          type: 'integer',
          description: '单任务下载最大超时秒数，默认 3600。',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) {
          return [
            {
              type: 'text',
              text: `⚠ 模型获取失败 [${v.status || 'ERROR'}]: ${v.error}${v.hint ? '\n💡 ' + v.hint : ''}`,
            },
          ]
        }
        if (v.skipped) {
          return [
            {
              type: 'text',
              text: `✨ 模型已存在（无需下载）:\n· 文件: ${v.filename}\n· 本地路径: ${v.existingPath}\n· 大小: ${(v.size / (1024 ** 2)).toFixed(1)} MB\n· 提示: ${v.note}`,
            },
          ]
        }
        return [
          {
            type: 'text',
            text: `🎉 模型下载成功:\n· 文件: ${v.filename}\n· 目标路径: ${v.path}\n· 最终大小: ${(v.bytes / (1024 ** 2)).toFixed(1)} MB\n· 平均速率: ${v.mbps || 0} Mbps ${v.resumed ? '(断点续传完成)' : ''}\n· 提示: ${v.note}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      return await executeFetchModel(args, exec)
    },
  }

  // ── 工具 8: comfyui_install ─────────────────────────────────────────────────
  const installTool = {
    name: 'comfyui_install',
    description: '一键下载并安装官方纯净版 ComfyUI 便携版至非 C 盘根目录（如 D:\\ComfyUI）。注意：调用前须先征得用户明确同意，请勿自动将 confirm 设为 true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['confirm'],
      properties: {
        confirm: {
          type: 'boolean',
          description: '是否确认执行安装。必须显式设为 true。调用前必须先征得用户明确同意。',
        },
        target_drive: {
          type: 'string',
          description: '可选指定安装的目标盘符（如 "D:" 或 "E:"）。严禁使用 C 盘。缺省自动选择非 C 盘中剩余空间最大的盘。',
        },
        timeout_sec: {
          type: 'integer',
          description: '下载与解压总超时时间（秒），默认 3600。',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value || {}
        if (!v.ok) {
          return [
            {
              type: 'text',
              text: `⚠ ComfyUI 安装未执行或失败 [${v.error || 'FAILED'}]:\n${v.message || v.error}${v.blockers ? '\n未达标项: ' + v.blockers.join('；') : ''}`,
            },
          ]
        }
        return [
          {
            type: 'text',
            text: `🎉 ComfyUI 安装成功！\n· 安装路径: ${v.installedPath}\n· 版本: ${v.version}\n· 启动方式: ${v.startMethod}\n· 提示: ${v.message}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      return await executeComfyUIInstall(args, {
        signal: exec?.signal,
        ...(entryConfig.__installerOptions || {}),
      })
    },
  }

  // ── 注册工具与系统引导提示词 ───────────────────────────────────────────────

  ctx.effect(() => ctx.tools.register(statusTool))
  ctx.effect(() => ctx.tools.register(modelsTool))
  ctx.effect(() => ctx.tools.register(generateTool))
  ctx.effect(() => ctx.tools.register(historyTool))
  ctx.effect(() => ctx.tools.register(interruptTool))
  ctx.effect(() => ctx.tools.register(uploadTool))
  ctx.effect(() => ctx.tools.register(fetchModelTool))
  ctx.effect(() => ctx.tools.register(installTool))

  const promptSectionText = [
    'ComfyUI bridge tools are available for image and video generation:',
    '- comfyui_status: Check connection, version, GPU VRAM, queue state, and auto-discover model libraries. When unreachable, diagnoses installation and device viability.',
    '- comfyui_models: List available checkpoints/unets/vaes and detect video generation capabilities.',
    '- comfyui_generate: Generate images or videos. Use mode="preset" for standard workflows (txt2img, img2img, wan_t2v, wan_i2v, wan22_ti2v, svd_img2vid, animatediff, h3_t2v, h3_flf2v, h3_r2v), or mode="workflow" for custom API graphs.',
    '- comfyui_fetch_model: Fetch required models directly into user modelsDir corresponding subfolders with resume support.',
    '- comfyui_install: One-click installer for ComfyUI official portable version to non-C drive (requires explicit confirm: true after user consent).',
    '- Generated images/videos are automatically saved into your workspace (comfyui-outputs/...).',
    '- View generated images with read_image, and reference output file paths in your final answer.',
    '- For long video tasks, you may pass wait=false to submit and retrieve outputs later via comfyui_history.',
    '- comfyui_interrupt: Stop running tasks if needed; comfyui_upload: upload local files to ComfyUI.',
  ].join('\n')

  ctx.effect(() => ctx.systemPrompt.section({ name: 'comfyui:guide', order: 5, text: promptSectionText }))
}
