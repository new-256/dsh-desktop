// lib/imageMeta.mjs — 无依赖解析图片宽高及自动横竖构图适配器
//
// 遵循轻量与原生纪律：纯 JS 解析 PNG IHDR 与 JPEG SOF 段，零外部依赖。
// 为视频/图像生成预设（wan_i2v, wan22_ti2v, svd_img2vid, img2img, animatediff）
// 提供素材横竖比判定与最佳分辨率自适应推荐。

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * 从 Buffer 中解析 PNG 宽高
 */
function parsePng(buffer) {
  if (!buffer || buffer.length < 24) return null
  // PNG 签名: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47 ||
    buffer[4] !== 0x0d ||
    buffer[5] !== 0x0a ||
    buffer[6] !== 0x1a ||
    buffer[7] !== 0x0a
  ) {
    return null
  }
  // IHDR 必须为第一个 Chunk，其 chunk type 在 offset 12..15 为 "IHDR"
  const type = buffer.toString('ascii', 12, 16)
  if (type !== 'IHDR') return null

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { width, height, format: 'png' }
}

/**
 * 从 Buffer 中解析 JPEG 宽高
 */
function parseJpeg(buffer) {
  if (!buffer || buffer.length < 4) return null
  // JPEG 签名: FF D8 (SOI)
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null

  let offset = 2
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset++
    while (offset < buffer.length && buffer[offset] === 0xff) offset++
    if (offset >= buffer.length) break

    const marker = buffer[offset++]
    // EOI (D9) 或 SOS (DA) 结束标志
    if (marker === 0xd9 || marker === 0xda) break

    if (offset + 2 > buffer.length) break
    const len = buffer.readUInt16BE(offset)

    // SOF0..SOF15 标记 (排除 DHT C4, JPG C8, DAC CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 7 > buffer.length) break
      // offset + 2: precision (1 byte)
      const height = buffer.readUInt16BE(offset + 3)
      const width = buffer.readUInt16BE(offset + 5)
      return { width, height, format: 'jpeg' }
    }

    offset += len
  }
  return null
}

/**
 * 解析文件或 Buffer 宽高
 * @param {string|Buffer} input - 本地文件路径或文件二进制 Buffer
 * @returns {{ width: number, height: number, format: string }|null}
 */
export function getImageDimensions(input) {
  try {
    let buffer
    if (Buffer.isBuffer(input)) {
      buffer = input
    } else if (typeof input === 'string') {
      if (!fs.existsSync(input)) return null
      // 头部 64KB 通常足以覆盖 PNG IHDR 与大多数 JPEG APP/SOF 段
      const fd = fs.openSync(input, 'r')
      const buf = Buffer.alloc(65536)
      const bytesRead = fs.readSync(fd, buf, 0, 65536, 0)
      fs.closeSync(fd)
      buffer = buf.subarray(0, bytesRead)
    } else {
      return null
    }

    return parsePng(buffer) || parseJpeg(buffer)
  } catch {
    return null
  }
}

/**
 * 根据预设与输入素材横竖比，自动选择/自适应分辨率
 * @param {string} preset
 * @param {string} imagePath
 * @param {number|undefined} explicitWidth
 * @param {number|undefined} explicitHeight
 * @param {string} workspaceRoot
 * @returns {{ width: number, height: number, autoSelected: boolean, note?: string }}
 */
export function resolveAutoDimensions(preset, imagePath, explicitWidth, explicitHeight, workspaceRoot = '') {
  // 若调用方已显式传参，优先遵守调用方意图
  if (explicitWidth && explicitHeight) {
    return { width: Number(explicitWidth), height: Number(explicitHeight), autoSelected: false }
  }

  // 默认基准尺寸表
  const defaultPresets = {
    wan_i2v: { landscape: [1280, 720], portrait: [720, 1280], square: [832, 832] },
    wan22_ti2v: { landscape: [1280, 704], portrait: [704, 1280], square: [1280, 704] },
    svd_img2vid: { landscape: [1024, 576], portrait: [576, 1024], square: [576, 576] },
    animatediff: { landscape: [768, 512], portrait: [512, 768], square: [512, 512] },
    img2img: { landscape: [1024, 768], portrait: [768, 1024], square: [1024, 1024] },
  }

  const spec = defaultPresets[preset]
  if (!spec || !imagePath) {
    return {
      width: explicitWidth || spec?.landscape[0] || 1280,
      height: explicitHeight || spec?.landscape[1] || 720,
      autoSelected: false,
    }
  }

  const absImgPath = path.isAbsolute(imagePath) ? imagePath : path.resolve(workspaceRoot, imagePath)
  const dims = getImageDimensions(absImgPath)
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return {
      width: explicitWidth || spec.landscape[0],
      height: explicitHeight || spec.landscape[1],
      autoSelected: false,
    }
  }

  const { width: srcW, height: srcH } = dims
  const ratio = srcW / srcH

  // img2img 预设特殊规则：按原图尺寸 clamp 到 <=1536 并对齐到 64 整数倍
  if (preset === 'img2img') {
    let w = srcW
    let h = srcH
    const maxDim = Math.max(w, h)
    if (maxDim > 1536) {
      const scale = 1536 / maxDim
      w = Math.round(w * scale)
      h = Math.round(h * scale)
    }
    w = Math.max(64, Math.round(w / 64) * 64)
    h = Math.max(64, Math.round(h / 64) * 64)

    return {
      width: explicitWidth || w,
      height: explicitHeight || h,
      autoSelected: true,
      note: `width/height 由素材横竖比自动选择 (${w}x${h}，原素材 ${srcW}x${srcH} 对齐至 64 整数倍)`,
    }
  }

  // 视频类预设（wan_i2v, wan22_ti2v, svd_img2vid, animatediff）
  let chosen
  let orientationDesc = ''

  if (ratio > 1.05) {
    // 横版素材
    chosen = spec.landscape
    orientationDesc = '横版素材'
  } else if (ratio < 0.95) {
    // 竖版素材
    chosen = spec.portrait
    orientationDesc = '竖版素材'
  } else {
    // 正方形或接近正方形素材
    chosen = spec.square
    orientationDesc = '正方形素材'
  }

  const finalW = explicitWidth || chosen[0]
  const finalH = explicitHeight || chosen[1]

  return {
    width: finalW,
    height: finalH,
    autoSelected: true,
    note: `width/height 由素材横竖比自动选择 (${finalW}x${finalH}，识别为 ${orientationDesc} 原图 ${srcW}x${srcH})`,
  }
}
