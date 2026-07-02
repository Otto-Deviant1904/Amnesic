---
name: webrtc-preload-layer-gap
description: Tab content WebContentsView has no preload script at all; the WebRTC preload-deletion mitigation (ADR 0002 layer 2) is entirely unimplemented as of the first review (commit 077a88d, 2026-07-02)
metadata:
  type: project
---

`src/main/index.ts` `createTab()` constructs each tab's `WebContentsView` with
`webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false }`
and **no `preload` key**. The only `preload:` assignment in the codebase is
on the shell `BrowserWindow` in `createWindow()` (loads the React chrome UI),
and that preload script (`src/preload/index.ts`) only sets up the
`contextBridge` IPC bridge — it does not delete
`window.RTCPeerConnection` / `window.RTCDataChannel` /
`navigator.mediaDevices.getUserMedia`.

`docs/adr/0002-electron-43-flag-and-api-corrections.md` and
`docs/threat-model.md` both describe a **3-layer** WebRTC mitigation, where
layer 2 is exactly this preload-script deletion, specifically to catch
"a peer connection object created before the preload script runs, or via a
code path the deletion misses." As of the first review this layer does not
exist anywhere — confirmed via `grep -rn "RTCPeerConnection\|getUserMedia\|RTCDataChannel"`
returning zero hits outside the ADR/threat-model prose itself.

**Why this matters for future reviews:** if a future PR adds a preload to
tab content, do not assume reusing `src/preload/index.ts` unmodified is
correct — that file exposes the `amnesic` contextBridge API, which must
never be reachable from arbitrary web content tabs (only from the trusted
shell BrowserWindow). A correct fix needs a _separate_ tab-content preload
(e.g. `src/preload/tab.ts`) that does only the RTCAPI deletion, with its own
`preload:` entry in `createTab()`'s `webPreferences`.

**How to apply:** On the next review, check whether (a) a dedicated
tab-content preload exists, (b) it performs the RTC deletion, and (c) it is
NOT the same file that exposes the `amnesic` bridge. If all three hold, this
finding is resolved — do not re-flag it, just confirm and move on. If only
some hold, downgrade severity accordingly but still note the gap.

Related: [[project-verification-rigor]]
