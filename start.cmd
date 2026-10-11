@echo off
title Stronghold-Luck
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 22 or newer, then run this again.
  pause
  exit /b 1
)
node src\launcher.mjs %*
pause
