@echo off
title AI Teams Node Agent
cd /d "%~dp0.."
node dist\src\node\agent.js --config config\node.json
echo.
echo AI Teams node agent exited. Press any key to close this window.
pause >nul
