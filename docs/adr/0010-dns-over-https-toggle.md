# 0010: DNS-over-HTTPS toggle

## Status

Accepted (implemented 2026-07-05 under the same Phase 2 owner approval as
ADR 0007 — DoH was scoped alongside Tor in the roadmap the owner approved
in full, not a separate non-goal requiring its own sign-off; CLAUDE.md's
non-goals list names "Tor / SOCKS proxy integration" specifically and does
not separately list DoH).

Off by default on every launch, consistent with this project's
no-persisted-settings rule — there is no "DoH enabled at startup" state to
design around.

## Context

Even with Tor mode (ADR 0007) available, a user who leaves Tor off still
has every DNS lookup go to whatever resolver their OS or network hands
them — typically an ISP resolver in plaintext, visible to the same
network-level observer the threat model already discusses. Electron 43
exposes `app.configureHostResolver()`, letting this app force DNS-over-HTTPS
to a specific, chosen provider independent of the OS's own DNS
configuration. This ADR is the toggle's design.

## Decision

1. **`app.configureHostResolver({ secureDnsMode, secureDnsServers })`,
   verified against the pinned electron@43.0.0 type definitions** (research/
   session-and-userdata.md §23): `secureDnsMode` is `'off' | 'automatic' |
'secure'`; `'secure'` restricts lookups to DoH only, `'automatic'` is
   Electron's own un-configured default (opportunistic upgrade when the
   OS resolver advertises DoH support). This app's "off" state maps to
   `'automatic'`, not `'off'` — turning this feature off returns to
   Chromium's own default behavior rather than forcing plaintext-only,
   which would be a strictly worse privacy posture than doing nothing.
2. **Exactly two providers, no free-text server field, no Google or
   Cloudflare default:** Quad9 (`https://dns.quad9.net/dns-query`) and
   Mullvad (`https://dns.mullvad.net/dns-query`) — both publish a
   no-logging policy and are operated independently of any large ad-tech
   or access-ISP entity. A free-text "custom DoH server" input was
   considered and rejected: it's an easy way to typo yourself into leaking
   queries to an unintended host, and this project would rather ship two
   vetted defaults than that footgun. `src/main/dns.ts` is the sole
   authority on the id→template mapping; the renderer only ever receives
   `{id, label}` pairs (`DNS_LIST_PROVIDERS`), never the raw template.
3. **Session-only, re-appliable at runtime.** `applyHostResolver()`
   (`src/main/index.ts`) calls `configureHostResolver()` once at startup
   and again on every provider change — no relaunch required. Electron's
   docs say the method "must be called after `ready`" but say nothing
   about repeat calls; this was verified empirically (not assumed) with a
   standalone script calling it four times in sequence with different
   modes, all of which succeeded with no exception (research/session-and-
   userdata.md §23).
4. **Tor precedence: greyed out in the UI, not forcibly overridden in
   state.** When Tor mode is on, tab DNS resolves through the SOCKS5 proxy
   (ADR 0007 decision 3) — this setting only affects the local,
   non-proxied resolver path, so changing it has no visible effect on
   proxied tab traffic while Tor is on. Rather than silently disable DoH
   or silently no-op a change, `DnsControl.tsx` locks its options
   (`disabled`) and shows an explanatory hint whenever `torEnabled` is
   true, while the underlying `dohProviderId` is left untouched — so
   turning Tor back off restores the DNS control to exactly the state the
   user left it in, with no re-selection needed. This is a UI-level
   precedence, not a code-level mutual exclusion: `configureHostResolver`
   and Tor's `setProxy` are independent calls that don't reference each
   other's state.
5. **No default "verify DoH is active" network beacon.** Unlike a design
   that might ping a well-known URL to confirm the resolver is in effect,
   this app makes no such call — matching ADR 0007's equivalent decision
   for Tor (no automatic check.torproject.org beacon). If a maintainer
   wants to manually confirm DoH is active, the threat model documents the
   `tcpdump`-based manual check instead.

## Alternatives considered

- **A free-text custom DoH server field** — rejected in decision 2 above.
- **Forcing `secureDnsMode: 'off'` while Tor is on**, to make the "DoH is
  irrelevant under Tor" framing literal in code as well as UI. Rejected:
  it would actively regress protection for the one case that still matters
  even under Tor — the confirmed localhost/loopback bypass (ADR 0007's own
  threat-model update) still goes through the local resolver path
  regardless of Tor state, so leaving DoH configured is strictly better
  than turning it off, not worse. "Greyed out" only needed to be a UI
  truth, not a backend one.
- **Google (`8.8.8.8` / `dns.google`) or Cloudflare (`1.1.1.1`) as a
  third/default option** — explicitly excluded per the roadmap's own
  instruction; both are large-scale operators this project has no reason
  to default to over an explicitly privacy-first alternative.

## Consequences

- New per-session state (`dohProviderId: string | null`), never persisted,
  always `null` (off/automatic) on a fresh launch — same shape as Tor's
  `torEnabled`/`torConfig`.
- `docs/threat-model.md` gains a DNS row: DoH mitigates plaintext DNS
  leakage to a network-level observer when enabled and Tor is off, with an
  honest caveat that packet-level proof this actually reaches the chosen
  provider (rather than being silently downgraded) is **not** asserted in
  CI — this sandboxed environment has no root/netns access for packet
  capture, and this project will not stand up a live HTTPS DoH mock server
  requiring weakened TLS certificate validation just to test it. What CI
  **does** assert: the toggle reaches the main process and is reflected in
  status (`tests/e2e/dns.spec.ts`), and the exact resolver-config mapping
  is unit-tested (`tests/unit/dns.test.ts`). A maintainer wanting the
  stronger guarantee should manually run `tcpdump -i any port 53` while
  toggling the setting and confirm lookups stop going out in plaintext.
- Verification burden: e2e coverage for the Tor-precedence UI interaction
  (`tests/e2e/dns.spec.ts`'s third test), reusing the same hermetic fake
  SOCKS5 server as ADR 0007's tests rather than a new fixture.
