/**
 * Profile startup runs recovery, composition, and edition provisioning under
 * one profile lease, releases it before boot, and awaits the leased step on
 * shutdown before exiting.
 */
import { Context } from '@shres-code/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessShutdown } from '../src/process-shutdown.ts'

const mocks = vi.hoisted(() => ({
  recover: vi.fn(), lease: vi.fn(), load: vi.fn(), boot: vi.fn(), metadata: vi.fn(),
  ensure: vi.fn(), exit: vi.fn(), complete: vi.fn(),
  cmdline: vi.fn<(ctx: Context, value: { args: readonly string[]; exit: (code: number) => void }) => void>(),
}))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), writeFileSync: vi.fn() }))
vi.mock('../src/plugin.ts', () => ({ ensureProfileEditions: mocks.ensure }))
vi.mock('@shres-code/shres-code-cmdline', () => ({ provideCmdline: mocks.cmdline }))
vi.mock('../src/process-shutdown.ts', async (original) => {
  const actual = await original<typeof import('../src/process-shutdown.ts')>()
  return {
    ...actual,
    createProcessShutdown: (dispose: () => Promise<void>): ProcessShutdown =>
      actual.createProcessShutdown(dispose, mocks.exit, mocks.complete),
  }
})
vi.mock('@shres-code/shres-code-app-boot', async () => ({
  ProfilePluginError: (await import('@shres-code/shres-code-app-boot/plugin-types')).ProfilePluginError,
  withRecoveredProfile: mocks.lease, nodePnpmRunner: vi.fn(),
  resolveProfileDir: (name: string) => '/profiles/' + name,
  boot: mocks.boot, loadProfile: mocks.load, provideProfileRuntime: mocks.metadata,
  composeEntries: () => [], healProfilesModuleFallback: vi.fn(), installFailLoud: vi.fn(),
  loadOptionalPatches: () => [], loadOverlayPatches: () => [], watchUserPatches: vi.fn(),
  PROFILE_PATCH_FILENAME: 'cordis.patch.yml',
}))
import { runProfile } from '../src/profile-boot.ts'
import { ProfilePluginError } from '@shres-code/shres-code-app-boot/plugin-types'

const invocation = {
  profile: 'test', args: [], patchFiles: [],
  environment: { get: () => undefined, getFrom: () => undefined },
}
let contexts: Context[]
let signals: Map<'SIGTERM' | 'SIGINT', Set<ReturnType<typeof process.listeners>[number]>>
let errors: string[]
let leaseLog: string[]

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SHRES_TELEMETRY_DISABLED', undefined)
  contexts = []
  errors = []
  leaseLog = []
  signals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal as 'SIGTERM' | 'SIGINT', new Set(process.listeners(signal))]))
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errors.push(String(chunk)); return true })
  mocks.recover.mockResolvedValue({ kind: 'none' })
  // The lease recovers (through `recover`, so tests can script it), runs the
  // callback while "held", and records release after the callback settles.
  mocks.lease.mockImplementation(async (dir: string, options: { signal: AbortSignal }, operation: (outcome: unknown) => unknown) => {
    leaseLog.push('acquire:' + dir)
    try {
      const outcome: unknown = await mocks.recover(dir, options)
      return await operation(outcome)
    } finally {
      leaseLog.push('release')
    }
  })
  mocks.ensure.mockReturnValue(0)
  mocks.load.mockReturnValue({
    name: 'test', dir: '/profiles/test', patchPath: '/profiles/test/cordis.patch.yml', patches: [],
    layers: [{ packageName: 'demo', packageDir: '/demo', patchPath: '/demo/plugin.yml', patches: [] }],
  })
  mocks.boot.mockImplementation(async (_name: string, _path: string, _patches: unknown, initialize: (ctx: Context) => void) => {
    const ctx = new Context()
    contexts.push(ctx)
    initialize(ctx)
    return ctx
  })
})

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  for (const [signal, before] of signals) {
    for (const listener of process.listeners(signal)) if (!before.has(listener)) process.off(signal, listener)
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('profile recovery lifetime', () => {
  it('recovers, composes, and provisions under one lease, then releases it before boot', async () => {
    mocks.recover.mockImplementation(async () => { leaseLog.push('recovery'); return { kind: 'none' } })
    mocks.load.mockImplementation(() => {
      leaseLog.push('compose')
      return { name: 'test', dir: '/profiles/test', patchPath: '/profile/patch.yml', patches: [], layers: [{ packageName: 'demo', patches: [] }] }
    })
    mocks.ensure.mockImplementation(() => { leaseLog.push('ensure'); return 0 })
    mocks.boot.mockImplementationOnce(async (_name: string, _path: string, _patches: unknown, initialize: (ctx: Context) => void) => {
      leaseLog.push('boot')
      const ctx = new Context()
      contexts.push(ctx)
      initialize(ctx)
      return ctx
    })
    const result = await runProfile(invocation)
    expect(leaseLog).toEqual(['acquire:/profiles/test', 'recovery', 'compose', 'ensure', 'release', 'boot'])
    expect(mocks.metadata).toHaveBeenCalledWith(result.ctx, {
      profileDir: '/profiles/test', bootBundles: ['demo'], pluginMutations: 'enabled',
    })
    await result.shutdown.shutdown(0)
  })

  it('refuses a live transaction before composition or automatic provisioning', async () => {
    mocks.lease.mockRejectedValue(new ProfilePluginError('transaction-pending', 'A live process owns the transaction.', 12345))
    await expect(runProfile(invocation)).rejects.toThrow('install-plugin transaction by pid 12345 pending on profile test; retry after it settles')
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.boot).not.toHaveBeenCalled()
  })

  it('reports a lock held by another process without composing', async () => {
    mocks.lease.mockRejectedValue(new ProfilePluginError('lock-timeout', 'atomic-write: timed out waiting for the writer lock at /x.lock'))
    await expect(runProfile(invocation)).rejects.toThrow('profile test is locked by another shres process; retry after it finishes')
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.boot).not.toHaveBeenCalled()
  })

  it('passes a failed restoration through unchanged', async () => {
    const failure = new ProfilePluginError('restore-failed', 'Invalid plugin transaction journal')
    mocks.lease.mockRejectedValue(failure)
    await expect(runProfile(invocation)).rejects.toBe(failure)
  })

  it('fails provisioning inside the lease and releases it before reporting', async () => {
    mocks.ensure.mockReturnValue(7)
    await expect(runProfile(invocation)).rejects.toThrow('auto-provision failed (pnpm exited 7)')
    expect(leaseLog.at(-1)).toBe('release')
    expect(mocks.boot).not.toHaveBeenCalled()
  })

  it('refuses boot after metadata recovery when dependency restoration failed', async () => {
    mocks.recover.mockResolvedValue({ kind: 'recovered', op: 'install', rollback: { filesRestored: true, reinstall: 'failed' } })
    await expect(runProfile(invocation)).rejects.toThrow('dependency restoration failed')
    expect(errors.join('')).toContain('filesRestored')
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it.each([['SIGTERM', 0], ['SIGINT', 130]] as const)('waits for recovery to stop before exiting on %s', async (signal, exitCode) => {
    const order: string[] = []
    mocks.exit.mockImplementation((code: number) => { order.push('exit:' + String(code)) })
    mocks.recover.mockImplementation((_dir: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        queueMicrotask(() => { order.push('runner-stopped'); reject(new Error('recovery aborted')) })
      }, { once: true })
    }))
    const pending = runProfile(invocation)
    const rejected = expect(pending).rejects.toThrow('recovery aborted')
    const listener = process.listeners(signal).find(item => !signals.get(signal)?.has(item))
    expect(listener).toBeDefined()
    listener?.(signal)
    await rejected
    // Shutdown awaited the whole leased step, released lease included, before exiting.
    expect(order).toEqual(['runner-stopped', 'exit:' + String(exitCode)])
    expect(leaseLog.at(-1)).toBe('release')
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('does not await boot from the shutdown disposer when an app exits during boot', async () => {
    mocks.cmdline.mockImplementation((_ctx, value) => { value.exit(0) })
    const result = await runProfile(invocation)
    await result.shutdown.shutdown(0)
    expect(mocks.complete).toHaveBeenCalledWith(0)
    expect(mocks.exit).not.toHaveBeenCalled()
  })
})
