# 0008: `app.relaunch()` crashes the packaged AppImage — replaced with a manual spawn

## Status

Accepted

## Context

v0.1.0 shipped unlaunchable on Linux as the packaged AppImage. The tmpfs
bootstrap (ADR 0004) calls `app.relaunch()` followed immediately by
`app.exit(0)` to get `XDG_CACHE_HOME` set before Chromium forks its zygote.
That pattern works in dev (`electron-vite dev`) and is the documented
Electron idiom for this exact problem, but in the packaged AppImage the
relaunched process never survives: it crashes during Electron/Chromium's
native startup, before this module's own top-level JS ever runs — verified
by adding a file-write at the very first line of `src/main/index.ts` and
observing it fire exactly once (the original bootstrap process) across
repeated runs, never a second time for the relaunched process.

The first crash observed (running the AppImage via its default FUSE mount)
printed `Received signal 7 BUS_ADRERR` right as the relaunch fired. The
working theory was that `app.relaunch()` defaults `execPath` to
`process.execPath`, which under a FUSE-mounted AppImage points inside a
mount whose lifetime is tied to the exiting bootstrap process — a plausible
mmap-past-the-unmount race. Pointing `execPath` at `$APPIMAGE` (the AppImage
runtime's own env var for the persistent, real path to the outer `.AppImage`
file, which would re-mount independently) did **not** fix it: the relaunched
process still never reached the module's top-level code, with no
consistently reproducible signal this time (stdio for `app.relaunch()`'s
child appears to not be inherited from the parent, so crash-handler output,
when any, doesn't reach the invoking shell — confirmed by the fact a
`console.error` placed right before the `app.relaunch()` call never showed
up from the child in any capture attempt).

What _did_ work, verified repeatedly: manually spawning the exact same
AppImage binary with the exact same environment (`AMNESIC_SHM_DIR` and
`XDG_CACHE_HOME` preset, bypassing the relaunch branch entirely) produces a
fully healthy process tree — browser process, zygote, GPU process, network
service, renderer — that stays alive indefinitely and shuts down cleanly
(tmpfs userData and the single-instance lock socket both removed on exit).
This was true even with two such processes sharing the same tmpfs userData
directory concurrently, which rules out simple profile-lock contention as
the cause. The failure is specific to something in `app.relaunch()`'s own
internal spawn mechanism on this packaging — not fully root-caused (no
`strace`, `gdb`, or `coredumpctl` output was available in the diagnosing
environment; `coredumpctl` found no dumps at all, consistent with
Chromium's crash handler intercepting the signal and exiting rather than
letting the kernel produce a core).

## Decision

Replace `app.relaunch()` with an explicit `child_process.spawn(process.execPath,
process.argv.slice(1), { env: process.env, detached: true, stdio: 'ignore' })`
followed by `child.unref()`, then `app.exit(0)` as before. This is
functionally what `app.relaunch()` is documented to do (same execPath
default, same argv default, same augmented environment), just performed
with Node's own spawn instead of Electron's internal implementation of it —
and empirically, it survives where `app.relaunch()` does not.

## Alternatives considered

- **Root-cause `app.relaunch()`'s actual failure** (via `strace`/`gdb`, not
  available in the diagnosing environment). Preferable in principle — this
  ADR's fix works around the symptom without knowing the exact mechanism —
  but blocked on tooling, and every environment where the crash was
  reproduced (default FUSE mount, `--appimage-extract-and-run`, with and
  without `$APPIMAGE`-based `execPath`) failed identically, while the manual
  spawn succeeded identically every time it was tried. Revisit if
  `app.relaunch()`'s Linux implementation changes in a future Electron
  version, or if better crash tooling becomes available.
- **Drop the relaunch bootstrap entirely, accept Mesa/fontconfig writing to
  `~/.cache`.** Rejected: this is the exact gap ADR 0004 exists to close;
  reintroducing it would fail `scripts/verify_footprint.sh` and violate the
  amnesic guarantee for GPU-stack caches.
- **Use `execFileSync` to run the relaunch synchronously and block until it
  exits.** Rejected: the whole point is the relaunched process outlives the
  bootstrap process; blocking on it would mean the bootstrap (and the
  browser) never actually starts.

## Consequences

- `src/main/index.ts` now imports `node:child_process`. The bootstrap's
  behavioral contract (skip under automation/dev, same env vars, same
  `relaunching` guard flag downstream) is unchanged — only the mechanism
  that launches the second process changed.
- The packaged v0.1.0 AppImage release does not launch on Linux at all;
  this fix ships as v0.1.1. Anyone who downloaded v0.1.0 needs the new
  build.
- `app.relaunch()`'s failure mode in this packaging remains formally
  unexplained. If a future Electron/electron-builder upgrade changes AppImage
  packaging or relaunch internals, re-verify this bootstrap still survives a
  real packaged launch (not just `npm run dev`) before shipping — dev never
  exercises this code path at all (the `automated` check skips it), so
  nothing short of running the actual AppImage would have caught this before
  release.
