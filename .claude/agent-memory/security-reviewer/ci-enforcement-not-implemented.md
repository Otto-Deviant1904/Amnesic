---
name: ci-enforcement-not-implemented
description: threat-model.md and ADR 0002 describe CI/lint enforcement (crashReporter.start grep, verify_footprint.sh) as an existing guarantee mechanism, but as of first review neither exists/passes
metadata:
  type: project
---

`docs/threat-model.md` §2 (crash dumps row) and
`docs/adr/0002-electron-43-flag-and-api-corrections.md` both state the
crash-reporter guarantee is "enforced by a CI/lint grep for
`crashReporter.start(`". As of the first review (commit 077a88d,
2026-07-02) there is no `.github/workflows` directory, no ESLint
`no-restricted-syntax`/`no-restricted-imports` rule, and no script anywhere
in the repo implementing that grep. `.husky/pre-commit` only runs
`lint-staged` (eslint --fix + prettier --write on staged files) — neither
does this check.

Separately, `scripts/verify_footprint.sh` (referenced by CLAUDE.md as a
required merge gate for any PR touching session/storage/cache handling) is
an intentional stub that always `exit 1`s — it says so in its own comment.
This PR touches session/storage/cache handling extensively, so by the
project's own stated rule it should not merge yet, though the stub is
clearly deliberate scaffolding, not an oversight, per its comment header
attributing real implementation to the forensics-verifier subagent.

**Why this matters:** the actual runtime safety today (no `crashReporter.start()`
call exists in the code) is real and correctly implemented — this is not a
live leak. But the _enforcement_ the docs claim protects that guarantee
going forward does not exist yet, so a future PR could add
`crashReporter.start()` and nothing would catch it.

**How to apply:** On future reviews, grep for `.github/workflows`, an ESLint
rule targeting `crashReporter`, and check `scripts/verify_footprint.sh` for
real logic (not just the stub). If the enforcement now exists, this finding
is resolved — don't re-flag. Until then, keep noting it as a Warning
(process gap, not a code vulnerability) each time CI/lint config changes.

Related: [[project-verification-rigor]]
