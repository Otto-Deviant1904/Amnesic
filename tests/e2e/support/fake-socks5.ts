import { createServer, connect, type Server, type Socket } from 'node:net'

// A minimal, hand-rolled SOCKS5 server (RFC 1928) for e2e testing Tor mode
// (ADR 0007). It understands exactly enough of the protocol to (a) complete
// method negotiation (no-auth only), (b) parse a CONNECT request and record
// its address type/value, and (c) relay bytes to a fixed local backend
// regardless of what destination was actually requested. This project
// doesn't need real destination resolution for these tests — only proof of
// whether a given request reached this proxy at all, and whether the
// hostname arrived at it unresolved (SOCKS5's domain-name address type,
// never a pre-resolved IP).

export interface Socks5ConnectRequest {
  /** 0x01 = IPv4, 0x03 = domain name, 0x04 = IPv6. */
  atyp: number
  address: string
  port: number
}

export interface FakeSocks5Server {
  port: number
  connectLog: Socks5ConnectRequest[]
  close(): Promise<void>
}

function parseConnectRequest(request: Buffer): Socks5ConnectRequest {
  const atyp = request[3]!
  let address = ''
  let offset = 4
  if (atyp === 0x01) {
    address = Array.from(request.subarray(4, 8)).join('.')
    offset = 8
  } else if (atyp === 0x03) {
    const len = request[4]!
    address = request.subarray(5, 5 + len).toString('utf8')
    offset = 5 + len
  } else if (atyp === 0x04) {
    address = request.subarray(4, 20).toString('hex')
    offset = 20
  }
  const port = request.readUInt16BE(offset)
  return { atyp, address, port }
}

export function startFakeSocks5Server(backendPort: number): Promise<FakeSocks5Server> {
  const connectLog: Socks5ConnectRequest[] = []
  // Tracks every socket this server has ever accepted (plus its paired
  // backend connection once relaying starts) so close() can forcibly tear
  // them down. Plain server.close() only stops accepting new connections
  // and waits for existing ones to end on their own — but Chromium pools
  // and keeps proxy tunnel connections alive/idle rather than closing them
  // promptly, so a kill-switch test that awaits close() to simulate "the
  // proxy vanished" would hang for however long Chromium keeps that socket
  // pooled. A real dead proxy doesn't wait for its client to hang up.
  const openSockets = new Set<Socket>()

  const server: Server = createServer((socket: Socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
    socket.once('data', (greeting: Buffer) => {
      if (greeting[0] !== 0x05) {
        socket.destroy()
        return
      }
      // Version 5, method 0x00 (no authentication) selected.
      socket.write(Buffer.from([0x05, 0x00]))

      socket.once('data', (request: Buffer) => {
        connectLog.push(parseConnectRequest(request))

        const backend = connect(backendPort, '127.0.0.1')
        openSockets.add(backend)
        backend.on('close', () => openSockets.delete(backend))
        backend.once('connect', () => {
          // Reply: succeeded (REP=0x00), bound address 0.0.0.0:0 — the
          // value here is unused by any client that just wants to start
          // exchanging bytes, which is all this harness needs.
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          socket.pipe(backend)
          backend.pipe(socket)
        })
        backend.once('error', () => {
          // REP=0x01: general SOCKS server failure.
          socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          socket.destroy()
        })
      })
    })
    socket.on('error', () => {
      /* a torn-down connection (e.g. the kill-switch test closing the
         server mid-relay) is expected, not a test failure */
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        connectLog,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
            for (const socket of openSockets) socket.destroy()
          })
      })
    })
  })
}
