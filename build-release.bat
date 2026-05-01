@echo off
setlocal
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo [MViewer] 由대━??鍮뚮뱶瑜??쒖옉?⑸땲??..
call npm.cmd run build:desktop
if errorlevel 1 (
  echo.
  echo [MViewer] 鍮뚮뱶???ㅽ뙣?덉뒿?덈떎.
  exit /b 1
)

echo.
echo [MViewer] 鍮뚮뱶媛 ?꾨즺?섏뿀?듬땲??
echo EXE: src-tauri\target\release\tauri-app.exe
echo ?ㅼ튂 ?뚯씪: src-tauri\target\release\bundle\

endlocal
