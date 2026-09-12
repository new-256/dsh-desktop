/**
 * session-cleaner.plugin.mjs — DSH 会话回收站与清理管理器宿主插件 (原生 UI 集成版 v1.2.0)
 *
 * 【开发纪律（DEV-DISCIPLINE，必读）】本文件是部署副本，源码正本在 Desktop\DSH 仓
 * plugins\web\session-cleaner.plugin.mjs。每次改动：同步双份 → bump cordis.patch.yml 的
 * ?v=N 缓存参数 → 重启 DSH Desktop 验证 → 提交仓库。详见 dsh-home\plugins\DEV-DISCIPLINE.md。
 * （2026-09-12 纪律审计发现部署副本曾长期领先正本，已回同步归位。）
 *
 * 契约与规范：
 * 1. 路由注册：必须使用 handler 属性，形如 ws.register({ kind: 'exact', path: '...', async handler(req, res) { ... } })
 * 2. 页面注入：必须监听 webserver/index-inject 事件，调用 table.push({ kind: 'script', placement: 'body', text: '...' })
 * 3. 移入回收站语义：物理目录移至 dsh-home\.session-cleaner-trash\<sessionId>\，清理 workspace.json / projcache
 * 4. 防重名误删：严格提取 React Fiber 的 sessionId，无法确定 ID 时绝不注入删除选项，二次确认展示同名摘要与首条指令对比
 * 5. 对话内容预览：支持多帧 zstd 解压与 plain text JSONL 提取（标题/创建/轮次/用户与助手消息/首条指令高亮）
 *
 * v1.2.0 变更：
 * - 主题与 DSH 主体完全一致：管理页内嵌 DSH design-platform 设计令牌（light/dark），
 *   全部组件改用 --dsw-alias-* 语义变量；注入弹窗同步跟随。
 * - 回收站列表优化：不再显示「当前列表（未归档可见会话）」中仍然存在的会话条目；
 *   已归档会话与已列入回收站的会话正常显示，并带 已归档/子代理 标记。
 * - 新增定期清空设置：会话移入回收站 N 天后自动彻底删除（可开关、可调天数与检查间隔），
 *   支持「立即清理过期项」；回收站内展示剩余天数/过期状态。
 * - 恢复会话时保留归档状态（原为已归档的会话恢复后仍回到归档区）。
 * - 新增 Session ID 安全校验，防止路径穿越。
 *
 * @module session-cleaner
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'session-cleaner'

const DEFAULT_CONFIG = {
  trashDirName: '.session-cleaner-trash',
  verbose: false,
  autoPurgeEnabled: true,
  retentionDays: 30,
  purgeIntervalMinutes: 60,
}

/** 回收站定期清空设置持久化文件名 (位于 dshHome 下，独立于回收站目录以避免被清空) */
const SETTINGS_FILENAME = 'session-cleaner-settings.json'

// ---------------------------------------------------------------------------
// 纯函数与路径编码 (与 dsh-session-persistence-jsonl 规范 100% 对齐)
// ---------------------------------------------------------------------------

export function projectKey(cwd) {
  if (!cwd || cwd.length === 0) throw new Error('cannot encode empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

export function encodeSegment(raw) {
  if (!raw || raw.length === 0) throw new Error('cannot encode empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

export async function getDirSize(dirPath) {
  let size = 0
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        size += await getDirSize(fullPath)
      } else if (entry.isFile()) {
        const st = await stat(fullPath)
        size += st.size
      }
    }
  } catch {}
  return size
}

async function readJsonFile(filePath) {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

async function writeJsonFile(filePath, data) {
  const content = JSON.stringify(data, null, 2) + '\n'
  await writeFile(filePath, content, 'utf8')
}

// ---------------------------------------------------------------------------
// 定期清空设置
// ---------------------------------------------------------------------------

export async function loadSettings(dshHome) {
  const saved = (await readJsonFile(join(dshHome, SETTINGS_FILENAME))) || {}
  return {
    autoPurgeEnabled: typeof saved.autoPurgeEnabled === 'boolean' ? saved.autoPurgeEnabled : DEFAULT_CONFIG.autoPurgeEnabled,
    retentionDays: Number.isFinite(saved.retentionDays) ? saved.retentionDays : DEFAULT_CONFIG.retentionDays,
    purgeIntervalMinutes: Number.isFinite(saved.purgeIntervalMinutes) ? saved.purgeIntervalMinutes : DEFAULT_CONFIG.purgeIntervalMinutes,
  }
}

export async function saveSettings(dshHome, patch = {}) {
  const current = await loadSettings(dshHome)
  const next = { ...current }
  if (patch.autoPurgeEnabled !== undefined) next.autoPurgeEnabled = Boolean(patch.autoPurgeEnabled)
  if (Number.isFinite(patch.retentionDays)) next.retentionDays = Math.max(1, Math.min(3650, Math.round(patch.retentionDays)))
  if (Number.isFinite(patch.purgeIntervalMinutes)) next.purgeIntervalMinutes = Math.max(15, Math.min(1440, Math.round(patch.purgeIntervalMinutes)))
  await writeJsonFile(join(dshHome, SETTINGS_FILENAME), next)
  return next
}

// ---------------------------------------------------------------------------
// 安全校验：Session ID 用于拼装文件路径
// ---------------------------------------------------------------------------

export function assertSafeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('无效的 Session ID')
  }
  if (sessionId.length > 120) throw new Error('Session ID 长度异常')
  if (/[\\/]|\.\./.test(sessionId)) throw new Error('Session ID 包含非法字符')
  return sessionId.trim()
}

// ---------------------------------------------------------------------------
// 多帧 zstd 解压与 JSONL 预览提取 (核心解压与提取纯函数)
// ---------------------------------------------------------------------------

export function decompressMultiFrameZstd(buf) {
  const chunks = []
  let p = 0
  const dictIdSizes = [0, 1, 2, 4]
  while (p < buf.length) {
    if (p + 4 > buf.length) break
    // Magic number: 0xFD2FB528 (Little Endian: 0x28 0xB5 0x2F 0xFD)
    if (buf[p] !== 0x28 || buf[p + 1] !== 0xb5 || buf[p + 2] !== 0x2f || buf[p + 3] !== 0xfd) {
      break
    }
    const frameStart = p
    p += 4
    if (p >= buf.length) break
    const fhd = buf[p++]
    const fcsFlag = fhd >> 6
    const singleSegment = (fhd >> 5) & 1
    const checksumFlag = (fhd >> 2) & 1
    const dictIdFlag = fhd & 3

    if (!singleSegment && p < buf.length) p += 1 // Window Descriptor
    p += dictIdSizes[dictIdFlag] // Dictionary ID

    let fcsSize = 0
    if (fcsFlag === 0) fcsSize = singleSegment ? 1 : 0
    else if (fcsFlag === 1) fcsSize = 2
    else if (fcsFlag === 2) fcsSize = 4
    else if (fcsFlag === 3) fcsSize = 8
    p += fcsSize

    while (p + 3 <= buf.length) {
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
      const last = h & 1
      const blockSize = h >>> 3
      p += 3 + blockSize
      if (last) break
    }
    if (checksumFlag) p += 4

    const frameBuf = buf.subarray(frameStart, p)
    const decompressed = zstdDecompressSync(frameBuf)
    chunks.push(decompressed)
  }

  if (chunks.length === 0) {
    return zstdDecompressSync(buf)
  }
  return Buffer.concat(chunks)
}

function parseContentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && (item.type === 'text' || typeof item.text === 'string'))
      .map((item) => item.text || '')
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export async function extractSessionPreview(filePath) {
  const result = {
    ok: true,
    title: null,
    createdAt: null,
    lastActiveAt: null,
    cwd: null,
    turns: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    firstUserText: null,
    lastUserText: null,
    lastAssistantText: null,
  }

  try {
    let resolvedPath = filePath
    if (!existsSync(resolvedPath)) {
      if (existsSync(join(filePath, 'session.jsonl.zstd'))) {
        resolvedPath = join(filePath, 'session.jsonl.zstd')
      } else if (existsSync(join(filePath, 'session.jsonl'))) {
        resolvedPath = join(filePath, 'session.jsonl')
      } else if (existsSync(filePath + '.zstd')) {
        resolvedPath = filePath + '.zstd'
      } else if (existsSync(filePath + '.jsonl')) {
        resolvedPath = filePath + '.jsonl'
      } else {
        return { ok: false, error: `文件或目录不存在: ${filePath}` }
      }
    }

    let fileContent = ''
    const isZstd = resolvedPath.endsWith('.zstd')

    if (isZstd) {
      const rawBuf = await readFile(resolvedPath)
      fileContent = decompressMultiFrameZstd(rawBuf).toString('utf8')
    } else {
      fileContent = await readFile(resolvedPath, 'utf8')
    }

    const lines = fileContent.split('\n')
    for (const rawLine of lines) {
      const lineStr = rawLine.trim()
      if (!lineStr) continue

      let event
      try {
        event = JSON.parse(lineStr)
      } catch {
        continue
      }

      if (!event || typeof event !== 'object') continue

      const timeVal = event.time || event.createdAt || event.data?.time
      if (typeof timeVal === 'number' && timeVal > 0) {
        if (!result.createdAt) result.createdAt = timeVal
        result.lastActiveAt = timeVal
      }

      switch (event.type) {
        case 'session':
          if (typeof event.createdAt === 'number') result.createdAt = event.createdAt
          if (typeof event.cwd === 'string') result.cwd = event.cwd
          break

        case 'session/title':
          if (event.data && typeof event.data.title === 'string') {
            result.title = event.data.title
          }
          break

        case 'turn/start':
          result.turns += 1
          break

        case 'tool/call':
          result.toolCalls += 1
          break

        case 'user/message': {
          const srcKind = event.data?.source?.kind
          if (srcKind !== 'user') break // 系统/插件注入消息过滤

          result.userMessages += 1
          const text = parseContentText(event.data?.content)
          if (text) {
            const truncated = text.slice(0, 300)
            if (result.firstUserText === null) {
              result.firstUserText = truncated
            }
            result.lastUserText = truncated
          }
          break
        }

        case 'assistant/message': {
          result.assistantMessages += 1
          const msgObj = event.data?.message || event.data
          const text = parseContentText(msgObj?.content)
          if (text) {
            result.lastAssistantText = text.slice(0, 300)
          }
          break
        }
      }
    }

    return result
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

// ---------------------------------------------------------------------------
// 核心清理/恢复逻辑函数 (独立无 Cordis 依赖，接收 dshHome 根路径)
// ---------------------------------------------------------------------------

export async function listSessions(dshHome) {
  const storagesDir = join(dshHome, 'storages')
  const sessionsDir = join(dshHome, 'sessions')

  const workspaceJson = (await readJsonFile(join(storagesDir, 'workspace.json'))) || { tables: { workspaces: {} }, global: {} }
  const projcacheJson = (await readJsonFile(join(storagesDir, 'session_projcache.json'))) || { tables: { sessions: {} } }

  const workspaces = workspaceJson.tables?.workspaces || {}
  const archivedSessionIds = new Set(workspaceJson.global?.archivedSessionIds || [])
  const projSessions = projcacheJson.tables?.sessions || {}

  const registeredSessions = new Map()
  for (const [wsId, ws] of Object.entries(workspaces)) {
    const sIds = ws.sessionIds || []
    for (const sId of sIds) {
      registeredSessions.set(sId, {
        workspaceId: wsId,
        workspacePath: ws.path,
        workspaceTitle: ws.title,
      })
    }
  }

  const foundSessions = []

  if (existsSync(sessionsDir)) {
    let wsFolders = []
    try {
      wsFolders = await readdir(sessionsDir, { withFileTypes: true })
    } catch {}

    for (const wsFolder of wsFolders) {
      if (!wsFolder.isDirectory()) continue
      const wsFolderPath = join(sessionsDir, wsFolder.name)

      let sDirs = []
      try {
        sDirs = await readdir(wsFolderPath, { withFileTypes: true })
      } catch {}

      for (const sDir of sDirs) {
        if (!sDir.isDirectory()) continue
        const sessionId = sDir.name
        const fullSessionDir = join(wsFolderPath, sessionId)
        const dirSize = await getDirSize(fullSessionDir)

        const regInfo = registeredSessions.get(sessionId)
        const proj = projSessions[sessionId] || {}
        const rows = proj.rows || {}

        const title = rows.title?.val || (sessionId.startsWith('session-') ? '未命名会话' : '子代理任务')
        const createdAt = proj.identity?.createdAt || 0
        const sessionStats = rows.sessionStats?.val || {}
        const turns = sessionStats.turns || 0
        const steps = sessionStats.steps || 0
        const openStep = sessionStats.openStep || null
        const pendingCalls = sessionStats.pendingCalls || {}
        const lastPromptAt = rows.sessionListMetadata?.val?.lastPromptAt || 0
        const blank = Boolean(rows.sessionListMetadata?.val?.blank)

        const subagentVal = rows.subagent?.val || {}
        const isSubagent = Boolean(!sessionId.startsWith('session-') || subagentVal.identity)
        const subagentLabel = subagentVal.identity?.label || null

        const isArchived = archivedSessionIds.has(sessionId)

        // 活跃判定只看 projcache openStep/pendingCalls
        const isLive = Boolean(openStep || (pendingCalls && Object.keys(pendingCalls).length > 0))

        foundSessions.push({
          sessionId,
          title,
          createdAt,
          lastPromptAt,
          turns,
          steps,
          dirSize,
          isRegistered: Boolean(regInfo),
          workspacePath: regInfo?.workspacePath || proj.identity?.cwd || '未知工作区',
          workspaceTitle: regInfo?.workspaceTitle || '全局',
          isArchived,
          isVisible: !isArchived && !isSubagent,
          isSubagent,
          subagentLabel,
          blank,
          isLive,
          openStep,
          pendingCalls,
          sessionDir: fullSessionDir,
          titleCollision: false,
        })
      }
    }
  }

  const titleCounts = new Map()
  for (const s of foundSessions) {
    if (s.title && s.title !== '未命名会话' && s.title !== '子代理任务') {
      titleCounts.set(s.title, (titleCounts.get(s.title) || 0) + 1)
    }
  }
  for (const s of foundSessions) {
    if (s.title && titleCounts.get(s.title) > 1) {
      s.titleCollision = true
    }
  }

  return foundSessions
}

/**
 * 列出回收站条目。
 * 过滤规则：若某条目的 sessionId 仍存在于「当前列表」(sessions 目录中存在的
 * 未归档可见会话)，则视为过期/重复条目，不再显示；已归档会话与已列入回收站的
 * 会话始终显示。同时基于定期清空设置计算 过期时间/剩余天数。
 */
export async function listTrash(dshHome, options = {}) {
  const trashDirName = options.trashDirName || DEFAULT_CONFIG.trashDirName
  const retentionDays = Number.isFinite(options.retentionDays) ? options.retentionDays : DEFAULT_CONFIG.retentionDays
  const trashDir = join(dshHome, trashDirName)
  if (!existsSync(trashDir)) return []

  // 当前列表：sessions 目录中存在的全部会话；归档集合：workspace.json 中的归档 ID
  let presentIds = new Set()
  let archivedIds = new Set()
  try {
    const sessions = await listSessions(dshHome)
    presentIds = new Set(sessions.map((s) => s.sessionId))
  } catch {}
  try {
    const ws = await readJsonFile(join(dshHome, 'storages', 'workspace.json'))
    archivedIds = new Set(ws?.global?.archivedSessionIds || [])
  } catch {}

  const trashItems = []
  try {
    const entries = await readdir(trashDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      const itemDir = join(trashDir, sessionId)
      const infoPath = join(itemDir, '.trash-info.json')

      const info = (await readJsonFile(infoPath)) || {}
      const isArchived = Boolean(info.isArchived) || archivedIds.has(sessionId)

      // 回收站内不再显示当前列表中仍然存在的会话（未归档的可见会话）
      if (presentIds.has(sessionId) && !isArchived) continue

      const size = await getDirSize(join(itemDir, 'session-data'))
      const deletedAt = info.deletedAt || 0
      const expiresAt = retentionDays > 0 && deletedAt > 0 ? deletedAt + retentionDays * 86400000 : 0

      trashItems.push({
        sessionId,
        deletedAt,
        title: info.title || sessionId,
        originalWorkspacePath: info.originalWorkspacePath || '',
        workspaceTitle: info.workspaceTitle || '',
        dirSize: size,
        isSubagent: info.isSubagent || false,
        isArchived,
        retentionDays,
        expiresAt,
        expired: Boolean(expiresAt) && expiresAt < Date.now(),
      })
    }
  } catch {}

  return trashItems.sort((a, b) => b.deletedAt - a.deletedAt)
}

export async function moveToTrash(dshHome, sessionId, options = {}) {
  assertSafeSessionId(sessionId)
  const trashDirName = options.trashDirName || DEFAULT_CONFIG.trashDirName
  const trashDir = join(dshHome, trashDirName)
  const report = { sessionId, success: false, stepsDone: [] }

  const storagesDir = join(dshHome, 'storages')
  const wsJsonPath = join(storagesDir, 'workspace.json')
  const projPath = join(storagesDir, 'session_projcache.json')

  const workspaceJson = await readJsonFile(wsJsonPath)
  const projJson = await readJsonFile(projPath)

  const allSessions = await listSessions(dshHome)
  const target = allSessions.find((s) => s.sessionId === sessionId)

  if (!target) {
    throw new Error(`未找到会话 ID 为 "${sessionId}" 的物理目录或注册记录`)
  }

  if (target.isLive) {
    throw new Error(`会话 "${sessionId}" 的 openStep/pendingCalls 处于活跃状态，拒绝清理`)
  }

  const itemTrashDir = join(trashDir, sessionId)
  const trashDataDir = join(itemTrashDir, 'session-data')

  // 若回收站中已存在同名残留条目（例如上次移动中断/恢复失败留下的陈旧备份），
  // 先清除，避免 rename 目标目录已存在导致 EPERM，同时保证回收站与当前列表不重复显示。
  if (existsSync(itemTrashDir)) {
    await rm(itemTrashDir, { recursive: true, force: true })
    report.stepsDone.push('清除回收站同名残留条目')
  }

  await mkdir(itemTrashDir, { recursive: true })

  let targetWsId = null
  let projRecord = null

  if (workspaceJson?.tables?.workspaces) {
    for (const [wsId, ws] of Object.entries(workspaceJson.tables.workspaces)) {
      if (ws.sessionIds && ws.sessionIds.includes(sessionId)) {
        targetWsId = wsId
        break
      }
    }
  }

  if (projJson?.tables?.sessions?.[sessionId]) {
    projRecord = projJson.tables.sessions[sessionId]
  }

  const trashInfo = {
    sessionId,
    deletedAt: Date.now(),
    title: target.title,
    originalWorkspacePath: target.workspacePath,
    workspaceTitle: target.workspaceTitle,
    originalSessionDir: target.sessionDir,
    targetWsId,
    projRecord,
    isSubagent: target.isSubagent,
    isArchived: Boolean(target.isArchived),
  }

  await writeJsonFile(join(itemTrashDir, '.trash-info.json'), trashInfo)
  report.stepsDone.push('写入回收站元数据 .trash-info.json')

  if (existsSync(target.sessionDir)) {
    await rename(target.sessionDir, trashDataDir)
    report.stepsDone.push(`移动物理目录 ${target.sessionDir} -> ${trashDataDir}`)
  }

  if (workspaceJson?.tables?.workspaces && targetWsId) {
    const ws = workspaceJson.tables.workspaces[targetWsId]
    if (ws.sessionIds) {
      ws.sessionIds = ws.sessionIds.filter((id) => id !== sessionId)
    }
  }
  if (workspaceJson?.global?.archivedSessionIds) {
    workspaceJson.global.archivedSessionIds = workspaceJson.global.archivedSessionIds.filter((id) => id !== sessionId)
  }
  if (workspaceJson && targetWsId) {
    await writeJsonFile(wsJsonPath, workspaceJson)
    report.stepsDone.push('从 workspace.json 移除 sessionIds 及 archivedSessionIds 条目')
  }

  if (projJson?.tables?.sessions?.[sessionId]) {
    delete projJson.tables.sessions[sessionId]
    await writeJsonFile(projPath, projJson)
    report.stepsDone.push('从 session_projcache.json 移除对应投影 Checkpoint')
  }

  report.success = true
  return report
}

export async function restoreFromTrash(dshHome, sessionId, options = {}) {
  assertSafeSessionId(sessionId)
  const trashDirName = options.trashDirName || DEFAULT_CONFIG.trashDirName
  const trashDir = join(dshHome, trashDirName)
  const itemTrashDir = join(trashDir, sessionId)
  const infoPath = join(itemTrashDir, '.trash-info.json')
  const trashDataDir = join(itemTrashDir, 'session-data')

  if (!existsSync(itemTrashDir) || !existsSync(infoPath)) {
    throw new Error(`回收站中未找到会话 "${sessionId}" 的恢复备份`)
  }

  const info = await readJsonFile(infoPath)
  const report = { sessionId, success: false, stepsDone: [] }

  if (existsSync(trashDataDir) && info.originalSessionDir) {
    await mkdir(dirname(info.originalSessionDir), { recursive: true })
    await rename(trashDataDir, info.originalSessionDir)
    report.stepsDone.push(`还原物理目录 -> ${info.originalSessionDir}`)
  }

  const storagesDir = join(dshHome, 'storages')
  const wsJsonPath = join(storagesDir, 'workspace.json')
  const workspaceJson = await readJsonFile(wsJsonPath)

  let wsChanged = false
  if (workspaceJson?.tables?.workspaces && info.targetWsId) {
    const ws = workspaceJson.tables.workspaces[info.targetWsId]
    if (ws && Array.isArray(ws.sessionIds)) {
      if (!ws.sessionIds.includes(sessionId)) {
        ws.sessionIds.push(sessionId)
        wsChanged = true
      }
    }
  }
  // 归档状态还原：移入回收站前为归档会话时，恢复后回到归档区（保留 accounting slot）
  if (info.isArchived && workspaceJson) {
    workspaceJson.global ||= {}
    if (!Array.isArray(workspaceJson.global.archivedSessionIds)) workspaceJson.global.archivedSessionIds = []
    if (!workspaceJson.global.archivedSessionIds.includes(sessionId)) {
      workspaceJson.global.archivedSessionIds.push(sessionId)
      wsChanged = true
    }
  }
  if (wsChanged) {
    await writeJsonFile(wsJsonPath, workspaceJson)
    report.stepsDone.push('还原 workspace.json 中的 sessionIds / archivedSessionIds 属性')
  }

  const projPath = join(storagesDir, 'session_projcache.json')
  const projJson = await readJsonFile(projPath)
  if (projJson?.tables?.sessions && info.projRecord) {
    projJson.tables.sessions[sessionId] = info.projRecord
    await writeJsonFile(projPath, projJson)
    report.stepsDone.push('还原 session_projcache.json 中的 Checkpoint 属性')
  }

  await rm(itemTrashDir, { recursive: true, force: true })
  report.stepsDone.push('清除回收站备份临时节点')

  report.success = true
  return report
}

export async function purgeTrash(dshHome, sessionId, confirm, options = {}) {
  const trashDirName = options.trashDirName || DEFAULT_CONFIG.trashDirName
  const trashDir = join(dshHome, trashDirName)

  if (confirm === 'PURGE-ALL') {
    if (existsSync(trashDir)) {
      await rm(trashDir, { recursive: true, force: true })
      await mkdir(trashDir, { recursive: true })
    }
    return { success: true, message: '已彻底清空回收站' }
  }

  if (confirm !== 'PURGE') {
    throw new Error('彻底删除需要确认参数 confirm: "PURGE"')
  }

  assertSafeSessionId(sessionId)
  const itemTrashDir = join(trashDir, sessionId)
  if (!existsSync(itemTrashDir)) {
    throw new Error(`回收站中不存在会话 "${sessionId}"`)
  }

  await rm(itemTrashDir, { recursive: true, force: true })
  return { success: true, message: `已彻底删除回收站条目 ${sessionId}` }
}

/** 清理所有在回收站中滞留超过 retentionDays 天的条目 (定期清空) */
export async function purgeExpiredTrash(dshHome, retentionDays = DEFAULT_CONFIG.retentionDays, options = {}) {
  const trashDirName = options.trashDirName || DEFAULT_CONFIG.trashDirName
  const trashDir = join(dshHome, trashDirName)
  const purged = []

  if (!existsSync(trashDir) || !(retentionDays > 0)) return { purged }

  const cutoff = Date.now() - retentionDays * 86400000
  let entries = []
  try {
    entries = await readdir(trashDir, { withFileTypes: true })
  } catch {
    return { purged }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionId = entry.name
    try {
      const info = (await readJsonFile(join(trashDir, sessionId, '.trash-info.json'))) || {}
      if (info.deletedAt && info.deletedAt > 0 && info.deletedAt <= cutoff) {
        await rm(join(trashDir, sessionId), { recursive: true, force: true })
        purged.push({ sessionId, title: info.title || sessionId })
      }
    } catch {}
  }

  return { purged }
}

// ---------------------------------------------------------------------------
// 自包含 HTML 管理界面生成器 (主题与 DSH 主体一致 + 回收站定期清空设置)
// ---------------------------------------------------------------------------

export function renderManagerHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-ds-theme="system">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH 会话清理与回收站管理器</title>
  <style>
    /* ===== DSH design-platform 设计令牌 (与主界面逐字一致) ===== */
    :root{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#679efe;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f5f6f7;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-900:#570c0c--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-00);--dsw-alias-bg-mask-1:#0000003d;--dsw-alias-bg-mask-2:#0000001f;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#ffffffb3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-bluish-60);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-150);--dsw-alias-bg-skeleton:#0000000a;--dsw-alias-border-inverted2:#0000;--dsw-alias-border-inverted:#0000;--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2-darkmode-thin:#0000001a;--dsw-alias-border-l2:#0000001a;--dsw-alias-border-l3:#0000001f;--dsw-alias-border-l4:#00000029;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-primary-new-colorprimary-new-color:#4176e6;--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-1000);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-00);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-75);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-500);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-150);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-500);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-400);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#2631481a;--dsw-alias-interactive-bg-hover-accent:#26314824;--dsw-alias-interactive-bg-hover-danger:#ec13130d;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-75);--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-400);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-200);--dsw-alias-label-primary-bluish:var(--dsw-static-blue-900);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-950);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-00);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-700);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-600);--dsw-alias-link:var(--dsw-static-deepseek-500);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-100);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-50);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-00);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-75);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-50);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-60);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-75);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-200);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-300);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-300);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-500);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-100);--dsw-alias-state-error-primary:var(--dsw-static-red-600);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-100);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-100);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-800);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-850);--dsw-specific-bubble-highlight:var(--dsw-static-deepseek-200);--dsw-specific-bubble:var(--dsw-static-deepseek-50);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-00);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-50);--dsw-specific-menu:var(--dsw-alias-bg-layer-3);--dsw-specific-selector:var(--dsw-static-neutral-bluish-60);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-50);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-deepseek-100);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-100);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-75);--dsw-specific-tip:var(--dsw-static-neutral-bluish-60)}
    :root[data-ds-theme="dark"]{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#679efe;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f9fafb;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-900:#570c0c--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-850);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-mask-1:#00000080;--dsw-alias-bg-mask-2:#0003;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#272730b3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-850);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-skeleton:#ffffff14;--dsw-alias-border-inverted2:#ffffff14;--dsw-alias-border-inverted:#ffffff0f;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2-darkmode-thin:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-border-l4:#fff3;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-primary-new-colorprimary-new-color:var(--dsw-static-deepseek-450);--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-850);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-800);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-600);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-400);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-500);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#ffffff24;--dsw-alias-interactive-bg-hover-accent:#ffffff3d;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-800);--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-link:var(--dsw-static-deepseek-400);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-800);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-850);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-700);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-550);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-400);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-state-error-primary:var(--dsw-static-red-400);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-900);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-900);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble-highlight:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble:var(--dsw-static-neutral-bluish-850);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-850);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-900);--dsw-specific-menu:var(--dsw-alias-bg-layer-3);--dsw-specific-selector:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-900);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-750);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-850);--dsw-specific-tip:var(--dsw-static-neutral-bluish-800)}
    @media (prefers-color-scheme: dark){
      :root:not([data-ds-theme]), :root[data-ds-theme="system"]{--dsw-static-amber-100:#fef5e7;--dsw-static-amber-400:#f7ad31;--dsw-static-amber-500:#f59e0b;--dsw-static-amber-600:#dd8629;--dsw-static-amber-900:#27241f;--dsw-static-blue-100:#dbeafe;--dsw-static-blue-300:#93c5fd;--dsw-static-blue-400:#60a5fa;--dsw-static-blue-450:#4d93f8;--dsw-static-blue-500:#3b82f6;--dsw-static-blue-50:#eff6ff;--dsw-static-blue-50p:#eaf3ff;--dsw-static-blue-600:#2563eb;--dsw-static-blue-75:#e5f0ff;--dsw-static-blue-800:#1e40af;--dsw-static-blue-900:#0e3074;--dsw-static-blue-950:#172554;--dsw-static-deepseek-100:#e4edfd;--dsw-static-deepseek-200:#d3e2ff;--dsw-static-deepseek-300:#b7c8fe;--dsw-static-deepseek-400:#679efe;--dsw-static-deepseek-450:#5686fe;--dsw-static-deepseek-500:#4176e6;--dsw-static-deepseek-50:#edf3fe;--dsw-static-deepseek-600:#4868b2;--dsw-static-deepseek-700-delete:#2f4c8f;--dsw-static-deepseek-800:#34415b;--dsw-static-deepseek-900:#283142;--dsw-static-green-100:#e6faed;--dsw-static-green-400:#4ed17e;--dsw-static-green-500:#22c55e;--dsw-static-green-900:#233c2c;--dsw-static-neutral-00:#fff;--dsw-static-neutral-1000:#000;--dsw-static-neutral-100:#f5f5f5;--dsw-static-neutral-150:#ededed;--dsw-static-neutral-200:#e5e5e5;--dsw-static-neutral-250:#dcdcdc;--dsw-static-neutral-300:#d4d4d4;--dsw-static-neutral-400:#a2a4a6;--dsw-static-neutral-500:#7f8287;--dsw-static-neutral-50:#fafafa;--dsw-static-neutral-550:#65676b;--dsw-static-neutral-600:#545557;--dsw-static-neutral-700:#3c3c3d;--dsw-static-neutral-800:#292929;--dsw-static-neutral-850:#212123;--dsw-static-neutral-900:#0f0f0f;--dsw-static-neutral-bluish-00:#fff;--dsw-static-neutral-bluish-1000:#0f1115;--dsw-static-neutral-bluish-100:#ebeef2;--dsw-static-neutral-bluish-150:#e9ecf2;--dsw-static-neutral-bluish-200:#e1e5ee;--dsw-static-neutral-bluish-300:#cfd3d6;--dsw-static-neutral-bluish-400:#adb2b8;--dsw-static-neutral-bluish-500:#979da6;--dsw-static-neutral-bluish-50:#f9fafb;--dsw-static-neutral-bluish-600:#81858c;--dsw-static-neutral-bluish-60:#f9fafb;--dsw-static-neutral-bluish-700:#61666b;--dsw-static-neutral-bluish-750:#43454a;--dsw-static-neutral-bluish-75:#f1f3f5;--dsw-static-neutral-bluish-800:#353638;--dsw-static-neutral-bluish-850:#2c2c2e;--dsw-static-neutral-bluish-875:#232324;--dsw-static-neutral-bluish-900:#1b1b1c;--dsw-static-neutral-bluish-950:#151517;--dsw-static-red-100:#fee2e2;--dsw-static-red-400:#f25a5a;--dsw-static-red-500:#ef4444;--dsw-static-red-50:#fef2f2;--dsw-static-red-600:#ec1313;--dsw-static-red-900:#570c0c--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950);--dsw-alias-bg-layer-1:var(--dsw-static-neutral-bluish-875);--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-850);--dsw-alias-bg-layer-3:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-mask-1:#00000080;--dsw-alias-bg-mask-2:#0003;--dsw-alias-bg-mask-3:#0000007a;--dsw-alias-bg-mask-photo:#000000e0;--dsw-alias-bg-mask-drop:#272730b3;--dsw-alias-bg-module-platform:var(--dsw-static-neutral-bluish-800);--dsw-alias-bg-multi-select:var(--dsw-static-neutral-850);--dsw-alias-bg-overlay:var(--dsw-static-neutral-bluish-700);--dsw-alias-bg-skeleton:#ffffff14;--dsw-alias-border-inverted2:#ffffff14;--dsw-alias-border-inverted:#ffffff0f;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2-darkmode-thin:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-border-l3:#ffffff29;--dsw-alias-border-l4:#fff3;--dsw-alias-brand-primary-invert:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-primary-new-colorprimary-new-color:var(--dsw-static-deepseek-450);--dsw-alias-brand-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-brand-text:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-contrast-fill:var(--dsw-static-neutral-bluish-50);--dsw-alias-button-elevated-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-floating-fill:var(--dsw-static-neutral-bluish-850);--dsw-alias-button-floating-hover:var(--dsw-static-neutral-bluish-800);--dsw-alias-button-ghost-active-border:var(--dsw-static-neutral-bluish-600);--dsw-alias-button-ghost-active-fill:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-ghost-active-hover:var(--dsw-static-neutral-bluish-700);--dsw-alias-button-info-fill:var(--dsw-static-deepseek-400);--dsw-alias-button-info-hover:var(--dsw-static-deepseek-500);--dsw-alias-button-primary-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-button-primary-fill:var(--dsw-alias-brand-primary);--dsw-alias-button-primary-hover:var(--dsw-static-neutral-bluish-100);--dsw-alias-button-tool-bar-fill-invisible:#1f1f1f5c;--dsw-alias-button-tool-bar-fill:#54555780;--dsw-alias-button-tool-bar-hover:#54555799;--dsw-alias-interactive-bg-active:#ffffff24;--dsw-alias-interactive-bg-hover-accent:#ffffff3d;--dsw-alias-interactive-bg-hover-danger:#f25a5a26;--dsw-alias-interactive-bg-hover-solid:var(--dsw-static-neutral-bluish-800);--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-label-caption:var(--dsw-static-neutral-bluish-600);--dsw-alias-label-dimmed:var(--dsw-static-neutral-bluish-750);--dsw-alias-label-primary-bluish:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-primary-dimmed:var(--dsw-static-neutral-bluish-100);--dsw-alias-label-primary-foreground:var(--dsw-static-neutral-bluish-1000);--dsw-alias-label-primary-inverted:var(--dsw-static-neutral-bluish-800);--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-50);--dsw-alias-label-secondary:var(--dsw-static-neutral-bluish-300);--dsw-alias-label-tertiary:var(--dsw-static-neutral-bluish-400);--dsw-alias-link:var(--dsw-static-deepseek-400);--dsw-alias-markdown-citation:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-block-banner:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-code-block:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-code-segment-selected:var(--dsw-static-neutral-bluish-800);--dsw-alias-markdown-code-segment-unselected:var(--dsw-static-neutral-bluish-900);--dsw-alias-markdown-inline-code:var(--dsw-static-neutral-800);--dsw-alias-markdown-placeholder:var(--dsw-static-neutral-bluish-850);--dsw-alias-markdown-tag:var(--dsw-static-neutral-bluish-850);--dsw-alias-scrollbar-bg-l1:var(--dsw-static-neutral-700);--dsw-alias-scrollbar-bg-l2:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l1:var(--dsw-static-neutral-600);--dsw-alias-scrollbar-hover-l2:var(--dsw-static-neutral-550);--dsw-alias-state-business-primary:var(--dsw-static-deepseek-400);--dsw-alias-state-business-tertiary:var(--dsw-static-deepseek-800);--dsw-alias-state-error-primary:var(--dsw-static-red-400);--dsw-alias-state-error-secondary:var(--dsw-static-red-400);--dsw-alias-state-success-primary:var(--dsw-static-green-500);--dsw-alias-state-success-secondary:var(--dsw-static-green-400);--dsw-alias-state-success-tertiary:var(--dsw-static-green-900);--dsw-alias-state-warn-label:var(--dsw-static-amber-600);--dsw-alias-state-warn-primary:var(--dsw-static-amber-500);--dsw-alias-state-warn-secondary:var(--dsw-static-amber-400);--dsw-alias-state-warn-tertiary:var(--dsw-static-amber-900);--dsw-alias-toast-bg:var(--dsw-static-neutral-bluish-750);--dsw-alias-tooltip-bg:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble-highlight:var(--dsw-static-neutral-bluish-750);--dsw-specific-bubble:var(--dsw-static-neutral-bluish-850);--dsw-specific-input-major:var(--dsw-static-neutral-bluish-850);--dsw-specific-login-input:var(--dsw-static-neutral-bluish-900);--dsw-specific-menu:var(--dsw-alias-bg-layer-3);--dsw-specific-selector:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-900);--dsw-specific-sidebar-nav-item-active-accent:var(--dsw-static-neutral-bluish-800);--dsw-specific-sidebar-nav-item-active:var(--dsw-static-neutral-bluish-750);--dsw-specific-sidebar-nav-item-hover:var(--dsw-static-neutral-bluish-850);--dsw-specific-tip:var(--dsw-static-neutral-bluish-800)}
    }
    :root{
      --dsw-font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
      --ds-font-family-code:"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
      --ds-ease-in-out:cubic-bezier(.4, 0, .2, 1);
      --ds-transition-duration:.2s;
      --ds-transition-duration-fast:.1s;
      --ds-transition-duration-slow:.3s;
      --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l1);
      --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l1);
      --dsh-scrollbar-width:8px;
    }
    body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
    ::-webkit-scrollbar{width:8px;height:8px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb);border-radius:4px}
    ::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover)}
    ::-webkit-scrollbar-corner{background:transparent}

    /* ===== 组件样式 ===== */
    body {
      margin: 0; padding: 24px;
      font-family: var(--dsw-font-family);
      font-size: 14px; line-height: 1.6;
    }
    h1, h2 { margin: 0; font-weight: 600; color: var(--dsw-alias-label-primary); }
    h1 { font-size: 20px; line-height: 30px; }
    h2 { font-size: 16px; line-height: 26px; }
    .header { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 20px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding-bottom: 16px; flex-wrap: wrap; }
    .header-sub { color: var(--dsw-alias-label-tertiary); font-size: 13px; margin-top: 4px; }
    .header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .stats-bar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .stat-card { background: var(--dsw-alias-bg-module-platform); padding: 12px 18px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08)); }
    .stat-val { font-size: 20px; font-weight: 700; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
    .stat-val.warn { color: var(--dsw-alias-state-warn-primary); }
    .stat-lbl { font-size: 12px; color: var(--dsw-alias-label-tertiary); }

    .search-box { width: 100%; max-width: 400px; padding: 9px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 14px; margin-bottom: 20px; box-sizing: border-box; transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
    .search-box:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
    .search-box::placeholder { color: var(--dsw-alias-label-tertiary); }

    .card { background: var(--dsw-alias-bg-module-platform); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 14px; text-align: left; border-bottom: .5px solid var(--dsw-alias-border-l2); font-size: 13px; vertical-align: middle; }
    th { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-weight: 600; font-size: 12px; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tr.collision-row { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
    tr.trash-expired-row { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
    tbody tr { transition: background var(--ds-transition-duration-fast) var(--ds-ease-in-out); }
    tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .muted { color: var(--dsw-alias-label-tertiary); }
    code, .sid, .mono { font-family: var(--ds-font-family-code); }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 18px; margin-right: 4px; }
    .badge-live { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); color: var(--dsw-alias-state-error-primary); border: .5px solid var(--dsw-alias-state-error-primary); }
    .badge-collision { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); border: .5px solid var(--dsw-alias-state-warn-primary); }
    .badge-archived { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent); color: var(--dsw-alias-state-business-primary); border: .5px solid var(--dsw-alias-state-business-primary); }
    .badge-subagent { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary); border: .5px solid var(--dsw-alias-brand-primary); }
    .badge-unreg { background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 16%, transparent); color: var(--dsw-alias-label-tertiary); border: .5px solid var(--dsw-alias-label-tertiary); }
    .badge-expired { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 20%, transparent); color: var(--dsw-alias-state-warn-primary); border: .5px solid var(--dsw-alias-state-warn-primary); }
    .badge-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color: var(--dsw-alias-state-success-primary); border: .5px solid var(--dsw-alias-state-success-primary); }

    .btn { display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: 8px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity .15s var(--ds-ease-in-out), background .15s var(--ds-ease-in-out); font-family: var(--dsw-font-family); }
    .btn:hover { opacity: .88; }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .btn-danger { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
    .btn-danger-ghost { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: var(--dsw-alias-state-error-primary); border: .5px solid var(--dsw-alias-state-error-primary); }
    .btn-secondary { background: var(--dsw-alias-button-tool-bar-fill); color: var(--dsw-alias-label-primary); border: .5px solid var(--dsw-alias-border-l3); }
    .btn-success { background: var(--dsw-alias-state-success-primary); color: #fff; }
    .btn-brand { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground, #fff); }

    .sid { background: var(--dsw-alias-bg-layer-2); padding: 2px 6px; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-link); font-size: 12px; }
    .sid:hover { text-decoration: underline; }

    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: var(--dsw-alias-bg-mask-3, rgba(0,0,0,.7)); backdrop-filter: blur(4px); display: none; justify-content: center; align-items: center; z-index: 1000; }
    .modal { background: var(--dsw-alias-bg-module-platform); width: 600px; max-width: calc(100vw - 32px); border-radius: 14px; padding: 24px; border: 1px solid var(--dsw-alias-border-l3); box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.35)); }
    .modal-header { font-size: 18px; font-weight: 700; margin-bottom: 14px; color: var(--dsw-alias-state-error-primary); display: flex; align-items: center; gap: 8px; }
    .modal-body { font-size: 14px; line-height: 1.6; color: var(--dsw-alias-label-primary); }
    .info-grid { background: var(--dsw-alias-bg-layer-2); padding: 12px; border-radius: 8px; margin: 12px 0; font-family: var(--ds-font-family-code); font-size: 12px; white-space: pre-wrap; word-break: break-all; }
    .collision-alert { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); border-left: 4px solid var(--dsw-alias-state-warn-primary); padding: 12px; margin: 12px 0; border-radius: 8px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }

    .section { margin-top: 32px; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .trash-notice { color: var(--dsw-alias-label-tertiary); font-size: 12px; margin-bottom: 10px; }

    /* 回收站设置卡片 */
    .settings-card { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-module-platform); margin-bottom: 14px; }
    .settings-item { display: flex; align-items: center; gap: 8px; }
    .settings-label { font-size: 13px; color: var(--dsw-alias-label-primary); display: flex; align-items: center; gap: 6px; }
    .settings-desc { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
    .num-input { width: 76px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; font-variant-numeric: tabular-nums; }
    .num-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
    .toggle { position: relative; width: 38px; height: 22px; border-radius: 999px; border: none; background: var(--dsw-alias-border-l3); cursor: pointer; transition: background .15s var(--ds-ease-in-out); padding: 0; }
    .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-alias-bg-module-platform); box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .15s var(--ds-ease-in-out); }
    .toggle[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
    .toggle[aria-checked="true"]::after { transform: translateX(16px); }

    /* 主题切换 */
    .theme-select { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; font-family: var(--dsw-font-family); }

    /* 预览 */
    .prev-stat-pill { display: flex; gap: 12px; align-items: center; font-size: 12px; background: var(--dsw-alias-bg-layer-2); padding: 6px 12px; border-radius: 10px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); }
    .prev-block { border-left: 4px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); padding: 8px 12px; margin: 6px 0; border-radius: 6px; font-family: var(--ds-font-family-code); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto; }
    .prev-block.warn { border-left-color: var(--dsw-alias-state-warn-primary); }
    .prev-block.success { border-left-color: var(--dsw-alias-state-success-primary); }
    .empty-row { text-align: center; color: var(--dsw-alias-label-tertiary); padding: 28px 0; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🗑️ DSH 会话清理与回收站管理器</h1>
      <div class="header-sub">安全清理 · 防误删重名保障 · 对话内容预览 · 可逆恢复 · 定期自动清空</div>
    </div>
    <div class="header-actions">
      <button class="btn btn-secondary" id="view-toggle" onclick="toggleView()">🗑️ 回收站</button>
      <select id="theme-select" class="theme-select" title="界面主题" onchange="setThemeMode(this.value)">
        <option value="system">🌓 跟随系统</option>
        <option value="light">☀️ 浅色</option>
        <option value="dark">🌙 深色</option>
      </select>
      <button class="btn btn-secondary" onclick="loadAll()">🔄 刷新列表</button>
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-card"><div class="stat-val" id="st-total">0</div><div class="stat-lbl">总会话数</div></div>
    <div class="stat-card"><div class="stat-val" id="st-size">0 B</div><div class="stat-lbl">占用磁盘大小</div></div>
    <div class="stat-card"><div class="stat-val" id="st-trash">0</div><div class="stat-lbl">回收站条目</div></div>
    <div class="stat-card"><div class="stat-val warn" id="st-expired">0</div><div class="stat-lbl">已过期条目</div></div>
  </div>

  <input type="text" id="search" class="search-box" placeholder="搜索标题、Session ID 或工作区路径..." oninput="renderSessions()">

  <div class="section" id="sessions-section">
    <div class="section-head"><h2>会话列表 (Sessions)</h2><span class="muted" style="font-size:12px;">已归档会话可移入回收站；恢复时保留归档状态</span></div>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>状态/标记</th>
            <th>会话标题</th>
            <th>Session ID (点击复制)</th>
            <th>创建时间</th>
            <th>轮次/步骤</th>
            <th>占用大小</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="sessions-tbl"></tbody>
      </table>
    </div>
  </div>

  <div class="section" id="trash-section">
    <div class="section-head">
      <h2>回收站 (Trash)</h2>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-danger-ghost" onclick="purgeExpired()" id="btn-purge-expired" disabled>🧹 立即清理已过期</button>
        <button class="btn btn-danger" onclick="purgeAll()">清空回收站</button>
      </div>
    </div>

    <div class="settings-card">
      <div class="settings-item">
        <button class="toggle" id="auto-purge-toggle" role="switch" aria-checked="true" onclick="togglePurge()"></button>
        <div>
          <div class="settings-label">定期自动清空</div>
          <div class="settings-desc">会话移入回收站后，超过保留天数自动彻底删除</div>
        </div>
      </div>
      <div class="settings-item">
        <label class="settings-label" for="retention-days">保留天数</label>
        <input type="number" id="retention-days" class="num-input" min="1" max="3650" value="30">
        <span class="settings-desc">天</span>
      </div>
      <div class="settings-item">
        <label class="settings-label" for="purge-interval">检查间隔</label>
        <input type="number" id="purge-interval" class="num-input" min="15" max="1440" value="60">
        <span class="settings-desc">分钟</span>
      </div>
      <div style="margin-left:auto; display:flex; gap:8px;">
        <button class="btn btn-secondary" onclick="saveSettings()">💾 保存设置</button>
      </div>
    </div>
    <div class="trash-notice" id="settings-note">加载中...</div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>会话标题 / ID</th>
            <th>原工作区</th>
            <th>删除时间</th>
            <th>自动清除</th>
            <th>大小</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="trash-tbl"></tbody>
      </table>
    </div>
  </div>

  <div class="modal-overlay" id="confirm-modal">
    <div class="modal">
      <div class="modal-header">⚠️ 确认移入回收站</div>
      <div class="modal-body">
        您即将将以下会话移入回收站 (移入后可从回收站还原)：
        <div class="info-grid" id="modal-target-info"></div>

        <div id="modal-collision-warning" class="collision-alert" style="display:none;">
          <strong>⚠️ 关键提示：检测到存在同名冲突会话！</strong><br>
          系统已精准定位到您的目标 ID。为防止删错同名任务，请对照以下另一同名会话的完整信息：
          <div style="margin-top: 6px; font-size: 12px;" id="modal-other-info"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn btn-danger" id="modal-confirm-btn">确认删除 (移入回收站)</button>
      </div>
    </div>
  </div>

  <script>
    let rawSessions = [];
    let rawTrash = [];
    let settings = { autoPurgeEnabled: true, retentionDays: 30, purgeIntervalMinutes: 60 };

    /* ---------- 主题 (与 DSH 主体一致，默认跟随系统) ---------- */
    function applyThemeMode(mode) {
      const root = document.documentElement;
      if (mode === 'dark') root.setAttribute('data-ds-theme', 'dark');
      else if (mode === 'light') root.setAttribute('data-ds-theme', 'light');
      else root.removeAttribute('data-ds-theme');
      const sel = document.getElementById('theme-select');
      if (sel) sel.value = mode || 'system';
    }
    function setThemeMode(mode) {
      localStorage.setItem('sc-theme-mode', mode || 'system');
      applyThemeMode(mode || 'system');
    }
    (function initTheme() {
      const saved = localStorage.getItem('sc-theme-mode');
      applyThemeMode(saved || 'system');
    })();

    async function loadAll() {
      try {
        const [resS, resT, resSettings] = await Promise.all([
          fetch('/api/session-cleaner/sessions').then(r => r.json()),
          fetch('/api/session-cleaner/trash').then(r => r.json()),
          fetch('/api/session-cleaner/settings').then(r => r.json())
        ]);
        if (resS.success) rawSessions = resS.sessions;
        if (resT.success) {
          rawTrash = resT.trash || [];
          if (resT.settings) {
            settings.autoPurgeEnabled = resT.settings.autoPurgeEnabled;
            settings.retentionDays = resT.settings.retentionDays;
            settings.purgeIntervalMinutes = resT.settings.purgeIntervalMinutes;
          }
        }
        if (resSettings.success) {
          settings.autoPurgeEnabled = resSettings.settings.autoPurgeEnabled;
          settings.retentionDays = resSettings.settings.retentionDays;
          settings.purgeIntervalMinutes = resSettings.settings.purgeIntervalMinutes;
        }
        updateStats();
        renderSessions();
        renderTrash();
        renderSettings();
        checkHashAnchor();
      } catch (err) {
        alert('加载会话列表失败: ' + err.message);
      }
    }

    /* ---------- 视图切换：回收站页面(#trash)只展示回收站，不展示工作区会话列表 ---------- */
    function applyView() {
      const trashMode = window.location.hash === '#trash';
      const sec = document.getElementById('sessions-section');
      const search = document.getElementById('search');
      const toggle = document.getElementById('view-toggle');
      if (sec) sec.style.display = trashMode ? 'none' : '';
      if (search) search.style.display = trashMode ? 'none' : '';
      if (toggle) toggle.innerText = trashMode ? '💬 会话列表' : '🗑️ 回收站';
      if (trashMode) {
        const trashSec = document.getElementById('trash-section');
        if (trashSec) trashSec.scrollIntoView({ behavior: 'smooth' });
      }
    }

    function toggleView() {
      if (window.location.hash === '#trash') {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } else {
        window.location.hash = '#trash';
      }
      applyView();
    }

    window.addEventListener('hashchange', applyView);

    function checkHashAnchor() {
      applyView();
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatDate(ts) {
      if (!ts) return '未知';
      return new Date(ts).toLocaleString('zh-CN');
    }

    function daysLeftOf(expiresAt) {
      if (!expiresAt) return null;
      return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000));
    }

    function updateStats() {
      document.getElementById('st-total').innerText = rawSessions.length;
      const totalBytes = rawSessions.reduce((acc, s) => acc + (s.dirSize || 0), 0) + rawTrash.reduce((acc, t) => acc + (t.dirSize || 0), 0);
      document.getElementById('st-size').innerText = formatBytes(totalBytes);
      document.getElementById('st-trash').innerText = rawTrash.length;
      const expiredCount = rawTrash.filter(t => t.expired).length;
      document.getElementById('st-expired').innerText = expiredCount;
      document.getElementById('btn-purge-expired').disabled = expiredCount === 0;
    }

    function renderSessions() {
      const q = document.getElementById('search').value.toLowerCase();
      const filtered = rawSessions.filter(s =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.sessionId || '').toLowerCase().includes(q) ||
        (s.workspacePath || '').toLowerCase().includes(q)
      );

      const tbody = document.getElementById('sessions-tbl');
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-row">没有匹配的会话</td></tr>';
        return;
      }
      let html = '';
      filtered.forEach(s => {
        let badges = '';
        if (s.isLive) badges += '<span class="badge badge-live">活跃运行中</span> ';
        if (s.isArchived) badges += '<span class="badge badge-archived">已归档</span> ';
        if (s.titleCollision) badges += '<span class="badge badge-collision">同名冲突</span> ';
        if (s.isSubagent) badges += '<span class="badge badge-subagent">子代理</span> ';
        if (!s.isRegistered) badges += '<span class="badge badge-unreg">未注册目录</span> ';
        if (!badges) badges = '<span class="badge badge-ok">正常</span>';

        const longId = s.sessionId.length > 18;
        const shortId = longId ? s.sessionId.slice(0, 10) + '...' + s.sessionId.slice(-6) : s.sessionId;
        const rowClass = s.titleCollision ? 'collision-row' : '';

        html += \`<tr class="\${rowClass}">
          <td>\${badges}</td>
          <td><strong>\${escapeHtml(s.title)}</strong>\${s.subagentLabel ? '<br><small class="muted">' + escapeHtml(s.subagentLabel) + '</small>' : ''}</td>
          <td><span class="sid" title="点击复制完整 ID: \${s.sessionId}" onclick="copyId('\${s.sessionId}')">\${shortId}</span></td>
          <td class="muted">\${formatDate(s.createdAt)}</td>
          <td>\${s.turns} 轮 / \${s.steps} 步</td>
          <td>\${formatBytes(s.dirSize)}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-secondary" onclick="togglePreview('\${s.sessionId}', this)">💬 查看对话</button>
            <button class="btn btn-danger-ghost" style="margin-left:6px;" \${s.isLive ? 'disabled title="活跃会话无法删除"' : ''} onclick="openDeleteModal('\${s.sessionId}')">
              \${s.isLive ? '活跃锁定' : '移入回收站'}
            </button>
          </td>
        </tr>
        <tr id="prev-row-\${s.sessionId}" style="display:none;">
          <td colspan="7" id="prev-cell-\${s.sessionId}" style="background:var(--dsw-alias-bg-layer-2); padding:16px;"></td>
        </tr>\`;
      });
      tbody.innerHTML = html;
    }

    function renderTrash() {
      const tbody = document.getElementById('trash-tbl');
      const note = document.getElementById('settings-note');
      if (settings.autoPurgeEnabled && settings.retentionDays > 0) {
        note.innerText = '定期清空已启用：会话移入回收站 ' + settings.retentionDays + ' 天后将自动彻底删除，每 ' + settings.purgeIntervalMinutes + ' 分钟检查一次。';
      } else {
        note.innerText = '定期清空未启用：回收站条目将一直保留，直到手动恢复或彻底清除。';
      }

      if (rawTrash.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-row">回收站为空 🎉</td></tr>';
        return;
      }
      let html = '';
      rawTrash.forEach(t => {
        const badges = (t.isArchived ? '<span class="badge badge-archived">已归档</span> ' : '')
          + (t.isSubagent ? '<span class="badge badge-subagent">子代理</span> ' : '')
          + (t.expired ? '<span class="badge badge-expired">已过期</span> ' : '');
        const rowClass = t.expired ? 'trash-expired-row' : '';

        let clearInfo;
        if (!settings.autoPurgeEnabled || settings.retentionDays <= 0) {
          clearInfo = '<span class="muted">未启用</span>';
        } else if (!t.deletedAt) {
          clearInfo = '<span class="muted">—</span>';
        } else if (t.expired) {
          clearInfo = '<span style="color:var(--dsw-alias-state-warn-primary); font-weight:600;">已过期 · 将被自动清除</span>';
        } else {
          const left = daysLeftOf(t.expiresAt);
          clearInfo = '<span style="color:var(--dsw-alias-label-secondary);">剩 ' + left + ' 天</span>';
        }

        html += \`<tr class="\${rowClass}">
          <td><strong>\${escapeHtml(t.title)}</strong><br><small class="mono muted">\${t.sessionId}</small>\${badges}</td>
          <td class="muted">\${escapeHtml(t.originalWorkspacePath || '未知')}</td>
          <td class="muted">\${formatDate(t.deletedAt)}</td>
          <td>\${clearInfo}</td>
          <td>\${formatBytes(t.dirSize)}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-secondary" onclick="togglePreview('\${t.sessionId}', this)">💬 查看对话</button>
            <button class="btn btn-success" style="margin-left:6px;" onclick="restoreSession('\${t.sessionId}')">恢复</button>
            <button class="btn btn-danger-ghost" style="margin-left:6px;" onclick="purgeSession('\${t.sessionId}')">彻底清除</button>
          </td>
        </tr>
        <tr id="prev-row-\${t.sessionId}" style="display:none;">
          <td colspan="6" id="prev-cell-\${t.sessionId}" style="background:var(--dsw-alias-bg-layer-2); padding:16px;"></td>
        </tr>\`;
      });
      tbody.innerHTML = html;
    }

    function renderSettings() {
      document.getElementById('auto-purge-toggle').setAttribute('aria-checked', String(settings.autoPurgeEnabled));
      document.getElementById('retention-days').value = settings.retentionDays;
      document.getElementById('purge-interval').value = settings.purgeIntervalMinutes;
    }

    function togglePurge() {
      settings.autoPurgeEnabled = document.getElementById('auto-purge-toggle').getAttribute('aria-checked') !== 'true';
      renderSettings();
      saveSettings();
    }

    async function saveSettings() {
      const payload = {
        autoPurgeEnabled: document.getElementById('auto-purge-toggle').getAttribute('aria-checked') === 'true',
        retentionDays: parseInt(document.getElementById('retention-days').value, 10) || 30,
        purgeIntervalMinutes: parseInt(document.getElementById('purge-interval').value, 10) || 60
      };
      try {
        const res = await fetch('/api/session-cleaner/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(r => r.json());
        if (res.success) {
          settings = res.settings;
          renderSettings();
          renderTrash();
          updateStats();
        } else {
          alert('保存设置失败: ' + (res.error || '未知错误'));
        }
      } catch (err) {
        alert('请求失败: ' + err.message);
      }
    }

    async function purgeExpired() {
      try {
        const res = await fetch('/api/session-cleaner/purge-expired', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }).then(r => r.json());
        if (res.success) {
          alert('已清理 ' + (res.purged || []).length + ' 个过期条目');
          await loadAll();
        } else {
          alert('清理失败: ' + (res.error || '未知错误'));
        }
      } catch (err) {
        alert('请求失败: ' + err.message);
      }
    }

    async function togglePreview(sessionId, btn) {
      const prevRow = document.getElementById('prev-row-' + sessionId);
      const prevCell = document.getElementById('prev-cell-' + sessionId);
      if (!prevRow || !prevCell) return;

      if (prevRow.style.display !== 'none') {
        prevRow.style.display = 'none';
        btn.innerText = '💬 查看对话';
        return;
      }

      prevRow.style.display = 'table-row';
      btn.innerText = '🔼 收起对话';
      prevCell.innerHTML = '<div style="color:var(--dsw-alias-brand-primary);">⏳ 正在解压并读取对话记录...</div>';

      try {
        const res = await fetch('/api/session-cleaner/preview?sessionId=' + encodeURIComponent(sessionId)).then(r => r.json());
        if (!res.success || !res.preview) {
          prevCell.innerHTML = '<div style="color:var(--dsw-alias-state-error-primary);">⚠️ 无法加载对话预览: ' + escapeHtml(res.error || '未知错误') + '</div>';
          return;
        }
        const p = res.preview;
        let html = \`
          <div style="font-size:13px; line-height:1.5; color:var(--dsw-alias-label-primary);">
            <div style="display:flex; gap:16px; margin-bottom:10px; color:var(--dsw-alias-label-secondary); font-size:12px; flex-wrap:wrap;">
              <span>📅 创建时间: \${formatDate(p.createdAt)}</span>
              <span>⏱️ 最近活动: \${formatDate(p.lastActiveAt)}</span>
              <span>📁 工作目录: <code style="color:var(--dsw-alias-link);">\${escapeHtml(p.cwd || '未知')}</code></span>
            </div>
            <div class="prev-stat-pill" style="margin-bottom:12px;">
              <span><strong>\${p.turns}</strong> 轮对话</span> <span class="muted">|</span>
              <span><strong>\${p.userMessages}</strong> 条用户指令</span> <span class="muted">|</span>
              <span><strong>\${p.assistantMessages}</strong> 条助手回复</span> <span class="muted">|</span>
              <span><strong>\${p.toolCalls}</strong> 次工具调用</span>
            </div>
        \`;

        if (p.firstUserText) {
          html += \`
            <div style="margin-bottom:10px;">
              <strong style="color:var(--dsw-alias-brand-primary); font-size:13px;">💡 首条用户指令 (同名分辨核心)：</strong>
              <pre class="prev-block">\${escapeHtml(p.firstUserText)}</pre>
            </div>
          \`;
        }
        if (p.lastUserText && p.lastUserText !== p.firstUserText) {
          html += \`
            <div style="margin-bottom:10px;">
              <strong style="color:var(--dsw-alias-label-secondary); font-size:12px;">💬 最近用户指令：</strong>
              <pre class="prev-block warn">\${escapeHtml(p.lastUserText)}</pre>
            </div>
          \`;
        }
        if (p.lastAssistantText) {
          html += \`
            <div>
              <strong style="color:var(--dsw-alias-state-success-primary); font-size:12px;">🤖 最近助手回复：</strong>
              <pre class="prev-block success">\${escapeHtml(p.lastAssistantText)}</pre>
            </div>
          \`;
        }
        html += '</div>';
        prevCell.innerHTML = html;
      } catch (err) {
        prevCell.innerHTML = '<div style="color:var(--dsw-alias-state-error-primary);">⚠️ 请求失败: ' + escapeHtml(err.message) + '</div>';
      }
    }

    function copyId(id) {
      navigator.clipboard.writeText(id);
      alert('已复制 Session ID: ' + id);
    }

    function escapeHtml(str) {
      return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function openDeleteModal(sessionId) {
      const target = rawSessions.find(s => s.sessionId === sessionId);
      if (!target) return;

      document.getElementById('modal-target-info').innerHTML = \`
标题: \${escapeHtml(target.title)}\${target.isArchived ? '  [已归档]' : ''}
完整 ID: \${target.sessionId}
创建时间: \${formatDate(target.createdAt)}
磁盘大小: \${formatBytes(target.dirSize)}
工作区: \${escapeHtml(target.workspacePath)}
状态: \${target.isArchived ? '已归档' : (target.isLive ? '活跃运行中' : '正常')}
      \`;

      const warningEl = document.getElementById('modal-collision-warning');
      if (target.titleCollision) {
        const others = rawSessions.filter(s => s.title === target.title && s.sessionId !== target.sessionId);
        document.getElementById('modal-other-info').innerHTML = others.map(o => \`
- 另一同名会话 ID: \${o.sessionId}
  创建时间: \${formatDate(o.createdAt)} | 大小: \${formatBytes(o.dirSize)} | 工作区: \${escapeHtml(o.workspacePath)}
        \`).join('<br>');
        warningEl.style.display = 'block';
      } else {
        warningEl.style.display = 'none';
      }

      document.getElementById('modal-confirm-btn').onclick = () => doDelete(target.sessionId);
      document.getElementById('confirm-modal').style.display = 'flex';
    }

    function closeModal() {
      document.getElementById('confirm-modal').style.display = 'none';
    }

    async function doDelete(sessionId) {
      try {
        const res = await fetch('/api/session-cleaner/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, confirm: 'DELETE' })
        }).then(r => r.json());

        if (res.success) {
          closeModal();
          await loadAll();
        } else {
          alert('删除失败: ' + (res.error || '未知错误'));
        }
      } catch (err) {
        alert('请求失败: ' + err.message);
      }
    }

    async function restoreSession(sessionId) {
      try {
        const res = await fetch('/api/session-cleaner/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        }).then(r => r.json());

        if (res.success) {
          await loadAll();
        } else {
          alert('恢复失败: ' + (res.error || '未知错误'));
        }
      } catch (err) {
        alert('请求失败: ' + err.message);
      }
    }

    async function purgeSession(sessionId) {
      if (!confirm(\`确认彻底清除回收站中的会话 \${sessionId}？此操作不可逆！\`)) return;
      try {
        const res = await fetch('/api/session-cleaner/purge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, confirm: 'PURGE' })
        }).then(r => r.json());

        if (res.success) {
          await loadAll();
        } else {
          alert('彻底删除失败: ' + (res.error || '未知错误'));
        }
      } catch (err) {
        alert('请求失败: ' + err.message);
      }
    }

    async function purgeAll() {
      if (!confirm('确认彻底清空回收站中的所有项目？此操作不可逆！')) return;
      try {
        const res = await fetch('/api/session-cleaner/purge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'PURGE-ALL' })
        }).then(r => r.json());

        if (res.success) {
          await loadAll();
        } else {
          alert('清空失败: ' + (res.error || '未知错误'));
        }
      } catch (err) {
        alert('请求失败: ' + err.message);
      }
    }

    loadAll();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Cordis 宿主插件入口 (apply)
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }
  const verbose = Boolean(mergedConfig.verbose)

  const dshHome = config.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')

  if (verbose) {
    ctx.logger?.info(`[session-cleaner] 启动成功，dshHome: ${dshHome}`)
  }

  const disposers = []

  // -------------------------------------------------------------------------
  // 定期清空自动任务
  // -------------------------------------------------------------------------
  let currentSettings = { autoPurgeEnabled: mergedConfig.autoPurgeEnabled, retentionDays: mergedConfig.retentionDays, purgeIntervalMinutes: mergedConfig.purgeIntervalMinutes }
  let purgeTimer = null
  let purgeRunning = false
  let startupTimer = null

  const refreshSettings = async () => {
    try {
      currentSettings = await loadSettings(dshHome)
    } catch {}
    return currentSettings
  }

  const runAutoPurge = async () => {
    if (purgeRunning) return
    purgeRunning = true
    try {
      if (!currentSettings.autoPurgeEnabled || !(currentSettings.retentionDays > 0)) return
      const { purged } = await purgeExpiredTrash(dshHome, currentSettings.retentionDays, { trashDirName: mergedConfig.trashDirName })
      if (purged.length > 0 && verbose) {
        ctx.logger?.info(`[session-cleaner] 自动清空回收站 ${purged.length} 项: ${purged.map((p) => p.sessionId).join(', ')}`)
      }
    } catch (err) {
      if (verbose) ctx.logger?.warn(`[session-cleaner] 自动清空失败: ${err.message}`)
    } finally {
      purgeRunning = false
    }
  }

  const schedulePurgeTimer = () => {
    if (purgeTimer) clearInterval(purgeTimer)
    const intervalMs = Math.max(15, Math.min(1440, Number(currentSettings.purgeIntervalMinutes) || 60)) * 60000
    purgeTimer = setInterval(() => void runAutoPurge(), intervalMs)
    if (purgeTimer.unref) purgeTimer.unref()
  }

  refreshSettings().then((s) => {
    currentSettings = s
    schedulePurgeTimer()
    // 启动后延迟一次检查
    startupTimer = setTimeout(() => void runAutoPurge(), 10000)
    if (startupTimer.unref) startupTimer.unref()
    if (verbose) ctx.logger?.info(`[session-cleaner] 定期清空: ${currentSettings.autoPurgeEnabled ? `启用 (保留 ${currentSettings.retentionDays} 天, 每 ${currentSettings.purgeIntervalMinutes} 分钟)` : '关闭'}`)
  })

  ctx.inject(['webServer'], (childCtx) => {
    const ws = childCtx.webServer
    if (!ws) return

    const parsePostJson = (req) =>
      new Promise((resolve, reject) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          try {
            resolve(body ? JSON.parse(body) : {})
          } catch (e) {
            reject(new Error('非法 JSON 请求体'))
          }
        })
        req.on('error', reject)
      })

    // 路由 1: GET /api/session-cleaner/sessions
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/sessions',
        async handler(req, res) {
          try {
            const sessions = await listSessions(dshHome)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, sessions }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 2: GET /api/session-cleaner/trash
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/trash',
        async handler(req, res) {
          try {
            const settings = await refreshSettings()
            const trash = await listTrash(dshHome, { trashDirName: mergedConfig.trashDirName, retentionDays: settings.retentionDays })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, trash, settings }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 3: GET/POST /api/session-cleaner/settings (读取/保存定期清空设置)
    // 注：DSH webserver 路由按 (kind, path) 唯一注册，同路径不同 method 需合并处理
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/settings',
        async handler(req, res) {
          if (req.method === 'POST') {
            try {
              const payload = await parsePostJson(req)
              currentSettings = await saveSettings(dshHome, {
                autoPurgeEnabled: payload.autoPurgeEnabled,
                retentionDays: payload.retentionDays,
                purgeIntervalMinutes: payload.purgeIntervalMinutes,
              })
              schedulePurgeTimer()
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ success: true, settings: currentSettings }))
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ success: false, error: err.message }))
            }
            return
          }
          try {
            const settings = await refreshSettings()
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, settings }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 5: POST /api/session-cleaner/purge-expired
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/purge-expired',
        async handler(req, res) {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          try {
            const settings = await refreshSettings()
            const { purged } = await purgeExpiredTrash(dshHome, settings.retentionDays, { trashDirName: mergedConfig.trashDirName })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, purged }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 6: GET /api/session-cleaner/preview?sessionId=...
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/preview',
        async handler(req, res) {
          try {
            const urlObj = new URL(req.url, 'http://localhost')
            const sessionId = urlObj.searchParams.get('sessionId')
            if (!sessionId) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ success: false, error: '缺少 sessionId 参数' }))
              return
            }
            assertSafeSessionId(sessionId)

            let targetFile = null
            let source = null

            // 1. 查找回收站
            const trashDir = join(dshHome, mergedConfig.trashDirName, sessionId, 'session-data')
            if (existsSync(trashDir)) {
              if (existsSync(join(trashDir, 'session.jsonl.zstd'))) {
                targetFile = join(trashDir, 'session.jsonl.zstd')
                source = 'trash'
              } else if (existsSync(join(trashDir, 'session.jsonl'))) {
                targetFile = join(trashDir, 'session.jsonl')
                source = 'trash'
              }
            }

            // 2. 查找 sessions 目录
            if (!targetFile) {
              const sessionsDir = join(dshHome, 'sessions')
              if (existsSync(sessionsDir)) {
                let wsFolders = []
                try {
                  wsFolders = await readdir(sessionsDir, { withFileTypes: true })
                } catch {}
                for (const wsFolder of wsFolders) {
                  if (!wsFolder.isDirectory()) continue
                  const candidateDir = join(sessionsDir, wsFolder.name, sessionId)
                  if (existsSync(candidateDir)) {
                    if (existsSync(join(candidateDir, 'session.jsonl.zstd'))) {
                      targetFile = join(candidateDir, 'session.jsonl.zstd')
                      source = 'sessions'
                      break
                    } else if (existsSync(join(candidateDir, 'session.jsonl'))) {
                      targetFile = join(candidateDir, 'session.jsonl')
                      source = 'sessions'
                      break
                    }
                  }
                }
              }
            }

            if (!targetFile) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ success: false, error: `未找到 sessionId 为 "${sessionId}" 的会话日志` }))
              return
            }

            const preview = await extractSessionPreview(targetFile)
            if (preview.ok) {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ success: true, source, preview }))
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ success: false, error: preview.error || '解析日志元数据失败' }))
            }
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 7: POST /api/session-cleaner/delete
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/delete',
        async handler(req, res) {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          try {
            const payload = await parsePostJson(req)
            if (payload.confirm !== 'DELETE') {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ success: false, error: '必须包含 confirm: "DELETE" 参数' }))
              return
            }

            const report = await moveToTrash(dshHome, payload.sessionId, { trashDirName: mergedConfig.trashDirName })

            try {
              const wsReg = childCtx.get('workspaceRegistry')
              if (wsReg && wsReg.headers && typeof wsReg.headers.delete === 'function') {
                wsReg.headers.delete(payload.sessionId)
              }
            } catch {}

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, report }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 8: POST /api/session-cleaner/restore
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/restore',
        async handler(req, res) {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          try {
            const payload = await parsePostJson(req)
            const report = await restoreFromTrash(dshHome, payload.sessionId, { trashDirName: mergedConfig.trashDirName })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, report }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 9: POST /api/session-cleaner/purge
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/api/session-cleaner/purge',
        async handler(req, res) {
          if (req.method !== 'POST') {
            res.writeHead(405)
            res.end()
            return
          }
          try {
            const payload = await parsePostJson(req)
            const result = await purgeTrash(dshHome, payload.sessionId, payload.confirm, { trashDirName: mergedConfig.trashDirName })
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, ...result }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

    // 路由 10: GET /session-cleaner (管理页面)
    disposers.push(
      ws.register({
        kind: 'exact',
        path: '/session-cleaner',
        async handler(req, res) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderManagerHtml())
        },
      })
    )

    // -----------------------------------------------------------------------
    // 前端 UI 脚本注入 (通过 childCtx.on('webserver/index-inject') 监听事件)
    // -----------------------------------------------------------------------
    const unbindInject = childCtx.on('webserver/index-inject', (table) => {
      const scriptRow = {
        kind: 'script',
        placement: 'body',
        text: `
        (function() {
          try {
            const MENU_OPEN_SELECTORS = ['[class*="_menuOpen"]', '.YDXeBa_menuOpen'];
            const FOOT_AREA_SELECTORS = ['[class*="_footArea"]', '.hHd-Xa_footArea'];
            const SETTINGS_AREA_SELECTORS = ['[class*="_settingsArea"]', '.hHd-Xa_settingsArea'];
            const TRIGGER_SELECTORS = ['[class*="_trigger"]', '.VOzbGW_trigger'];

            // 1. 从 React Fiber 提取真实 sessionId (绝不按标题猜)
            function extractSessionIdFromEl(el) {
              if (!el) return null;
              let curr = el;
              for (let depth = 0; depth < 6 && curr; depth++) {
                try {
                  const keys = Object.keys(curr);
                  const fiberKey = keys.find(k => k.startsWith('__reactFiber$'));
                  if (fiberKey) {
                    let fiber = curr[fiberKey];
                    for (let i = 0; i < 12 && fiber; i++) {
                      const p = fiber.memoizedProps;
                      if (p && typeof p === 'object') {
                        const sId = (p.node && typeof p.node.id === 'string' && p.node.id.trim() && p.node.id)
                          || (p.session && typeof p.session.id === 'string' && p.session.id.trim() && p.session.id);
                        if (sId) return sId.trim();
                      }
                      fiber = fiber.return;
                    }
                  }
                  const propsKey = keys.find(k => k.startsWith('__reactProps$'));
                  if (propsKey) {
                    const p = curr[propsKey];
                    const sId = (p && p.node && typeof p.node.id === 'string' && p.node.id)
                      || (p && p.session && typeof p.session.id === 'string' && p.session.id);
                    if (sId && sId.trim()) return sId.trim();
                  }
                } catch(e) {}
                curr = curr.parentElement;
              }
              return null;
            }

            // 2. 注入二次确认弹窗 HTML & JS (主题跟随 DSH 主体的 --dsw-alias-* 变量)
            function ensureModalContainer() {
              if (document.getElementById('sc-confirm-overlay')) return;
              const modalHtml = \`
                <div id="sc-confirm-overlay" style="position:fixed; top:0; left:0; right:0; bottom:0; background:var(--dsw-alias-bg-mask-3, rgba(0,0,0,0.75)); display:none; justify-content:center; align-items:center; z-index:99999; backdrop-filter:blur(4px); font-family:var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);">
                  <div style="background:var(--dsw-alias-bg-module-platform); width:540px; border-radius:14px; padding:24px; color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l3); box-shadow:0 8px 32px rgba(0,0,0,0.6); max-width:calc(100vw - 32px);">
                    <div style="font-size:18px; font-weight:bold; color:var(--dsw-alias-state-error-primary); margin-bottom:14px; display:flex; align-items:center; gap:8px;">⚠️ 确认移入回收站</div>
                    <div style="font-size:14px; line-height:1.6;">
                      将把以下会话移入回收站 (可在回收站还原)：
                      <div id="sc-modal-info" style="background:var(--dsw-alias-bg-layer-2); padding:12px; border-radius:8px; margin:12px 0; font-family:var(--ds-font-family-code, monospace); font-size:12px; white-space:pre-wrap; word-break:break-all;">读取中...</div>

                      <div id="sc-modal-preview" style="display:none; background:var(--dsw-alias-bg-layer-2); border-left:4px solid var(--dsw-alias-brand-primary); padding:10px 12px; margin:12px 0; border-radius:6px; font-size:13px;">
                        <strong style="color:var(--dsw-alias-brand-primary);">💡 本会话首条用户指令 (对照摘要)：</strong>
                        <div id="sc-modal-preview-text" style="margin-top:4px; font-size:12px; font-family:var(--ds-font-family-code, monospace); white-space:pre-wrap; word-break:break-all; max-height:100px; overflow-y:auto; color:var(--dsw-alias-label-primary);"></div>
                      </div>

                      <div id="sc-modal-collision" style="display:none; background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); border-left:4px solid var(--dsw-alias-state-warn-primary); padding:10px 12px; margin:12px 0; border-radius:6px; font-size:13px;">
                        <strong style="color:var(--dsw-alias-state-warn-primary);">⚠️ 注意区分：检测到存在同名冲突会话！</strong><br>
                        <span style="font-size:12px; color:var(--dsw-alias-label-tertiary);">本操作只删除上方列出的这一个。同名另一会话信息：</span>
                        <div id="sc-modal-other" style="margin-top:6px; font-size:12px; font-family:var(--ds-font-family-code, monospace);"></div>
                      </div>
                      <div id="sc-modal-msg" style="color:var(--dsw-alias-state-error-primary); font-size:13px; margin-top:8px;"></div>
                    </div>
                    <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
                      <button id="sc-btn-cancel" style="padding:8px 16px; border-radius:8px; border:1px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-button-tool-bar-fill); color:var(--dsw-alias-label-primary); font-size:13px; cursor:pointer;">取消</button>
                      <button id="sc-btn-confirm" style="padding:8px 16px; border-radius:8px; border:none; background:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-label-primary-foreground, #fff); font-size:13px; font-weight:bold; cursor:pointer;">确认删除 (移入回收站)</button>
                    </div>
                  </div>
                </div>
              \`;
              const div = document.createElement('div');
              div.innerHTML = modalHtml;
              document.body.appendChild(div.firstElementChild);

              document.getElementById('sc-btn-cancel').onclick = closeConfirmModal;
              document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeConfirmModal();
              });
            }

            function closeConfirmModal() {
              const overlay = document.getElementById('sc-confirm-overlay');
              if (overlay) overlay.style.display = 'none';
            }

            async function openConfirmModal(sessionId, targetRow) {
              ensureModalContainer();
              const overlay = document.getElementById('sc-confirm-overlay');
              const infoEl = document.getElementById('sc-modal-info');
              const prevBox = document.getElementById('sc-modal-preview');
              const prevTextEl = document.getElementById('sc-modal-preview-text');
              const collisionEl = document.getElementById('sc-modal-collision');
              const otherEl = document.getElementById('sc-modal-other');
              const msgEl = document.getElementById('sc-modal-msg');
              const confirmBtn = document.getElementById('sc-btn-confirm');

              infoEl.innerText = 'Session ID: ' + sessionId + '\\n正在读取元数据...';
              prevBox.style.display = 'none';
              collisionEl.style.display = 'none';
              msgEl.innerText = '';
              confirmBtn.disabled = false;
              confirmBtn.style.opacity = '1';
              overlay.style.display = 'flex';

              let allSessions = [];
              try {
                const res = await fetch('/api/session-cleaner/sessions').then(r => r.json());
                if (res.success) allSessions = res.sessions || [];
              } catch {}

              const target = allSessions.find(s => s.sessionId === sessionId);
              if (target) {
                infoEl.innerText = \`标题: \${target.title}\${target.isArchived ? '  [已归档]' : ''}\\n完整 ID: \${target.sessionId}\\n创建时间: \${new Date(target.createdAt).toLocaleString('zh-CN')}\\n大小: \${(target.dirSize/1024/1024).toFixed(2)} MB | 轮次: \${target.turns}\\n工作区: \${target.workspacePath}\\n状态: \${target.isArchived ? '已归档' : (target.isLive ? '活跃运行中' : '正常')}\`;

                if (target.isLive) {
                  confirmBtn.disabled = true;
                  confirmBtn.style.opacity = '0.4';
                  msgEl.innerText = '该会话处于活跃状态 (openStep/pendingCalls)，拒绝清理';
                }

                if (target.titleCollision) {
                  const others = allSessions.filter(s => s.title === target.title && s.sessionId !== target.sessionId);
                  otherEl.innerText = '读取同名会话首条指令中...';
                  collisionEl.style.display = 'block';

                  Promise.all(others.map(async o => {
                    let pText = '';
                    try {
                      const pRes = await fetch('/api/session-cleaner/preview?sessionId=' + encodeURIComponent(o.sessionId)).then(r => r.json());
                      if (pRes.success && pRes.preview && pRes.preview.firstUserText) {
                        pText = pRes.preview.firstUserText.slice(0, 200);
                      }
                    } catch {}
                    return \`- ID: \${o.sessionId}\\n  创建时间: \${new Date(o.createdAt).toLocaleString('zh-CN')} | \${o.turns}轮\\n  工作区: \${o.workspacePath}\${pText ? '\\n  首条指令: ' + pText : ''}\`;
                  })).then(listStr => {
                    otherEl.innerText = listStr.join('\\n\\n');
                  }).catch(() => {});
                }
              } else {
                infoEl.innerText = '完整 ID: ' + sessionId + '\\n(包含日志文件)';
              }

              try {
                fetch('/api/session-cleaner/preview?sessionId=' + encodeURIComponent(sessionId))
                  .then(r => r.json())
                  .then(pRes => {
                    if (pRes.success && pRes.preview && pRes.preview.firstUserText) {
                      prevTextEl.innerText = pRes.preview.firstUserText.slice(0, 200);
                      prevBox.style.display = 'block';
                    }
                  })
                  .catch(() => {});
              } catch(e) {}

              confirmBtn.onclick = async () => {
                confirmBtn.disabled = true;
                msgEl.innerText = '正在移入回收站...';
                try {
                  const res = await fetch('/api/session-cleaner/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, confirm: 'DELETE' })
                  }).then(r => r.json());

                  if (res.success) {
                    msgEl.style.color = 'var(--dsw-alias-state-success-primary)';
                    msgEl.innerText = '✓ 已成功移入回收站';
                    setTimeout(() => {
                      closeConfirmModal();
                      if (targetRow && targetRow.isConnected) {
                        targetRow.style.transition = 'opacity 0.25s, height 0.25s';
                        targetRow.style.opacity = '0';
                        setTimeout(() => { try { targetRow.remove(); } catch(e){} }, 250);
                      }
                    }, 1000);
                  } else {
                    msgEl.style.color = 'var(--dsw-alias-state-error-primary)';
                    msgEl.innerText = '删除失败: ' + (res.error || '未知错误');
                    confirmBtn.disabled = false;
                  }
                } catch (err) {
                  msgEl.style.color = 'var(--dsw-alias-state-error-primary)';
                  msgEl.innerText = '请求失败: ' + err.message;
                  confirmBtn.disabled = false;
                }
              };
            }

            // 3. 拦截与注入 Portal 菜单
            function processMenu(menuEl) {
              if (menuEl.querySelector('[data-sc-item="1"]')) return;
              const items = Array.from(menuEl.querySelectorAll('button[role="menuitem"], [role="menuitem"]'));
              const archiveBtn = items.find(btn => (btn.textContent || '').trim().includes('归档会话'));
              if (!archiveBtn) return;

              let targetRow = null;
              for (const sel of MENU_OPEN_SELECTORS) {
                targetRow = document.querySelector(sel);
                if (targetRow) break;
              }

              const sessionId = extractSessionIdFromEl(targetRow);
              if (!sessionId) return; // 必须拿到 sessionId，绝不按标题猜

              const scItem = archiveBtn.cloneNode(true);
              scItem.setAttribute('data-sc-item', '1');

              let textSet = false;
              const replaceText = (node) => {
                if (node.nodeType === 3 && node.nodeValue.trim()) {
                  node.nodeValue = '移入回收站';
                  textSet = true;
                  return;
                }
                for (const c of node.childNodes) {
                  if (!textSet) replaceText(c);
                }
              };
              replaceText(scItem);
              if (!textSet) scItem.innerText = '移入回收站';

              scItem.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                if (document.activeElement) document.activeElement.blur();
                openConfirmModal(sessionId, targetRow);
              });

              menuEl.appendChild(scItem);
            }

            // 4. 侧边栏脚部回收站入口注入
            function injectTrashEntrance() {
              let footArea = null;
              for (const sel of FOOT_AREA_SELECTORS) {
                footArea = document.querySelector(sel);
                if (footArea) break;
              }
              if (!footArea) {
                for (const sel of SETTINGS_AREA_SELECTORS) {
                  const sa = document.querySelector(sel);
                  if (sa && sa.parentElement) {
                    footArea = sa.parentElement;
                    break;
                  }
                }
              }
              if (!footArea || footArea.querySelector('[data-sc-trash-entry="1"]')) return;

              let settingsArea = null;
              for (const sel of SETTINGS_AREA_SELECTORS) {
                settingsArea = footArea.querySelector(sel);
                if (settingsArea) break;
              }

              let triggerBtn = null;
              if (settingsArea) {
                for (const sel of TRIGGER_SELECTORS) {
                  triggerBtn = settingsArea.querySelector(sel);
                  if (triggerBtn) break;
                }
              }

              let trashBtn;
              if (triggerBtn) {
                trashBtn = triggerBtn.cloneNode(true);
                let textSet = false;
                const replaceText = (node) => {
                  if (node.nodeType === 3 && node.nodeValue.trim()) {
                    node.nodeValue = '回收站';
                    textSet = true;
                    return;
                  }
                  for (const c of node.childNodes) {
                    if (!textSet) replaceText(c);
                  }
                };
                replaceText(trashBtn);
                if (!textSet) trashBtn.innerText = '回收站';
              } else {
                trashBtn = document.createElement('button');
                trashBtn.type = 'button';
                trashBtn.innerText = '🗑️ 回收站';
                trashBtn.style.cssText = 'height:42px; border-radius:12px; font-size:14px; display:flex; align-items:center; gap:8px; padding:0 10px 0 8px; cursor:pointer; width:100%; background:transparent; border:none; color:var(--dsw-alias-label-primary);';
              }

              trashBtn.setAttribute('data-sc-trash-entry', '1');
              trashBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open('/session-cleaner#trash', '_blank');
              });

              if (settingsArea) {
                footArea.insertBefore(trashBtn, settingsArea);
              } else {
                footArea.appendChild(trashBtn);
              }
            }

            // 5. Observer 监听
            const observer = new MutationObserver(() => {
              try {
                const menus = document.querySelectorAll('[role="menu"]');
                menus.forEach(processMenu);
                injectTrashEntrance();
              } catch(e) {}
            });

            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(injectTrashEntrance, 500);

          } catch(e) {}
        })();
        `
      }

      if (Array.isArray(table)) {
        table.push(scriptRow)
      } else if (table && typeof table.add === 'function') {
        table.add(scriptRow)
      }
    })
    if (typeof unbindInject === 'function') disposers.push(unbindInject)
  })

  ctx.effect(() => () => {
    if (purgeTimer) clearInterval(purgeTimer)
    purgeTimer = null
    if (startupTimer) clearTimeout(startupTimer)
    startupTimer = null
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }, 'sessionCleaner.cleanup')
}