@echo off
set NODE_OPTIONS=--experimental-sqlite
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" server/index.mjs
