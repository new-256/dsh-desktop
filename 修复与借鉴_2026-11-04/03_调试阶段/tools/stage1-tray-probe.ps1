# stage1-tray-probe.ps1 —— 托盘交互可行性探针（非破坏性）
#
# 目的：真机验收里「关闭到托盘 → 从托盘退出」必须靠真实 UI 交互取证。
# 本探针只做三件事，**绝不点击任何菜单项**：
#   1) 通过 UIA 找到任务栏托盘的「通知」按钮并展开溢出区；
#   2) 在溢出区里定位 DSH Desktop 的托盘图标（拿 Rect → 右键打开菜单）；
#   3) 枚举菜单项名称（用于确认「退出」存在），然后 ESC 关闭菜单。
# 把每一步的原始 UIA 观察落盘，供正式验收脚本复用选择器。

param(
  [string]$OutDir = "$PSScriptRoot\..\..\03_调试阶段\tools-selftest",
  [string]$Match = 'DSH'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Stage1Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
}
"@

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$log = Join-Path $OutDir 'tray-probe.log'
function Log($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $m
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}

function Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $path = Join-Path $OutDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Log "截图已保存: $path"
  return $path
}

function RightClick([System.Windows.Rect]$r) {
  $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  Log "右键点击 坐标=($x,$y) 目标矩形=$($r.X),$($r.Y),$($r.Width)x$($r.Height)"
  [Stage1Mouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  [Stage1Mouse]::mouse_event([Stage1Mouse]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Stage1Mouse]::mouse_event([Stage1Mouse]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}

function LeftClick([System.Windows.Rect]$r) {
  $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  Log "左键点击 坐标=($x,$y)"
  [Stage1Mouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  [Stage1Mouse]::mouse_event([Stage1Mouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Stage1Mouse]::mouse_event([Stage1Mouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 600
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# ── 1. 找到任务栏与「通知」按钮 ──────────────────────────────────────────────
$tbCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
$tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $tbCond)
if ($null -eq $tb) { Log '✖ 未找到 Shell_TrayWnd（任务栏）'; exit 1 }
Log '✔ 找到任务栏 Shell_TrayWnd'

$all = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
Log ("任务栏内可见元素: " + $all.Count)
# 溢出区开关在不同 Windows 11 版本/状态下的 UIA 名字不同：
#   常态是「显示隐藏的图标」，有点击过/有通知时可能是「通知 N 个新通知」。
# 只按 "class=SystemTray.NormalButton 且 名字命中这三个关键词之一" 定位，避免写死单一样例。
$notifyBtn = $null
foreach ($e in $all) {
  try {
    $nm = $e.Current.Name
    $cls = $e.Current.ClassName
    if ($cls -eq 'SystemTray.NormalButton' -and $nm -match '显示隐藏的图标|通知|Notifications') {
      $notifyBtn = $e
      Log ("  找到溢出区开关: name='" + $nm + "' cls='" + $cls + "'")
      break
    }
  } catch { }
}
if ($null -eq $notifyBtn) {
  foreach ($e in $all) {
    try {
      if ($e.Current.Name -match '显示隐藏的图标|通知|Notifications') {
        $notifyBtn = $e
        Log ("  找到溢出区开关(宽松匹配): name='" + $e.Current.Name + "' cls='" + $e.Current.ClassName + "'")
        break
      }
    } catch { }
  }
}
if ($null -eq $notifyBtn) { Log '✖ 未找到溢出区开关，无法展开'; exit 1 }

$r = $notifyBtn.Current.BoundingRectangle
Log ("通知按钮矩形: {0},{1} {2}x{3}" -f $r.X, $r.Y, $r.Width, $r.Height)
LeftClick $r
Start-Sleep -Milliseconds 800
Shot 'probe-1-overflow-opened.png' | Out-Null

# ── 2. 在溢出区里找 DSH 图标 ────────────────────────────────────────────────
$candidates = @()
$topWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
Log ("顶层窗口数: " + $topWindows.Count)
foreach ($w in $topWindows) {
  try {
    $cls = $w.Current.ClassName
    $wn = $w.Current.Name
    if ($cls -match 'Overflow|NotifyIcon|XamlIsland|Tray|#32768|Popup') {
      Log ("  过渡窗口: cls='" + $cls + "' name='" + $wn + "'")
      $kids = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      Log ("    后代元素: " + $kids.Count)
      foreach ($k in $kids) {
        try {
          $kn = $k.Current.Name
          if ($kn -match $Match) { $candidates += $k; Log ("    命中: '" + $kn + "' " + $k.Current.ControlType.ProgrammaticName) }
        } catch { }
      }
    }
  } catch { }
}
# 有些系统把溢出图标直接挂到任务栏下，兜底再扫一遍任务栏子树
$tbAll = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($k in $tbAll) {
  try { if ($k.Current.Name -match $Match) { $candidates += $k } } catch { }
}
$candidates = $candidates | Where-Object { $_.Current.Name -match $Match } | Select-Object -Unique
Log ("匹配 '$Match' 的候选元素: " + @($candidates).Count)
foreach ($c in $candidates) {
  $cr = $c.Current.BoundingRectangle
  Log ("  候选: name='" + $c.Current.Name + "' type=" + $c.Current.ControlType.ProgrammaticName + " rect=" + $cr.X + "," + $cr.Y + " " + $cr.Width + "x" + $cr.Height)
}

if (@($candidates).Count -eq 0) {
  Log '✖ 溢出区未找到 DSH 托盘图标（可能被固定在任务栏托盘而非溢出区，或 UIA 未暴露）'
  # 关闭溢出区
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  exit 2
}

$icon = @($candidates)[0]
RightClick $icon.Current.BoundingRectangle
Shot 'probe-2-context-menu.png' | Out-Null

# ── 3. 枚举菜单项（只读，不点击）──────────────────────────────────────────────
$menuItems = @()
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  try {
    $cls = $w.Current.ClassName
    if ($cls -match 'Menu|Popup|#32768') {
      Log ("  菜单窗口: cls='" + $cls + "'")
      foreach ($m in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        try {
          if ($m.Current.ControlType.ProgrammaticName -match 'MenuItem' -or $m.Current.Name) {
            $menuItems += [pscustomobject]@{ Name = $m.Current.Name; Type = $m.Current.ControlType.ProgrammaticName; Class = $m.Current.ClassName }
          }
        } catch { }
      }
    }
  } catch { }
}
Log ("菜单项数量: " + @($menuItems).Count)
foreach ($mi in ($menuItems | Select-Object -Unique Name, Type)) { Log ("    · " + $mi.Type + " | " + $mi.Name) }

Log '按 ESC 关闭菜单（不点击任何项）'
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Shot 'probe-3-after-esc.png' | Out-Null
Log '探针结束（未执行任何破坏性操作）'
