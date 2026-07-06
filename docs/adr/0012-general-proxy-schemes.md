# 0012: Generalize the proxy to any user-supplied scheme (SOCKS5 + HTTP + HTTPS)

## Status

Accepted (owner approval given for this scope, 2026-07-06). Extends ADR 0007;
does not supersede it. Every decision in ADR 0007 still holds — this ADR only
widens the single hard-coded `socks5://` scheme into a small, closed set of
schemes and renames the feature from "Tor mode" to "proxy mode (Tor by
default)" so the code and UI stop implying Tor when a non-Tor proxy is in use.

## Context

ADR 0007 shipped a bring-your-own-Tor integration: the browser routes tab
traffic through a SOCKS5 proxy the user already runs (default the local Tor
port `127.0.0.1:9050`), fail-closed, DNS resolved at the proxy. In practice
users asked for the honest, browser-scoped equivalent of "use my VPN": point
the browser at a proxy their VPN or provider already exposes, which is very
often an **HTTP or HTTPS** proxy rather than SOCKS5.

That is squarely in charter — it is still bring-your-own-proxy, still transport
privacy at the session level, still no bundled daemon and no persisted setting.
It is **not** a system VPN (no TUN device, no root, no bundled tunnel — see
Rejected alternatives). The only real design question is which proxy schemes to
support and how to keep every ADR 0007 guarantee (fail-closed kill-switch,
DNS-at-proxy, no-tabs-navigated gate, both-sessions + all-live-tab-sessions
application per ADR 0011, empty bypass list, mandatory WebRTC layers) true for
each of them.

## Decision

1. **Config gains a scheme.** The proxy config becomes
   `{ scheme: 'socks5' | 'http' | 'https', host, port }`, default
   `{ scheme: 'socks5', host: '127.0.0.1', port: 9050 }` — the unchanged Tor
   default. `proxyRulesFor()` returns `` `${scheme}://${host}:${port}` `` and is
   **still never comma-joined and still has no `direct://` fallback entry**, for
   any scheme. That exact invariant (verified in
   `research/session-and-userdata.md` §22/§24) is what makes the kill-switch
   fail closed rather than fall open to a direct connection; it is scheme-
   independent and load-bearing for all three.

2. **Scheme list is closed at exactly these three. SOCKS4 is deliberately
   excluded.** ADR 0007 decision 3 already documents why: SOCKS4 has no
   domain-name address type and requires a pre-resolved IPv4 address, so using
   it would force a **local** hostname resolution and leak every destination to
   the local resolver before the proxy ever saw the connection — the exact leak
   SOCKS5, HTTP, and HTTPS all avoid by resolving DNS at the proxy. Excluding
   SOCKS4 is an honesty decision, not an oversight: `validateProxyConfig`
   rejects `socks4`, the bare `socks` alias (which Chromium historically maps to
   SOCKS4), and anything else outside `{socks5, http, https}`.

3. **DNS-at-proxy holds for HTTP/HTTPS, and is proven, not assumed.** With an
   HTTP/HTTPS proxy set, Chromium sends the destination **hostname** to the
   proxy — absolute-form request target (`GET http://host:port/path`) for
   `http://` destinations, `CONNECT host:port` for `https://` destinations — and
   does not resolve it locally. This is the same no-local-DNS-leak property
   SOCKS5 has. Per this project's verify-don't-assume rule it is confirmed by
   the e2e harness (`tests/e2e/support/fake-http-proxy.ts` +
   `tests/e2e/proxy.spec.ts`): the fake HTTP proxy records the destination host
   as it arrived on the wire, and the test navigates to a reserved
   `*.invalid` hostname (RFC 2606, never resolvable) and asserts the proxy
   received the literal unresolved name, never a pre-resolved IP. Had Chromium
   pre-resolved the name, the navigation would have failed with a DNS error and
   the proxy log would be empty — the test fails closed rather than shipping a
   leak. See `research/session-and-userdata.md` §24.

4. **Kill-switch holds for HTTP/HTTPS.** A bare `http://host:port` (or
   `https://host:port`) rule has no comma-joined fallback and no `direct://`
   escape, so an unreachable HTTP proxy fails the navigation with an
   `ERR_PROXY_CONNECTION_FAILED`-class error rather than quietly connecting
   direct — identical to the SOCKS5 case. Proven in `tests/e2e/proxy.spec.ts`
   (the HTTP kill-switch test asserts a `PROXY` error, never `NAME_NOT_RESOLVED`
   from a stealth direct attempt).

5. **Scheme-aware health probe.** ADR 0007's SOCKS5 handshake probe
   (`probeSocks5`, RFC 1928 method negotiation) is unchanged and still used for
   `socks5`. A generic `probeProxy(config)` dispatches by scheme:
   - `http`: `probeHttpProxy` — plain TCP connect, send a `CONNECT` for a
     reserved `*.invalid` host, and confirm the reply is an `HTTP/1.x` status
     line. This proves the endpoint speaks the HTTP CONNECT-proxy protocol (not
     merely that a TCP port is open); it deliberately does **not** prove the
     proxy can reach the wider internet, since the probe target never resolves —
     a well-behaved proxy answers with an error status, which still confirms the
     protocol. Honest in the code comment about exactly this.
   - `https`: `probeHttpsProxy` — the connection to the proxy is itself TLS, so
     the probe uses `node:tls.connect` (verified reachable on Electron 43's Node
     runtime) then does the same CONNECT/status-line check over TLS. It uses
     `rejectUnauthorized: false` **only on the throwaway probe socket**: it
     checks reachability + that the endpoint speaks HTTP-over-TLS, exactly as
     the SOCKS5 probe checks protocol without validating a credential. It does
     not — and cannot — weaken Chromium's own certificate validation on the real
     proxied traffic. A documented weaker check, not a false claim of full
     validation.

6. **Tor stays the flagship, and the UI says so.** The toolbar chip and popover
   present SOCKS5 `127.0.0.1:9050` as the one-click default, explicitly labeled
   as the Tor setting, and keep the shield icon. HTTP/HTTPS with a custom
   host/port are offered as "a VPN or other provider's proxy." The
   no-tabs-navigated gate (ADR 0007 decision 7 / 7a), the both-sessions +
   all-live-tab-sessions application (ADR 0011 `liveTabSessions()`), the empty
   `proxyBypassRules`, and the honest status text all carry over unchanged.

7. **WebRTC / CDP layers stay mandatory and unconditional, for every scheme.**
   `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` and the CDP script
   that deletes `RTCPeerConnection` etc. (ADR 0002/0003, threat-model
   §"WebRTC IP leak") are per-`webContents` and applied to every tab regardless
   of proxy scheme. SOCKS and HTTP/HTTPS proxies all operate on TCP; WebRTC's
   ICE/STUN uses UDP and bypasses them, so those layers are exactly why the CDP
   removal exists — it is not a SOCKS-specific mitigation and does not change
   here.

## Honesty (per-scheme)

All three schemes resolve DNS **at the proxy** (no local leak). But the trust
model differs from Tor's and the UI/README must not let anyone read an HTTP
proxy as "as private as Tor":

- **SOCKS5 → Tor (default):** Tor's relay model means no single operator sees
  both your real IP and your destinations. Honestly scoped limits are unchanged
  from ADR 0007 (no uniform fingerprint, no control-port/circuit integration,
  New Identity only rotates the browser session).
- **HTTP / HTTPS (a VPN or provider's proxy):** you are trusting **one**
  operator — the endpoint you point at sees your real source IP and can
  correlate all your traffic. This is transport privacy, **not** anonymity and
  **not** anti-fingerprinting. `https://` additionally encrypts the
  browser↔proxy hop (the `http://` hop to the proxy is not itself encrypted,
  though the destination's own TLS still applies end-to-end for `https://`
  destinations).

## Rejected alternatives

- **A full system VPN (TUN device / WireGuard / provider APIs).** Out of scope
  and out of charter: it needs root or a privileged helper to create a TUN
  interface and route the whole host, breaking this project's unprivileged-
  sandbox posture, and would mean bundling or managing a tunnel daemon — the
  same lifecycle/security-surface problem ADR 0007 decision 1 rejected for a
  bundled Tor daemon. "Point the browser at a proxy the user already runs" is
  the honest, browser-scoped slice of "use my VPN" that stays in charter.
- **SOCKS4.** Rejected — leaks DNS (decision 2 above; ADR 0007 decision 3).
- **PAC-script routing / a bypass list / split-tunneling.** Still rejected, same
  as ADR 0007 decisions 4 and 6: a `direct` fallback or a per-domain bypass is
  exactly the silent-leak footgun the fail-closed design exists to prevent.
  `proxyBypassRules` stays empty for every scheme (Chromium's default localhost
  bypass remains the one documented, tested exception).

## Consequences

- The feature is renamed for honesty (a `tor.ts` carrying HTTP-proxy logic would
  mislead, the same reason `applySessionMitigations` became `hardenSession`):
  `src/main/tor.ts`→`src/main/proxy.ts`, `TorControl.tsx`→`ProxyControl.tsx`,
  the `TOR_*` IPC channels→`PROXY_*`, `torEnabled`→`proxyEnabled`,
  `TorConfig`/`TorStatus`/`TorResult`→`ProxyConfig`/`ProxyStatus`/`ProxyResult`.
  No behavior changes for existing SOCKS5/Tor users — the default and its
  fail-closed guarantees are identical.
- `DnsControl` now greys out on `proxyEnabled` (any proxy resolves DNS at the
  proxy), unchanged behavior with the selection preserved.
- Verification grows a second hermetic proxy server
  (`tests/e2e/support/fake-http-proxy.ts`) and HTTP route + kill-switch e2e
  coverage, alongside the unchanged SOCKS5 cases; `proxyRulesFor`/validation/
  probe-dispatch are unit-tested per scheme in `tests/unit/proxy.test.ts`.
- `docs/threat-model.md`'s network-observer row generalizes from "Tor mode" to
  "proxy mode (Tor by default)" with the per-scheme honesty above and the
  confirmed localhost-bypass caveat retained.
