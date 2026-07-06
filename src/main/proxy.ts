import { connect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

// Proxy integration (ADR 0007, generalized by ADR 0012). Bring-your-own-proxy:
// this module never spawns or manages a proxy process, only connects to one
// already running (a local Tor instance for the SOCKS5 default, or any HTTP/
// HTTPS proxy a VPN or provider exposes). Session-only state — nothing here is
// ever persisted, and every launch starts with the proxy off (CLAUDE.md's
// no-persisted-settings rule).
//
// Scheme = how the browser talks to the PROXY, independent of the destination
// scheme. SOCKS4 is deliberately excluded (ADR 0012): it has no domain-name
// address type, so it would force a local hostname resolution and leak every
// destination to the local resolver before the proxy ever saw the request —
// exactly the leak SOCKS5/HTTP/HTTPS all avoid by resolving DNS at the proxy.

export type ProxyScheme = 'socks5' | 'http' | 'https'

export interface ProxyConfig {
  scheme: ProxyScheme
  host: string
  port: number
}

// Tor stays the flagship default: a SOCKS5 proxy on the standard local Tor
// port. Unchanged from ADR 0007 — generalizing the scheme did not move the
// default.
export const DEFAULT_PROXY_CONFIG: ProxyConfig = { scheme: 'socks5', host: '127.0.0.1', port: 9050 }

export const PROXY_SCHEMES: readonly ProxyScheme[] = ['socks5', 'http', 'https']

function isProxyScheme(value: string): value is ProxyScheme {
  return (PROXY_SCHEMES as readonly string[]).includes(value)
}

const HOSTNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isValidHost(host: string): boolean {
  if (host === 'localhost') return true
  const ipv4 = IPV4_RE.exec(host)
  if (ipv4) return ipv4.slice(1).every((octet) => Number(octet) <= 255)
  return HOSTNAME_RE.test(host)
}

export function validateProxyConfig(scheme: string, host: string, port: number): string | null {
  if (!isProxyScheme(scheme)) return 'Proxy scheme must be socks5, http, or https'
  if (!isValidHost(host)) return 'Not a valid hostname or IPv4 address'
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be between 1 and 65535'
  return null
}

// The exact proxyRules string Electron/Chromium's proxy-rules parser
// recognizes for a single proxy, scheme included — verified against Electron's
// ProxyConfig docs (research/session-and-userdata.md §22/§24). The scheme is
// how the browser reaches the PROXY (socks5://, http://, https://), not the
// destination's scheme. Deliberately never comma-joined with a fallback entry:
// a bare "<scheme>://host:port" has no failover for Chromium to fail open to if
// the proxy is unreachable, which is exactly the fail-closed guarantee ADR 0007
// decision 4 (kept by ADR 0012 for every scheme) depends on. Never construct
// this as part of a larger, comma-separated proxyRules string.
export function proxyRulesFor(config: ProxyConfig): string {
  return `${config.scheme}://${config.host}:${config.port}`
}

// Health-check probe (ADR 0007 decision 4, generalized by ADR 0012):
// dispatches to a scheme-appropriate handshake, never a bare "is the TCP port
// open" check. Each variant confirms the configured endpoint actually speaks
// the expected proxy protocol — a listener that isn't (a stray web server, an
// SSH daemon, a half-open port) must be treated as "proxy not usable", never
// as a green light that would let a tab silently load direct.
export function probeProxy(config: ProxyConfig, timeoutMs = 3000): Promise<boolean> {
  switch (config.scheme) {
    case 'socks5':
      return probeSocks5(config, timeoutMs)
    case 'http':
      return probeHttpProxy(config, timeoutMs)
    case 'https':
      return probeHttpsProxy(config, timeoutMs)
  }
}

// SOCKS5 method-negotiation handshake (RFC 1928 §3), unchanged from ADR 0007.
// Sends the version/method greeting and confirms a version-5 method-selection
// reply. This never sends a CONNECT request and never touches any destination
// host — it only confirms the configured endpoint itself speaks the protocol.
export function probeSocks5(config: ProxyConfig, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host: config.host, port: config.port })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      // Version 5, one method offered: 0x00 (no authentication).
      socket.write(Buffer.from([0x05, 0x01, 0x00]))
    })
    socket.once('data', (data: Buffer) => {
      // A SOCKS5 method-selection reply is exactly 2 bytes: [version, method].
      // method 0xff means "no acceptable methods" — the far end understood
      // SOCKS5 framing but rejected us, which still confirms it speaks the
      // protocol; anything version-5 counts as a successful probe.
      finish(data.length >= 2 && data[0] === 0x05)
    })
  })
}

// A CONNECT request for a reserved, guaranteed-unresolvable host (RFC 2606
// .invalid). What this proves: the endpoint replies with an HTTP/1.x status
// line, i.e. it speaks the HTTP CONNECT-proxy protocol rather than just having
// an open TCP port. What it deliberately does NOT prove: that the proxy can
// actually reach the wider internet, or that any real destination is
// reachable — the target host never resolves, so a well-behaved proxy answers
// with an error status (502/504/400/405), which still starts with "HTTP/1."
// and still confirms the protocol. This mirrors, in spirit, the SOCKS5
// handshake probe: protocol confirmation, not connectivity guarantee.
function httpConnectProbeRequest(): Buffer {
  return Buffer.from(
    'CONNECT amnesic-probe.invalid:443 HTTP/1.1\r\nHost: amnesic-probe.invalid:443\r\n\r\n'
  )
}

function isHttpStatusLine(data: Buffer): boolean {
  return /^HTTP\/1\.[01] \d{3}/.test(data.toString('latin1', 0, 32))
}

export function probeHttpProxy(config: ProxyConfig, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host: config.host, port: config.port })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write(httpConnectProbeRequest()))
    socket.once('data', (data: Buffer) => finish(isHttpStatusLine(data)))
  })
}

// HTTPS-proxy probe: the connection to the proxy is itself TLS (the browser
// speaks HTTP CONNECT over a TLS socket to the proxy), so the probe must be a
// TLS connection too — verified reachable via node:tls against Electron 43's
// Node runtime (research/session-and-userdata.md §24). rejectUnauthorized is
// deliberately FALSE here and only here: this probe checks reachability + that
// the endpoint speaks HTTP-over-TLS, exactly as the SOCKS5 probe checks
// protocol without validating any credential. It does NOT weaken the real
// connection — Chromium validates the HTTPS proxy's certificate itself on the
// actual proxied traffic; loosening it on this throwaway probe socket cannot
// reach that path. An honest, documented weaker check, not a false claim of
// full validation.
export function probeHttpsProxy(config: ProxyConfig, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = tlsConnect({
      host: config.host,
      port: config.port,
      servername: config.host,
      rejectUnauthorized: false
    })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('error', () => finish(false))
    socket.once('secureConnect', () => socket.write(httpConnectProbeRequest()))
    socket.once('data', (data: Buffer) => finish(isHttpStatusLine(data)))
  })
}
