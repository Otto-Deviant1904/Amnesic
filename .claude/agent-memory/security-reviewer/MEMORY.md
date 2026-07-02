# Memory index

- [Tab content has no preload / WebRTC layer-2 missing](webrtc-preload-layer-gap.md) — createTab() never sets `preload`; RTCPeerConnection deletion doesn't exist anywhere in repo (as of 2026-07-02, commit 077a88d)
- [defaultSession vs in-memory partition parity gap](default-session-parity-gap.md) — configureSession()/cleanupAndExit() only touch the tab partition, never session.defaultSession used by the shell BrowserWindow
- [CI enforcement described in docs not yet wired up](ci-enforcement-not-implemented.md) — crashReporter.start() grep, verify_footprint.sh are documented as guarantees but don't exist/don't pass yet
- [Project verification rigor standard](project-verification-rigor.md) — how this codebase wants every Chromium switch/API claim checked; use as the bar for future reviews
