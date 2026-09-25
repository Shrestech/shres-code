import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** A socket double that emits only what the test drives. */
class FakeSocket extends EventEmitter {
  destroyed = false
  timeoutHandler: (() => void) | undefined
  setTimeout(_ms: number, handler: () => void): void {
    this.timeoutHandler = handler
  }

  destroy(): void {
    this.destroyed = true
  }
}

const sockets: FakeSocket[] = []
const connections: unknown[] = []

vi.mock('node:net', () => ({
  createConnection: (options: unknown) => {
    connections.push(options)
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  },
}))

const { probeGateway, probeTarget } = await import('../src/readiness.ts')

afterEach(() => {
  sockets.length = 0
  connections.length = 0
})

describe('probeTarget', () => {
  it('reads the host name and port, stripping IPv6 brackets and defaulting the port by scheme', () => {
    expect(probeTarget('http://127.0.0.1:8765/gateway')).toEqual({ hostname: '127.0.0.1', port: 8765 })
    expect(probeTarget('http://[::1]:9000')).toEqual({ hostname: '::1', port: 9000 })
    expect(probeTarget('http://localhost')).toEqual({ hostname: 'localhost', port: 80 })
    expect(probeTarget('https://localhost')).toEqual({ hostname: 'localhost', port: 443 })
  })
})

describe('probeGateway', () => {
  it('connects to the target and settles once, destroying the socket', async () => {
    const connected = probeGateway({ hostname: '127.0.0.1', port: 1 }, 50)
    sockets[0]?.emit('connect')
    sockets[0]?.emit('error', new Error('late'))
    await expect(connected).resolves.toBeUndefined()
    expect(connections).toEqual([{ host: '127.0.0.1', port: 1 }])
    expect(sockets[0]?.destroyed).toBe(true)
  })

  it('reports a connection error and a timeout by their text', async () => {
    const refused = probeGateway({ hostname: '127.0.0.1', port: 2 }, 50)
    sockets[0]?.emit('error', new Error('connect ECONNREFUSED'))
    await expect(refused).resolves.toBe('connect ECONNREFUSED')

    const silent = probeGateway({ hostname: '127.0.0.1', port: 3 }, 75)
    sockets[1]?.timeoutHandler?.()
    await expect(silent).resolves.toBe('no connection within timeoutMs 75')
    expect(sockets[1]?.destroyed).toBe(true)
  })
})
