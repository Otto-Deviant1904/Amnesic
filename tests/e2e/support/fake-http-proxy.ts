import { createServer, connect, type Server, type Socket } from 'node:net'

// A minimal, hand-rolled HTTP forward proxy for e2e testing proxy mode's
// HTTP/HTTPS schemes (ADR 0012). It understands exactly enough to (a) parse
// the first request line of a proxied request, (b) record the destination
// HOST as it arrived — which, for an HTTP proxy, is the whole point: Chromium
// sends the destination hostname to the proxy (absolute-form request target
// for http:// destinations, `CONNECT host:port` for https:// destinations)
// and does NOT resolve it locally, so an unresolved hostname arriving here is
// the proof of no local DNS leak (the same property SOCKS5 has) — and (c)
// relay bytes to a fixed local backend regardless of the requested
// destination. This harness needs no real destination resolution: only proof
// of whether a request reached this proxy, and whether the hostname arrived
// unresolved (a literal name like `http-test.invalid`, never a pre-resolved
// IP).

export interface HttpProxyRequest {
  method: string
  /** The destination host exactly as it arrived on the wire — for a working
   *  HTTP proxy this is an unresolved hostname, never a local IP. */
  host: string
  port: number
}

export interface FakeHttpProxyServer {
  port: number
  requestLog: HttpProxyRequest[]
  close(): Promise<void>
}

function parseFirstLine(chunk: Buffer): { method: string; target: string } | null {
  const firstLine = chunk.toString('latin1').split('\r\n', 1)[0] ?? ''
  const parts = firstLine.split(' ')
  if (parts.length < 3) return null
  return { method: parts[0]!, target: parts[1]! }
}

function destinationOf(method: string, target: string): { host: string; port: number } | null {
  if (method === 'CONNECT') {
    // authority-form: host:port
    const idx = target.lastIndexOf(':')
    if (idx < 0) return null
    return { host: target.slice(0, idx), port: Number(target.slice(idx + 1)) }
  }
  // absolute-form: scheme://host[:port]/path
  try {
    const url = new URL(target)
    return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) }
  } catch {
    return null
  }
}

export function startFakeHttpProxyServer(backendPort: number): Promise<FakeHttpProxyServer> {
  const requestLog: HttpProxyRequest[] = []
  // Tracks every accepted socket (plus its paired backend connection) so
  // close() can forcibly tear them down. Plain server.close() only stops
  // accepting and waits for existing connections to end on their own — but
  // Chromium pools and keeps proxy connections alive/idle, so a kill-switch
  // test awaiting close() to simulate "the proxy vanished" would hang for
  // however long Chromium keeps that socket pooled. A real dead proxy doesn't
  // wait for its client to hang up. (Same reason fake-socks5.ts tracks
  // sockets.)
  const openSockets = new Set<Socket>()

  const server: Server = createServer((socket: Socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
    socket.on('error', () => {
      /* a torn-down connection (e.g. the kill-switch test closing the server
         mid-relay) is expected, not a test failure */
    })

    socket.once('data', (chunk: Buffer) => {
      const line = parseFirstLine(chunk)
      const dest = line && destinationOf(line.method, line.target)
      if (!line || !dest) {
        socket.destroy()
        return
      }
      requestLog.push({ method: line.method, host: dest.host, port: dest.port })

      const backend = connect(backendPort, '127.0.0.1')
      openSockets.add(backend)
      backend.on('close', () => openSockets.delete(backend))
      backend.on('error', () => {
        socket.destroy()
      })
      backend.once('connect', () => {
        if (line.method === 'CONNECT') {
          // Open the tunnel, then relay raw bytes both ways. (Not exercised by
          // the http-destination tests, which use absolute-form GET, but kept
          // so an https destination would tunnel correctly too.)
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        } else {
          // Forward the buffered absolute-form request as-is; the fixed backend
          // ignores the request target and always serves its marker page.
          backend.write(chunk)
        }
        socket.pipe(backend)
        backend.pipe(socket)
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        requestLog,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
            for (const socket of openSockets) socket.destroy()
          })
      })
    })
  })
}
