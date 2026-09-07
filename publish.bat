@echo off
setlocal enabledelayedexpansion

:: Navigate to script directory automatically
cd /d "%~dp0"

echo ====================================
echo   Antigravity Project Publisher
echo ====================================
echo.

:: 1. Check Git Repository
git rev-parse --is-inside-work-tree >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] This directory is not a valid Git repository.
    exit /b 1
)

:: Get current active branch
for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%b

if "%BRANCH%"=="" (
    echo [ERROR] Could not determine current Git branch.
    exit /b 1
)

echo [INFO] Repository verified. Active branch: %BRANCH%
echo.

:: 2. Check Git Status & Show Summary of Files
echo Status of project files:
echo ------------------------------------
git status -s
echo ------------------------------------
echo.

:: Check if working directory has changes
set HAS_CHANGES=
for /f "tokens=*" %%c in ('git status --porcelain 2^>nul') do set HAS_CHANGES=1

if not defined HAS_CHANGES (
    echo [INFO] No uncommitted changes detected in working directory.
)

:: 3. Prompt User for Confirmation
set /p CONFIRM="Do you want to publish the latest changes to GitHub (%BRANCH%)? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo.
    echo [CANCELLED] Publish process cancelled by user.
    exit /b 0
)

echo.

if defined HAS_CHANGES (
    echo [INFO] Staging project files...
    git add .
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Git add failed.
        exit /b 1
    )

    echo [INFO] Creating commit...
    git commit -m "Publish latest version"
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Git commit failed.
        exit /b 1
    )
) else (
    echo [INFO] Skipping commit (working directory is clean).
)

:: Get latest commit hash
for /f "tokens=*" %%h in ('git rev-parse HEAD 2^>nul') do set COMMIT_HASH=%%h

:: 4. Push to Remote
echo [INFO] Pushing latest commit to remote (%BRANCH%)...
git push origin %BRANCH%
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Git push failed. Check your network or GitHub authentication.
    exit /b 1
)

:: 5. Output Final Success Summary
echo.
echo ====================================
echo PUBLISH SUCCESSFUL
echo ====================================
echo.
echo GitHub:
echo Latest commit pushed successfully
echo.
echo Commit:
echo %COMMIT_HASH%
echo.
echo Branch:
echo %BRANCH%
echo.
echo Render:
echo Auto-deploy should now start automatically
echo.
echo Live URL:
echo https://downloader-gxyi.onrender.com
echo.
echo ====================================
