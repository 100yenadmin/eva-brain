#!/bin/bash
# CI guard against silent singleton reuse in connected-gbrains code paths.
#
# Codex finding #7 (plan review 2026-04-22): the module singleton in
# src/core/db.ts is shared across the process. With multi-brain routing,
# any `db.getConnection()` call in an op-dispatch code path means that op
# silently targets whichever brain connected to the singleton first,
# regardless of ctx.brainId / ctx.engine. This is exactly the bug Codex
# #1 flagged in postgres-engine.ts internals.
#
# This script fails the build when NEW `db.getConnection()` calls appear
# in src/core or src/commands. Existing legitimate callers are grandfathered
# via an explicit allowlist — cleanups land in PR 1.
#
# When you hit this guard: instead of `db.getConnection()` or `db.connect(...)`,
# use `ctx.engine` from the passed-in OperationContext. See
# src/core/brain-registry.ts for how ctx.engine gets populated per-call.
#
# Run manually:  bash scripts/check-no-legacy-getconnection.sh
# Wired into CI: `bun test` (via package.json scripts.test)

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT"

CTX_DIR="$ROOT/.context"
mkdir -p "$CTX_DIR"
FAIL_LOG="$CTX_DIR/test-failures.log"
SUMMARY_LOG="$CTX_DIR/test-summary.txt"

if ! bun scripts/check-no-legacy-getconnection.mjs >"$FAIL_LOG" 2>&1; then
  FAIL_ABS="$(cd "$(dirname "$FAIL_LOG")" && pwd)/$(basename "$FAIL_LOG")"
  SUMMARY_ABS="$(cd "$(dirname "$SUMMARY_LOG")" && pwd)/$(basename "$SUMMARY_LOG")"
  cp "$FAIL_LOG" "$SUMMARY_LOG"
  {
    echo "========== CHECK-NO-LEGACY-GETCONNECTION FAILED =========="
    echo "Failure log: $FAIL_ABS"
    echo "Summary:     $SUMMARY_ABS"
    echo "=========================================================="
  } >&2
  cat "$FAIL_LOG" >&2
  exit 1
fi

cat "$FAIL_LOG"
