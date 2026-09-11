import { describe, expect, it, vi } from 'vitest'
import { TeamError } from '../src/error.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'

describe('TeamRuntimeLifecycle', () => {
  it('closes admission and treats TEAM_DISPOSED as cancellation', async () => {
    const life = new TeamRuntimeLifecycle(50)
    expect(life.disposed).toBe(false)
    life.close()
    expect(life.disposed).toBe(true)
    expect(life.reason).toBeInstanceOf(TeamError)
    expect((life.reason as TeamError).code).toBe('TEAM_DISPOSED')
    await expect(Promise.reject(life.reason)).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
  })

  it('settles mixed outcomes and ignores disposal cancellation', async () => {
    const life = new TeamRuntimeLifecycle(1_000)
    life.close()
    const failures: unknown[] = []
    await life.settle([
      Promise.resolve('ok'),
      Promise.reject(life.reason),
      Promise.reject(new Error('boom')),
    ], failures)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ message: 'boom' })
    await life.settle([], failures)
    expect(failures).toHaveLength(1)
  })

  it('times out a hung settlement', async () => {
    vi.useFakeTimers()
    const life = new TeamRuntimeLifecycle(20)
    const hung = new Promise<void>(() => undefined)
    const pending = life.withTimeout(hung)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TEAM_DISPOSAL_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    vi.useRealTimers()
  })

  it('walks Error.cause to recognize disposal and ignores unrelated values', async () => {
    const life = new TeamRuntimeLifecycle(1_000)
    life.close()
    const wrapped = new Error('wrap', { cause: life.reason })
    const cyclic = new Error('cycle')
    cyclic.cause = cyclic
    const otherDisposed = new TeamError('Agent Teams service disposed', 'TEAM_DISPOSED')
    const failures: unknown[] = []
    await life.settle([
      Promise.reject(wrapped),
      Promise.reject(cyclic),
      Promise.reject('plain'),
      Promise.reject(otherDisposed),
    ], failures)
    expect(failures).toHaveLength(2)
  })

  it('records a settlement timeout as an unexpected failure', async () => {
    vi.useFakeTimers()
    const life = new TeamRuntimeLifecycle(20)
    const failures: unknown[] = []
    const pending = life.settle([new Promise(() => undefined)], failures)
    await vi.advanceTimersByTimeAsync(25)
    await pending
    expect(failures[0]).toMatchObject({ code: 'TEAM_DISPOSAL_TIMEOUT' })
    vi.useRealTimers()
  })
})
