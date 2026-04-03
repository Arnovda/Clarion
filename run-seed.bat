@echo off
echo Generating sample.db with seed data...
cd backend
npx ts-node src/seed.ts
echo.
echo Done. data/sample.db is ready.
pause
