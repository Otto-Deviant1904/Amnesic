#!/usr/bin/env bash
# Forensic footprint verification — the empirical proof of the core claim.
#
# Method:
#   1. Static guarantees: grep-enforced invariants from docs/threat-model.md
#      (no crashReporter.start, no addRecentDocument, no GOOGLE_API_KEY).
#   2. Build the app (skip with FOOTPRINT_SKIP_BUILD=1 if already built).
#   3. Drop a marker file, then run a scripted browsing session
#      (scripts/footprint-session.mjs) that exercises persistent cookies,
#      localStorage, sessionStorage, IndexedDB, the Cache API, and an
#      attempted download, then exits through the real cleanup path. The
#      driver itself asserts the tmpfs userData dir exists during the run
#      and is deleted on exit.
#   4. Scan $HOME, /tmp, /var/tmp and /dev/shm for any file created or
#      modified since the marker. Every hit must be attributable to the
#      test harness itself (exclusions documented inline); anything else
#      is a footprint violation and fails the run.
#
# The authoritative environment for this check is CI, where nothing else
# writes to the filesystem during the run. On a developer workstation other
# processes (editors, desktop services) create noise; findings there need
# eyeballing before being treated as violations.
#
# Exit codes: 0 = pass, non-zero = fail (blocks CI merge per CLAUDE.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "verify_footprint: FAIL — $1" >&2
  exit 1
}

# --- 1. Static guarantees (threat-model §2: "enforced by CI grep") -----------
# Comment lines are stripped so the threat-model discussion of these APIs in
# code comments doesn't false-positive.
STATIC_VIOLATIONS="$(grep -rn --include='*.ts' --include='*.tsx' \
  -e 'crashReporter\.start(' \
  -e 'addRecentDocument(' \
  -e 'GOOGLE_API_KEY' \
  src/ | grep -vE ':\s*(//|\*)' || true)"
if [ -n "$STATIC_VIOLATIONS" ]; then
  echo "$STATIC_VIOLATIONS" >&2
  fail "forbidden API reference in src/ (see docs/threat-model.md §2)"
fi
echo "verify_footprint: static guarantees OK"

# --- 2. Build ----------------------------------------------------------------
if [ "${FOOTPRINT_SKIP_BUILD:-}" != "1" ]; then
  npm run build >/dev/null
fi
[ -f out/main/index.js ] || fail "no build at out/main/index.js"

# --- 3. Marker, then scripted session ---------------------------------------
MARKER="$(mktemp /tmp/footprint-marker.XXXXXX)"
trap 'rm -f "$MARKER"' EXIT
sleep 1.1 # ensure every subsequent write sorts strictly after the marker mtime

node scripts/footprint-session.mjs

# --- 4. Filesystem diff -------------------------------------------------------
# Exclusions, each attributable to the harness rather than the app:
#   - the marker file itself
#   - Playwright's launch artifacts dir (created by playwright-core, not the app)
#   - this repo's build/test output (written by npm/playwright invoked here)
#   - the GitHub Actions runner's own diagnostic logs (written by the CI
#     agent process continuously, unrelated to the app under test)
SCAN_DIRS="${FOOTPRINT_SCAN_DIRS:-$HOME /tmp /var/tmp /dev/shm}"

# shellcheck disable=SC2086 # SCAN_DIRS is intentionally word-split
FINDINGS="$(find $SCAN_DIRS -xdev \( -type f -o -type p -o -type s \) -newer "$MARKER" \
  ! -path "$MARKER" \
  ! -path '/tmp/playwright*' \
  ! -path "${TMPDIR:-/tmp}/playwright*" \
  ! -path "$ROOT/out/*" \
  ! -path "$ROOT/test-results/*" \
  ! -path "$ROOT/node_modules/*" \
  ! -path '*/actions-runner/*' \
  2>/dev/null || true)"

if [ -n "$FINDINGS" ]; then
  echo "verify_footprint: files written outside tmpfs during the session:" >&2
  echo "$FINDINGS" >&2
  fail "$(echo "$FINDINGS" | wc -l) unexpected filesystem write(s)"
fi

echo "verify_footprint: PASS — no recoverable footprint outside tmpfs"
