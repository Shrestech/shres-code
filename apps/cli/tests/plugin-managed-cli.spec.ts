/** CLI consent and lifecycle handling; the shared core owns filesystem transactions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  begin: vi.fn(), remove: vi.fn(), init: vi.fn(), heal: vi.fn(), exists: vi.fn(),
  reader: { question: vi.fn(), once: vi.fn(), off: vi.fn(), close: vi.fn() },
}))
vi.mock('node:fs', () => ({ existsSync: mocks.exists }))
vi.mock('node:readline/promises', () => ({ createInterface: () => mocks.reader }))
vi.mock('@shres-code/shres-code-app-boot', () => ({
  beginPluginInstall: mocks.begin,
  removePlugin: mocks.remove,
  initProfile: mocks.init,
  healProfilesModuleFallback: mocks.heal,
  resolveProfileDir: (profile: string) => '/profiles/' + profile,
  nodePnpmRunner: vi.fn(),
  PROFILE_TEMPLATES: {}, PROFILE_TEMPLATE_EDITIONS: {}, DEFAULT_PROFILE_BUNDLES: ['base'],
}))
import { runPluginManagementCli } from '../src/plugin-managed-cli.ts'

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const rollback = { filesRestored: true, reinstall: 'ok' }
let output: string[]
let errors: string[]

function tty(enabled: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: enabled })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: enabled })
}

function parked() {
  return {
    preview: { spec: 'demo', name: 'demo', version: '1.0.0', source: 'registry', clientHalf: false, addedPackages: [] },
    confirm: vi.fn(async () => ({ kind: 'committed', name: 'demo', version: '1.0.0', readiness: 'restart-required' })),
    cancel: vi.fn(async () => rollback),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tty(true)
  mocks.exists.mockReturnValue(true)
  mocks.reader.question.mockResolvedValue('yes')
  output = []
  errors = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errors.push(String(chunk)); return true })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY)
  else Reflect.deleteProperty(process.stdin, 'isTTY')
  if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
})

describe('managed plugin CLI', () => {
  it.each(['install', 'remove'] as const)('refuses %s on Windows before any profile mutation', async (kind) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      mocks.exists.mockReturnValue(false)
      expect(await runPluginManagementCli({ kind, profile: 'test', target: 'demo', yes: true })).toBe(1)
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
    expect(mocks.init).not.toHaveBeenCalled()
    expect(mocks.heal).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('unsupported-platform')
  })

  it('refuses non-interactive use without consent before profile creation or package execution', async () => {
    tty(false)
    expect(await runPluginManagementCli({ kind: 'install', profile: 'test', target: 'demo', yes: false })).toBe(1)
    expect(mocks.init).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('explicit --yes')
  })

  it('prints the preview, confirms, and reports restart after commit', async () => {
    const install = parked()
    mocks.begin.mockResolvedValue({ kind: 'parked', install })
    mocks.exists.mockReturnValue(false)
    expect(await runPluginManagementCli({ kind: 'install', profile: 'test', target: 'demo', yes: false })).toBe(0)
    expect(mocks.init).toHaveBeenCalledWith('/profiles/test', ['base'], undefined)
    // The fresh home's shared fallback is healed from this app's own manifest before the core runs.
    expect(mocks.heal).toHaveBeenCalledWith(expect.stringMatching(/apps[\\/]cli[\\/]package\.json$/))
    expect(mocks.heal.mock.invocationCallOrder[0]).toBeLessThan(mocks.begin.mock.invocationCallOrder[0] ?? 0)
    expect(mocks.reader.question).toHaveBeenCalled()
    expect(install.confirm).toHaveBeenCalledOnce()
    expect(install.cancel).not.toHaveBeenCalled()
    expect(output.join('')).toContain('1.0.0')
    expect(output.join('')).toContain('restart the profile')
    expect(mocks.reader.close).toHaveBeenCalledOnce()
  })

  it('accepts explicit --yes without reading the terminal', async () => {
    tty(false)
    const install = parked()
    mocks.begin.mockResolvedValue({ kind: 'parked', install })
    expect(await runPluginManagementCli({ kind: 'install', profile: 'test', target: 'demo', yes: true })).toBe(0)
    expect(mocks.reader.question).not.toHaveBeenCalled()
    expect(install.confirm).toHaveBeenCalledOnce()
  })

  it('awaits rollback when confirmation is declined', async () => {
    const install = parked()
    mocks.begin.mockResolvedValue({ kind: 'parked', install })
    mocks.reader.question.mockResolvedValue('no')
    expect(await runPluginManagementCli({ kind: 'install', profile: 'test', target: 'demo', yes: false })).toBe(1)
    expect(install.confirm).not.toHaveBeenCalled()
    expect(install.cancel).toHaveBeenCalledOnce()
    expect(output.join('')).toContain('cancelled')
  })

  it('reports a core refusal without prompting or claiming activation', async () => {
    mocks.begin.mockResolvedValue({ kind: 'refused', refusal: { code: 'foreign-dsh', name: 'demo' }, rollback })
    expect(await runPluginManagementCli({ kind: 'install', profile: 'test', target: 'demo', yes: true })).toBe(1)
    expect(mocks.reader.question).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('foreign-dsh')
    expect(output.join('')).not.toContain('restart the profile')
  })

  it('settles the parked operation when the confirmation reader fails', async () => {
    const install = parked()
    mocks.begin.mockResolvedValue({ kind: 'parked', install })
    mocks.reader.question.mockRejectedValue(new Error('input closed'))
    expect(await runPluginManagementCli({ kind: 'install', profile: 'test', target: 'demo', yes: false })).toBe(1)
    expect(install.cancel).toHaveBeenCalledOnce()
    expect(errors.join('')).toContain('input closed')
    expect(mocks.reader.close).toHaveBeenCalledOnce()
  })

  it('preserves the operation error and reports a failed cleanup', async () => {
    const install = parked()
    install.confirm.mockRejectedValue(new Error('commit failed'))
    install.cancel.mockRejectedValue(new Error('restore failed'))
    mocks.begin.mockResolvedValue({ kind: 'parked', install })
    expect(await runPluginManagementCli({ kind: 'install', profile: 'test', target: 'demo', yes: true })).toBe(1)
    expect(errors.join('')).toContain('commit failed')
    expect(errors.join('')).toContain('rollback failed: restore failed')
  })

  it('declined removal never calls the core', async () => {
    mocks.reader.question.mockResolvedValue('')
    expect(await runPluginManagementCli({ kind: 'remove', profile: 'test', target: 'demo', yes: false })).toBe(1)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each(['ok', 'failed'])('reports the package-manager removal outcome %s', async (pnpm) => {
    mocks.remove.mockResolvedValue({ kind: 'removed', pnpm })
    expect(await runPluginManagementCli({ kind: 'remove', profile: 'test', target: 'demo', yes: true })).toBe(pnpm === 'ok' ? 0 : 1)
    const signalMatcher: unknown = expect.any(AbortSignal)
    expect(mocks.remove).toHaveBeenCalledWith('/profiles/test', 'demo', expect.objectContaining({ signal: signalMatcher }))
  })

  it('reports refused removals without a restart-success message', async () => {
    mocks.remove.mockResolvedValue({ kind: 'refused', code: 'template-bundle' })
    expect(await runPluginManagementCli({ kind: 'remove', profile: 'test', target: 'base', yes: true })).toBe(1)
    expect(output.join('')).toContain('template-bundle')
    expect(output.join('')).not.toContain('restart the profile')
  })
})
