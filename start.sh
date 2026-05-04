#!/usr/bin/env bash
set -e

echo "============================================"
echo "  Clarion - Starting all services"
echo "============================================"
echo ""

# 1. Docker services
echo "[1/4] Starting Docker services..."
docker compose up -d --build
echo "      Docker services started."
echo ""

# 2. Migrations
echo "[2/4] Running database migrations..."
(cd backend && npx knex migrate:latest) || echo "WARNING: Migrations may have failed"
echo "      Migrations done."
echo ""

# 3. Backend
echo "[3/4] Starting backend on port 3001..."
(cd backend && npx ts-node src/index.ts) &
BACKEND_PID=$!
echo "      Backend PID: $BACKEND_PID"
echo ""

# 4. Frontend
echo "[4/4] Starting frontend on port 3000..."
(cd frontend && npx next dev) &
FRONTEND_PID=$!
echo "      Frontend PID: $FRONTEND_PID"
echo ""

echo "============================================"
echo "  All services launched!"
echo ""
echo "  Frontend:  http://localhost:3000"
echo "  Backend:   http://localhost:3001"
echo "  ETL:       http://localhost:8000"
echo "  Neo4j:     http://localhost:7474"
echo "  Postgres:  localhost:5432"
echo "============================================"
echo ""
echo "  Press Ctrl+C to stop backend + frontend."
echo "  Run 'docker compose down' to stop Docker."
echo ""

# Wait for both background processes
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM
wait
