// lib/downloader.mjs — 健壮单连接流式文件下载器（带断点续传与精确字节校验）
//
// 专为 CDN 限制场景与超大权重模型设计：
// 1. 严格单连接顺序下载，逐源重试（首选源失败自动切换备选源）；
// 2. HTTP Range 断点续传：检测到已有部分文件时附带 `Range: bytes=<cur>-` 请求头；
// 3. 服务端若返回 206 Partial Content 则 append 写入，若返回 200 则说明不支持 Range，自动截断重写；
// 4. 下载进度回调：按时间/字节节流（每 ~500MB 或 10%）回调；
// 5. 校验 expectedBytes：若校验失败保留文件供重试（不删除），抛出错误；
// 6. 纯 Node 原生内置 API（node:fs, node:path, fetch, stream），零额外外部依赖。

import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'

/**
 * 流式下载单个文件，支持多源重试、断点续传与字节数校验
 *
 * @param {object} options
 * @param {string[]} options.urls - 下载 URL 列表（按优先级逐一尝试）
 * @param {string} options.dest - 本地目标完整路径
 * @param {number} [options.expectedBytes=0] - 期望的总字节数（为 0 则不校验）
 * @param {AbortSignal} [options.signal] - 中止控制信号
 * @param {Function} [options.onProgress] - 进度回调 ({ downloaded, total, percent, speedMbps }) => void
 * @returns {Promise<{ path: string, bytes: number, mbps: number, resumed: boolean }>}
 */
export async function downloadFile(options) {
  const { urls, dest, expectedBytes = 0, signal, onProgress } = options || {}

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    throw new Error('downloadFile: 缺少有效的下载源 URL 列表 (urls)')
  }
  if (!dest || typeof dest !== 'string') {
    throw new Error('downloadFile: 缺少目标文件路径 (dest)')
  }

  // 确保父目录存在
  const destDir = path.dirname(dest)
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
  }

  let lastError = null

  // 逐源尝试
  for (let urlIdx = 0; urlIdx < urls.length; urlIdx++) {
    const currentUrl = urls[urlIdx]
    if (signal?.aborted) {
      throw new Error(signal.reason || '下载已被用户中止')
    }

    try {
      return await downloadFromSingleUrl({
        url: currentUrl,
        dest,
        expectedBytes,
        signal,
        onProgress,
      })
    } catch (err) {
      lastError = err
      if (signal?.aborted) {
        throw err
      }
      // 当前源失败，若还有备用源则尝试下一个
      if (urlIdx < urls.length - 1) {
        continue
      }
    }
  }

  throw lastError || new Error(`所有下载源均失败: ${urls.join(', ')}`)
}

/**
 * 从单一 URL 下载/续传到目标文件
 */
async function downloadFromSingleUrl({ url, dest, expectedBytes, signal, onProgress }) {
  let existingBytes = 0
  if (fs.existsSync(dest)) {
    try {
      const stat = fs.statSync(dest)
      existingBytes = stat.size
    } catch {}
  }

  // 若本地文件已经完整符合 expectedBytes，直接通过
  if (expectedBytes > 0 && existingBytes === expectedBytes) {
    if (onProgress) {
      onProgress({ downloaded: existingBytes, total: expectedBytes, percent: 100, speedMbps: 0 })
    }
    return { path: dest, bytes: existingBytes, mbps: 0, resumed: true }
  }

  // 若本地文件字节数超出预期（可能损坏），则重置
  if (expectedBytes > 0 && existingBytes > expectedBytes) {
    existingBytes = 0
  }

  const reqHeaders = {}
  let isRangeRequest = false
  if (existingBytes > 0) {
    reqHeaders['Range'] = `bytes=${existingBytes}-`
    isRangeRequest = true
  }

  const fetchOpts = {
    method: 'GET',
    headers: reqHeaders,
  }
  if (signal) {
    fetchOpts.signal = signal
  }

  const response = await fetch(url, fetchOpts)

  if (!response.ok && response.status !== 206) {
    throw new Error(`下载请求失败: HTTP ${response.status} (${url})`)
  }

  // 服务端响应处理：206 为接受 Range；200 为全量响应（不支持 Range 或重新发送）
  const isPartial = response.status === 206
  let writeFlag = 'w'
  let startOffset = 0

  if (isRangeRequest && isPartial) {
    writeFlag = 'a'
    startOffset = existingBytes
  } else {
    writeFlag = 'w'
    startOffset = 0
  }

  // 获取总大小
  let totalBytes = expectedBytes || 0
  const contentLength = Number(response.headers.get('content-length')) || 0
  if (contentLength > 0) {
    totalBytes = isPartial ? startOffset + contentLength : contentLength
  }

  const fileStream = fs.createWriteStream(dest, { flags: writeFlag })

  // 进度统计
  let downloadedBytes = startOffset
  let lastReportedBytes = downloadedBytes
  let lastReportedPercent = totalBytes > 0 ? Math.floor((downloadedBytes / totalBytes) * 100) : 0
  const startTime = Date.now()
  let lastSampleTime = startTime
  let lastSampleBytes = downloadedBytes
  let currentSpeedMbps = 0

  // 进度通知判定（每 500MB 或 10% 回调一次）
  const reportProgressIfNeeded = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    const bytesSinceReport = downloadedBytes - lastReportedBytes
    const currentPercent = totalBytes > 0 ? Math.floor((downloadedBytes / totalBytes) * 100) : 0
    const percentDiff = currentPercent - lastReportedPercent

    // 计算速率 (Mbps)
    const timeSinceSample = now - lastSampleTime
    if (timeSinceSample >= 1000) {
      const bytesSinceSample = downloadedBytes - lastSampleBytes
      currentSpeedMbps = Math.round(((bytesSinceSample * 8) / (timeSinceSample / 1000) / (1024 * 1024)) * 10) / 10
      lastSampleTime = now
      lastSampleBytes = downloadedBytes
    }

    if (force || bytesSinceReport >= 500 * 1024 * 1024 || percentDiff >= 10) {
      lastReportedBytes = downloadedBytes
      lastReportedPercent = currentPercent
      onProgress({
        downloaded: downloadedBytes,
        total: totalBytes,
        percent: currentPercent,
        speedMbps: currentSpeedMbps,
      })
    }
  }

  reportProgressIfNeeded(true)

  if (!response.body) {
    fileStream.close()
    throw new Error('下载失败: 响应体为空 (Empty body)')
  }

  const nodeReadable = Readable.fromWeb(response.body)

  try {
    for await (const chunk of nodeReadable) {
      if (signal?.aborted) {
        throw new Error(signal.reason || '下载已被用户中止')
      }
      fileStream.write(chunk)
      downloadedBytes += chunk.length
      reportProgressIfNeeded(false)
    }
  } catch (err) {
    fileStream.end()
    throw err
  }

  await new Promise((resolve, reject) => {
    fileStream.end((err) => {
      if (err) reject(err)
      else resolve()
    })
  })

  reportProgressIfNeeded(true)

  // 校验最终文件大小
  const finalStat = fs.statSync(dest)
  const finalSize = finalStat.size

  if (expectedBytes > 0 && finalSize !== expectedBytes) {
    // 字节不符则报错并保留文件供重试（不删除）
    throw new Error(
      `文件大小校验失败: 期望 ${expectedBytes} 字节，实得 ${finalSize} 字节 (${path.basename(dest)})。文件已保留供断点续传重试。`
    )
  }

  const durationSec = Math.max(0.1, (Date.now() - startTime) / 1000)
  const transferredBytes = downloadedBytes - startOffset
  const avgMbps = Math.round(((transferredBytes * 8) / durationSec / (1024 * 1024)) * 10) / 10

  return {
    path: dest,
    bytes: finalSize,
    mbps: avgMbps,
    resumed: startOffset > 0,
  }
}