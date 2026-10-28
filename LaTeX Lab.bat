@echo off
rem Double-click to start LaTeX Lab. You can also drag a project folder onto this file.
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m latexlab %*
  goto :end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python -m latexlab %*
  goto :end
)

echo.
echo   Python 3 was not found.
echo   Install it with:   winget install -e --id Python.Python.3.12
echo   (or from https://www.python.org/downloads/ ), then double-click this file again.
echo.
pause

:end
if errorlevel 1 pause
endlocal
