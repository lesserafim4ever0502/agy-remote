@echo off
title Agy Remote
cd /d "%~dp0\.."
echo Starting Agy Remote Bridge...
node apps/bridge/src/server.js
pause
