@echo off
setlocal
chcp 65001 >nul 2>nul
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found.
  echo         Install Python from https://python.org first, then run this again.
  pause
  exit /b 1
)
echo ============================================
echo   merge-reader merge wizard  (Python)
echo ============================================
echo.
python "%~dp0merge-reader.py" %*
echo.
echo Done. Press any key to close this window.
pause >nul
