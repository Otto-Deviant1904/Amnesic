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

// Exercises the Sprint 2 shell features end-to-end: in-shell error pages,
// find-in-page, and HTTP basic-auth dialogs. Context menus are native OS
// menus and HTML5 fullscreen needs a user gesture inside the page, so those
// two are not drivable from Playwright — they were verified manually.

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

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    })
  })
}

test('failed loads render the in-shell error page with retry', async () => {
  const { app, window } = await launchApp()
  // .invalid is reserved (RFC 2606): resolution is guaranteed to fail.
  await navigate(window, 'https://no-such-host.invalid/')
  await expect(window.locator('.error-page__title')).toHaveText('Site not found', {
    timeout: 20_000
  })
  await expect(window.locator('.error-page__code')).toContainText('ERR_NAME_NOT_RESOLVED')
  // The address bar talks about the URL that failed, not a previous page.
  await expect(window.locator('.address-bar__input')).toHaveValue('https://no-such-host.invalid/')
  // Retry re-attempts the same URL and lands back on the error page.
  await window.getByRole('button', { name: 'Try again' }).click()
  await expect(window.locator('.error-page__title')).toHaveText('Site not found', {
    timeout: 20_000
  })
  await app.close()
})

test('find in page counts matches and cycles through them', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>Find fixture</title><p>needle</p><p>needle</p><p>needle</p>')
  })
  const url = await listen(server)
  const { app, window } = await launchApp()
  try {
    await navigate(window, url)
    await expect(window.locator('.tab__title')).toHaveText('Find fixture')

    await window.keyboard.press('Control+f')
    const findInput = window.locator('.find-bar__input')
    await expect(findInput).toBeVisible()
    await findInput.fill('needle')
    const count = window.locator('.find-bar__count')
    await expect(count).toHaveText('1/3')
    await findInput.press('Enter')
    await expect(count).toHaveText('2/3')
    await findInput.press('Shift+Enter')
    await expect(count).toHaveText('1/3')
    await findInput.fill('no-such-text')
    await expect(count).toHaveText('No results')
    await findInput.press('Escape')
    await expect(window.locator('.find-bar')).toHaveCount(0)
  } finally {
    await app.close()
    server.close()
  }
})

test('tab favicons are fetched through the tab session and shown as data: URIs', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
  const server = http.createServer((req, res) => {
    if (req.url === '/icon.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(png)
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>Favicon fixture</title><link rel="icon" href="/icon.png"><p>hi</p>')
    }
  })
  const url = await listen(server)
  const { app, window } = await launchApp()
  try {
    await navigate(window, url)
    const favicon = window.locator('.tab__favicon')
    await expect(favicon).toBeVisible()
    // data: URI proves the shell never fetched from the network itself.
    expect(await favicon.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  } finally {
    await app.close()
    server.close()
  }
})

test('HTTP basic auth prompts in-shell and signs in with entered credentials', async () => {
  const expected = `Basic ${Buffer.from('alice:secret').toString('base64')}`
  const server = http.createServer((req, res) => {
    if (req.headers.authorization === expected) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>authed ok</title><h1>welcome</h1>')
    } else {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="e2e"' })
      res.end('denied')
    }
  })
  const url = await listen(server)
  const { app, window } = await launchApp()
  try {
    await navigate(window, url)
    const dialog = window.locator('.auth-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('127.0.0.1')
    await expect(dialog).toContainText('e2e')
    await dialog.getByPlaceholder('Username').fill('alice')
    await dialog.getByPlaceholder('Password').fill('secret')
    await dialog.getByRole('button', { name: 'Sign in' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(window.locator('.tab__title')).toHaveText('authed ok')
  } finally {
    await app.close()
    server.close()
  }
})

test('cancelling the auth dialog lets the 401 response render', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="e2e"' })
    res.end('<title>denied 401</title>denied')
  })
  const url = await listen(server)
  const { app, window } = await launchApp()
  try {
    await navigate(window, url)
    const dialog = window.locator('.auth-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(window.locator('.tab__title')).toHaveText('denied 401')
  } finally {
    await app.close()
    server.close()
  }
})
