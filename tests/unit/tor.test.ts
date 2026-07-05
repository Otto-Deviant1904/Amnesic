import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeSocks5, proxyRulesFor, validateTorConfig } from '../../src/main/tor'

describe('validateTorConfig', () => {
  it('accepts localhost, hostnames, and IPv4 addresses', () => {
    expect(validateTorConfig('localhost', 9050)).toBeNull()
    expect(validateTorConfig('127.0.0.1', 9050)).toBeNull()
    expect(validateTorConfig('tor.example.com', 9150)).toBeNull()
  })

  it('rejects an out-of-range octet even if it looks IPv4-shaped', () => {
    expect(validateTorConfig('999.1.1.1', 9050)).toMatch(/valid/)
  })

  it('rejects invalid hostnames', () => {
    expect(validateTorConfig('not a host', 9050)).toMatch(/valid/)
    expect(validateTorConfig('', 9050)).toMatch(/valid/)
  })

  it('rejects out-of-range or non-integer ports', () => {
    expect(validateTorConfig('127.0.0.1', 0)).toMatch(/[Pp]ort/)
    expect(validateTorConfig('127.0.0.1', 65536)).toMatch(/[Pp]ort/)
    expect(validateTorConfig('127.0.0.1', 9050.5)).toMatch(/[Pp]ort/)
  })
})

describe('proxyRulesFor', () => {
  it('produces a bare socks5:// string with no fallback entry', () => {
    const rules = proxyRulesFor({ host: '127.0.0.1', port: 9050 })
    expect(rules).toBe('socks5://127.0.0.1:9050')
    // The fail-closed guarantee (ADR 0007 decision 4) depends on this never
    // containing a comma — a comma-joined proxyRules list is exactly how
    // Chromium's fallback-to-direct syntax works.
    expect(rules).not.toContain(',')
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
    await expect(probeSocks5({ host: '127.0.0.1', port })).resolves.toBe(true)
  })

  it('resolves false against a non-SOCKS listener (e.g. a stray HTTP server)', async () => {
    server = createServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    await expect(probeSocks5({ host: '127.0.0.1', port })).resolves.toBe(false)
  })

  it('resolves false when nothing is listening', async () => {
    // Port 1 is a privileged, essentially-never-bound port — used here only
    // to get a reliable "connection refused" without racing a real bind.
    await expect(probeSocks5({ host: '127.0.0.1', port: 1 }, 500)).resolves.toBe(false)
  })

  it('resolves false on timeout against a listener that never replies', async () => {
    server = createServer(() => {
      /* accept the connection, never respond */
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    await expect(probeSocks5({ host: '127.0.0.1', port }, 200)).resolves.toBe(false)
  })
})
