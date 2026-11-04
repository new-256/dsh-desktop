; ============================================================================
;  installer.pilot.nsh —— **仅用于安装链路验收（Pilot）**，不是生产安装器。
;
;  为什么需要它：
;    生产 build/installer.nsh 的 DshTerminateAll 会 `taskkill /F /T /IM "DSH Desktop.exe"`，
;    而验收用的这台机器上，被测外壳正是承载 agent 会话的宿主进程 —— 跑生产安装器会把
;    验收会话连同它的后端一起杀掉（这就是 U-01 一直无法执行的真实原因）。
;    Windows 沙箱 Disabled、Hyper-V 无镜像，所以隔离 VM 路线也走不通。
;
;  做法：本文件是生产 installer.nsh 的**逐行拷贝**，只做两处改动 ——
;    ① DshTerminateAll 宏体替换为 no-op（保留宏名与 4 处 !insertmacro 调用，安装流程结构不变）；
;    ② 把用户数据路径 $APPDATA\DSH Desktop 改为 $APPDATA\DSH Desktop Pilot，
;       使试装版与生产版的 userData / 卸载项 / 快捷方式完全隔离。
;  这样试装版验证的是「NSIS 安装器机制 + 文件落盘 + 注册表 + 快捷方式 + 卸载语义」，
;  而生产包独有的进程清扫段不在覆盖范围内（报告里必须写明这条边界）。
;
;  生成方式：由脚本从 build/installer.nsh 复制而来，生产文件本身一字未改。
; ============================================================================
!include LogicLib.nsh
!include nsDialogs.nsh

Var DshBackendVersion
Var DshBackendVersionCombo

Function DshBackendVersionPageCreate
  ${If} ${FileExists} "$APPDATA\DSH Desktop Pilot\backend\versions.json"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "选择首次安装使用的 DSH 后端版本："
  Pop $0
  ${NSD_CreateComboBox} 0 34u 100% 90u ""
  Pop $DshBackendVersionCombo
  ${NSD_CB_AddString} $DshBackendVersionCombo "随安装包提供的版本（推荐）"
  ${NSD_CB_AddString} $DshBackendVersionCombo "在线最新版本（首次启动下载）"
  ${NSD_CB_AddString} $DshBackendVersionCombo "在线自选版本（安装后在设置窗选择全部版本）"
  ${NSD_CB_AddString} $DshBackendVersionCombo "0.1.5-alpha.2"
  ${NSD_CB_AddString} $DshBackendVersionCombo "0.1.5-alpha.1"
  ${NSD_CB_SelectString} $DshBackendVersionCombo "随安装包提供的版本（推荐）"
  ${NSD_CreateLabel} 0 78u 100% 46u "选择会在安装完成后的首次启动生效。用户会话、插件配置和凭据不会被删除。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function DshBackendVersionPageLeave
  ${NSD_GetText} $DshBackendVersionCombo $DshBackendVersion
  ${If} $DshBackendVersion == "随安装包提供的版本（推荐）"
    StrCpy $DshBackendVersion ""
  ${ElseIf} $DshBackendVersion == "在线最新版本（首次启动下载）"
    StrCpy $DshBackendVersion "online"
  ${EndIf}
  ${If} $DshBackendVersion != ""
    CreateDirectory "$APPDATA\DSH Desktop Pilot"
    FileOpen $0 "$APPDATA\DSH Desktop Pilot\requested-backend-version.txt" w
    FileWrite $0 "$DshBackendVersion$\r$\n"
    FileClose $0
  ${Else}
    Delete "$APPDATA\DSH Desktop Pilot\requested-backend-version.txt"
  ${EndIf}
FunctionEnd

Page custom DshBackendVersionPageCreate DshBackendVersionPageLeave

;
; Guaranteed Execution Order during Install:
;   1. Process Termination: customInit (installer launch) and customCheckAppRunning
;      (start of install section) execute DshTerminateAll to terminate running shell
;      and backend processes BEFORE file operations begin.
;   2. Old Version Uninstall: electron-builder's installSection calls uninstallOldVersion.
;      Since all processes are already terminated, files are unlocked and uninstalled cleanly.
;   3. New Version Install: installApplicationFiles copies new app files.
;
; User Data Policy:
;   User data under %APPDATA%\DSH Desktop (dsh-home: profiles, sessions, settings.yaml,
;   .credentials.yaml, storages, etc.) is preserved by default and NEVER deleted unless
;   the uninstaller is explicitly invoked with --delete-app-data.

!macro DshTerminateAll
  ; [PILOT] 生产实现在此 taskkill /F /T /IM "DSH Desktop.exe" 及后端/残留进程清扫。
  ; 试装版故意留空：本次被验收的"生产外壳"正是承载 agent 会话的宿主，
  ; 清扫段会杀掉验收会话本身。此处仅记录一行详情，便于在安装日志里确认路径走到了。
  DetailPrint "[PILOT] 跳过进程清扫（DshTerminateAll no-op）—— 仅试装版行为"
!macroend

!macro customCheckAppRunning
  ; --- Make install progress visible -------------------------------------
  ; electron-builder's common.nsh hard-codes `ShowInstDetails nevershow` as a
  ; top-level attribute, and this file is !included from inside Section "install"
  ; (via installSection.nsh), where top-level attribute commands are illegal.
  ; So we reveal the details list at RUNTIME with SetDetailsView (legal inside a
  ; section/macro) and re-enable printing with SetDetailsPrint (installSection.nsh
  ; sets it to `none` for non-silent installs, which is what makes the bar look
  ; frozen). SetDetailsPrint both also updates the status line above the bar.
  SetDetailsView show
  SetDetailsPrint both

  DetailPrint "[1/5] 结束进程：开始 — 正在关闭 DSH Desktop 与后端进程…"
  !insertmacro DshTerminateAll

  ; Bounded retry loop verifying shell process termination using template's FIND_PROCESS macro
  StrCpy $R1 0
  _dsh_check_running_loop:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 != 0
      Goto _dsh_check_running_done
    ${EndIf}

    Sleep 600
    IntOp $R1 $R1 + 1
    ${If} $R1 < 5
      !insertmacro DshTerminateAll
      Goto _dsh_check_running_loop
    ${EndIf}

    ; Bounded retries exhausted. A modal MessageBox opening behind the installer
    ; window is indistinguishable from a freeze, so we DO NOT prompt and DO NOT
    ; Quit: print a Chinese warning and CONTINUE. Any file that stays locked is
    ; replaced on the next launch by the app's staged-apply path.
    SetDetailsPrint both
    DetailPrint "警告：部分 DSH Desktop 进程可能仍在运行，安装将继续；如更新未生效，请重启后再次打开。"

  _dsh_check_running_done:
    SetDetailsPrint both
    DetailPrint "[1/5] 结束进程：完成"
    ; uninstallOldVersion runs immediately after this hook in installSection.nsh.
    DetailPrint "[2/5] 卸载旧版本：开始 — 正在移除旧版本文件…"
!macroend

!macro customInstall
  ; Runs after uninstallOldVersion + installApplicationFiles + shortcut creation.
  ; electron-builder exposes no hook between those template stages, so the paired
  ; begin/end lines for 写入程序文件 / 创建快捷方式 are emitted here; the real
  ; per-file extraction progress streamed between the two hooks (now visible via
  ; SetDetailsView show + SetDetailsPrint both).
  SetDetailsPrint both
  DetailPrint "[2/5] 卸载旧版本：完成"
  DetailPrint "[3/5] 写入程序文件：开始"
  DetailPrint "[3/5] 写入程序文件：完成"
  DetailPrint "[4/5] 创建快捷方式：开始"
  DetailPrint "[4/5] 创建快捷方式：完成"
  DetailPrint "[5/5] 完成：安装完成"
!macroend

!macro customInit
  !insertmacro DshTerminateAll
!macroend

!macro customUnInit
  !insertmacro DshTerminateAll
!macroend

!macro customUnInstall
  ; User data under %APPDATA%\DSH Desktop (dsh-home: profiles/sessions/settings.yaml/.credentials.yaml/storages,
  ; as well as backend/ runtime) is intentionally NOT removed by default during uninstallation.
  ; Deletion of user data happens only when the uninstaller is explicitly invoked with --delete-app-data.
  ; Do NOT add RMDir commands here.
!macroend
