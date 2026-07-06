// Dev-only memory measurement for containers mode (ADR 0011 Phase 3.3).
//
// Opens 10 tabs against a local hermetic page with containers OFF, then again
// with containers ON, and reports the total resident set size (RSS) summed
// across the app's whole process tree for each. Modeled on the launch harness
// in scripts/footprint-session.mjs. The point is the DELTA: with containers on,
// each user-opened tab gets its own session/network-context, which costs extra
// per-tab memory over the shared-session baseline — this quantifies that cost.
//
// Two separate launches (relaunch between runs), the honest, simple option:
// the OFF run's 10 tabs don't linger into the ON measurement. NOT run in CI —
// a maintainer runs it by hand to fill in ADR 0011's measurement section.
//
//   npm run build && node scripts/measure-containers.mjs
//
// Requires Linux (/proc) — it walks the process tree the same way the rest of
// this project's tooling assumes a Linux host.

import { _electron as electron } from 'playwright-core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TAB_COUNT = 10
const SETTLE_MS = 4000

const PAGE = `<!doctype html>
<html><head><title>Mem Probe</title></head>
<body>
<script>
  // A little storage per tab, so a per-tab partition actually holds something.
  localStorage.setItem('mem', 'x'.repeat(2048))
  document.cookie = 'mem=1; max-age=3600'
  document.title = 'Mem Probe Ready'
</script>
</body></html>`

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// --- /proc process-tree RSS ------------------------------------------------
// Build ppid -> children from /proc/*/stat, BFS from the root pid, and sum
// VmRSS (kB) from each /proc/<pid>/status.
function rssTreeKb(rootPid) {
  const children = new Map()
  const rssByPid = new Map()
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    try {
      // /proc/<pid>/stat: the comm field can contain spaces/parens, so parse
      // ppid from after the last ')'.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(afterComm[1]) // state, ppid, ...
      if (!children.has(ppid)) children.set(ppid, [])
      children.get(ppid).push(pid)
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
      const match = /VmRSS:\s+(\d+)\s+kB/.exec(status)
      rssByPid.set(pid, match ? Number(match[1]) : 0)
    } catch {
      /* process exited between readdir and read — skip it */
    }
  }
  let total = 0
  let count = 0
  const queue = [rootPid]
  const seen = new Set()
  while (queue.length > 0) {
    const pid = queue.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    total += rssByPid.get(pid) ?? 0
    count += 1
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return { totalKb: total, processCount: count }
}

async function launchApp() {
  const shmDir = `/dev/shm/amnesic-browser-measure-${process.pid}-${Date.now()}`
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    env: {
      ...process.env,
      AMNESIC_SHM_DIR: shmDir,
      XDG_CACHE_HOME: path.join(shmDir, 'xdg-cache')
    }
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.address-bar__input')
  return { app, window }
}

async function enableContainers(window) {
  await window.locator('.containers-control__chip').click()
  await window.getByRole('button', { name: 'Turn on containers' }).click()
  await window.locator('.address-bar__input').click() // click-outside closes the popover
}

async function openTabs(window) {
  for (let i = 0; i < TAB_COUNT; i++) {
    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await window.focus('.address-bar__input')
    await window.keyboard.type(`localhost:${port}/tab${i}`)
    await window.keyboard.press('Enter')
    await window.waitForSelector('.tab--active .tab__title:has-text("Mem Probe Ready")', {
      timeout: 15000
    })
  }
}

async function measure(containersOn) {
  const { app, window } = await launchApp()
  const pid = app.process().pid
  try {
    if (containersOn) await enableContainers(window)
    await openTabs(window)
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    return rssTreeKb(pid)
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await new Promise((resolve) => app.process().once('exit', resolve))
  }
}

const off = await measure(false)
const on = await measure(true)
server.close()

const fmtMb = (kb) => (kb / 1024).toFixed(1).padStart(9)
const deltaKb = on.totalKb - off.totalKb
const pct = off.totalKb > 0 ? ((deltaKb / off.totalKb) * 100).toFixed(1) : 'n/a'

console.log(`\nContainers mode memory footprint (${TAB_COUNT} tabs, RSS across process tree)\n`)
console.log('  mode        total RSS (MiB)   processes')
console.log('  --------    ---------------   ---------')
console.log(`  OFF        ${fmtMb(off.totalKb)}   ${String(off.processCount).padStart(9)}`)
console.log(`  ON         ${fmtMb(on.totalKb)}   ${String(on.processCount).padStart(9)}`)
console.log(`\n  delta:     ${fmtMb(deltaKb)} MiB  (${pct}% over baseline)\n`)
