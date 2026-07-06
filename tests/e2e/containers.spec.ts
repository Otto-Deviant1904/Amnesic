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

// Containers mode (ADR 0011): per-tab isolated sessions. Verifies the four
// storage-isolation properties the design promises, plus that a container tab
// created while Tor is on still routes through the SOCKS5 proxy (reusing the
// hermetic fake-socks5 harness from tor.spec.ts):
//   1. OFF (default): a cookie set in tab A is visible to a later tab B
//      (today's shared-session behavior, unchanged);
//   2. ON: a cookie set in tab A is NOT visible in a newly opened tab B;
//   3. ON: a tab a PAGE opens (window.open) shares its opener's storage —
//      a container's own links stay in its container (decision 3);
//   4. ON: New Identity leaves exactly one working, isolated fresh tab;
//   5. ON + Tor: a container tab opened while Tor is on flows through the
//      proxy (fresh per-tab partitions are proxied before content loads).

// Reports whether the request already carried the probe cookie, and sets it
// when absent. "has-cookie" vs "no-cookie" in the title is the isolation probe.
function cookieServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/open') {
      // A page that opens a pop-up to '/' in the same (inherited) session.
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>opener</title><script>window.open("/", "_blank")</script>')
      return
    }
    const hasCookie = (req.headers.cookie ?? '').includes('probe=set')
    res.writeHead(200, {
      'content-type': 'text/html',
      ...(hasCookie ? {} : { 'set-cookie': 'probe=set; Max-Age=31536000; Path=/' })
    })
    res.end(`<title>${hasCookie ? 'has-cookie' : 'no-cookie'}</title>`)
  })
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

// The containers chip toggles through IPC on click, like the Tor chip — no
// main-only shift-combo, so plain Playwright clicks reach it.
async function enableContainers(window: Page): Promise<void> {
  await window.locator('.containers-control__chip').click()
  await window.getByRole('button', { name: 'Turn on containers' }).click()
  await expect(window.locator('.containers-control__chip')).toHaveText('Containers: On')
  // Close the popover so it doesn't overlap later interactions.
  await window.keyboard.press('Escape')
  await window.locator('.address-bar__input').click()
}

async function enableTor(window: Page, port: number): Promise<void> {
  await window.locator('.proxy-control__chip').click()
  const hostInput = window.locator('.proxy-control__field input').first()
  const portInput = window.locator('.proxy-control__field input').nth(1)
  await hostInput.fill('127.0.0.1')
  await portInput.fill(String(port))
  await window.getByRole('button', { name: 'Save' }).click()
  await window.getByRole('button', { name: 'Enable Tor' }).click()
  await expect(window.locator('.proxy-control__chip')).toHaveText('Tor: On', { timeout: 10_000 })
}

test('containers off: a cookie set in one tab is visible to a later tab', async () => {
  const server = cookieServer()
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const { app, window } = await launchApp()

  try {
    // Tab A sets the cookie.
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('no-cookie')

    // A second, user-opened tab B shares the one session, so it already has it.
    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('has-cookie')
  } finally {
    await app.close()
    server.close()
  }
})

test('containers on: a cookie set in one tab is invisible to a new tab', async () => {
  const server = cookieServer()
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const { app, window } = await launchApp()

  try {
    await enableContainers(window)

    // Tab A (opened after the toggle) gets its own partition and sets the cookie.
    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('no-cookie')

    // Tab B gets a different fresh partition — the cookie must not be there.
    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('no-cookie')
  } finally {
    await app.close()
    server.close()
  }
})

test('containers on: a page-opened tab shares its opener container', async () => {
  const server = cookieServer()
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const { app, window } = await launchApp()

  try {
    await enableContainers(window)

    // Tab A sets the cookie in its own container.
    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('no-cookie')

    // A page in tab A opens a pop-up (new tab). It inherits A's session, so the
    // cookie A set is present — a container's own links stay in its container.
    await navigate(window, base + '/open')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('has-cookie', {
      timeout: 15_000
    })
  } finally {
    await app.close()
    server.close()
  }
})

test('containers on: New Identity leaves one working, isolated fresh tab', async () => {
  const server = cookieServer()
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  const { app, window } = await launchApp()

  try {
    await enableContainers(window)

    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('no-cookie')

    // New Identity — fired via sendInputEvent (Playwright's CDP keyboard never
    // reaches before-input-event, where this shift-combo lives; see
    // new-identity.spec.ts / research/cleanup-and-exit.md §20).
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'N',
        modifiers: ['control', 'shift']
      })
      win.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: 'N',
        modifiers: ['control', 'shift']
      })
    })
    await expect(window.locator('.tab')).toHaveCount(1)
    await expect(window.locator('.start-page')).toBeVisible()
    expect(app.process().exitCode).toBeNull()

    // The fresh tab is a new isolated partition under the new generation — the
    // cookie from before the reset is gone, so this reads "no-cookie" again.
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('no-cookie')
  } finally {
    await app.close()
    server.close()
  }
})

test('containers on + Tor: a container tab routes through the SOCKS5 proxy', async () => {
  const backend = serveMarker('VIA-PROXY')
  const backendPort = await listen(backend)
  const socks: FakeSocks5Server = await startFakeSocks5Server(backendPort)
  const { app, window } = await launchApp()

  try {
    // Both toggles allowed now: no tab has navigated yet, and containers has no
    // gate at all.
    await enableTor(window, socks.port)
    await enableContainers(window)

    // A container tab created WHILE Tor is on must have the proxy applied
    // before any content loads (prepareFreshTabSession folds it in).
    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await navigate(window, 'http://tor-test.invalid:4321/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('VIA-PROXY', {
      timeout: 15_000
    })

    expect(socks.connectLog).toContainEqual({ atyp: 0x03, address: 'tor-test.invalid', port: 4321 })
  } finally {
    await app.close()
    await socks.close()
    backend.close()
  }
})
