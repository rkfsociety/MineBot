@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
  echo npm не найден. Установите Node.js LTS: https://nodejs.org
  echo После установки снова запустите этот файл.
  exit /b 1
)
call npm install
exit /b %ERRORLEVEL%
