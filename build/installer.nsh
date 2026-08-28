; NSIS custom hooks — reliability: always close a running instance (and its
; whole process tree, which includes the bundled Node backend) before
; installing/uninstalling, so the installer never stalls on "无法关闭".
; nsExec::Exec runs taskkill without a console window; non-zero return
; (process not running) is harmless and ignored.

!macro KillRunningApp
  nsExec::Exec 'taskkill /F /IM "DSH Desktop.exe" /T'
  nsExec::Exec 'taskkill /F /IM "dsh-desktop.exe" /T'
  Pop $0
  Sleep 700
!macroend

!macro customInit
  !insertmacro KillRunningApp
!macroend

!macro customUnInit
  !insertmacro KillRunningApp
!macroend
