@echo off
setlocal
cd /d "%~dp0"

set "APP_EXE=src-tauri\target\release\tauri-app.exe"

if not exist "%APP_EXE%" (
  echo [Media Vault] 릴리스 EXE가 없습니다.
  echo 먼저 build-release.bat 또는 npm run build:desktop 을 실행하세요.
  exit /b 1
)

echo [Media Vault] 릴리스 EXE를 실행합니다...
start "" "%APP_EXE%"

endlocal
