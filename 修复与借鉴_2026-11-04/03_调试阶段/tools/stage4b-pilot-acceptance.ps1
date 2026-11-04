<#
  stage4b-pilot-acceptance.ps1 —— U-01 试装版安装链路验收（v2，修正 v1 的两处测量错误）

  v1 的两处**测量错误**（不是产品缺陷，必须在报告里写明）：
    ① 日志路径：生产外壳默认把日志写在"安装目录 logs"，卸载时随目录删除；v1 却去读
       %APPDATA%\...\logs（不存在）→ lifecycle start / Web UI 地址全部读不到，误判首启失败。
       实际 userData 里已经出现 backend/、dsh-home/、startup-recovery.json → 应用**确实启动过**。
       修正：用 diag-log.js 支持的 DSH_DIAG_BASE 注入，把日志写到验收目录（卸载后仍留存）。
    ② 进程识别：后端 node.exe 落在 userData\backend\，v1 只按安装目录过滤 → 误报"后端 0 个"。
       修正：按「安装目录 ∪ userData」双根过滤，且仍不按映像名模糊匹配（不误伤宿主）。

  其余流程与 v1 一致：安装 → 首启（CDP 首帧）→ 关到托盘 → 二次启动 → userData 标记 → 卸载 → 宿主存活。
#>
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [int]$CdpPort = 9450,
  [int]$InstallTimeoutSec = 600,
  [int]$BootTimeoutSec = 360
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class P4bWin {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public const uint WM_CLOSE = 0x0010;
}
"@ | Out-Null

$outDir = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段\试装版安装验收'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $outDir "试装版安装验收_v2_$stamp.log"
$jsonOut = Join-Path $outDir "试装版安装验收_v2_$stamp.json"
$probeJs = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段\tools\stage1-cdp-probe.js'
$diagBase = Join-Path $outDir "diag_$stamp"
New-Item -ItemType Directory -Force -Path $diagBase | Out-Null

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop Pilot'
$exePath = Join-Path $installDir 'DSH Desktop Pilot.exe'
$userData = Join-Path $env:APPDATA 'DSH Desktop Pilot'
$lifecycle = Join-Path $diagBase 'logs\DSH-Desktop-生命周期.log'
$mainLog = Join-Path $diagBase 'logs\DSH-Desktop-日志.txt'

$R = [ordered]@{ installer = $InstallerPath; startedAt = (Get-Date).ToString('o'); steps = [ordered]@{} }
function Log([string]$m, [string]$lvl = 'INFO') {
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss.fff'), $lvl, $m
  Write-Host $line; Add-Content -Path $logFile -Value $line -Encoding utf8
}
function Step([string]$k, [string]$st, [string]$detail) { $R.steps[$k] = @{ status = $st; detail = $detail }; Log ("  → {0}  {1}" -f $st, $detail) }
function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec, [string]$What, [int]$PollMs = 700)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) { try { $v = & $Condition } catch { $v = $null }; if ($v) { return $v }; Start-Sleep -Milliseconds $PollMs }
  Log "  等待超时（${TimeoutSec}s）：$What" 'WARN'; return $null
}
# 试装版进程 = 安装目录 ∪ userData（后端 node 在 userData\backend），绝不按映像名模糊匹配
function PilotProcs {
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and ($_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) -or
                              $_.ExecutablePath.StartsWith($userData, [System.StringComparison]::OrdinalIgnoreCase))
    })
}
function PilotBackends { @(PilotProcs | Where-Object { $_.Name -eq 'node.exe' }) }
function HostPids {
  @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and -not $_.Path.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -ExpandProperty Id)
}

Log '===== U-01 试装版安装链路验收（v2）====='
$fi = Get-Item $InstallerPath -ErrorAction SilentlyContinue
if (-not $fi) { Log "安装包不存在：$InstallerPath" 'ERROR'; exit 1 }
$hash = (Get-FileHash $InstallerPath -Algorithm SHA256).Hash
Log ("  安装包：{0}" -f $fi.FullName)
Log ("  字节数={0}  SHA-256={1}" -f $fi.Length, $hash)
$R.installerBytes = $fi.Length; $R.installerSha256 = $hash
Log ("  日志注入目录（卸载后仍留存）：$diagBase")

$hostBefore = HostPids
Log ("  S0 宿主 DSH 进程：" + ($(if ($hostBefore) { $hostBefore -join ',' } else { '(无)' })))
$R.hostPidsBefore = $hostBefore

# ── S1 安装 ───────────────────────────────────────────────────────────────────
Log ''
Log '── S1 静默安装（/S，perMachine=false 用户目录）────────────────────────'
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru
$exited = $p.WaitForExit($InstallTimeoutSec * 1000)
$sw.Stop()
if (-not $exited) { & taskkill /F /T /PID $p.Id 2>&1 | Out-Null; Step 'S1-install' 'FAIL' "安装器 ${InstallTimeoutSec}s 未退出" }
else {
  $uninst = Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'DSH Desktop Pilot*' } | Select-Object -First 1
  $sm = @(Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter '*DSH Desktop Pilot*' -ErrorAction SilentlyContinue)
  $dt = @(Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Filter '*DSH Desktop Pilot*' -ErrorAction SilentlyContinue)
  $ok = (Test-Path $exePath) -and [bool]$uninst -and $sm.Count -gt 0
  Step 'S1-install' $(if ($ok) { 'PASS' } else { 'FAIL' }) ("退出码=$($p.ExitCode) 耗时=$([math]::Round($sw.Elapsed.TotalSeconds,1))s；exe=$(Test-Path $exePath)；卸载项=$(if($uninst){$uninst.PSChildName + '/v' + $uninst.DisplayVersion}else{'无'})；开始菜单=$($sm.Count)；桌面=$($dt.Count)")
  $R.uninstallRegKey = if ($uninst) { $uninst.PSChildName } else { $null }
  $R.uninstallString = if ($uninst) { $uninst.UninstallString } else { $null }
  $R.shortcuts = @{ startMenu = @($sm | ForEach-Object { $_.FullName }); desktop = @($dt | ForEach-Object { $_.FullName }) }
}

# ── S2 首启 + 首帧 ────────────────────────────────────────────────────────────
Log ''
Log '── S2 首启：到 Web UI 首帧（日志经 DSH_DIAG_BASE 注入）────────────────'
$appProc = $null
$port = $CdpPort
for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }; $port++ }
$env:DSH_DIAG_BASE = $diagBase
$appProc = Start-Process -FilePath $exePath -ArgumentList @("--remote-debugging-port=$port") -PassThru
$env:DSH_DIAG_BASE = $null
Log "  已启动 pid=$($appProc.Id)，CDP=$port"

$startEvt = Wait-Until -TimeoutSec $BootTimeoutSec -What 'lifecycle start' -Condition {
  if (Test-Path $lifecycle) { foreach ($l in (Get-Content $lifecycle -ErrorAction SilentlyContinue)) { if ($l -match '"event":"start"') { try { return ($l | ConvertFrom-Json) } catch { } } } }
  return $null
}
if ($startEvt) { Log ("  lifecycle start: version={0} pid={1}" -f $startEvt.version, $startEvt.pid) }
$url = Wait-Until -TimeoutSec $BootTimeoutSec -What 'Web UI 地址' -Condition {
  if (Test-Path $mainLog) { $m = [regex]::Matches((Get-Content $mainLog -Tail 900 -ErrorAction SilentlyContinue | Out-String), 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+'); if ($m.Count -gt 0) { return $m[$m.Count - 1].Value } }
  return $null
}
$http = $null
if ($url) { $http = Wait-Until -TimeoutSec 120 -What 'HTTP 200' -Condition { try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15; if ($r.StatusCode -eq 200) { return $r } } catch { }; return $null } }
$aumidLine = if (Test-Path $mainLog) { (Select-String -Path $mainLog -Pattern 'aumidApplied' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line } else { $null }
$preloadErr = if (Test-Path $mainLog) { @(Select-String -Path $mainLog -Pattern 'PRELOAD ERROR|Unable to load preload|preload-error' -ErrorAction SilentlyContinue).Count } else { -1 }
$backends = @(PilotBackends)
$detail = "版本=$(if($startEvt){$startEvt.version}else{'未读到'})；首帧=$(if($http){"HTTP $($http.StatusCode) $($http.RawContentLength)B @$([regex]::Match($url,'127\.0\.0\.1:\d+').Value)"}else{'未拿到'})；AUMID=$(if($aumidLine -match 'aumidApplied"?\s*:\s*true'){'true'}else{'未确认'})；PRELOAD错误=$preloadErr；后端进程=$($backends.Count)"
Step 'S2-firstBoot' $(if ($http -and ($aumidLine -match 'aumidApplied"?\s*:\s*true') -and ($preloadErr -eq 0) -and $backends.Count -ge 1) { 'PASS' } else { 'FAIL' }) $detail
$R.pilotVersion = if ($startEvt) { $startEvt.version } else { $null }
$R.backendCount = $backends.Count

$shot = Join-Path $outDir "试装版_首帧_v2_$stamp.png"
$shotJson = Join-Path $outDir "试装版_首帧_v2_$stamp.json"
$shotRaw = & node $probeJs --port $port screenshot --out $shot --meta $shotJson 2>&1 | Out-String
if ($LASTEXITCODE -eq 0 -and (Test-Path $shot)) { Log "  截图（CDP target 级）：$shot"; Step 'S2-screenshot' 'PASS' 'magic/尺寸/锚点断言通过' }
else { Step 'S2-screenshot' 'FAIL' ("exit=$LASTEXITCODE：" + $shotRaw.Trim().Substring(0, [Math]::Min(200, $shotRaw.Trim().Length))) }

# ── S3 关到托盘 ──────────────────────────────────────────────────────────────
Log ''
Log '── S3 关到托盘 ─────────────────────────────────────────────────────────'
$winProc = @(PilotProcs | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1)
if ($winProc) {
  Log ("  目标窗口 pid=$($winProc.Id) title='$($winProc.MainWindowTitle)'")
  $posted = [P4bWin]::PostMessage([IntPtr]$winProc.MainWindowHandle, [P4bWin]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
  Log "  PostMessage(WM_CLOSE) 返回=$posted"
  Start-Sleep -Seconds 7
} else { Log '  未找到可见主窗口' 'WARN' }
$alive = $appProc -and (@(Get-Process -Id $appProc.Id -ErrorAction SilentlyContinue).Count -gt 0)
$vis = @(PilotProcs | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ -and $_.MainWindowHandle -ne 0 })
$closeLog = if (Test-Path $mainLog) { (Select-String -Path $mainLog -Pattern '托盘|背景运行|background|关闭' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line } else { $null }
Step 'S3-closeToTray' $(if ($alive -and $vis.Count -eq 0) { 'PASS' } else { 'FAIL' }) "进程存活=$alive；可见主窗口=$($vis.Count)（窗口句柄=$(if($winProc){'有'}else{'无'})）"

# ── S5 二次启动 ──────────────────────────────────────────────────────────────
Log ''
Log '── S5 二次启动 / 单实例 ────────────────────────────────────────────────'
$procsBefore = @(PilotProcs).Count
$bkBefore = @(PilotBackends).Count
$lcBefore = if (Test-Path $lifecycle) { @(Get-Content $lifecycle).Count } else { 0 }
$p2 = Start-Process -FilePath $exePath -PassThru
$p2Exited = $p2.WaitForExit(45000)
Start-Sleep -Seconds 2
$p2Still = @(Get-Process -Id $p2.Id -ErrorAction SilentlyContinue).Count -gt 0
$procsAfter = @(PilotProcs).Count
$bkAfter = @(PilotBackends).Count
$secondLine = if (Test-Path $lifecycle) { (Get-Content $lifecycle | Select-Object -Skip $lcBefore | Where-Object { $_ -match 'second-instance' } | Select-Object -Last 1) } else { $null }
if ($secondLine) { Log ("  lifecycle：" + $secondLine.Trim()) }
Step 'S5-secondInstance' $(if ((-not $p2Still) -and $bkAfter -le $bkBefore) { 'PASS' } else { 'FAIL' }) "第二实例退出=$p2Exited/仍在=$p2Still；进程 $procsBefore→$procsAfter；后端 $bkBefore→$bkAfter"
$R.secondInstanceLifecycle = if ($secondLine) { $secondLine.Trim() } else { $null }

# ── S6 userData 标记 ─────────────────────────────────────────────────────────
Log ''
Log '── S6 造 userData 标记（卸载后必须仍在）────────────────────────────────'
New-Item -ItemType Directory -Force -Path $userData | Out-Null
$marker = Join-Path $userData "pilot-marker-v2-$stamp.txt"
"U-01 试装版 v2 标记：卸载后必须仍然存在。$stamp" | Set-Content -Path $marker -Encoding utf8
Log ("  标记：" + $marker)
Step 'S6-markUserData' 'PASS' "已写入 $marker"
$R.markerPath = $marker

# ── S7 关闭 ──────────────────────────────────────────────────────────────────
Log ''
Log '── S7 关闭试装版（路径限定）───────────────────────────────────────────'
$pl = @(PilotProcs)
Log ("  命中 " + $pl.Count + " 个：" + (($pl | ForEach-Object { "$($_.Name)($($_.ProcessId))" }) -join ', '))
foreach ($x in $pl) {
  if ($x.ExecutablePath -and ($x.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) -or $x.ExecutablePath.StartsWith($userData, [System.StringComparison]::OrdinalIgnoreCase))) {
    & taskkill /F /T /PID $x.ProcessId 2>&1 | Out-Null
  }
}
Start-Sleep -Seconds 3
Step 'S7-stopPilot' $(if (@(PilotProcs).Count -eq 0) { 'PASS' } else { 'WARN' }) ("残留 " + @(PilotProcs).Count + " 个")

# ── S8 卸载 ──────────────────────────────────────────────────────────────────
Log ''
Log '── S8 卸载试装版 ───────────────────────────────────────────────────────'
$uninstExe = $null
if ($R.uninstallString) { $uninstExe = ($R.uninstallString -replace '^"([^"]+)".*$', '$1'); if (-not $uninstExe.EndsWith('.exe')) { $uninstExe = ($R.uninstallString -split '"')[1] } }
if (-not $uninstExe -or -not (Test-Path $uninstExe)) { $cand = Join-Path $installDir 'Uninstall DSH Desktop Pilot.exe'; if (Test-Path $cand) { $uninstExe = $cand } }
if (-not $uninstExe -or -not (Test-Path $uninstExe)) { Step 'S8-uninstall' 'FAIL' "找不到卸载程序（uninstallString='$($R.uninstallString)'）" }
else {
  Log "  卸载程序：$uninstExe"
  $up = Start-Process -FilePath $uninstExe -ArgumentList '/S' -PassThru
  if (-not $up.WaitForExit($InstallTimeoutSec * 1000)) { & taskkill /F /T /PID $up.Id 2>&1 | Out-Null; Log '  卸载器超时' 'WARN' } else { Log "  卸载器退出码=$($up.ExitCode)" }
  Start-Sleep -Seconds 4
  $dirGone = -not (Test-Path $exePath)
  $regGone = -not (Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DSH Desktop Pilot*' })
  $smGone = -not (Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter '*DSH Desktop Pilot*' -ErrorAction SilentlyContinue)
  $markerKept = Test-Path $marker
  Step 'S8-uninstall' $(if ($dirGone -and $regGone -and $smGone -and $markerKept) { 'PASS' } else { 'FAIL' }) "exe删除=$dirGone（目录残留=$(Test-Path $installDir)）；注册表清除=$regGone；开始菜单清除=$smGone；userData 标记保留=$markerKept"
}

# ── S9 宿主存活 ──────────────────────────────────────────────────────────────
Log ''
Log '── S9 宿主存活断言 ────────────────────────────────────────────────────'
$hostAfter = HostPids
$survived = @($hostBefore | Where-Object { $hostAfter -contains $_ })
Log ("  前：$($hostBefore -join ',')")
Log ("  后：$($hostAfter -join ',')")
Step 'S9-hostIntact' $(if ($survived.Count -eq $hostBefore.Count -and $hostBefore.Count -gt 0) { 'PASS' } else { 'FAIL' }) "存活 $($survived.Count)/$($hostBefore.Count)"
$R.hostPidsAfter = $hostAfter

$R.logs = @{ lifecycle = $lifecycle; mainLog = $mainLog; diagBase = $diagBase }
$R.finishedAt = (Get-Date).ToString('o')
$R | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonOut -Encoding utf8
$fails = @($R.steps.Values | Where-Object { $_.status -eq 'FAIL' }).Count
$pass = @($R.steps.Values | Where-Object { $_.status -eq 'PASS' }).Count
$manual = @($R.steps.Values | Where-Object { $_.status -like 'NOT_*' }).Count
Log ''
Log ("===== 结束：PASS=$pass FAIL=$fails NEED_MANUAL=$manual =====")
Log ("  记录：" + $jsonOut)
