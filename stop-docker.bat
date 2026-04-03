@echo off
echo Stopping all Docker services...
docker compose down
echo.
echo Done. Postgres, Neo4j, and ETL stopped.
pause
