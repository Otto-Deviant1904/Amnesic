---
name: project-verification-rigor
description: This project's own standard is that every Chromium switch/API claim must be verified against the pinned Electron version with a research/*.md citation before being trusted or documented as a mitigation — use this as the review bar
metadata:
  type: project
---

Amnesic Browser's own process (see `docs/adr/0002-electron-43-flag-and-api-corrections.md`
and `research/*.md`) is to never cite a Chromium command-line switch or
Electron API as a security mitigation without verifying it against the
pinned `electron@43.0.0` / Chromium source at HEAD first. The original plan
got three things wrong this way (`no-referrers` dead switch,
`disable-crash-reporter`/`disable-breakpad` non-guarantees, incomplete
WebRTC mitigation) and ADR 0002 exists specifically to correct those with
real citations.

**Why this matters for reviews:** treat this as the bar the codebase holds
itself to, not just a one-time historical correction. Any new main-process
security claim (new switch, new API call, new "this prevents X" comment)
that lacks a `research/*.md` citation or test should be flagged — not
necessarily as wrong, but as unverified, which this project treats as
equivalent to a false claim (see ADR 0002 "Alternatives considered": "a
switch that silently does nothing is worse than no mitigation at all for
this project, because it creates a false sense of security").

**How to apply:** when reviewing new main-process code, check whether every
new `app.commandLine.appendSwitch(...)`, new `session`/`webContents` API
call framed as a mitigation, or new claim in `docs/threat-model.md` has a
matching `research/*.md` entry or inline citation. If not, flag as a
Suggestion/Warning depending on exploitability, referencing this standard
rather than re-deriving it each time. Example already applied: the implicit
"Electron denies window.open() popups by default" assumption relied on in
`src/main/index.ts` has no `setWindowOpenHandler` and no research citation —
flagged on first review for exactly this reason.

Related: [[webrtc-preload-layer-gap]], [[ci-enforcement-not-implemented]],
[[default-session-parity-gap]]
