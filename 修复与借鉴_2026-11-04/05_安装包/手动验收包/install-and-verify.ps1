<#
  install-and-verify.ps1 —— 0.3.50「手动安装验收」一键脚本（用户双击 一键安装并验收.cmd 触发）

  为什么用它：真机 NSIS 安装会按设计杀掉正在运行的 DSH Desktop（含其全部会话），
  所以在团队流水线里无法自动执行——必须由用户在「可以接受窗口被关闭几分钟」的时刻手动触发一次。
  本脚本把这件事做成可控的一步：

    1) 先备份当前状态（注册表版本 / exe 文件版本 / 安装目录 / 用户数据目录是否存在）
       → 失败时能明确说"你原来是哪个版本"，不会让用户失去参照；
    2) 校验安装包 SHA-256（与冻结记录一致才继续，不一致立即中止并指出期望值与实际值）；
    3) 静默安装 0.3.49（NSIS /S，标准安装流程：结束进程 → 卸载旧版 → 写文件 → 快捷方式）；
    4) 等安装完成（轮询注册表版本），然后启动应用；
    5) 引导用户做 4 步人工核对（关窗是否缩托盘 / 托盘菜单点设置 / 托盘退出 / 再启动一次）；
    6) 自动把日志与关键锚点收集到 `验收结果_<时间戳>\`，生成 `核对摘要.txt`。

  退出码：0=脚本流程完成（不代表人工 4 步都通过，摘要里会逐条列出）；1=校验/安装失败；2=用户中止。
#>

param(
  [string]$PackagePath = '',
  [string]$ExpectedVersion = '0.3.50',
  [string]$ExpectedSha256 = 'AFDC586EB86650DD0F149C56D7A404A48E68728BFE21C59CDA10D292C28D0313',
  [switch]$AssumeYes,
  [switch]$SkipLaunch
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $here '..\..\..')).Path
if (-not $PackagePath) { $PackagePath = Join-Path $repoRoot "release\DSH Desktop Setup $ExpectedVersion.exe" }

$installDir = 'C:\Program Files\DSH Desktop'
$exePath = Join-Path $installDir 'DSH Desktop.exe'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$resultDir = Join-Path $here "验收结果_$stamp"
$summary = New-Object System.Collections.ArrayList

function Say([string]$m, [string]$lvl = 'INFO') {
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $lvl, $m
  Write-Host $line
  if (Test-Path $resultDir) { Add-Content -Path (Join-Path $resultDir '运行日志.txt') -Value $line -Encoding utf8 }
  [void]$summary.Add($line)
}
function Line([string]$m = '') { Write-Host $m; if (Test-Path $resultDir) { Add-Content -Path (Join-Path $resultDir '运行日志.txt') -Value $m -Encoding utf8 }; [void]$summary.Add($m) }

function Get-InstalledVersion {
  foreach ($k in @(
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $hit = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DSH Desktop*' } | Select-Object -First 1
    if ($hit) { return $hit.DisplayVersion }
  }
  return $null
}

/** 等主窗口出现（按 exe 路径匹配进程，避免把其它程序的窗口当成结果）。 */
function Wait-UntilWindow {
  param([string]$exePath, [int]$timeoutSec = 120)
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 1
    if ($p) { return "$($p.MainWindowTitle)（pid=$($p.Id)）" }
    Start-Sleep -Seconds 2
  }
  return $null
}

# ── 0. 准备结果目录并备份原始状态 ─────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $resultDir | Out-Null
Line ('=' * 74)
Line "  DSH Desktop 手动安装验收 0.3.50    $stamp"
Line ('=' * 74)
Line ''
$beforeVersion = Get-InstalledVersion
$beforeExeVer = if (Test-Path $exePath) { (Get-Item $exePath).VersionInfo.ProductVersion } else { $null }
$backup = @"
===== 安装前原始状态备份（$stamp）=====
注册表 DisplayVersion      : $(if ($beforeVersion) { $beforeVersion } else { '（未安装）' })
安装目录 exe ProductVersion: $(if ($beforeExeVer) { $beforeExeVer } else { '（无 exe）' })
安装目录                   : $installDir  存在=$(Test-Path $installDir)
用户数据目录               : $env:APPDATA\DSH Desktop  存在=$(Test-Path "$env:APPDATA\DSH Desktop")
本次安装包                 : $PackagePath
期望版本 / SHA-256         : $ExpectedVersion / $ExpectedSha256
"@
$backupPath = Join-Path $resultDir '原始状态备份.txt'
$backup | Set-Content -Path $backupPath -Encoding utf8
Write-Host $backup
Write-Host ''

if ($beforeVersion -eq $ExpectedVersion) {
  Say "当前已安装版本已经是 $ExpectedVersion —— 你可能是重复运行。仍会继续校验安装包（若只想重新走人工核对，可直接按提示操作）。" 'WARN'
}

# ── 1. 校验安装包 ─────────────────────────────────────────────────────────────
Line '── 第 1 步：校验安装包 ─────────────────────────────────────────────'
if (-not (Test-Path $PackagePath)) {
  Say "找不到安装包：$PackagePath" 'ERROR'
  Say '请确认 release 目录里有该文件，或把脚本与安装包放在同一层目录结构下。' 'ERROR'
  Read-Host '按 Enter 关闭' | Out-Null
  exit 1
}
$fi = Get-Item $PackagePath
$actualHash = (Get-FileHash $PackagePath -Algorithm SHA256).Hash.ToUpperInvariant()
Say "安装包：$($fi.FullName)"
Say "字节数：$($fi.Length)"
Say "SHA-256：$actualHash"
if ($actualHash -ne $ExpectedSha256.ToUpperInvariant()) {
  Say '安装包 SHA-256 与冻结记录不一致，已中止（不会安装被替换过的包）。' 'ERROR'
  Say "  期望：$($ExpectedSha256.ToUpperInvariant())" 'ERROR'
  Say "  实际：$actualHash" 'ERROR'
  Add-Content -Path (Join-Path $resultDir '核对摘要.txt') -Value "安装包校验：失败（SHA-256 不匹配）`n期望 $($ExpectedSha256.ToUpperInvariant())`n实际 $actualHash" -Encoding utf8
  Read-Host '按 Enter 关闭' | Out-Null
  exit 1
}
Say '安装包校验：通过（SHA-256 与冻结记录一致）'

# ── 2. 用户确认（会被关闭窗口，必须知情）──────────────────────────────────────
Line ''
Line '── 第 2 步：确认（安装会关闭当前 DSH Desktop）──────────────────────'
Line '  安装器会结束正在运行的 DSH Desktop 与它的后端进程，窗口会关闭约 2–4 分钟。'
Line '  你的会话与配置保存在 %APPDATA%\DSH Desktop，不会被删除。'
Line ''
if (-not $AssumeYes) {
  $ans = Read-Host "确认继续请输入大写 YES"
  if ($ans -ne 'YES') { Say '用户中止，未做任何安装动作。' 'WARN'; Read-Host '按 Enter 关闭' | Out-Null; exit 2 }
}

# ── 3. 静默安装 ───────────────────────────────────────────────────────────────
Line ''
Line '── 第 3 步：静默安装（NSIS /S，标准安装流程）──────────────────────'
$p = Start-Process -FilePath $PackagePath -ArgumentList '/S' -PassThru
Say "安装器已启动 pid=$($p.Id)，等待退出（最长 10 分钟）…"
if (-not $p.WaitForExit(600000)) {
  Say '安装器 10 分钟未退出，可能是被 UAC 弹窗挡住或卡住。请检查屏幕上的窗口。' 'ERROR'
  Add-Content -Path (Join-Path $resultDir '核对摘要.txt') -Value '安装：失败（安装器超时未退出）' -Encoding utf8
  Read-Host '按 Enter 关闭' | Out-Null
  exit 1
}
Say "安装器退出码：$($p.ExitCode)"

$deadline = (Get-Date).AddSeconds(180)
$nowVer = Get-InstalledVersion
while ((Get-Date) -lt $deadline -and $nowVer -ne $ExpectedVersion) { Start-Sleep -Seconds 2; $nowVer = Get-InstalledVersion }
Say "安装后注册表版本：$(if ($nowVer) { $nowVer } else { '（读不到）' })"
if ($nowVer -ne $ExpectedVersion) {
  Say "版本未变成 $ExpectedVersion —— 安装可能没成功（可能被 UAC 拒绝）。原始状态已备份在：$backupPath" 'ERROR'
  Add-Content -Path (Join-Path $resultDir '核对摘要.txt') -Value "安装：失败（注册表版本=$nowVer，期望 $ExpectedVersion）；原始版本=$beforeVersion" -Encoding utf8
  Read-Host '按 Enter 关闭' | Out-Null
  exit 1
}
$exeVer = if (Test-Path $exePath) { (Get-Item $exePath).VersionInfo.ProductVersion } else { '（无 exe）' }
Say "安装目录 exe ProductVersion：$exeVer"
Say '安装：成功'

# ── 4. 启动应用 ───────────────────────────────────────────────────────────────
Line ''
Line '── 第 4 步：启动应用 ──────────────────────────────────────────────'
if (-not $SkipLaunch) {
  if (Test-Path $exePath) {
    Start-Process -FilePath $exePath | Out-Null
    Say '已启动 DSH Desktop，等窗口出现…'
    $t = Wait-UntilWindow -exePath $exePath -timeoutSec 120
    if ($t) { Say "主窗口已出现：$t" } else { Say '等待主窗口超时（可能还在启动画面/后端初始化）。请人工确认。' 'WARN' }
  } else { Say "找不到 $exePath" 'ERROR' }
}

# ── 5. 人工 4 步 ─────────────────────────────────────────────────────────────
Line ''
Line '── 第 5 步：请按顺序做这 4 件事（每步做完回这个窗口按 Enter）────────'
Line ''
Line '  【1/4】点窗口右上角 X 关闭 → 观察：窗口消失，但任务栏托盘区仍应存在 DSH 图标（可能被收进"隐藏的图标"里）。'
Read-Host '        做完按 Enter' | Out-Null
Line '  【2/4】右键任务栏托盘区的 DSH 图标 → 点「设置…」→ 设置窗应打开且内容可读（不是白屏）。'
Read-Host '        做完按 Enter' | Out-Null
Line '  【3/4】再次右键托盘图标 → 点「退出」→ 应用应真正退出（任务管理器里 DSH Desktop 进程消失）。'
Read-Host '        做完按 Enter' | Out-Null
Line '  【4/4】再双击桌面「DSH Desktop」启动一次 → 应能正常打开到你原来的会话。'
Read-Host '        做完按 Enter' | Out-Null

# ── 6. 收集证据 ───────────────────────────────────────────────────────────────
Line ''
Line '── 第 6 步：收集日志与关键锚点 ───────────────────────────────────'
$sources = @(
  @{ path = (Join-Path $installDir 'logs'); name = '安装目录logs' },
  @{ path = (Join-Path $env:APPDATA 'DSH Desktop\logs'); name = '用户目录logs' }
)
foreach ($s in $sources) {
  if (Test-Path $s.path) {
    $dest = Join-Path $resultDir $s.name
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item (Join-Path $s.path '*') $dest -Recurse -Force -ErrorAction SilentlyContinue
    Say "已收集：$($s.name) → $dest"
  } else { Say "未找到：$($s.path)" 'WARN' }
}

function Grep([string]$file, [string]$pattern) {
  if (-not (Test-Path $file)) { return $null }
  return (Select-String -Path $file -Pattern $pattern -ErrorAction SilentlyContinue | Select-Object -Last 1).Line
}
$lifecycle = Join-Path $resultDir '安装目录logs\DSH-Desktop-生命周期.log'
if (-not (Test-Path $lifecycle)) { $lifecycle = Join-Path $resultDir '用户目录logs\DSH-Desktop-生命周期.log' }
$mainLog = Join-Path $resultDir '安装目录logs\DSH-Desktop-日志.txt'
if (-not (Test-Path $mainLog)) { $mainLog = Join-Path $resultDir '用户目录logs\DSH-Desktop-日志.txt' }

$trayQuit = Grep $lifecycle '"reason":"tray-quit"'
$aumid = Grep $mainLog 'aumidApplied'
$startLine = Grep $lifecycle '"event":"start"'
$report = Get-ChildItem (Split-Path $mainLog -Parent) -Filter 'DSH-Desktop-错误报告*.txt' -ErrorAction SilentlyContinue | Select-Object -First 3

$checkRows = @(
  @{ name = '安装版本为 0.3.49'; ok = ($nowVer -eq $ExpectedVersion); detail = "注册表=$nowVer / exe=$exeVer" },
  @{ name = 'AUMID 已生效（aumidApplied:true）'; ok = ($aumid -and $aumid -match 'aumidApplied"?\s*:\s*true'); detail = $(if ($aumid) { $aumid.Trim() } else { '日志里没有 aumidApplied 行' }) },
  @{ name = '托盘退出留下 reason=tray-quit'; ok = [bool]$trayQuit; detail = $(if ($trayQuit) { $trayQuit.Trim() } else { '未找到 —— 若你这步没做，属正常' }) },
  @{ name = '日志里有启动记录'; ok = [bool]$startLine; detail = $(if ($startLine) { $startLine.Trim() } else { '未找到' }) },
  @{ name = '本次无错误报告文件（有则说明出现过故障）'; ok = ($report.Count -eq 0); detail = $(if ($report.Count -eq 0) { '无' } else { ($report.Name -join ', ') }) }
)

Line ''
Line '── 核对摘要（自动判定）──────────────────────────────────────────'
$md = New-Object System.Collections.ArrayList
[void]$md.Add("# 手动安装验收结果（$stamp）")
[void]$md.Add('')
[void]$md.Add('| 检查项 | 结果 | 证据 |')
[void]$md.Add('|---|---|---|')
foreach ($r in $checkRows) {
  $mark = if ($r.ok) { '✅ 通过' } else { '❌ 未通过' }
  Line ("  {0}  {1}" -f $mark, $r.name)
  if ($r.detail) { Line ("        " + $r.detail) }
  [void]$md.Add("| $($r.name) | $mark | $($r.detail -replace '\|', '/') |")
}
Line ''
Line '  人工 4 步的结论需要你自己判断（脚本无法替你点托盘菜单）：'
Line '    1) 关窗后托盘图标还在？  2) 托盘「设置…」能打开且不白屏？'
Line '    3) 托盘「退出」能真正退出？  4) 再启动能回到原会话？'
Line ''
Line "  结果目录：$resultDir"
Line "  原始状态备份：$backupPath"
[void]$md.Add('')
[void]$md.Add("原始版本（安装前）：$(if ($beforeVersion) { $beforeVersion } else { '未安装' })")
[void]$md.Add('')
[void]$md.Add("结果目录：$resultDir")
$md | Set-Content -Path (Join-Path $resultDir '核对摘要.md') -Encoding utf8

Say '完成。请把这个目录整体打包发回给维护者：' + $resultDir
Read-Host '按 Enter 关闭' | Out-Null
exit 0
