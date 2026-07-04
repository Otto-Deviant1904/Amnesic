import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Single-instance lock. Electron's app.requestSingleInstanceLock() is useless
// here: it puts its lock inside userData, and our userData is a *per-pid*
// tmpfs dir — two instances would each lock their own dir and never collide.
// Pointing the built-in lock at a fixed path would mean the default location,
// ~/.config/<name>, i.e. a real-disk write, which CLAUDE.md forbids.
//
// Instead: a unix socket at a fixed per-uid path on /dev/shm. tmpfs only, so
// nothing survives reboot; a socket inode holds no data, so nothing forensic
// survives even until reboot (threat-model §2). A path-based socket (not the
// Linux abstract namespace) is deliberate: abstract-namespace names carry no
// permissions and any local user could connect or squat the name, while a
// path under a mode-0700 directory is reachable only by the owning uid.
//
// Protocol: the holder listens; a second launch connects, sends one JSON line
// of forwardable URLs from its argv, and exits. A crashed holder leaves a
// dead socket file; the next launch's connect() gets ECONNREFUSED, unlinks
// it, and takes over. This module is Electron-free so vitest can exercise
// the real socket dance in-process.

const SOCKET_FILE = 's'
const MAX_MESSAGE_BYTES = 16 * 1024
const MAX_FORWARDED_URLS = 8
const READ_TIMEOUT_MS = 2_000

export function defaultLockDir(uid: number): string {
  return `/dev/shm/amnesic-browser-lock-${uid}`
}

// Only ever forward web URLs — argv also carries Electron/Chromium switches
// and the executable path, and the receiving instance must never be told to
// open anything a tab couldn't load anyway (mirrors isAllowedUrl in index.ts).
export function extractForwardableUrls(argv: string[]): string[] {
  return argv.filter((arg) => /^https?:\/\//i.test(arg)).slice(0, MAX_FORWARDED_URLS)
}

// Parses a forwarded message defensively: same-uid processes can connect, so
// shape and size are validated rather than trusted. Returns null on garbage.
export function parseForwardedUrls(raw: string): string[] | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('urls' in parsed)) return null
    const urls = (parsed as { urls: unknown }).urls
    if (!Array.isArray(urls)) return null
    return extractForwardableUrls(urls.filter((u): u is string => typeof u === 'string'))
  } catch {
    return null
  }
}

// The lock dir must be ours alone: if an attacker pre-created it (0777, or
// owned by another uid) they could unlink our socket and squat the lock.
// Refusing the dir means refusing the *lock*, not the launch — the caller
// runs standalone, trading duplicate instances for availability.
function lockDirUsable(dir: string, uid: number): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stats = lstatSync(dir)
    return stats.isDirectory() && stats.uid === uid && (stats.mode & 0o077) === 0
  } catch {
    return false
  }
}

export interface SingleInstanceLock {
  /** True: this process holds the lock and will receive second-instance URLs. */
  acquired: boolean
  /** Holder only: stop listening and remove the lock dir. Safe to call twice. */
  release: () => void
}

function connectAndForward(socketPath: string, urls: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    socket.setTimeout(READ_TIMEOUT_MS)
    socket.on('connect', () => {
      socket.end(JSON.stringify({ urls }))
      resolve(true) // delivered — the holder validates, we're done
    })
    const fail = () => {
      socket.destroy()
      resolve(false) // nobody home (ENOENT / ECONNREFUSED / dead holder)
    }
    socket.on('error', fail)
    socket.on('timeout', fail)
  })
}

function listenOn(socketPath: string, onUrls: (urls: string[]) => void): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      let data = ''
      let overflow = false
      socket.setTimeout(READ_TIMEOUT_MS, () => socket.destroy())
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8')
        if (data.length > MAX_MESSAGE_BYTES) {
          overflow = true
          socket.destroy()
        }
      })
      socket.on('end', () => {
        if (overflow) return
        const urls = parseForwardedUrls(data)
        if (urls) onUrls(urls)
      })
      socket.on('error', () => {
        /* a hung or dropped client is its own problem */
      })
    })
    server.on('error', () => resolve(null)) // EADDRINUSE: lost the listen race
    server.listen(socketPath, () => resolve(server))
  })
}

export async function acquireSingleInstance(options: {
  lockDir: string
  uid: number
  argv: string[]
  onSecondInstance: (urls: string[]) => void
}): Promise<SingleInstanceLock> {
  const { lockDir, uid, argv, onSecondInstance } = options
  const standalone: SingleInstanceLock = { acquired: true, release: () => {} }
  if (!lockDirUsable(lockDir, uid)) return standalone // lock refused, launch anyway

  const socketPath = join(lockDir, SOCKET_FILE)
  const urls = extractForwardableUrls(argv)

  // Try existing holder → stale socket cleanup → listen → (race) retry once.
  if (await connectAndForward(socketPath, urls)) {
    return { acquired: false, release: () => {} }
  }
  rmSync(socketPath, { force: true }) // dead holder's socket file, if any
  const server = await listenOn(socketPath, onSecondInstance)
  if (!server) {
    // Another launch won the listen race in the window after our connect
    // failed. Forward to it; if it also died, just run standalone.
    if (await connectAndForward(socketPath, urls)) {
      return { acquired: false, release: () => {} }
    }
    return standalone
  }
  return {
    acquired: true,
    release: () => {
      server.close()
      rmSync(lockDir, { recursive: true, force: true })
    }
  }
}
