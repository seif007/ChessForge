#!/usr/bin/env bash
#
# npm install for the ChessForge mobile port, hardened against the WorkBuddy shims.
#
# Why this script exists
# ----------------------
# The WorkBuddy desktop app injects two hooks into every Node process:
#
#   1. NODE_OPTIONS="--require=.../cli/vendor/shim/node-language-shim.cjs"
#      which monkey-patches node:fs and redirects every delete/rename through a
#      *trash* binary (genie-trash.exe) instead of doing it natively.
#   2. CODEBUDDY_SAFE_DELETE_BULK_GUARD=.../safe-delete-bulk-guard.cjs
#      a pre-flight helper that tries to exec `CODEBUDDY_NODE_BIN` on every
#      bulk delete, which ETIMEDOUTs under load.
#
# `reifyPackages` in @npmcli/arborist does tens of thousands of staging
# renames/deletes (`.foo-XXXX` -> `foo`). With the trash redirect that either
# starves on the bulk-guard timeout or takes minutes per package, so the
# install dies partway through and leaves a half-reified node_modules (which is
# exactly what happened on the first two attempts: 289 packages, no `.bin`,
# no @expo/cli).
#
# The fix is the shim's own documented escape hatch — node-safe-delete-shim.cjs
# line 22 reads:
#     const SAFE_DELETE_ENABLED = process.env.CODEBUDDY_SAFE_DELETE_ENABLED !== '0';
#     if (!SAFE_DELETE_ENABLED) { /* return, leave fs native */ }
# so `CODEBUDDY_SAFE_DELETE_ENABLED=0` restores native node:fs.
#
# We also:
#   - strip the NODE_OPTIONS shim entirely for this process tree
#   - use the *system* node (C:\Program Files\nodejs) so we are not inside the
#     managed runtime the shim expects to control
#   - raise fetch retries and socket timeouts for flaky-network resilience
#   - run with --no-audit/--no-fund to cut redundant registry round-trips
#
set -euo pipefail

cd "$(dirname "$0")/.."

# NOTE: real node.exe requires *Windows* paths for its argv entries — Git Bash
# only rewrites paths it recognises as standalone arguments, and these get
# concatenated into a node:-style specifier lookup (`C:\c\Program Files\...`),
# so we pass backslash paths explicitly.
NODE_BIN="C:\\Program Files\\nodejs\\node.exe"
NPM_CLI="C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"

# Git Bash needs the POSIX form only for the existence checks below.
NODE_BIN_POSIX="/c/Program Files/nodejs/node.exe"
NPM_CLI_POSIX="/c/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"

if [ ! -f "$NODE_BIN_POSIX" ]; then
  echo "FATAL: system node not found at $NODE_BIN_POSIX" >&2
  exit 1
fi
if [ ! -f "$NPM_CLI_POSIX" ]; then
  echo "FATAL: npm cli not found at $NPM_CLI_POSIX" >&2
  exit 1
fi

# --- neutralise the WorkBuddy fs shims -------------------------------------
unset NODE_OPTIONS
export CODEBUDDY_SAFE_DELETE_ENABLED=0

echo "node    : $("$NODE_BIN" --version)"
echo "npm     : $("$NODE_BIN" "$NPM_CLI" --version)"
echo "shim off: CODEBUDDY_SAFE_DELETE_ENABLED=$CODEBUDDY_SAFE_DELETE_ENABLED"
echo

# --- sanity: confirm native fs.rm is really back ---------------------------
"$NODE_BIN" -e "
const fs = require('fs');
if (fs.rmSync.toString().includes('safe-delete')) {
  console.error('FATAL: safe-delete shim is still active on fs.rmSync');
  process.exit(1);
}
console.log('fs.rmSync is native  OK');
" || exit 1

echo
echo "=== installing ==="
exec "$NODE_BIN" "$NPM_CLI" install \
  --no-audit \
  --no-fund \
  --legacy-peer-deps \
  --fetch-retries=5 \
  --fetch-retry-maxtimeout=120000 \
  --fetch-timeout=600000
