@echo off
echo Running database migrations...
cd backend
npx knex migrate:latest
echo.
echo Done. Restart the backend if schema changed.
pause
