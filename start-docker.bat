@echo off
echo Starting Docker services (Postgres, Neo4j, ETL)...
docker compose up -d --build
echo.
echo   Postgres:  localhost:5432
echo   Neo4j:     http://localhost:7474
echo   ETL:       http://localhost:8000
echo.
pause
