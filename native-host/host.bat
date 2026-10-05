@echo off
rem webai-hands host launcher (Windows, spawned by Chrome).
rem Prefers the interpreter from the install dir's .venv,
rem falls back to the system Python py launcher.
set "VENV_PY=%~dp0.venv\Scripts\python.exe"
if exist "%VENV_PY%" (
  "%VENV_PY%" "%~dp0host.py" %*
) else (
  py -3 "%~dp0host.py" %*
)
