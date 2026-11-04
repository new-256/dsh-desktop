<#
  rollback-to-0.3.48.ps1 —— 一键装回 B 版（0.3.48），用户后悔 0.3.49 时用。

  与安装脚本同一条纪律：
    1) 先备份当前状态（注册表版本 / exe 版本 / 用户数据是否存在）——出问题能说清"你原来是什么"；
    2) 校验 0.3.48 安装包 SHA-256（与冻结记录一致才继续）；
    3) 需要用户输入 YES 明确确认（会关闭当前窗口）；
    4) 静默安装 0.3.48 → 等注册表版本变化 → 启动；
    5) 结果与备份写到 `回滚结果_<时间戳>\`。
  用户数据（%APPDATA%\DSH Desktop）在整个过程中不会被删除或改动。
  退出码：0=成功；1=校验/安装失败；2=用户中止。
#>
param(
  [string]$PackagePath = '',
  [string]$ExpectedVersion = '0.3.48',
  [string]$ExpectedSha256 = 'F0EFD669C3798738C67440DCC4AC5064642268BE94730AF692F96968D89DA249',
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
$resultDir = Join-Path $here "回滚结果_$stamp"
New-Item -ItemType Directory -Force -Path $resultDir | Out-Null

function Say([string]$m, [string]$lvl = 'INFO') {
  $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $lvl, $m
  Write-Host $line
  Add-Content -Path (Join-Path $resultDir '运行日志.txt') -Value $line -Encoding utf8
}
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

Say ('=' * 74)
Say '  DSH Desktop 回滚到 0.3.48（B 版）'
Say ('=' * 74)
$beforeVersion = Get-InstalledVersion
$beforeExeVer = if (Test-Path $exePath) { (Get-Item $exePath).VersionInfo.ProductVersion } else { $null }
$backup = @"
===== 回滚前原始状态（$stamp）=====
注册表 DisplayVersion      : $(if ($beforeVersion) { $beforeVersion } else { '（未安装）' })
安装目录 exe ProductVersion: $(if ($beforeExeVer) { $beforeExeVer } else { '（无 exe）' })
用户数据目录               : $env:APPDATA\DSH Desktop  存在=$(Test-Path "$env:APPDATA\DSH Desktop")
回滚目标                   : $ExpectedVersion
期望 SHA-256               : $ExpectedSha256
"@
$backup | Set-Content -Path (Join-Path $resultDir '回滚前原始状态.txt') -Encoding utf8
Write-Host $backup

if (-not (Test-Path $PackagePath)) {
  Say "找不到 0.3.48 安装包：$PackagePath" 'ERROR'
  Say '请确认 release 目录里有 "DSH Desktop Setup 0.3.48.exe"。' 'ERROR'
  Read-Host '按 Enter 关闭' | Out-Null
  exit 1
}
$actualHash = (Get-FileHash $PackagePath -Algorithm SHA256).Hash.ToUpperInvariant()
Say "0.3.48 包 SHA-256：$actualHash"
if ($actualHash -ne $ExpectedSha256.ToUpperInvariant()) {
  Say 'SHA-256 与冻结记录不一致，已中止（不会装被替换过的包）。' 'ERROR'
  Say "  期望：$($ExpectedSha256.ToUpperInvariant())" 'ERROR'
  Read-Host '按 Enter 关闭' | Out-Null
  exit 1
}
Say '包校验：通过'

if (-not $AssumeYes) {
  Write-Host ''
  Write-Host '  回滚会关闭当前 DSH Desktop（约 2–4 分钟），然后装上 0.3.48。'
  Write-Host '  你的会话与配置在 %APPDATA%\DSH Desktop，不会被删除。'
  $ans = Read-Host '确认回滚请输入大写 YES'
  if ($ans -ne 'YES') { Say '用户中止，未做任何改动。' 'WARN'; Read-Host '按 Enter 关闭' | Out-Null; exit 2 }
}

$p = Start-Process -FilePath $PackagePath -ArgumentList '/S' -PassThru
Say "回滚安装器已启动 pid=$($p.Id)，等待退出（最长 10 分钟）…"
if (-not $p.WaitForExit(600000)) { Say '安装器超时未退出' 'ERROR'; Read-Host '按 Enter 关闭' | Out-Null; exit 1 }
Say "安装器退出码：$($p.ExitCode)"

$deadline = (Get-Date).AddSeconds(180)
$nowVer = Get-InstalledVersion
while ((Get-Date) -lt $deadline -and $nowVer -ne $ExpectedVersion) { Start-Sleep -Seconds 2; $nowVer = Get-InstalledVersion }
Say "回滚后注册表版本：$(if ($nowVer) { $nowVer } else { '（读不到）' })"
if ($nowVer -ne $ExpectedVersion) {
  Say "回滚未生效（期望 $ExpectedVersion）。原始状态已备份：$(Join-Path $resultDir '回滚前原始状态.txt')" 'ERROR'
  Read-Host '按 Enter 关闭' | Out-Null
  exit 1
}
Say '回滚：成功'

if (-not $SkipLaunch) {
  if (Test-Path $exePath) { Start-Process -FilePath $exePath | Out-Null; Say '已启动 0.3.48。' }
}

$reportPath = Join-Path $resultDir '回滚结果.md'
@"
# 回滚结果（$stamp）

- 回滚前版本：$(if ($beforeVersion) { $beforeVersion } else { '未安装' })（exe=$(if ($beforeExeVer) { $beforeExeVer } else { '无' })）
- 回滚目标  ：$ExpectedVersion
- 回滚后版本：$nowVer
- 用户数据  ：未改动（%APPDATA%\DSH Desktop 保留）
- 结果      ：$(if ($nowVer -eq $ExpectedVersion) { '✅ 成功' } else { '❌ 失败' })
"@ | Set-Content -Path $reportPath -Encoding utf8
Say "结果文件：$reportPath"
Read-Host '按 Enter 关闭' | Out-Null
exit 0
