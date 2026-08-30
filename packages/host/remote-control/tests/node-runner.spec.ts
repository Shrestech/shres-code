import { describe, expect, it } from 'vitest'
import { nodeSshRunner } from '../src/node-runner.ts'

// The adapter prepends whatever command it is given, so these specs exercise
// the process seam against process.execPath instead of a real ssh binary.
const NODE = process.execPath

describe('nodeSshRunner', () => {
  it('runs a short execution and captures its stdout', async () => {
    const result = await nodeSshRunner(NODE).run(['-e', 'console.log("runner-ok")'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('runner-ok')
  })

  it('maps a nonzero exit to probe data instead of a rejection', async () => {
    const result = await nodeSshRunner(NODE).run(['-e', 'process.exit(3)'])
    expect(result.exitCode).toBe(3)
  })

  it('maps a missing binary to the 255 probe state with the failure message', async () => {
    const result = await nodeSshRunner('/nonexistent/shres-ssh-missing').run([])
    expect(result.exitCode).toBe(255)
    expect(result.stderr).toContain('shres-ssh-missing')
  })

  it('rejects the spawn promise when the binary cannot start', async () => {
    await expect(nodeSshRunner('/nonexistent/shres-ssh-missing').spawn([])).rejects.toThrow(/ssh spawn failed/)
  })

  it('observes a natural child exit through the callback', async () => {
    const exits: (number | null)[] = []
    const handle = await nodeSshRunner(NODE).spawn(['-e', 'process.exit(7)'], (code) => { exits.push(code) })
    expect(handle.pid).toBeGreaterThan(0)
    await new Promise<void>((resolveSettled) => { setTimeout(resolveSettled, 150) })
    expect(exits).toEqual([7])
    await handle.dispose()
  })

  it('disposes a live child by SIGTERM and observes the killed exit', async () => {
    const exits: (number | null)[] = []
    const handle = await nodeSshRunner(NODE).spawn(['-e', 'setTimeout(() => {}, 30_000)'], (code) => { exits.push(code) })
    await handle.dispose()
    expect(exits).toEqual([null])
  })
})

// Windows cannot ignore SIGTERM (the signal terminates unconditionally), so
// the SIGKILL escalation arm only exists on POSIX signals.
describe.skipIf(process.platform === 'win32')('nodeSshRunner escalation', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const exits: (number | null)[] = []
    const ignoresTerm = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
    const handle = await nodeSshRunner(NODE).spawn(['-e', ignoresTerm], (code) => { exits.push(code) })
    await handle.dispose()
    expect(exits).toEqual([null])
  })
})
