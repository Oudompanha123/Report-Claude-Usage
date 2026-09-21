@echo off
rem Wrapper used by the "Claude Usage Push" scheduled task.
rem Any arguments given here are passed straight through to push-usage.mjs.
cd /d "%~dp0"
echo ---- %DATE% %TIME% : node push-usage.mjs %* >> "%~dp0push-usage.log"
"C:\Program Files\nodejs\node.exe" "%~dp0push-usage.mjs" %* >> "%~dp0push-usage.log" 2>&1
echo ---- exit code %ERRORLEVEL% >> "%~dp0push-usage.log"
