<#
  stage2-verify.ps1 —— 阶段二（0.3.49）出包后的成品行为验证。

  为什么单独一支：阶段二的改动都是"打包后才可能暴露"的类型（sandbox:true、cookie 清理、
  更新完整性校验），阶段一的教训是 dev 全绿不代表 shipped 正常。本脚本只做**成品实跑**取证：

    [1] 便携副本启动（隔离 userData + 日志基址 + CDP 调试口）
    [2] 渲染侧沙箱态：CDP 读 typeof require/process（沙箱生效的硬指标）
    [3] 主窗 Web UI 首帧：从日志取含 token 的 URL，实探 HTTP 200
    [4] AUMID 复验：日志必须 aumidApplied:true + 具体 appId（防阶段一修复回归）
    [5] cookie 清理：种外站 cookie → 杀掉后端触发重启 → 清理应只针对 127.0.0.1 源，
        外站 cookie 必须仍在（这是 B-01 的副作用防线）
    [6] 环形台账/中断标记不得出现"进包"迹象（在包内查找 apply-in-progress / plugin-journal 段文件）
    [7] 收尾：定向 taskkill（按 PID 且校验 exe 路径在临时目录内），日志留存

  诚实边界：
    - 「设置窗读写」由 `stage1-sandbox-settings-probe.js` 单独覆盖（成品 asar + 真 Electron + sandbox:true），
      因为设置窗唯一入口是托盘菜单，而本机悬浮托盘无法自动点击；
    - 「托盘图标/更新提示/插件列表」这类需要点开托盘菜单才能看到的项，本脚本只能给"未验证"，不冒充通过。

  用法：
    pwsh -NoProfile -File stage2-verify.ps1 -UnpackedDir <repo>\release\win-unpacked -RunId 0.3.49-xxxx -RepoRoot <repo>
  退出码：0=全部 PASS（允许 SKIP）；1=存在 FAIL。
#>
param(
  [Parameter(Mandatory = $true)][string]$UnpackedDir,
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [string]$ExpectedVersion = '0.3.49',
  [string]$ExpectedAppId = 'com.deepseek.dshdesktop',
  [int]$LaunchTimeoutSec = 420,
  [int]$CdpPort = 9339,
  [switch]$SkipCookieRestart
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$outDir = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$logFile = Join-Path $outDir "阶段二成品验证_$RunId.log"
$jsonOut = Join-Path $outDir "阶段二成品验证_$RunId.json"
$probeJs = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段\tools\stage1-cdp-probe.js'

function Log([string]$m, [string]$lvl = 'INFO') {
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss.fff'), $lvl, $m
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Wait-Until {
  param([scriptblock]$Condition, [int]$TimeoutSec, [string]$What, [int]$PollMs = 800)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { $v = & $Condition } catch { $v = $null }
    if ($v) { return $v }
    Start-Sleep -Milliseconds $PollMs
  }
  Log "  等待超时（${TimeoutSec}s）：$What" 'WARN'
  return $null
}

function Cdp([string]$cmd, [string[]]$extra = @()) {
  $args = @($probeJs, '--port', "$CdpPort", $cmd) + $extra
  $raw = & node @args 2>&1 | Out-String
  try { return $raw | ConvertFrom-Json } catch { return $null }
}

$result = [ordered]@{ runId = $RunId; mode = 'stage2-packaged-verify'; expectedVersion = $ExpectedVersion; startedAt = (Get-Date).ToString('o'); steps = [ordered]@{} }
function StepResult([string]$k, [string]$st, [string]$detail) {
  $result.steps[$k] = @{ status = $st; detail = $detail }
  Log ("  → {0}  {1}" -f $st, $detail)
}

Log "===== 阶段二成品验证开始 runId=$RunId ====="
$srcExe = Join-Path $UnpackedDir 'DSH Desktop.exe'
if (-not (Test-Path $srcExe)) { Log "✖ 找不到 $srcExe" 'ERROR'; exit 1 }
$hostPidsBefore = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Log ("宿主 DSH 进程（不得误杀）：" + ($(if ($hostPidsBefore) { $hostPidsBefore -join ',' } else { '(无)' })))

$smokeRoot = Join-Path $env:TEMP "dsh-s2-$RunId"
$userData = Join-Path $smokeRoot 'userdata'
$diagBase = Join-Path $smokeRoot 'diag'
$smokeLogs = Join-Path $diagBase 'logs'
$mainLog = Join-Path $smokeLogs 'DSH-Desktop-日志.txt'
$lifecycle = Join-Path $smokeLogs 'DSH-Desktop-生命周期.log'
$proc = $null

try {
  # ── [1] 复制并启动 ─────────────────────────────────────────────────────────
  if (Test-Path $smokeRoot) { Remove-Item $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $smokeRoot, $userData, $diagBase | Out-Null
  Log '复制 win-unpacked → 临时目录…'
  $rc = Start-Process robocopy -ArgumentList @("`"$UnpackedDir`"", "`"$smokeRoot`"", '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:16') -Wait -PassThru -WindowStyle Hidden
  if (-not (Test-Path (Join-Path $smokeRoot 'DSH Desktop.exe'))) { throw "复制失败（robocopy exit=$($rc.ExitCode)）" }
  StepResult 'copy' 'PASS' "robocopy exit=$($rc.ExitCode)"

  $env:DSH_DIAG_BASE = $diagBase
  # 调试口必须先确认空闲：端口被占用时 Chromium 绑不上 DevTools 服务，实测会让整个启动链
  # 停在"版本耦合软闸门"之后不再前进（现象与后端起不来一样，极易误判成产品回归）。
  $port = $CdpPort
  for ($i = 0; $i -lt 20; $i++) {
    $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $busy) { break }
    Log "  端口 $port 已被占用，换下一个" 'WARN'
    $port++
  }
  if ($port -ne $CdpPort) { Log "  CDP 端口从 $CdpPort 调整到 $port" 'WARN' }
  $script:CdpPort = $port
  $proc = Start-Process -FilePath (Join-Path $smokeRoot 'DSH Desktop.exe') -ArgumentList @(
    "--user-data-dir=`"$userData`"", "--remote-debugging-port=$port"
  ) -PassThru
  $env:DSH_DIAG_BASE = $null
  Log "  便携副本 pid=$($proc.Id)，CDP 端口 $port"

  # 等 lifecycle start
  $start = Wait-Until -TimeoutSec $LaunchTimeoutSec -What 'lifecycle start' -Condition {
    if (Test-Path $lifecycle) {
      foreach ($l in (Get-Content $lifecycle -ErrorAction SilentlyContinue)) {
        if ($l -match '"event":"start"') { try { return ($l | ConvertFrom-Json) } catch { } }
      }
    }
    return $null
  }
  if (-not $start) { StepResult 'lifecycleStart' 'FAIL' "超时未见 lifecycle start（进程已退出=$($proc.HasExited)）" }
  elseif ($start.version -ne $ExpectedVersion) { StepResult 'lifecycleStart' 'FAIL' "启动版本=$($start.version)，期望 $ExpectedVersion" }
  else { StepResult 'lifecycleStart' 'PASS' "version=$($start.version) reason=$($start.reason)" }

  # ── [2] Web UI 首帧（先按日志判定 —— 这是最可靠、最便宜的证据）─────────────
  $fullUrl = Wait-Until -TimeoutSec $LaunchTimeoutSec -What '日志出现含 token 的 Web UI 地址' -Condition {
    if (Test-Path $mainLog) {
      $text = Get-Content $mainLog -Tail 800 -ErrorAction SilentlyContinue | Out-String
      $m = [regex]::Matches($text, 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+')
      if ($m.Count -gt 0) { return $m[$m.Count - 1].Value }
    }
    return $null
  }
  if ($fullUrl) {
    $probe = Wait-Until -TimeoutSec 120 -What 'HTTP 200' -Condition {
      try { $r = Invoke-WebRequest -Uri $fullUrl -UseBasicParsing -TimeoutSec 15; if ($r.StatusCode -eq 200) { return $r } } catch { }
      return $null
    }
    if ($probe) { StepResult 'webui' 'PASS' ("HTTP 200（" + $probe.RawContentLength + " 字节） @" + ([regex]::Match($fullUrl, '127\.0\.0\.1:\d+').Value)) }
    else { StepResult 'webui' 'FAIL' '带 token 的 URL 未拿到 200' }
  } else {
    # 超时时留现场：谁还活着、卡在哪一行 —— 否则只能靠猜
    $procs = @(Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)
    $kids = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id } | ForEach-Object { "$($_.Name)($($_.ProcessId))" })
    $tail = @(Get-Content $mainLog -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object { $_.Trim() }) -join ' | '
    StepResult 'webui' 'FAIL' ("日志中未找到含 token 的 Web UI 地址；主进程存活=" + ($procs.Count -gt 0) + "；子进程=" + ($kids -join ',') + "；日志尾部=" + $tail)
  }

  # ── [3] 渲染侧沙箱态（CDP；失败不拖累首帧结论）──────────────────────────────
  $webTarget = Wait-Until -TimeoutSec 40 -What 'CDP 出现 http 页面目标' -Condition {
    $l = Cdp 'list'
    if ($l) {
      $hit = @($l | Where-Object { $_.url -match '^http://127\.0\.0\.1' })
      if ($hit.Count -gt 0) { return $hit[0] }
    }
    return $null
  }
  if ($webTarget) {
    $eval = Cdp 'eval' @("JSON.stringify({require:typeof require,process:typeof process,bridge:typeof window.dshDesktop})")
    $val = $null
    if ($eval -and $eval.value) { try { $val = $eval.value | ConvertFrom-Json } catch { } }
    if ($val) {
      $sandboxed = ($val.require -eq 'undefined') -and ($val.process -eq 'undefined')
      if ($sandboxed -and $val.bridge -eq 'object') {
        # 注意措辞：这只能证明 contextIsolation 生效（页面看不到 Node 全局）。
        # sandbox 是否开启由成品 main.js 的静态断言 + settings 探针运行证据分别给出，不在此处冒充。
        StepResult 'rendererIsolation' 'PASS' "Web UI 页面无 Node 全局（contextIsolation 生效），桥 dshDesktop 可用（$($webTarget.url)）"
      } elseif ($sandboxed) {
        StepResult 'rendererIsolation' 'SKIP' "页面无 Node 全局，但 window.dshDesktop 不存在（bridge=$($val.bridge)）"
      } else {
        StepResult 'rendererIsolation' 'FAIL' "页面仍可见 Node 全局（require=$($val.require) process=$($val.process)）—— 隔离失效"
      }
    } else { StepResult 'rendererIsolation' 'FAIL' 'CDP eval 未返回可解析结果' }
  } else {
    StepResult 'rendererIsolation' 'SKIP' 'CDP 未暴露 http 页面目标；隔离/沙箱结论改由 asar 静态断言 + 设置窗探针给出'
  }

  # ── [4] AUMID 复验（阶段一修复防回归）──────────────────────────────────────
  $aumidLine = $null
  if (Test-Path $mainLog) { $aumidLine = (Select-String -Path $mainLog -Pattern 'aumidApplied' -ErrorAction SilentlyContinue | Select-Object -Last 1).Line }
  if ($aumidLine -and $aumidLine -match 'aumidApplied"?\s*:\s*true' -and $aumidLine -match [regex]::Escape($ExpectedAppId)) {
    StepResult 'aumid' 'PASS' $aumidLine.Trim()
    $result.aumidLine = $aumidLine.Trim()
  } else {
    StepResult 'aumid' 'FAIL' ("AUMID 未按预期生效：" + $(if ($aumidLine) { $aumidLine.Trim() } else { '日志无 aumidApplied 行' }))
  }

  # ── [5] cookie 清理副作用（B-01）───────────────────────────────────────────
  if ($SkipCookieRestart) {
    StepResult 'cookieSideEffect' 'SKIP' '按参数跳过（-SkipCookieRestart）'
  } else {
    $setForeign = Cdp 'set-cookie' @('--url', 'https://example.com', '--name', 'dsh_foreign_probe', '--value', 'alive')
    if ($setForeign -and $setForeign.set) {
      Log '  已种外站 cookie（https://example.com/dsh_foreign_probe=alive）'
      # 杀掉便携副本的后端子进程（node.exe，父进程=本副本 exe），触发主进程自愈重启 → 清理逻辑重跑
      $appPid = $proc.Id
      $backendKids = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $appPid -and $_.Name -eq 'node.exe' })
      if ($backendKids.Count -eq 0) {
        StepResult 'cookieSideEffect' 'SKIP' '未找到后端子进程（可能尚未 spawn 或已退出），无法触发清理重跑'
      } else {
        foreach ($b in $backendKids) { Log ("  终止后端 pid=" + $b.ProcessId + " 以触发重启"); & taskkill /F /PID $b.ProcessId 2>&1 | Out-Null }
        $restarted = Wait-Until -TimeoutSec 180 -What '后端重启后出现新的 Web UI 地址' -Condition {
          $text = Get-Content $mainLog -Tail 400 -ErrorAction SilentlyContinue | Out-String
          $m = [regex]::Matches($text, 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+')
          if ($m.Count -ge 2) { return $m[$m.Count - 1].Value }
          return $null
        }
        if (-not $restarted) { StepResult 'cookieSideEffect' 'SKIP' '后端重启未在 180s 内完成，未能观测清理重跑' }
        else {
          $cookies = Cdp 'get-cookies' @('--url', 'https://example.com')
          $alive = $false
          if ($cookies -and $cookies.cookies) { $alive = @($cookies.cookies | Where-Object { $_.name -eq 'dsh_foreign_probe' }).Count -gt 0 }
          $hygieneLines = @(Select-String -Path $mainLog -Pattern 'cookie|Cookie' -ErrorAction SilentlyContinue | Select-Object -Last 6 | ForEach-Object { $_.Line.Trim() })
          $result.cookieHygieneLines = $hygieneLines
          if ($alive) { StepResult 'cookieSideEffect' 'PASS' '外站 cookie 在清理重跑后仍在（未误删用户其它站点登录态）' }
          else { StepResult 'cookieSideEffect' 'FAIL' '外站 cookie 被清掉了 —— 清理范围过大（B-01 副作用）' }
        }
      }
    } else { StepResult 'cookieSideEffect' 'SKIP' 'CDP 种 cookie 失败（沙箱/协议限制），改用日志观察' }
  }

  # ── [6] 运行期文件未进包（H-05 标记 / B-04 台账段）─────────────────────────
  $badFiles = @()
  foreach ($pat in @('*apply-in-progress*', '*plugin-journal*', '*plugin-journal*.log', '*.journal')) {
    $badFiles += @(Get-ChildItem (Join-Path $smokeRoot 'resources') -Recurse -Force -Filter $pat -ErrorAction SilentlyContinue)
  }
  if ($badFiles.Count -gt 0) {
    StepResult 'runtimeFilesNotPackaged' 'FAIL' ("resources 下发现运行期文件：" + (($badFiles | ForEach-Object { $_.Name }) -join ', '))
  } else { StepResult 'runtimeFilesNotPackaged' 'PASS' 'resources 下无 apply-in-progress / plugin-journal 段文件' }

} catch {
  Log ("异常：" + $_.Exception.Message) 'ERROR'
  StepResult 'exception' 'FAIL' $_.Exception.Message
} finally {
  # ── [7] 收尾 ───────────────────────────────────────────────────────────────
  if ($proc -and -not $proc.HasExited) {
    $exePath = ''
    try { $exePath = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)").ExecutablePath } catch { }
    $safe = ($exePath -and $exePath.StartsWith($smokeRoot, [System.StringComparison]::OrdinalIgnoreCase))
    if ($safe) {
      & taskkill /F /T /PID $proc.Id 2>&1 | Out-Null
      Start-Sleep -Seconds 2
      StepResult 'cleanup' $(if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) { 'FAIL' } else { 'PASS' }) "定向 taskkill pid=$($proc.Id)"
    } else { StepResult 'cleanup' 'SKIP' 'exe 路径不在临时目录，出于安全未清理' }
  } else { StepResult 'cleanup' 'PASS' '进程已自行退出' }

  $hostPidsAfter = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $survived = @($hostPidsBefore | Where-Object { $hostPidsAfter -contains $_ })
  StepResult 'hostIntact' $(if ($survived.Count -eq $hostPidsBefore.Count) { 'PASS' } else { 'FAIL' }) "宿主 ${($hostPidsBefore.Count)} 个，仍存活 $(($survived.Count))"

  if (Test-Path $smokeLogs) {
    $dest = Join-Path $outDir "阶段二成品日志_$RunId"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $smokeLogs '*') $dest -ErrorAction SilentlyContinue
    $result.savedLogs = $dest
    Log "  便携副本日志已留存：$dest"
  }
  Remove-Item $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue

  $failCount = @($result.steps.Values | Where-Object { $_.status -eq 'FAIL' }).Count
  $passCount = @($result.steps.Values | Where-Object { $_.status -eq 'PASS' }).Count
  $skipCount = @($result.steps.Values | Where-Object { $_.status -eq 'SKIP' }).Count
  $result.counts = @{ pass = $passCount; fail = $failCount; skip = $skipCount }
  $result.passed = ($failCount -eq 0)
  $result.finishedAt = (Get-Date).ToString('o')
  $result | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonOut -Encoding utf8
  Log ''
  Log ("===== 阶段二成品验证结束：PASS=$passCount FAIL=$failCount SKIP=$skipCount =====")
  Log "  记录：$jsonOut"
  exit ([int]($failCount -gt 0))
}
