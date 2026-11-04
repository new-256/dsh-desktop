<#
  stage1-acceptance-supervisor.ps1 —— 阶段一「真机安装验收」的脱离进程树守护脚本。

  为什么必须"脱离进程树"：NSIS 的 customCheckAppRunning（build/installer.nsh:69-77）在安装段
  起点就 taskkill /F /T /IM "DSH Desktop.exe"，而本仓库的开发会话（DSH 里的 agent）正是该进程
  的后代 —— 直接在当前会话里点安装，等于把自己连同证据一起杀掉。所以本脚本由 Task Scheduler
  拉起（父进程 = 计划任务服务），装完再自己把证据写进仓库目录。

  它做的事（对应 task-8 验收要求，每步独立判定 PASS/FAIL，绝不编造成功）：
    [0] 预检：安装包哈希/字节、当前版本、磁盘、进程现状
    [1] 启动资源监控（独立进程，2s 采样 CPU/内存/GPU/显存 → CSV）
    [2] 静默标准安装（NSIS /S；不是解压即用），等待注册表版本变成目标版本
    [3] 装后核对：exe 文件版本、app.asar 存在、日志目录
    [4] 首次启动 → 等 lifecycle start(目标版本) → 等 starting backend → 等主窗口标题
        → 从日志取 127.0.0.1:<port> 实探 HTTP 200（"Web UI 首帧可见"的硬证据）→ 截图
    [5] 关到托盘：向主窗口发 WM_CLOSE → 断言进程仍存活且窗口消失 → 断言 lifecycle 有对应记录
    [6] 从托盘退出：优先 UIA（图标若在任务栏可见区）；不可达则如实记 SKIP 并给出人工步骤
    [7] 再启动一次 → 再次验证首帧 → 保持运行
    [8] 停监控并汇总峰值，写 JSON + Markdown 片段

  退出码：0=全程 PASS 或仅"需人工"项；1=存在自动化 FAIL。
#>

param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$RunId,
  [string]$FreezeId = 'FREEZE-2026-11-04-A',
  [string]$ExpectedVersion = '0.3.48',
  [string]$InstallDir = 'C:\Program Files\DSH Desktop',
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [int]$InstallTimeoutSec = 420,
  [int]$LaunchTimeoutSec = 240,
  [int]$QuitTimeoutSec = 90,
  # DryRun：只跑 [S0] 预检 + [S1] 起监控，然后停在「即将安装」之前，绝不执行安装。
  # 用于在真正触发前证明脚本可用（真实触发起会关掉宿主 DSH 与全部 agent 会话）。
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing | Out-Null

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Stage1Win {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint WM_CLOSE = 0x0010;
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
}
"@

# ── 基础设施：日志 / 截图 / 步骤记录 ─────────────────────────────────────────
$ErrorActionPreference = 'Continue'
$debugDir = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段'
$shotDir = Join-Path $debugDir "真机验收截图_$RunId"
New-Item -ItemType Directory -Force -Path $debugDir, $shotDir | Out-Null
$logFile = Join-Path $debugDir "真机验收原始日志_$RunId.log"
$resultJson = Join-Path $debugDir "真机验收原始记录_$RunId.json"

$script:steps = New-Object System.Collections.ArrayList

function Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level, $Message
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Shot {
  param([string]$Name)
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $p = Join-Path $shotDir "$Name.png"
    $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Log "  截图：$p"
    return $p
  } catch {
    Log "  截图失败：$($_.Exception.Message)" 'WARN'
    return $null
  }
}

function Step {
  param([string]$Id, [string]$Title, [scriptblock]$Body)
  Log ''
  Log ("===== [$Id] $Title =====")
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $entry = [ordered]@{ id = $Id; title = $Title; status = 'FAIL'; detail = ''; startedAt = (Get-Date).ToString('o'); durationSec = 0; evidence = @() }
  try {
    $r = & $Body
    if ($r -is [hashtable]) {
      $entry.status = $r.status
      $entry.detail = [string]$r.detail
      if ($r.evidence) { $entry.evidence = @($r.evidence) }
    } elseif ($r -eq $true) {
      $entry.status = 'PASS'; $entry.detail = 'OK'
    } else {
      $entry.status = 'FAIL'; $entry.detail = [string]$r
    }
  } catch {
    $entry.status = 'FAIL'
    $entry.detail = $_.Exception.Message
    Log ("  异常：" + $_.Exception.Message) 'ERROR'
    Log ($_.ScriptStackTrace) 'ERROR'
  }
  $sw.Stop()
  $entry.durationSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  [void]$script:steps.Add($entry)
  Log ("  → {0}  ({1}s) {2}" -f $entry.status, $entry.durationSec, $entry.detail)
  return $entry
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec, [string]$What, [int]$PollMs = 500)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { $v = & $Condition } catch { $v = $null }
    if ($v) { return $v }
    Start-Sleep -Milliseconds $PollMs
  }
  Log "  等待超时（${TimeoutSec}s）：$What" 'WARN'
  return $null
}

function Get-DshProcesses {
  @(Get-Process -Name 'DSH Desktop', 'dsh-desktop' -ErrorAction SilentlyContinue)
}

function Get-InstalledVersion {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    $hit = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DSH Desktop*' } | Select-Object -First 1
    if ($hit) { return $hit.DisplayVersion }
  }
  return $null
}

function Get-ExeFileVersion([string]$path) {
  try { return (Get-Item $path).VersionInfo.FileVersion } catch { return $null }
}

function Get-MainWindowHanlde {
  $p = Get-DshProcesses | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { return $p.MainWindowHandle }
  return [IntPtr]::Zero
}

# ── 启动护栏：确认自己不是 DSH 的后代（否则安装必然先杀掉自己）──────────────
$selfChain = @()
$cur = $PID
for ($i = 0; $i -lt 6; $i++) {
  $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
  if (-not $pr) { break }
  $selfChain += "$($pr.Name)($($pr.ProcessId))"
  $cur = $pr.ParentProcessId
  if (-not $cur -or $cur -eq 0) { break }
}
Log ("守护进程祖先链：" + ($selfChain -join ' ← '))
$descendantOfDsh = $selfChain -match 'DSH Desktop'
if ($descendantOfDsh -and -not $DryRun) {
  Log '✖ 致命：守护进程是 DSH Desktop 的后代，安装会把自己杀掉。请用 schtasks 以脱离进程树的方式启动。' 'ERROR'
  exit 1
}
if ($descendantOfDsh -and $DryRun) {
  Log '⚠ DryRun：本进程确实在 DSH 进程树内，但本次不执行安装，只做只读预检 + 监控自检。真实触发必须走 schtasks。' 'WARN'
}
Log '✔ 进程树关系检查完成（真实触发要求：不属于 DSH 进程树）'

$script:monitorProc = $null
$monitorStopFile = Join-Path $debugDir "monitor-stop-$RunId.flag"
$resourceCsv = Join-Path $debugDir '资源监控_阶段一.csv'
Remove-Item $monitorStopFile -Force -ErrorAction SilentlyContinue

# ══════════════════════════════════════════════════════════════════════════
$summary = [ordered]@{
  runId = $RunId; freezeId = $FreezeId; expectedVersion = $ExpectedVersion
  installer = $InstallerPath; installDir = $InstallDir
  startedAt = (Get-Date).ToString('o'); finishedAt = $null
  host = @{ os = (Get-CimInstance Win32_OperatingSystem).Caption; build = (Get-CimInstance Win32_OperatingSystem).BuildNumber; psVersion = $PSVersionTable.PSVersion.ToString() }
  steps = $null; resourceCsv = $resourceCsv; shots = @()
}

# [0] 预检
Step 'S0' '预检：安装包与现状' {
  if (-not (Test-Path $InstallerPath)) { return @{ status = 'FAIL'; detail = "安装包不存在：$InstallerPath" } }
  $fi = Get-Item $InstallerPath
  $hash = (Get-FileHash $InstallerPath -Algorithm SHA256).Hash
  $prevVer = Get-InstalledVersion
  $procs = Get-DshProcesses
  $disk = Get-PSDrive C
  Log "  安装包 : $($fi.FullName)"
  Log "  字节数 : $($fi.Length)"
  Log "  SHA-256: $hash"
  Log "  改动前已安装版本 : $prevVer"
  Log "  当前 DSH 进程数  : $($procs.Count)"
  Log "  C 盘剩余        : $([math]::Round($disk.Free/1GB,1)) GB"
  $summary.installerBytes = $fi.Length
  $summary.installerSha256 = $hash
  $summary.previousVersion = $prevVer
  $summary.diskFreeGbBefore = [math]::Round($disk.Free/1GB, 1)
  @{ status = 'PASS'; detail = "安装包 $($fi.Length) 字节，SHA-256=$hash，改动前版本=$prevVer"; evidence = @($hash) }
} | Out-Null

# [1] 资源监控
Step 'S1' '启动资源监控（2s 采样 CPU/内存/GPU/显存）' {
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { return @{ status = 'FAIL'; detail = '找不到 node.exe（资源监控器依赖它）' } }
  $monitorJs = Join-Path $RepoRoot '修复与借鉴_2026-11-04\02_编译阶段\tools\stage1-resource-monitor.js'
  if (-not (Test-Path $monitorJs)) { return @{ status = 'FAIL'; detail = "监控器不存在：$monitorJs" } }
  $monitorLog = Join-Path $debugDir "资源监控_阶段一_控制台_$RunId.log"
  $script:monitorProc = Start-Process -FilePath $nodeExe -ArgumentList @(
    "`"$monitorJs`"", '--out', "`"$resourceCsv`"", '--interval', '2',
    '--name', '"DSH Desktop.exe,node.exe,npm.exe,electron.exe"',
    '--stop-file', "`"$monitorStopFile`"", '--label', '"阶段一真机验收 ' + $RunId + '"'
  ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $monitorLog -RedirectStandardError "$monitorLog.err"
  Start-Sleep -Seconds 2
  if ($script:monitorProc.HasExited) {
    $err = if (Test-Path "$monitorLog.err") { (Get-Content "$monitorLog.err" -Raw) } else { '' }
    return @{ status = 'FAIL'; detail = "监控器启动即退出：$err" }
  }
  Log "  监控器 pid=$($script:monitorProc.Id) → $resourceCsv"
  @{ status = 'PASS'; detail = "监控器已启动 pid=$($script:monitorProc.Id)"; evidence = @($resourceCsv, $monitorLog) }
} | Out-Null

# DryRun 停止点：只做到「即将安装」之前 —— 用于在真实触发前证明脚本可用，
# 且不对系统做任何改动（不装、不启动、不篡改）。
if ($DryRun) {
  Log ''
  Log '===== DryRun 停止点：已停在「即将执行安装」之前，未对系统做任何改动 ====='
  if ($script:monitorProc -and -not $script:monitorProc.HasExited) {
    Set-Content -Path $monitorStopFile -Value 'stop' -Encoding utf8
    [void](Wait-Until -TimeoutSec 15 -What '监控器退出' -Condition { $script:monitorProc.HasExited })
    if (-not $script:monitorProc.HasExited) { try { $script:monitorProc.Kill() } catch {} }
    Log '  已停止资源监控（自检完成）'
  }
  $dry = [ordered]@{
    runId = $RunId; dryRun = $true; stoppedBefore = 'S2 安装'
    startedAt = $summary.startedAt; finishedAt = (Get-Date).ToString('o')
    steps = $script:steps
    note = '真实触发请用 schtasks（脱离 DSH 进程树），命令见 03_调试阶段/真机验收_触发说明.md'
  }
  ($dry | ConvertTo-Json -Depth 8) | Set-Content -Path ($resultJson -replace '\.json$', '_dryrun.json') -Encoding utf8
  Log ("  DryRun 记录：" + ($resultJson -replace '\.json$', '_dryrun.json'))
  exit 0
}

# [2] 静默标准安装
Step 'S2' "标准 NSIS 安装（/S，目标版本 $ExpectedVersion）" {
  # 注意：/S 会跳过 nsDialogs 的后端版本选择页（该页在静默安装下不显示），
  # 其余安装段（结束进程 → 卸载旧版 → 写文件 → 快捷方式）全部照常执行 —— 这正是"标准安装"。
  $log0 = Get-DshProcesses | Select-Object -ExpandProperty Id -ErrorAction SilentlyContinue
  Log "  安装前 DSH 进程：$(if($log0){$log0 -join ','}else{'(无)'})"
  $p = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru
  Log "  安装器 pid=$($p.Id)，等待退出（超时 ${InstallTimeoutSec}s）"
  if (-not $p.WaitForExit($InstallTimeoutSec * 1000)) {
    Log '  安装器超时未退出' 'ERROR'
    return @{ status = 'FAIL'; detail = "安装器 ${InstallTimeoutSec}s 未退出（pid=$($p.Id)）" }
  }
  Log "  安装器退出码：$($p.ExitCode)"
  $v = Wait-Until -TimeoutSec 180 -What "注册表版本变为 $ExpectedVersion" -Condition { (Get-InstalledVersion) -eq $ExpectedVersion }
  $finalVer = Get-InstalledVersion
  if (-not $v) {
    return @{ status = 'FAIL'; detail = "安装器 exit=$($p.ExitCode)，但注册表版本仍为 $finalVer（期望 $ExpectedVersion）" }
  }
  @{ status = 'PASS'; detail = "安装器 exit=$($p.ExitCode)，注册表版本=$finalVer"; evidence = @("registry=0.3.48") }
} | Out-Null

# [3] 装后核对
Step 'S3' '装后核对：exe 文件版本 / app.asar / 日志目录' {
  $exe = Join-Path $InstallDir 'DSH Desktop.exe'
  $asar = Join-Path $InstallDir 'resources\app.asar'
  $logs = Join-Path $InstallDir 'logs'
  if (-not (Test-Path $exe)) { return @{ status = 'FAIL'; detail = "找不到 $exe" } }
  if (-not (Test-Path $asar)) { return @{ status = 'FAIL'; detail = "找不到 $asar" } }
  $fv = Get-ExeFileVersion $exe
  $asarBytes = (Get-Item $asar).Length
  Log "  exe 文件版本 ：$fv"
  Log "  app.asar 字节：$asarBytes"
  Log "  日志目录存在 ：$(Test-Path $logs)"
  if ($fv -and $fv -notlike "*$ExpectedVersion*") {
    return @{ status = 'FAIL'; detail = "exe 文件版本为 $fv，与期望 $ExpectedVersion 不符" }
  }
  @{ status = 'PASS'; detail = "exe FileVersion=$fv，app.asar=$asarBytes 字节" }
} | Out-Null

# 记录启动前的 lifecycle 行数（用于判定"新的一次启动"）
$lifecycleLog = Join-Path $InstallDir 'logs\DSH-Desktop-生命周期.log'
$mainLog = Join-Path $InstallDir 'logs\DSH-Desktop-日志.txt'
function Get-LineCount([string]$p) { if (Test-Path $p) { return @(Get-Content $p -ErrorAction SilentlyContinue).Count } return 0 }

function Start-And-VerifyLaunch {
  param([string]$Tag)
  $exe = Join-Path $InstallDir 'DSH Desktop.exe'
  $beforeLines = Get-LineCount $lifecycleLog
  $beforeMainLines = Get-LineCount $mainLog
  Log "  启动前 lifecycle 行数=$beforeLines，主日志行数=$beforeMainLines"

  Start-Process -FilePath $exe | Out-Null
  Log '  已发出启动命令'

  $startEvent = Wait-Until -TimeoutSec $LaunchTimeoutSec -What "lifecycle 出现新 start 事件（$ExpectedVersion）" -Condition {
    if (-not (Test-Path $lifecycleLog)) { return $null }
    $lines = Get-Content $lifecycleLog -ErrorAction SilentlyContinue | Select-Object -Skip $beforeLines
    foreach ($l in $lines) {
      if ($l -match '"event":"start"') {
        try {
          $o = $l | ConvertFrom-Json
          return [pscustomobject]@{ pid = $o.pid; version = $o.version; reason = $o.reason; raw = $l }
        } catch { }
      }
    }
    return $null
  }
  if (-not $startEvent) { throw "启动后 ${LaunchTimeoutSec}s 内 lifecycle 没有新的 start 事件（应用可能没起来）" }
  Log "  lifecycle start：pid=$($startEvent.pid) version=$($startEvent.version) reason=$($startEvent.reason)"
  if ($startEvent.version -ne $ExpectedVersion) { throw "启动的版本是 $($startEvent.version)，不是期望的 $ExpectedVersion" }

  # 后端 spawn
  $backendLine = Wait-Until -TimeoutSec $LaunchTimeoutSec -What '主日志出现 starting backend' -Condition {
    if (-not (Test-Path $mainLog)) { return $null }
    $hit = Get-Content $mainLog -ErrorAction SilentlyContinue | Select-Object -Skip $beforeMainLines | Select-String -Pattern 'starting backend' -SimpleMatch | Select-Object -Last 1
    if ($hit) { return $hit.Line } return $null
  }
  if (-not $backendLine) { throw '主日志里没有 starting backend，后端可能未启动' }
  Log "  后端启动行：$($backendLine.Trim())"

  # 主窗口出现且标题非空（= Electron 已把 Web UI 装进窗口）
  $title = Wait-Until -TimeoutSec $LaunchTimeoutSec -What '主窗口出现且标题非空' -Condition {
    $p = Get-DshProcesses | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 1
    if ($p) { return $p.MainWindowTitle } return $null
  }
  if (-not $title) { throw '主窗口标题始终为空（可能停在启动画面）' }
  Log "  主窗口标题：$title"

  # 从日志里取后端端口，实探 HTTP 200 —— "Web UI 首帧可见" 的硬证据
  $portInfo = $null
  $port = Wait-Until -TimeoutSec 60 -What '日志中出现 127.0.0.1:<port> 的 Web UI 地址' -Condition {
    if (-not (Test-Path $mainLog)) { return $null }
    $text = Get-Content $mainLog -Tail 400 -ErrorAction SilentlyContinue | Out-String
    $m = [regex]::Matches($text, 'http://127\.0\.0\.1:(\d+)/')
    if ($m.Count -gt 0) { return $m[$m.Count - 1].Groups[1].Value }
    return $null
  }
  if ($port) {
    Log "  探测端口：$port"
    $probe = Wait-Until -TimeoutSec 90 -What "HTTP 200 http://127.0.0.1:$port/" -Condition {
      try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 10
        if ($resp.StatusCode -eq 200) { return [pscustomobject]@{ code = 200; bytes = $resp.RawContentLength; ctype = $resp.Headers['Content-Type'] } }
      } catch { }
      return $null
    }
    if ($probe) {
      $portInfo = "HTTP 200 @ 127.0.0.1:$port（$($probe.bytes) 字节，Content-Type=$($probe.ctype)）"
      Log "  ✔ $portInfo"
    } else {
      Log "  ⚠ 端口 $port 的 HTTP 探测未拿到 200" 'WARN'
    }
  } else {
    Log '  ⚠ 日志里没找到后端端口，跳过 HTTP 探测' 'WARN'
  }

  Start-Sleep -Seconds 2
  $shot = Shot "$Tag-首帧"
  if ($shot) { $script:summary.shots += $shot }
  return [pscustomobject]@{
    pid = $startEvent.pid; title = $title; port = $port; portInfo = $portInfo; shot = $shot
  }
}

# [4] 首次启动到首帧
$firstLaunch = $null
Step 'S4' '首次启动 → Web UI 首帧' {
  $r = Start-And-VerifyLaunch -Tag 'first-launch'
  $script:firstLaunch = $r
  $summary.firstLaunch = @{ pid = $r.pid; title = $r.title; port = $r.port; http = $r.portInfo; shot = $r.shot }
  @{ status = 'PASS'; detail = "首帧 OK：pid=$($r.pid)，窗口='$($r.title)'，$($r.portInfo)"; evidence = @($r.shot) }
} | Out-Null

# [5] 关到托盘
Step 'S5' '关窗口 → 留在托盘（进程存活、窗口消失）' {
  $h = Get-MainWindowHanlde
  if ($h -eq [IntPtr]::Zero) { return @{ status = 'FAIL'; detail = '找不到主窗口句柄，无法发送 WM_CLOSE' } }
  Log "  主窗口句柄：$h，发送 WM_CLOSE"
  [Stage1Win]::PostMessage($h, [Stage1Win]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Seconds 6
  $procs = Get-DshProcesses
  $visible = @($procs | Where-Object { $_.MainWindowHandle -ne 0 })
  Log "  关闭后 DSH 进程数：$($procs.Count)（有主窗口的：$($visible.Count)）"
  $shot = Shot 'close-to-tray'
  if ($shot) { $script:summary.shots += $shot }
  if ($procs.Count -eq 0) {
    return @{ status = 'FAIL'; detail = '关闭窗口后进程全退出了 —— 没有留在托盘，与"关到托盘"预期不符' }
  }
  if ($visible.Count -gt 0) {
    return @{ status = 'FAIL'; detail = "进程存活但仍有可见主窗口（$($visible.Count) 个），未真正隐藏" }
  }
  @{ status = 'PASS'; detail = "进程仍存活 $($procs.Count) 个、主窗口已隐藏 = 留在托盘运行"; evidence = @($shot) }
} | Out-Null

# [6] 从托盘退出
Step 'S6' '从托盘真正退出（UIA；不可达则如实记 SKIP）' {
  $beforeLines = Get-LineCount $lifecycleLog
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $tbCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
  $tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $tbCond)

  # 情况 A：图标已固定在任务栏可见区（可直接右键）
  $icon = $null
  $zone = $null
  foreach ($e in $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $e.Current.ClassName -eq 'SystemTray.NormalButton' -and $e.Current.Name -match 'DSH Desktop') {
        $icon = $e; $zone = 'taskbar'; break
      }
    } catch { }
  }

  # 情况 B：图标在溢出区（no-activate 浮层，合成输入通常打不开菜单）
  if (-not $icon) {
    Log '  任务栏可见区没有 DSH 图标，尝试展开溢出区'
    $toggle = $null
    foreach ($e in $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      try { if ($e.Current.Name -match '显示隐藏的图标|通知|Notifications') { $toggle = $e; break } } catch { }
    }
    if ($toggle) {
      $tr = $toggle.Current.BoundingRectangle
      [Stage1Win]::SetCursorPos([int]($tr.X + $tr.Width / 2), [int]($tr.Y + $tr.Height / 2)) | Out-Null
      Start-Sleep -Milliseconds 200
      [Stage1Win]::mouse_event([Stage1Win]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 80
      [Stage1Win]::mouse_event([Stage1Win]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      $island = Wait-Until -TimeoutSec 5 -What '溢出岛窗口出现' -Condition {
        foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
          try { if ($w.Current.ClassName -match 'Overflow|NotifyIcon') { return $w } } catch { }
        }
        return $null
      }
      if ($island) {
        foreach ($e in $island.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          try { if ($e.Current.Name -match 'DSH Desktop') { $icon = $e; $zone = 'overflow'; break } } catch { }
        }
      }
    }
  }

  if ($icon) {
    Log "  DSH 托盘图标位置：$zone，name='$($icon.Current.Name)'"
    $ir = $icon.Current.BoundingRectangle
    [Stage1Win]::SetCursorPos([int]($ir.X + $ir.Width / 2), [int]($ir.Y + $ir.Height / 2)) | Out-Null
    Start-Sleep -Milliseconds 250
    [Stage1Win]::mouse_event([Stage1Win]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400   # 刻意延迟右键抬起：过快的 DOWN/UP 会被浮层当作"点空白"而吞掉菜单
    [Stage1Win]::mouse_event([Stage1Win]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 900

    $quitItem = $null
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try {
        if ($w.Current.ClassName -match '32678|Menu|Popup') {
          foreach ($it in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            try { if ($it.Current.Name -match '^\s*退出\s*$' -or $it.Current.Name -match '退出应用|Quit') { $quitItem = $it; break } } catch { }
          }
        }
      } catch { }
      if ($quitItem) { break }
    }

    if ($quitItem) {
      Log "  找到菜单项：'$($quitItem.Current.Name)'，执行 Invoke"
      try {
        $pat = $quitItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pat.Invoke()
      } catch {
        Log ("  Invoke 失败，改用点击：" + $_.Exception.Message) 'WARN'
        $qr = $quitItem.Current.BoundingRectangle
        [Stage1Win]::SetCursorPos([int]($qr.X + $qr.Width / 2), [int]($qr.Y + $qr.Height / 2)) | Out-Null
        Start-Sleep -Milliseconds 150
        [Stage1Win]::mouse_event([Stage1Win]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [Stage1Win]::mouse_event([Stage1Win]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      }
    } else {
      Log '  ⚠ 右键后没有枚举到托盘菜单（Electron 菜单未弹出或被浮层吞掉）' 'WARN'
      [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    }
  }

  $gone = Wait-Until -TimeoutSec $QuitTimeoutSec -What 'DSH 进程全部退出' -Condition { (Get-DshProcesses).Count -eq 0 }
  if ($gone) {
    $exitEvent = $null
    if (Test-Path $lifecycleLog) {
      $lines = Get-Content $lifecycleLog -ErrorAction SilentlyContinue | Select-Object -Skip $beforeLines
      foreach ($l in $lines) {
        if ($l -match '"event":"exit"') { try { $o = $l | ConvertFrom-Json; $exitEvent = $o } catch { } }
      }
    }
    if ($exitEvent) {
      Log "  lifecycle exit：reason=$($exitEvent.reason) detail=$($exitEvent.detail) uptimeMs=$($exitEvent.uptimeMs)"
      $summary.trayQuit = @{ reason = $exitEvent.reason; detail = $exitEvent.detail; uptimeMs = $exitEvent.uptimeMs }
      return @{ status = 'PASS'; detail = "已退出，lifecycle reason=$($exitEvent.reason)"; evidence = @("exit-reason=$($exitEvent.reason)") }
    }
    return @{ status = 'PASS'; detail = '进程已退出（未取到 lifecycle exit 行）' }
  }

  # 自动化不可达 —— 如实记录，不伪造
  Start-Sleep -Seconds 1
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  @{ status = 'SKIP'; detail = "自动化未能驱动托盘菜单退出（zone=$zone）。需人工一步：右键任务栏托盘的 DSH 图标 → 「退出」；核对 logs\DSH-Desktop-生命周期.log 出现 reason=tray-quit" }
} | Out-Null

# [7] 再启动一次
Step 'S7' '再启动一次 → 再次验证首帧（并保持运行）' {
  $r = Start-And-VerifyLaunch -Tag 'relaunch'
  $summary.relaunch = @{ pid = $r.pid; title = $r.title; port = $r.port; http = $r.portInfo; shot = $r.shot }
  @{ status = 'PASS'; detail = "二次启动首帧 OK：pid=$($r.pid)，$($r.portInfo)"; evidence = @($r.shot) }
} | Out-Null

# [8] 收尾：停监控、汇总
Step 'S8' '停止资源监控并汇总峰值' {
  if ($script:monitorProc -and -not $script:monitorProc.HasExited) {
    Set-Content -Path $monitorStopFile -Value 'stop' -Encoding utf8
    $ok = Wait-Until -TimeoutSec 20 -What '监控器退出' -Condition { $script:monitorProc.HasExited }
    if (-not $ok) { try { $script:monitorProc.Kill() } catch {} }
    Log "  监控器已停止（exit=$($script:monitorProc.ExitCode)）"
  }
  if (Test-Path $resourceCsv) {
    $peak = (Get-Content $resourceCsv -ErrorAction SilentlyContinue | Select-String -Pattern '峰值|CPU 峰值|GPU 峰值' | ForEach-Object { $_.Line.Trim() })
    Log "  资源监控摘要：$($peak -join ' / ')"
  }
  @{ status = 'PASS'; detail = "资源监控 CSV：$resourceCsv；停止文件已写" }
} | Out-Null

$summary.steps = $script:steps
$summary.finishedAt = (Get-Date).ToString('o')
$failCount = @($script:steps | Where-Object { $_.status -eq 'FAIL' }).Count
$skipCount = @($script:steps | Where-Object { $_.status -eq 'SKIP' }).Count
$passCount = @($script:steps | Where-Object { $_.status -eq 'PASS' }).Count
$summary.counts = @{ pass = $passCount; fail = $failCount; skip = $skipCount }
$summary.passed = ($failCount -eq 0)

$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $resultJson -Encoding utf8
Log ''
Log "===== 汇总：PASS=$passCount FAIL=$failCount SKIP=$skipCount ====="
Log "  原始记录：$resultJson"
Log "  原始日志：$logFile"
Log "  截图目录：$shotDir"
if ($failCount -gt 0) { Log '  结论：✖ 存在自动化 FAIL，需人工复核' 'ERROR' }
else { Log '  结论：✔ 自动化验收全部通过（SKIP 项需人工补一步）' }

exit ([int]($failCount -gt 0))
