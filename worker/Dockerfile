# Sync-worker container image.
#
# This image contains the FULL connector framework + every registered
# connector. One execution = one sync of one connection. No HTTP server,
# no DataBridge DB credentials, no shared state with the backend.
#
# Built and pushed by CI as `databridge-sync-worker`. Container Apps Jobs
# launches one container per sync execution, passing per-execution env
# vars (decrypted credentials, warehouse SAS URL, etc.). Container exits
# cleanly after the sync; memory is gone with it.
#
# Multi-stage build:
#   • `deps`   — install + build packages/connectors and worker, prune to prod deps
#   • `runtime` — copy compiled output + production node_modules, run as non-root

# ─── Stage 1: build ───────────────────────────────────────────────────────
# Note: node:20-slim (Debian, glibc) — NOT alpine.
# DuckDB's prebuilt binary links against glibc; on Alpine (musl) it fails
# to load with `Error loading shared library ld-linux-x86-64.so.2`.
# The backend image uses node:20-slim for the same reason.
FROM node:20-slim AS deps

WORKDIR /build

# Build essentials for native modules (DuckDB) — used during npm install.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy lockfiles first so layer cache survives source changes.
# packages/connectors is a workspace dep referenced via file:.
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY packages/connectors/tsconfig.json ./packages/connectors/tsconfig.json
COPY worker/package.json ./worker/package.json
COPY worker/tsconfig.json ./worker/tsconfig.json

# Install deps for the connectors package, then build it. Build output
# goes into packages/connectors/dist which the worker resolves via
# the file: dependency.
COPY packages/connectors/src ./packages/connectors/src
RUN cd packages/connectors && npm install --no-audit --no-fund && npm run build

# Now install + build the worker. The worker's `file:../packages/connectors`
# dep is resolved against the path we just built.
COPY worker/src ./worker/src
RUN cd worker && npm install --no-audit --no-fund && npm run build

# Prune the worker to production-only dependencies (drops tsc + types).
RUN cd worker && npm prune --production --no-audit --no-fund

# ─── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Runtime libs DuckDB's azure extension expects (the spike's backend has the
# same set — kept consistent so DuckDB behaves identically across processes).
RUN apt-get update && apt-get install -y \
      ca-certificates libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Run as a dedicated non-root user. Container Apps already namespace-isolates
# but defence in depth is cheap.
RUN groupadd -r worker && useradd -r -g worker worker

WORKDIR /app

# Copy worker compiled output + its (pruned) node_modules.
COPY --from=deps /build/worker/dist ./worker/dist
COPY --from=deps /build/worker/package.json ./worker/package.json
COPY --from=deps /build/worker/node_modules ./worker/node_modules

# The worker's node_modules contains a symlink to packages/connectors via
# the file: dep. Copy the connectors package's compiled output to the path
# the symlink resolves to.
COPY --from=deps /build/packages/connectors/dist ./packages/connectors/dist
COPY --from=deps /build/packages/connectors/package.json ./packages/connectors/package.json
COPY --from=deps /build/packages/connectors/node_modules ./packages/connectors/node_modules

USER worker

# No exposed port — this is a one-shot job, not a server.
# No CMD args either — env vars carry everything the worker reads.
ENV NODE_ENV=production
ENTRYPOINT ["node", "worker/dist/main.js"]
