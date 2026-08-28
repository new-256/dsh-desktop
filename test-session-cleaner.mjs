/**
 * test-session-cleaner.mjs — session-cleaner 宿主插件独立单元与集成测试脚本
 *
 * 测试目标：
 * 1. 同名重名任务误删防护断言：删除目标 ID 时，同名的其它会话及其注册项原封不动
 * 2. 物理与 JSON 注册表同步清理断言：sessionDir, workspace.json, projcache 三处全清
 * 3. 移入回收站断言：数据安全暂存 dsh-home\.session-cleaner-trash\
 * 4. 恢复断言：restoreFromTrash 完整恢复物理与 JSON 结构
 * 5. 活跃拦截断言：openStep / in-memory 活跃会话拒绝删除
 * 6. 粉碎断言：purge 彻底移除
 * 7. Cordis 插件生命周期与路由注册/卸载断言
 * 8. 前端注入脚本文本包含 _menuOpen 与 #trash
 */

import { existsSync } from 'node:fs'
import { mkdir as mkdirP, readFile as readText, rm as rmDir, writeFile as writeText } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// 导入待测组件：优先测试仓库内的源码副本（plugins/web/），
// 不存在时回退到 DSH Desktop 实际部署位置（DSH_HOME/profiles/web/）。
const repoLocal = resolve('plugins/web/session-cleaner.plugin.mjs')
const appData = process.env.APPDATA || 'C:\\Users\\lcl\\AppData\\Roaming'
const deployed = resolve(appData, 'DSH Desktop/dsh-home/profiles/web/session-cleaner.plugin.mjs')
const pluginPath = existsSync(repoLocal) ? repoLocal : deployed
const pluginModule = await import(pathToFileURL(pluginPath).href)
const { projectKey, encodeSegment, listSessions, listTrash, moveToTrash, restoreFromTrash, purgeTrash, apply } = pluginModule

let passes = 0
let fails = 0

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    passes++
  } else {
    console.error(`  ✗ FAIL: ${message}`)
    fails++
  }
}

async function writeJson(filePath, data) {
  await mkdirP(resolve(filePath, '..'), { recursive: true })
  await writeText(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

async function readJson(filePath) {
  const content = await readText(filePath, 'utf8')
  return JSON.parse(content)
}

async function runTests() {
  console.log('====================================================')
  console.log(' 正在测试 session-cleaner 宿主插件...')
  console.log('====================================================\n')

  // 构造临时测试根目录 (%TEMP%\test-session-cleaner-xxxx)
  const testRoot = join(tmpdir(), `test-session-cleaner-${Date.now()}`)
  console.log(`[测试环境] 创建临时 dsh-home Mock 目录: ${testRoot}`)

  const mockWsPath = 'C:\\mock\\project'
  const wsSlug = projectKey(mockWsPath) // --C-mock-project--

  // 1. 初始化文件数据
  const wsJson = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-1': {
          path: mockWsPath,
          title: 'Mock Project',
          sessionIds: ['session-dup-1', 'session-dup-2', 'session-live'],
        },
      },
    },
  }

  const projJson = {
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: {
      sessions: {
        'session-dup-1': {
          identity: { createdAt: 1000, cwd: mockWsPath },
          rows: {
            title: { ver: 1, seq: 10, val: '重名测试任务' },
            sessionStats: { ver: 1, seq: 10, val: { turns: 2, steps: 5 } },
          },
        },
        'session-dup-2': {
          identity: { createdAt: 2000, cwd: mockWsPath },
          rows: {
            title: { ver: 1, seq: 20, val: '重名测试任务' }, // 同名!
            sessionStats: { ver: 1, seq: 20, val: { turns: 4, steps: 12 } },
          },
        },
        'session-live': {
          identity: { createdAt: 3000, cwd: mockWsPath },
          rows: {
            title: { ver: 1, seq: 30, val: '活跃任务' },
            sessionStats: { ver: 1, seq: 30, val: { turns: 1, steps: 2, openStep: { turn: 1 } } }, // 活跃!
          },
        },
      },
    },
  }

  await writeJson(join(testRoot, 'storages', 'workspace.json'), wsJson)
  await writeJson(join(testRoot, 'storages', 'session_projcache.json'), projJson)

  // 物理目录结构
  const sDir1 = join(testRoot, 'sessions', wsSlug, 'session-dup-1')
  const sDir2 = join(testRoot, 'sessions', wsSlug, 'session-dup-2')
  const sDirLive = join(testRoot, 'sessions', wsSlug, 'session-live')
  const sDirUnreg = join(testRoot, 'sessions', wsSlug, 'subagent-uuid-999')

  await writeJson(join(sDir1, 'session.jsonl'), { type: 'session', id: 'session-dup-1' })
  await writeJson(join(sDir2, 'session.jsonl'), { type: 'session', id: 'session-dup-2' })
  await writeJson(join(sDirLive, 'session.jsonl'), { type: 'session', id: 'session-live' })
  await writeJson(join(sDirUnreg, 'session.jsonl'), { type: 'session', id: 'subagent-uuid-999' })

  // -------------------------------------------------------------------------
  // Test 1: listSessions 探测与重名标记判定
  // -------------------------------------------------------------------------
  console.log('\n[测试 1] listSessions 探测与重名冲突标记...')
  const sessions = await listSessions(testRoot)
  assert(sessions.length === 4, '成功扫描到 4 个物理会话目录 (3 个已注册 + 1 个未注册子代理)')

  const s1 = sessions.find((s) => s.sessionId === 'session-dup-1')
  const s2 = sessions.find((s) => s.sessionId === 'session-dup-2')
  const sLive = sessions.find((s) => s.sessionId === 'session-live')
  const sUnreg = sessions.find((s) => s.sessionId === 'subagent-uuid-999')

  assert(s1 && s1.titleCollision === true, 'session-dup-1 成功标记为 titleCollision = true')
  assert(s2 && s2.titleCollision === true, 'session-dup-2 成功标记为 titleCollision = true')
  assert(sLive && sLive.isLive === true, 'session-live 成功探测并标记为 isLive = true')
  assert(sUnreg && sUnreg.isRegistered === false, '未注册子代理目录成功标记为 isRegistered = false')

  // -------------------------------------------------------------------------
  // Test 2: 同名隔离删除 (删除 session-dup-1，断言 session-dup-2 原封不动)
  // -------------------------------------------------------------------------
  console.log('\n[测试 2] moveToTrash 同名隔离删除断言...')
  const delReport = await moveToTrash(testRoot, 'session-dup-1')
  assert(delReport.success === true, 'session-dup-1 移入回收站成功')

  // 检查 session-dup-1 清理结果
  assert(!existsSync(sDir1), 'session-dup-1 原物理目录已被移除')
  assert(existsSync(join(testRoot, '.session-cleaner-trash', 'session-dup-1', 'session-data')), 'session-dup-1 物理目录进入回收站')

  const wsJsonAfter = await readJson(join(testRoot, 'storages', 'workspace.json'))
  const projJsonAfter = await readJson(join(testRoot, 'storages', 'session_projcache.json'))

  const wsSessions = wsJsonAfter.tables.workspaces['ws-1'].sessionIds
  assert(!wsSessions.includes('session-dup-1'), 'workspace.json 已安全移除 session-dup-1')
  assert(projJsonAfter.tables.sessions['session-dup-1'] === undefined, 'session_projcache.json 已移除 session-dup-1')

  // 关键断言 (a)：同名另一会话 session-dup-2 绝对不受影响！
  assert(wsSessions.includes('session-dup-2'), '【关键安全断言】同名另一会话 session-dup-2 仍完整保存在 workspace.json 中')
  assert(projJsonAfter.tables.sessions['session-dup-2'] !== undefined, '【关键安全断言】同名另一会话 session-dup-2 仍完整保存在 session_projcache.json 中')
  assert(existsSync(sDir2), '【关键安全断言】同名另一会话 session-dup-2 物理目录原封不动')

  // -------------------------------------------------------------------------
  // Test 3: 活跃会话拒删拦截
  // -------------------------------------------------------------------------
  console.log('\n[测试 3] 活跃会话拒删拦截断言...')
  try {
    await moveToTrash(testRoot, 'session-live')
    assert(false, '应该抛错但未抛错')
  } catch (err) {
    assert(err.message.includes('活跃'), `成功拦截活跃会话删除: ${err.message}`)
  }

  // -------------------------------------------------------------------------
  // Test 4: restoreFromTrash 恢复
  // -------------------------------------------------------------------------
  console.log('\n[测试 4] restoreFromTrash 还原断言...')
  const restoreReport = await restoreFromTrash(testRoot, 'session-dup-1')
  assert(restoreReport.success === true, 'restoreFromTrash 成功')

  assert(existsSync(sDir1), 'session-dup-1 物理目录恢复成功')
  const wsJsonRestored = await readJson(join(testRoot, 'storages', 'workspace.json'))
  const projJsonRestored = await readJson(join(testRoot, 'storages', 'session_projcache.json'))

  assert(wsJsonRestored.tables.workspaces['ws-1'].sessionIds.includes('session-dup-1'), 'session-dup-1 重新插入 workspace.json')
  assert(projJsonRestored.tables.sessions['session-dup-1'] !== undefined, 'session-dup-1 重新插入 session_projcache.json')
  assert(!existsSync(join(testRoot, '.session-cleaner-trash', 'session-dup-1')), '回收站暂存项被清理')

  // -------------------------------------------------------------------------
  // Test 5: purgeTrash 彻底移除
  // -------------------------------------------------------------------------
  console.log('\n[测试 5] purgeTrash 彻底粉碎断言...')
  await moveToTrash(testRoot, 'session-dup-1')
  const purgeRes = await purgeTrash(testRoot, 'session-dup-1', 'PURGE')
  assert(purgeRes.success === true, 'purgeTrash 彻底粉碎成功')
  assert(!existsSync(join(testRoot, '.session-cleaner-trash', 'session-dup-1')), '回收站项物理移除')

  // -------------------------------------------------------------------------
  // Test 6: 插件生命周期与 Cordis WebServer 注册桩测试
  // -------------------------------------------------------------------------
  console.log('\n[测试 6] Cordis 宿主插件 apply/dispose 生命周期函数测试...')
  let effectDisposer = null
  const registeredRoutes = new Map()
  const injectListeners = []
  const injectedRows = []

  const mockWs = {
    register: (route) => {
      registeredRoutes.set(route.path, route)
      return () => registeredRoutes.delete(route.path)
    },
  }

  const mockCtx = {
    logger: { info: () => {}, warn: () => {} },
    inject: (deps, callback) => {
      callback({
        webServer: mockWs,
        get: () => null,
        on: (event, listener) => {
          if (event === 'webserver/index-inject') injectListeners.push(listener)
          return () => {
            const at = injectListeners.indexOf(listener)
            if (at !== -1) injectListeners.splice(at, 1)
          }
        },
      })
    },
    effect: (fn) => {
      effectDisposer = fn()
    },
  }

  apply(mockCtx, { verbose: false })

  assert(registeredRoutes.has('/api/session-cleaner/sessions'), '成功注册路由 /api/session-cleaner/sessions')
  assert(registeredRoutes.has('/api/session-cleaner/delete'), '成功注册路由 /api/session-cleaner/delete')
  assert(registeredRoutes.has('/session-cleaner'), '成功注册管理页路由 /session-cleaner')

  // 真实 webServer 以 route.handler(req,res) 派发；属性名不匹配会得到空 400
  for (const route of registeredRoutes.values()) {
    assert(typeof route.handler === 'function', `路由 ${route.path} 以 route.handler 暴露处理函数（真实 webServer 派发契约）`)
  }

  // 模拟一次 index 渲染：触发 webserver/index-inject 事件并校验结构化注入行
  class MockInjectedRows {
    constructor() { this.items = []; }
    add(item) { this.items.push(item); }
  }
  const mockInj = new MockInjectedRows();
  for (const listener of injectListeners) listener(mockInj);

  const scriptRow = mockInj.items.find((r) => r.kind === 'script' && r.placement === 'body');
  assert(Boolean(scriptRow), 'webserver/index-inject 事件提交了前端入口脚本行');
  assert(scriptRow && scriptRow.text.includes('_menuOpen'), '前端注入脚本包含 _menuOpen 选择器定义');
  assert(scriptRow && scriptRow.text.includes('#trash'), '前端注入脚本包含 #trash 路由逻辑');

  // 模拟插件卸载
  if (effectDisposer) effectDisposer();
  assert(registeredRoutes.size === 0, '插件卸载 disposer 成功清理所有已注册路由');
  assert(injectListeners.length === 0, '插件卸载后 index-inject 事件监听已全部移除');

  // 清理临时根目录
  try {
    await rmDir(testRoot, { recursive: true, force: true })
  } catch {}

  console.log('\n====================================================')
  console.log(` 测试结束: ${passes} 通过, ${fails} 失败`)
  console.log('====================================================\n')

  if (fails > 0) {
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error('测试脚本发生未知异常:', err)
  process.exit(1)
})
