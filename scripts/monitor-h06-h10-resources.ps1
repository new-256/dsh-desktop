# H-06 / H-10 验证期硬件资源监控（用户硬规则：测试必须同步监控 CPU/内存/GPU/显存）
#
# 为什么存在：本阶段验证涉及 5 万行日志压力注入与 Electron 真机渲染，必须同步记录
# CPU、内存、GPU 利用率与显存占用，作为「测试是否把机器打满/是否触发降级」的证据。
#
# 用法（独立进程运行，主测试进程与它并行）：
#   pwsh -NoProfile -File scripts/monitor-h06-h10-resources.ps1 -Out <csv> -IntervalSec 2 -StopFile <文件>
# 停止：创建 -StopFile 指向的文件即退出并打印汇总。

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$IntervalSec = 2,
  [Parameter(Mandatory = $true)][string]$StopFile
)

$ErrorActionPreference = 'Continue'
$parent = Split-Path -Parent $Out
if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

$hasNvidiaSmi = $false
try { $null = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null; $hasNvidiaSmi = ($LASTEXITCODE -eq 0) } catch { $hasNvidiaSmi = $false }

"timestamp,gpuAvailable,cpuPercent,memUsedMB,memTotalMB,memPercent,procCount,procWorkingSetMB,procCpuSecondsMax,gpuUtilPercent,gpuMemUsedMB,gpuMemTotalMB" |
  Set-Content -Path $Out -Encoding utf8

$maxCpu = 0.0; $maxMemPct = 0.0; $maxGpu = 0.0; $maxGpuMem = 0.0; $samples = 0

while (-not (Test-Path $StopFile)) {
  $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  $cpu = $null
  try {
    $total = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop |
      Where-Object { $_.Name -eq '_Total' }
    if ($total) { $cpu = [double]$total.PercentProcessorTime }
  } catch { $cpu = $null }

  $memUsedMB = $null; $memTotalMB = $null; $memPct = $null
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $memTotalMB = [math]::Round($os.TotalVisibleMemorySize / 1024, 0)
    $memUsedMB = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1024, 0)
    if ($memTotalMB -gt 0) { $memPct = [math]::Round(100 * $memUsedMB / $memTotalMB, 1) }
  } catch { }

  $procs = @()
  try { $procs = @(Get-Process -Name node, electron -ErrorAction SilentlyContinue) } catch { }
  $procCount = $procs.Count
  $procWsMB = [math]::Round((($procs | Measure-Object -Property WorkingSet64 -Sum).Sum) / 1MB, 0)
  $procCpuMax = 0.0
  if ($procs.Count -gt 0) { $procCpuMax = [math]::Round((($procs | Measure-Object -Property CPU -Maximum).Maximum), 1) }

  $gpuUtil = $null; $gpuMemUsed = $null; $gpuMemTotal = $null
  if ($hasNvidiaSmi) {
    try {
      $q = & nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>$null
      if ($LASTEXITCODE -eq 0 -and $q) {
        $parts = ($q | Select-Object -First 1).Split(',')
        if ($parts.Count -ge 3) {
          $gpuUtil = [double]$parts[0].Trim()
          $gpuMemUsed = [double]$parts[1].Trim()
          $gpuMemTotal = [double]$parts[2].Trim()
        }
      }
    } catch { }
  }

  "{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11}" -f $ts, $hasNvidiaSmi, $cpu, $memUsedMB, $memTotalMB, $memPct,
    $procCount, $procWsMB, $procCpuMax, $gpuUtil, $gpuMemUsed, $gpuMemTotal | Add-Content -Path $Out -Encoding utf8

  if ($cpu -ne $null -and [double]$cpu -gt $maxCpu) { $maxCpu = [double]$cpu }
  if ($memPct -ne $null -and [double]$memPct -gt $maxMemPct) { $maxMemPct = [double]$memPct }
  if ($gpuUtil -ne $null -and [double]$gpuUtil -gt $maxGpu) { $maxGpu = [double]$gpuUtil }
  if ($gpuMemUsed -ne $null -and [double]$gpuMemUsed -gt $maxGpuMem) { $maxGpuMem = [double]$gpuMemUsed }
  $samples++

  Start-Sleep -Seconds $IntervalSec
}

"=== 监控汇总 ===" 
"样本数: $samples  间隔: ${IntervalSec}s"
"CPU 峰值: $maxCpu %"
"内存占用峰值: $maxMemPct %"
if ($hasNvidiaSmi) { "GPU 利用率峰值: $maxGpu %  显存峰值: $maxGpuMem MB" } else { "GPU: nvidia-smi 不可用（未探测到 NVIDIA 设备）" }
