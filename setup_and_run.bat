@echo off
setlocal enabledelayedexpansion
title Music Downloader + Player + Clasifyer - Automatic Installer
color 0A

:: ============================================================
:: SET WORKING DIRECTORY TO SCRIPT LOCATION
:: ============================================================
cd /d "%~dp0"

echo ========================================================
echo   Music Downloader + Player + Clasifyer - Automatic Installer
echo ========================================================
echo Working Directory: %CD%
echo.
echo.
echo This script will automatically install all required components:
echo   - Node.js (if missing)
echo   - Python (if missing)
echo   - FFmpeg (if missing)
echo   - yt-dlp (Python package)
echo   - npm dependencies
echo.
echo Press any key to continue or CTRL+C to cancel...
pause >nul

:: ============================================================
:: ADMIN CHECK
:: ============================================================
:: net session >nul 2>&1
:: if %errorlevel% neq 0 (
::     echo.
::     echo [WARNING] This installer requires Administrator privileges.
::     echo Please right-click and select "Run as administrator"
::     echo.
::     pause
::     exit /b 1
:: )
echo [DEBUG] Skipping Admin Check for debugging...

:: ============================================================
:: CREATE TEMP DIRECTORY
:: ============================================================
set "TEMP_DIR=%TEMP%\MP3PlayerInstall"
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"

:: ============================================================
:: INSTALL NODE.JS
:: ============================================================
echo.
echo [1/4] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js not found. Downloading latest LTS...
    
    :: Download Node.js installer
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.3/node-v20.18.3-x64.msi' -OutFile '%TEMP_DIR%\nodejs.msi'}"
    
    if exist "%TEMP_DIR%\nodejs.msi" (
        echo Installing Node.js silently...
        msiexec /i "%TEMP_DIR%\nodejs.msi" /qn /norestart
        
        :: Wait for installation
        timeout /t 10 /nobreak >nul
        
        :: Refresh PATH
        call :RefreshPath
        
        where node >nul 2>nul
        if !errorlevel! equ 0 (
            echo [OK] Node.js installed successfully.
        ) else (
            echo [ERROR] Node.js installation failed. Please install manually from https://nodejs.org/
            pause
            exit /b 1
        )
    ) else (
        echo [ERROR] Failed to download Node.js installer.
        pause
        exit /b 1
    )
) else (
    echo [OK] Node.js already installed.
)

:: ============================================================
:: INSTALL PYTHON
:: ============================================================
echo.
echo [2/4] Checking Python...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Python not found. Downloading Python 3.12...
    
    :: Download Python installer
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe' -OutFile '%TEMP_DIR%\python.exe'}"
    
    if exist "%TEMP_DIR%\python.exe" (
        echo Installing Python silently...
        "%TEMP_DIR%\python.exe" /quiet InstallAllUsers=1 PrependPath=1 Include_test=0
        
        :: Wait for installation
        timeout /t 15 /nobreak >nul
        
        :: Refresh PATH
        call :RefreshPath
        
        where python >nul 2>nul
        if !errorlevel! equ 0 (
            echo [OK] Python installed successfully.
        ) else (
            echo [ERROR] Python installation failed. Please install manually from https://www.python.org/
            pause
            exit /b 1
        )
    ) else (
        echo [ERROR] Failed to download Python installer.
        pause
        exit /b 1
    )
) else (
    echo [OK] Python already installed.
)

:: ============================================================
:: INSTALL FFMPEG
:: ============================================================
echo.
echo [3/4] Checking FFmpeg...
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo FFmpeg not found. Downloading FFmpeg...
    
    :: Download FFmpeg (using gyan.dev builds - most reliable)
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip' -OutFile '%TEMP_DIR%\ffmpeg.zip'}"
    
    if exist "%TEMP_DIR%\ffmpeg.zip" (
        echo Extracting FFmpeg...
        powershell -Command "Expand-Archive -Path '%TEMP_DIR%\ffmpeg.zip' -DestinationPath '%TEMP_DIR%' -Force"
        
        :: Find extracted directory
        for /d %%i in ("%TEMP_DIR%\ffmpeg-*") do set "FFMPEG_DIR=%%i"
        
        :: Copy to Program Files
        set "INSTALL_DIR=%ProgramFiles%\FFmpeg"
        if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
        
        xcopy "!FFMPEG_DIR!\bin\*" "%INSTALL_DIR%\" /E /I /Y >nul
        
        :: Add to PATH permanently
        powershell -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';%INSTALL_DIR%', 'Machine')"
        
        :: Refresh PATH
        call :RefreshPath
        
        where ffmpeg >nul 2>nul
        if !errorlevel! equ 0 (
            echo [OK] FFmpeg installed successfully.
        ) else (
            echo [WARNING] FFmpeg installed but not in PATH. Restart may be required.
        )
    ) else (
        echo [ERROR] Failed to download FFmpeg.
        pause
        exit /b 1
    )
) else (
    echo [OK] FFmpeg already installed.
)

:: ============================================================
:: INSTALL YT-DLP
:: ============================================================
echo.
echo [4/4] Installing yt-dlp...
call python -m pip install --upgrade pip >nul 2>&1
call python -m pip install -U yt-dlp
set YTDLP_EXIT=%ERRORLEVEL%
if %YTDLP_EXIT% equ 0 (
    echo [OK] yt-dlp installed successfully.
) else (
    echo [WARNING] yt-dlp installation had issues ^(exit code: %YTDLP_EXIT%^). Will retry on first run.
)
echo.

:: ============================================================
:: INSTALL NPM DEPENDENCIES
:: ============================================================
echo.
echo [5/5] Installing npm dependencies...
echo Current directory: %CD%
echo.

if not exist "package.json" (
    echo [ERROR] package.json not found in current directory!
    echo Please run this installer from the project root folder.
    pause
    exit /b 1
)

if exist "node_modules" goto :VerifyElectron

:NpmInstall
echo This may take a few minutes, please wait...
echo.
call npm install --verbose
if errorlevel 1 goto :NpmAlt
echo [OK] npm dependencies installed.
goto :VerifyElectron

:NpmAlt
echo [ERROR] Failed to install npm dependencies.
echo.
echo Trying alternative method...
echo.
call npm cache clean --force
call npm install --verbose --legacy-peer-deps
if errorlevel 1 (
    echo [ERROR] All installation methods failed.
    echo.
    echo Please try manually:
    echo   1. Open Command Prompt in this folder
    echo   2. Run: npm install
    echo.
    pause
    exit /b 1
)
echo [OK] npm dependencies installed (alternative method).

:VerifyElectron
:: Verify existing installation
if exist "node_modules\electron" (
    echo [VERIFY] Electron found in node_modules
) else (
    echo [WARNING] Electron not found - reinstalling...
    if exist "node_modules" rd /s /q "node_modules"
    goto :NpmInstall
)

:: ============================================================
:: CLEANUP
:: ============================================================
echo.
echo Cleaning up temporary files...
rd /s /q "%TEMP_DIR%" >nul 2>&1

:: ============================================================
:: CREATE DESKTOP SHORTCUT
:: ============================================================
echo.
echo Creating desktop shortcut...
set "SCRIPT_DIR=%~dp0"
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Music Downloader + Player + Clasifyer.lnk'); $s.TargetPath = '%SCRIPT_DIR%run.bat'; $s.WorkingDirectory = '%SCRIPT_DIR%'; if (Test-Path '%SCRIPT_DIR%app-icon.ico') { $s.IconLocation = '%SCRIPT_DIR%app-icon.ico' } elseif (Test-Path '%SCRIPT_DIR%App Icon.ico') { $s.IconLocation = '%SCRIPT_DIR%App Icon.ico' }; $s.Save()"

:: ============================================================
:: DONE
:: ============================================================
echo.
echo ========================================================
echo      Installation Complete!
echo ========================================================
echo.
echo All components have been installed successfully.
echo.
echo You can now run the app via the Desktop shortcut.
echo.
echo Launching the application now...
timeout /t 3 /nobreak >nul
start "" "run.bat"

exit /b 0

:: ============================================================
:: FUNCTION: Refresh PATH
:: ============================================================
:RefreshPath
set "SysPath="
set "UserPath="
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SysPath=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "UserPath=%%b"
if defined SysPath (
    if defined UserPath (
        set "PATH=!SysPath!;!UserPath!"
    ) else (
        set "PATH=!SysPath!"
    )
)
goto :eof
