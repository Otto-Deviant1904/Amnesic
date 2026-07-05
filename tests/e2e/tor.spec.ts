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

// Tor/SOCKS5 mode (ADR 0007). Verifies, against a hand-rolled hermetic
// SOCKS5 server (never touches the real network or a real Tor instance),
// the three properties the ADR's design depends on:
//   1. traffic actually flows through the configured proxy when enabled,
//      and the hostname arrives at the proxy unresolved (SOCKS5's
//      domain-name address type — a pre-resolved IP would mean a DNS
//      leak to the local resolver before the proxy ever saw the request);
//   2. the kill-switch: if the proxy becomes unreachable, navigation fails
//      closed (a proxy-specific error) rather than silently falling back
//      to a direct connection;
//   3. whether proxyBypassRules: '' still leaves localhost/loopback
//      implicitly exempt from the proxy — recorded here as an observed,
//      empirical fact (see docs/threat-model.md), not assumed from docs.

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

async function enableTor(window: Page, port: number): Promise<void> {
  await window.locator('.tor-control__chip').click()
  const hostInput = window.locator('.tor-control__field input').first()
  const portInput = window.locator('.tor-control__field input').nth(1)
  await hostInput.fill('127.0.0.1')
  await portInput.fill(String(port))
  await window.getByRole('button', { name: 'Save' }).click()
  await window.getByRole('button', { name: 'Enable Tor' }).click()
  await expect(window.locator('.tor-control__chip')).toHaveText('Tor: On', { timeout: 10_000 })
}

test('traffic flows through the SOCKS5 proxy, hostname arrives unresolved', async () => {
  const backend = serveMarker('VIA-PROXY')
  const backendPort = await listen(backend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(backendPort)
  const { app, window } = await launchApp()

  try {
    await enableTor(window, socks.port)

    // .invalid is reserved (RFC 2606): guaranteed to never resolve via a
    // real resolver. If this navigation succeeds at all, the hostname
    // cannot have been resolved locally — it must have reached the proxy.
    await navigate(window, 'http://tor-test.invalid:4321/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('VIA-PROXY', {
      timeout: 15_000
    })

    expect(socks.connectLog).toHaveLength(1)
    expect(socks.connectLog[0]).toEqual({ atyp: 0x03, address: 'tor-test.invalid', port: 4321 })
  } finally {
    await app.close()
    await socks.close()
    backend.close()
  }
})

test('kill-switch: an unreachable proxy fails the navigation, never falls back to direct', async () => {
  const backend = serveMarker('VIA-PROXY')
  const backendPort = await listen(backend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(backendPort)
  const { app, window } = await launchApp()

  try {
    await enableTor(window, socks.port)
    await navigate(window, 'http://tor-test.invalid:4321/')
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

test('proxyBypassRules: "" still leaves localhost routed direct, not through the proxy', async () => {
  const proxyBackend = serveMarker('VIA-PROXY')
  const proxyBackendPort = await listen(proxyBackend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(proxyBackendPort)
  const directServer = serveMarker('DIRECT-LOCALHOST')
  const directPort = await listen(directServer)
  const { app, window } = await launchApp()

  try {
    await enableTor(window, socks.port)
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
