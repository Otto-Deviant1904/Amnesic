# 0007: Tor/SOCKS proxy integration

## Status

Proposed — this is a design for review, not an implementation. CLAUDE.md
lists "Tor / SOCKS proxy integration" under non-goals that require explicit
human approval before any code is written; nothing in this ADR has been
built. Do not begin implementation until this is Accepted.

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

2. **Proxy set at the session level, before any tab exists — and on both
   sessions, not just the tab partition.** `session.setProxy({ proxyRules:
'socks5://host:port' })` on the in-memory partition used for tabs
   (`session.fromPartition('inmemory-session', ...)`, threat-model
   §"Cookies / LocalStorage..."), applied once at startup before
   `createTab()` is ever called — never per-tab, and never toggled
   mid-session. Critically, the same call must also run against
   `session.defaultSession`, alongside `applySessionMitigations()`
   (`src/main/index.ts`), not left as tab-partition-only. This project has
   already hit this exact class of bug once: `defaultSession` backs the
   shell window and is Electron's fallback for anything not explicitly
   assigned a session, and a prior security review flagged mitigations
   applied only to the tab partition as a real parity gap (the comment
   above `applySessionMitigations` documents it). A proxy config with the
   same gap — tabs proxied, `defaultSession` not — would be a silent leak
   in exactly the spot this project has already been burned on, and directly
   contradicts decision 4's fail-closed requirement if anything ever routes
   through `defaultSession` unproxied.

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
   changeable only when no tabs are open (forces a clean session boundary —
   consistent with decision 2) — exact placement is a follow-up design, not
   part of this ADR.

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

## Open questions for the approval discussion

- Should the app attempt to detect a running Tor instance automatically
  (probe default ports) or always require explicit user configuration?
  Auto-detection is more usable but adds a scan-for-a-local-service pattern
  worth scrutinizing on its own.
- Does Tor mode change any threat-model claims about fingerprinting
  (threat-model's existing "sites can still fingerprint during the session"
  caveat gets more serious when Tor Browser's uniform fingerprint is the
  implicit comparison point users will bring)? This ADR deliberately does
  not touch anti-fingerprinting (a separate non-goal in CLAUDE.md) — flagging
  the gap rather than scoping it in.
- Control-port integration (decision 4's circuit-health check) requires a
  Tor control port with auth configured on the user's side — is that an
  acceptable setup burden, or should the health check be limited to the
  SOCKS handshake probe alone?

## Consequences (if accepted)

- New per-session state (proxy config) that must be re-applied identically
  on every relaunch path (fresh start, the XDG_CACHE_HOME relaunch bootstrap
  from ADR 0004) — needs its own audit for "does this survive every launch
  path" the way ADR 0004 audited env-var propagation.
- New failure-mode UI (blocking error state when the proxy probe fails) that
  doesn't exist anywhere else in the app today.
- Verification burden grows: `scripts/verify_footprint.sh` proves nothing
  about network egress, so this feature needs its own verification script
  (e.g. asserting no direct-connection attempt occurs when the proxy is
  down) before it can be considered proven rather than just implemented.
