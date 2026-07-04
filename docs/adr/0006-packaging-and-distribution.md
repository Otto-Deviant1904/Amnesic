# 0006: Packaging and distribution — AppImage, no updater, single-instance

## Status

Accepted

## Context

Sprints 1–2 made the app credible (footprint proven in CI) and usable
(table-stakes browsing). Sprint 3 makes it shareable: a license, a
distributable artifact, desktop identity, and single-instance behavior.
Packaging decisions for this project are unusually constrained: the
distribution machinery itself must not violate the charter (no telemetry,
no phone-home, no real-disk writes at runtime), and packaging defaults in
the Electron ecosystem violate it in several places. Every deviation from
those defaults is recorded here.

## Decisions

1. **MIT license, still `"private": true`.** The code is public and
   permissively licensed; `private` stays because the app ships as an
   AppImage, not an npm package, and the flag only guards against an
   accidental `npm publish`.

2. **Linux AppImage only for v1.** The amnesic guarantee is Linux-only
   (tmpfs userData, threat-model §1), so shipping macOS/Windows artifacts
   would distribute builds whose core claim doesn't hold. AppImage over
   .deb/.rpm because it is distro-agnostic, needs no install step, and
   leaves nothing in package-manager state; a .deb can follow if wanted.

3. **No auto-updater, no publish provider — enforced, not just omitted.**
   `publish: null` in electron-builder.yml. Without it, electron-builder
   auto-detects a GitHub publish configuration from package.json's
   `repository` field and bakes `app-update.yml` (updater metadata) into
   the package — discovered by extracting the first local build. An
   auto-updater is phone-home machinery and is against the charter.
   Updates are: download the new AppImage, verify its checksum. The
   release workflow publishes a `SHA256SUMS` file alongside the artifact
   and creates releases as drafts so a human writes the notes.

4. **`--no-sandbox` is stripped from the desktop entry.** electron-builder's
   AppImage default is `Exec=AppRun --no-sandbox %U` (the SUID sandbox
   helper can't work from a nosuid squashfs mount, and some distros
   restrict unprivileged user namespaces). Shipping a _browser_ — an app
   whose whole job is rendering hostile content — with the Chromium OS
   sandbox disabled is not acceptable, so `appImage.executableArgs: []`
   removes the flag and Chromium uses the user-namespace sandbox instead.
   Cost: on distros that restrict unprivileged userns without an exception
   (Ubuntu 23.10+ AppArmor policy), the app refuses to start rather than
   silently running unsandboxed. That is the right failure direction; the
   README documents the AppArmor profile workaround.

5. **Electron fuses are flipped at package time.** `runAsNode`,
   `enableNodeOptionsEnvironmentVariable`, and
   `enableNodeCliInspectArguments` off; `onlyLoadAppFromAsar` and
   `enableEmbeddedAsarIntegrityValidation` on. The packaged binary can't
   be repurposed as a Node runtime, fed `NODE_OPTIONS`, debugged into via
   `--inspect`, or pointed at substitute app code — all of which would
   otherwise be ways to run code with this app's identity or quietly
   defeat its mitigations. `enableCookieEncryption` deliberately stays
   off: it would route cookie key material through the OS keyring — a
   real-disk write — to protect cookies that live in RAM and die with the
   session anyway. Verified post-build with `@electron/fuses read`.

6. **Single-instance lock via a unix socket on tmpfs — not Electron's.**
   `app.requestSingleInstanceLock()` places its lock inside `userData`;
   our userData is a _per-pid_ tmpfs directory, so two instances would
   each lock their own directory and never collide, and repointing the
   built-in lock means a real-disk write under `~/.config`. Instead
   `src/main/single-instance.ts` listens on a socket at
   `/dev/shm/amnesic-browser-lock-<uid>/s`. A second launch connects,
   forwards the http(s) URLs from its argv as one size-capped JSON
   message, and exits; the holder re-validates every URL against the same
   scheme gate as `createTab` and opens them as background tabs. Details
   that matter:
   - **Path-based socket, not the Linux abstract namespace.** Abstract
     socket names carry no permissions — any local user could connect or
     squat the name. A socket under a mode-0700 directory is reachable
     only by the owning uid. The dir is stat-checked after creation
     (ownership, mode, dir-ness); if it can't be trusted the app launches
     _without_ the lock rather than not at all.
   - **Crash recovery is connect-based.** A dead holder leaves a socket
     file that refuses connections; the next launch unlinks it and takes
     over. A socket inode holds no data, so pre-reboot residue is a name,
     not content (threat-model §2).
   - **Skipped under automation** (Playwright, dev server), same
     rationale and detection as the relaunch bootstrap in ADR 0004: those
     harnesses own their process lifecycles.
   - The module is Electron-free so vitest exercises the real socket
     protocol (acquire, forward, stale recovery, hostile-dir fallback).

7. **Desktop identity.** `desktopName: amnesic.desktop` in package.json
   (Electron uses it for the Wayland app_id) with
   `linux.syncDesktopName: true` so the packaged .desktop file matches;
   `StartupWMClass=Amnesic` for X11 grouping. The app registers
   `x-scheme-handler/http(s)` MIME types so it can be chosen as a default
   browser — which is what makes the second-instance URL forwarding
   reachable in practice. The icon is generated from `build/icon.svg`
   (the committed source of truth) by `scripts/generate_icon.sh`;
   regenerate rather than editing PNGs.

8. **The packaged runtime is the pinned node_modules Electron.**
   `electronDist: node_modules/electron/dist` packages the exact runtime
   the lockfile pins instead of re-downloading the same version, and an
   `afterPack` hook strips `default_app.asar` (Electron's fallback app —
   already unreachable behind `onlyLoadAppFromAsar`, so this is weight,
   not security).

## Consequences

- `npm run dist` produces `dist/amnesic-browser-<version>-x86_64.AppImage`;
  pushing a `v*` tag builds it in CI behind the full quality gate and
  drafts a GitHub release with checksums.
- A second launch of the packaged app (including via "open link with")
  lands in the running window as a background tab; dev and test instances
  are unaffected.
- Ubuntu 23.10+ users with restricted unprivileged userns must add an
  AppArmor exception (documented in the README) — the app fails closed
  rather than running without the Chromium sandbox.
- Electron version bumps now also require re-verifying the fuse set and
  the `--no-sandbox` stance against the new version's AppImage behavior,
  in addition to the CLAUDE.md switch re-verification rule.
