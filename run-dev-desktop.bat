@echo off
setlocal
cd /d "%~dp0"

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo [MViewer] Tauri 媛쒕컻 紐⑤뱶濡??ㅽ뻾?⑸땲??..
call npm.cmd run dev:desktop

endlocal
