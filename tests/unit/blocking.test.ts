import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../src/main/blocking-engine'

// The engine emits 'request-blocked' via queueMicrotask (async), so the blocked
// counter — and any throttled change notification — settle one task later.
const flush = () => new Promise((r) => setTimeout(r, 0))

// Unit tests for the Electron-free blocking core (src/main/blocking-engine.ts).
// The thin Electron adapter (src/main/blocking.ts) — session wiring, IPC, the
// frame preload path — is exercised by tests/e2e/blocking.spec.ts instead, since
// it needs a live Electron runtime. See ADR 0013.

const RESOURCES_DIR = join(__dirname, '../../resources/adblock')

// A tiny hand-written list: one network rule, one cosmetic rule, one scriptlet
// rule pointing at a real bundled resource. Lets the logic tests run without
// depending on whatever is in the live snapshots that day.
const FIXTURE_LIST = [
  '||tracker.example^',
  'example.com##.ad-banner',
  'example.com##+js(json-prune, foo)'
].join('\n')

function fixtureResources(): string {
  // Real bundled scriptlet resources so the +js(json-prune) rule resolves.
  return readFileSync(join(RESOURCES_DIR, 'ubo-resources.json'), 'utf8')
}

function initFixture(): void {
  core.initEngine({ lists: FIXTURE_LIST, resources: fixtureResources() })
}

describe('blocking-engine network matching', () => {
  beforeEach(() => {
    core.__resetForTests()
    initFixture()
  })

  it('cancels a matching third-party sub-resource', () => {
    const decision = core.matchRequest({
      url: 'https://tracker.example/pixel.js',
      referrer: 'https://site.test/',
      resourceType: 'script'
    })
    expect(decision).toEqual({ cancel: true })
  })

  it('allows a request that matches no rule', () => {
    const decision = core.matchRequest({
      url: 'https://site.test/app.js',
      referrer: 'https://site.test/',
      resourceType: 'script'
    })
    expect(decision).toEqual({})
  })

  it('never blocks the main document frame, even if it matches a rule', () => {
    const decision = core.matchRequest({
      url: 'https://tracker.example/',
      referrer: '',
      resourceType: 'mainFrame'
    })
    expect(decision).toEqual({})
  })
})

describe('blocking-engine cosmetic + scriptlet injection', () => {
  beforeEach(() => {
    core.__resetForTests()
    initFixture()
  })

  it('returns a cosmetic style for a matching hostname', () => {
    const { active, styles } = core.cosmeticsFor('https://example.com/', undefined)
    expect(active).toBe(true)
    expect(styles).toContain('.ad-banner')
  })

  it('returns a scriptlet to inject for a +js() rule (the YouTube mechanism)', () => {
    const { scripts } = core.cosmeticsFor('https://example.com/', undefined)
    expect(scripts.length).toBeGreaterThan(0)
    // json-prune scriptlet body should be present in the injected script.
    expect(scripts.join('\n')).toMatch(/json.?prune|JSON\.parse/i)
  })
})

describe('blocking-engine enabled state + blocked count', () => {
  beforeEach(() => {
    core.__resetForTests()
    initFixture()
  })

  it('reports enabled + zero count on a fresh engine', () => {
    expect(core.isEnabled()).toBe(true)
    expect(core.blockingStatus()).toEqual({ enabled: true, blockedCount: 0 })
  })

  it('increments blockedCount when a request is blocked', async () => {
    expect(core.blockingStatus().blockedCount).toBe(0)
    core.matchRequest({
      url: 'https://tracker.example/a.js',
      referrer: 'https://site.test/',
      resourceType: 'script'
    })
    await flush()
    expect(core.blockingStatus().blockedCount).toBe(1)
  })

  it('setBlockingEnabled flips the flag and reports it', () => {
    expect(core.setBlockingEnabled(false)).toEqual({ enabled: false, blockedCount: 0 })
    expect(core.isEnabled()).toBe(false)
    expect(core.setBlockingEnabled(true).enabled).toBe(true)
  })

  it('resetBlockedCount zeroes the counter', async () => {
    core.matchRequest({
      url: 'https://tracker.example/a.js',
      referrer: 'https://site.test/',
      resourceType: 'script'
    })
    await flush()
    expect(core.blockingStatus().blockedCount).toBe(1)
    core.resetBlockedCount()
    expect(core.blockingStatus().blockedCount).toBe(0)
  })
})

describe('blocking-engine change notifications', () => {
  beforeEach(() => {
    core.__resetForTests()
    initFixture()
  })

  it('notifies immediately on reset and on toggle', () => {
    const listener = vi.fn()
    core.setBlockingChangeListener(listener)
    core.resetBlockedCount()
    core.setBlockingEnabled(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('coalesces per-block notifications through a throttle', async () => {
    const listener = vi.fn()
    core.setBlockingChangeListener(listener)
    // Two blocks in quick succession -> one coalesced notification.
    for (let i = 0; i < 2; i++) {
      core.matchRequest({
        url: `https://tracker.example/${i}.js`,
        referrer: 'https://site.test/',
        resourceType: 'script'
      })
    }
    await flush() // let the blocked events settle (count updates, timer arms)
    expect(core.blockingStatus().blockedCount).toBe(2)
    await new Promise((r) => setTimeout(r, 350)) // wait out the throttle window
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('blocking-engine loads the real bundled snapshots (CI guard)', () => {
  // Parses the ACTUAL shipped lists so a malformed snapshot refresh fails CI,
  // and asserts a generous per-request latency bound so the swap can never
  // regress to the homemade engine's 60-78 ms/request (ADR 0013).
  beforeEach(() => {
    core.__resetForTests()
    const lists = [
      'easylist-snapshot.txt',
      'ubo-filters.txt',
      'ubo-quick-fixes.txt',
      'ubo-privacy.txt'
    ]
      .map((f) => readFileSync(join(RESOURCES_DIR, f), 'utf8'))
      .join('\n')
    core.initEngine({ lists, resources: fixtureResources() })
  })

  it('loads a substantial number of network filters', () => {
    const { networkFilters } = core.getEngine().getFilters()
    expect(networkFilters.length).toBeGreaterThan(1000)
  })

  it('injects YouTube scriptlets data-driven (no site-specific code)', () => {
    const { active, scripts } = core.cosmeticsFor('https://www.youtube.com/watch?v=abc', undefined)
    expect(active).toBe(true)
    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts.join('\n')).toMatch(/playerResponse|adPlacements|json.?prune/i)
  })

  it('matches representative requests well under a 5 ms mean', () => {
    const sample: core.RawRequest[] = [
      {
        url: 'https://www.googletagmanager.com/gtag/js',
        referrer: 'https://cnn.com',
        resourceType: 'script'
      },
      {
        url: 'https://doubleclick.net/instream/ad',
        referrer: 'https://cnn.com',
        resourceType: 'image'
      },
      {
        url: 'https://r5.googlevideo.com/videoplayback',
        referrer: 'https://www.youtube.com',
        resourceType: 'media'
      },
      {
        url: 'https://static.example.com/logo.png',
        referrer: 'https://example.com',
        resourceType: 'image'
      },
      {
        url: 'https://ssl.google-analytics.com/collect',
        referrer: 'https://nytimes.com',
        resourceType: 'xmlhttprequest'
      }
    ]
    // warm
    for (let i = 0; i < 200; i++) for (const r of sample) core.matchRequest(r)
    const N = 2000
    const t0 = performance.now()
    for (let i = 0; i < N; i++) for (const r of sample) core.matchRequest(r)
    const meanMs = (performance.now() - t0) / (N * sample.length)
    expect(meanMs).toBeLessThan(5)
  })
})
