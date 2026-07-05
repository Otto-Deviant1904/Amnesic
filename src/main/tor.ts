import { connect } from 'node:net'

// Tor/SOCKS5 integration (ADR 0007). Bring-your-own-Tor: this module never
// spawns or manages a tor process, only connects to one already running.
// Session-only state — nothing here is ever persisted, and every launch
// starts with Tor off (CLAUDE.md's no-persisted-settings rule).

export interface TorConfig {
  host: string
  port: number
}

export const DEFAULT_TOR_CONFIG: TorConfig = { host: '127.0.0.1', port: 9050 }

const HOSTNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isValidHost(host: string): boolean {
  if (host === 'localhost') return true
  const ipv4 = IPV4_RE.exec(host)
  if (ipv4) return ipv4.slice(1).every((octet) => Number(octet) <= 255)
  return HOSTNAME_RE.test(host)
}

export function validateTorConfig(host: string, port: number): string | null {
  if (!isValidHost(host)) return 'Not a valid hostname or IPv4 address'
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be between 1 and 65535'
  return null
}

// The exact proxyRules string Electron/Chromium's proxy-rules parser
// recognizes for a SOCKS version 5 proxy — verified against Electron's
// ProxyConfig docs (research/session-and-userdata.md §22). Deliberately
// never comma-joined with a fallback entry: a bare "socks5://host:port"
// has no failover for Chromium to fail open to if the proxy is
// unreachable, which is exactly the fail-closed guarantee ADR 0007
// decision 4 depends on. Never construct this as part of a larger,
// comma-separated proxyRules string.
export function proxyRulesFor(config: TorConfig): string {
  return `socks5://${config.host}:${config.port}`
}

// Health-check probe (ADR 0007 decision 4): a raw SOCKS5 method-negotiation
// handshake (RFC 1928 §3), not just "is the TCP port open" — a listener
// that isn't actually speaking SOCKS5 would either refuse the connection,
// hang, or reply with something that isn't a valid method-selection
// message, and all three must be treated as "Tor is not usable", not as a
// green light. This never sends a CONNECT request and never touches any
// destination host — it only confirms the configured endpoint itself
// speaks the protocol.
export function probeSocks5(config: TorConfig, timeoutMs = 3000): Promise<boolean> {
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
