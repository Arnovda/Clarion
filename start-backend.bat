@echo off
echo Stopping any process on port 3001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Starting backend on http://localhost:3001 ...
echo (Restart this after any change in backend/src/)
echo.
cd backend
npx ts-node src/index.ts
pause
