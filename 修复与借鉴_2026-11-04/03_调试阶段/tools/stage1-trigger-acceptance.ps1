# stage1-trigger-acceptance.ps1 —— 真机验收的「一次性触发」封装（默认只打印计划，-Go 才真的执行）
#
# 为什么要绕道 Task Scheduler：安装器 DshTerminateAll（installer.nsh:69-77）会
# taskkill /F /T /IM "DSH Desktop.exe"，而开发会话（DSH 里的 agent）是它的后代。
# 由计划任务拉起守护脚本后，守护进程的父进程是 Task Scheduler 服务，不再属于被杀的那棵树，
# 因此它能活过安装、把「首启 → 关到托盘 → 托盘退出 → 再启动」的全程证据写完。
#
# 用法：
#   pwsh -NoProfile -File stage1-trigger-acceptance.ps1 -InstallerPath "release\DSH Desktop Setup 0.3.48.exe" -RunId "0.3.48-20261104-01-a1b2c3"
#        （只打印将要执行的 schtasks 命令，不动系统）
#   pwsh -NoProfile -File stage1-trigger-acceptance.ps1 ... -Go
#        （真正创建并立即运行计划任务）
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$RunId,
  [string]$RepoRoot = 'C:\Users\lcl\Desktop\DSH',
  [string]$FreezeId = 'FREEZE-2026-11-04-A',
  [string]$ExpectedVersion = '0.3.48',
  [string]$TaskName = '',
  [string]$User = '',
  [switch]$Go
)

$ErrorActionPreference = 'Stop'
$supervisor = Join-Path $RepoRoot '修复与借鉴_2026-11-04\03_调试阶段\tools\stage1-acceptance-supervisor.ps1'
$installer = (Resolve-Path $InstallerPath).Path

if (-not (Test-Path $supervisor)) { throw "找不到守护脚本：$supervisor" }
if (-not (Test-Path $installer)) { throw "找不到安装包：$installer" }
$installerItem = Get-Item $installer
if (-not $TaskName) { $TaskName = "DSH-$ExpectedVersion-真机验收-$RunId" }
if (-not $User) { $User = [Security.Principal.WindowsIdentity]::GetCurrent().Name }

# pwsh 绝对路径（计划任务里 PATH 可能不含 pwsh）
$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { throw '找不到 pwsh.exe' }

$argLine = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$supervisor`"",
  "-InstallerPath", "`"$installer`"",
  "-RunId", "`"$RunId`"",
  "-FreezeId", "`"$FreezeId`"",
  "-ExpectedVersion", "`"$ExpectedVersion`"",
  "-RepoRoot", "`"$RepoRoot`""
) -join ' '

$tr = "`"$pwsh`" $argLine"

Write-Host ''
Write-Host '══════════════════════════════════════════════════════════════════════'
Write-Host '  真机验收触发计划'
Write-Host '══════════════════════════════════════════════════════════════════════'
Write-Host ("  安装包        : {0}" -f $installer)
Write-Host ("  字节数        : {0}" -f $installerItem.Length)
Write-Host ("  SHA-256       : {0}" -f (Get-FileHash $installer -Algorithm SHA256).Hash)
Write-Host ("  守护脚本      : {0}" -f $supervisor)
Write-Host ("  计划任务名    : {0}" -f $TaskName)
Write-Host ("  运行身份      : {0}（/RL HIGHEST /IT：交互式会话 + 最高权限）" -f $User)
Write-Host ("  RunId         : {0}" -f $RunId)
Write-Host ("  冻结号        : {0}" -f $FreezeId)
Write-Host ''
Write-Host '  影响面        : 安装器会 taskkill 掉当前 DSH Desktop（含其 backend 与本目录下全部 agent 会话），'
Write-Host '                  窗口关闭约 2–4 分钟；守护脚本装完会自己把 0.3.48 拉起来。'
Write-Host '  预计耗时      : 安装 1–2 分钟 + 首启 30–60 秒 + 关托盘/托盘退出 30–60 秒 + 二次启动 30 秒 ≈ 4–6 分钟'
Write-Host ''
Write-Host '  将要执行的命令：'
Write-Host ("    schtasks /Create /TN `"{0}`" /TR `"{1}`" /SC ONCE /ST 23:59 /RL HIGHEST /RU `"{2}`" /IT /F" -f $TaskName, $tr, $User)
Write-Host ("    schtasks /Run /TN `"{0}`"" -f $TaskName)
Write-Host ''
Write-Host '  证据落点（中断后照样能读）：'
Write-Host '    修复与借鉴_2026-11-04\03_调试阶段\真机验收原始日志_<runId>.log'
Write-Host '    修复与借鉴_2026-11-04\03_调试阶段\真机验收原始记录_<runId>.json'
Write-Host '    修复与借鉴_2026-11-04\03_调试阶段\真机验收截图_<runId>\*.png'
Write-Host '    修复与借鉴_2026-11-04\03_调试阶段\资源监控_阶段一.csv'
Write-Host ''
Write-Host '  中断后的恢复方式：'
Write-Host '    1) 若守护脚本中途失败，直接手动启动："C:\Program Files\DSH Desktop\DSH Desktop.exe"'
Write-Host '    2) DSH 的会话保存在 %APPDATA%\DSH Desktop\dsh-home，重启后继续原会话即可'
Write-Host '    3) 排查：看上面的原始日志；任务是否在跑用 schtasks /Query /TN "<任务名>" /V /FO LIST'
Write-Host '══════════════════════════════════════════════════════════════════════'

if (-not $Go) {
  Write-Host ''
  Write-Host '  （未加 -Go：只打印计划，没有对系统做任何改动）'
  exit 0
}

Write-Host ''
Write-Host '  正在创建计划任务…'
$create = & schtasks /Create /TN $TaskName /TR $tr /SC ONCE /ST 23:59 /RL HIGHEST /RU $User /IT /F 2>&1
Write-Host ($create | Out-String)
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create 失败（exit=$LASTEXITCODE）" }

Write-Host '  正在立即运行计划任务（约 1 秒后本会话会被安装器结束，属预期）…'
Start-Sleep -Seconds 1
$run = & schtasks /Run /TN $TaskName 2>&1
Write-Host ($run | Out-String)
Write-Host ''
Write-Host '  已触发。接下来当前窗口会关闭；4–6 分钟后 0.3.48 会被自动拉起。'
Write-Host '  回到 DSH 后请查看上面「证据落点」里的文件确认结果。'
