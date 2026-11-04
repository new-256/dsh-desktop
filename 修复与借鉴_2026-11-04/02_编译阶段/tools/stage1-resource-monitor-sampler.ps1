<#
  stage1-resource-monitor-sampler.ps1 —— 采样后端（由 stage1-resource-monitor.js 常驻拉起）。

  为什么要一个常驻进程而不是 Node 每次 spawn 一遍 PowerShell：
  采样间隔只有 2s，每次 spawn pwsh 冷启动 200~400ms，会自己污染被测负载的
  CPU 曲线。所以这里做成「stdin 命令驱动」的常驻采样器，Node 侧每条 sample
  只付一次 JSON 往返的代价。

  协议（一行一条命令，UTF-8）：
    filter <名称,名称>   设置进程名过滤器（不带 .exe 亦可，大小写不敏感）；空串=不过滤
    sample               立即输出一行 JSON 采样
    quit                 退出

  GPU 走 nvidia-smi；不可用时如实回 ok=false + 原因，绝不编造数字。
#>

$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:filters = @()
$script:nvidiaSmi = $null
$script:nvidiaChecked = $false

function Get-NvidiaSmiPath {
  if ($script:nvidiaChecked) { return $script:nvidiaSmi }
  $script:nvidiaChecked = $true
  $cmd = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if ($cmd) { $script:nvidiaSmi = $cmd.Source } else { $script:nvidiaSmi = $null }
  return $script:nvidiaSmi
}

function Get-GpuSample {
  $exe = Get-NvidiaSmiPath
  if (-not $exe) {
    return @{ ok = $false; reason = 'nvidia-smi 不可用（未在 PATH 中找到）' }
  }
  try {
    $raw = & $exe --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) {
      return @{ ok = $false; reason = "nvidia-smi 调用失败（exit $LASTEXITCODE）" }
    }
    # 多卡时只取第一张（本机为单卡 RTX 5060 Ti，记录时以实际输出为准）。
    $first = @($raw)[0]
    if ($first -isnot [string]) { $first = [string]$first }
    $p = $first -split '\s*,\s*'
    if ($p.Count -lt 4) { return @{ ok = $false; reason = "nvidia-smi 输出结构异常：$first" } }
    return @{
      ok = $true
      name = $p[0]
      util = [double]$p[1]
      memUsed = [double]$p[2]
      memTotal = [double]$p[3]
      tempC = if ($p.Count -ge 5) { [double]$p[4] } else { $null }
      gpuCount = @($raw).Count
    }
  } catch {
    return @{ ok = $false; reason = "nvidia-smi 异常：$($_.Exception.Message)" }
  }
}

function Get-SamplePayload {
  $all = @()
  try { $all = @(Get-Process -ErrorAction SilentlyContinue) } catch { $all = @() }

  $matched = New-Object System.Collections.ArrayList
  foreach ($p in $all) {
    if ($script:filters.Count -gt 0) {
      $hit = $false
      foreach ($f in $script:filters) {
        if ($p.ProcessName -ieq $f) { $hit = $true; break }
      }
      if (-not $hit) { continue }
    }
    [void]$matched.Add($p)
  }

  $ws = [double]0; $pb = [double]0; $cpu = [double]0
  $top = New-Object System.Collections.ArrayList
  foreach ($p in $matched) {
    try {
      $ws += [double]$p.WorkingSet64
      $pb += [double]$p.PrivateMemorySize64
      if ($null -ne $p.CPU) { $cpu += [double]$p.CPU }
      [void]$top.Add([pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; ws = [double]$p.WorkingSet64 })
    } catch { continue }
  }

  $topList = @($top | Sort-Object -Property ws -Descending | Select-Object -First 12)

  $sysTotal = [double]0; $sysAvail = [double]0
  try {
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $sysTotal = [double]$os.TotalVisibleMemorySize * 1024
    $sysAvail = [double]$os.FreePhysicalMemory * 1024
  } catch { }

  return [ordered]@{
    ts = (Get-Date).ToString('o')
    filter = ($script:filters -join ',')
    procCount = $matched.Count
    procWs = $ws
    procPb = $pb
    procCpuSec = [math]::Round($cpu, 3)
    sysTotal = $sysTotal
    sysAvail = $sysAvail
    top = $topList
    gpu = (Get-GpuSample)
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '' ) { continue }

  if ($line -eq 'quit') { break }

  if ($line -like 'filter *') {
    $spec = $line.Substring(7).Trim()
    $script:filters = @()
    if ($spec -ne '') {
      foreach ($n in ($spec -split ',')) {
        $t = $n.Trim()
        if ($t -eq '') { continue }
        $script:filters += ($t -replace '\.exe$', '')
      }
    }
    Write-Output ('{"ack":"filter","filters":"' + ($script:filters -join ',') + '"}')
    continue
  }

  if ($line -eq 'sample') {
    $payload = Get-SamplePayload
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 4)
    continue
  }

  Write-Output ('{"error":"unknown command","line":"' + ($line -replace '"', "'") + '"}')
}
