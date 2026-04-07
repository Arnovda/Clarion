# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install build essentials for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL deps (including devDependencies for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json tsconfig.build.json ./
COPY knexfile.ts ./
COPY src/ ./src/

# Compile TypeScript → JavaScript in /app/dist
# Type checking is done in CI (test.yml); Docker build uses transpile-only for speed
RUN npx tsc --project tsconfig.build.json

# ── Stage 2: Production ────────────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app

# Install runtime deps for native modules (better-sqlite3, duckdb)
RUN apt-get update && apt-get install -y wget python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy knexfile (needed for runtime migrations)
COPY knexfile.ts ./

# We still need ts-node for knexfile.ts at migration time
RUN npm install ts-node typescript

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

EXPOSE 3001

# Run compiled JS directly (not ts-node) for performance
CMD ["node", "dist/index.js"]
