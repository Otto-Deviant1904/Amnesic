import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROXY_CONFIG,
  probeHttpProxy,
  probeProxy,
  probeSocks5,
  proxyRulesFor,
  validateProxyConfig,
  type ProxyConfig
} from '../../src/main/proxy'

describe('DEFAULT_PROXY_CONFIG', () => {
  it('is the Tor SOCKS5 endpoint (unchanged flagship default)', () => {
    expect(DEFAULT_PROXY_CONFIG).toEqual({ scheme: 'socks5', host: '127.0.0.1', port: 9050 })
  })
})

describe('validateProxyConfig', () => {
  it('accepts each supported scheme with a valid host/port', () => {
    expect(validateProxyConfig('socks5', '127.0.0.1', 9050)).toBeNull()
    expect(validateProxyConfig('http', 'proxy.example.com', 8080)).toBeNull()
    expect(validateProxyConfig('https', 'localhost', 3128)).toBeNull()
  })

  it('rejects SOCKS4 and any other unsupported scheme', () => {
    // SOCKS4 is excluded on purpose (ADR 0012): it leaks every hostname to the
    // local resolver. It must never validate through.
    expect(validateProxyConfig('socks4', '127.0.0.1', 9050)).toMatch(/scheme/)
    expect(validateProxyConfig('socks', '127.0.0.1', 9050)).toMatch(/scheme/)
    expect(validateProxyConfig('ftp', '127.0.0.1', 9050)).toMatch(/scheme/)
  })

  it('accepts localhost, hostnames, and IPv4 addresses', () => {
    expect(validateProxyConfig('socks5', 'localhost', 9050)).toBeNull()
    expect(validateProxyConfig('socks5', '127.0.0.1', 9050)).toBeNull()
    expect(validateProxyConfig('socks5', 'tor.example.com', 9150)).toBeNull()
  })

  it('rejects an out-of-range octet even if it looks IPv4-shaped', () => {
    expect(validateProxyConfig('socks5', '999.1.1.1', 9050)).toMatch(/valid/)
  })

  it('rejects invalid hostnames', () => {
    expect(validateProxyConfig('http', 'not a host', 9050)).toMatch(/valid/)
    expect(validateProxyConfig('http', '', 9050)).toMatch(/valid/)
  })

  it('rejects out-of-range or non-integer ports', () => {
    expect(validateProxyConfig('socks5', '127.0.0.1', 0)).toMatch(/[Pp]ort/)
    expect(validateProxyConfig('socks5', '127.0.0.1', 65536)).toMatch(/[Pp]ort/)
    expect(validateProxyConfig('socks5', '127.0.0.1', 9050.5)).toMatch(/[Pp]ort/)
  })
})

describe('proxyRulesFor', () => {
  it('produces a bare <scheme>://host:port string per scheme, with no fallback entry', () => {
    expect(proxyRulesFor({ scheme: 'socks5', host: '127.0.0.1', port: 9050 })).toBe(
      'socks5://127.0.0.1:9050'
    )
    expect(proxyRulesFor({ scheme: 'http', host: 'proxy.example.com', port: 8080 })).toBe(
      'http://proxy.example.com:8080'
    )
    expect(proxyRulesFor({ scheme: 'https', host: '10.0.0.2', port: 3128 })).toBe(
      'https://10.0.0.2:3128'
    )
  })

  it('never contains a comma (the fail-closed guarantee, ADR 0007 decision 4)', () => {
    // A comma-joined proxyRules list is exactly how Chromium's fallback-to-
    // direct syntax works — an unreachable proxy must fail closed, never fall
    // back to a direct connection, for every scheme.
    for (const scheme of ['socks5', 'http', 'https'] as const) {
      expect(proxyRulesFor({ scheme, host: 'h', port: 1 })).not.toContain(',')
    }
  })
})

describe('probeSocks5', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('resolves true against a real SOCKS5 method-selection reply', async () => {
    server = createServer((socket) => {
      socket.once('data', () => socket.write(Buffer.from([0x05, 0x00])))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    await expect(probeSocks5({ scheme: 'socks5', host: '127.0.0.1', port })).resolves.toBe(true)
  })

  it('resolves false against a non-SOCKS listener (e.g. a stray HTTP server)', async () => {
    server = createServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    await expect(probeSocks5({ scheme: 'socks5', host: '127.0.0.1', port })).resolves.toBe(false)
  })

  it('resolves false when nothing is listening', async () => {
    // Port 1 is a privileged, essentially-never-bound port — used here only
    // to get a reliable "connection refused" without racing a real bind.
    await expect(probeSocks5({ scheme: 'socks5', host: '127.0.0.1', port: 1 }, 500)).resolves.toBe(
      false
    )
  })

  it('resolves false on timeout against a listener that never replies', async () => {
    server = createServer(() => {
      /* accept the connection, never respond */
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    await expect(probeSocks5({ scheme: 'socks5', host: '127.0.0.1', port }, 200)).resolves.toBe(
      false
    )
  })
})

describe('probeHttpProxy / probeProxy dispatch', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  it('resolves true against an endpoint that answers a CONNECT with an HTTP/1.x status line', async () => {
    // A real HTTP proxy answers a CONNECT (even to an unreachable host) with an
    // HTTP status line — that is what the probe confirms: protocol, not
    // connectivity.
    server = createServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    const config: ProxyConfig = { scheme: 'http', host: '127.0.0.1', port }
    await expect(probeHttpProxy(config)).resolves.toBe(true)
    // probeProxy dispatches by scheme to the same result.
    await expect(probeProxy(config)).resolves.toBe(true)
  })

  it('resolves false against a listener that speaks a non-HTTP protocol (e.g. SOCKS5)', async () => {
    server = createServer((socket) => {
      socket.once('data', () => socket.write(Buffer.from([0x05, 0x00])))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    await expect(probeHttpProxy({ scheme: 'http', host: '127.0.0.1', port })).resolves.toBe(false)
  })

  it('resolves false when nothing is listening', async () => {
    await expect(probeHttpProxy({ scheme: 'http', host: '127.0.0.1', port: 1 }, 500)).resolves.toBe(
      false
    )
  })
})
