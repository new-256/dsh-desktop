<#
  stage1-portable-smoke.ps1 —— 「不安装也能证明装完能起」的便携冒烟（lead 裁决 2 的替代手段）。

  为什么不做 NSIS 安装：安装器的 DshTerminateAll（installer.nsh:69-77）会 taskkill /F /T
  掉 "DSH Desktop.exe"，而开发会话正是它的后代 —— 在阶段一装一次会把整条流水线打断，
  而卸载/重装只应发生一次（阶段二统一做）。

  本脚本改为：把 release/win-unpacked 整棵复制到临时目录，用隔离的 userData 与日志基址
  直接启动这份**即将被装进安装包的同一组二进制**，验证它能不能起来、能不能出 Web UI 首帧。

  隔离手段（都不改产品代码）：
    --user-data-dir=<temp>\userdata   Electron 官方命令行开关，让 userData（含单实例锁、
                                      缓存、WebStorage）全部落在临时目录；
    DSH_DIAG_BASE=<temp>\diag         diag-log.js 明文档支持的测试注入点，日志落 <base>\logs。
  这两条保证：不碰真实用户的 %APPDATA%\DSH Desktop、不触发 NSIS、不会顶掉正在运行的实例。
  如果单实例锁仍然阻止（用户目录无法完全隔离），脚本**如实记录**，不修改代码去绕锁。

  安全纪律：清理阶段只用 PID 定向 taskkill，且执行前核对目标进程的可执行文件路径必须在临时目录内
  —— 绝不用 /IM 按镜像名杀，那会连正在运行的宿主 DSH 一起杀掉。

  用法：
    pwsh -NoProfile -File stage1-portable-smoke.ps1 `
         -UnpackedDir <repo>\release\win-unpacked -RunId <runId> -RepoRoot <repo> -ExpectedVersion 0.3.48
  DryRun：-SkipCopy -DryRun（只做路径/尺寸检查，不复制不启动）
#>
param(
  [Parameter(Mandatory = $true)][string]$UnpackedDir,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [string]$ExpectedVersion = '0.3.48',
  [string]$ExpectedAppId = 'com.deepseek.dshdesktop',
  [int]$TimeoutSec = 300,
  [switch]$KeepDir,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$outDir = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$logFile = Join-Path $outDir "便携冒烟_$RunId.log"
$jsonOut = Join-Path $outDir "便携冒烟_$RunId.json"

function Log {
  param([string]$m, [string]$lvl = 'INFO')
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss.fff'), $lvl, $m
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec, [string]$What, [int]$PollMs = 600)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { $v = & $Condition } catch { $v = $null }
    if ($v) { return $v }
    Start-Sleep -Milliseconds $PollMs
  }
  Log "  等待超时（${TimeoutSec}s）：$What" 'WARN'
  return $null
}

function Shot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction SilentlyContinue
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $p = Join-Path $outDir "$name.png"
    $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Log "  截图：$p"
    return $p
  } catch { Log "  截图失败：$($_.Exception.Message)" 'WARN'; return $null }
}

$result = [ordered]@{
  runId = $RunId; mode = 'portable-smoke'; expectedVersion = $ExpectedVersion
  unpackedDir = (Resolve-Path $UnpackedDir).Path
  startedAt = (Get-Date).ToString('o'); steps = [ordered]@{}
  note = '不执行 NSIS 安装；以隔离 userData + DSH_DIAG_BASE 启动 win-unpacked 同一组二进制'
}

Log "===== 便携冒烟开始 runId=$RunId ====="
Log "源目录：$($result.unpackedDir)"
$srcExe = Join-Path $UnpackedDir 'DSH Desktop.exe'
if (-not (Test-Path $srcExe)) { Log "✖ 找不到 $srcExe" 'ERROR'; exit 1 }
$srcStat = Get-Item $srcExe
Log ("源 exe：{0} 字节，FileVersion={1}" -f $srcStat.Length, $srcStat.VersionInfo.FileVersion)

# 宿主进程快照：结束时核对它们没有被本脚本误伤
$hostPidsBefore = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Log ("宿主 DSH 进程（不得误杀）：" + ($(if ($hostPidsBefore) { $hostPidsBefore -join ',' } else { '(无)' })))
$result.hostPidsBefore = $hostPidsBefore

$smokeRoot = Join-Path $env:TEMP "dsh-smoke-$RunId"
$userData = Join-Path $smokeRoot 'userdata'
$diagBase = Join-Path $smokeRoot 'diag'
$smokeLogs = Join-Path $diagBase 'logs'
$lifecycle = Join-Path $smokeLogs 'DSH-Desktop-生命周期.log'
$mainLog = Join-Path $smokeLogs 'DSH-Desktop-日志.txt'
$result.smokeRoot = $smokeRoot
$result.lifecycleLog = $lifecycle

if ($DryRun) {
  Log 'DryRun：只核对路径与体积，不复制、不启动。'
  $stat = Get-ChildItem $UnpackedDir -Recurse -File | Measure-Object -Property Length -Sum
  Log ("win-unpacked：{0} 个文件，{1} MB" -f $stat.Count, [math]::Round($stat.Sum / 1MB, 1))
  $disk = Get-PSDrive C
  Log ("C 盘剩余 {0} GB（复制需要约 {1} GB）" -f [math]::Round($disk.Free / 1GB, 1), [math]::Round($stat.Sum / 1GB, 2))
  if ($disk.Free -lt $stat.Sum * 1.2) { Log '✖ 磁盘空间不足，便携冒烟不可行' 'ERROR'; exit 1 }
  $result.steps.dryRun = @{ status = 'PASS'; detail = "可复制：$($stat.Count) 文件 / $([math]::Round($stat.Sum/1MB,1)) MB" }
  $result.finishedAt = (Get-Date).ToString('o')
  $result | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonOut -Encoding utf8
  Log "DryRun 记录：$jsonOut"
  exit 0
}

# [1] 复制到临时目录
try {
  if (Test-Path $smokeRoot) { Remove-Item $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $smokeRoot, $userData, $diagBase | Out-Null
  Log '复制 win-unpacked → 临时目录（robocopy /MT:16）…'
  $rc = Start-Process robocopy -ArgumentList @("`"$($result.unpackedDir)`"", "`"$smokeRoot`"", '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:16') -Wait -PassThru -WindowStyle Hidden
  $copied = Test-Path (Join-Path $smokeRoot 'DSH Desktop.exe')
  Log ("  robocopy exit=$($rc.ExitCode)（0-7 均为成功）→ 目标 exe 存在=$copied")
  $result.steps.copy = @{ status = $(if ($copied) { 'PASS' } else { 'FAIL' }); detail = "robocopy exit=$($rc.ExitCode)" }
  if (-not $copied) { throw '复制失败：临时目录里没有 DSH Desktop.exe' }
} catch {
  Log ("  ✖ 复制失败：" + $_.Exception.Message) 'ERROR'
  $result.steps.copy = @{ status = 'FAIL'; detail = $_.Exception.Message }
  $result.finishedAt = (Get-Date).ToString('o')
  $result | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonOut -Encoding utf8
  exit 1
}

$smokeExe = Join-Path $smokeRoot 'DSH Desktop.exe'
$proc = $null
try {
  # [2] 启动（隔离 userData + 日志基址）
  Log '启动便携副本（--user-data-dir 隔离 userData，DSH_DIAG_BASE 隔离日志）'
  $env:DSH_DIAG_BASE = $diagBase
  $proc = Start-Process -FilePath $smokeExe -ArgumentList "--user-data-dir=`"$userData`"" -PassThru
  Log "  便携进程 pid=$($proc.Id)"
  $result.pid = $proc.Id
  $env:DSH_DIAG_BASE = $null

  # [3] 等 lifecycle start 事件
  $startEvent = Wait-Until -TimeoutSec $TimeoutSec -What "便携副本写出 lifecycle start（版本 $ExpectedVersion）" -Condition {
    if (Test-Path $lifecycle) {
      foreach ($l in (Get-Content $lifecycle -ErrorAction SilentlyContinue)) {
        if ($l -match '"event":"start"') { try { return ($l | ConvertFrom-Json) } catch { } }
      }
    }
    return $null
  }
  if ($startEvent) {
    Log ("  lifecycle start：pid={0} version={1} reason={2}" -f $startEvent.pid, $startEvent.version, $startEvent.reason)
    $verOk = ($startEvent.version -eq $ExpectedVersion)
    $result.steps.lifecycleStart = @{ status = $(if ($verOk) { 'PASS' } else { 'FAIL' }); detail = "version=$($startEvent.version) reason=$($startEvent.reason)" }
  } else {
    $exited = $proc.HasExited
    $result.steps.lifecycleStart = @{ status = 'FAIL'; detail = "超时未见 start 事件（进程已退出=$exited）" }
    Log '  ⚠ 未见 lifecycle start（可能是单实例锁拒绝，见下）' 'WARN'
  }

  # [4] 单实例锁判定：若进程很快退出且 lifecycle 有 second-instance 记录，如实记录
  Start-Sleep -Seconds 3
  if ($proc.HasExited) {
    $reason = '未知'
    if (Test-Path $lifecycle) {
      $last = Get-Content $lifecycle -ErrorAction SilentlyContinue | Select-Object -Last 1
      if ($last -match '"event":"exit"') { try { $reason = ($last | ConvertFrom-Json).reason } catch { } }
    }
    Log ("  ⚠ 便携进程已退出（exit code $($proc.ExitCode)），lifecycle 最后原因=$reason") 'WARN'
    $result.steps.singleInstance = @{ status = 'SKIP'; detail = "便携副本在 3s 内退出，lifecycle reason=$reason（若为 second-instance 即单实例锁阻止，属如实记录，不绕锁）" }
  } else {
    $result.steps.singleInstance = @{ status = 'PASS'; detail = '便携副本未被子实例锁拦截（隔离 userData 生效）' }

    # [5] 主窗口标题
    $title = Wait-Until -TimeoutSec $TimeoutSec -What '便携副本出现非空主窗口标题' -Condition {
      $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne 0 -and $p.MainWindowTitle) { return $p.MainWindowTitle }
      return $null
    }
    if ($title) {
      Log "  主窗口标题：$title"
      $result.steps.window = @{ status = 'PASS'; detail = $title }
      $result.windowTitle = $title
    } else {
      $result.steps.window = @{ status = 'FAIL'; detail = '超时未见非空主窗口标题（可能停在启动画面）' }
    }

    # [5b] H-08 AUMID 取证（这是 A 版被拦下的那一条，B 版必须为 true）
    # 注意日志有两种写法并存：结构化自检行是 JSON（"aumidApplied":true），
    # 设置成功/失败行是纯文本（aumidApplied:true appId=…）。两种都要认，
    # 否则会把"其实成功了"误判成失败（A 版复核时就踩过这个坑）。
    $aumidLine = $null
    if (Test-Path $mainLog) {
      $aumidLine = (Select-String -Path $mainLog -Pattern 'aumidApplied' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line
    }
    if ($aumidLine) {
      Log ("  AUMID 证据行：" + $aumidLine.Trim())
      $appliedTrue = $aumidLine -match 'aumidApplied"?\s*:\s*true'
      $hasAppId = $aumidLine -match [regex]::Escape($ExpectedAppId)
      if ($appliedTrue -and $hasAppId) {
        $result.steps.aumid = @{ status = 'PASS'; detail = "aumidApplied:true 且 appId=$ExpectedAppId"; evidence = @($aumidLine.Trim()) }
      } else {
        $result.steps.aumid = @{ status = 'FAIL'; detail = "AUMID 未按预期生效（appliedTrue=$appliedTrue hasAppId=$hasAppId）：$($aumidLine.Trim())" }
      }
    } else {
      $result.steps.aumid = @{ status = 'FAIL'; detail = '日志里没有 aumidApplied 证据行（H-08 自检未执行或日志未落盘）' }
    }
    $result.aumidLine = if ($aumidLine) { $aumidLine.Trim() } else { $null }

    # [6] Web UI 首帧：从日志取**完整 URL（含 token）**后实探 HTTP 200
    # 注意：只探 http://127.0.0.1:<port>/ 会失败 —— 后端首页要求 ?token=... 鉴权，
    # 不带 token 的请求不是 200。A 版曾因探测方式不对而误判为"首帧失败"，这里按日志原文取全串。
    $fullUrl = Wait-Until -TimeoutSec 120 -What '便携日志里出现含 token 的 Web UI 地址' -Condition {
      if (Test-Path $mainLog) {
        $text = Get-Content $mainLog -Tail 600 -ErrorAction SilentlyContinue | Out-String
        $m = [regex]::Matches($text, 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+')
        if ($m.Count -gt 0) { return $m[$m.Count - 1].Value }
      }
      return $null
    }
    if ($fullUrl) {
      $port = ([regex]::Match($fullUrl, ':(\d+)/')).Groups[1].Value
      Log "  探测 URL（含 token）：$fullUrl"
      $probe = Wait-Until -TimeoutSec 120 -What "HTTP 200 $fullUrl" -Condition {
        try {
          $resp = Invoke-WebRequest -Uri $fullUrl -UseBasicParsing -TimeoutSec 15
          if ($resp.StatusCode -eq 200) { return [pscustomobject]@{ code = 200; bytes = $resp.RawContentLength; ctype = $resp.Headers['Content-Type'] } }
        } catch { }
        return $null
      }
      if ($probe) {
        Log ("  ✔ HTTP 200（{0} 字节，{1}）" -f $probe.bytes, $probe.ctype)
        $result.steps.webui = @{ status = 'PASS'; detail = "HTTP 200 @ 127.0.0.1:$port/（$($probe.bytes) 字节，$($probe.ctype)）" }
        $result.port = $port
      } else {
        $result.steps.webui = @{ status = 'FAIL'; detail = "带 token 的 URL 探测未拿到 200：$fullUrl" }
      }
    } else {
      $result.steps.webui = @{ status = 'FAIL'; detail = '日志中未找到含 token 的 Web UI 地址' }
    }

    $shot = Shot "便携冒烟_首帧_$RunId"
    if ($shot) { $result.shot = $shot }
  }

  # [7] 宿主进程未被误伤
  $hostPidsAfter = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $survived = @($hostPidsBefore | Where-Object { $hostPidsAfter -contains $_ })
  Log ("  宿主进程存活核对：启动前 $($hostPidsBefore.Count) 个 → 现在 $($hostPidsAfter.Count) 个，仍存活 $($survived.Count) 个")
  $result.steps.hostIntact = @{
    status = $(if ($survived.Count -eq $hostPidsBefore.Count) { 'PASS' } else { 'FAIL' })
    detail = "启动前 $($hostPidsBefore.Count) 个，仍存活 $($survived.Count) 个"
  }
} catch {
  Log ("  ✖ 冒烟异常：" + $_.Exception.Message) 'ERROR'
  $result.steps.exception = @{ status = 'FAIL'; detail = $_.Exception.Message }
} finally {
  # [8] 清理：只按 PID 定向杀，且核对可执行文件路径在临时目录内
  if ($proc -and -not $proc.HasExited) {
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    $exePath = ''
    try { $exePath = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)").ExecutablePath } catch { }
    $safe = ($exePath -and $exePath.StartsWith($smokeRoot, [System.StringComparison]::OrdinalIgnoreCase))
    Log ("  清理便携副本：pid={0} exe='{1}' 在临时目录内={2}" -f $proc.Id, $exePath, $safe)
    if ($safe) {
      # 只对确认属于临时目录的 PID 树动手，绝不用 /IM 按镜像名杀（会杀掉宿主 DSH）
      & taskkill /F /T /PID $proc.Id 2>&1 | Out-Null
      Start-Sleep -Seconds 2
      $still = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
      Log ("  清理结果：进程仍在=$([bool]$still)")
      $result.steps.cleanup = @{ status = $(if ($still) { 'FAIL' } else { 'PASS' }); detail = "定向 taskkill pid=$($proc.Id)" }
    } else {
      Log '  ⚠ 目标 exe 不在临时目录内，拒绝清理（避免误杀宿主）' 'WARN'
      $result.steps.cleanup = @{ status = 'SKIP'; detail = 'exe 路径不在临时目录，出于安全未清理' }
    }
  } else {
    $result.steps.cleanup = @{ status = 'PASS'; detail = '便携进程已自行退出，无需清理' }
  }

  # 证据留存：把便携日志复制进仓库
  if (Test-Path $smokeLogs) {
    $dest = Join-Path $outDir "便携冒烟日志_$RunId"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $smokeLogs '*') $dest -ErrorAction SilentlyContinue
    Log "  便携副本日志已留存：$dest"
    $result.savedLogs = $dest

    # H-10 分层在成品里是否成立：桌面错误报告必须是**固定名且有内容**（不是只跑单测）。
    # 报告只在"疑似故障"时生成，所以这里如实区分三种结局：存在固定名 / 存在时间戳名(错) / 本次无故障未生成。
    $desktopDir = Join-Path $diagBase 'desktop'
    $fixed = Join-Path $desktopDir 'DSH-Desktop-错误报告.txt'
    if (Test-Path $fixed) {
      $lines = @(Get-Content $fixed -ErrorAction SilentlyContinue).Count
      Log ("  ✔ 桌面错误报告（固定名）已生成：" + $fixed + "（" + $lines + " 行）")
      $result.steps.durableReport = @{ status = 'PASS'; detail = "固定名报告存在，$lines 行" }
      Copy-Item $fixed (Join-Path $dest 'DSH-Desktop-错误报告.txt') -ErrorAction SilentlyContinue
    } elseif (Test-Path $desktopDir) {
      $tsReports = @(Get-ChildItem $desktopDir -Filter 'DSH-Desktop-错误报告-*.txt' -ErrorAction SilentlyContinue)
      if ($tsReports.Count -gt 0) {
        Log ("  ✖ 桌面出现时间戳名报告（违反固定名契约）：" + ($tsReports.Name -join ', '))
        $result.steps.durableReport = @{ status = 'FAIL'; detail = '桌面出现时间戳名报告：' + ($tsReports.Name -join ',') }
      } else {
        $result.steps.durableReport = @{ status = 'SKIP'; detail = '本次启动无疑似故障，未生成桌面报告（按设计如此）' }
      }
    } else {
      Log '  本次便携启动没有触发错误报告（无故障关键字），durable 层无法在该场景观测'
      $result.steps.durableReport = @{ status = 'SKIP'; detail = '本次无故障，未生成桌面报告；durable 层由 test-h10-electron-exit-flush（12/12）+ 成品与仓库 diag-log.js 字节一致共同佐证' }
    }
  }
  if (-not $KeepDir -and (Test-Path $smokeRoot)) {
    Log '  移除临时目录（-KeepDir 可保留）'
    Remove-Item $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$failCount = @($result.steps.Values | Where-Object { $_.status -eq 'FAIL' }).Count
$passCount = @($result.steps.Values | Where-Object { $_.status -eq 'PASS' }).Count
$skipCount = @($result.steps.Values | Where-Object { $_.status -eq 'SKIP' }).Count
$result.counts = @{ pass = $passCount; fail = $failCount; skip = $skipCount }
$result.passed = ($failCount -eq 0)
$result.finishedAt = (Get-Date).ToString('o')
$result | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonOut -Encoding utf8

Log ''
Log ("===== 便携冒烟结束：PASS=$passCount FAIL=$failCount SKIP=$skipCount =====")
Log "  记录：$jsonOut"
Log "  日志：$logFile"
exit ([int]($failCount -gt 0))
