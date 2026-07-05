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

// DNS-over-HTTPS provider selection (ADR 0010). What this file verifies —
// and, just as importantly, what it does not:
//   1. the UI toggle actually reaches app.configureHostResolver via the
//      main process (asserted indirectly: the status IPC round-trip
//      reflects the selection, and research/session-and-userdata.md §23
//      records the direct verification that repeat calls succeed);
//   2. Tor mode (ADR 0007) takes precedence in the UI: the DNS control is
//      greyed out and shows an explanatory hint while Tor is on, and the
//      underlying selection is preserved (not silently reset) once Tor is
//      turned back off;
//   3. selecting "Off" returns to the default resolver state.
// What this file does NOT do: assert at the packet level that DNS queries
// actually leave the process as HTTPS to the selected resolver rather than
// plaintext port 53. That requires root/netns packet capture this sandboxed
// CI-equivalent environment doesn't have, and this project doesn't stand up
// a live HTTPS DoH mock (would require weakening TLS certificate validation
// to trust a self-signed cert, which must never ship even behind a test
// flag). See docs/threat-model.md's DNS row for the manual verification
// step a maintainer should run instead (tcpdump on port 53 while toggling).

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

test('selecting a provider updates the chip and offers no Google/Cloudflare default', async () => {
  const { app, window } = await launchApp()
  try {
    await expect(window.locator('.dns-control__chip')).toHaveText('DNS: Off')
    await window.locator('.dns-control__chip').click()

    const optionTexts = await window.locator('.dns-control__option').allTextContents()
    expect(optionTexts).toEqual(['Off (default resolver)', 'Quad9', 'Mullvad'])
    expect(optionTexts.join(' ')).not.toMatch(/google|cloudflare/i)

    await window.locator('.dns-control__option', { hasText: 'Quad9' }).click()
    await expect(window.locator('.dns-control__chip')).toHaveText('DNS: Quad9')
    await expect(window.locator('.dns-control__option', { hasText: 'Quad9' })).toHaveClass(
      /dns-control__option--active/
    )
  } finally {
    await app.close()
  }
})

test('selecting "Off" returns to the default resolver', async () => {
  const { app, window } = await launchApp()
  try {
    await window.locator('.dns-control__chip').click()
    await window.locator('.dns-control__option', { hasText: 'Mullvad' }).click()
    await expect(window.locator('.dns-control__chip')).toHaveText('DNS: Mullvad')

    await window.locator('.dns-control__option', { hasText: 'Off' }).click()
    await expect(window.locator('.dns-control__chip')).toHaveText('DNS: Off')
  } finally {
    await app.close()
  }
})

test('Tor mode greys out the DNS control but preserves the selection underneath', async () => {
  const backend = serveMarker('VIA-PROXY')
  const backendPort = await listen(backend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(backendPort)
  const { app, window } = await launchApp()

  try {
    await window.locator('.dns-control__chip').click()
    await window.locator('.dns-control__option', { hasText: 'Quad9' }).click()
    await expect(window.locator('.dns-control__chip')).toHaveText('DNS: Quad9')
    await window.locator('.dns-control__chip').click() // close

    await enableTor(window, socks.port)
    await window.locator('.tor-control__chip').click() // close Tor popover

    await window.locator('.dns-control__chip').click()
    await expect(window.locator('.dns-control__hint')).toBeVisible()
    await expect(window.locator('.dns-control__option', { hasText: 'Quad9' })).toBeDisabled()
    await expect(window.locator('.dns-control__option', { hasText: 'Off' })).toBeDisabled()
    // The setting itself isn't silently reset — only the UI is locked.
    await expect(window.locator('.dns-control__chip')).toHaveText('DNS: Quad9')
    await window.locator('.dns-control__chip').click() // close

    await window.locator('.tor-control__chip').click()
    await expect(window.getByRole('button', { name: 'Disable Tor' })).toBeVisible()
    await window.getByRole('button', { name: 'Disable Tor' }).click()
    await expect(window.locator('.tor-control__chip')).toHaveText('Tor: Off')
    await window.locator('.tor-control__chip').click() // close

    await window.locator('.dns-control__chip').click()
    await expect(window.locator('.dns-control__hint')).toHaveCount(0)
    await expect(window.locator('.dns-control__option', { hasText: 'Quad9' })).toBeEnabled()
    await expect(window.locator('.dns-control__chip')).toHaveText('DNS: Quad9')
  } finally {
    await app.close()
    await socks.close()
    backend.close()
  }
})
