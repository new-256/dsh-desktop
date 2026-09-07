// lib/pathDiscovery.mjs — 模型库位置自动发现与多根管理
//
// 适应所有用户的电脑环境：自动发现已有 ComfyUI 根目录与模型存放位置。
// 优先级：插件显式配置 > 环境变量 > 正在运行的 ComfyUI 进程 > 磁盘扫描兜底 > extra_model_paths.yaml

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { STANDARD_SUBFOLDERS } from './modelRegistry.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_CACHE_FILE = path.resolve(__dirname, '..', '.comfyui-bridge-cache.json')

/**
 * 轻量解析 extra_model_paths.yaml（零第三方依赖）
 * 匹配 key: path，识别 base_path 与各类已知模型目录
 */
export function parseExtraModelPaths(yamlContent, fallbackBaseDir = '') {
  const result = {
    basePath: null,
    roots: [],
    extraPaths: {},
  }
  if (!yamlContent || typeof yamlContent !== 'string') return result

  const lines = yamlContent.split(/\r?\n/)
  let currentBasePath = fallbackBaseDir || null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = line.match(/^\s*([\w-]+):\s*(.+)$/)
    if (!match) continue

    const key = match[1].trim().toLowerCase()
    let val = match[2].trim()
    // 去除包裹的双引号或单引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).trim()
    }

    if (!val) continue

    if (key === 'base_path') {
      currentBasePath = path.isAbsolute(val) ? path.normalize(val) : path.resolve(fallbackBaseDir || '', val)
      if (!result.roots.includes(currentBasePath)) {
        result.roots.push(currentBasePath)
      }
      result.basePath = currentBasePath
      continue
    }

    // 检查是否包含路径分隔符
    if (val.includes('\\') || val.includes('/') || path.isAbsolute(val)) {
      let resolvedPath = val
      if (!path.isAbsolute(resolvedPath) && currentBasePath) {
        resolvedPath = path.resolve(currentBasePath, val)
      }
      resolvedPath = path.normalize(resolvedPath)

      if (!result.extraPaths[key]) {
        result.extraPaths[key] = []
      }
      result.extraPaths[key].push(resolvedPath)

      // 如果这个路径本身包含 models 结构或为标准子目录，把父级也纳入根候选
      const parentDir = path.dirname(resolvedPath)
      if (!result.roots.includes(parentDir) && path.basename(parentDir).toLowerCase() === 'models') {
        result.roots.push(parentDir)
      }
    }
  }

  return result
}

/**
 * 进程扫描：查找正在运行的 ComfyUI python 进程
 */
export function scanProcessForComfyUI() {
  if (process.platform !== 'win32') return null
  try {
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name LIKE 'python%'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`
    // 10s:冷启动的 PowerShell CIM(WMI)在多进程机器上可能要 3-8 秒,3s 会静默失败
    const stdout = execSync(cmd, { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' })
    if (!stdout || !stdout.trim()) return null

    let parsed
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return null
    }

    const list = Array.isArray(parsed) ? parsed : [parsed]
    for (const proc of list) {
      const line = proc?.CommandLine
      if (!line || typeof line !== 'string') continue

      // 检查 CommandLine 是否同时包含 main.py 和 comfy (大小写不敏感)
      if (/main\.py/i.test(line) && /comfy/i.test(line)) {
        // 1. 检查是否有 --base-directory
        let root = null
        const baseDirMatch = line.match(/--base-directory\s+([^\s"']+)/i) || line.match(/--base-directory\s+"([^"]+)"/i)
        if (baseDirMatch && baseDirMatch[1]) {
          root = path.normalize(baseDirMatch[1])
        }

        // 2. 否则通过 main.py 所在目录确定根
        if (!root) {
          const mainMatch = line.match(/(?:[a-zA-Z]:[\\/][^\s"]*?main\.py)/i) || line.match(/"([^"]*?main\.py)"/i)
          const mainPath = mainMatch ? mainMatch[1] || mainMatch[0] : null
          if (mainPath) {
            root = path.dirname(path.normalize(mainPath))
          }
        }

        if (root && fs.existsSync(root)) {
          // 检查是否有 --extra-model-paths-config
          let extraConfig = null
          const extraMatch = line.match(/--extra-model-paths-config\s+([^\s"']+)/i) || line.match(/--extra-model-paths-config\s+"([^"]+)"/i)
          if (extraMatch && extraMatch[1]) {
            extraConfig = path.normalize(extraMatch[1])
          }

          const modelsDir = path.join(root, 'models')
          return {
            root,
            modelsDir: fs.existsSync(modelsDir) ? modelsDir : root,
            extraConfig,
          }
        }
      }
    }
  } catch {
    // 静默降级
  }
  return null
}

/**
 * 沿 comfy 命名链递归下钻(最多 depthLeft 层),发现嵌套安装:
 * D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models 这种三层结构。
 * 只下钻名字含 comfy 的目录,避免全盘遍历。
 */
function scanNestedComfy(dir, depthLeft, deadline, results, seenModelsDirs) {
  if (depthLeft <= 0 || Date.now() > deadline) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (Date.now() > deadline) return
    if (!e.isDirectory() || !/comfy/i.test(e.name)) continue
    const full = path.join(dir, e.name)
    const models = path.join(full, 'models')
    if (/^comfyui/i.test(e.name) && fs.existsSync(models) && !seenModelsDirs.has(models)) {
      seenModelsDirs.add(models)
      results.push({ root: full, modelsDir: models })
    }
    scanNestedComfy(full, depthLeft - 1, deadline, results, seenModelsDirs)
  }
}

/**
 * 磁盘扫描兜底：扫描盘符查找已有的 ComfyUI 安装与 models 目录
 */
export function scanDrivesForComfyUI(options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 4000)
  const results = []
  const seenModelsDirs = new Set()

  // 盘符顺序：先 D..Z 再 C（已有安装即使在 C 盘也发现，新安装才避开 C）
  let letters = []
  if (options.drives && Array.isArray(options.drives)) {
    letters = options.drives
  } else if (process.platform === 'win32') {
    for (let i = 68; i <= 90; i++) { // D..Z
      letters.push(String.fromCharCode(i) + ':\\')
    }
    letters.push('C:\\')
  } else {
    letters = ['/']
  }

  for (const drive of letters) {
    if (Date.now() > deadline) break
    try {
      if (!fs.existsSync(drive)) continue
      // 检查根目录
      let topEntries
      try {
        topEntries = fs.readdirSync(drive, { withFileTypes: true })
      } catch {
        continue // 慢盘或权限拒绝跳过
      }

      for (const entry of topEntries) {
        if (Date.now() > deadline) break
        if (!entry.isDirectory()) continue
        const name = entry.name
        const fullDir = path.join(drive, name)

        // 深度 1: 形如 D:\ComfyUI, D:\ComfyUI-aki-v3
        if (/^comfyui/i.test(name)) {
          // 检查是否有 models 子目录
          const modelsCandidate = path.join(fullDir, 'models')
          if (fs.existsSync(modelsCandidate) && !seenModelsDirs.has(modelsCandidate)) {
            seenModelsDirs.add(modelsCandidate)
            results.push({ root: fullDir, modelsDir: modelsCandidate })
          }
          // 沿 comfy 命名链下钻最多 2 层,覆盖 D:\ComfyUI\ComfyUI-aki-v3\ComfyUI\models
          // 以及 D:\ComfyUI-aki-v3\ComfyUI\models 等嵌套形态
          scanNestedComfy(fullDir, 2, deadline, results, seenModelsDirs)
        } else if (/^(AI|SD|StableDiffusion)/i.test(name)) {
          // 深度 2 探测常见 AI 工具集目录
          try {
            const subEntries = fs.readdirSync(fullDir, { withFileTypes: true })
            for (const sub of subEntries) {
              if (Date.now() > deadline) break
              if (sub.isDirectory() && /comfyui/i.test(sub.name)) {
                const subFull = path.join(fullDir, sub.name)
                const modelsCand = path.join(subFull, 'models')
                if (fs.existsSync(modelsCand) && !seenModelsDirs.has(modelsCand)) {
                  seenModelsDirs.add(modelsCand)
                  results.push({ root: subFull, modelsDir: modelsCand })
                }
                scanNestedComfy(subFull, 1, deadline, results, seenModelsDirs)
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  return results
}

/**
 * 核心解析入口：自动发现模型库目录
 * 遵循严格优先级，并实现磁盘缓存
 */
export function resolveModelsDirs(options = {}) {
  const cacheFile = options.cacheFile || DEFAULT_CACHE_FILE
  const force = Boolean(options.force)

  // 1. 读取有效缓存（如果非 force）
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
      // 若当前显式传入了 configModelsDir，必须确保缓存包含该路径，否则缓存失效
      const normConfig = options.configModelsDir ? path.normalize(path.resolve(options.configModelsDir)) : null
      const configMatches = !normConfig || (cached.roots || []).some((r) => r.path === normConfig)
      if (configMatches && cached && cached.primary && fs.existsSync(cached.primary)) {
        // 校验 roots 中有效路径
        const validRoots = (cached.roots || []).filter((r) => r && r.path && fs.existsSync(r.path))
        if (validRoots.length > 0) {
          return {
            roots: validRoots,
            primary: cached.primary,
            source: cached.source || 'cache',
            extraPaths: cached.extraPaths || {},
          }
        }
      }
    } catch {}
  }

  const roots = []
  const extraPaths = {}
  const seenPaths = new Set()

  const addRoot = (dirPath, source) => {
    if (!dirPath || typeof dirPath !== 'string') return
    const normalized = path.normalize(path.resolve(dirPath))
    if (!fs.existsSync(normalized)) return
    if (!seenPaths.has(normalized)) {
      seenPaths.add(normalized)
      roots.push({ path: normalized, source })
    }
  }

  // 优先级 1: 插件 config 中的 modelsDir
  if (options.configModelsDir) {
    addRoot(options.configModelsDir, 'config')
  }

  // 优先级 2: 环境变量 COMFYUI_MODELS_DIR
  const envDir = options.envModelsDir !== undefined ? options.envModelsDir : process.env.COMFYUI_MODELS_DIR
  if (envDir) {
    addRoot(envDir, 'env')
  }

  // 辅助函数：解析指定 ComfyUI 根目录下的 extra_model_paths.yaml
  const parseExtraYamlIfPresent = (comfyRoot, extraConfigPath = null) => {
    const yamlPaths = []
    if (extraConfigPath && fs.existsSync(extraConfigPath)) {
      yamlPaths.push(extraConfigPath)
    }
    if (comfyRoot) {
      const standardYaml = path.join(comfyRoot, 'extra_model_paths.yaml')
      if (fs.existsSync(standardYaml)) {
        yamlPaths.push(standardYaml)
      }
    }

    for (const yPath of yamlPaths) {
      try {
        const content = fs.readFileSync(yPath, 'utf-8')
        const parsed = parseExtraModelPaths(content, comfyRoot)
        for (const r of parsed.roots) {
          addRoot(r, 'extra_yaml')
        }
        for (const [k, pathsList] of Object.entries(parsed.extraPaths)) {
          if (!extraPaths[k]) extraPaths[k] = []
          for (const p of pathsList) {
            if (!extraPaths[k].includes(p)) extraPaths[k].push(p)
          }
        }
      } catch {}
    }
  }

  // 优先级 3: 进程扫描（ComfyUI 运行时最可靠）
  let procResult = null
  if (options.mockProcessScan !== undefined) {
    procResult = options.mockProcessScan
  } else {
    procResult = scanProcessForComfyUI()
  }

  if (procResult && procResult.modelsDir) {
    addRoot(procResult.modelsDir, 'process')
    parseExtraYamlIfPresent(procResult.root, procResult.extraConfig)
  }

  // 优先级 4: 磁盘扫描兜底
  let diskScanList = []
  if (options.mockDiskScan !== undefined) {
    diskScanList = options.mockDiskScan
  } else {
    diskScanList = scanDrivesForComfyUI(options)
  }

  for (const item of diskScanList) {
    if (item && item.modelsDir) {
      addRoot(item.modelsDir, 'disk_scan')
      parseExtraYamlIfPresent(item.root)
    }
  }

  // 确定 primary 路径
  let primary = null
  let primarySource = null
  if (roots.length > 0) {
    primary = roots[0].path
    primarySource = roots[0].source
  }

  const result = {
    roots,
    primary,
    source: primarySource || 'none',
    extraPaths,
  }

  // 写入缓存文件
  try {
    const cacheData = {
      ...result,
      timestamp: Date.now(),
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf-8')
  } catch {}

  return result
}

/**
 * 多根全库扫描查重（兼容单根与多根）
 */
export function findInLibraryMulti(modelsDirs, filename, preferredSubfolder = null) {
  if (!filename) return { found: false, fullPath: null, size: 0, subfolder: null }
  const baseName = path.basename(filename).trim().toLowerCase()
  if (!baseName) return { found: false, fullPath: null, size: 0, subfolder: null }

  // 统一转为目录数组
  let dirs = []
  if (Array.isArray(modelsDirs)) {
    dirs = modelsDirs.map((d) => (typeof d === 'string' ? d : d?.path)).filter(Boolean)
  } else if (typeof modelsDirs === 'string' && modelsDirs.trim()) {
    dirs = [modelsDirs.trim()]
  }

  if (dirs.length === 0) return { found: false, fullPath: null, size: 0, subfolder: null }

  const searchSubs = []
  if (preferredSubfolder && STANDARD_SUBFOLDERS.includes(preferredSubfolder)) {
    searchSubs.push(preferredSubfolder)
  }
  for (const sf of STANDARD_SUBFOLDERS) {
    if (!searchSubs.includes(sf)) {
      searchSubs.push(sf)
    }
  }
  searchSubs.push('')

  for (const rootDir of dirs) {
    if (!fs.existsSync(rootDir)) continue
    for (const sub of searchSubs) {
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

/**
 * 目的地选择器：在多模型库根中优选下载落脚点
 * 规则：
 * 1. 优先“目标子目录已存在且有文件”的根；
 * 2. 平手时优先非 C 盘；
 * 3. 再按该根所在盘剩余空间（fs.statfs）最大；
 * 4. 绝不新建 C 盘根（已有 C 盘库里的子目录除外）。
 */
export function chooseFetchDestination(roots, subfolder = 'diffusion_models', options = {}) {
  let candidates = []
  if (Array.isArray(roots)) {
    candidates = roots.map((r) => (typeof r === 'string' ? r : r?.path)).filter(Boolean)
  } else if (typeof roots === 'string') {
    candidates = [roots]
  }

  if (candidates.length === 0) return null

  const statfsFn = options.statfsFn || ((p) => {
    try {
      return fs.statfsSync(p)
    } catch {
      return null
    }
  })

  const scored = candidates.map((rootPath) => {
    const isC = rootPath.toUpperCase().startsWith('C:')
    const subPath = path.join(rootPath, subfolder)
    let hasSubWithFiles = false
    try {
      if (fs.existsSync(subPath)) {
        const files = fs.readdirSync(subPath)
        hasSubWithFiles = files.length > 0
      }
    } catch {}

    let freeBytes = 0
    try {
      const st = statfsFn(rootPath)
      if (st) {
        freeBytes = Number(st.bfree || st.bavail || 0) * Number(st.bsize || 4096)
      }
    } catch {}

    return {
      rootPath,
      isC,
      hasSubWithFiles,
      freeBytes,
    }
  })

  scored.sort((a, b) => {
    // 1. 已有该子目录且里面有文件优先
    if (a.hasSubWithFiles !== b.hasSubWithFiles) {
      return a.hasSubWithFiles ? -1 : 1
    }
    // 2. 非 C 盘优先
    if (a.isC !== b.isC) {
      return a.isC ? 1 : -1
    }
    // 3. 剩余空间大者优先
    return b.freeBytes - a.freeBytes
  })

  return scored[0]?.rootPath || candidates[0]
}
