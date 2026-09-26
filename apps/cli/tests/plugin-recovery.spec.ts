/** Expert CLI dispatch cannot reconcile an unsettled managed installation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoveredProfile } from '@shres-code/shres-code-app-boot'

const recovery = vi.hoisted(() => vi.fn<(_dir: string, options: { signal: AbortSignal }) => Promise<RecoveredProfile>>())
vi.mock('@shres-code/shres-code-app-boot', () => ({
  withRecoveredProfile: async (dir: string, options: { signal: AbortSignal }, operation: (value: RecoveredProfile) => number) =>
    operation(await recovery(dir, options)),
  resolveProfileDir: (name: string) => '/profiles/' + name,
  nodePnpmRunner: vi.fn(),
}))
import { withProfilePluginRecovery } from '../src/plugin-recovery.ts'

let errors: string[]
beforeEach(() => {
  vi.clearAllMocks()
  errors = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errors.push(String(chunk)); return true })
})
afterEach(() => { vi.restoreAllMocks() })

describe('expert CLI recovery', () => {
  it('runs the command only after an interrupted transaction has settled', async () => {
    const order: string[] = []
    recovery.mockImplementation(async () => {
      await Promise.resolve()
      order.push('recovered')
      return { kind: 'recovered', op: 'install', rollback: { filesRestored: true, reinstall: 'ok' } }
    })
    const result = await withProfilePluginRecovery('test', () => { order.push('command'); return 7 })
    expect(result).toBe(7)
    expect(order).toEqual(['recovered', 'command'])
    expect(errors.join('')).toContain('filesRestored')
  })

  it('does not run a command while another process owns the transaction', async () => {
    recovery.mockRejectedValue(new Error('install-plugin transaction by pid 12345 pending'))
    const run = vi.fn(() => 0)
    expect(await withProfilePluginRecovery('test', run)).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('pid 12345 pending')
  })

  it('reports failed recovery without invoking the command', async () => {
    recovery.mockRejectedValue(new Error('restore failed'))
    const run = vi.fn(() => 0)
    expect(await withProfilePluginRecovery('test', run)).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('restore failed')
  })

  it('removes temporary signal listeners before invoking the synchronous command', async () => {
    const term = process.listenerCount('SIGTERM')
    const interrupt = process.listenerCount('SIGINT')
    recovery.mockResolvedValue({ kind: 'none' })
    expect(await withProfilePluginRecovery('test', () => {
      expect(process.listenerCount('SIGTERM')).toBe(term)
      expect(process.listenerCount('SIGINT')).toBe(interrupt)
      return 0
    })).toBe(0)
  })

  it.each([['SIGTERM', 0], ['SIGINT', 130]] as const)('awaits cancellation before returning the %s exit code', async (signal, exitCode) => {
    const initial = new Set(process.listeners(signal))
    const order: string[] = []
    recovery.mockImplementation((_dir: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        queueMicrotask(() => { order.push('runner-stopped'); reject(new Error('recovery aborted')) })
      }, { once: true })
    }))
    const run = vi.fn(() => 0)
    const pending = withProfilePluginRecovery('test', run)
    const added = process.listeners(signal).find(listener => !initial.has(listener))
    expect(added).toBeDefined()
    added?.(signal)
    expect(await pending).toBe(exitCode)
    expect(order).toEqual(['runner-stopped'])
    expect(run).not.toHaveBeenCalled()
    expect(process.listeners(signal)).toEqual([...initial])
  })
})
