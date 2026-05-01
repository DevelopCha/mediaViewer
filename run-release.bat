@echo off
setlocal
cd /d "%~dp0"

set "APP_EXE=src-tauri\target\release\tauri-app.exe"

if not exist "%APP_EXE%" (
  echo [MViewer] 由대━??EXE媛 ?놁뒿?덈떎.
  echo 癒쇱? build-release.bat ?먮뒗 npm run build:desktop ???ㅽ뻾?섏꽭??
  exit /b 1
)

echo [MViewer] 由대━??EXE瑜??ㅽ뻾?⑸땲??..
start "" "%APP_EXE%"

endlocal
