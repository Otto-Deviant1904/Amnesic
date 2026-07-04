import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSingleInstance,
  extractForwardableUrls,
  parseForwardedUrls,
  type SingleInstanceLock
} from '../../src/main/single-instance'

const uid = process.getuid!()
const scratchDirs: string[] = []
const heldLocks: SingleInstanceLock[] = []

// Unix socket paths are limited to ~108 bytes and os.tmpdir() can be
// arbitrarily long (sandboxed environments), so use the shortest writable
// root available. Exceeding the limit isn't a crash — acquire degrades to
// standalone — but these tests exist to exercise the *socket* paths.
function shortTmpRoot(): string {
  for (const root of ['/tmp/claude', tmpdir()]) {
    try {
      mkdirSync(root, { recursive: true })
      return root
    } catch {
      /* not writable here — try the next one */
    }
  }
  return tmpdir()
}

function scratchLockDir(): string {
  const dir = join(mkdtempSync(join(shortTmpRoot(), 'amn-')), 'lock')
  scratchDirs.push(dir)
  return dir
}

async function acquire(
  lockDir: string,
  argv: string[] = [],
  onSecondInstance: (urls: string[]) => void = () => {}
): Promise<SingleInstanceLock> {
  const lock = await acquireSingleInstance({ lockDir, uid, argv, onSecondInstance })
  heldLocks.push(lock)
  return lock
}

afterEach(() => {
  for (const lock of heldLocks.splice(0)) lock.release()
  for (const dir of scratchDirs.splice(0)) rmSync(join(dir, '..'), { recursive: true, force: true })
})

describe('extractForwardableUrls', () => {
  it('keeps only http(s) URLs from argv', () => {
    expect(
      extractForwardableUrls([
        '/usr/bin/amnesic',
        '--no-sandbox',
        'https://example.com/a',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'HTTP://UPPER.example'
      ])
    ).toEqual(['https://example.com/a', 'HTTP://UPPER.example'])
  })

  it('caps the number of forwarded URLs', () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`)
    expect(extractForwardableUrls(many)).toHaveLength(8)
  })
})

describe('parseForwardedUrls', () => {
  it('accepts a well-formed message', () => {
    expect(parseForwardedUrls('{"urls":["https://example.com"]}')).toEqual(['https://example.com'])
  })

  it('rejects garbage, wrong shapes, and oversized payloads', () => {
    expect(parseForwardedUrls('not json')).toBeNull()
    expect(parseForwardedUrls('null')).toBeNull()
    expect(parseForwardedUrls('{"urls":"https://example.com"}')).toBeNull()
    expect(parseForwardedUrls(`{"urls":["${'x'.repeat(20 * 1024)}"]}`)).toBeNull()
  })

  it('re-filters URL schemes — the receiving side never trusts the sender', () => {
    expect(parseForwardedUrls('{"urls":["file:///etc/passwd","https://ok.example",42]}')).toEqual([
      'https://ok.example'
    ])
  })
})

describe('acquireSingleInstance', () => {
  it('first launch acquires; release removes the lock dir', async () => {
    const dir = scratchLockDir()
    const lock = await acquire(dir)
    expect(lock.acquired).toBe(true)
    lock.release()
    expect(existsSync(dir)).toBe(false)
  })

  it('second launch forwards its URLs to the holder and does not acquire', async () => {
    const dir = scratchLockDir()
    const received = new Promise<string[]>((resolve) => {
      void acquire(dir, [], resolve)
    })
    // Wait for the holder to be listening before launching the "second" one.
    await new Promise((r) => setTimeout(r, 50))
    const second = await acquire(dir, ['--flag', 'https://example.com/from-argv'])
    expect(second.acquired).toBe(false)
    expect(await received).toEqual(['https://example.com/from-argv'])
  })

  it('recovers the lock from a crashed holder (stale socket file)', async () => {
    // Simulate a crash: the lock dir and socket path exist but nothing is
    // listening (a plain file forces the connect failure deterministically).
    const dir = scratchLockDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 's'), '', { mode: 0o600 })
    const next = await acquire(dir)
    expect(next.acquired).toBe(true)
  })

  it('falls back to standalone when the lock dir is unusable', async () => {
    const parent = mkdtempSync(join(shortTmpRoot(), 'amn-'))
    scratchDirs.push(join(parent, 'lock'))
    const fileInTheWay = join(parent, 'lock')
    writeFileSync(fileInTheWay, 'not a directory')
    const lock = await acquire(fileInTheWay)
    expect(lock.acquired).toBe(true) // launch anyway, just without the lock
  })
})
