#!/bin/bash
#
# PASTE THIS INTO THE ENVIRONMENT'S "Setup script" FIELD.
#   claude.ai/code -> the cloud icon above the message box -> hover your
#   environment -> the settings gear -> Setup script.
#
# It is kept in the repository so it can be reviewed and edited like code, but
# the copy that RUNS is the one stored on the environment. Change both together.
#
# WHY HERE AND NOT IN A SessionStart HOOK. A setup script runs once, before
# Claude Code launches, and the filesystem it leaves behind is snapshotted into
# the environment cache — so later sessions start with node_modules already on
# disk. A SessionStart hook re-runs on every session, including resumed ones.
# Dependencies belong in the cache; only things the cache cannot hold (running
# processes, e.g. Postgres) belong in the hook.
#
# THE FIVE-MINUTE BUDGET. The cache is only built if this finishes in roughly
# five minutes. That is why the network allowlist below is not optional:
#
#   Network access: Custom
#   Allowed domains:
#       npm.duckdb.org
#       extensions.duckdb.org
#       *.frame.claudeusercontent.com
#   [x] Also include default list of common package managers
#
# With `npm.duckdb.org` allowed, `duckdb` downloads a prebuilt binary in
# seconds. WITHOUT it the installer falls back to compiling DuckDB from C++
# source, which takes 10-15 minutes even with every core busy — over budget, so
# the cache never builds and the compile repeats every single session. That one
# line is the difference between a fast environment and a slow one.
#
# The other two: `extensions.duckdb.org` is where DuckDB fetches the `delta`
# and `azure` extensions at runtime, so without it any code path doing
# `LOAD delta` fails; `*.frame.claudeusercontent.com` is what lets a session
# read artifacts.

set -euo pipefail

# NODE 20, because that is what the product actually runs: both Dockerfiles are
# `FROM node:20` and all eleven CI jobs pin node-version: 20, while the sandbox
# image ships a newer one. A local run on a Node the product never executes on
# is not evidence about the product. `.nvmrc` records the version.
# nvm's own functions return non-zero for ordinary conditions, and sourcing
# nvm.sh auto-reads .nvmrc and can fail there — under `set -e` any of that
# aborts the script before it does anything (observed: silent exit 3). Run the
# whole block with errexit off; not selecting Node 20 is a downgrade, not a
# reason to abandon the session.
set +e
NVM_SH=""
for c in "${NVM_DIR:-}/nvm.sh" "$HOME/.nvm/nvm.sh" /opt/nvm/nvm.sh /usr/local/nvm/nvm.sh; do
  if [ -n "$c" ] && [ -s "$c" ]; then NVM_SH="$c"; break; fi
done
if [ -n "$NVM_SH" ]; then
  export NVM_DIR="$(dirname "$NVM_SH")"
  # shellcheck disable=SC1090
  . "$NVM_SH"
  nvm use 20 >/dev/null 2>&1 || { nvm install 20 >/dev/null 2>&1; nvm use 20 >/dev/null 2>&1; }
fi
set -e
echo "==> node $(node -v)"

# node-gyp invokes `make` with no -j flag of its own, so a native build would
# use one core and leave the rest idle. Harmless when nothing needs compiling.
export MAKEFLAGS="-j$(nproc 2>/dev/null || echo 2)"

echo "==> backend"
( cd backend && npm install --no-audit --no-fund )

echo "==> connectors"
( cd packages/connectors && npm install --no-audit --no-fund )

# The backend imports `@databridge/connectors`, so its compiled output must
# exist or `npm run check` fails with a dozen "cannot find module" errors that
# look like broken code and are not.
echo "==> connectors dist"
( cd packages/connectors && npm run build )

echo "==> frontend"
( cd frontend && npm install --no-audit --no-fund )

echo "==> done"
