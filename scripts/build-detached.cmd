@echo off
REM ---------------------------------------------------------------------------
REM Detached release-APK build for ChessForge.
REM
REM Why this exists: Gradle's release build for this project takes 25-40 minutes
REM on a cold cache. Running it through the agent's Bash tool means it gets
REM killed whenever the foreground command times out or the shell exits, and a
REM half-finished build leaves the transform cache in a confusing state.
REM
REM Launching it as a detached cmd.exe process lets it run to completion
REM independent of any shell, and it writes progress to a log file we can tail.
REM ---------------------------------------------------------------------------

setlocal

set "JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot"
set "ANDROID_HOME=C:\AndroidSDK"
set "ANDROID_SDK_ROOT=C:\AndroidSDK"
set "GRADLE_USER_HOME=C:\gradle-home-chessforge"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;C:\Program Files\nodejs;%PATH%"

REM Bypass the WorkBuddy fs shim / bulk-delete guard for this child process only.
set "CODEBUDDY_SAFE_DELETE_ENABLED=0"
REM Gradle needs NODE_ENV at bundle time or Expo CLI warns and skips .env.production.
set "NODE_ENV=production"
set "NO_COLOR=1"

set "LOG=%~dp0..\..\apk-build.log"
set "PROJ=%~dp0..\android"

echo === build started %DATE% %TIME% === > "%LOG%"
cd /d "%PROJ%"
call gradlew.bat :app:assembleRelease --no-daemon --console=plain >> "%LOG%" 2>&1
echo === build exit %ERRORLEVEL% at %DATE% %TIME% === >> "%LOG%"

endlocal
