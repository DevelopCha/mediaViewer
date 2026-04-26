@echo off
setlocal
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo [Media Vault] 릴리스 빌드를 시작합니다...
call npm.cmd run build:desktop
if errorlevel 1 (
  echo.
  echo [Media Vault] 빌드에 실패했습니다.
  exit /b 1
)

echo.
echo [Media Vault] 빌드가 완료되었습니다.
echo EXE: src-tauri\target\release\tauri-app.exe
echo 설치 파일: src-tauri\target\release\bundle\

endlocal
