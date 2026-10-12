@echo off
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node server.js
) else (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    "%ProgramFiles%\nodejs\node.exe" server.js
  ) else (
    echo Node.js was not found. Install Node.js LTS and try again.
  )
)
pause

