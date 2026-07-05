<p align="center">
  <img src=".github/assets/logo.png" alt="Amnesic — Browse. Live. Leave nothing." width="360">
</p>

# Amnesic Browser

A desktop app that behaves like a normal tabbed browser but is engineered so
that nothing recoverable is left on disk once the process exits — no
history, no cookies, no cache, no OS-level breadcrumbs from the app itself.

This is not a general-purpose "private browsing" claim. It is a specific,
narrow, and verifiable one: **read [docs/threat-model.md](docs/threat-model.md)
before trusting anything about what this app does or doesn't protect
against.** That document lists, mechanism by mechanism, what's actually
mitigated and what isn't — including the things this project cannot fix
(OS swap/hibernation, live RAM forensics, website fingerprinting). Network-
level observers are now _partially_ addressed — off by default, opt-in per
session — see [Network privacy](#network-privacy-optional) below.

## Status

v1 — Linux only. Single-window, in-memory-session tabbed browsing with a
hard-exit cleanup routine. `scripts/verify_footprint.sh` (the empirical
proof of the core claim — a scripted session followed by a filesystem
diff) runs in CI on every push and must pass before any PR touching
session/storage/cache handling merges (see `CLAUDE.md` and ADR 0004).

## Installing

Download the AppImage and `SHA256SUMS` from the
[releases page](https://github.com/Otto-Deviant1904/Amnesic/releases),
verify, and run:

```sh
sha256sum -c SHA256SUMS
chmod +x amnesic-browser-*.AppImage
./amnesic-browser-*.AppImage
```

There is deliberately **no auto-updater** — an amnesic browser should not
phone home, even to itself. To update, download the next release and
verify its checksum (ADR 0006).

Launching a second instance hands its URLs to the running window and
exits; the app registers as an `http(s)` handler so it can be set as the
default browser.

**Sandbox note:** unlike most Electron AppImages, this one does **not**
ship `--no-sandbox` — a browser must not run hostile web content outside
the Chromium OS sandbox. It uses the kernel's unprivileged user
namespaces, available on most modern distros. On Ubuntu 23.10+ (which
restricts unprivileged userns by default) the app will refuse to start
rather than run unsandboxed; either install an AppArmor profile granting
`userns` to the extracted binary, or run
`sysctl kernel.apparmor_restrict_unprivileged_userns=0` at your own risk
(it relaxes that restriction system-wide).

## Why the claims are verified, not asserted

Every Chromium command-line switch and Electron session API this project
relies on was checked against the exact pinned Electron version
(`electron@43.0.0`, Chromium 150.0.7871.46) rather than trusted from
general knowledge or older tutorials — flags and APIs change between
releases. See `research/` for the verification notes and
`docs/adr/` for the architectural decisions and corrections that came out
of that process.

The start page also carries a **self-audit panel** that runs a set of live
checks in the main process every time you open it (or press "Re-check") —
turning the CI-only trust story into something you can watch happen in your
own running instance, not just read about:

<p align="center">
  <img src=".github/assets/self-audit.png" alt="Amnesic's self-audit panel showing live runtime checks" width="560">
</p>

Every row is honest about what it actually proved: rows marked **checked
now** were verified in that exact process at that exact moment (tmpfs
filesystem type, the session partition's name, the HTTP-cache switch, …);
rows marked **enforced by CI** are guarantees with no reliable Electron 43
runtime signal (the crash-reporter guarantee, for one — see
`research/cleanup-and-exit.md` §21) and are labeled as such rather than
faked as a runtime check.

## Using it

New tabs open on an in-app start page; the address bar accepts URLs or
search terms (searches go to DuckDuckGo). `target=_blank` links and
ctrl+click open as new tabs in the same hardened in-memory session —
real popup windows are never created. Closing the last tab closes the
window, which triggers the wipe-and-exit routine.

Everyday browsing niceties are in and stay inside the amnesic envelope:
right-click context menus (page, links, images, selections, address bar),
find in page (`Ctrl+F`), session-only tab favicons (fetched through the
tab's in-memory session, never by the shell), drag-to-reorder tabs, an
audio indicator with click-to-mute, and a zoom chip in the address bar
when zoom ≠ 100%. HTML5 fullscreen (video players) works; all other
permission requests remain denied. Failed loads — DNS errors, refused
connections, invalid certificates — render an in-shell error page with a
retry button; there is deliberately **no** "proceed anyway" bypass for bad
certificates. Sites behind HTTP basic auth get an in-shell sign-in dialog;
credentials go only into the request and are forgotten with the session.

Two shortcuts reach the same wipe machinery from a different angle: the
**panic key** (`Ctrl+Shift+Q`) runs the exact wipe-and-exit routine that
closing the last tab does, from anywhere — address bar, page content, or the
find bar — and quits immediately. **New identity** (`Ctrl+Shift+N`, or the
mask icon in the toolbar) closes every open tab and rotates to a brand-new,
freshly hardened in-memory session without restarting the app — a Tor
Browser-style forensic reset mid-session (see ADR 0009).

| Shortcut                       | Action                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `Ctrl+T` / `Ctrl+W`            | new / close tab                                                                |
| `Ctrl+Tab`, `Ctrl+PgUp/PgDn`   | cycle tabs                                                                     |
| `Ctrl+1…8`, `Ctrl+9`           | nth / last tab                                                                 |
| `Ctrl+L`                       | focus address bar                                                              |
| `Ctrl+F`                       | find in page (`Enter`/`Shift+Enter` cycle, `Esc` closes)                       |
| `Ctrl+R`, `F5`, `Ctrl+Shift+R` | reload (hard)                                                                  |
| `Alt+←` / `Alt+→`              | back / forward                                                                 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | zoom in / out / reset                                                          |
| `Esc`                          | stop loading (or revert address bar while typing)                              |
| `Ctrl+Shift+Q`                 | **panic key** — wipe session and quit immediately, from anywhere in the window |
| `Ctrl+Shift+N`                 | **new identity** — close all tabs, rotate to a fresh session, without quitting |

## Network privacy (optional)

Local footprint elimination and network-level privacy are separate
problems; the browser's core claim was always about the first. Two
opt-in, session-only toggles now address a slice of the second — both are
**off by default on every launch** and never persisted, matching the
project's no-persisted-settings rule.

**Tor / SOCKS5** (the shield chip in the toolbar) — bring your own Tor.
Point it at a SOCKS5 proxy already running on your machine (Tor Browser,
the system `tor` service, or your own `tor` process; `127.0.0.1:9050` is
the pre-filled default) and the toggle connects tab traffic through it.
Hostnames resolve at the proxy, never locally, and — critically — an
unreachable proxy fails navigation closed rather than silently falling
back to a direct connection. Read
[ADR 0007](docs/adr/0007-tor-socks-proxy-integration.md) for the full
design and its honestly-stated limits: this is transport privacy and
footprint elimination, **not** anonymity parity with Tor Browser — no
uniform fingerprint, no circuit-health control-port integration, and New
Identity under Tor only rotates the browser's own session, never requests
a fresh circuit.

**DNS-over-HTTPS** (the DNS chip next to it) — independent of Tor, forces
encrypted DNS to Quad9 or Mullvad (no Google or Cloudflare option, no
free-text server field — see [ADR 0010](docs/adr/0010-dns-over-https-toggle.md)
for why). While Tor mode is on, this control greys out with an
explanation: tab DNS already resolves through the SOCKS5 proxy in that
case, so changing the local resolver has no visible effect on proxied
traffic — but your selection is preserved underneath, not reset, so
turning Tor back off picks up right where you left it.

Both toggles are verified end-to-end against a hand-rolled, hermetic
SOCKS5 test server (`tests/e2e/tor.spec.ts`, `tests/e2e/dns.spec.ts`) —
never a real Tor instance or real network egress in CI. One honestly
un-asserted limit: neither test suite proves at the packet level that
DNS queries leave the process as HTTPS rather than plaintext port 53 —
that needs root/netns packet capture this project's CI doesn't have. See
`docs/threat-model.md`'s DNS row for the manual `tcpdump`-based check a
maintainer can run for that stronger guarantee.

## Development

```sh
npm install
npm run dev      # electron-vite dev server + app
npm run build    # production build
npm run typecheck
npm run lint
npm test         # vitest unit tests
npm run test:e2e # playwright e2e tests
npm run dist     # package the Linux AppImage into dist/
```

Releases are cut by pushing a `v*` tag: CI re-runs the full quality gate,
builds the AppImage, and drafts a GitHub release with a `SHA256SUMS` file
(`.github/workflows/release.yml`). The app icon is generated from
`build/icon.svg` by `scripts/generate_icon.sh` — edit the SVG, never the
PNGs.

## Non-goals for v1

See `CLAUDE.md`. Anti-fingerprinting, extensions, bookmarks, downloads,
password/autofill management, and any telemetry are explicitly out of
scope and require explicit approval before being added. (Tor/SOCKS
integration was on this list before v0.3.0 — see "Network privacy" above.)

## License

[APACHE 2.0](LICENSE)
