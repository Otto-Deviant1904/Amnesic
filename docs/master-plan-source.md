# Project Amnesia: A Zero-Footprint Local Browser

### Full Architecture, Build & Verification Report

**Prepared for:** Harsh
**Scope:** A desktop app that behaves like a real browser (tabs, address bar, back/forward) but is engineered so that closing the window leaves _no recoverable trace_ on disk — no history, no cookies, no cache, no OS-level breadcrumbs. Think Tails OS's amnesic principle, applied to a single application instead of a whole OS.

This report is organized as if four specialists reviewed the project independently and then merged their findings: a **Systems/Architecture engineer**, a **Security/Forensics engineer**, a **Network engineer**, and a **Release/Build engineer**. Each section is written from that lens, then there's a unified build roadmap at the end.

---

## 1. Threat Model First (this decides every downstream choice)

Before any code, define exactly what you're defending against, because "no footprint" means different things:

| Threat                                                     | In scope?                  | Why                                                                                                                                           |
| ---------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Forensic disk analysis after the app closes                | **Yes — primary goal**     | This is the core promise: nothing recoverable from disk.                                                                                      |
| A live attacker with RAM access _while the app is running_ | Partial                    | RAM will always contain plaintext page content while browsing — no browser avoids this. You can minimize residency time but not eliminate it. |
| Network-level observer (ISP, Wi-Fi owner)                  | Optional, separate concern | Local footprint ≠ network footprint. Tor/VPN is a different subsystem you can bolt on later.                                                  |
| The websites themselves fingerprinting/tracking you        | Optional, separate concern | This is anti-fingerprinting (canvas, WebGL, font enumeration) — a different, larger problem than local footprint.                             |
| OS swap/hibernation files leaking page content             | **Yes**                    | This is the #1 way "zero footprint" apps quietly fail. Covered in Section 4.                                                                  |
| Crash reports / telemetry phoning home                     | **Yes**                    | Chromium and most frameworks do this by default and it writes to disk _and_ network.                                                          |

**Decision for v1:** Optimize hard for "nothing recoverable from disk once the process exits." Treat anti-fingerprinting and network anonymity as v2/v3 features, not blockers. Trying to solve all four at once is why most "private browser" side projects stall.

---

## 2. Architecture Overview (Systems Engineer's view)

### 2.1 Framework choice: Tauri vs Electron

|                            | Electron                                                                             | Tauri                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering engine           | Bundles Chromium (full control, consistent behavior)                                 | Uses OS's native webview (WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux)                                                       |
| Binary size                | ~150–200MB                                                                           | ~10–20MB                                                                                                                                  |
| Footprint control          | Very fine-grained — Chromium flags let you disable almost everything                 | Less uniform — three different rendering engines behave differently per-OS, meaning your "leaves no trace" guarantees differ per platform |
| Maturity for this use case | High — Tor Browser, Brave, etc. all fork Chromium and expose these same session APIs | Lower — you'd be fighting three separate webview implementations' cache behaviors                                                         |

**Recommendation: Electron.** For this specific project, controllability beats binary size. You need one engine whose disk-write behavior you can fully enumerate and disable, not three. Tauri is the better choice for a general-purpose app; it's the worse choice when the entire point of the app is "we know exactly what touches disk."

### 2.2 Process model

Standard Electron multi-process model, with one critical change from a normal Electron app:

```
Main Process (Node.js)
  ├─ owns app lifecycle, window creation
  ├─ creates ONE in-memory, non-persistent session
  ├─ intercepts and blocks specific disk-writing subsystems (Section 4)
  └─ on window-close: triggers explicit wipe + exits (no background/tray mode)

Renderer Process(es) — one per tab
  ├─ sandboxed (sandbox: true, contextIsolation: true)
  ├─ no nodeIntegration in renderer (security best practice regardless)
  └─ all bound to the same in-memory session partition

Preload script
  └─ minimal — just exposes a safe IPC bridge for tab management (new tab, navigate, back/forward)
```

Key architectural rule: **no persistent `userData` directory at all.** Electron's default behavior creates `app.getPath('userData')` on disk (`~/.config/AppName` on Linux, `%APPDATA%\AppName` on Windows, `~/Library/Application Support/AppName` on macOS) and Chromium writes dozens of files there unless you redirect it. You are going to redirect this entire path into memory (Section 4.2).

### 2.3 Tab & session strategy

- Single shared **in-memory partition** across all tabs (`session.fromPartition('inmemory-session', { cache: false })` — critically, **no `persist:` prefix**, which is what makes it memory-only instead of disk-backed).
- Every tab is a `<webview>` or `BrowserView` attached to that same session, so cookies/logins persist _within_ a browsing session (so you can actually log into something mid-session) but vanish entirely on close.
- Optional v1.5 feature: a "New Identity" button (Tor Browser's model) that destroys and recreates the session object without closing the whole app — clears cookies/storage for a fresh start without restarting.

---

## 3. Security / Forensics Engineer's view: What "footprint" actually means

This is the section most people skip, and it's the one that actually determines if your claim is true. A forensic examiner doesn't just check `~/.config/YourApp` — they check the whole system. Here is the full enumeration of places a browser can leave traces, and the mitigation for each.

### 3.1 Application-level disk writes (Chromium's own behavior)

| Artifact                                                                | Default location                                                                                                                                                    | Mitigation                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookies / LocalStorage / IndexedDB / Cache API / Service Workers        | `userData/Partitions/*`                                                                                                                                             | In-memory session partition (Section 2.3) — never touches disk                                                                                          |
| HTTP disk cache                                                         | `userData/Cache`, `GPUCache`                                                                                                                                        | `session.setPreloads([])`; launch with `--disk-cache-dir=` pointed at a tmpfs path, or disable via `app.commandLine.appendSwitch('disable-http-cache')` |
| GPU shader cache                                                        | `userData/GPUCache`                                                                                                                                                 | `app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')`                                                                                         |
| `Local State` file (Chromium's global prefs, includes some identifiers) | `userData/Local State`                                                                                                                                              | Redirect entire `userData` to a RAM-backed path (Section 4.2)                                                                                           |
| Crashpad / crash dumps                                                  | `userData/Crashpad`                                                                                                                                                 | `app.commandLine.appendSwitch('disable-crash-reporter')`; also `crashReporter` — never call `.start()`                                                  |
| Network log / NetLog                                                    | only if you explicitly enabled `--log-net-log`                                                                                                                      | Just don't enable it                                                                                                                                    |
| Session storage / "restore previous session" data                       | Electron doesn't do this by default (unlike Chrome) — but double check you never call session-restore APIs                                                          | N/A if you don't build the feature                                                                                                                      |
| Spellchecker dictionaries                                               | `userData/Dictionaries`                                                                                                                                             | `session.setSpellCheckerEnabled(false)` or redirect path                                                                                                |
| Component updater (Widevine CDM, etc.)                                  | `userData/WidevineCdm` etc.                                                                                                                                         | Disable component updater switches; you don't need DRM playback for v1                                                                                  |
| Favicons                                                                | `userData/Favicons` (Chrome does this; Electron less aggressively, but `<webview>` may cache favicon images via normal cache — covered by disk cache disable above) |
| Autofill / form data / saved passwords                                  | `userData/Web Data`, `Login Data`                                                                                                                                   | Never implement autofill/password manager features in v1 — don't give yourself something to forget to disable                                           |

### 3.2 OS-level artifacts (outside the app's own folder — the part people forget)

This is the list that separates "looks private" from "actually forensically clean." These are written by the **operating system**, not your app, purely because a window existed and a process ran.

| Artifact                                                 | OS                    | What it is                                                                                                                                                                                       | Mitigation                                                                                                                                                                               |
| -------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Swap file / pagefile**                                 | All                   | If the OS runs low on RAM, it can write your in-memory session data (page contents, cookies) to disk as swap. This is the single biggest hole in any "in-memory only" privacy claim.             | Ideally instruct the user to run with swap disabled or encrypted swap. You cannot fully control this from inside your app — document it clearly as a known limitation (see Section 3.4). |
| **Hibernation file** (`hiberfil.sys` on Windows)         | Windows               | If the machine hibernates while your app is open, the entire RAM contents — including your "in-memory" session — get written to disk in plaintext (or encrypted, depending on BitLocker config). | Document as a known limitation. Optionally detect and warn the user if hibernation is enabled.                                                                                           |
| **Jump Lists / Recent Items**                            | Windows               | Windows tracks recently opened files/apps for taskbar right-click menus                                                                                                                          | Set `app.setJumpList(null)`; don't register file associations                                                                                                                            |
| **Recents (macOS)**                                      | macOS                 | Similar recent-items tracking                                                                                                                                                                    | Don't use `NSDocument`-based APIs; Electron apps are fine here by default since there's no "document" concept, but verify no file dialogs are used that register recents                 |
| **`recently-used.xbel`**                                 | Linux (GTK-based DEs) | GTK file chooser tracks recently opened files                                                                                                                                                    | Only relevant if you add file open/save dialogs — avoid or pass `properties: ['dontAddToRecent']` in Electron's dialog API                                                               |
| **Thumbnail cache**                                      | All                   | OS may generate thumbnails of app windows for task switchers (mostly macOS/Windows)                                                                                                              | Low risk for a browser (no document icons to thumbnail), but worth noting                                                                                                                |
| **DNS resolver cache**                                   | All                   | The OS caches resolved hostnames regardless of what the browser does                                                                                                                             | Out of scope for "app footprint" but relevant to your privacy goal — see Section 5                                                                                                       |
| **ARP cache / local network logs**                       | All                   | Network-level, not disk                                                                                                                                                                          | Out of scope for v1                                                                                                                                                                      |
| **Shell history** if launched via terminal with URL args | All                   | If you ever pass a URL as a CLI argument, it lands in `.bash_history`/`.zsh_history`                                                                                                             | Never accept URLs via argv; only via in-app UI                                                                                                                                           |
| **systemd journal / Windows Event Log**                  | Linux/Windows         | Process start/stop events, sometimes with argv, get logged by the OS itself                                                                                                                      | Out of your control from inside the app; document as a limitation                                                                                                                        |

### 3.3 Memory hygiene (best-effort, not perfect)

RAM is not magically wiped when a process exits — the OS marks pages free but doesn't zero them until reallocated, and tools exist to scrape recently-freed memory. You can't achieve perfect memory scrubbing in a V8/Chromium environment (you don't control Chromium's allocator), but you can reduce the window:

- On window-close, explicitly call `session.clearStorageData()`, `session.clearCache()`, `session.clearAuthCache()` before calling `app.quit()` — this at least drops Chromium's own references and lets GC reclaim faster.
- Force `app.exit()` (immediate) rather than `app.quit()` (graceful, can leave background processes alive briefly) once cleanup calls have resolved.
- Ensure there is **no tray icon / background mode** — the entire point breaks if the process lingers after the window closes. Explicitly handle `window-all-closed` to quit on all platforms (macOS defaults to staying alive — override that).

**Document this honestly to yourself and any future users:** "no recoverable trace on disk after exit" is achievable. "No trace in RAM while running, or immune to a live memory-dump attack" is not achievable by any browser, including Tor Browser. Don't oversell the RAM story.

### 3.4 The "known limitations" section you should ship in your README

Being upfront about what you _can't_ fix builds more credibility than pretending to solve everything:

1. If the OS swaps or hibernates while the app is open, plaintext session data can land on disk outside your control. Recommend users disable hibernation / use encrypted swap.
2. Live RAM forensics while the app is running can recover data — true of every browser.
3. Network-level observers (ISP, router owner) can still see traffic unless you add Tor/VPN — that's a separate subsystem, not covered by "local footprint."
4. The website you visit can still fingerprint/track you _during_ the session — local footprint elimination doesn't equal anti-fingerprinting.

---

## 4. Implementation Details (Systems Engineer, continued)

### 4.1 Electron app bootstrap flags

Command-line switches to append in `main.js` before any window is created:

```js
app.commandLine.appendSwitch('disable-http-cache')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-background-networking') // kills a chunk of Chromium's phone-home behavior
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-crash-reporter')
app.commandLine.appendSwitch('disable-breakpad')
app.commandLine.appendSwitch('no-referrers') // optional, breaks some sites but reduces leakage
app.commandLine.appendSwitch('disable-features', 'Translate,OptimizationHints,MediaRouter')
```

### 4.2 Redirecting `userData` into memory (Linux path shown; document per-OS)

The cleanest approach: point Electron's entire `userData` path at a **tmpfs** mount (RAM-backed filesystem) instead of trying to catch every individual Chromium subsystem.

```js
const os = require('os')
const path = require('path')

// On Linux: /dev/shm is tmpfs by default (RAM-backed)
// On macOS: /private/var/run or a manually mounted ramdisk (no default tmpfs equivalent)
// On Windows: no native tmpfs — requires a third-party RAM disk driver, OR fall back to
//   aggressive per-subsystem disabling (Section 4.1) as the primary defense on Windows.

if (process.platform === 'linux') {
  app.setPath('userData', path.join('/dev/shm', 'amnesia-browser-' + process.pid))
}
```

This is a **per-OS problem**, not a one-liner — flag it clearly in your build plan:

- **Linux:** trivial, `/dev/shm` is tmpfs by default on virtually every distro.
- **macOS:** no default writable tmpfs exposed to unprivileged apps the same way. Options: use `diskutil` to programmatically create a RAM disk at first launch (requires a shell-out, adds complexity), or fall back to per-subsystem disabling + a temp dir that you securely delete on exit.
- **Windows:** no native tmpfs. Realistic v1 approach: rely on per-subsystem disabling (4.1) as primary defense, and if anything must be written, write it to `os.tmpdir()` and shred it on exit (Section 4.3), accepting this is weaker than the Linux guarantee. Document this asymmetry honestly.

### 4.3 Cleanup-on-exit routine

```js
app.on('window-all-closed', async () => {
  const ses = session.fromPartition('inmemory-session')
  await ses.clearStorageData()
  await ses.clearCache()
  await ses.clearAuthCache()
  // If anything was forced to touch a real disk path (Windows fallback case):
  // securely overwrite before delete rather than a plain unlink, since a plain
  // delete just removes the directory entry — the data blocks are still
  // recoverable until overwritten.
  app.exit(0) // hard exit, not app.quit()
})
```

For any Windows-fallback temp files: a plain `fs.unlink` is **not sufficient** for a genuine "unrecoverable" claim on an SSD or HDD without TRIM/encryption — the data blocks remain until overwritten. If you truly need to write something to a real disk on Windows, either encrypt it in memory before writing so the plaintext never touches disk, or accept and document that this narrow path is best-effort only.

---

## 5. Network Engineer's view (optional but worth planning for v2)

Local footprint and network privacy are separable, but since you'll want to eventually talk about this project as more than a toy, plan the seam now even if you don't build it in v1:

- **DNS leak prevention:** route DNS-over-HTTPS through the app rather than relying on OS resolver (Chromium supports `--dns-over-https` flags).
- **WebRTC IP leak:** WebRTC can reveal your real local/public IP even behind a VPN unless explicitly disabled — `app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')` needs the opposite treatment; actually disable WebRTC entirely for v1 (`--disable-webrtc` isn't a real Chromium flag — instead block via `session.setPermissionRequestHandler` and a content-blocking rule) if you're not using video calls.
- **Optional Tor integration (v2/v3):** bundle or shell out to a `tor` binary and route traffic through a local SOCKS5 proxy via `session.setProxy()`. This is exactly what Tor Browser does architecturally — you'd be rebuilding a lightweight version of it.
- **Safe Browsing / Google phone-home:** Chromium's built-in Safe Browsing service sends hashes of visited URLs to Google by default. Disable via `--disable-features=SafeBrowsing` or the equivalent Electron session setting — otherwise your "no record anywhere" claim is false the moment it's enabled.

---

## 6. Release / Build Engineer's view

### 6.1 No telemetry, anywhere, by construction

- Never integrate Sentry/analytics SDKs (tempting to add "just for crash reports" — don't; it directly contradicts the product's premise).
- Disable Electron's own update-check pings unless you build an explicit, user-initiated "check for updates" button (no silent auto-update phoning home).
- If you use `electron-builder` for packaging, audit its generated code for any telemetry (some CI-related electron tooling pings usage stats by default — check and disable).

### 6.2 Distribution & reproducibility

- Publish as open source with a clear README stating exactly what is and isn't protected (Section 3.4) — for a privacy tool, "trust us" is worthless; "here's the exact list of Chromium flags we disable, verify it yourself" is what builds credibility, especially for a portfolio/internship context.
- Consider reproducible builds (pinned dependency versions, lockfile committed, build script documented) so someone can verify the shipped binary matches the source.
- Code-sign the binary per OS (this is unrelated to privacy but required for the app to run without scary OS warnings — separate but necessary workstream).

### 6.3 Testing / verification methodology (this is what makes the claim credible)

Don't just assert "zero footprint" — build a verification script as part of the project:

1. Snapshot `find / -newer <timestamp-before-launch>` (or equivalent per-OS) before launching the app.
2. Launch app, browse to a few sites, log into something, close the app.
3. Re-run the same `find` diff and manually inspect every new/modified file.
4. Specifically check: `userData` path, OS temp dir, swap file modification time (can't inspect contents, but can check if it grew), any crash dump directories, shell history files.
5. Turn this into a repeatable script (`verify_footprint.sh`) that ships in the repo — this is genuinely a strong portfolio artifact on its own, since it demonstrates you understand forensic verification, not just the feature.

---

## 7. Scope for v1 (what to actually build first)

To avoid the "12 half-finished projects" pattern — pick the smallest version that proves the concept end-to-end, then extend:

**v1 — Prove the core claim:**

- Single window, tabbed browsing (3–5 tabs), address bar, back/forward/reload
- Shared in-memory session, no persistent `userData` (Linux-first, since tmpfs makes the guarantee cleanest there)
- All Section 4.1 flags applied
- Hard-exit cleanup routine
- `verify_footprint.sh` script + README documenting exactly what's protected and what isn't

**v1.5:**

- "New Identity" button (destroy/recreate session mid-run)
- macOS support (ramdisk workaround)
- Windows support (fallback strategy, clearly documented as weaker)

**v2:**

- DNS-over-HTTPS, WebRTC leak blocking, Safe Browsing disabled
- Optional Tor/SOCKS5 proxy integration

**v3 (stretch):**

- Basic anti-fingerprinting (spoof canvas/WebGL fingerprints, standardize user-agent)

---

## 8. Suggested repo structure

```
amnesia-browser/
├── src/
│   ├── main.js               # app lifecycle, session config, cleanup routine
│   ├── preload.js            # minimal IPC bridge
│   ├── renderer/
│   │   ├── index.html        # tab bar + address bar UI
│   │   └── renderer.js
├── scripts/
│   └── verify_footprint.sh   # the forensic self-test from Section 6.3
├── docs/
│   └── THREAT_MODEL.md       # Section 1 + 3.4, kept honest and public
├── package.json
└── README.md                 # what this is, what it protects against, what it doesn't
```

---

## 9. Summary: the one-sentence version of this whole report

**Nothing about "zero footprint" is one clever trick — it's a checklist.** Route storage into memory, disable every individual Chromium subsystem that writes to disk by default (cache, crash reports, spellcheck, component updater, Safe Browsing), hard-exit instead of graceful-quit, and then _prove it_ with a verification script instead of just claiming it — that last part is what turns this from "another Electron browser" into a legitimately interesting security engineering project for your internship portfolio.
