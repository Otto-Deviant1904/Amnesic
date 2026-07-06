# A browser that forensically proves its own amnesia

_How I built a zero-disk-footprint Chromium browser on Electron, what
"private browsing" actually leaves behind, and the four bugs that taught me
never to trust my own memory of an API._

---

## The claim

Amnesic Browser makes exactly one promise: **nothing recoverable is left on
disk once the process exits.** No history, no cookies, no cache, no crash
dumps, no OS-level breadcrumbs from the app itself.

That's a much narrower promise than "private browsing," and the narrowness
is the point. It is not an anonymity tool (websites can still fingerprint
you during a session), it is not immune to live RAM forensics (no browser
is), and it cannot stop the OS from swapping page content to disk (it warns
you if disk-backed swap is active, which is all a userspace process can
honestly do). What it can do — and, more importantly, _prove_ it does — is
leave a machine forensically indistinguishable, on disk, from one where the
browser was never run.

Why is that hard? Because Chromium's disk surface is enormous and mostly
invisible. Open any Chromium-based browser's profile directory and count
what accumulates without you asking for any of it:

- `Local State` — global preferences, written on every launch
- `GPUCache/` and the GPU shader disk cache — compiled shaders keyed to
  what you rendered
- `Crashpad/` — crash dumps containing arbitrary process memory
- `Dictionaries/` — spellcheck dictionaries downloaded in the background
- `Partitions/*` — cookies, LocalStorage, IndexedDB, Cache API, service
  worker registrations
- the HTTP disk cache itself

And that's just Chromium. The GPU process also writes _through the system
graphics stack_: Mesa's shader cache and fontconfig's cache land under
`~/.cache`, written by libraries that are not Chromium code and answer to
no Chromium flag. "Incognito mode" in mainstream browsers addresses a
slice of this surface — cookies and history — while the rest keeps being
written. A private _mode_ inside a non-private browser inherits the whole
profile machinery around it.

So the design goal became: instead of chasing every write with a disable
flag, make the writes land somewhere that ceases to exist.

## The architecture, in one diagram

```
                     ┌───────────────────────────────────────────┐
                     │  RAM (tmpfs: /dev/shm)                    │
                     │                                           │
   app.setPath ────► │  /dev/shm/amnesic-browser-<pid>/          │
   (before ready)    │    ├── Local State, Partitions/, …        │
                     │    └── xdg-cache/   ◄──── XDG_CACHE_HOME  │
                     │         (Mesa, fontconfig, GPU process)   │
                     └───────────────┬───────────────────────────┘
                                     │ deleted by cleanupAndExit()
                                     ▼ before app.exit(0)
                                  (nothing)

   Tab content lives in session.fromPartition('inmemory-session-<n>')
   — no `persist:` prefix ⇒ memory-only, never touches even the tmpfs.
   Every wipe trigger (last tab closed, Ctrl+Shift+Q panic key) funnels
   into the same single cleanupAndExit() routine: clear both sessions'
   storage/cache/auth caches, rmSync the tmpfs dir, exit.
```

Three layers, from inside out:

1. **The tab session is memory-only.** Page storage (cookies,
   LocalStorage, IndexedDB, Cache API) lives in a non-persistent Electron
   session partition — the kind you get when the partition name has no
   `persist:` prefix. It never materializes as files anywhere.
2. **Everything else Chromium writes goes to tmpfs.** Before the app is
   ready, `userData` is redirected to a per-pid directory under
   `/dev/shm`, which on Linux is RAM-backed by default. `Local State`,
   GPU caches, anything a future Chromium version invents — it all lands
   in RAM. `XDG_CACHE_HOME` is pointed inside that same directory so the
   non-Chromium writers (Mesa, fontconfig) land there too.
3. **Exit deletes the tmpfs directory.** tmpfs contents survive process
   exit until reboot, so the exit routine explicitly clears both sessions
   and removes the directory before `app.exit(0)`.

Belt-and-suspenders switches (`disable-http-cache`,
`disable-gpu-shader-disk-cache`, …) sit on top, but the threat model is
explicit that the tmpfs redirect is the primary control and the switches
are defense-in-depth — not the other way around.

Since v0.3.0 there's also an opt-in network story (fail-closed SOCKS5/Tor
routing with proxy-side DNS, and a DNS-over-HTTPS toggle), but this post is
about the disk claim; the network design has its own ADRs (0007, 0010) and
its own honestly-stated limits.

## Four war stories with receipts

The project's engineering rule that shaped everything: **every Chromium
switch and Electron API is verified against the exact pinned version
(`electron@43.0.0`, Chromium 150.0.7871.46), not against general knowledge
or tutorials.** That rule exists because general knowledge failed four
times. Each failure would have shipped a mitigation that looked correct and
did nothing — which, for a privacy tool, is worse than shipping nothing.

### 1. The dead flag: `--no-referrers` (ADR 0002)

The original plan suppressed `Referer` headers with
`app.commandLine.appendSwitch('no-referrers')`. Plausible — that switch
appears in a decade of Stack Overflow answers. It is also **dead**: the
mapping to `kEnableReferrers` it relied on only existed in pre-2015
Chromium. Current Chromium doesn't define it anywhere, and unrecognized
switches are silently ignored. No warning, no error — the app would have
sent referrers exactly as before while the docs claimed otherwise.

The fix is real interception: `webRequest.onBeforeSendHeaders` strips the
header on the way out. The lesson generalized into the project's research
protocol: a switch only counts if you can find it in the pinned Chromium's
own source (`chrome_switches.cc`, `content_switches.cc`, …), and every
verification gets a citation in `research/`.

### 2. The wrong realm: deleting WebRTC in a preload script (ADR 0003)

WebRTC can leak your real IP through ICE candidates even behind a proxy.
One mitigation layer was to delete `window.RTCPeerConnection` before page
scripts run — and the obvious place to do that is a preload script.

Except this app (like every responsibly configured Electron app) runs with
`contextIsolation: true`, and under context isolation the preload script's
`window` is a **different JavaScript object** from the page's — separate
realms by design. `delete window.RTCPeerConnection` in preload deletes the
property on the preload's isolated copy. The page's own
`RTCPeerConnection` remains fully functional. A silent, complete no-op —
the same failure class as the dead flag, one layer up the stack.

The working mechanism is the Chrome DevTools Protocol:
`webContents.debugger` + `Page.addScriptToEvaluateOnNewDocument`, which
injects into the page's _own main-world realm_ before any page script
executes (it's the same mechanism Playwright's `addInitScript` uses). The
uncomfortable part of this story: the broken preload design had already
been written into an accepted ADR. Verification isn't a phase you pass
once; ADR 0003 exists to supersede a specific decision in ADR 0002.

### 3. The API that does the opposite: `setJumpList(null)`

On Windows, the taskbar Jump List tracks recently visited items. The
intuitive cleanup call is `app.setJumpList(null)` — null, meaning "no jump
list," right?

No. Passing `null` **restores Windows' default automatic Jump List** —
the recent/frequent tracking you were trying to remove. Only an _empty
array_ clears the custom list, and the thing that actually feeds the
tracking is `app.addRecentDocument()`, which must simply never be called —
a guarantee enforced by a CI grep, because no runtime setting expresses
"and never in the future, either."

This one never shipped wrong — it was caught at threat-model-writing time —
but it earned its row in the model because it's the purest example of the
genre: an API where the plausible reading of the argument does the exact
inverse of what it does.

### 4. The verifier catching real residue (ADR 0004)

For its first few weeks, `scripts/verify_footprint.sh` was a stub that
always failed — the project's core claim was _engineered_ but never
_demonstrated_. Making the verifier real was the most important commit in
the repo, because it immediately found that the claim was false.

The verifier drives the built app through a scripted session designed to
tempt every persistence mechanism (persistent cookies, LocalStorage,
IndexedDB, Cache API, a `Content-Disposition: attachment` download), exits,
and diffs the filesystem. First real runs found:

1. **The tmpfs directory outlived the process.** tmpfs contents persist
   until reboot. The exit routine cleared session data through Chromium's
   APIs but never deleted `/dev/shm/amnesic-browser-<pid>` itself — so
   `Local State` and the leveldb files backing Local Storage sat there,
   readable by any local process, until reboot. Direct violation of the
   headline claim; fixed by deleting the directory in the exit routine,
   asserted on every run since.
2. **Mesa and fontconfig were writing to real disk.** No Chromium switch
   covers them because they aren't Chromium. And you can't just set
   `process.env.XDG_CACHE_HOME` at startup — Chromium's zygote processes
   fork before your main script's env mutation can matter, so children
   never see it. The fix is a one-time relaunch bootstrap so every child
   inherits the RAM-backed cache path from birth. (That bootstrap later
   produced its own war story — `app.relaunch()` crashes inside a packaged
   AppImage's FUSE mount, ADR 0008 — verification is turtles all the way
   down.)
3. **Downloads were live.** "Downloads manager is a non-goal" was written
   in the project constitution, but a non-goal is a policy, not a
   mechanism: with no `will-download` handler, Electron's _default_ is to
   open the GTK save dialog and write wherever the user picks — and GTK's
   file chooser then logs the file into `~/.local/share/recently-used.xbel`
   on its own. Every session now cancels every download, with a visible
   "download blocked" notice.

Three gaps, two of them silent violations of the core claim, all invisible
to code review — the code _looked_ like it implemented the design. Only an
empirical filesystem diff caught them.

## What it deliberately doesn't do — and why saying so matters

The non-goals list is enforced as hard as the features: no bookmarks, no
downloads, no extensions, no password manager or autofill, no telemetry of
any kind, no auto-updater. Some of these are missing features; several are
load-bearing _absences_. Autofill data lives in `Web Data` and
`Login Data` files — the strongest mitigation for a file is a feature that
never exists. An auto-updater is phone-home machinery by definition (and
electron-builder had to be explicitly stopped from baking updater metadata
into the package — it auto-detects a GitHub publish config from
`package.json` and quietly adds `app-update.yml`).

The limits get equal billing with the features, in a threat model that
names each one: swap/hibernation can leak page content and no userspace
process can prevent it; live RAM forensics works on every browser; websites
can fingerprint you during the session; even in Tor mode, Chromium's
default proxy-bypass still routes `localhost` destinations directly
(confirmed empirically in the e2e suite, not assumed from docs); the
crash-reporter guarantee rests on a CI lint rule with no runtime signal,
and the threat model says exactly that instead of pretending there's a
runtime check.

This candor isn't modesty theater — it's the product. A privacy tool that
overstates one claim gives you no reason to believe any of its claims. The
start page even carries a self-audit panel that runs live checks in the
running process (is userData really on tmpfs _right now_? is the partition
really non-persistent?) and explicitly labels each row "checked now" versus
"enforced by CI" — because presenting a lint-enforced guarantee as a
runtime check would be exactly the overselling the project exists to avoid.

## Verification methodology: the filesystem diff as CI gate

The heart of the trust story is ~200 lines of shell and Node:

1. **Snapshot** the filesystem state (home directory and the app-relevant
   paths, with a documented noise allowlist).
2. **Drive a real session** against a local hermetic HTTP server whose one
   page deliberately sets persistent cookies, LocalStorage, sessionStorage,
   IndexedDB, and Cache API entries, and serves an attachment download —
   every persistence mechanism the threat model claims to neutralize.
   Mid-session it also fires "New Identity" (the mid-run session rotation),
   because a subsystem that isn't exercised by the verifier is an
   assertion, not a guarantee.
3. **Assert during the run** that the tmpfs userData directory exists (the
   redirect actually happened) — and **after exit** that it is gone.
4. **Diff** the filesystem and fail on any unexplained new or modified
   file.

This runs in CI on every push, and no PR touching session, storage, or
cache handling merges without it. Alongside it, CI greps enforce the
"never call X" class of guarantee: `crashReporter.start(` must not appear
in the codebase, ever (that grep once flagged the self-audit panel's own
descriptive text for containing the banned string — the text was reworded;
the grep was not weakened).

The methodology's honest limit: a filesystem diff proves what happened on
_this_ run, on _this_ machine, with _this_ kernel and graphics stack. It's
an empirical demonstration, not a formal proof. But it's a class stronger
than the industry default for privacy claims, which is: trust the
changelog.

---

_Amnesic Browser is open source (Apache-2.0):
<https://github.com/Otto-Deviant1904/Amnesic>. Start with
`docs/threat-model.md` — it's the document the whole project answers to —
and the ADRs in `docs/adr/`, which record every decision above including
the wrong turns. Scrutiny of `scripts/verify_footprint.sh` is especially
welcome: if the verifier has a blind spot, the claim does too._
