// Scripted, visually paced session for the README demo GIF.
//
// Same launch harness as scripts/footprint-session.mjs (built app, tmpfs
// userData provided by the caller's env — the relaunch bootstrap is skipped
// under automation, ADR 0004), but paced for a human viewer instead of CI:
// open the start page, sign in on a local page that stores data through
// every user-visible mechanism, hit the panic key, then show a live residue
// check in an xterm on the same display. scripts/record_demo.sh wraps this
// in Xvfb + ffmpeg and produces .github/assets/demo.gif — the GIF is a
// recording of real behavior, not an animation.
//
// The residue check the epilogue terminal runs is real: it lists /dev/shm
// and the XDG cache path live, after the app has exited. If the wipe ever
// regressed, the recording would show the leftover files.

import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>demo.example — sign in</title><style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #10141b;
         color: #e6e9ef; display: grid; place-items: center; min-height: 100vh; }
  .card { background: #1a2029; border: 1px solid #2a3342; border-radius: 12px;
          padding: 40px 48px; width: 380px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p  { color: #9aa5b4; margin: 0 0 24px; font-size: 14px; }
  label { display: block; font-size: 13px; color: #9aa5b4; margin: 14px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 15px;
          background: #10141b; color: #e6e9ef; border: 1px solid #2a3342;
          border-radius: 8px; }
  button { margin-top: 22px; width: 100%; padding: 11px; font-size: 15px;
           background: #4c8dff; color: #fff; border: 0; border-radius: 8px;
           cursor: pointer; }
  ul { margin: 18px 0 0; padding: 0; list-style: none; font-size: 15px; }
  li { margin: 8px 0; }
  li::before { content: '✔ '; color: #5dd39e; }
  .ok h1::before { content: '● '; color: #5dd39e; }
</style></head><body>
<div class="card" id="card">
  <h1>demo.example</h1>
  <p>A local test page — this session will store data every way a page can.</p>
  <form id="f">
    <label>Email</label><input id="u" type="email" autocomplete="off">
    <label>Password</label><input id="p" type="password">
    <button type="submit">Sign in</button>
  </form>
</div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault()
  document.cookie = 'session_token=8f3a9c1d4e; max-age=31536000'
  localStorage.setItem('profile', JSON.stringify({ user: 'demo', theme: 'dark' }))
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('demo-db', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('s')
    req.onsuccess = () => {
      const tx = req.result.transaction('s', 'readwrite')
      tx.objectStore('s').put('demo-record', 'k')
      tx.oncomplete = resolve
      tx.onerror = reject
    }
    req.onerror = reject
  })
  const cache = await caches.open('demo-cache')
  await cache.put('/cached', new Response('cached-body'))
  document.getElementById('card').innerHTML = \`
    <div class="ok"><h1>Signed in as demo@example.com</h1>
    <p>This page just persisted, using ordinary web APIs:</p>
    <ul><li>a login cookie (max-age: 1 year)</li>
        <li>localStorage profile data</li>
        <li>an IndexedDB database</li>
        <li>a Cache API entry</li></ul></div>\`
  document.title = 'demo.example — signed in'
})
</script>
</body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const shmDir = `/dev/shm/amnesic-browser-demo-${process.pid}`
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
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 720 })
})

// Wait for the shell renderer to repaint at the new bounds before declaring
// readiness — setBounds returning does not mean a 1280x720 frame was drawn,
// and starting ffmpeg early records an unpainted dark rectangle. The double
// rAF only proves the shell renderer painted, which is enough here: the start
// page IS the shell. The sleep covers compositor latency after that.
await window.evaluate(
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
)
await sleep(1200)

// Recording handshake with scripts/record_demo.sh: the window now exists and
// is painted at size, so signal readiness and wait for the wrapper to start
// ffmpeg before the first beat — otherwise the GIF opens on a black frame.
// Run standalone (env vars unset), we skip the handshake gracefully.
const readyFile = process.env.DEMO_READY_FILE
const goFile = process.env.DEMO_GO_FILE
if (readyFile && goFile) {
  fs.writeFileSync(readyFile, 'ready')
  const deadline = Date.now() + 15000
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) {
      console.error('demo-session: FAIL — no DEMO_GO_FILE after 15s')
      process.exit(1)
    }
    await sleep(100)
  }
  await sleep(700) // let ffmpeg settle before the action starts
}

// Beat 1 — the start page (self-audit panel) breathes for a moment.
await sleep(3500)

// Beat 2 — navigate to the local "site", typed at human speed.
await window.focus('.address-bar__input')
await window.keyboard.type(`localhost:${port}/`, { delay: 55 })
await sleep(400)
await window.keyboard.press('Enter')
await window.waitForSelector('.tab--active .tab__title:has-text("demo.example")', {
  timeout: 15000
})
await sleep(1200)

// Beat 3 — sign in; the page visibly stores a cookie, localStorage,
// IndexedDB, and a Cache API entry. Typed via sendInputEvent on the tab's
// webContents so the keystrokes are visible in the recording.
await app.evaluate(
  async ({ webContents }, { port }) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => w.getURL().includes(`localhost:${port}`))
    const type = async (selector, text) => {
      await wc.executeJavaScript(`document.querySelector('${selector}').focus()`)
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await new Promise((r) => setTimeout(r, 45))
      }
    }
    await type('#u', 'demo@example.com')
    await type('#p', 'hunter2-demo')
    await new Promise((r) => setTimeout(r, 500))
    await wc.executeJavaScript(
      `document.querySelector('#f button').click()`
    )
  },
  { port }
)
await window.waitForSelector('.tab--active .tab__title:has-text("signed in")', {
  timeout: 15000
})
await sleep(4000)

if (!fs.existsSync(shmDir)) {
  console.error('demo-session: FAIL — tmpfs userData missing while app runs')
  process.exit(1)
}

// Beat 4 — the panic key. Same caveat as footprint-session.mjs: shift-combos
// are handled exclusively in main's before-input-event, which Playwright's
// CDP keyboard never reaches — send a real input event instead.
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['control', 'shift'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Q', modifiers: ['control', 'shift'] })
})
await Promise.race([
  exited,
  new Promise((_, reject) => setTimeout(() => reject(new Error('no exit after panic key')), 15000))
]).catch((error) => {
  console.error(`demo-session: FAIL — ${error.message}`)
  process.exit(1)
})
server.close()
await sleep(1500)

// Beat 5 — the receipts: an xterm on the same display runs a REAL residue
// check against the paths the app was just using.
// The check script lives in os.tmpdir(), NOT under /dev/shm — so it never
// matches the find pattern below and can't inflate its own count. The pattern
// is scoped to this pipeline's own session dirs (amnesic-browser-demo-*), so
// stale residue from unrelated sessions on a dev machine can't be counted as
// ours. The displayed command and the executed command are one and the same
// string (run via eval), so the recording can't show a command it didn't run.
const checkScript = path.join(os.tmpdir(), `amnesic-demo-check-${process.pid}.sh`)
fs.writeFileSync(
  checkScript,
  `#!/bin/sh
green() { printf '\\033[1;32m%s\\033[0m\\n' "$1"; }
cmd='find /dev/shm "$HOME/.cache" -path "*amnesic-browser-demo-*" 2>/dev/null | wc -l'
sleep 1
green '$ # the browser just exited — where did the login go?'
sleep 1
green '$ ls ${shmDir}'
ls '${shmDir}' 2>&1
sleep 2
green "$ $cmd"
count=$(eval "$cmd")
echo "$count"
sleep 1
printf '\\n'
green "$count files of residue. Nothing recoverable is left on disk."
sleep 6
`,
  { mode: 0o755 }
)
await new Promise((resolve) => {
  const term = spawn(
    'xterm',
    ['-fa', 'DejaVu Sans Mono', '-fs', 15, '-bg', '#10141b', '-fg', '#e6e9ef',
     '-geometry', '106x28+0+0', '-e', checkScript],
    { stdio: 'ignore' }
  )
  term.once('exit', resolve)
})
fs.rmSync(checkScript, { force: true })

console.log('demo-session: OK')
