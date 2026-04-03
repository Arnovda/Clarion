@echo off
echo Rebuilding and restarting ETL service...
echo (Run this after changes to etl/main.py or etl/requirements.txt)
echo.
docker compose up -d --build etl
echo.
echo ETL running at http://localhost:8000
pause
