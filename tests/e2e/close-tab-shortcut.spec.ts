import { test, expect, _electron as electron } from '@playwright/test'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

// Ctrl+W (close active tab) has two independent handlers, one per focus
// location — this file proves BOTH, without changing either:
//   - shell focus (tab strip / address bar): the App.tsx keydown handler calls
//     window.amnesic.closeTab(). Playwright's CDP-driven window.keyboard.press
//     DOES reach this one (it's a plain DOM listener in the shell renderer).
//   - page focus: handleShortcut() in src/main/index.ts, attached via
//     before-input-event on every tab's webContents. CDP-injected keys never
//     reach before-input-event (research/cleanup-and-exit.md §20), so this path
//     MUST be fired via app.evaluate + webContents.sendInputEvent on the tab's
//     own WebContents — same technique as panic-key.spec.ts.
// Only the multi-tab case (2 tabs -> 1) is asserted; closing the last tab
// quits the whole app (see panic-key.spec.ts for app-exit coverage patterns)
// and its semantics are out of scope here.

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    })
  })
}

function fixtureServer(): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>Close fixture</title><p>hello</p>')
  })
}

async function launchWithTwoTabs(url: string) {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js')]
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.address-bar__input')

  // Navigate the first tab, then open a second one (which becomes active).
  const input = window.locator('.address-bar__input')
  await input.click()
  await input.fill(url)
  await input.press('Enter')
  await expect(window.locator('.tab--active .tab__title')).toHaveText('Close fixture')
  await window.keyboard.press('Control+t')
  await expect(window.locator('.tab')).toHaveCount(2)
  return { app, window }
}

test('Ctrl+W with shell focus closes the active tab (renderer keydown path)', async () => {
  const server = fixtureServer()
  const url = await listen(server)
  const { app, window } = await launchWithTwoTabs(url)

  try {
    // Focus is in the shell (the fresh tab shows the start page and the
    // address bar was auto-focused by Ctrl+T) — the App.tsx handler fires.
    await window.keyboard.press('Control+w')
    await expect(window.locator('.tab')).toHaveCount(1)
    // The surviving tab is the navigated one, now active again.
    await expect(window.locator('.tab--active .tab__title')).toHaveText('Close fixture')
  } finally {
    await app.close()
    server.close()
  }
})

test('Ctrl+W with page focus closes the active tab (main before-input-event path)', async () => {
  const server = fixtureServer()
  const url = await listen(server)
  const { app, window } = await launchWithTwoTabs(url)

  try {
    // Make the NAVIGATED tab active again so its webContents is both the
    // active tab and a real page we can target by URL.
    await window.locator('.tab', { hasText: 'Close fixture' }).click()
    await expect(window.locator('.tab--active .tab__title')).toHaveText('Close fixture')

    // Fire the accelerator on the tab's own webContents — the only way to
    // exercise handleShortcut()'s 'tab' source (CDP keys never reach
    // before-input-event).
    await app.evaluate(({ webContents }, targetUrl) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === targetUrl)
      if (!wc) throw new Error('tab webContents not found')
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] })
    }, url)

    await expect(window.locator('.tab')).toHaveCount(1)
    // The navigated tab is gone; the start-page tab survives.
    await expect(window.locator('.tab--active .tab__title')).not.toHaveText('Close fixture')
  } finally {
    await app.close()
    server.close()
  }
})
