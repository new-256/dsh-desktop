<#
  stage4-pilot-acceptance.ps1 —— U-01「试装版（Pilot）安装链路」真实验收。

  为什么这么绕：生产安装器的 DshTerminateAll 会 taskkill /F /T /IM "DSH Desktop.exe"，
  而被验收的这台机器上，被测外壳正是承载 agent 会话的宿主 —— 跑生产包会杀掉验收会话本身。
  Windows 沙箱 Disabled、Hyper-V 无镜像，隔离 VM 也走不通。于是另造身份不同的试装版
  （不同 productName/appId/安装目录/userData，且进程清扫段 no-op），把 NSIS 的
  安装 / 首启 / 关到托盘 / 二次启动 / 数据保留 / 卸载 全链路真跑一遍。

  每一步都断言并打印实际值；失败不掩盖。宿主存活断言在流程首尾各做一次。
#>
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [int]$CdpPort = 9440,
  [int]$InstallTimeoutSec = 600,
  [int]$FirstFrameTimeoutSec = 420
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class P4Win {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public const uint WM_CLOSE = 0x0010;
}
"@ | Out-Null

$outDir = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段\试装版安装验收'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $outDir "试装版安装验收_$stamp.log"
$jsonOut = Join-Path $outDir "试装版安装验收_$stamp.json"
$probeJs = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段\tools\stage1-cdp-probe.js'

$RESULT = [ordered]@{ installer = $InstallerPath; startedAt = (Get-Date).ToString('o'); steps = [ordered]@{} }
function Log([string]$m, [string]$lvl = 'INFO') {
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss.fff'), $lvl, $m
  Write-Host $line; Add-Content -Path $logFile -Value $line -Encoding utf8
}
function Step([string]$k, [string]$st, [string]$detail) {
  $RESULT.steps[$k] = @{ status = $st; detail = $detail }
  Log ("  → {0}  {1}" -f $st, $detail)
}
function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec, [string]$What, [int]$PollMs = 800)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) { try { $v = & $Condition } catch { $v = $null }; if ($v) { return $v }; Start-Sleep -Milliseconds $PollMs }
  Log "  等待超时（${TimeoutSec}s）：$What" 'WARN'; return $null
}
function PilotProcs {
  # 只认**试装版安装目录**下的进程，绝不按映像名模糊匹配（那样会误伤宿主）
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$installDir*" })
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop Pilot'
$exePath = Join-Path $installDir 'DSH Desktop Pilot.exe'
$userData = Join-Path $env:APPDATA 'DSH Desktop Pilot'

Log '===== U-01 试装版安装链路验收 ====='
Log "  安装包：$InstallerPath"
if (-not (Test-Path $InstallerPath)) { Log '安装包不存在' 'ERROR'; exit 1 }
$fi = Get-Item $InstallerPath
$hash = (Get-FileHash $InstallerPath -Algorithm SHA256).Hash
Log ("  字节数：{0}  SHA-256：{1}" -f $fi.Length, $hash)
$RESULT.installerBytes = $fi.Length; $RESULT.installerSha256 = $hash

# ── S0 宿主基线（贯穿全文的唯一前提）─────────────────────────────────────────
$hostBefore = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path -notlike "$installDir*" } | Select-Object -ExpandProperty Id)
Log ("  S0 宿主 DSH 进程（必须全程存活）：" + ($(if ($hostBefore) { $hostBefore -join ',' } else { '(无)' })))
$RESULT.hostPidsBefore = $hostBefore
Step 'S0-hostBaseline' $(if ($hostBefore.Count -gt 0) { 'INFO' } else { 'INFO' }) "宿主进程 $($hostBefore.Count) 个：$($hostBefore -join ',')"

# ── S1 静默安装 ───────────────────────────────────────────────────────────────
Log ''
Log '── S1 静默安装（NSIS /S，perMachine=false 用户目录，无 UAC）──────────────'
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru
Log "  安装器 pid=$($p.Id)，最长等 $InstallTimeoutSec s"
if (-not $p.WaitForExit($InstallTimeoutSec * 1000)) {
  & taskkill /F /T /PID $p.Id 2>&1 | Out-Null
  Step 'S1-install' 'FAIL' "安装器 ${InstallTimeoutSec}s 未退出（已强杀），卡点未定位"
} else {
  $sw.Stop()
  Log ("  安装器退出码={0}，耗时 {1:N1}s" -f $p.ExitCode, $sw.Elapsed.TotalSeconds)
  $dirOk = Wait-Until -TimeoutSec 60 -What '安装目录出现' -Condition { if (Test-Path $exePath) { return $true } return $null }
  $uninstKey = $null
  $uninstPath = $null
  foreach ($k in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $hit = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DSH Desktop Pilot*' } | Select-Object -First 1
    if ($hit) { $uninstKey = $hit; break }
  }
  if ($uninstKey) { $uninstPath = $uninstKey.PSChildName }
  $startMenu = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  ) | ForEach-Object { Get-ChildItem $_ -Recurse -Filter '*DSH Desktop Pilot*' -ErrorAction SilentlyContinue }
  $desktopLnk = Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Filter '*DSH Desktop Pilot*' -ErrorAction SilentlyContinue
  $detail = "退出码=$($p.ExitCode) 耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s；exe存在=$(Test-Path $exePath)；卸载项=$(if($uninstPath){$uninstPath + ' / v' + $uninstKey.DisplayVersion}else{'无'})；开始菜单=$($startMenu.Count)；桌面=$($desktopLnk.Count)"
  $ok = (Test-Path $exePath) -and $uninstPath -and $startMenu.Count -gt 0
  Step 'S1-install' $(if ($ok) { 'PASS' } else { 'FAIL' }) $detail
  $RESULT.uninstallRegKey = $uninstPath
  $RESULT.uninstallString = if ($uninstKey) { $uninstKey.UninstallString } else { $null }
  $RESULT.shortcuts = @{ startMenu = @($startMenu | ForEach-Object { $_.FullName }); desktop = @($desktopLnk | ForEach-Object { $_.FullName }) }
  $RESULT.installDirExists = Test-Path $installDir
}

# ── S2 首启（Web UI 首帧 + CDP target 级截图）─────────────────────────────────
Log ''
Log '── S2 首启：到 Web UI 首帧 ────────────────────────────────────────────'
$appProc = $null
if (-not (Test-Path $exePath)) {
  Step 'S2-firstBoot' 'FAIL' 'exe 不存在，跳过'
} else {
  $port = $CdpPort
  for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }; $port++ }
  $appProc = Start-Process -FilePath $exePath -ArgumentList @("--remote-debugging-port=$port") -PassThru
  Log "  试装版已启动 pid=$($appProc.Id)，CDP=$port，userData=$userData"
  $lifecycle = Join-Path $userData 'logs\DSH-Desktop-生命周期.log'
  $mainLog = Join-Path $userData 'logs\DSH-Desktop-日志.txt'
  $startEvt = Wait-Until -TimeoutSec $FirstFrameTimeoutSec -What 'lifecycle start' -Condition {
    if (Test-Path $lifecycle) { foreach ($l in (Get-Content $lifecycle -ErrorAction SilentlyContinue)) { if ($l -match '"event":"start"') { try { return ($l | ConvertFrom-Json) } catch { } } } }
    return $null
  }
  $url = Wait-Until -TimeoutSec $FirstFrameTimeoutSec -What 'Web UI 地址' -Condition {
    if (Test-Path $mainLog) { $m = [regex]::Matches((Get-Content $mainLog -Tail 800 -ErrorAction SilentlyContinue | Out-String), 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+'); if ($m.Count -gt 0) { return $m[$m.Count - 1].Value } }
    return $null
  }
  $http = if ($url) { Wait-Until -TimeoutSec 90 -What 'HTTP 200' -Condition { try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15; if ($r.StatusCode -eq 200) { return $r } } catch { }; return $null } } else { $null }
  $aumidLine = if (Test-Path $mainLog) { (Select-String -Path $mainLog -Pattern 'aumidApplied' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line } else { $null }
  $preloadErr = if (Test-Path $mainLog) { @(Select-String -Path $mainLog -Pattern 'PRELOAD ERROR|Unable to load preload' -ErrorAction SilentlyContinue).Count } else { -1 }
  $portListen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $appProc.Id -or $_.LocalPort -eq $(if ($url) { [int]([regex]::Match($url, ':(\d+)/').Groups[1].Value) } else { -1 }) })
  $detail = "lifecycle版本=$(if($startEvt){$startEvt.version}else{'无'})；首帧=$(if($http){"HTTP $($http.StatusCode) $($http.RawContentLength)B @$([regex]::Match($url,'127\.0\.0\.1:\d+').Value)"}else{'未拿到'})；AUMID=$(if($aumidLine -match 'aumidApplied"?\s*:\s*true'){'true'}else{'未确认'})；PRELOAD错误=$preloadErr；端口监听=$($portListen.Count)"
  Step 'S2-firstBoot' $(if ($http -and ($aumidLine -match 'aumidApplied"?\s*:\s*true') -and $preloadErr -eq 0) { 'PASS' } else { 'FAIL' }) $detail
  $RESULT.pilotVersion = if ($startEvt) { $startEvt.version } else { $null }
  $RESULT.pilotUserData = $userData

  # 截图（target 级 + 元数据，过 visual-gate）
  $shot = Join-Path $outDir '试装版_首帧.png'
  $shotJson = Join-Path $outDir '试装版_首帧.json'
  $shotRaw = & node $probeJs --port $port screenshot --out $shot --meta $shotJson 2>&1 | Out-String
  $shotExit = $LASTEXITCODE
  if ($shotExit -eq 0 -and (Test-Path $shot)) {
    Log "  截图已落盘（CDP target 级）：$shot"
    Step 'S2-screenshot' 'PASS' "CDP Page.captureScreenshot + 元数据断言通过"
  } else {
    Step 'S2-screenshot' 'FAIL' "CDP 截图断言失败 exit=$shotExit：$($shotRaw.Trim().Substring(0,[Math]::Min(200,$shotRaw.Trim().Length)))"
  }

  # ── S3 关到托盘 ─────────────────────────────────────────────────────────────
  Log ''
  Log '── S3 关到托盘（关窗 ≠ 退出）──────────────────────────────────────────'
  $target = Get-Process -Id $appProc.Id -ErrorAction SilentlyContinue
  if ($target -and $target.MainWindowHandle -ne 0) {
    $posted = [P4Win]::PostMessage([IntPtr]$target.MainWindowHandle, [P4Win]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    Log "  PostMessage(WM_CLOSE) 返回=$posted（标题='$($target.MainWindowTitle)'）"
    Start-Sleep -Seconds 7
  } else { Log '  未取到主窗口句柄（可能还在启动中）' 'WARN' }
  $alive = @(Get-Process -Id $appProc.Id -ErrorAction SilentlyContinue).Count -gt 0
  $vis = @(PilotProcs | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ -and $_.MainWindowHandle -ne 0 })
  Step 'S3-closeToTray' $(if ($alive -and $vis.Count -eq 0) { 'PASS' } else { 'FAIL' }) "进程存活=$alive；可见主窗口=$($vis.Count)"

  # ── S4 托盘退出 ─────────────────────────────────────────────────────────────
  Log ''
  Log '── S4 托盘退出 ────────────────────────────────────────────────────────'
  Log '  Win11 托盘溢出区为 no-activate 浮层，UIA 无 pattern 可激活（同 U-08 结论），无法自动点击「退出」'
  Step 'S4-trayQuit' 'NOT_VERIFIED_MANUAL' '需人工一步：右键托盘图标 →「退出」；日志锚点 生命周期.log 出现 "reason":"tray-quit"'

  # ── S5 二次启动（单实例）────────────────────────────────────────────────────
  Log ''
  Log '── S5 二次启动 / 单实例 ───────────────────────────────────────────────'
  $procsBefore = @(PilotProcs).Count
  $backendBefore = @(PilotProcs | Where-Object { $_.Name -eq 'node.exe' }).Count
  $lcBefore = if (Test-Path $lifecycle) { @(Get-Content $lifecycle).Count } else { 0 }
  $p2 = Start-Process -FilePath $exePath -PassThru
  $exited = $p2.WaitForExit(45000)
  Start-Sleep -Seconds 2
  $still = @(Get-Process -Id $p2.Id -ErrorAction SilentlyContinue).Count -gt 0
  $procsAfter = @(PilotProcs).Count
  $backendAfter = @(PilotProcs | Where-Object { $_.Name -eq 'node.exe' }).Count
  $lcAfter = if (Test-Path $lifecycle) { @(Get-Content $lifecycle).Count } else { 0 }
  $secondLine = $null
  if (Test-Path $lifecycle) { $secondLine = (Get-Content $lifecycle | Select-Object -Skip $lcBefore | Where-Object { $_ -match 'second-instance' } | Select-Object -Last 1) }
  if ($secondLine) { Log ("  lifecycle：" + $secondLine.Trim()) }
  Step 'S5-secondInstance' $(if ((-not $still) -and $backendAfter -le $backendBefore) { 'PASS' } else { 'FAIL' }) "第二实例退出=$exited/仍在=$still；进程 $procsBefore→$procsAfter；后端 $backendBefore→$backendAfter；lifecycle 新增=$($lcAfter - $lcBefore)"
  $RESULT.secondInstanceLifecycle = if ($secondLine) { $secondLine.Trim() } else { $null }

  # ── S6 数据保留标记（在卸载前造，卸载后必须还在）─────────────────────────────
  Log ''
  Log '── S6 造 userData 标记（模拟用户会话数据）─────────────────────────────'
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
  $marker = Join-Path $userData "pilot-marker-$stamp.txt"
  "这是 U-01 试装版验收造的标记文件，卸载后必须仍然存在。$stamp" | Set-Content -Path $marker -Encoding utf8
  Log ("  已写入标记：" + $marker + "（" + (Get-Item $marker).Length + " 字节）")
  Step 'S6-markUserData' 'PASS' "标记已写入 $marker"
  $RESULT.markerPath = $marker
}

# ── S7 关闭试装版进程（卸载前必须退出）──────────────────────────────────────
Log ''
Log '── S7 关闭试装版（路径限定的 taskkill，绝不按映像名）────────────────────'
$pilot = @(PilotProcs)
Log ("  命中试装版进程 " + $pilot.Count + " 个：" + (($pilot | ForEach-Object { "$($_.Name)($($_.ProcessId))" }) -join ', '))
foreach ($pp in $pilot) {
  if ($pp.ExecutablePath -and $pp.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    & taskkill /F /T /PID $pp.ProcessId 2>&1 | Out-Null
  }
}
Start-Sleep -Seconds 3
$left = @(PilotProcs).Count
Step 'S7-stopPilot' $(if ($left -eq 0) { 'PASS' } else { 'WARN' }) "残留试装版进程 $left 个"

# ── S8 卸载 ───────────────────────────────────────────────────────────────────
Log ''
Log '── S8 卸载试装版 ──────────────────────────────────────────────────────'
$uninstExe = $null
if ($RESULT.uninstallString) {
  $uninstExe = ($RESULT.uninstallString -replace '^"([^"]+)".*$', '$1') -replace '^([^"]+?\.exe).*$', '$1'
} else {
  $candidate = Join-Path $installDir 'Uninstall DSH Desktop Pilot.exe'
  if (Test-Path $candidate) { $uninstExe = $candidate }
}
if (-not $uninstExe -or -not (Test-Path $uninstExe)) {
  Step 'S8-uninstall' 'FAIL' "找不到卸载程序（uninstallString='$($RESULT.uninstallString)'）"
} else {
  Log "  卸载程序：$uninstExe"
  $up = Start-Process -FilePath $uninstExe -ArgumentList '/S' -PassThru
  if (-not $up.WaitForExit($InstallTimeoutSec * 1000)) { & taskkill /F /T /PID $up.Id 2>&1 | Out-Null; Log '  卸载器超时，已强杀' 'WARN' }
  else { Log "  卸载器退出码=$($up.ExitCode)" }
  Start-Sleep -Seconds 4
  $dirGone = -not (Test-Path $exePath)
  $regGone = -not (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DSH Desktop Pilot*' })
  $smGone = -not (Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter '*DSH Desktop Pilot*' -ErrorAction SilentlyContinue)
  $markerKept = Test-Path $RESULT.markerPath
  $detail = "exe已删除=$dirGone（目录残留=$(Test-Path $installDir)）；注册表卸载项已清除=$regGone；开始菜单项已清除=$smGone；userData 标记仍在=$markerKept（$($RESULT.markerPath)）"
  Step 'S8-uninstall' $(if ($dirGone -and $regGone -and $smGone -and $markerKept) { 'PASS' } else { 'FAIL' }) $detail
}

# ── S9 宿主存活（唯一能证明"真的绕开了清扫"的证据）──────────────────────────
Log ''
Log '── S9 宿主存活断言 ────────────────────────────────────────────────────'
$hostAfter = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path -notlike "$installDir*" } | Select-Object -ExpandProperty Id)
$survived = @($hostBefore | Where-Object { $hostAfter -contains $_ })
Log ("  安装前宿主：$($hostBefore -join ',')")
Log ("  安装后宿主：$($hostAfter -join ',')")
Step 'S9-hostIntact' $(if ($survived.Count -eq $hostBefore.Count -and $hostBefore.Count -gt 0) { 'PASS' } else { 'FAIL' }) "存活 $($survived.Count)/$($hostBefore.Count)：$($survived -join ',')"
$RESULT.hostPidsAfter = $hostAfter
$RESULT.hostSurvived = $survived

$RESULT.finishedAt = (Get-Date).ToString('o')
$RESULT | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonOut -Encoding utf8
Log ''
$fails = @($RESULT.steps.Values | Where-Object { $_.status -eq 'FAIL' }).Count
$pass = @($RESULT.steps.Values | Where-Object { $_.status -eq 'PASS' }).Count
$manual = @($RESULT.steps.Values | Where-Object { $_.status -like 'NOT_*' }).Count
Log ("===== 结束：PASS=$pass FAIL=$fails NEED_MANUAL=$manual =====")
Log ("  记录：" + $jsonOut)
