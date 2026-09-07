// lib/installer.mjs — ComfyUI 本地检测、硬件评估与自动化安装器
//
// 专为 Windows 消费级硬件打造：
// 1. 本地安装检测：全盘扫描寻找已有的 ComfyUI 安装并提取启动方式（startHint）；
// 2. 硬件达标评估：探测 NVIDIA 显卡显存、CUDA 驱动版本、系统 RAM、非 C 盘空闲容量；
// 3. 自动化安装器：严禁安装在 C 盘，优先选择空间充裕的非 C 盘根目录（<盘>:\ComfyUI）；
// 4. 纯内置流式下载（复用 downloader.mjs）与解压，生成快捷方式与启动脚本。

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import { downloadFile } from './downloader.mjs'

/**
 * 扫描指定目录及上一层目录，寻找 ComfyUI 启动脚本或启动器
 */
export function findStartHint(comfyRoot) {
  if (!comfyRoot || !fs.existsSync(comfyRoot)) return '请在控制台运行 python main.py'

  const checkDirs = [comfyRoot, path.dirname(comfyRoot)]
  for (const dir of checkDirs) {
    if (!fs.existsSync(dir)) continue
    try {
      const files = fs.readdirSync(dir)
      // 1. 优先 run_nvidia_gpu.bat
      if (files.includes('run_nvidia_gpu.bat')) {
        return `运行 ${path.join(dir, 'run_nvidia_gpu.bat')}`
      }
      // 2. 找秋叶等整合包启动器 exe (含 launcher 或 绘世)
      const launcherExe = files.find((f) => /launcher|绘世/i.test(f) && f.endsWith('.exe'))
      if (launcherExe) {
        return `双击运行 ${path.join(dir, launcherExe)}`
      }
      // 3. run_cpu.bat
      if (files.includes('run_cpu.bat')) {
        return `运行 ${path.join(dir, 'run_cpu.bat')}`
      }
      // 4. 其他 bat 脚本
      const anyBat = files.find((f) => f.endsWith('.bat') && !/update|install|uninstall|setup/i.test(f))
      if (anyBat) {
        return `运行 ${path.join(dir, anyBat)}`
      }
    } catch {}
  }

  return `在 ${comfyRoot} 运行 python main.py`
}

/**
 * 扫描磁盘检测已有的 ComfyUI 安装（即便服务未启动也能找到）
 */
export function detectComfyUIInstall(options = {}) {
  const results = []
  const deadline = Date.now() + (options.timeoutMs || 3000)

  // 盘符顺序：先 D..Z 再 C（已有安装全盘识别）
  let letters = []
  if (options.drives && Array.isArray(options.drives)) {
    letters = options.drives
  } else if (process.platform === 'win32') {
    for (let i = 68; i <= 90; i++) {
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
      let entries
      try {
        entries = fs.readdirSync(drive, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (Date.now() > deadline) break
        if (!entry.isDirectory()) continue
        const name = entry.name
        const fullDir = path.join(drive, name)

        // 检查深度 1: 形如 D:\ComfyUI
        if (fs.existsSync(path.join(fullDir, 'main.py'))) {
          results.push({
            root: fullDir,
            startHint: findStartHint(fullDir),
          })
          continue
        }

        // 检查深度 2: 例如 D:\ComfyUI-aki-v3\ComfyUI\main.py
        if (/^comfyui|aki/i.test(name)) {
          const innerComfy = path.join(fullDir, 'ComfyUI')
          if (fs.existsSync(path.join(innerComfy, 'main.py'))) {
            results.push({
              root: innerComfy,
              startHint: findStartHint(innerComfy),
            })
          }
        }
      }
    } catch {}
  }

  return {
    installed: results.length > 0,
    paths: results,
  }
}

/**
 * 硬件资源与环境达标评估
 */
export function deviceAssessment(options = {}) {
  let gpuName = null
  let driverVersion = null
  let vramGB = null

  // 1. GPU 信息获取
  if (options.mockGpu !== undefined) {
    gpuName = options.mockGpu.name || null
    driverVersion = options.mockGpu.driverVersion || null
    vramGB = options.mockGpu.vramGB !== undefined ? options.mockGpu.vramGB : null
  } else if (process.platform === 'win32') {
    try {
      const cmd = 'nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader'
      const stdout = execSync(cmd, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' })
      if (stdout && stdout.trim()) {
        const parts = stdout.trim().split(/\r?\n/)[0].split(',')
        if (parts.length >= 3) {
          gpuName = parts[0].trim()
          driverVersion = parts[1].trim()
          const memStr = parts[2].trim()
          const memMatch = memStr.match(/(\d+)/)
          if (memMatch) {
            vramGB = Math.round(parseInt(memMatch[1], 10) / 1024)
          }
        }
      }
    } catch {
      // 无 nvidia-smi 或非 NVIDIA GPU
    }
  }

  // 2. 系统物理内存 RAM
  const ramGB = options.mockRamGB !== undefined ? options.mockRamGB : Math.round(os.totalmem() / (1024 ** 3))

  // 3. 非 C 盘剩余空间枚举
  const statfsFn = options.statfsFn || ((p) => {
    try {
      return fs.statfsSync(p)
    } catch {
      return null
    }
  })

  let targetDriveHint = null
  let maxFreeGB = 0

  if (options.mockDisks) {
    for (const [d, freeGB] of Object.entries(options.mockDisks)) {
      const isC = d.toUpperCase().startsWith('C') && !options.targetDriveHint
      if (!isC && freeGB > maxFreeGB) {
        maxFreeGB = freeGB
        targetDriveHint = options.targetDriveHint || d
      }
    }
  } else if (process.platform === 'win32') {
    for (let i = 68; i <= 90; i++) { // D..Z
      const d = String.fromCharCode(i) + ':\\'
      try {
        if (!fs.existsSync(d)) continue
        const st = statfsFn(d)
        if (st) {
          const freeBytes = Number(st.bfree || st.bavail || 0) * Number(st.bsize || 4096)
          const freeGB = Math.round(freeBytes / (1024 ** 3))
          if (freeGB > maxFreeGB) {
            maxFreeGB = freeGB
            targetDriveHint = String.fromCharCode(i) + ':'
          }
        }
      } catch {}
    }
  }

  // 4. 预检拦截规则 (blockers)
  const blockers = []
  if (!gpuName) {
    blockers.push('未检测到 NVIDIA GPU，无法运行 ComfyUI CUDA 加速工作流')
  } else {
    if (vramGB !== null && vramGB < 7.5) {
      blockers.push(`显存不足 8GB (当前 ${vramGB}GB)`)
    }
    if (driverVersion) {
      const major = parseFloat(driverVersion)
      if (!isNaN(major) && major < 525) {
        blockers.push(`NVIDIA 驱动版本过低 (${driverVersion} < 525)，无法兼容现代 PyTorch/CUDA 运行时`)
      }
    }
  }

  if (ramGB < 15) {
    blockers.push(`系统物理内存不足 16GB (当前 ${ramGB}GB)`)
  }

  if (!targetDriveHint || maxFreeGB < 50) {
    blockers.push('没有剩余空间 ≥50GB 的非 C 盘 (便携包及模型运行需要至少 50GB 存储空间)')
  }

  const viable = blockers.length === 0

  return {
    device: {
      gpuName,
      vramGB,
      driverVersion,
      ramGB,
    },
    viable,
    blockers,
    targetDriveHint: targetDriveHint || (maxFreeGB >= 50 ? 'D:' : null),
    targetDriveFreeGB: maxFreeGB,
  }
}

/**
 * 当 ComfyUI 服务未连上时，生成结构化的诊断与操作建议
 */
export function assessComfyUIStatus(options = {}) {
  const installInfo = detectComfyUIInstall(options)
  const assessment = deviceAssessment(options)

  let suggestedAction = 'not_viable'
  let recommendation = ''

  if (installInfo.installed) {
    suggestedAction = 'start_existing'
    const first = installInfo.paths[0]
    recommendation = `发现本地已有 ComfyUI 安装（位于 ${first.root}）。建议先启动现有版本：${first.startHint}。启动后插件将自动连接并发现其模型库。`
  } else if (assessment.viable) {
    suggestedAction = 'offer_install'
    recommendation = `本地未检测到 ComfyUI 服务或安装，但当前设备配置达标（${assessment.device.gpuName} / ${assessment.device.vramGB}GB 显存 / ${assessment.device.ramGB}GB 内存）。可在空间充足的非 C 盘（推荐 ${assessment.targetDriveHint}\\ComfyUI）一键安装官方便携版。若需要安装，请使用 comfyui_install 并确认。`
  } else {
    suggestedAction = 'not_viable'
    recommendation = `本地未运行 ComfyUI，且当前设备不满足推荐安装门槛：${assessment.blockers.join('；')}。建议升级硬件配置（推荐 16GB+ 显存，32GB+ 内存）或使用云端 GPU 推理服务。`
  }

  return {
    ok: false,
    reachable: false,
    installed: installInfo.installed,
    installPaths: installInfo.paths,
    device: assessment.device,
    recommendation,
    suggestedAction,
    installOffer: {
      viable: assessment.viable,
      blockers: assessment.blockers,
      targetDriveHint: assessment.targetDriveHint,
    },
  }
}

/**
 * 执行 ComfyUI 官方便携版安装
 */
export async function executeComfyUIInstall(params, options = {}) {
  // 1. 用户显式确认鉴权
  if (params?.confirm !== true) {
    return {
      ok: false,
      error: 'CONFIRMATION_REQUIRED',
      message: '安装 ComfyUI 便携版将下载约 2GB 安装包并解压，请先征得用户明确同意，再传入 confirm: true 执行。',
    }
  }

  // 2. 硬件达标预检
  const assessment = deviceAssessment(options)
  if (!assessment.viable) {
    return {
      ok: false,
      error: 'PRECHECK_FAILED',
      blockers: assessment.blockers,
      message: `设备未达到推荐安装门槛: ${assessment.blockers.join('；')}`,
    }
  }

  // 3. 确定目标磁盘与目录（严禁 C 盘）
  let targetDrive = params?.target_drive ? String(params.target_drive).trim().toUpperCase() : null
  if (targetDrive) {
    if (!targetDrive.endsWith(':')) targetDrive += ':'
  } else {
    targetDrive = assessment.targetDriveHint
  }

  if (!targetDrive || targetDrive.startsWith('C')) {
    return {
      ok: false,
      error: 'C_DRIVE_FORBIDDEN',
      message: '严禁将 ComfyUI 安装到 C 盘，请选择其他剩余空间充裕的磁盘（如 D: 或 E:）。',
    }
  }

  // 目标根目录为 <盘>:\ComfyUI，易于用户查找（支持 options.targetDir 测试注入）
  const targetDir = options.targetDir || path.join(targetDrive + '\\', 'ComfyUI')
  if (fs.existsSync(targetDir)) {
    return {
      ok: false,
      error: 'TARGET_EXISTS',
      targetDir,
      message: `目标安装路径 ${targetDir} 已存在，为防止破坏已有数据，已中止安装。请手动检查该目录或指定其他磁盘。`,
    }
  }

  // 4. 根据 NVIDIA 驱动版本匹配官方包
  let pkgFilename = 'ComfyUI_windows_portable_nvidia.7z'
  const driverVer = parseFloat(assessment.device.driverVersion || '560')
  if (!isNaN(driverVer) && driverVer < 560 && driverVer >= 525) {
    pkgFilename = 'ComfyUI_windows_portable_nvidia_cu126.7z'
  }

  const officialUrl = `https://github.com/Comfy-Org/ComfyUI/releases/download/v0.34.0/${pkgFilename}`
  const mirrorUrl = `https://ghfast.top/${officialUrl}`
  const urls = options.downloadUrls || [officialUrl, mirrorUrl]

  // 5. 下载至临时目录
  const tmpDir = options.tmpDir || path.join(targetDrive + '\\', '.comfyui_installer_tmp')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }
  const archivePath = path.join(tmpDir, pkgFilename)

  let downloadResult = null
  if (options.mockDownload) {
    downloadResult = await options.mockDownload({ urls, dest: archivePath })
  } else {
    try {
      const dl = await downloadFile({
        urls,
        dest: archivePath,
        signal: options.signal,
        timeoutMs: (params?.timeout_sec || 3600) * 1000,
      })
      downloadResult = { ok: true, ...dl }
    } catch (err) {
      downloadResult = { ok: false, error: err.message }
    }
  }

  if (!downloadResult || !downloadResult.ok) {
    return {
      ok: false,
      error: 'DOWNLOAD_FAILED',
      message: `下载 ComfyUI 便携包失败: ${downloadResult?.error || '网络错误'}`,
    }
  }

  // 6. 解压压缩包
  try {
    if (options.extractor) {
      await options.extractor({ archivePath, targetDir, targetDrive })
    } else {
      // 真实解压流程：解到 targetDrive 根，便携包自建 ComfyUI_windows_portable
      const sevenZipExe = path.join(tmpDir, '7zr.exe')
      if (!fs.existsSync(sevenZipExe)) {
        // 7zr.exe 是自解压控制台程序本体(~1.1MB),直接下载即用;
        // 不用任何 .7z 格式的镜像做兜底——没有 7zr 就解不开 .7z,鸡生蛋
        await downloadFile({
          urls: ['https://www.7-zip.org/a/7zr.exe'],
          dest: sevenZipExe,
          signal: options.signal,
        })
      }
      execSync(`"${sevenZipExe}" x -o"${targetDrive}\\" -y "${archivePath}"`, { timeout: 600000 })
      const extractedRoot = path.join(targetDrive + '\\', 'ComfyUI_windows_portable')
      if (fs.existsSync(extractedRoot) && !fs.existsSync(targetDir)) {
        fs.renameSync(extractedRoot, targetDir)
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: 'EXTRACT_FAILED',
      message: `解压 ComfyUI 便携包失败: ${err.message}`,
    }
  }

  // 7. 收尾：写出启动脚本并创建桌面快捷方式
  const batPath = path.join(targetDir, '启动ComfyUI.bat')
  const batContent = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'if exist run_nvidia_gpu.bat (',
    '    call run_nvidia_gpu.bat',
    ') else if exist ComfyUI\\main.py (',
    '    python_embeded\\python.exe ComfyUI\\main.py',
    ') else if exist main.py (',
    '    python\\python.exe main.py',
    ')',
  ].join('\r\n')
  try {
    fs.writeFileSync(batPath, batContent, 'utf-8')
  } catch {}

  let shortcutPath = null
  try {
    if (options.shellExecutor) {
      shortcutPath = await options.shellExecutor({ batPath, targetDir })
    } else if (process.platform === 'win32') {
      const desktopDir = path.join(os.homedir(), 'Desktop')
      shortcutPath = path.join(desktopDir, 'ComfyUI.lnk')
      const psCmd = `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $s.TargetPath = '${batPath.replace(/'/g, "''")}'; $s.WorkingDirectory = '${targetDir.replace(/'/g, "''")}'; $s.Save()`
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 5000, stdio: 'ignore' })
    }
  } catch {
    // 快捷方式失败不影响整体安装成功
  }

  // 8. 清理临时下载文件
  try {
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath)
  } catch {}

  return {
    ok: true,
    installedPath: targetDir,
    version: 'v0.34.0',
    shortcutPath,
    startMethod: `双击运行 ${batPath}${shortcutPath ? ' 或桌面快捷方式 ComfyUI' : ''}`,
    message: `ComfyUI 便携版已成功安装至 ${targetDir}！首次启动后插件会自动发现该目录下的 models 文件夹作为模型库。`,
  }
}
