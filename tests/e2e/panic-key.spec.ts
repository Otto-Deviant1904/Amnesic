import { test, expect, _electron as electron } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

// The panic key (Ctrl+Shift+Q) must reach cleanupAndExit() no matter what
// currently has keyboard focus — see research/cleanup-and-exit.md §19 for why
// the two existing before-input-event attachments (shell webContents, every
// tab's webContents) already cover this without a Menu accelerator.
//
// Playwright's _electron API only exposes BrowserWindow-level pages, not a
// tab's own WebContentsView, so `window.keyboard` can't reach a tab at all —
// and even for the shell, page.keyboard.press() is CDP-driven and never
// reaches Electron's before-input-event in the first place (verified while
// building New Identity's e2e coverage; research/cleanup-and-exit.md §20).
// This test fires the accelerator directly at a tab's webContents via
// sendInputEvent() from the main process, the only reliable way to exercise
// the 'tab' source (the harder case: a focused page, not the shell chrome).

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    })
  })
}

test('panic key wipes and exits when a tab (not the shell) has focus', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>Panic fixture</title><p>hello</p>')
  })
  const url = await listen(server)

  const app = await electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js')]
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.address-bar__input')

  // No AMNESIC_SHM_DIR override here (unlike scripts/footprint-session.mjs) —
  // Playwright injects --remote-debugging-port itself, so the app's own
  // `automated` check already skips the relaunch bootstrap and falls back to
  // /dev/shm/amnesic-browser-<pid>, pid being this launched process's own.
  const pid = app.process().pid
  const shmDir = `/dev/shm/amnesic-browser-${pid}`
  expect(fs.existsSync(shmDir)).toBe(true)

  try {
    // Two tabs, both navigated, so the wipe has real session state to clear.
    const navigate = async () => {
      const input = window.locator('.address-bar__input')
      await input.click()
      await input.fill(url)
      await input.press('Enter')
      await expect(window.locator('.tab--active .tab__title')).toHaveText('Panic fixture')
    }
    await navigate()
    await window.keyboard.press('Control+t')
    await navigate()

    const exited = new Promise<void>((resolve) => {
      app.process().once('exit', () => resolve())
    })

    // Fire the accelerator on the tab's own webContents — not through the
    // shell — so this proves the 'tab' source in handleShortcut() catches it
    // on its own, the case a page genuinely holding focus would exercise.
    await app.evaluate(({ webContents }, targetUrl) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === targetUrl)
      if (!wc) throw new Error('tab webContents not found')
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['control', 'shift'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Q', modifiers: ['control', 'shift'] })
    }, url)

    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('app did not exit within 10s')), 10_000)
      )
    ])

    expect(fs.existsSync(shmDir)).toBe(false)
  } finally {
    server.close()
  }
})
