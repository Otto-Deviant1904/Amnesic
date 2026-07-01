#!/usr/bin/env bash
# Forensic footprint verification — owned by the forensics-verifier workflow.
#
# THIS IS A STUB, seeded early per CLAUDE.md's verification requirement so
# the file (and the CI wiring pointing at it) exists before feature work
# starts, not bolted on after. The real logic — snapshot filesystem mtimes,
# launch + drive the app via Playwright, re-snapshot, diff, and fail on any
# write outside the expected tmpfs-backed userData path — is a v1 deliverable
# tracked separately; see docs/threat-model.md for the exact artifact list
# this script must check once implemented.
#
# Exit codes: 0 = pass, non-zero = fail (blocks CI merge per CLAUDE.md).

set -euo pipefail

echo "verify_footprint.sh: not yet implemented — stub only." >&2
echo "See CLAUDE.md 'Verification requirement' and the forensics-verifier subagent." >&2
exit 1
