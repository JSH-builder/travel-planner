@echo off
chcp 65001 >nul
title Travel Planner Worker
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt
:loop
".venv\Scripts\python.exe" -m travel_planner worker
if errorlevel 3 if not errorlevel 4 goto already
echo.
echo [%date% %time%] 작업기가 멈췄어요. 10초 뒤 자동으로 다시 켭니다. (완전히 끄려면 이 창을 닫으세요)
timeout /t 10 /nobreak >nul
goto loop
:already
timeout /t 5 >nul
