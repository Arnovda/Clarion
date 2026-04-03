@echo off
echo Stopping any process on port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
echo Starting frontend on http://localhost:3000 ...
echo (Has hot-reload, but restart if you add new dependencies)
echo.
cd frontend
npx next dev -p 3000
pause
