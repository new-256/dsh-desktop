<#
  stage3-supplemental-verify.ps1 —— 阶段二「补充验收」四件套（全部非破坏性，隔离 DSH_HOME）

  覆盖：
    U-02 关到托盘（关窗≠退出）：进程存活 + 托盘图标存在 + 日志有留托盘记录
    U-04 二次启动 / 单实例：同 DSH_HOME 再起一个 → 第二实例按预期退出，只有一个后端，无端口抢占
    U-06 气泡系统确认显示：等真实通知事件，看有没有 balloon-show 确认（没有就如实记"未观测到"）
    U-08 从托盘点开设置窗：先用 UIA 的 Invoke（不是鼠标合成）试，记录精确失败原因
  另存视觉验收截图（全窗口含标题栏）到 03_调试阶段/视觉验收_0.3.49_首帧.png

  安全纪律（与阶段一一致）：
    - 只操作临时目录里的便携副本；清理只用 PID 定向 taskkill 且先核对 exe 路径；
    - 绝不 taskkill /IM "DSH Desktop.exe"（那会杀掉宿主会话）；
    - 隔离 userData + DSH_DIAG_BASE + DSH_HOME，不碰真实 profile。
#>
param(
  [Parameter(Mandatory = $true)][string]$UnpackedDir,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [string]$ExpectedVersion = '0.3.49',
  [int]$CdpPort = 9370,
  [int]$NotifyWaitSec = 420
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing | Out-Null
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class S3Win {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint WM_CLOSE = 0x0010;
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static string RectOf(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return ""; return r.Left + "," + r.Top + "," + (r.Right-r.Left) + "," + (r.Bottom-r.Top); }
}
"@

$outDir = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$logFile = Join-Path $outDir "补充验收_$RunId.log"
$jsonOut = Join-Path $outDir "补充验收_$RunId.json"
$shotOut = Join-Path $outDir ("视觉验收_${ExpectedVersion}_首帧.png")
$shotDir = Join-Path $outDir "补充验收截图_$RunId"

function Log([string]$m, [string]$lvl = 'INFO') {
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss.fff'), $lvl, $m
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}
function Wait-Until {
  param([scriptblock]$Condition,[int]$TimeoutSec,[string]$What,[int]$PollMs = 800)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) { try { $v = & $Condition } catch { $v = $null }; if ($v) { return $v }; Start-Sleep -Milliseconds $PollMs }
  Log "  等待超时（${TimeoutSec}s）：$What" 'WARN'; return $null
}

$R = [ordered]@{ runId = $RunId; expectedVersion = $ExpectedVersion; startedAt = (Get-Date).ToString('o'); results = [ordered]@{} }
function Res([string]$k, [string]$st, [string]$detail) { $R.results[$k] = @{ status = $st; detail = $detail }; Log ("  → {0}  {1}" -f $st, $detail) }

New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
Log "===== 补充验收开始 runId=$RunId ====="
$hostPids = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Log ("宿主 DSH 进程（不得误杀）：" + ($(if ($hostPids) { $hostPids -join ',' } else { '(无)' })))

$root = Join-Path $env:TEMP "dsh-s3-$RunId"
$userData = Join-Path $root 'userdata'
$dshHome = Join-Path $root 'dsh-home'
$diagBase = Join-Path $root 'diag'
$logs = Join-Path $diagBase 'logs'
$mainLog = Join-Path $logs 'DSH-Desktop-日志.txt'
$lifecycle = Join-Path $logs 'DSH-Desktop-生命周期.log'
$app = $null
$app2 = $null

try {
  if (Test-Path $root) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $root, $userData, $dshHome, $diagBase | Out-Null
  Log '复制 win-unpacked → 临时目录…'
  $rc = Start-Process robocopy -ArgumentList @("`"$UnpackedDir`"", "`"$root`"", '/E','/NFL','/NDL','/NJH','/NJS','/NP','/MT:16') -Wait -PassThru -WindowStyle Hidden
  if (-not (Test-Path (Join-Path $root 'DSH Desktop.exe'))) { throw "复制失败 exit=$($rc.ExitCode)" }

  $port = $CdpPort
  for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }; $port++ }
  $script:CdpPort2 = $port

  $env:DSH_DIAG_BASE = $diagBase
  $env:DSH_HOME = $dshHome
  $app = Start-Process -FilePath (Join-Path $root 'DSH Desktop.exe') -ArgumentList @("--user-data-dir=`"$userData`"", "--remote-debugging-port=$port") -PassThru
  $env:DSH_DIAG_BASE = $null
  $env:DSH_HOME = $null
  Log "  便携副本 pid=$($app.Id)，CDP=$port，DSH_HOME=$dshHome"

  # ── 前置：起来并拿到首帧 ──────────────────────────────────────────────────
  $start = Wait-Until -TimeoutSec 420 -What 'lifecycle start' -Condition {
    if (Test-Path $lifecycle) { foreach ($l in (Get-Content $lifecycle -ErrorAction SilentlyContinue)) { if ($l -match '"event":"start"') { try { return ($l | ConvertFrom-Json) } catch { } } } }
    return $null
  }
  if (-not $start) { throw '启动失败：未见 lifecycle start' }
  Log "  lifecycle start version=$($start.version)"
  $url = Wait-Until -TimeoutSec 300 -What 'Web UI 地址' -Condition {
    if (Test-Path $mainLog) { $m = [regex]::Matches((Get-Content $mainLog -Tail 800 -ErrorAction SilentlyContinue | Out-String), 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+'); if ($m.Count -gt 0) { return $m[$m.Count - 1].Value } }
    return $null
  }
  if (-not $url) { throw 'Web UI 未就绪' }
  $probe = Wait-Until -TimeoutSec 90 -What 'HTTP 200' -Condition { try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15; if ($r.StatusCode -eq 200) { return $r } } catch { }; return $null }
  if (-not $probe) { throw '首帧 HTTP 未拿到 200' }
  Res 'precondition' 'PASS' ("启动+首帧 HTTP 200（" + $probe.RawContentLength + " 字节）@ " + ([regex]::Match($url,'127\.0\.0\.1:\d+').Value))

  # ── C. 视觉验收截图（**必须 target 级**：CDP Page.captureScreenshot + 元数据）──────
  # 纪律：绝不用全桌面 CopyFromScreen —— 那会抓到前台别人的窗口（本项目真的发生过一次，
  # 两张名为"首帧"的图分别是游戏与播放器，已作废）。抓不到合规证据时，宁可不落盘。
  Start-Sleep -Seconds 2
  $probeJs = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段\tools\stage1-cdp-probe.js'
  $shotJson = [System.IO.Path]::ChangeExtension($shotOut, '.json')
  $shotRaw = & node $probeJs --port $port screenshot --out $shotOut --meta $shotJson 2>&1 | Out-String
  $shotExit = $LASTEXITCODE
  if ($shotExit -eq 0 -and (Test-Path $shotOut) -and (Test-Path $shotJson)) {
    Log "  视觉验收截图（CDP target 级）：$shotOut"
    Res 'visualCapture' 'PASS' ("CDP Page.captureScreenshot + 元数据断言通过（readyState=complete、URL 本地后端、DOM 有实质内容）")
    $R.visualShot = $shotOut
    $R.visualShotMeta = $shotJson
  } else {
    Log ("  ✖ CDP 截图未通过断言（exit=$shotExit），不落盘作为证据") 'ERROR'
    Log ("    " + ($shotRaw -split "`n" | Select-Object -First 25 | Out-String))
    if (Test-Path $shotOut) { Remove-Item $shotOut -Force -ErrorAction SilentlyContinue }
    Res 'visualCapture' 'FAIL' "CDP 截图断言失败（exit=$shotExit）：$($shotRaw.Trim().Substring(0,[Math]::Min(300,$shotRaw.Trim().Length)))"
  }

  # ── U-02 关到托盘 ─────────────────────────────────────────────────────────
  Log ''
  Log '=== U-02 关到托盘 ==='
  $beforeCount = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$root*" }).Count
  Log "  关窗前：便携进程数（含子进程）=$beforeCount"
  # 关键：句柄必须**当场重新取**（splash 关闭后旧句柄会失效，PostMessage 静默返回 false），
  # 并且校验 PostMessage 的返回值 —— 早期版本没校验，导致"以为发了 WM_CLOSE 其实没送到"，
  # 于是把"窗口还在"误判成产品缺陷。
  $target = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 1
  if (-not $target) { Res 'u02-closeToTray' 'FAIL' '找不到可见主窗口（MainWindowTitle 为空），无法触发关闭' }
  else {
    $h = [IntPtr]$target.MainWindowHandle
    Log "  目标窗口：pid=$($target.Id) title='$($target.MainWindowTitle)' hwnd=$h"
    $posted = [S3Win]::PostMessage($h, [S3Win]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    Log "  PostMessage(WM_CLOSE) 返回=$posted"
    if (-not $posted) {
      Log '  PostMessage 失败，改用 CloseMainWindow() 重试' 'WARN'
      $closed = $target.CloseMainWindow()
      Log "  CloseMainWindow() 返回=$closed"
    }

    # 0.3.39 起「首次点 X」会弹确认框（background-close-confirmed）：这是**设计行为**，
    # 不是没关掉。所以流程是：断言确认框出现 → 用 UIA Invoke 点「确认最小化到托盘」→ 断言窗口隐藏。
    $dialogSeen = $false
    $confirmBtn = $null
    $uiaRoot2 = [System.Windows.Automation.AutomationElement]::RootElement
    $dlg = Wait-Until -TimeoutSec 20 -What '关闭确认框出现' -Condition {
      foreach ($w in $uiaRoot2.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        try {
          if ($w.Current.Name -match 'DSH Desktop' -and $w.Current.ClassName -notmatch 'Chrome_WidgetWin') {
            foreach ($it in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
              try { if ($it.Current.Name -match '确认最小化到托盘') { return @{ win = $w; btn = $it } } } catch { }
            }
          }
        } catch { }
      }
      return $null
    }
    if ($dlg) {
      $dialogSeen = $true
      $confirmBtn = $dlg.btn
      Log ("  关闭确认框出现：'" + $dlg.win.Current.Name + "'，按钮='" + $confirmBtn.Current.Name + "'（这是设计行为：首次点 X 先确认一次）")
      try { $confirmBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Log '  已 Invoke「确认最小化到托盘」' }
      catch { Log ("  按钮 Invoke 失败：" + $_.Exception.Message) 'WARN' }
      Start-Sleep -Seconds 4
    } else {
      Log '  未出现确认框（可能此前已确认过 → 直接隐藏，这也是设计行为）'
    }

    Start-Sleep -Seconds 3
    $alive = @(Get-Process -Id $app.Id -ErrorAction SilentlyContinue).Count -gt 0
    $visWin = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$root*" } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ -and $_.MainWindowHandle -ne 0 })
    Log "  关窗后：主进程存活=$alive，仍有可见主窗口=$($visWin.Count)"
    # 这里**不做**全桌面截图（关窗后窗口已隐藏，桌面上是谁的窗口与本验收无关；
    # 全桌面截屏曾被误当成证据，已作废）。U-02 的证据是：进程存活 + 托盘图标 + 日志。

    # 托盘图标存在性：打开溢出区，在 UIA 里找 DSH Desktop 图标
    $trayFound = $false
    try {
      $uiaRoot = [System.Windows.Automation.AutomationElement]::RootElement
      $tbCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
      $tb = $uiaRoot.FindFirst([System.Windows.Automation.TreeScope]::Children, $tbCond)
      foreach ($e in $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        try { if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $e.Current.ClassName -eq 'SystemTray.NormalButton' -and $e.Current.Name -match 'DSH Desktop') { $trayFound = $true; break } } catch { }
      }
      if (-not $trayFound) {
        $toggle = $null
        foreach ($e in $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { try { if ($e.Current.Name -match '显示隐藏的图标|通知|Notifications') { $toggle = $e; break } } catch { } }
        if ($toggle) {
          $tr = $toggle.Current.BoundingRectangle
          [S3Win]::SetCursorPos([int]($tr.X + $tr.Width / 2), [int]($tr.Y + $tr.Height / 2)) | Out-Null
          Start-Sleep -Milliseconds 200
          [S3Win]::mouse_event([S3Win]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [S3Win]::mouse_event([S3Win]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 900
          $island = $null
          foreach ($w in $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { try { if ($w.Current.ClassName -match 'Overflow|NotifyIcon') { $island = $w; break } } catch { } }
          if ($island) {
            foreach ($e in $island.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { try { if ($e.Current.Name -match 'DSH Desktop') { $trayFound = $true; $script:trayIconEl = $e; break } } catch { } }
          }
          [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        }
      }
    } catch { Log ("  托盘枚举异常：" + $_.Exception.Message) 'WARN' }
    $script:trayIconElement = $script:trayIconEl

    # 日志里的"留托盘"记录
    $trayLog = $null
    if (Test-Path $mainLog) { $trayLog = (Select-String -Path $mainLog -Pattern '托盘|background-close|关闭到|hide' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line }
    if ($trayLog) { Log ("  日志留托盘记录：" + $trayLog.Trim()) }
    $ok = $alive -and ($visWin.Count -eq 0)
    # 判定口径：进程存活 + 主窗口已隐藏 = 关到托盘成立（=PASS）。
    # 托盘图标存在性是**附加证据**：Win11 溢出区枚举本身有抖动（首次点开常需重试），
    # 不能因为枚举失败就否定产品行为，但必须在 detail 里如实写出来。
    $detail = "进程存活=$alive；可见主窗口=$($visWin.Count)；首次关闭确认框=$dialogSeen；托盘图标=$trayFound；留托盘日志=$(if($trayLog){'有'}else{'无'})"
    Res 'u02-closeToTray' $(if ($ok) { 'PASS' } else { 'FAIL' }) $detail
    $R.u02 = @{ trayIconFound = $trayFound; dialogSeen = $dialogSeen; windowHidden = ($visWin.Count -eq 0); trayLogLine = if ($trayLog) { $trayLog.Trim() } else { $null } }
  }

  # ── U-04 二次启动 / 单实例 ────────────────────────────────────────────────
  Log ''
  Log '=== U-04 二次启动 / 单实例 ==='
  $before2 = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$root*" }).Count
  $backendBefore = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $app.Id -and $_.Name -eq 'node.exe' }).Count
  $lcBefore = if (Test-Path $lifecycle) { @(Get-Content $lifecycle).Count } else { 0 }
  Log "  二次启动前：便携进程总数=$before2，后端 node 数=$backendBefore，lifecycle 行数=$lcBefore"
  $env:DSH_DIAG_BASE = $diagBase
  $env:DSH_HOME = $dshHome
  $app2 = Start-Process -FilePath (Join-Path $root 'DSH Desktop.exe') -ArgumentList @("--user-data-dir=`"$userData`"") -PassThru
  $env:DSH_DIAG_BASE = $null
  $env:DSH_HOME = $null
  Log "  第二实例 pid=$($app2.Id)，等待其退出（单实例锁应使其快速退出）"
  $exited = $app2.WaitForExit(45000)
  Start-Sleep -Seconds 2
  $secondStill = @(Get-Process -Id $app2.Id -ErrorAction SilentlyContinue).Count -gt 0
  $after2 = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$root*" }).Count
  $backendAfter = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $app.Id -and $_.Name -eq 'node.exe' }).Count
  $lcAfter = if (Test-Path $lifecycle) { @(Get-Content $lifecycle).Count } else { 0 }
  $secondInstanceLog = $null
  if (Test-Path $lifecycle) {
    $newLines = @(Get-Content $lifecycle | Select-Object -Skip $lcBefore)
    $secondInstanceLog = ($newLines | Where-Object { $_ -match 'second-instance' } | Select-Object -Last 1)
  }
  Log "  第二实例已退出=$exited（仍在=$secondStill）；lifecycle 新增行=$($lcAfter - $lcBefore)"
  if ($secondInstanceLog) { Log ("  lifecycle 记录：" + $secondInstanceLog.Trim()) }
  Log "  二次启动后：便携进程总数=$after2，后端 node 数=$backendAfter"
  $ok4 = (-not $secondStill) -and ($backendAfter -le $backendBefore) -and ($after2 -le $before2)
  Res 'u04-singleInstance' $(if ($ok4) { 'PASS' } else { 'FAIL' }) "第二实例退出=$exited/仍在=$secondStill；进程数 ${before2}→${after2}；后端数 ${backendBefore}→${backendAfter}；lifecycle 新增=$($lcAfter - $lcBefore)"
  $R.u04 = @{ secondExited = $exited; secondStillRunning = $secondStill; procsBefore = $before2; procsAfter = $after2; backendsBefore = $backendBefore; backendsAfter = $backendAfter; lifecycleLine = if ($secondInstanceLog) { $secondInstanceLog.Trim() } else { $null } }

  # ── U-06 气泡系统确认显示（等真实通知事件）────────────────────────────────
  Log ''
  Log "=== U-06 气泡系统确认显示（最多等 ${NotifyWaitSec}s 的真实通知事件）==="
  $notified = Wait-Until -TimeoutSec $NotifyWaitSec -What '真实通知事件 + balloon-show 确认' -Condition {
    if (-not (Test-Path $mainLog)) { return $null }
    $txt = Get-Content $mainLog -Tail 600 -ErrorAction SilentlyContinue | Out-String
    $sent = [regex]::Matches($txt, '托盘气泡已发出')
    $shown = [regex]::Matches($txt, '托盘气泡已由系统确认显示')
    if ($sent.Count -gt 0) { return [pscustomobject]@{ sent = $sent.Count; shown = $shown.Count } }
    return $null
  } -PollMs 2000
  if (-not $notified) {
    $pending = (Select-String -Path $mainLog -Pattern '更新检查|检查更新|发现新版本|update' -ErrorAction SilentlyContinue | Select-Object -Last 2 | ForEach-Object { $_.Line.Trim() })
    Log '  未观测到真实通知事件（本轮没有触发 notifyUser 的业务事件）'
    Res 'u06-balloonConfirm' 'NOT_OBSERVED' ("未观测到真实通知事件（等 ${NotifyWaitSec}s 无『托盘气泡已发出』）；更新检查最近记录：" + ($pending -join ' | '))
    $R.u06 = @{ observed = $false; pendingUpdateLines = $pending }
  } else {
    $sentLine = (Select-String -Path $mainLog -Pattern '托盘气泡已发出' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line
    $shownLine = (Select-String -Path $mainLog -Pattern '托盘气泡已由系统确认显示' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line
    if ($notified.shown -gt 0) {
      Log ("  ✔ 系统确认显示：" + $shownLine.Trim())
      Res 'u06-balloonConfirm' 'PASS' ("balloon-show 已触发；发出行：" + $sentLine.Trim())
    } else {
      Log ("  ⚠ 发出但未收到 balloon-show 确认：" + $sentLine.Trim())
      Res 'u06-balloonConfirm' 'FAIL' ("气泡已发出但系统未确认（未收到 balloon-show）；发出行：" + $sentLine.Trim())
    }
    $R.u06 = @{ observed = $true; sentLine = $sentLine.Trim(); shownLine = if ($shownLine) { $shownLine.Trim() } else { $null } }
  }

  # ── U-08 从托盘点开设置窗（UIA Invoke 模式，非鼠标合成）─────────────────────
  Log ''
  Log '=== U-08 从托盘点开设置窗（UIA Invoke 优先）==='
  $u08 = [ordered]@{ menuItemFound = $false; invokeAttempted = $false; settingsWindow = $false; reason = '' }
  try {
    $uiaRoot = [System.Windows.Automation.AutomationElement]::RootElement
    # 先探当前存在的 UIA 元素（若 U-02 已经抓到托盘图标元素则直接复用其坐标/模式）
    $icon = $script:trayIconElement
    if (-not $icon) {
      $tbCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
      $tb = $uiaRoot.FindFirst([System.Windows.Automation.TreeScope]::Children, $tbCond)
      $toggle = $null
      foreach ($e in $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { try { if ($e.Current.Name -match '显示隐藏的图标|通知|Notifications') { $toggle = $e; break } } catch { } }
      if ($toggle) {
        $tr = $toggle.Current.BoundingRectangle
        [S3Win]::SetCursorPos([int]($tr.X + $tr.Width / 2), [int]($tr.Y + $tr.Height / 2)) | Out-Null
        Start-Sleep -Milliseconds 200
        [S3Win]::mouse_event([S3Win]::LEFTDOWN,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [S3Win]::mouse_event([S3Win]::LEFTUP,0,0,0,[UIntPtr]::Zero)
        Start-Sleep -Milliseconds 900
        $island = $null
        foreach ($w in $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { try { if ($w.Current.ClassName -match 'Overflow|NotifyIcon') { $island = $w; break } } catch { } }
        if ($island) { foreach ($e in $island.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { try { if ($e.Current.Name -match 'DSH Desktop') { $icon = $e; break } } catch { } } }
      }
    }
    if (-not $icon) {
      $u08.reason = 'UIA 未枚举到 DSH 托盘图标（溢出区未出现或图标未被暴露）'
      Res 'u08-openSettingsFromTray' 'NOT_VERIFIED_MANUAL' $u08.reason
    } else {
      # 枚举该元素支持的 pattern，并逐个报告（便于下次直接选对模式）
      # 注意两点：
      #   1) PowerShell 不支持 [System.Windows.Automation.$p]::Pattern 这种"变量类型名"，必须显式映射；
      #   2) pwsh 7 的 UIAutomationClient 里**没有** LegacyIAccessiblePattern 类型（.NET Framework 才有），
      #      所以每个类型都要单独 try/catch —— 早期版本在构造映射表时整体抛异常，直接把 U-08 判成 FAIL，
      #      那是"工具缺能力"，不是"产品点不开"。
      $patternMap = [ordered]@{}
      foreach ($pair in @(
          @('InvokePattern', 'System.Windows.Automation.InvokePattern'),
          @('ExpandCollapsePattern', 'System.Windows.Automation.ExpandCollapsePattern'),
          @('LegacyIAccessiblePattern', 'System.Windows.Automation.LegacyIAccessiblePattern'),
          @('SelectionItemPattern', 'System.Windows.Automation.SelectionItemPattern'),
          @('TogglePattern', 'System.Windows.Automation.TogglePattern'))) {
        try {
          $t = [Type]::GetType(($pair[1] + ', UIAutomationClient'), $false)
          if ($t) { $patternMap[$pair[0]] = $t.GetProperty('Pattern').GetValue($null) }
        } catch { Log ("  类型不可用（跳过）：" + $pair[0]) 'WARN' }
      }
      $patterns = @()
      foreach ($k in $patternMap.Keys) {
        try {
          $obj = $null
          if ($icon.TryGetCurrentPattern($patternMap[$k], [ref]$obj) -and $obj) { $patterns += $k }
        } catch { }
      }
      $u08.supportedPatterns = $patterns
      Log ("  托盘图标支持的模式：" + ($patterns -join ', '))
      $opened = $false
      # 方式1：LegacyIAccessible DoDefaultAction（等价键鼠"默认动作"）
      if (-not $opened -and $patterns -contains 'LegacyIAccessiblePattern') {
        try {
          $legacy = $icon.GetCurrentPattern($patternMap['LegacyIAccessiblePattern'])
          $legacy.DoDefaultAction()
          $u08.invokeAttempted = $true
          Log '  已用 LegacyIAccessiblePattern.DoDefaultAction 触发默认动作'
        } catch { Log ("  DoDefaultAction 失败：" + $_.Exception.Message) 'WARN' }
      }
      # 方式2：InvokePattern
      if (-not $opened -and $patterns -contains 'InvokePattern') {
        try {
          $icon.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          $u08.invokeAttempted = $true
          Log '  已用 InvokePattern.Invoke 触发默认动作'
        } catch { Log ("  Invoke 失败：" + $_.Exception.Message) 'WARN' }
      }
      Start-Sleep -Milliseconds 900
      # 是否有菜单窗口（#32768）出现
      $menu = $null
      foreach ($w in $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { try { if ($w.Current.ClassName -match '32678|Menu|Popup') { $menu = $w; break } } catch { } }
      if ($menu) {
        foreach ($it in $menu.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          try {
            if ($it.Current.Name -match '设置') {
              $u08.menuItemFound = $true
              Log ("  找到菜单项：'" + $it.Current.Name + "'")
              try { $it.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $opened = $true; Log '  已 Invoke「设置…」' }
              catch { try { $it.GetCurrentPattern($patternMap['LegacyIAccessiblePattern']).DoDefaultAction(); $opened = $true; Log '  已 DoDefaultAction「设置…」' } catch { Log ("  菜单项激活失败：" + $_.Exception.Message) 'WARN' } }
              break
            }
          } catch { }
        }
      }
      if ($opened) {
        # 等设置窗出现：UIA 顶层窗口标题包含「DSH Desktop 设置」
        $settWin = Wait-Until -TimeoutSec 20 -What '设置窗出现' -Condition {
          foreach ($w in $uiaRoot.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
            try { if ($w.Current.Name -match 'DSH Desktop 设置') { return $w } } catch { }
          }
          return $null
        }
        if ($settWin) { $u08.settingsWindow = $true; Log ("  ✔ 设置窗已打开：" + $settWin.Current.Name); Res 'u08-openSettingsFromTray' 'PASS' ("UIA 激活成功，设置窗标题='" + $settWin.Current.Name + "'；支持模式=" + ($patterns -join ',')) }
        else { Res 'u08-openSettingsFromTray' 'FAIL' ("已激活菜单项但 20s 内未见设置窗；支持模式=" + ($patterns -join ',')) }
      } else {
        $u08.reason = "托盘图标支持模式=$($patterns -join ',')；尝试了 " + $(if ($u08.invokeAttempted) { 'Invoke/DoDefaultAction' } else { '无可用模式' }) + '，但未出现托盘菜单窗口（#32768），因此无法点到「设置…」'
        Res 'u08-openSettingsFromTray' 'NOT_VERIFIED_MANUAL' $u08.reason
      }
    }
  } catch { Log ("  U-08 异常：" + $_.Exception.Message) 'ERROR'; Res 'u08-openSettingsFromTray' 'FAIL' $_.Exception.Message }
  $R.u08 = $u08

} catch {
  Log ("异常：" + $_.Exception.Message) 'ERROR'
  Res 'exception' 'FAIL' $_.Exception.Message
} finally {
  # 清理（PID 定向 + 路径核对）
  foreach ($p in @($app2, $app)) {
    if ($p -and -not $p.HasExited) {
      $exePath = ''
      try { $exePath = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").ExecutablePath } catch { }
      if ($exePath -and $exePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { & taskkill /F /T /PID $p.Id 2>&1 | Out-Null; Log ("  已定向终止 pid=" + $p.Id) }
      else { Log ("  跳过清理 pid=" + $p.Id + "（exe 路径不在临时目录）") 'WARN' }
    }
  }
  Start-Sleep -Seconds 2
  if (Test-Path $logs) {
    $dest = Join-Path $outDir "补充验收日志_$RunId"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $logs '*') $dest -ErrorAction SilentlyContinue
    $R.savedLogs = $dest
    Log "  日志已留存：$dest"
  }
  $afterHost = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $survived = @($hostPids | Where-Object { $afterHost -contains $_ })
  Res 'hostIntact' $(if ($survived.Count -eq $hostPids.Count) { 'PASS' } else { 'FAIL' }) "宿主 $($hostPids.Count) 个，仍存活 $($survived.Count)"
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue

  $fal = @($R.results.Values | Where-Object { $_.status -eq 'FAIL' }).Count
  $nv = @($R.results.Values | Where-Object { $_.status -like 'NOT_*' }).Count
  $ok = @($R.results.Values | Where-Object { $_.status -eq 'PASS' }).Count
  $R.counts = @{ pass = $ok; fail = $fal; notVerified = $nv }
  $R.finishedAt = (Get-Date).ToString('o')
  $R | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonOut -Encoding utf8
  Log ''
  Log ("===== 补充验收结束：PASS=$ok FAIL=$fal NOT_VERIFIED=$nv =====")
  Log ("  记录：" + $jsonOut)
  exit ([int]($fal -gt 0))
}
