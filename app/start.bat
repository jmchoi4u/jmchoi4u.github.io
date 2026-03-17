@echo off
title JM Blog Editor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    pause
    exit /b 1
)

echo Starting blog editor...
echo Browser will open automatically. Close this window to stop the server.
echo.
node server.mjs
if errorlevel 1 (
    echo.
    echo [ERROR] Server exited with an error.
    pause
)
exit /b
