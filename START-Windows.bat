@echo off
cd /d "%~dp0"
title PRE-AUDIT OS
REM Extra memory headroom so large Excel/ledger imports never crash the server.
set NODE_OPTIONS=--max-old-space-size=4096
echo ============================================
echo            PRE-AUDIT OS
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found.
  echo     Please install Node.js version 22 or newer from:
  echo     https://nodejs.org
  echo     Then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] Installing components for the first time. Please wait ~2 minutes...
  call npm install
  if errorlevel 1 (
    echo [X] Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist "data\dev.db" (
  echo [2/3] Creating the first admin account...
  call npm run db:seed
)

echo [3/3] Building. Please wait...
call npm run build
if errorlevel 1 (
  echo [X] Build failed.
  pause
  exit /b 1
)

echo.
echo Starting the system... the browser will open automatically in a few seconds.
echo ============================================
echo  Address:   http://localhost:3000
echo  Login:     admin@company.local
echo  Password:  ChangeMe123!
echo  (Keep this window open. Close it to stop.)
echo ============================================

REM open the browser AFTER the server has had time to start (10s), in a separate window
start "" cmd /c "timeout /t 10 /nobreak >nul & start "" http://localhost:3000"

call npm start
pause
