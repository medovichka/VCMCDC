@echo off
chcp 65001 >nul
setlocal
title Modpack Builder

rem Modpack Builder launcher (Windows).
rem ASCII only on purpose: cmd.exe reads .bat files in the OEM codepage,
rem and CRLF line endings are required for correct parsing.

set "ROOT=%~dp0"
set "APP=%ROOT%app.py"
set "VENV_PY=%ROOT%.venv\Scripts\python.exe"

if not exist "%APP%" (
    echo [!] app.py not found next to this file: "%APP%"
    pause
    exit /b 1
)

if exist "%VENV_PY%" goto run_venv

echo [!] Virtual environment not found:
echo     "%VENV_PY%"
echo [i] Falling back to the system Python.
where py >nul 2>nul
if not errorlevel 1 goto run_py
goto run_python

:run_venv
"%VENV_PY%" "%APP%" %*
goto check

:run_py
py -3 "%APP%" %*
goto check

:run_python
python "%APP%" %*

:check
if errorlevel 1 (
    echo.
    echo [!] The app exited with an error - read the messages above.
    echo [i] If it mentions "No module named requests", install dependencies:
    echo     python -m venv .venv
    echo     .venv\Scripts\pip install -r requirements.txt
    pause
)
endlocal
