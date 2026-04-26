@echo off
setlocal
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo [Media Vault] Tauri 개발 모드로 실행합니다...
call npm.cmd run dev:desktop

endlocal
