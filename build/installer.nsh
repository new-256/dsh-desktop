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
      Goto _dsh_check_running_loop
    ${EndIf}

    ; If shell process genuinely survives all retries, prompt user with Retry/Cancel dialog
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY _dsh_check_running_retry
    Quit

  _dsh_check_running_retry:
    !insertmacro DshTerminateAll
    StrCpy $R1 0
    Goto _dsh_check_running_loop

  _dsh_check_running_done:
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
