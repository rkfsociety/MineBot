@echo off
setlocal enabledelayedexpansion

REM Simple build without Gradle/Maven.
REM Requires JDK 17+ in PATH (javac, jar).

set ROOT=%~dp0
set SRC=%ROOT%src\main\java
set RES=%ROOT%src\main\resources
set OUT=%ROOT%build\classes
set JAROUT=%ROOT%build\MineBot.jar

if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%" >nul 2>&1

for /f "delims=" %%f in ('dir /s /b "%SRC%\*.java"') do (
  set FILES=!FILES! "%%f"
)

echo [build] compiling...
javac -encoding UTF-8 -source 17 -target 17 -d "%OUT%" %FILES%
if errorlevel 1 exit /b 1

echo [build] copying resources...
xcopy /e /i /y "%RES%\*" "%OUT%\" >nul

echo [build] creating jar...
if exist "%JAROUT%" del /q "%JAROUT%" >nul 2>&1
pushd "%OUT%"
jar --create --file "%JAROUT%" --main-class rkfsociety.minebot.server.Main .
popd

echo [build] done: %JAROUT%
endlocal

