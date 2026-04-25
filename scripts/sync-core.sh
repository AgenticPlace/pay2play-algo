#!/usr/bin/env bash
# Sync agnostic core types from pay2play-arc at a pinned commit.
#
# Usage:
#   bash scripts/sync-core.sh                                # sync against current pin
#   bash scripts/sync-core.sh --pin <commit-sha>             # update to a new pin
#   bash scripts/sync-core.sh --check                        # diff-only, no overwrite
#
# What it does:
#   - Fetches packages/core/src/types.ts and session.ts from
#     github.com/AgenticPlace/pay2play-arc at the pinned commit
#   - Stamps a CORE_SYNCED_AT / CORE_SOURCE provenance header on each file
#   - Leaves src/core/meter.ts alone (Algo-specific, owned by this repo)
set -euo pipefail

REPO="AgenticPlace/pay2play-arc"
DEFAULT_PIN="7e386939ef9812e1e87b65ec3d461ff0fbc50140"
TARGET_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/core"
FILES=(types.ts session.ts decimal.ts fee.ts)

PIN="$DEFAULT_PIN"
CHECK_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pin) PIN="$2"; shift 2;;
    --check) CHECK_ONLY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

NOW=$(date -u +"%Y-%m-%dT%H:%MZ")
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "[sync-core] pinning to $REPO @ $PIN"

for f in "${FILES[@]}"; do
  url="https://raw.githubusercontent.com/${REPO}/${PIN}/packages/core/src/${f}"
  echo "[sync-core] fetching $f"
  curl -fsSL "$url" -o "$TMPDIR/$f"

  out="$TMPDIR/${f}.stamped"
  {
    echo "// CORE_SYNCED_AT: ${NOW}"
    echo "// CORE_SOURCE: github.com/${REPO} @ ${PIN}"
    echo "// DO NOT EDIT BY HAND — sync via scripts/sync-core.sh"
    cat "$TMPDIR/$f"
  } > "$out"

  if [[ $CHECK_ONLY -eq 1 ]]; then
    # Ignore the CORE_SYNCED_AT timestamp line — it changes on every sync.
    # Drift = real content differences in lines 4+.
    if ! diff -q \
        <(grep -v "^// CORE_SYNCED_AT:" "$TARGET_DIR/$f") \
        <(grep -v "^// CORE_SYNCED_AT:" "$out") >/dev/null 2>&1; then
      echo "[sync-core] DRIFT: $f differs from pinned source"
      diff \
        <(grep -v "^// CORE_SYNCED_AT:" "$TARGET_DIR/$f") \
        <(grep -v "^// CORE_SYNCED_AT:" "$out") || true
    else
      echo "[sync-core] OK: $f matches pinned source"
    fi
  else
    cp "$out" "$TARGET_DIR/$f"
    echo "[sync-core] wrote $TARGET_DIR/$f"
  fi
done

if [[ $CHECK_ONLY -eq 0 ]]; then
  echo "[sync-core] done — review changes with: git diff src/core/"
fi
