@echo off
title Music Downloader + Player + Clasifyer - Launcher
cd /d "%~dp0"
echo Starting Music Downloader + Player + Clasifyer...
npm start
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start the application.
    echo Please make sure Node.js is installed and run 'npm install' if you haven't.
    pause
)
