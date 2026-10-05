@echo off
rem webai-hands host installer (Windows): double-click to run once.
cd /d %~dp0
py -3 install.py
if errorlevel 1 python install.py
echo.
pause
