!macro customInstall
  ; Install the bundled C++ runtime automatically when Windows does not have it.
  ; 0 = success; 1638 = newer runtime present; 3010 = success, reboot requested.
  DetailPrint "Preparing Cobble's local voice runtime..."
  ExecWait '"$INSTDIR\resources\redist\vc_redist.x64.exe" /install /quiet /norestart' $0
  ${If} $0 != 0
  ${AndIf} $0 != 1638
  ${AndIf} $0 != 3010
    MessageBox MB_OK|MB_ICONSTOP "Windows could not prepare the included voice runtime (code $0). Installation cannot continue."
    Abort
  ${EndIf}
  ${If} $0 == 3010
    SetRebootFlag true
  ${EndIf}
!macroend
