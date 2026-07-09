# Command-line switches — verified against Electron 43.0.0

**Date:** 2026-07-01
**Pinned version confirmed from package.json:** `electron@43.0.0`
**Chromium base confirmed:** 150.0.7871.46 (Node.js 24.17.0, V8 15.0.245.13) — via releases.electronjs.org/release/v43.0.0

**Re-verified 2026-07-09 for the bump to `electron@43.1.0`:** Chromium
150.0.7871.47, Node.js 24.18.0 — via the v43.1.0 GitHub release notes
(api.github.com/repos/electron/electron/releases/tags/v43.1.0). The release
contains one fix (a crash when replacing an open application menu, #52276)
plus the Chromium/Node patch bumps; no change to switch handling,
`disable-features` flag names, WebRTC behavior, or the fuses API. Chromium
stays on the same 150 branch, so every per-switch verdict below (including
the `no-referrers` dead-switch verdict) carries over unchanged.

All switches below are appended via `app.commandLine.appendSwitch(...)` before `app.ready`, as the plan proposes. Verified against Electron's own `docs/api/command-line-switches.md` (the authoritative list of switches Electron itself documents/implements or explicitly passes through) plus Chromium source (`chromium.googlesource.com/chromium/src`, HEAD) for switches Electron doesn't document itself.

## 1. `disable-http-cache`

**Verified: TRUE, still valid.**
This is one of the small set of switches Electron documents itself (not just inherited silently from Chromium): "Disables the disk cache for HTTP requests." Confirmed present verbatim on `https://www.electronjs.org/docs/latest/api/command-line-switches` as of the v43 docs.

- Source: https://www.electronjs.org/docs/latest/api/command-line-switches
- Caveat: this only affects the HTTP disk cache. It does not affect the GPU shader cache (separate switch, see #2) or Code Cache (V8 compiled-script cache), which Chromium stores separately under `GPUCache`/`Code Cache` in `userData`. Since the plan's primary mitigation is redirecting `userData` to tmpfs (Section 4.2), this switch is defense-in-depth on top of that, not a substitute for it — keep both.

## 2. `disable-gpu-shader-disk-cache`

**Verified: TRUE, still valid.**
Defined in current Chromium source as `kDisableGpuShaderDiskCache = "disable-gpu-shader-disk-cache"` in `gpu/config/gpu_switches.cc`, with the comment "Disables the GPU shader on disk cache." This is a raw Chromium switch (not separately documented by Electron, but Electron passes all unrecognized switches through to Chromium via `appendSwitch`, so it works).

- Source: https://chromium.googlesource.com/chromium/src/+/HEAD/gpu/config/gpu_switches.cc
- Caveat: it lives in a different file/module (`gpu/config`) than where older references point (`gpu/command_buffer/service/gpu_switches.cc` no longer defines it — it moved at some point in Chromium's history). The switch string itself is unchanged and still functions the same way. No code change needed.

## 3. `disable-background-networking`

**Verified: TRUE, still valid, description confirmed.**
Defined in `chrome/common/chrome_switches.cc` as `kDisableBackgroundNetworking = "disable-background-networking"`. Exact current comment in source: "Disable several subsystems which run network requests in the background. This is for use when doing network performance testing to avoid noise in the measurements."

- Source: https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_switches.cc
- What it actually suppresses (per Chromium's own historical design doc + source comment): IntranetRedirectDetector probes, background extension/component update checks, and other background service pings. **Caveat:** this switch was designed for benchmarking noise-reduction, not as a formal privacy control — Chromium does not guarantee it is an exhaustive kill-switch for "all phone-home behavior." Treat it as one layer, not the whole mitigation. It does **not** on its own disable Safe Browsing or the component updater — those need their own switches (see #4 and the Safe Browsing note in `os-level-and-webrtc.md`).

## 4. `disable-component-update`

**Verified: TRUE, still valid.**
Defined in `chrome/common/chrome_switches.cc` as `kDisableComponentUpdate = "disable-component-update"`, confirmed present in current source.

- Source: https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_switches.cc
- **Widevine CDM caveat:** Widevine CDM is downloaded/updated through Chromium's component updater service, so this switch does suppress Widevine component _update checks_. However: (a) Electron does not ship Widevine at all by default — it requires the separate `electron-widevinecdm` / castlabs "Electron with Widevine" fork, or manual component registration; stock `electron@43.0.0` from npm has no Widevine component to update in the first place, so this part of the claim is moot for this project's stack unless DRM playback is added later (which the plan correctly scopes out for v1). (b) This switch is a blunt instrument — it disables the _entire_ component updater, not just Widevine, which also covers things like the Certificate Transparency component. That's consistent with what the plan wants (no v1 DRM, minimize background services), so no change needed, just note the "also covers CT logs / other components" side effect for the README's known-limitations section.

## 5. `disable-crash-reporter` / `disable-breakpad`

**Verified: PARTIALLY — code change recommended.**

- `crashReporter` in Electron is confirmed **strictly opt-in**. Per Electron's crash-reporter docs: crash reporting only begins if you explicitly call `crashReporter.start(...)`, and this should be done "as early as possible in app startup, preferably before `app.on('ready')`." Nothing in Electron 43 auto-starts it. **This means: if the codebase never calls `crashReporter.start()`, no crash reporter is running, and the two command-line switches are redundant, not load-bearing.**
  - Source: https://www.electronjs.org/docs/latest/api/crash-reporter
- `disable-breakpad`: Breakpad itself was replaced by Crashpad in Chromium years ago (Electron's own breaking-changes log notes the Linux crash handler switched from Breakpad to Crashpad as of Electron 16, matching upstream Chromium history). I could **not** find `kDisableBreakpad` defined anywhere in current Chromium source (checked `chrome_switches.cc`, `content_switches.cc`, `components/embedder_support/switches.cc`, `base/base_switches.cc`). A still-open Chromium issue (`issues.chromium.org/issues/41178289`, "Chrome crashes when using --disable-breakpad flag") suggests the flag string may still be silently accepted/parsed by legacy compatibility code in some paths, but it is **not a current, documented, guaranteed-effective switch** — treat it as legacy cruft, not a real control.
- `disable-crash-reporter`: not found in Electron's own documented switches list, and not found as a Chromium constant in the files checked. Likely a no-op string today.
- **Recommendation:** Drop reliance on both switches as the "crash reporting is off" guarantee. The actual guarantee comes from **never calling `crashReporter.start()`** in the codebase — make that the documented control (e.g., an ESLint rule or CI grep banning `crashReporter.start(` from ever landing), not the command-line switches. Keep the switches as harmless defense-in-depth if you like, but don't cite them in the README as the mechanism that disables crash reporting.

## 6. `no-referrers`

**Verified: FALSE / stale — needs replacement.**
Historically `--no-referrers` mapped to the `kEnableReferrers` preference (setting it to `false`) via `command_line_pref_store.cc` in very old Chromium (pre-2015-era code, seen in the `adobe/chromium` fork mirror from that period). I could **not** find this switch defined anywhere in current Chromium source (`chrome_switches.cc`, `content_switches.cc`, `components/embedder_support/switches.cc` all checked — absent). It is not on Electron's documented switches list either.

- **Verdict: stale/removed. Do not rely on it** — appending it is very likely a silent no-op in Electron 43 / Chromium 150.
- **Current correct approach:** Referrer policy today is controlled per-navigation/per-document via the `Referrer-Policy` HTTP header or `<meta name="referrer">`, which sites set themselves — Chromium's own default policy is `strict-origin-when-cross-origin` (reduced referrer, not "no referrer"). To force stricter behavior app-wide, intercept responses/requests in the main process with `session.webRequest.onBeforeSendHeaders` and strip/rewrite the `Referer` header yourself, or use `session.webRequest.onHeadersReceived` to inject a `Referrer-Policy: no-referrer` response header override. This needs actual implementation code — there is no single command-line switch equivalent in modern Chromium.
- Source (negative-result check): https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/common/chrome_switches.cc and https://chromium.googlesource.com/chromium/src/+/HEAD/content/public/common/content_switches.cc

## 7. `disable-features` list: `Translate,OptimizationHints,MediaRouter`

**Verified: TRUE, all three names still current in Chromium 150.**

- `Translate` — disables the built-in translate popup/manual translate option. Still a valid, current feature name.
- `OptimizationHints` — disables Chrome's Optimization Guide and its networking calls to Google's hints service. Still current.
- `MediaRouter` — disables Chrome's Media Router (Cast target discovery), which otherwise generates background network/mDNS activity. Still current.
- Caveat: a filed Chromium bug (`issues.chromium.org/issues/41347677`, formerly crbug 770776) notes `--disable-translate` (the _old_, pre-`base::Feature` style switch) is ignored/broken — this is exactly why the plan correctly uses the newer `--disable-features=Translate` form instead of the deprecated standalone switch. No change needed; the plan already uses the right mechanism.
- Source: general Chromium feature-flag documentation (`base::Feature` API) cross-referenced against current usage; no renames found for Electron 43 / Chromium 150 specifically.
