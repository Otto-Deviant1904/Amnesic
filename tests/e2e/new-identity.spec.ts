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

// New Identity (Ctrl+Shift+N, ADR 0009) must give a forensically fresh
// session mid-run: every tab closed, the old in-memory session's cookies and
// Chromium's basic-auth cache both gone, and the resulting single fresh tab
// running under a newly hardened session. See docs/adr/0009 for the design
// (partition rotation, not clear-in-place) and scripts/footprint-session.mjs
// for the same trigger exercised against the tmpfs-residue guarantee.

const AUTH_EXPECTED = `Basic ${Buffer.from('alice:secret').toString('base64')}`

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
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

test('New Identity wipes cookies and the basic-auth cache without quitting', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/basic') {
      if (req.headers.authorization === AUTH_EXPECTED) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<title>authed ok</title>')
      } else {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="e2e"' })
        res.end('<title>denied</title>')
      }
      return
    }
    // Cookie-based login simulation: no cookie -> "logged out" + Set-Cookie;
    // cookie present -> "logged in".
    if ((req.headers.cookie ?? '').includes('session=logged-in')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>logged in</title>')
    } else {
      res.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'session=logged-in; Max-Age=31536000; Path=/'
      })
      res.end('<title>logged out</title>')
    }
  })
  const base = await listen(server)
  const { app, window } = await launchApp()

  try {
    // First visit sets the cookie; a second request proves it stuck.
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('logged out')
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('logged in')

    // Open a second tab and complete an HTTP basic-auth challenge, so
    // Chromium caches the credentials for the session.
    await window.keyboard.press('Control+t')
    await navigate(window, base + '/basic')
    const dialog = window.locator('.auth-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('Username').fill('alice')
    await dialog.getByPlaceholder('Password').fill('secret')
    await dialog.getByRole('button', { name: 'Sign in' }).click()
    await expect(window.locator('.tab--active .tab__title')).toHaveText('authed ok')

    await expect(window.locator('.tab')).toHaveCount(2)

    // New Identity: closes both tabs, rotates the partition, opens one fresh
    // tab — the app itself must keep running (no exit). Fired via
    // sendInputEvent on the shell's own webContents, not page.keyboard.press
    // — Playwright's CDP-driven keyboard never reaches Electron's
    // before-input-event (research/cleanup-and-exit.md §20), which is where
    // this shift-combo (unlike Ctrl+T above) is exclusively handled.
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

    // The cookie must be gone: revisiting shows "logged out" again, not the
    // cached "logged in" state from before the reset.
    await navigate(window, base + '/')
    await expect(window.locator('.tab--active .tab__title')).toHaveText('logged out')

    // Chromium's basic-auth cache must be gone too: revisiting /basic prompts
    // again instead of silently resending the old cached credentials.
    await window.keyboard.press('Control+t')
    await navigate(window, base + '/basic')
    await expect(window.locator('.auth-dialog')).toBeVisible()
  } finally {
    await app.close()
    server.close()
  }
})
