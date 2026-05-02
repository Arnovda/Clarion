# Build context: REPO ROOT (not ./backend).
# This is because backend now depends on `@databridge/connectors` via
# `file:../packages/connectors` — `npm ci` needs to see that path.
# CI's `build-push-action` is configured with `context: .` and
# `file: ./backend/Dockerfile` to make this work.

# ── Stage 1: Build connectors package + backend ─────────────────────────────
FROM node:20-slim AS builder

WORKDIR /build

# Install build essentials for native modules (DuckDB, better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# ── Build the shared connectors package first ──
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY packages/connectors/package-lock.json ./packages/connectors/package-lock.json
COPY packages/connectors/tsconfig.json  ./packages/connectors/tsconfig.json
RUN cd packages/connectors && npm ci
COPY packages/connectors/src ./packages/connectors/src
RUN cd packages/connectors && npm run build && npm prune --production

# ── Install + build the backend ──
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci
COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/knexfile.ts ./backend/knexfile.ts
COPY backend/src/ ./backend/src/
RUN cd backend && npx tsc --project tsconfig.build.json

# ── Stage 2: Production image ───────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app

RUN apt-get update && apt-get install -y \
      wget python3 make g++ ca-certificates libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

# The backend's `file:../packages/connectors` dep resolution looks RELATIVE to
# the backend's package.json. Recreate the same on-disk layout the build had:
#   /app/backend/        ← runtime cwd
#   /app/packages/connectors/  ← what file:../packages/connectors resolves to
COPY --from=builder /build/packages/connectors/package.json ./packages/connectors/package.json
COPY --from=builder /build/packages/connectors/dist          ./packages/connectors/dist
COPY --from=builder /build/packages/connectors/node_modules  ./packages/connectors/node_modules

# Install the backend's production deps, pointing the WORKDIR at /app/backend
# so the relative `file:../packages/connectors` link resolves correctly.
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS + knexfile
COPY --from=builder /build/backend/dist ./dist
COPY backend/knexfile.ts ./

# Migrations are run via `knex migrate:latest` which loads knexfile.ts via
# ts-node, so we need it at runtime even though the app itself is plain JS.
RUN npm install ts-node typescript

# DuckDB's Azure extension is compiled on RHEL and looks for CA certs at
# /etc/pki/tls/certs/ca-bundle.crt. On Debian-based images (node:20-slim)
# the certs live at /etc/ssl/certs/ca-certificates.crt. Create a symlink so
# the extension finds them. Also set CURL_CA_BUNDLE as a fallback.
RUN mkdir -p /etc/pki/tls/certs && \
    ln -s /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Pre-install DuckDB extensions so they don't need to download at runtime
RUN node -e "\
const duckdb = require('duckdb');\
const db = new duckdb.Database(':memory:');\
db.exec('INSTALL delta; INSTALL azure;', (err) => {\
  if (err) { console.error('Extension install failed:', err); process.exit(1); }\
  console.log('DuckDB extensions installed (delta, azure)');\
  db.close(() => process.exit(0));\
});"

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

EXPOSE 3001

CMD ["node", "dist/index.js"]
