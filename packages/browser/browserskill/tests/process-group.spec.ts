/** Read-only group proof uses PID metadata, never command lines or process signals. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { observeOwnedGroup, waitForOwnedGroupMembers, isOwnedChromeProcess } from '../src/runtime/process-group.ts'
const ps = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: ps }) }
})
let killSignal!: MockInstance<typeof process.kill>
beforeEach(() => {
  ps.mockReset()
  killSignal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('must never signal') })
})
afterEach(() => { expect(killSignal).not.toHaveBeenCalled(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('process-group observation', () => {
  it.each([
    ['/owned/profile', '/chrome --user-data-dir=/owned/profile', true],
    ['/owned/profile', '/chrome --user-data-dir=/owned/profile --other', true],
    ['/owned/profile', '/chrome --user-data-dir=/owned/profile2 --other', false],
    ['/owned/profile', '/chrome --user-data-dir=/owned/profile2 --user-data-dir=/owned/profile', true],
    ['/owned/with space/profile', '/chrome --user-data-dir=/owned/with space/profile --other', true],
    ['/owned/profile', '/unrelated-process', false],
  ])('matches the exact profile token %s in %s', async (profile, command, expected) => {
    ps.mockResolvedValue({ stdout: command })
    expect(await isOwnedChromeProcess(42, profile)).toBe(expected)
    expect(ps).toHaveBeenCalledWith('/bin/ps', ['-ww', '-p', '42', '-o', 'command='], expect.objectContaining({ timeout: 2000 }))
  })
  it('treats a disappeared pid as gone, not an unreadable live process', async () => {
    ps.mockRejectedValue({ code: 1, stdout: '', stderr: '' })
    expect(await isOwnedChromeProcess(42, '/owned/profile', 100)).toBe(false)
  })
  it.each([
    { code: 'EACCES', stdout: '', stderr: '' },
    { code: 1, stdout: 'unexpected output', stderr: '' },
    { code: 1, stdout: '', stderr: 'query failed' },
  ])('fails closed on a process identity query failure', async (error) => {
    ps.mockRejectedValue(error)
    await expect(isOwnedChromeProcess(42, '/owned/profile')).rejects.toThrow('cannot verify Chrome process identity')
  })
  it('ignores positively unmarked members of a reused group', async () => {
    ps.mockResolvedValue({ stdout: '43 42\n1 1\n' })
    const verify = vi.fn(async () => false)
    await expect(waitForOwnedGroupMembers(42, 5000, verify)).resolves.toEqual([43])
    expect(verify).toHaveBeenCalledWith(43, expect.any(Number))
  })
  it('stops checking identities when the shared grace is exhausted', async () => {
    vi.useFakeTimers()
    ps.mockImplementation(async () => { vi.setSystemTime(Date.now() + 100); return { stdout: '43 42\n' } })
    await expect(waitForOwnedGroupMembers(42, 100, async () => true)).rejects.toThrow('within the shutdown deadline')
  })

  it('grants group authority only when the owned child is its leader', async () => {
    ps.mockResolvedValueOnce({ stdout: ' 42\n' }).mockResolvedValueOnce({ stdout: '43' }).mockResolvedValueOnce({ stdout: 'garbage' }).mockRejectedValueOnce(new Error('ps failed'))
    expect(await observeOwnedGroup(42)).toBe(42)
    expect(await observeOwnedGroup(42)).toBeUndefined()
    expect(await observeOwnedGroup(42)).toBeUndefined()
    expect(await observeOwnedGroup(42)).toBeUndefined()
    expect(ps).toHaveBeenCalledWith('/bin/ps', ['-o', 'pgid=', '-p', '42'], expect.objectContaining({ timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024 }))
  })
  it('waits for natural helper exit and never signals a reused group', async () => {
    ps.mockResolvedValueOnce({ stdout: '43 42\n1 1\n' }).mockResolvedValue({ stdout: '1 1\n' })
    vi.useFakeTimers()
    const pending = waitForOwnedGroupMembers(42, 5000, async () => true)
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(ps).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retains a bounded diagnostic when membership persists', async () => {
    ps.mockResolvedValue({ stdout: '43 42\n44 42\n' })
    vi.useFakeTimers()
    const pending = waitForOwnedGroupMembers(42, 250, async () => true).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(250)
    expect(String(await pending)).toContain('43, 44 remain')
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['', 'one two', '4', '4 999999999999999999999'])('refuses unverifiable output %j', async (stdout) => {
    ps.mockResolvedValue({ stdout })
    await expect(waitForOwnedGroupMembers(42, 5000, async () => true)).rejects.toThrow(/process-group/)
  })
  it('refuses an expired grace without making a process query', async () => {
    await expect(waitForOwnedGroupMembers(42, 0, async () => true)).rejects.toThrow('could not be verified')
    expect(ps).not.toHaveBeenCalled()
  })
  it('refuses process-query failure without disclosing unrelated process details', async () => {
    ps.mockRejectedValue(new Error('ps failed'))
    await expect(waitForOwnedGroupMembers(42, 100, async () => true)).rejects.toThrow('cannot verify recorded Chrome group 42')
  })
})
