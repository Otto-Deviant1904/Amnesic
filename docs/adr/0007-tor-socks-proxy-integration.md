# 0007: Tor/SOCKS proxy integration

## Status

Accepted (owner approval given 2026-07-05; see resolutions to the open
questions below, decided at implementation time). CLAUDE.md's requirement
of explicit human approval before any Tor/SOCKS code is written has been
satisfied — this ADR's design is now binding for the implementation.

Tor starts **off** by default on every launch, consistent with this
project's "no persisted settings" rule (CLAUDE.md anti-goals) — there is no
concept of "Tor enabled at startup" to design around; the user opts in each
session via the toggle in decision 7, subject to the same no-tabs-open gate
whether that happens moments after launch or hours into a session.

## Context

The threat model (`docs/threat-model.md` §"Network-level observer") scopes
ISP/Wi-Fi-owner visibility as out-of-scope for v1 and explicitly names
Tor/VPN integration as "a separate subsystem that may be bolted on later."
The amnesic guarantee this project has actually verified so far — sprints
1–3, proven in CI, packaged as an AppImage (ADR 0006) — is entirely about
what's left on _disk_ after exit. It says nothing about what's visible _on
the wire_ while the app runs. A visitor's ISP, network operator, or any
on-path observer currently sees every destination IP and every TLS SNI in
plaintext, correlated to the real source IP, for the full duration of a
session — regardless of how clean the exit-time footprint is.

This ADR proposes closing that gap by routing traffic through Tor via a
local SOCKS5 proxy, and lays out the leak-proofing design so the approach
can be approved before code.

## Decision (proposed)

1. **Bring your own Tor — don't bundle or spawn a daemon.** The app connects
   to a Tor SOCKS proxy already running on the host (Tor Browser, system
   `tor` service, or a user-run `tor` process), configurable as
   `host:port` (default `127.0.0.1:9050`, the standard SOCKS port; `9150` for
   Tor Browser's bundled instance). Rejected alternative: bundling a `tor`
   binary and spawning it as a child process. That would make this app
   responsible for a security-critical daemon's lifecycle, config generation,
   and circuit health — a large surface this project isn't positioned to
   maintain — and would blur the "verified amnesic footprint" claim, since
   Tor's own data directory (state, guard node cache) is a persistence
   question in its own right, separate from this app's tmpfs `userData`.

2. **Proxy set at the session level, only while no tab exists — and on both
   sessions, not just the tab partition.** `session.setProxy({ proxyRules:
'socks5://host:port' })` on the in-memory partition used for tabs
   (`session.fromPartition(...)`, rotated per ADR 0009 —
   whichever partition `getInMemorySession()` currently returns), called
   only when `tabs.size === 0` (decision 7's gate) — never per-tab, and
   never while any tab is open. Critically, the same call must also run
   against `session.defaultSession`, alongside `hardenSession()`
   (`src/main/index.ts`, renamed from `applySessionMitigations` in ADR
   0009), not left as tab-partition-only. This project has already hit this
   exact class of bug once: `defaultSession` backs the shell window and is
   Electron's fallback for anything not explicitly assigned a session, and a
   prior security review flagged mitigations applied only to the tab
   partition as a real parity gap (the comment above `hardenSession`
   documents it). A proxy config with the same gap — tabs proxied,
   `defaultSession` not — would be a silent leak in exactly the spot this
   project has already been burned on, and directly contradicts decision 4's
   fail-closed requirement if anything ever routes through `defaultSession`
   unproxied.

2a. **Wording note:** "never toggled mid-session" above means never
changed while the proxy is in active use serving requests — it does not
mean the setting can only change across a full app relaunch. Decision 7
allows the toggle when no tabs are open, which is a live `setProxy()`
call on the same long-lived session object (the in-memory partition
survives tab close, per the threat model — it's only torn down at app
exit). That's an intentional, narrower guarantee than "requires
relaunch," and should be read that way rather than as full session
isolation between toggles. The "no tabs open" gate exists precisely
because a proxy setting that changes while tabs are open is worse than
no proxy at all: a page could keep loading resources through a stale
route while the UI claims protection.

3. **DNS resolution happens inside Tor, never locally.** `socks5://` proxy
   rules in Chromium's network stack send hostnames to the proxy for
   resolution rather than resolving locally and connecting to a raw IP —
   this is standard SOCKS5 (as opposed to SOCKS4, which requires a
   pre-resolved IP and would leak every hostname to the local resolver
   before the proxy ever sees the connection). This must be verified against
   the pinned Electron/Chromium version's proxy-resolution behavior before
   implementation, per CLAUDE.md's re-verification rule for network-facing
   switches — Chromium has had bugs here before (e.g. `chrome://net-internals`
   DNS-over-HTTPS interactions overriding proxy DNS in some configurations).

4. **Kill-switch: if the proxy is unreachable, tabs fail closed, not open.**
   Chromium's default behavior for an unreachable SOCKS proxy is to fail the
   individual navigation (`ERR_PROXY_CONNECTION_FAILED`) rather than fall
   back to a direct connection — that fallback does not exist for explicit
   `proxyRules`, unlike PAC-script proxy configs which can be written to fail
   open. The design leans on this: no PAC script, no `direct://` in the proxy
   rules' fallback list. In addition, the app must actively health-check the
   proxy at startup (a SOCKS5 handshake probe, not just "is the port open")
   and refuse to create any tab — showing a blocking error state instead —
   if the probe fails or if Tor's control port (if configured) reports
   circuits are not built. A tab that silently loads over a direct
   connection because Tor was down is the single worst failure mode this
   feature could have, worse than not offering the feature at all.

5. **DevTools/CDP layer (ADR 0003) and WebRTC IP-handling policy
   (threat-model §"WebRTC IP leak") stay mandatory and unconditional, not
   proxy-dependent.** `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`
   already exists specifically because SOCKS proxying alone does not stop
   WebRTC: SOCKS operates on TCP, and WebRTC's ICE/STUN candidate gathering
   uses UDP, which bypasses SOCKS entirely and can expose the real local/
   public IP even with the proxy correctly configured — this is the
   textbook "WebRTC leak" that VPN/proxy users hit. Because layer 2 (the CDP
   script deleting `RTCPeerConnection` etc.) already removes the API surface
   outright, Tor mode adds no new WebRTC exposure beyond what threat-model
   §44 already documents and mitigates. This ADR does not change that
   design; it only notes that Tor integration must not be shipped under the
   assumption that SOCKS alone makes WebRTC safe.

6. **No bypass list, no split-tunneling.** `proxyBypassRules` stays empty.
   A per-domain bypass list is exactly the kind of footgun that produces
   silent, hard-to-notice leaks (a user adds an exception for convenience
   and forgets it's there); if Tor mode is on, _everything_ goes through
   Tor or the tab fails to load. Local/loopback exceptions that Chromium
   applies by default (e.g. `localhost`) are the one unavoidable exception
   and will be documented, not hidden.

7. **UI surfaces Tor mode as a whole-session toggle, not a per-tab setting**,
   changeable only when no tab has navigated anywhere yet (forces a clean
   session boundary — consistent with decision 2) — exact placement is a
   follow-up design, not part of this ADR.

7a. **Clarification found at implementation time:** "no tabs are open"
above cannot mean literally zero tabs in this app — there is always at
least one (closing the last tab quits the app entirely; there is no
"blank window, zero tabs" state to gate on). The actual risk this decision
guards against is a tab keeping in-flight requests on a stale route while
the UI claims a new one; a tab still showing the start page (never
navigated) has no content and nothing in flight, so it is harmless to
change the proxy under it. The gate is therefore "no open tab has ever
navigated" (`TabEntry.navigated` in `src/main/index.ts`, already tracked
for the start-page/error-page distinction), not tab count.

## Alternatives considered

- **VPN integration instead of Tor.** Rejected for v1: a VPN is a single
  provider the user must trust with real IP + traffic correlation, whereas
  Tor's exit-relay model doesn't require trusting one operator; also, "VPN"
  covers a huge integration surface (WireGuard configs, provider APIs) with
  no single mechanism as uniform as SOCKS. Nothing here precludes VPN
  support as a separate later ADR.
- **Bundling and managing a Tor daemon** — rejected in decision 1 above.
- **PAC-script-based proxy config for more flexible routing rules.**
  Rejected: PAC scripts run arbitrary JS to decide routing per-request and
  support a `direct` fallback, which directly conflicts with the fail-closed
  requirement in decision 4.

## Open questions — resolved at implementation time (2026-07-05)

- **Auto-detection of a running Tor instance?** No. The app never scans for
  or probes ports the user hasn't specified. The host:port field defaults to
  `127.0.0.1:9050` (pre-filled, editable) and the user must explicitly
  trigger a connection attempt (the toggle) for the app to ever open a
  socket to it. A background port-scanning pattern is unusual, surprising
  behavior for a privacy tool to ship silently, and the usability gain over
  a pre-filled default doesn't justify it. Revisit only via a new ADR if
  real usage shows the pre-filled default is insufficient.
- **Fingerprinting claim change?** No change beyond what decision 5 already
  says. The threat-model update (see Consequences) adds the candid caveat
  that Tor mode is footprint/transport-layer privacy, not anti-fingerprinting
  or anonymity parity with Tor Browser — anti-fingerprinting remains its own
  non-goal, untouched by this ADR.
- **Control-port integration for circuit health / NEWNYM?** Not implemented
  in v1. The health check is the SOCKS5 handshake probe alone (decision 4's
  baseline) — no control-port connection, no auth cookie/password handling,
  no `NEWNYM`. This keeps the integration surface to exactly one protocol
  (SOCKS5) instead of two, at the cost of New Identity (existing feature)
  only ever rotating the browser's own session when Tor is on, never
  requesting a fresh Tor circuit — the UI must say so honestly rather than
  imply circuit freshness it doesn't deliver. Control-port support can be a
  later, separately-decided ADR if real usage shows the gap matters.

## Consequences

- New per-session state (proxy config) that is never persisted and starts
  fresh (off) on every launch, including across the XDG_CACHE_HOME relaunch
  bootstrap from ADR 0004 — that bootstrap re-execs the same process before
  any UI exists, so there is no in-flight Tor state to carry across it in
  the first place.
- New failure-mode UI (blocking error state when the proxy probe fails) that
  doesn't exist anywhere else in the app today.
- Verification burden grows: `scripts/verify_footprint.sh` proves nothing
  about network egress, so this feature needs its own e2e verification
  against a real (hand-rolled, hermetic) SOCKS5 test server asserting: the
  app actually routes through it when enabled, hostnames arrive at the
  proxy undresolved (SOCKS5's domain-name address type, not a pre-resolved
  IP), the kill-switch holds when the proxy disappears mid-session, and
  `proxyBypassRules: ''` still leaves navigation blocked when the proxy is
  down (i.e., nothing implicitly bypasses to direct).
- `docs/threat-model.md`'s "Network-level observer" row moves from
  out-of-scope to "mitigated when Tor mode is enabled, with these limits":
  Tor itself must be trusted and running, exit-node visibility is unchanged
  from using Tor directly, and — candidly — this is footprint elimination
  plus transport privacy, not anonymity parity with Tor Browser (no uniform
  fingerprint, no circuit-health control-port integration in v1).
