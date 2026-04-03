@echo off
echo ============================================
echo   DataBridge - Starting all services
echo ============================================
echo.

:: 1. Start Docker services (Postgres, Neo4j, ETL)
echo [1/5] Starting Docker services...
docker compose up -d --build
if %ERRORLEVEL% neq 0 (
    echo ERROR: Docker compose failed. Is Docker Desktop running?
    pause
    exit /b 1
)
echo      Docker services started.
echo.

:: 2. Run database migrations
echo [2/5] Running database migrations...
cd backend
call npx knex migrate:latest
cd ..
echo      Migrations done.
echo.

:: 3. Kill anything already on ports 3000/3001
echo [3/5] Freeing ports 3000 and 3001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo      Ports free.
echo.

:: 4. Start backend (in background)
echo [4/5] Starting backend on port 3001...
cd backend
start "DataBridge Backend" cmd /c "npx ts-node src/index.ts"
cd ..
echo      Backend starting...
echo.

:: 5. Start frontend (in background)
echo [5/5] Starting frontend on port 3000...
cd frontend
start "DataBridge Frontend" cmd /c "npx next dev -p 3000"
cd ..
echo      Frontend starting...
echo.

echo ============================================
echo   All services launched!
echo.
echo   Frontend:  http://localhost:3000
echo   Backend:   http://localhost:3001
echo   ETL:       http://localhost:8000
echo   Neo4j:     http://localhost:7474
echo   Postgres:  localhost:5432
echo ============================================
echo.
echo   Close the Backend/Frontend windows to stop.
echo   Run "docker compose down" to stop Docker.
echo.
pause
