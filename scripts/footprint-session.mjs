// Scripted browsing session for scripts/verify_footprint.sh.
//
// Drives the BUILT app (out/main/index.js) through a session designed to
// tempt every persistence mechanism the threat model claims to neutralize:
// persistent cookies, localStorage, sessionStorage, IndexedDB, the Cache
// API, and an attempted file download. Everything is served from a local
// HTTP server so the run is hermetic — no external network.
//
// The filesystem diffing is the calling shell script's job. This script's
// own assertions are the ones that need the app's pid: the tmpfs userData
// dir must exist while the app runs and must be GONE after exit
// (cleanupAndExit deletes it — ADR 0004).
//
// Exit code 0 = session completed and tmpfs dir cleaned up; 1 = failure.

import { _electron as electron } from 'playwright-core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const PAGE = `<!doctype html>
<html><head><title>Footprint Probe</title></head>
<body>
<a id="dl" href="/download">download</a>
<script>
(async () => {
  localStorage.setItem('footprint', 'x'.repeat(4096))
  sessionStorage.setItem('footprint', 'y'.repeat(4096))
  document.cookie = 'footprint_js=1; max-age=31536000'
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('footprint-db', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('s')
    req.onsuccess = () => {
      const tx = req.result.transaction('s', 'readwrite')
      tx.objectStore('s').put('z'.repeat(4096), 'k')
      tx.oncomplete = resolve
      tx.onerror = reject
    }
    req.onerror = reject
  })
  const cache = await caches.open('footprint-cache')
  await cache.put('/cached', new Response('c'.repeat(4096)))
  document.title = 'Footprint Probe Ready'
})()
</script>
</body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="footprint-probe.bin"'
    })
    res.end(Buffer.alloc(8192, 7))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html',
    'set-cookie': 'footprint_hdr=1; Max-Age=31536000; Path=/'
  })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

function fail(message) {
  console.error(`footprint-session: FAIL — ${message}`)
  process.exit(1)
}

// Automation launches skip the app's cache-env relaunch bootstrap (it would
// sever Playwright's connection), so the harness provides the same
// environment the relaunched instance would have — see the userData redirect
// block in src/main/index.ts and ADR 0004.
const shmDir = `/dev/shm/amnesic-browser-footprint-${process.pid}`
const app = await electron.launch({
  args: [path.join(root, 'out/main/index.js')],
  env: {
    ...process.env,
    AMNESIC_SHM_DIR: shmDir,
    XDG_CACHE_HOME: path.join(shmDir, 'xdg-cache')
  }
})
const exited = new Promise((resolve) => app.process().once('exit', resolve))

const window = await app.firstWindow()
await window.waitForSelector('.address-bar__input')

if (!fs.existsSync(shmDir)) {
  fail(`expected tmpfs userData at ${shmDir} while the app is running`)
}

// Browse via the real UI path, twice (two tabs), letting the page script
// exercise every storage mechanism.
for (let i = 0; i < 2; i++) {
  await window.focus('.address-bar__input')
  await window.keyboard.type(`localhost:${port}/page${i}`)
  await window.keyboard.press('Enter')
  await window.waitForSelector('.tab--active .tab__title:has-text("Footprint Probe Ready")', {
    timeout: 15000
  })
  if (i === 0) {
    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
  }
}

// Attempt a download; the app must cancel it and show the notice.
await app.evaluate(async ({ webContents }) => {
  const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('/page1'))
  await wc.executeJavaScript('document.getElementById("dl").click()')
})
await window
  .waitForSelector('.download-notice', { timeout: 10000 })
  .catch(() => fail('download was not visibly blocked'))

// Close the window (not app.close()) so the real user exit path runs:
// window-all-closed -> cleanupAndExit -> tmpfs deletion -> app.exit(0).
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
await Promise.race([
  exited,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('app did not exit within 15s')), 15000)
  )
]).catch((error) => fail(error.message))

server.close()

if (fs.existsSync(shmDir)) {
  fail(`tmpfs userData dir survived exit: ${shmDir}`)
}

console.log('footprint-session: OK — session complete, tmpfs userData removed on exit')
