@echo off
cd /d "%~dp0"
echo === engine check ===
node test\verify.mjs
echo === end-to-end check ===
node test\verify-e2e.mjs
echo === browser check ===
node test\verify-ui.mjs
pause
