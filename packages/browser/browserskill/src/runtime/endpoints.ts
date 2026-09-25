/**
 * Loopback endpoint ownership. The extension can only reach the daemon over
 * 127.0.0.1 TCP, so every open establishes exclusive ownership of the two
 * endpoints that matter before the browser exists:
 *
 * - The persisted daemon port is bound by our own daemon; an occupied port
 *   refuses the open before Chrome launches. Occupancy is detected with a
 *   transient exclusive bind — detection only, never a release mechanism.
 * - The upstream default port is held ATOMICALLY for the whole startup: the
 *   runtime binds it itself and destroys any contact, so no extension
 *   instance can reach a foreign daemon (or ours) on it. It is a reservation
 *   with a hold, not a probe-then-release, and it releases only once the
 *   owned instance is ready.
 *
 * @module @shres-code/shres-code-browserskill/runtime/endpoints
 */

import { createServer, type Socket } from 'node:net'

/** The requested loopback port is already bound by another process. */
export class EndpointInUseError extends Error {
  constructor(readonly port: number) {
    super(`browserskill: loopback port ${port} is already in use`)
    this.name = 'EndpointInUseError'
  }
}

/** A held loopback port that destroys and counts every contact. */
export interface PortReservation {
  /** The bound port. */
  readonly port: number
  /** How many contacts the hold has destroyed so far. */
  contacts(): number
  /** Close the listening socket; idempotent. */
  release(): Promise<void>
}

/**
 * Bind 127.0.0.1 on `port` exclusively and hold it until released. Every
 * incoming connection is destroyed immediately and counted: the hold refuses
 * contact rather than serving it.
 * @param port - the port to bind; must be a positive integer.
 * @returns the reservation; call {@link PortReservation.release} when done.
 * @throws EndpointInUseError when another listener already holds the port.
 */
export async function reserveLoopbackPort(port: number): Promise<PortReservation> {
  const server = createServer((socket: Socket) => {
    contacts += 1
    socket.destroy()
  })
  let contacts = 0
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolvePromise)
  }).catch((error: unknown) => {
    server.close()
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new EndpointInUseError(port)
    throw error
  })
  // A request of port 0 is filled by the OS; report the actual bound port.
  const boundPort = (server.address() as { port: number }).port
  let released = false
  return {
    port: boundPort,
    contacts: () => contacts,
    release: async () => {
      if (released) return
      released = true
      await new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise()
        })
      })
    },
  }
}

/**
 * Pick an available loopback port for our own daemon, via the same transient
 * exclusive bind used for occupancy detection: the OS assigns a free port, we
 * release the probe, and the daemon's own bind is the real claim — if it is
 * taken in between, the start refuses loudly instead of re-porting silently.
 * @returns an available loopback port number.
 */
export async function pickAvailableLoopbackPort(): Promise<number> {
  const server = createServer()
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolvePromise)
    })
    const address = server.address() as { port: number }
    return address.port
  } finally {
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise()
      })
    })
  }
}

/**
 * Check whether a loopback port is occupied right now, via a transient
 * exclusive bind that closes immediately on success. This classifies daemon
 * start failures; it is never the mechanism that frees a port.
 * @param port - the port to test.
 * @returns `true` when something else is bound on the port.
 */
export async function isPortOccupied(port: number): Promise<boolean> {
  const server = createServer()
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolvePromise)
    })
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return true
    throw error
  } finally {
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise()
      })
    })
  }
}
