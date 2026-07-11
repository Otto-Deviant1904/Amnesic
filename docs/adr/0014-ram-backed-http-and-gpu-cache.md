# 0014: Enable the HTTP and GPU shader caches (RAM-only via tmpfs) + post-exit janitor

## Status

Accepted (owner request, resource/performance pass, 2026-07-11).

## Context

Since the initial plan (Section 4.2), `index.ts` carried two
belt-and-suspenders switches — `disable-http-cache` and
`disable-gpu-shader-disk-cache` — plus `cache: false` on every
`session.fromPartition()` call. `research/session-and-userdata.md` §8 and
the pre-existing threat-model notes already established that `cache: false`
is redundant with the global switch, and that the disk-residue guarantee for
`userData/Cache` / `userData/GPUCache` comes entirely from ADR 0004's tmpfs
redirect of the whole `userData` path — the switches were defense-in-depth,
not an independent guarantee.

Their cost: every HTTP resource (JS, CSS, images, fonts) re-fetched and
re-decoded on **every single load** — including reloads and back/forward —
and every GPU shader recompiled on every launch. Pure wasted CPU, network,
and battery, especially painful over the Tor proxy where round-trips are
expensive.

## The regression the switches were accidentally masking

Naively removing `disable-http-cache` made `scripts/verify_footprint.sh`
fail reproducibly: the tmpfs userData dir **survived exit**. Bisection (one
switch at a time, multiple runs each) pinned it to the HTTP cache switch
specifically. Inspecting the surviving dir root-caused it:

```
Network Persistent State
Local State
Preferences
Cache/Cache_Data/index-dir/the-real-index
```

Chromium's **native shutdown path re-writes these files after
`cleanupAndExit()`'s `rmSync(ramUserData)` has already run**: `app.exit(0)`
starts native teardown, during which the disk-cache backend flushes its
index and the prefs/network-state writers commit — re-creating the
directory the JS side just deleted. No in-process ordering can win this
race; the only "after" that works is after the process is dead.

Note this race is not really _caused_ by the cache — enabling the cache
merely makes shutdown re-writes reliable enough for the verifier to catch.
The in-process-rmSync-then-exit design was always exposed to any late
native write.

## Decision

1. **Remove `disable-http-cache` and `disable-gpu-shader-disk-cache`**, and
   stop passing `cache: false` at both `session.fromPartition()` call sites.
   Non-`persist:` partitions get Chromium's in-memory cache backend; the
   default session's disk cache lands under tmpfs-redirected `userData`.
   The memory-only guarantee for tab sessions remains the missing
   `persist:` prefix, exactly as before.

2. **Add a post-exit janitor** (`spawnExitJanitor()` in `index.ts`): at both
   wipe sites (cleanupAndExit and the second-instance handoff path), after
   the immediate `rmSync`, spawn a detached `/bin/sh` that polls
   `/proc/<pid>` until this process is gone (bounded at 60s), then
   `rm -rf` the tmpfs dir again. This closes the shutdown-rewrite race for
   good — including for any future Chromium behavior change, not just the
   cache files. SIGKILL/crash still can't run it; `sweepStaleShmDirs()` on
   next launch remains that fallback, unchanged.

3. `scripts/footprint-session.mjs` polls up to 2s after process exit for
   the dir to vanish (the janitor completes within ~100ms of process
   death), instead of asserting at the exact exit instant. The deadline is
   deliberately tight so a broken janitor still fails the run loudly.

4. The self-audit panel's `http-cache` check now honestly reports the new
   state: caches enabled, tmpfs-backed, wiped by cleanup + janitor; it
   defers the runtime tmpfs proof to the existing `tmpfs` check rather than
   pretending to re-probe Chromium's cache backends.

## Verification

`scripts/footprint-session.mjs` (driven by `scripts/verify_footprint.sh`):

- Pre-change baseline: PASS.
- Cache enabled, no janitor: **FAIL, reproduced repeatedly** (dir survived
  exit with the four files above).
- Cache enabled + janitor: **PASS 5/5 consecutive runs**, no leftover
  `/dev/shm/amnesic-browser-*` dirs, no lingering janitor processes.

Typecheck, ESLint, and the unit suite are at baseline.

## Consequences

- **Faster loads, reloads, and back/forward; less network and battery** —
  resources are reused instead of re-fetched/re-decoded; shaders compile
  once per session instead of per launch. Biggest single win available in a
  resource pass, at zero disk-residue cost.
- **Exit-time wipe is now genuinely race-free**: the janitor covers any
  late native write, not just cache files — a strict hardening of the
  pre-0014 design even independent of the cache decision.
- **More to lose to a live RAM-forensics snapshot mid-session**: cached
  resources/shaders persist in RAM for the session's lifetime instead of
  never existing. Live-RAM access is already a "Partial" row in the threat
  model's scope table (§1); disk forensics — the primary goal — is
  unaffected. New Identity (ADR 0009) still `clearCache()`s the abandoned
  sessions, and exit still destroys everything.
- One more (short-lived) process at exit. It is plain `/bin/sh` + `rm`,
  spawned detached with stdio ignored, quote-guarded, and bounded.

## Rejected alternatives

- **Keep the switches (the first version of this ADR did).** Before the
  root cause was found, the observed verifier failure forced a revert of
  the HTTP-cache half. Root-causing showed the failure was a general
  exit-ordering race worth fixing in its own right, which then unblocked
  the full change.
- **Wipe from the relaunch-bootstrap parent instead of a spawned shell.**
  The bootstrap parent exits immediately after spawning the real instance
  (ADR 0008) — keeping it alive for the app's whole lifetime just to clean
  up at the end would re-introduce the AppImage process-tree fragility ADR
  0008 exists to avoid.
- **Have `sweepStaleShmDirs()` (next launch) be the only post-exit
  cleanup.** Leaves the dir readable in /dev/shm until the _next_ launch or
  reboot — a direct violation of the exit-residue charter.
