# 0004: Footprint verifier implementation and the exit-residue fixes it forced

## Status

Accepted

## Context

Until now `scripts/verify_footprint.sh` was a stub that always failed, so
the project's core claim — nothing recoverable on disk after exit — was
engineered but never empirically demonstrated. CLAUDE.md makes this script
the merge gate for any session/storage/cache change, which means the gate
itself was the most overdue deliverable in the repo.

Designing the verifier surfaced three gaps, two of them real residue bugs:

1. **The tmpfs userData directory outlived the process.** tmpfs contents
   survive process exit until reboot. `cleanupAndExit()` cleared session
   data via Chromium APIs but never deleted `/dev/shm/amnesic-browser-<pid>`
   itself, so whatever Chromium had materialized there (`Local State`,
   leveldb files backing Local Storage, etc.) remained readable by any local
   process after the app closed — a direct violation of the headline claim
   in the window between exit and reboot.

2. **Non-Chromium child-process caches were unmitigated.** The Chromium
   switches and the userData redirect cover Chromium's own disk writes, but
   the GPU process also writes through the system graphics stack: Mesa's
   shader cache and fontconfig's cache land under `$XDG_CACHE_HOME`
   (default `~/.cache`). No Chromium switch controls these because they are
   not Chromium code.

3. **Electron's default download behavior was live.** Downloads are a v1
   non-goal, and the threat model's `recently-used.xbel` row asserts the app
   never opens native file dialogs — but with no `will-download` handler,
   Electron's _default_ is to open exactly that GTK save dialog and write
   the file wherever the user picks. The non-goal was a policy, not a
   mechanism.

## Decision

**Verifier** (`scripts/verify_footprint.sh` + `scripts/footprint-session.mjs`):

- A marker file is created, then a Playwright-driven session runs the built
  app against a local (hermetic) HTTP server whose page deliberately
  exercises every persistence mechanism in the threat model's table:
  persistent header + JS cookies, localStorage, sessionStorage, IndexedDB,
  the Cache API, and an attempted `Content-Disposition: attachment`
  download. The session ends by closing the window — the real user exit
  path (`window-all-closed` → `cleanupAndExit`) — not `app.close()`.
- The driver asserts the tmpfs userData dir exists during the run and is
  gone after exit. The shell script then scans `$HOME`, `/tmp`, `/var/tmp`,
  and `/dev/shm` for anything newer than the marker; every finding must be
  attributable to the test harness (small, documented exclusion list) or
  the run fails.
- The script also enforces the threat model's grep invariants
  (`crashReporter.start(`, `addRecentDocument(`, `GOOGLE_API_KEY` must not
  appear in `src/`).
- CI (`.github/workflows/ci.yml`, new in this change) is the authoritative
  environment: a runner's filesystem is quiet during the run. Developer
  workstations produce unrelated-process noise (verified empirically:
  a local run flagged only Brave/Spotify/indexer writes — and nothing from
  this app), so local failures require eyeballing before being treated as
  violations.

**Residue fixes:**

- `cleanupAndExit()` now `rmSync`s the tmpfs userData directory (recursive,
  force) after the session-clearing calls and immediately before
  `app.exit(0)`. Open handles don't block unlinking on Linux, and a
  deletion failure must not block exit — hence `force: true`.
- At startup (Linux), `XDG_CACHE_HOME` is pointed at a subdirectory of the
  tmpfs userData dir, so every child process — including the GPU process and
  through it Mesa and fontconfig — inherits a RAM-backed cache location.
  This sweeps entire _classes_ of non-Chromium cache writes into tmpfs
  rather than chasing per-library disable flags
  (`MESA_SHADER_CACHE_DISABLE` etc. would each cover one library and need
  per-version re-verification).

  **Correction, found by the verifier's first CI run:** mutating
  `process.env` in the main script does _not_ reach child processes.
  Chromium forks its zygote processes before the main script executes, and
  GPU/renderer processes inherit the zygote's environment — confirmed by
  reading `/proc/<gpu-pid>/environ` (no `XDG_CACHE_HOME`) and by CI, where
  Mesa wrote `~/.cache/mesa_shader_cache/*` despite the env mutation. The
  working mechanism is a one-time bootstrap: on first launch the app sets
  `AMNESIC_SHM_DIR` + `XDG_CACHE_HOME` in its own env, calls
  `app.relaunch()` (the spawned instance inherits the augmented env from
  birth, before any zygote fork) and exits. Automation harnesses can't
  survive a relaunch, so launches carrying `--remote-debugging-port/-pipe`
  skip the bootstrap and are expected to pass the env themselves —
  `scripts/footprint-session.mjs` does, which is also what makes the
  mechanism CI-verifiable.

- Exit paths that bypass a clean `window-all-closed` are covered too, both
  found empirically. A plain `kill` (SIGTERM — also what logout/shutdown
  send) runs Chromium's own quit sequence, which terminated the process
  while `cleanupAndExit` was still awaiting the session clears, leaving the
  tmpfs dir behind; a `before-quit` handler now holds the quit open with
  `preventDefault()` until cleanup calls `app.exit(0)` itself (`app.exit`
  does not re-emit `before-quit`, so no loop). And every startup sweeps
  `/dev/shm/amnesic-browser-*` dirs whose owning pid no longer exists — the
  recovery path for crashes and `SIGKILL`, which no process can intercept.
  The sweep matches by path, not pid liveness, when protecting the current
  instance's own dir, because after the relaunch bootstrap the dir is named
  for the (dead) bootstrap pid.
- Every session gets a `will-download` handler that calls
  `event.preventDefault()` and notifies the shell, which shows a transient
  "download blocked" notice. This turns the downloads non-goal into an
  enforced mechanism and keeps the threat model's no-native-dialogs
  assertion true.

## Consequences

- The core claim is now demonstrated per-commit in CI, not asserted. Any
  regression that writes outside tmpfs (new Electron default, new feature,
  dependency behavior change) fails the merge gate.
- The `XDG_CACHE_HOME` redirect changes behavior for anything else reading
  that variable inside the app's process tree; nothing in v1 does, but a
  future feature spawning helper processes inherits the redirect by design.
- Deleting the userData dir at exit means post-exit debugging of session
  state is impossible. That is the product working as intended.
- If a future feature legitimately needs downloads, it must replace the
  cancel-all handler and carries its own ADR + security review per
  CLAUDE.md (and should confront the `recently-used.xbel` problem this ADR
  sidesteps by never opening a file dialog).
