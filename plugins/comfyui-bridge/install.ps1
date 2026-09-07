# dsh-comfyui-bridge 本地接线脚本（幂等）
#
# 用途：为本地开发形态（本目录即源码）重建包解析所需的 junction，
#       并检查家级补丁层是否有本插件的行。
# 何时跑：DSH Desktop 因后端启动失败把 profiles 目录隔离重建之后（junction 会丢），
#         或手工迁移 dsh-home / 克隆本仓库之后。
#
# 三种安装方式（按需选一）：
#   A. npm 注册表（发布后）：dsh plugin --profile web add dsh-comfyui-bridge
#   B. 本地路径 + dsh CLI：  dsh plugin --profile web add <本目录绝对路径>
#      （A/B 走官方 bundle 流程：package.json 的 dsh.bundle.patch 自动挂载，
#        无需本脚本、无需手写补丁行）
#   C. 本脚本（junction 直连，源码改动即时生效）：pwsh -File install.ps1
#      （本脚本只做接线；行的挂载走用户层补丁，见下方检查项）
#
# 用法：pwsh -File install.ps1              # 用默认 DSH_HOME
#      pwsh -File install.ps1 -DshHome "C:\path\to\dsh-home"

[CmdletBinding()]
param(
	[string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { "C:\Users\$env:USERNAME\AppData\Roaming\DSH Desktop\dsh-home" })
)

$ErrorActionPreference = 'Stop'
$pkgDir = $PSScriptRoot
$pkgName = 'dsh-comfyui-bridge'

if (-not (Test-Path (Join-Path $pkgDir 'package.json'))) { throw "找不到 $pkgDir\package.json —— 请在插件目录内运行本脚本。" }
if (-not (Test-Path $DshHome)) { throw "DSH_HOME 不存在：$DshHome" }
Write-Host "包目录 : $pkgDir"
Write-Host "DSH_HOME: $DshHome`n"

# 三处 junction：家级补丁行必需第一处，其余两处为 profile 层兜底。
$targets = @(
	(Join-Path $DshHome "node_modules\$pkgName"),
	(Join-Path $DshHome "profiles\node_modules\$pkgName"),
	(Join-Path $DshHome "profiles\web\node_modules\$pkgName")
)
foreach ($link in $targets) {
	$parent = Split-Path $link -Parent
	if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
	if (Test-Path (Join-Path $link 'package.json')) {
		Write-Host "OK   已存在  $link"
		continue
	}
	if (Test-Path $link) { Remove-Item $link -Force -Recurse }   # 残留的坏链
	New-Item -ItemType Junction -Path $link -Target $pkgDir | Out-Null
	Write-Host "NEW  已创建  $link"
}

# 家级补丁行检查（裸包名形式，靠上面第一处 junction 解析）
$patch = Join-Path $DshHome 'cordis.patch.yml'
Write-Host ''
if ((Test-Path $patch) -and ((Get-Content $patch -Raw) -match [regex]::Escape($pkgName))) {
	Write-Host "OK   家级补丁层已有 $pkgName 的行：$patch"
} else {
	Write-Warning "家级补丁层缺少 $pkgName 的行，请在 $patch 末尾追加："
	Write-Host @"

- insert:
    - id: comfyui-bridge
      name: $pkgName
      config:
        baseUrl: http://127.0.0.1:8188
        outputsDir: comfyui-outputs
        defaultTimeoutSec: 1800
        pollIntervalMs: 2000
        # 可选：显式指定模型库根目录（缺省自动发现）
        # modelsDir: D:/ComfyUI/ComfyUI-aki-v3/ComfyUI/models

"@ -ForegroundColor Cyan
	Write-Host "追加后重启 DSH Desktop 生效。机器特定配置（modelsDir 等）写在这行里，会整体覆盖 bundle 层默认。"
}
