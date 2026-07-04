# Amnesic Browser — Project Memory

## What this project is

An Electron desktop app that behaves like a browser (tabs, address bar, nav)
but is engineered so nothing recoverable is left on disk after the process
exits. See docs/threat-model.md for the full scope and known limitations.

## Non-goals for v1 (do not implement without explicit human approval)

- Tor / SOCKS proxy integration
- Anti-fingerprinting (canvas/WebGL spoofing)
- Extensions support
- Bookmarks
- Downloads manager
- Password / autofill management
- Any telemetry, analytics, or crash-reporting SDK, even "just for debugging"

If a task seems to require touching one of the above, stop and flag it
instead of implementing it.

## Stack

- TypeScript, Node.js
- Electron (not Tauri — see docs/adr/0001-electron-vs-tauri.md)
- React + Vite for the renderer UI
- Zustand for renderer state
- Vitest for unit tests, Playwright for e2e/forensic verification
- ESLint + Prettier, Husky pre-commit hooks

## Engineering rules

- Every Chromium command-line switch used in main.js must have a code comment
  citing what it disables and be re-verified against the pinned Electron
  version before any Electron version bump.
- No feature may write to a real (non-tmpfs) disk path without an ADR
  explaining why, reviewed by the security-reviewer subagent first.
- Every significant architecture decision gets an ADR in docs/adr/.
- Commit convention: logically grouped commits, no AI co-author line.

## Verification requirement

No PR that touches session/storage/cache handling merges without
scripts/verify_footprint.sh passing in CI. See the forensics-verifier
subagent for how this is run and interpreted.
