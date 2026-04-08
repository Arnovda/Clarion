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
# ca-certificates: SSL certs for DuckDB's Azure extension
# libcurl4-openssl-dev: required when azure_transport_option_type = 'curl'
RUN apt-get update && apt-get install -y wget python3 make g++ ca-certificates libcurl4-openssl-dev && rm -rf /var/lib/apt/lists/*

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy knexfile (needed for runtime migrations)
COPY knexfile.ts ./

# We still need ts-node for knexfile.ts at migration time
RUN npm install ts-node typescript

# DuckDB's Azure extension is compiled on RHEL and looks for CA certs at
# /etc/pki/tls/certs/ca-bundle.crt. On Debian-based images (node:20-slim)
# the certs live at /etc/ssl/certs/ca-certificates.crt. Create a symlink
# so the extension finds them. Also set CURL_CA_BUNDLE as a fallback.
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

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/health || exit 1

EXPOSE 3001

# Run compiled JS directly (not ts-node) for performance
CMD ["node", "dist/index.js"]
