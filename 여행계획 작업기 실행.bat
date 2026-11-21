@echo off
chcp 65001 >nul
title Travel Planner Worker
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt
".venv\Scripts\python.exe" -m travel_planner worker
pause
