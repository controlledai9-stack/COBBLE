@echo off
cd /d "%~dp0"
echo Starting Cobble Web Server (http://127.0.0.1:5174)...
npm run dev:web -- %*
