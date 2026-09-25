/**
 * Readiness probe for the deployment-run Shield gateway: a TCP connection to
 * the configured loopback endpoint, which tells whether a service is accepting
 * connections there without sending a judgment request.
 */

import { createConnection } from 'node:net'

/** Where the probe connects: the endpoint's host name and port. */
export interface ShieldProbeTarget {
  /** Host name without IPv6 brackets. */
  readonly hostname: string
  /** TCP port. */
  readonly port: number
}

/**
 * Resolve the probe target of a validated loopback endpoint.
 * @param endpoint - the resolved endpoint URL.
 * @returns the host name and port, defaulting the port by scheme.
 */
export function probeTarget(endpoint: string): ShieldProbeTarget {
  const url = new URL(endpoint)
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return { hostname, port }
}

/**
 * Open and close one TCP connection to the target.
 * @param target - host name and port.
 * @param timeoutMs - connection deadline.
 * @returns undefined when a connection opened, else the failure text.
 */
export function probeGateway(target: ShieldProbeTarget, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: target.hostname, port: target.port })
    const settle = (failure: string | undefined): void => {
      socket.destroy()
      resolve(failure)
    }
    socket.setTimeout(timeoutMs, () => {
      settle(`no connection within timeoutMs ${timeoutMs}`)
    })
    socket.once('connect', () => {
      settle(undefined)
    })
    socket.once('error', (error: Error) => {
      settle(error.message)
    })
  })
}
