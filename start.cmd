@echo off
setlocal
title Stronghold-Luck
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node 22 or newer, then run this again.
  pause
  exit /b 1
)
rem Dragging the game folder onto this .cmd passes it as %1. A leading "-" means it is a flag instead.
set "FIRST=%~1"
if not defined FIRST goto :run
if "%FIRST:~0,1%"=="-" goto :run
node src\launcher.mjs --game "%~1"
goto :done
:run
node src\launcher.mjs %*
:done
pause
