import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { isPortOccupied, pickAvailableLoopbackPort, reserveLoopbackPort } from '../src/runtime/endpoints.ts'

describe('loopback endpoints', () => {
  it('reserves and releases a port', async () => {
    const reservation = await reserveLoopbackPort(0)
    expect(reservation.port).toBeGreaterThan(0)
    await reservation.release()
    expect(await isPortOccupied(reservation.port)).toBe(false)
  })

  it('classifies an occupied port instead of stealing it', async () => {
    const first = await reserveLoopbackPort(0)
    await expect(reserveLoopbackPort(first.port)).rejects.toMatchObject({
      name: 'EndpointInUseError',
      port: first.port,
    })
    await first.release()
  })

  it('destroys and counts every contact while held', async () => {
    const reservation = await reserveLoopbackPort(0)
    const socket = connect(reservation.port, '127.0.0.1')
    await once(socket, 'close')
    expect(reservation.contacts()).toBe(1)
    await reservation.release()
  })

  it('reports occupancy via a transient probe', async () => {
    const holder = createServer()
    await new Promise<void>((resolve) => {
      holder.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
    })
    const port = (holder.address() as { port: number }).port
    expect(await isPortOccupied(port)).toBe(true)
    await new Promise<void>((resolve) => {
      holder.close(() => {
        resolve()
      })
    })
    expect(await isPortOccupied(port)).toBe(false)
  })

  it('picks an available port for our own daemon', async () => {
    const port = await pickAvailableLoopbackPort()
    expect(port).toBeGreaterThan(0)
    expect(await isPortOccupied(port)).toBe(false)
  })

  it('survives release being called twice', async () => {
    const reservation = await reserveLoopbackPort(0)
    await reservation.release()
    await expect(reservation.release()).resolves.toBeUndefined()
  })

  it('refuses an out-of-range port request instead of guessing', async () => {
    // Node validates the port before any bind: the failure is not an
    // occupancy signal and must propagate rather than be classified.
    await expect(reserveLoopbackPort(70_000)).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' })
    await expect(isPortOccupied(70_000)).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' })
  })
})
