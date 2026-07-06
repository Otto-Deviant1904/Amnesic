# Interview notes

Working notes for talking about this project in technical interviews.
Everything here is sourced from the ADRs and `docs/threat-model.md` — if an
answer below ever drifts from those documents, the documents win.

## The one-liner

> Built and forensically verified a zero-disk-footprint Chromium browser
> (Electron); automated filesystem-diff verification in CI; fail-closed Tor
> transport.

## Per-ADR: what / why / what I learned

**ADR 0002 — Electron 43 flag and API corrections.**
What: audited every planned mitigation against the pinned Electron/Chromium
version and found three were wrong — a dead switch (`no-referrers`), crash-
reporter switches that don't establish the guarantee attributed to them,
and an incomplete WebRTC story. Why: the project's credibility rests on
each control doing exactly what's claimed. Learned: my memory of Chromium
flags is training data of unknown vintage; the only trustworthy source is
the pinned version's own source and docs, and every verification needs a
written citation or it will be re-litigated later.

**ADR 0003 — WebRTC removal via CDP, not preload.**
What: replaced a preload-script `delete window.RTCPeerConnection` design
with CDP `Page.addScriptToEvaluateOnNewDocument` via `webContents.debugger`.
Why: with `contextIsolation: true`, preload and page live in separate JS
realms — the preload delete is a complete silent no-op. Learned: an
accepted ADR can still be wrong; the process has to allow superseding a
prior decision with evidence. Also: the failure mode I most fear is not a
bug that breaks, it's a mitigation that silently does nothing.

**ADR 0004 — the footprint verifier and the residue it found.**
What: turned the always-failing verifier stub into a real
scripted-session-plus-filesystem-diff CI gate; it immediately found the
tmpfs dir outliving exit, Mesa/fontconfig writing to real `~/.cache`, and
Electron's default download path being live. Why: an unverified guarantee
is an assertion. Learned: the verifier is worth more than any individual
mitigation — three gaps were invisible to code review because the code
looked like the design. Also the zygote lesson: env mutations in main never
reach forked children; only a relaunch bootstrap gets `XDG_CACHE_HOME`
there.

**ADR 0005 — usability inside the amnesic envelope.**
What: context menus, find-in-page, basic-auth dialog, in-shell error pages
(no bad-cert bypass), fullscreen permission carve-out, favicons fetched by
main through the tab session as size-capped data: URIs. Why: an unusable
privacy tool protects nobody because nobody uses it. Learned: every
"table-stakes" feature has a privacy-relevant design axis — e.g. the naive
favicon `<img>` would have had the privileged shell session fetching
page-controlled URLs.

**ADR 0006 — packaging and distribution.**
What: Linux-only AppImage, no auto-updater (`publish: null`), tag-push
release workflow with SHA256SUMS, single-instance via a tmpfs unix socket
instead of Electron's real-disk lock. Why: distribution machinery must
obey the same charter as the app. Learned: ecosystem defaults fight you —
electron-builder silently bakes updater metadata and injects `--no-sandbox`
into the AppImage launcher unless explicitly stopped; you have to extract
and inspect your own package to know what you shipped.

**ADR 0007 — Tor/SOCKS5 integration.**
What: bring-your-own-Tor SOCKS5 proxying applied to both sessions, with
proxy-side DNS resolution and a fail-closed kill-switch (unreachable proxy
⇒ navigation fails, never silent direct fallback); verified against a
hand-rolled hermetic SOCKS5 server in e2e. Why: the disk story says
nothing about the wire. Learned: state the limits as prominently as the
feature — this is transport privacy, not Tor Browser anonymity parity (no
uniform fingerprint, no control port). And one empirical surprise:
Chromium still bypasses the proxy for localhost even with an empty bypass
list — the e2e suite asserts that honestly instead of hiding it.

**ADR 0008 — `app.relaunch()` crashes the packaged AppImage.**
What: v0.1.0 shipped unlaunchable; the documented relaunch idiom dies
during native startup under the AppImage FUSE mount; replaced with a
manual spawn of the same binary with the environment preset. Why: the
tmpfs bootstrap requires a relaunch-shaped step. Learned: "works in dev"
spans a narrower world than I thought — the packaging format itself was
the variable. Debugging with zero stderr from the child forced
first-principles instrumentation (a file-write at the first line of main
to see whether the process ever reached JS).

**ADR 0009 — New Identity rotates the partition rather than clearing it.**
What: mid-session reset abandons the old session object entirely
(`inmemory-session-<n>`, monotonic counter) instead of trusting
`clearStorageData()` to enumerate every storage type forever; both startup
and rotation call one shared `hardenSession()`. Why:
`session.fromPartition(name)` returns the same object for the app's
lifetime, so clear-in-place and rotate are genuinely different guarantees.
Learned: prefer designs whose safety doesn't depend on an enumeration
staying complete across future versions; and when two code paths must
apply identical hardening, make them literally the same function — the
refactor was the real deliverable.

**ADR 0010 — DNS-over-HTTPS toggle.**
What: `app.configureHostResolver` with exactly two providers (Quad9,
Mullvad), no free-text field, greyed out (selection preserved) under Tor.
Why: with Tor off, plaintext DNS is the loudest signal an on-path observer
gets. Learned: "off" states need design too — mapping the app's off to
Chromium's `automatic` rather than `off`, because forcing plaintext-only
would be worse than doing nothing. And: define precedence explicitly when
two network features could race for the same traffic.

## The five hardest questions (and honest answers)

**1. "Why is this not snake oil?"**
Because the claim is narrow and machine-checked. One promise — nothing
recoverable on disk after exit — verified on every push by a filesystem
diff around a scripted session that deliberately tries to persist data
through every mechanism in the threat model. The threat model enumerates
what is _not_ protected (fingerprinting, RAM, swap) with the same
prominence as what is. Snake oil is defined by unfalsifiable breadth; this
project's claim is falsifiable by running one script — and early versions
_were_ falsified by it (ADR 0004), which is the strongest evidence the
check is real.

**2. "What breaks your guarantee?"**
Known and documented: OS swap or hibernation while running (we detect and
warn, cannot prevent); a live attacker reading RAM; tmpfs contents between
a _crash_ (not clean exit) and reboot — cleanup runs on the exit path, so
a SIGKILL leaves the per-pid tmpfs dir until reboot (RAM-backed, so never
past reboot); the crash-reporter guarantee is a CI grep, so a future PR
weakening CI silently removes it; and anything outside the process's
control that independently logs (shell history, DNS at the resolver when
DoH/Tor are off, the network itself when Tor is off).

**3. "Why Electron for a privacy tool? Isn't that huge/leaky?"**
Considered Tauri (system WebView) and rejected it deliberately: the whole
project is about controlling the browser engine's disk behavior, and
Electron pins one exact Chromium version I can verify switches against —
a system WebView is whatever version the OS ships, with per-distro storage
behavior I can't pin or audit. The engine's size is the threat surface I'm
managing, not a reason to use an engine I can't manage. The honest cost:
Chromium's defaults are hostile to this use case, which is why the
verifier, not the framework, is the trust anchor. (Note: the
electron-vs-tauri ADR is referenced as 0001 in project docs.)

**4. "Chromium already has incognito. Why is this different?"**
Incognito is a mode inside a browser whose profile machinery keeps
running: `Local State` is still written, GPU/shader caches still land on
disk, crash dumps still capture memory, and the mode's own guarantee is
just "we delete these categories when the window closes" — asserted, not
demonstrated. This app inverts the architecture: there is no persistent
profile at all, everything lands in RAM by construction, and the claim is
demonstrated by diffing the filesystem, not by trusting the deletion code.

**5. "How do you know your verifier itself isn't blind?"**
Partially, I don't — and the docs say so. It has a documented noise
allowlist that could theoretically mask a leak (each entry is justified);
it demonstrates one run on one machine, not all possible runs; and it
can't see below the filesystem (block-level remnants, swap). Mitigations:
the scripted session was designed adversarially from the threat model's
artifact table (each row names the file it would create — the session
tries to create all of them); the tmpfs assertions are positive checks
(the dir must exist mid-run — proving the redirect happened — and be gone
after); and CI is the authoritative environment because dev machines are
noisy. Inviting external scrutiny of the verifier is explicitly part of
the launch plan.

## Rapid-fire facts worth having loaded

- Pinned: `electron@43.0.0` / Chromium 150.0.7871.46. Every switch cited
  against this version in `research/`.
- The AppImage ships **with** the Chromium sandbox (unusual for Electron
  AppImages — most inject `--no-sandbox`); on Ubuntu 23.10+ it refuses to
  start rather than run unsandboxed.
- `clearAuthCache()` at exit is belt-and-suspenders — the partition being
  non-persistent is the primary control; knowing which of two mechanisms
  is load-bearing is a recurring theme.
- Playwright/CDP-injected keys never reach Electron's `before-input-event`
  — main-process-only shortcuts must be e2e-tested via
  `webContents.sendInputEvent()`. Found empirically; documented in
  `research/cleanup-and-exit.md` §20.
- `/proc/<pid>/environ` is clobbered by Chromium's setproctitle — verify
  environment by behavior, not by reading environ.
