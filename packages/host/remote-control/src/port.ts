/**
 * Loopback port allocation for tunnels: bind-verify-then-release, with a
 * re-check second pass because the kernel may hand the same ephemeral port
 * back to two successive probes.
 * @module @shres-code/shres-code-host-remote-control
 */

import { createServer } from 'node:net'

/**
 * Allocate one free loopback TCP port by binding `127.0.0.1:0`, observing the
 * assigned port, closing the listener, and re-verifying the port binds again.
 * The port is a race window by construction; the tunnel's own
 * `ExitOnForwardFailure` converts a stolen port into a loud failure.
 * @returns a loopback port that was free at call time.
 */
export async function allocateLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = await probePort()
    if (await canRebind(port)) return port
  }
  throw new Error('no rebindable loopback port found after two allocation attempts')
}

/**
 * Observe one port the kernel assigns for an ephemeral loopback bind.
 * @returns the assigned port.
 */
function probePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      // Typed same-process invariant: the loopback listener is always a TCP address.
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('loopback listener without TCP address')) }
      else server.close(() =>{  resolve(address.port) })
    })
  })
}

/**
 * Re-verify one port still accepts a new bind (guards against the allocator
 * handing back a port another process grabbed meanwhile).
 * @param port - port to re-test.
 * @returns true when a fresh bind on the port succeeded and was released.
 */
async function canRebind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () =>{  resolve(false) })
    server.once('listening', () => server.close(() =>{  resolve(true) }))
    server.listen(port, '127.0.0.1')
  })
}
