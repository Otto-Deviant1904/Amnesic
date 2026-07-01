# 0002: Electron 43 flag and API corrections (referrer, crash reporter, WebRTC)

## Status

Accepted

## Context

The original plan (`docs/master-plan-source.md`, Sections 3.1, 4.1, and 5)
specified three mitigations as simple `app.commandLine.appendSwitch(...)`
calls or a partial app-level workaround:

1. Suppress referrers with `app.commandLine.appendSwitch('no-referrers')`.
2. Guarantee crash dumps are never written via
   `app.commandLine.appendSwitch('disable-crash-reporter')` and
   `app.commandLine.appendSwitch('disable-breakpad')`.
3. Mitigate WebRTC IP leaks by asserting "there is no real Chromium switch
   for this" and relying only on `session.setPermissionRequestHandler`
   denying `'media'` requests plus a preload script deleting
   `window.RTCPeerConnection`.

Those claims were written before verification against the pinned
dependency. A research pass against `electron@43.0.0` (Chromium
150.0.7871.46) — see `research/command-line-switches.md` §5–6 and
`research/os-level-and-webrtc.md` §16 — checked each claim against
Electron's current documented API surface and Chromium's own source
(`chrome_switches.cc`, `content_switches.cc`,
`components/embedder_support/switches.cc`) at HEAD. It found that all
three were wrong or incomplete in ways that matter for a project whose
entire credibility rests on precisely enumerating what each control
actually does:

1. **`no-referrers` is dead.** It is not defined anywhere in current
   Chromium source and is not on Electron's documented switches list.
   The mapping to `kEnableReferrers` that this switch relied on only
   existed in pre-2015 Chromium forks. Appending it today is a silent
   no-op — Electron and Chromium simply ignore the unrecognized string.
   (`research/command-line-switches.md` §6)

2. **The crash-reporter switches don't establish the guarantee they were
   cited for.** `crashReporter` in Electron is strictly opt-in — nothing
   in Electron 43 starts it automatically, and crash reporting only
   begins if the codebase explicitly calls `crashReporter.start(...)`.
   `disable-breakpad` was not found defined anywhere in current Chromium
   source (Breakpad itself was replaced by Crashpad years ago); an open
   Chromium issue suggests the flag string may be silently accepted by
   legacy compatibility parsing in some code paths, but it is not a
   current, documented, guaranteed-effective control. `disable-crash-reporter`
   likewise isn't on Electron's documented switch list or found as a
   Chromium constant. In short: if the codebase never calls
   `crashReporter.start()`, no crash reporter runs regardless of these
   switches — the switches are not what is preventing crash dumps.
   (`research/command-line-switches.md` §5)

3. **The plan's WebRTC claim about no real Chromium switch existing is
   correct, but its proposed fallback is incomplete.** There genuinely is
   no `--disable-webrtc` switch and no way to remove the WebRTC API
   surface entirely in stock Chromium/Electron. But the plan missed a
   real, current, documented Electron API built for exactly this class of
   leak: `webContents.setWebRTCIPHandlingPolicy(policy)`. Setting it to
   `'disable_non_proxied_udp'` forces WebRTC to route only through a
   configured proxy or refuse to connect via UDP, which is the standard
   current mitigation for "WebRTC reveals the real IP behind a VPN/proxy."
   It does not disable WebRTC outright (peer connections and data
   channels remain present in the page's JS environment), so it needs to
   be combined with, not substituted for, the preload-script removal of
   `RTCPeerConnection`/`getUserMedia`. (`research/os-level-and-webrtc.md`
   §16)

## Decision

1. **Referrer control:** drop `no-referrers` entirely. Implement referrer
   suppression with actual interception code in the main process:
   `session.webRequest.onBeforeSendHeaders` to strip/rewrite the
   `Referer` request header, and/or `session.webRequest.onHeadersReceived`
   to inject a `Referrer-Policy: no-referrer` response header override.
   This requires real implementation code and tests, not a launch flag.

2. **Crash reporter guarantee:** stop citing
   `disable-crash-reporter`/`disable-breakpad` as the mechanism that
   prevents crash dumps. The actual, documented guarantee is **never
   calling `crashReporter.start()`** anywhere in the codebase. Enforce
   this with a CI/lint check that greps the codebase for
   `crashReporter.start(` and fails the build if it's found. Keep the two
   command-line switches in `main.js` as harmless defense-in-depth (in
   case some legacy code path still honors them), but they are not the
   primary control and must not be documented as such.

3. **WebRTC IP leak mitigation:** call
   `webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` on
   every window's `webContents` (e.g., in an
   `app.on('web-contents-created', ...)` hook, since this is a
   per-`webContents` method, not a `session`-level one, and must be
   (re-)applied to every new tab/`BrowserView`/webview) **in addition
   to**, not instead of, the preload-script deletion of
   `window.RTCPeerConnection`, `window.RTCDataChannel`, and
   `navigator.mediaDevices.getUserMedia`, and the existing
   `session.setPermissionRequestHandler` denial of `'media'` requests.
   All three layers stay; none of them alone is a complete guarantee.

## Alternatives considered

- **Keep `no-referrers` as originally written.** Rejected: a switch that
  silently does nothing is worse than no mitigation at all for this
  project, because it creates a false sense of security — the README
  would claim referrer suppression while nothing is actually happening.
  A project whose entire value proposition is "verify exactly what we
  do" cannot ship a checked box that doesn't correspond to any real
  behavior.

- **Keep citing the crash-reporter command-line switches as the primary
  guarantee.** Rejected: this doesn't address _why_ the guarantee
  actually holds. Even if the switches turn out to have some residual
  effect on Chromium's own crash handling (unconfirmed), the guarantee
  a reader actually needs — "this app does not run a crash reporter" —
  comes from the codebase never opting in via `crashReporter.start()`.
  Documenting the switches as the mechanism obscures the real control and
  gives no way to verify it beyond re-reading Chromium source on every
  version bump.

- **Keep the preload-script `RTCPeerConnection` deletion as the sole
  WebRTC mitigation.** Rejected: it's incomplete on its own. A peer
  connection object created before the preload script runs, or via a
  code path the deletion misses, survives untouched — the preload
  approach has no native-level backstop. `setWebRTCIPHandlingPolicy`
  covers exactly that gap by constraining ICE-candidate/IP-handling
  behavior at the Electron/Chromium level regardless of what JS in the
  page does. Using it alone was also rejected, since it doesn't remove
  the WebRTC API surface from the page (data channels, media capture
  APIs are all still present) — the two are complementary, covering
  different bypass paths, so both are needed.

## Consequences

- **Referrer control** now requires real interception code
  (`onBeforeSendHeaders`/`onHeadersReceived` handlers) plus tests to
  verify the header is actually stripped or overridden, instead of a
  single line appended before `app.ready`. This is more surface area to
  maintain and more surface area that can regress silently if a future
  refactor removes the handler — it needs its own test coverage, not
  just a code comment.

- **Crash reporter safety** now depends on an enforced lint/CI rule
  (grep for `crashReporter.start(`) that must keep working across every
  future PR, rather than a flag set once at launch. If the lint rule is
  ever removed, disabled, or bypassed (e.g., a dynamic string built to
  evade a naive grep), the guarantee silently disappears with no runtime
  signal. This is a process control, not a technical one, and is only as
  strong as the CI configuration enforcing it.

- **WebRTC mitigation** needs one additional main-process line
  (`setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`) applied to
  every `webContents` as new windows/tabs are created, and requires
  keeping the preload script's `RTCPeerConnection`/`getUserMedia`
  removal in sync with it. Two independent mechanisms now have to be
  maintained and tested together instead of one; a future contributor
  could remove one half (e.g., "simplify" by dropping the preload
  deletion because the native policy "already handles it") and silently
  regress coverage of the bypass path the other layer was covering.

- In all three cases, the project's documentation (`docs/threat-model.md`)
  must describe the actual mechanism and its limits, not a simplified
  version — this is more verbose than citing a single flag, but it's the
  only way the claims stay checkable against Electron/Chromium source.

## Sources

- `research/command-line-switches.md` §5 (`disable-crash-reporter` /
  `disable-breakpad`), §6 (`no-referrers`)
- `research/os-level-and-webrtc.md` §16 (WebRTC leak mitigation and
  `setWebRTCIPHandlingPolicy`)
