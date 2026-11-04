<#
  b05-tray-open-settings.ps1 —— 通过**真实托盘菜单**打开设置窗（B-05 真机证据）。

  为什么不用别的手段：
    · 设置窗只能从托盘菜单（或它自己的 IPC）打开，这是**用户唯一真实路径**；
    · 用开发注入/后门打开会绕开"托盘入口 + 菜单可用"这条验收项。

  做法（复用 stage1-tray-probe.ps1 已验证过的 UIA 选择器）：
    1) 展开任务栏托盘溢出区；
    2) 找到名字含 DSH 的托盘图标（拿 Rect）；
    3) 右键 → 枚举弹出菜单 → 找到名字含「设置」的项 → 左键点击；
    4) 只做这一件事，不点别的项；失败时如实返回非 0 并打印原因。

  输出：每一步一行日志到 stdout，供调用方（Node 驱动器）记录。
#>
param([int]$IconIndex = 0, [switch]$ListOnly)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class B05Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
}
"@

function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $m) }

function ClickAt([System.Windows.Rect]$r, [bool]$right) {
  $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  Log ("{0}键点击 坐标=({1},{2})" -f $(if ($right) { '右' } else { '左' }), $x, $y)
  [B05Mouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  if ($right) {
    [B05Mouse]::mouse_event([B05Mouse]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [B05Mouse]::mouse_event([B05Mouse]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    [B05Mouse]::mouse_event([B05Mouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [B05Mouse]::mouse_event([B05Mouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 600
}

$root = [System.Windows.Automation.AutomationElement]::RootElement

# ── 1. 任务栏 + 溢出区开关 ───────────────────────────────────────────────────
$tbCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
$tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $tbCond)
if ($null -eq $tb) { Log '✖ 未找到 Shell_TrayWnd（任务栏）'; exit 1 }

$all = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$notifyBtn = $null
foreach ($e in $all) {
  try {
    if ($e.Current.ClassName -eq 'SystemTray.NormalButton' -and $e.Current.Name -match '显示隐藏的图标|通知|Notifications') { $notifyBtn = $e; break }
  } catch { }
}
if ($null -eq $notifyBtn) {
  foreach ($e in $all) {
    try { if ($e.Current.Name -match '显示隐藏的图标|通知|Notifications') { $notifyBtn = $e; break } } catch { }
  }
}
if ($null -eq $notifyBtn) { Log '✖ 未找到溢出区开关'; exit 1 }
ClickAt $notifyBtn.Current.BoundingRectangle $false
Start-Sleep -Milliseconds 800

# ── 2. 在溢出区里找 DSH 图标 ─────────────────────────────────────────────────
$dshIcons = @()
$dshIcon = $null
foreach ($scopeRoot in @($root, $tb)) {
  try {
    $descs = $scopeRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $descs) {
      try {
        $nm = "$($e.Current.Name) $($e.Current.HelpText)"
        if ($nm -match 'DSH') {
          $r = $e.Current.BoundingRectangle
          if ($r.Width -gt 0 -and $r.Height -gt 0) { $dshIcons += $e }
        }
      } catch { }
    }
  } catch { }
}
if ($dshIcons.Count -eq 0) { Log '✖ 溢出区里没找到 DSH 托盘图标'; exit 1 }
Log ('DSH 托盘图标数量：' + $dshIcons.Count)
if ($ListOnly) { exit 0 }
if ($IconIndex -ge $dshIcons.Count) { Log ('✖ 请求的图标序号 ' + $IconIndex + ' 超出实际数量 ' + $dshIcons.Count); exit 2 }
$dshIcon = $dshIcons[$IconIndex]
Log ("✔ 找到 DSH 托盘图标：name='" + $dshIcon.Current.Name + "'")
ClickAt $dshIcon.Current.BoundingRectangle $true
Start-Sleep -Milliseconds 700

# ── 3. 枚举弹出菜单，点「设置」────────────────────────────────────────────
$settingsItem = $null
$menuNames = @()
try {
  $every = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $every) {
    try {
      if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.MenuItem') { continue }
      $nm = $e.Current.Name
      if (-not $nm) { continue }
      $menuNames += $nm
      if ($nm -match '设置') { $settingsItem = $e; break }
    } catch { }
  }
} catch { }
Log ('菜单项：' + (($menuNames | Select-Object -Unique) -join ' | '))
if ($null -eq $settingsItem) { Log '✖ 弹出菜单里没有「设置」项'; exit 1 }
ClickAt $settingsItem.Current.BoundingRectangle $false
Log '✔ 已点击「设置…」'
exit 0
