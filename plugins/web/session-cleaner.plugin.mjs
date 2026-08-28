/**
 * session-cleaner.plugin.mjs — DSH 会话回收站与清理管理器宿主插件 (原生 UI 集成版)
 *
 * 契约与规范：
 * 1. 路由注册：必须使用 handler 属性，形如 ws.register({ kind: 'exact', path: '...', async handler(req, res) { ... } })
 * 2. 页面注入：必须监听 webserver/index-inject 事件，调用 inj.add({ kind: 'script', placement: 'body', text: '...' })
 * 3. 移入回收站语义：物理目录移至 dsh-home\.session-cleaner-trash\<sessionId>\，清理 workspace.json / projcache
 * 4. 防重名误删：严格提取 React Fiber 的 sessionId，无法确定 ID 时绝不注入删除选项，二次确认展示同名摘要对比
 *
 * @module session-cleaner
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const name = 'session-cleaner'

const DEFAULT_CONFIG = {
  trashDirName: '.session-cleaner-trash',
  verbose: false,
}

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
// 核心清理/恢复逻辑函数 (独立无 Cordis 依赖，接收 dshHome 根路径)
// ---------------------------------------------------------------------------

export async function listSessions(dshHome, liveSessionsMap = new Map()) {
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

        const subagentVal = rows.subagent?.val || {}
        const isSubagent = Boolean(!sessionId.startsWith('session-') || subagentVal.identity)
        const subagentLabel = subagentVal.identity?.label || null

        const liveInfo = liveSessionsMap.get(sessionId)
        const isLive = Boolean(liveInfo?.isLive || openStep || (pendingCalls && Object.keys(pendingCalls).length > 0))

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
          isArchived: archivedSessionIds.has(sessionId),
          isSubagent,
          subagentLabel,
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

export async function listTrash(dshHome, trashDirName = DEFAULT_CONFIG.trashDirName) {
  const trashDir = join(dshHome, trashDirName)
  if (!existsSync(trashDir)) return []

  const trashItems = []
  try {
    const entries = await readdir(trashDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      const itemDir = join(trashDir, sessionId)
      const infoPath = join(itemDir, '.trash-info.json')

      const info = (await readJsonFile(infoPath)) || {}
      const size = await getDirSize(join(itemDir, 'session-data'))

      trashItems.push({
        sessionId,
        deletedAt: info.deletedAt || 0,
        title: info.title || sessionId,
        originalWorkspacePath: info.originalWorkspacePath || '',
        workspaceTitle: info.workspaceTitle || '',
        dirSize: size,
        isSubagent: info.isSubagent || false,
      })
    }
  } catch {}

  return trashItems.sort((a, b) => b.deletedAt - a.deletedAt)
}

export async function moveToTrash(dshHome, sessionId, options = {}) {
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

  if (workspaceJson?.tables?.workspaces && info.targetWsId) {
    const ws = workspaceJson.tables.workspaces[info.targetWsId]
    if (ws && ws.sessionIds) {
      if (!ws.sessionIds.includes(sessionId)) {
        ws.sessionIds.push(sessionId)
      }
      await writeJsonFile(wsJsonPath, workspaceJson)
      report.stepsDone.push('还原 workspace.json 中的 sessionIds 属性')
    }
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

  const itemTrashDir = join(trashDir, sessionId)
  if (!existsSync(itemTrashDir)) {
    throw new Error(`回收站中不存在会话 "${sessionId}"`)
  }

  await rm(itemTrashDir, { recursive: true, force: true })
  return { success: true, message: `已彻底删除回收站条目 ${sessionId}` }
}

// ---------------------------------------------------------------------------
// 自包含 HTML 管理界面生成器 (增强 #trash 锚点与恢复说明)
// ---------------------------------------------------------------------------

export function renderManagerHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH 会话清理与回收站管理器</title>
  <style>
    :root {
      --bg: #1e1e2e;
      --card-bg: #2b2b3b;
      --text: #cdd6f4;
      --subtext: #a6adc8;
      --accent: #89b4fa;
      --danger: #f38ba8;
      --warning: #f9e2af;
      --success: #a6e3a1;
      --border: #45475a;
    }
    body {
      margin: 0; padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg); color: var(--text);
    }
    h1, h2 { margin: 0 0 16px 0; font-weight: 600; color: #fff; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .stats-bar { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--card-bg); padding: 12px 20px; border-radius: 8px; border: 1px solid var(--border); }
    .stat-val { font-size: 20px; font-weight: bold; color: var(--accent); }
    .stat-lbl { font-size: 12px; color: var(--subtext); }
    
    .search-box { width: 100%; max-width: 400px; padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border); background: #181825; color: #fff; font-size: 14px; margin-bottom: 20px; box-sizing: border-box; }
    
    table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid var(--border); font-size: 14px; }
    th { background: #181825; color: var(--subtext); font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    tr.collision-row { background: rgba(249, 226, 175, 0.08); }
    
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .badge-live { background: rgba(243, 139, 168, 0.2); color: var(--danger); border: 1px solid var(--danger); }
    .badge-collision { background: rgba(249, 226, 175, 0.2); color: var(--warning); border: 1px solid var(--warning); }
    .badge-subagent { background: rgba(137, 180, 250, 0.2); color: var(--accent); }
    .badge-unreg { background: rgba(166, 173, 200, 0.2); color: var(--subtext); }
    .badge-ok { background: rgba(166, 227, 161, 0.2); color: var(--success); }
    
    .btn { padding: 6px 12px; border-radius: 4px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.85; }
    .btn-danger { background: var(--danger); color: #11111b; }
    .btn-secondary { background: var(--border); color: #fff; }
    .btn-success { background: var(--success); color: #11111b; }
    .btn[disabled] { opacity: 0.4; cursor: not-allowed; }
    
    .sid { font-family: monospace; background: #181825; padding: 2px 6px; border-radius: 4px; cursor: pointer; color: var(--accent); }
    .sid:hover { text-decoration: underline; }

    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: none; justify-content: center; align-items: center; z-index: 1000; }
    .modal { background: var(--card-bg); width: 560px; border-radius: 12px; padding: 24px; border: 1px solid var(--border); box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
    .modal-header { font-size: 18px; font-weight: bold; margin-bottom: 16px; color: var(--danger); display: flex; align-items: center; gap: 8px; }
    .modal-body { font-size: 14px; line-height: 1.6; color: var(--text); }
    .info-grid { background: #181825; padding: 12px; border-radius: 6px; margin: 12px 0; font-family: monospace; font-size: 13px; }
    .collision-alert { background: rgba(249, 226, 175, 0.15); border-left: 4px solid var(--warning); padding: 12px; margin: 12px 0; border-radius: 4px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }

    .trash-notice { color: var(--subtext); font-size: 13px; margin-bottom: 12px; }
    #trash-section { border-radius: 8px; transition: border-color 0.5s; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>DSH 会话清理与回收站管理器</h1>
      <div style="color: var(--subtext); font-size: 13px;">安全清理、防误删重名任务保障、可逆恢复</div>
    </div>
    <button class="btn btn-secondary" onclick="loadAll()">🔄 刷新列表</button>
  </div>

  <div class="stats-bar">
    <div class="stat-card"><div class="stat-val" id="st-total">0</div><div class="stat-lbl">总会话数</div></div>
    <div class="stat-card"><div class="stat-val" id="st-size">0 MB</div><div class="stat-lbl">占用磁盘大小</div></div>
    <div class="stat-card"><div class="stat-val" id="st-trash">0</div><div class="stat-lbl">回收站条目</div></div>
  </div>

  <input type="text" id="search" class="search-box" placeholder="搜索标题、Session ID 或工作区路径..." oninput="renderSessions()">

  <h2>会话列表 (Sessions)</h2>
  <table>
    <thead>
      <tr>
        <th>状态/标记</th>
        <th>会话标题</th>
        <th>Session ID (点击复制全称)</th>
        <th>创建时间</th>
        <th>轮次/步骤</th>
        <th>占用大小</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody id="sessions-tbl"></tbody>
  </table>

  <div id="trash-section" style="margin-top: 40px;">
    <h2>回收站 (Trash) <button class="btn btn-danger" style="margin-left: 12px; font-size: 12px;" onclick="purgeAll()">清空回收站</button></h2>
    <div class="trash-notice">提示：恢复的会话需重启 DSH Desktop 后才会重新出现在侧边栏列表中。</div>
    <table>
      <thead>
        <tr>
          <th>会话标题 / ID</th>
          <th>原工作区</th>
          <th>删除时间</th>
          <th>大小</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="trash-tbl"></tbody>
    </table>
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

    async function loadAll() {
      try {
        const [resS, resT] = await Promise.all([
          fetch('/api/session-cleaner/sessions').then(r => r.json()),
          fetch('/api/session-cleaner/trash').then(r => r.json())
        ]);
        if (resS.success) rawSessions = resS.sessions;
        if (resT.success) rawTrash = resT.trash;
        updateStats();
        renderSessions();
        renderTrash();
        checkHashAnchor();
      } catch (err) {
        alert('加载会话列表失败: ' + err.message);
      }
    }

    function checkHashAnchor() {
      if (window.location.hash === '#trash') {
        const trashSec = document.getElementById('trash-section');
        if (trashSec) {
          trashSec.scrollIntoView({ behavior: 'smooth' });
          trashSec.style.border = '2px solid var(--accent)';
          trashSec.style.padding = '12px';
          setTimeout(() => {
            trashSec.style.border = '';
            trashSec.style.padding = '';
          }, 2000);
        }
      }
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatDate(ts) {
      if (!ts) return '未知';
      return new Date(ts).toLocaleString('zh-CN');
    }

    function updateStats() {
      document.getElementById('st-total').innerText = rawSessions.length;
      const totalBytes = rawSessions.reduce((acc, s) => acc + (s.dirSize || 0), 0);
      document.getElementById('st-size').innerText = formatBytes(totalBytes);
      document.getElementById('st-trash').innerText = rawTrash.length;
    }

    function renderSessions() {
      const q = document.getElementById('search').value.toLowerCase();
      const filtered = rawSessions.filter(s => 
        s.title.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        s.workspacePath.toLowerCase().includes(q)
      );

      const tbody = document.getElementById('sessions-tbl');
      tbody.innerHTML = filtered.map(s => {
        let badges = '';
        if (s.isLive) badges += '<span class="badge badge-live">活跃运行中</span> ';
        if (s.titleCollision) badges += '<span class="badge badge-collision">同名冲突</span> ';
        if (s.isSubagent) badges += '<span class="badge badge-subagent">子代理</span> ';
        if (!s.isRegistered) badges += '<span class="badge badge-unreg">未注册目录</span> ';
        if (!badges) badges = '<span class="badge badge-ok">正常</span>';

        const shortId = s.sessionId.length > 18 ? s.sessionId.slice(0, 10) + '...' + s.sessionId.slice(-6) : s.sessionId;
        const rowClass = s.titleCollision ? 'collision-row' : '';

        return \`<tr class="\${rowClass}">
          <td>\${badges}</td>
          <td><strong>\${escapeHtml(s.title)}</strong>\${s.subagentLabel ? '<br><small style="color:var(--subtext)">' + escapeHtml(s.subagentLabel) + '</small>' : ''}</td>
          <td><span class="sid" title="点击复制完整 ID: \${s.sessionId}" onclick="copyId('\${s.sessionId}')">\${shortId}</span></td>
          <td>\${formatDate(s.createdAt)}</td>
          <td>\${s.turns} 轮 / \${s.steps} 步</td>
          <td>\${formatBytes(s.dirSize)}</td>
          <td>
            <button class="btn btn-danger" \${s.isLive ? 'disabled title="活跃会话无法删除"' : ''} onclick="openDeleteModal('\${s.sessionId}')">
              \${s.isLive ? '活跃锁定' : '移入回收站'}
            </button>
          </td>
        </tr>\`;
      }).join('');
    }

    function renderTrash() {
      const tbody = document.getElementById('trash-tbl');
      if (rawTrash.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--subtext);">回收站为空</td></tr>';
        return;
      }
      tbody.innerHTML = rawTrash.map(t => \`<tr>
        <td><strong>\${escapeHtml(t.title)}</strong><br><small style="font-family:monospace; color:var(--subtext)">\${t.sessionId}</small></td>
        <td>\${escapeHtml(t.originalWorkspacePath || '未知')}</td>
        <td>\${formatDate(t.deletedAt)}</td>
        <td>\${formatBytes(t.dirSize)}</td>
        <td>
          <button class="btn btn-success" onclick="restoreSession('\${t.sessionId}')">恢复</button>
          <button class="btn btn-danger" style="margin-left:8px;" onclick="purgeSession('\${t.sessionId}')">彻底清除</button>
        </td>
      </tr>\`).join('');
    }

    function copyId(id) {
      navigator.clipboard.writeText(id);
      alert('已复制 Session ID: ' + id);
    }

    function escapeHtml(str) {
      return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function openDeleteModal(sessionId) {
      const target = rawSessions.find(s => s.sessionId === sessionId);
      if (!target) return;

      document.getElementById('modal-target-info').innerHTML = \`
标题: \${target.title}
完整 ID: \${target.sessionId}
创建时间: \${formatDate(target.createdAt)}
磁盘大小: \${formatBytes(target.dirSize)}
工作区: \${target.workspacePath}
      \`;

      const warningEl = document.getElementById('modal-collision-warning');
      if (target.titleCollision) {
        const others = rawSessions.filter(s => s.title === target.title && s.sessionId !== target.sessionId);
        document.getElementById('modal-other-info').innerHTML = others.map(o => \`
- 另一同名会话 ID: \${o.sessionId}
  创建时间: \${formatDate(o.createdAt)} | 大小: \${formatBytes(o.dirSize)} | 工作区: \${o.workspacePath}
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

  const dshHome = process.env.DSH_HOME || resolve(process.env.APPDATA || '', 'DSH Desktop/dsh-home')

  if (verbose) {
    ctx.logger?.info(`[session-cleaner] 启动成功，dshHome: ${dshHome}`)
  }

  const disposers = []

  ctx.inject(['webServer'], (childCtx) => {
    const ws = childCtx.webServer
    if (!ws) return

    // 路由 1: GET /api/session-cleaner/sessions
    // 注：活跃判定只看 projcache 的 openStep/pendingCalls（正在运行的硬信号）。
    // 不用 SessionStore.get/list —— 后端会把打开过的会话常驻内存，
    // 那样会把所有空闲会话也误标为"活跃"导致全部拒删。
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
            const trash = await listTrash(dshHome, mergedConfig.trashDirName)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, trash }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: false, error: err.message }))
          }
        },
      })
    )

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

    // 路由 3: POST /api/session-cleaner/delete
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

    // 路由 4: POST /api/session-cleaner/restore
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

    // 路由 5: POST /api/session-cleaner/purge
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

    // 路由 6: GET /session-cleaner (管理页面)
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

            // 1. 从 React Fiber 递归提取真实 sessionId (绝不按标题猜)
            function extractSessionIdFromEl(el) {
              if (!el) return null;
              let curr = el;
              for (let depth = 0; depth < 6 && curr; depth++) {
                const keys = Object.keys(curr);
                const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
                if (fiberKey) {
                  const val = curr[fiberKey];
                  const sId = val?.memoizedProps?.node?.id || val?.node?.id || val?.memoizedProps?.session?.id || val?.session?.id;
                  if (typeof sId === 'string' && sId.trim().length > 0) return sId.trim();
                }
                curr = curr.parentElement;
              }
              return null;
            }

            // 2. 注入二次确认弹窗 HTML & JS
            function ensureModalContainer() {
              if (document.getElementById('sc-confirm-overlay')) return;
              const modalHtml = \`
                <div id="sc-confirm-overlay" style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.75); display:none; justify-content:center; align-items:center; z-index:99999; backdrop-filter:blur(4px); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                  <div style="background:#2b2b3b; width:520px; border-radius:12px; padding:24px; color:#cdd6f4; border:1px solid #45475a; box-shadow:0 8px 32px rgba(0,0,0,0.6); max-width:calc(100vw - 32px);">
                    <div style="font-size:18px; font-weight:bold; color:#f38ba8; margin-bottom:14px; display:flex; align-items:center; gap:8px;">⚠️ 确认移入回收站</div>
                    <div style="font-size:14px; line-height:1.6;">
                      将把以下会话移入回收站 (可在回收站还原)：
                      <div id="sc-modal-info" style="background:#181825; padding:12px; border-radius:6px; margin:12px 0; font-family:monospace; font-size:13px; white-space:pre-wrap; word-break:break-all;">读取中...</div>
                      <div id="sc-modal-collision" style="display:none; background:rgba(249, 226, 175, 0.15); border-left:4px solid #f9e2af; padding:10px 12px; margin:12px 0; border-radius:4px; font-size:13px;">
                        <strong style="color:#f9e2af;">⚠️ 注意区分：检测到存在同名冲突会话！</strong><br>
                        <span style="font-size:12px; color:#a6adc8;">本操作只删除上方列出的这一个。同名另一会话信息：</span>
                        <div id="sc-modal-other" style="margin-top:4px; font-size:12px; font-family:monospace;"></div>
                      </div>
                      <div id="sc-modal-msg" style="color:#f38ba8; font-size:13px; margin-top:8px;"></div>
                    </div>
                    <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
                      <button id="sc-btn-cancel" style="padding:8px 16px; border-radius:6px; border:none; background:#45475a; color:#fff; font-size:13px; cursor:pointer;">取消</button>
                      <button id="sc-btn-confirm" style="padding:8px 16px; border-radius:6px; border:none; background:#f38ba8; color:#11111b; font-size:13px; font-weight:bold; cursor:pointer;">确认删除 (移入回收站)</button>
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
              const collisionEl = document.getElementById('sc-modal-collision');
              const otherEl = document.getElementById('sc-modal-other');
              const msgEl = document.getElementById('sc-modal-msg');
              const confirmBtn = document.getElementById('sc-btn-confirm');

              infoEl.innerText = 'Session ID: ' + sessionId + '\\n正在读取元数据...';
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
                infoEl.innerText = \`标题: \${target.title}\\n完整 ID: \${target.sessionId}\\n创建时间: \${new Date(target.createdAt).toLocaleString('zh-CN')}\\n大小: \${(target.dirSize/1024/1024).toFixed(2)} MB | 轮次: \${target.turns}\\n工作区: \${target.workspacePath}\`;
                
                if (target.isLive) {
                  confirmBtn.disabled = true;
                  confirmBtn.style.opacity = '0.4';
                  msgEl.innerText = '该会话处于活跃状态 (openStep/pendingCalls)，拒绝清理';
                }

                if (target.titleCollision) {
                  const others = allSessions.filter(s => s.title === target.title && s.sessionId !== target.sessionId);
                  otherEl.innerText = others.map(o => \`- ID: \${o.sessionId} | 创建: \${new Date(o.createdAt).toLocaleString('zh-CN')} | \${o.turns}轮\`).join('\\n');
                  collisionEl.style.display = 'block';
                }
              } else {
                infoEl.innerText = '完整 ID: ' + sessionId + '\\n(包含日志文件)';
              }

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
                    msgEl.style.color = '#a6e3a1';
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
                    msgEl.style.color = '#f38ba8';
                    msgEl.innerText = '删除失败: ' + (res.error || '未知错误');
                    confirmBtn.disabled = false;
                  }
                } catch (err) {
                  msgEl.style.color = '#f38ba8';
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
                trashBtn.style.cssText = 'height:42px; border-radius:12px; font-size:14px; display:flex; align-items:center; gap:8px; padding:0 10px 0 8px; cursor:pointer; width:100%; background:transparent; border:none; color:inherit;';
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
      };

      if (Array.isArray(table)) {
        table.push(scriptRow);
      } else if (table && typeof table.add === 'function') {
        table.add(scriptRow);
      }
    })
    if (typeof unbindInject === 'function') disposers.push(unbindInject)
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }, 'sessionCleaner.cleanup')
}
