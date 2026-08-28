; NSIS custom hooks for DSH Desktop
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
  DetailPrint "Terminating existing DSH Desktop processes and backend..."

  ; Kill shell process tree by image name (handles both current and legacy binary names).
  ; Note: Every nsExec::Exec MUST be immediately followed by Pop $0 to prevent stack leakage.
  nsExec::Exec 'taskkill /F /T /IM "DSH Desktop.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "dsh-desktop.exe"'
  Pop $0

  ; Kill orphaned bundled Node backend processes by matching executable path.
  ; The -like path filter ensures that unrelated node.exe processes on the user's system are NOT affected.
  ; PowerShell is used here because wmic was deprecated and removed in recent Windows 11 releases.
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command $\"Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -like $\'*\DSH Desktop\backend\node.exe$\' | Stop-Process -Force -ErrorAction SilentlyContinue$\"'
  Pop $0

  ; Kill leftovers still running out of the installation directory (orphans whose
  ; parent shell already died, so the /T tree kill above could not reach them).
  ; The -Name allowlist is mandatory, for two reasons:
  ;   1. Self-preservation. This macro also runs from customUnInit, and a directly
  ;      launched "Uninstall DSH Desktop.exe" lives in $INSTDIR itself; an
  ;      unrestricted "every process under $INSTDIR" sweep would terminate the
  ;      uninstaller mid-run. Neither "Uninstall DSH Desktop" nor the setup
  ;      executable is in the allowlist, so they always survive.
  ;   2. Enumerating every process just to read .Path is slow and noisy on
  ;      protected system processes.
  ; Tolerates empty $INSTDIR safely before invoking PowerShell path match.
  ${If} $INSTDIR != ""
    nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command $\"Get-Process -Name $\'DSH Desktop$\',$\'dsh-desktop$\',$\'elevate$\',$\'node$\' -ErrorAction SilentlyContinue | Where-Object Path -like $\'$INSTDIR\*$\' | Stop-Process -Force -ErrorAction SilentlyContinue$\"'
    Pop $0
  ${EndIf}

  ; Short sleep so Windows releases file handles
  Sleep 700
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
