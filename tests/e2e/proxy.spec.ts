import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { startFakeSocks5Server, type FakeSocks5Server } from './support/fake-socks5'
import { startFakeHttpProxyServer, type FakeHttpProxyServer } from './support/fake-http-proxy'

// Proxy mode (ADR 0007, generalized to any scheme by ADR 0012). Verifies,
// against hand-rolled hermetic proxy servers (never the real network or a real
// Tor instance), the properties the design depends on — for both the SOCKS5
// (Tor) default and the HTTP proxy scheme a VPN/provider would expose:
//   1. traffic actually flows through the configured proxy when enabled, and
//      the destination hostname arrives at the proxy UNRESOLVED (SOCKS5's
//      domain-name address type / an HTTP proxy's absolute-form request target
//      — a pre-resolved IP would mean a DNS leak to the local resolver before
//      the proxy ever saw the request);
//   2. the kill-switch: if the proxy becomes unreachable, navigation fails
//      closed (a proxy-specific error) rather than silently falling back to a
//      direct connection;
//   3. whether proxyBypassRules: '' still leaves localhost/loopback implicitly
//      exempt from the proxy — recorded here as an observed empirical fact
//      (see docs/threat-model.md), not assumed from docs.

type Scheme = 'socks5' | 'http' | 'https'

const CHIP_LABEL: Record<Scheme, string> = { socks5: 'Tor', http: 'HTTP', https: 'HTTPS' }
const SCHEME_BUTTON: Record<Scheme, string> = {
  socks5: 'Tor / SOCKS5',
  http: 'HTTP',
  https: 'HTTPS'
}

function serveMarker(marker: string): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<title>${marker}</title>`)
  })
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js')]
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.address-bar__input')
  return { app, window }
}

async function navigate(window: Page, url: string): Promise<void> {
  const input = window.locator('.address-bar__input')
  await input.click()
  await input.fill(url)
  await input.press('Enter')
}

async function enableProxy(window: Page, scheme: Scheme, port: number): Promise<void> {
  await window.locator('.proxy-control__chip').click()
  await window.getByRole('button', { name: SCHEME_BUTTON[scheme], exact: true }).click()
  const hostInput = window.locator('.proxy-control__field input').first()
  const portInput = window.locator('.proxy-control__field input').nth(1)
  await hostInput.fill('127.0.0.1')
  await portInput.fill(String(port))
  await window.getByRole('button', { name: 'Save' }).click()
  await window.getByRole('button', { name: `Enable ${CHIP_LABEL[scheme]}` }).click()
  await expect(window.locator('.proxy-control__chip')).toHaveText(`${CHIP_LABEL[scheme]}: On`, {
    timeout: 10_000
  })
}

test('SOCKS5: traffic flows through the proxy, hostname arrives unresolved', async () => {
  const backend = serveMarker('VIA-PROXY')
  const backendPort = await listen(backend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(backendPort)
  const { app, window } = await launchApp()

  try {
    await enableProxy(window, 'socks5', socks.port)

    // .invalid is reserved (RFC 2606): guaranteed to never resolve via a
    // real resolver. If this navigation succeeds at all, the hostname
    // cannot have been resolved locally — it must have reached the proxy.
    await navigate(window, 'http://socks-test.invalid:4321/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('VIA-PROXY', {
      timeout: 15_000
    })

    expect(socks.connectLog).toHaveLength(1)
    expect(socks.connectLog[0]).toEqual({ atyp: 0x03, address: 'socks-test.invalid', port: 4321 })
  } finally {
    await app.close()
    await socks.close()
    backend.close()
  }
})

test('SOCKS5 kill-switch: an unreachable proxy fails the navigation, never falls back to direct', async () => {
  const backend = serveMarker('VIA-PROXY')
  const backendPort = await listen(backend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(backendPort)
  const { app, window } = await launchApp()

  try {
    await enableProxy(window, 'socks5', socks.port)
    await navigate(window, 'http://socks-test.invalid:4321/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('VIA-PROXY', {
      timeout: 15_000
    })

    // Kill the proxy mid-session, then try a fresh destination. A fallback
    // to direct would fail too (kill-switch-off.invalid can't resolve
    // either) but with a DNS error, not a proxy error — the error code is
    // what distinguishes "correctly failed closed" from "quietly tried
    // direct and failed for an unrelated reason".
    await socks.close()
    await navigate(window, 'http://kill-switch-off.invalid:4321/')
    await expect(window.locator('.error-page__title')).toBeVisible({ timeout: 15_000 })
    const description = await window.locator('.error-page__code').textContent()
    expect(description).toContain('PROXY')
    expect(description).not.toContain('NAME_NOT_RESOLVED')
  } finally {
    await app.close()
    backend.close()
  }
})

test('SOCKS5: proxyBypassRules "" still leaves localhost routed direct, not through the proxy', async () => {
  const proxyBackend = serveMarker('VIA-PROXY')
  const proxyBackendPort = await listen(proxyBackend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(proxyBackendPort)
  const directServer = serveMarker('DIRECT-LOCALHOST')
  const directPort = await listen(directServer)
  const { app, window } = await launchApp()

  try {
    await enableProxy(window, 'socks5', socks.port)
    await navigate(window, `http://localhost:${directPort}/`)
    // Confirmed empirically (twice, independently) rather than assumed from
    // docs: Chromium bypasses localhost/loopback by default regardless of an
    // empty proxyBypassRules — see docs/threat-model.md's network-observer
    // row and research/session-and-userdata.md §22. This is a regression
    // guard: if a future Electron/Chromium bump silently changes this
    // default, this assertion is what catches it, not just a log line.
    await expect(window.locator('.tab--active .tab__title')).toHaveText('DIRECT-LOCALHOST', {
      timeout: 15_000
    })
    expect(socks.connectLog).toHaveLength(0)
  } finally {
    await app.close()
    await socks.close()
    directServer.close()
  }
})

test('HTTP proxy: traffic flows through the proxy, hostname arrives unresolved', async () => {
  const backend = serveMarker('VIA-HTTP-PROXY')
  const backendPort = await listen(backend)
  const proxy: FakeHttpProxyServer = await startFakeHttpProxyServer(backendPort)
  const { app, window } = await launchApp()

  try {
    await enableProxy(window, 'http', proxy.port)

    // .invalid never resolves via a real resolver. Success here means the
    // hostname reached the HTTP proxy in the request target — Chromium did
    // NOT resolve it locally. This is the HTTP-proxy equivalent of SOCKS5's
    // domain-name address type: no local DNS leak (ADR 0012, DNS-at-proxy).
    await navigate(window, 'http://http-test.invalid:4321/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('VIA-HTTP-PROXY', {
      timeout: 15_000
    })

    // The destination host arrived at the proxy as the literal, UNRESOLVED name
    // (`http-test.invalid`) on the request target — never a pre-resolved IP.
    // Searched, not asserted by index: the enable-time health probe also sends
    // the proxy a CONNECT (to its own reserved `amnesic-probe.invalid`), so the
    // navigation's entry is not guaranteed to be requestLog[0]. That the probe
    // host is ALSO an unresolved `.invalid` name is itself further evidence of
    // DNS-at-proxy, but this assertion targets the real navigation.
    expect(proxy.requestLog.some((r) => r.host === 'http-test.invalid' && r.port === 4321)).toBe(
      true
    )
    // And crucially: no entry ever arrived as a resolved loopback/IP for that
    // destination — the hostname was never resolved locally.
    expect(proxy.requestLog.every((r) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(r.host))).toBe(true)
  } finally {
    await app.close()
    await proxy.close()
    backend.close()
  }
})

test('HTTP proxy kill-switch: an unreachable proxy fails the navigation, never falls back to direct', async () => {
  const backend = serveMarker('VIA-HTTP-PROXY')
  const backendPort = await listen(backend)
  const proxy: FakeHttpProxyServer = await startFakeHttpProxyServer(backendPort)
  const { app, window } = await launchApp()

  try {
    await enableProxy(window, 'http', proxy.port)
    await navigate(window, 'http://http-test.invalid:4321/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('VIA-HTTP-PROXY', {
      timeout: 15_000
    })

    // Kill the HTTP proxy, then try a fresh destination. A bare http://host:port
    // proxy rule has no direct fallback (ADR 0012, same as SOCKS5), so this must
    // fail with a PROXY error, never a DNS error from a quiet direct attempt.
    await proxy.close()
    await navigate(window, 'http://kill-switch-off.invalid:4321/')
    await expect(window.locator('.error-page__title')).toBeVisible({ timeout: 15_000 })
    const description = await window.locator('.error-page__code').textContent()
    expect(description).toContain('PROXY')
    expect(description).not.toContain('NAME_NOT_RESOLVED')
  } finally {
    await app.close()
    backend.close()
  }
})
