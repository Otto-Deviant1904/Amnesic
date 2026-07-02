# 0003: WebRTC API removal via CDP debugger, not a preload script

## Status

Accepted

## Context

ADR 0002 (decision 3) specified the second of three WebRTC leak-mitigation
layers as "a preload script deleting `window.RTCPeerConnection`,
`window.RTCDataChannel`, and `navigator.mediaDevices.getUserMedia` before
page scripts run." That layer was never implemented, and a security review
of the codebase (first review, commit `077a88d`) flagged its absence as a
Critical finding — the documented three-layer guarantee was only two layers
deep in the actual code.

While implementing the fix, the preload-script approach in ADR 0002 turned
out to be wrong, not just missing. This project uses `contextIsolation: true`
on every `WebContentsView` (`src/main/index.ts`). Electron's own
context-isolation documentation states that with context isolation enabled,
a preload script's `window` object is a **different object** from the one
page scripts see — they do not share a JS realm. `delete
window.RTCPeerConnection` executed in a preload script under
`contextIsolation: true` would delete the property on the preload's isolated
`window`, which has no effect on the actual page. Shipping that code would
have reproduced exactly the class of bug ADR 0002 exists to eliminate: a
mitigation that looks correct and does nothing (the `no-referrers` problem,
recurring).

## Decision

Remove the WebRTC API surface from the page using the Chrome DevTools
Protocol instead of a preload script: attach `webContents.debugger`,
`Page.enable`, then `Page.addScriptToEvaluateOnNewDocument` with a script
that deletes `RTCPeerConnection`, `webkitRTCPeerConnection`,
`RTCDataChannel`, and `navigator.mediaDevices.getUserMedia`. This runs the
deletion in the page's own main-world realm before any page script executes,
on every navigation — the same mechanism Playwright's `page.addInitScript()`
uses internally. Implemented in `installWebRtcBlock()` in
`src/main/index.ts`, called once per tab in `createTab()`.

No preload script is attached to tab `WebContentsView`s at all. There is no
need for one: tabs load untrusted third-party content and must never have
access to the `contextBridge` API surface that `src/preload/index.ts`
exposes to the trusted shell window.

## Alternatives considered

- **Keep the preload-script approach as originally written in ADR 0002.**
  Rejected: it does not work under `contextIsolation: true`, per Electron's
  own documentation. Implementing it as originally specified would have
  been a no-op mitigation shipped with a passing-looking code review.

- **Disable `contextIsolation` for tab `WebContentsView`s so a preload
  script's globals are shared with the page.** Rejected: this is a much
  larger security regression (loses the isolation between preload/Electron
  APIs and untrusted page content) than the problem it would solve, and is
  exactly backwards for a project whose tabs load arbitrary third-party
  sites.

- **Give tabs a preload script solely for exposing a `contextBridge` method
  that the page could call to request RTC removal.** Rejected: this
  requires the page's own cooperation (a hostile page simply never calls
  it), so it provides no actual guarantee — the whole point of layer 2 is
  that the page cannot opt out.

## Consequences

- `installWebRtcBlock()` attaches the CDP debugger to every tab's
  `webContents`. This has a real (if narrow) downside: attaching Electron's
  own `webContents.debugger` to a target can conflict with other consumers
  of the CDP debugger API on the same target (e.g., if remote debugging or
  DevTools were ever opened on a tab). v1 does not open DevTools on tabs, so
  this is currently inert, but any future feature that needs `debugger` or
  developer tools on tab content must account for this.
- `debugger.attach()`/`sendCommand()` can throw or reject; failures are
  caught and logged (`console.error`), not surfaced to the user or retried.
  If CDP attachment silently fails on some future Electron version, layer 2
  would silently regress with no user-visible signal — the same
  "single-layer guarantee is fragile" caveat ADR 0002 already documents for
  the other two WebRTC layers applies here too.
- This is a real, if small, additional cost per tab (one CDP round-trip at
  tab-creation time) compared to a preload script, which has none.

## Sources

- Electron context-isolation docs: preload and page do not share a `window`
  object under `contextIsolation: true`.
- Electron `webContents.debugger` API docs: `attach`, `sendCommand`,
  `Page.addScriptToEvaluateOnNewDocument` (Chrome DevTools Protocol).
- Security review, first pass, commit `077a88d` (Critical finding 1).
