import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

// Content blocking (ADR 0013, @ghostery/adblocker engine). What this file
// verifies, hermetically (local fixture site + tiny filter list via the
// AMNESIC_BLOCKLIST_PATH seam; scriptlet bodies resolve against the bundled
// uBO resources.json):
//   1. a network request matching a filter rule is cancelled via onBeforeRequest;
//   2. a same-origin request matching no rule is not blocked;
//   3. a cosmetic ## rule hides an in-page element (frame preload -> IPC ->
//      insertCSS pipeline);
//   4. a scriptlet +js(...) rule executes in the page's main world — the exact
//      data-driven mechanism that blocks same-origin YouTube ads, proven
//      without touching youtube.com;
//   5. the session blocked-request counter increments;
//   6. toggling blocking off lets a previously-blocked resource load and stops
//      cosmetic/scriptlet injection for later navigations;
//   7. blocking still applies inside a fresh Containers-mode tab (per-tab
//      sessions get the engine at hardening time).
// Real-list behavior (EasyList + uBO snapshots, YouTube scriptlet injection)
// is covered by tests/unit/blocking.test.ts against the actual bundled data.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function siteServer(trackerPort: number): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/same-origin.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('window.__sameOriginLoaded = true;')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html>
<title>loading</title>
<div class="ad-box">SPONSORED</div>
<div class="content">real content</div>
<script>
function probeTracker() {
  const s = document.createElement('script');
  s.onload = () => { document.title = 'tracker-loaded'; };
  s.onerror = () => { document.title = 'tracker-blocked'; };
  s.src = 'http://127.0.0.1:${trackerPort}/pixel.js?t=' + Date.now();
  document.head.appendChild(s);
}
function probeSameOrigin() {
  const s = document.createElement('script');
  s.onload = () => { document.body.dataset.same = 'loaded'; };
  s.onerror = () => { document.body.dataset.same = 'blocked'; };
  s.src = '/same-origin.js?t=' + Date.now();
  document.head.appendChild(s);
}
probeTracker();
probeSameOrigin();
</script>`)
  })
}

function trackerServer(): { server: http.Server; hits: () => number } {
  let hitCount = 0
  const server = http.createServer((_req, res) => {
    hitCount++
    res.writeHead(200, {
      'content-type': 'application/javascript',
      'access-control-allow-origin': '*'
    })
    res.end('window.__trackerLoaded = true;')
  })
  return { server, hits: () => hitCount }
}

function writeFixture(name: string, trackerPort: number): string {
  const template = readFileSync(path.join(__dirname, '../fixtures/test-blocklist.txt'), 'utf8')
  const fixturePath = path.join(__dirname, `../fixtures/.generated-${name}.txt`)
  // replaceAll: String.replace would only substitute the first occurrence.
  writeFileSync(fixturePath, template.replaceAll('TRACKER_PORT', String(trackerPort)))
  return fixturePath
}

async function launchApp(
  blocklistPath: string
): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js')],
    env: {
      ...process.env,
      AMNESIC_BLOCKLIST_PATH: blocklistPath
    }
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

async function readBlockedCount(window: Page): Promise<number> {
  return window.evaluate(async () => {
    const bridge = (
      window as unknown as {
        amnesic: { getBlockingStatus: () => Promise<{ blockedCount: number }> }
      }
    ).amnesic
    const status = await bridge.getBlockingStatus()
    return status.blockedCount
  })
}

/** Evaluate an expression inside the (non-shell) page WebContents. */
async function evalInPage(app: ElectronApplication, expression: string): Promise<unknown> {
  return app.evaluate(async ({ webContents }, expr) => {
    const wc = webContents.getAllWebContents().find((w) => !w.getURL().includes('index.html'))
    if (!wc) return null
    return wc.executeJavaScript(expr)
  }, expression)
}

test('blocks network rule, hides cosmetic target, runs scriptlet, allows first-party, toggle off works', async () => {
  const { server: tracker, hits: trackerHits } = trackerServer()
  const trackerPort = await listen(tracker)
  const site = siteServer(trackerPort)
  const sitePort = await listen(site)

  const { app, window } = await launchApp(writeFixture('blocklist', trackerPort))

  try {
    await expect(window.locator('.blocking-control__chip')).toHaveText('Blocking: On')

    await navigate(window, `http://localhost:${sitePort}/`)

    // (1) network rule cancels the tracker script
    await expect(window.locator('.tab--active .tab__title')).toHaveText('tracker-blocked', {
      timeout: 15_000
    })
    // (5) counter increments
    await expect.poll(() => readBlockedCount(window), { timeout: 10_000 }).toBeGreaterThan(0)

    // (2) same-origin resource matching no rule loads
    const sameOriginLoaded = await evalInPage(app, 'document.body.dataset.same ?? null')
    expect(sameOriginLoaded).toBe('loaded')

    // (3) cosmetic rule localhost##.ad-box hides the element; the unmatched
    // .content element stays visible (guards against a blanket-hide bug).
    await expect
      .poll(
        () =>
          evalInPage(
            app,
            `(() => {
              const ad = document.querySelector('.ad-box');
              const content = document.querySelector('.content');
              if (!ad || !content) return 'missing';
              return getComputedStyle(ad).display + '/' + getComputedStyle(content).display;
            })()`
          ),
        { timeout: 10_000 }
      )
      .toBe('none/block')

    // (4) scriptlet +js(set-constant, __amnesicScriptletProof, true) executed
    // in the page's MAIN world — the YouTube-critical mechanism, data-driven
    // from the filter list + bundled uBO resources, no site-specific code.
    await expect
      .poll(() => evalInPage(app, 'window.__amnesicScriptletProof === true'), {
        timeout: 10_000
      })
      .toBe(true)

    // (6) toggle off: previously-blocked resource loads, injections stop
    await window.locator('.blocking-control__chip').click()
    await window.getByRole('button', { name: 'Turn off blocking' }).click()
    await expect(window.locator('.blocking-control__chip')).toHaveText('Blocking: Off')

    await navigate(window, `http://localhost:${sitePort}/?reload=1`)
    await expect.poll(() => trackerHits(), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect(window.locator('.tab--active .tab__title')).toHaveText('tracker-loaded', {
      timeout: 15_000
    })
    const adBoxDisplayOff = await evalInPage(
      app,
      `getComputedStyle(document.querySelector('.ad-box')).display`
    )
    expect(adBoxDisplayOff).toBe('block')
    const scriptletOff = await evalInPage(app, 'window.__amnesicScriptletProof === true')
    expect(scriptletOff).toBe(false)
  } finally {
    await app.close()
    site.close()
    tracker.close()
  }
})

test('blocking applies inside a fresh containers-mode tab', async () => {
  const { server: tracker } = trackerServer()
  const trackerPort = await listen(tracker)
  const site = siteServer(trackerPort)
  const sitePort = await listen(site)

  const { app, window } = await launchApp(writeFixture('blocklist-containers', trackerPort))

  try {
    await window.locator('.containers-control__chip').click()
    await window.getByRole('button', { name: 'Turn on containers' }).click()
    await window.locator('.address-bar__input').click()

    await window.keyboard.press('Control+t')
    await window.waitForSelector('.start-page')
    await navigate(window, `http://localhost:${sitePort}/`)

    await expect(window.locator('.tab--active .tab__title')).toHaveText('tracker-blocked', {
      timeout: 15_000
    })
    await expect.poll(() => readBlockedCount(window), { timeout: 10_000 }).toBeGreaterThan(0)
    // The per-tab container session also gets the frame preload: the scriptlet
    // must run in the container tab too.
    await expect
      .poll(() => evalInPage(app, 'window.__amnesicScriptletProof === true'), {
        timeout: 10_000
      })
      .toBe(true)
  } finally {
    await app.close()
    site.close()
    tracker.close()
  }
})
