import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import PluginAdminGateway from '../src/gateway.ts'
import * as entry from '../src/index.ts'
import { nodePluginAdminCore } from '../src/core.ts'
import type { PluginAdminCore } from '../src/core.ts'
import type {
  InstalledSkillView,
  PluginAdminStatusResult,
  PluginConfirmToken,
  SkillInstallOutcome,
} from '../src/types.ts'
import type { InstallBegin, ParkedInstall } from '@shres-code/shres-code-app-boot'

const contexts: Context[] = []
const tempDirs: string[] = []

// The profileRuntime key app-boot owns; spelled literally so the harness can
// provide it through the same untyped path a launcher uses.
const PROFILE_RUNTIME_KEY = 'profileRuntime'
const SPEC = '/plugins/plugin-hello'

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A promise whose settlement the test controls. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

type FakeParked = ParkedInstall & { cancelCalls: number; confirmCalls: number; confirmGate?: Promise<void>; cancelGate?: Promise<void> }

/** One ParkedInstall whose settle paths the test controls and observes. */
function fakeParked(): FakeParked {
  const parked: FakeParked = {
    cancelCalls: 0,
    confirmCalls: 0,
    preview: {
      spec: SPEC,
      name: 'plugin-hello',
      version: '1.0.0',
      source: 'path',
      clientHalf: false,
      addedPackages: ['plugin-hello'],
    },
    async confirm() {
      parked.confirmCalls++
      await parked.confirmGate
      return { kind: 'committed', name: 'plugin-hello', version: '1.0.0', readiness: 'restart-required' }
    },
    async cancel() {
      parked.cancelCalls++
      await parked.cancelGate
      return { filesRestored: true, reinstall: 'skipped' }
    },
  }
  return parked
}

/** Refusal default for the fabricated core's begin. */
async function beginNotWired(): Promise<InstallBegin> {
  throw new Error('begin not wired')
}

/**
 * Fabricate the shared-core seam. Every member records its calls so tests
 * assert the gateway reached (or did not reach) the core.
 */
function fabricatedCore(begin: (signal: AbortSignal) => Promise<InstallBegin> = beginNotWired): PluginAdminCore & {
  beginCalls: { spec: string; signal: AbortSignal }[]
  removeCalls: { name: string; signal: AbortSignal }[]
  addCalls: { path: string }[]
  listResult: Omit<InstalledSkillView, 'shadowedBy'>[]
} {
  const recorded = {
    beginCalls: [] as { spec: string; signal: AbortSignal }[],
    removeCalls: [] as { name: string; signal: AbortSignal }[],
    addCalls: [] as { path: string }[],
    listResult: [] as Omit<InstalledSkillView, 'shadowedBy'>[],
  }
  const core = {
    ...recorded,
    async beginPluginInstall(_profileDir: string, spec: string, options: { signal: AbortSignal }) {
      core.beginCalls.push({ spec, signal: options.signal })
      return await begin(options.signal)
    },
    async removePlugin(_profileDir: string, name: string, options: { signal: AbortSignal }) {
      core.removeCalls.push({ name, signal: options.signal })
      return { kind: 'removed' as const, pnpm: 'ok' as const }
    },
    async pluginStates() {
      return [{ name: 'plugin-hello', version: '1.0.0', state: 'active' as const, removable: true }]
    },
    async addInstalledSkill(sourceDir: string) {
      core.addCalls.push({ path: sourceDir })
      return { kind: 'installed' as const, name: 'fix-docs', path: '/installed/fix-docs', digest: 'deadbeef' }
    },
    async removeInstalledSkill() {
      return { kind: 'removed' as const }
    },
    async listInstalledSkills() {
      return core.listResult
    },
  }
  return core
}

/** A skills registry stub answering one fixed snapshot. */
function fakeSkills(skills: { name: string; source: string }[]): { snapshot: () => Promise<{ skills: unknown[]; complete: boolean }> } {
  return {
    snapshot: async () => ({ skills: skills.map(skill => ({ ...skill, description: 'd', invocation: {} })), complete: true }),
  }
}

interface HarnessOptions {
  /** Plugin mutation policy of the provided profile runtime; `null` provides none. */
  mutations?: 'enabled' | 'unsupported' | null
  skills?: unknown
  confirmTtlMs?: number
}

/** Mount the gateway over a temp profile and the fabricated core. */
async function harness(core: PluginAdminCore, options: HarnessOptions = {}): Promise<PluginAdminGateway> {
  const profileDir = await mkdtemp(join(tmpdir(), 'shres-plugin-admin-'))
  tempDirs.push(profileDir)
  const ctx = new Context()
  contexts.push(ctx)
  if (options.mutations !== null) {
    ctx.provide(PROFILE_RUNTIME_KEY as never, {
      profileDir,
      bootBundles: ['plugin-hello'],
      pluginMutations: options.mutations ?? 'enabled',
    })
  }
  if (options.skills !== undefined) ctx.provide('skills' as never, options.skills)
  // Cordis plugin constructors take (ctx, config) only, so the fabricated
  // core rides a subclass instead of a third argument.
  class TestGateway extends PluginAdminGateway {
    constructor(ctx: Context, config?: { confirmTtlMs?: number }) {
      super(ctx, config, core)
    }
  }
  await ctx.plugin(TestGateway, options.confirmTtlMs === undefined ? {} : { confirmTtlMs: options.confirmTtlMs })
  return ctx.get('pluginAdmin') as PluginAdminGateway
}

/** Grant and run one install of {@link SPEC}. */
function install(gateway: PluginAdminGateway, spec = SPEC): ReturnType<PluginAdminGateway['stageInstall']> {
  return gateway.stageInstall({ token: gateway.begin({ verb: 'install', target: spec }).token, spec })
}

/** Park one install and return its confirm token. */
async function parkedToken(gateway: PluginAdminGateway): Promise<PluginConfirmToken> {
  const outcome = await install(gateway)
  if (outcome.kind !== 'parked') throw new Error(`expected a parked install, got ${outcome.kind}`)
  return outcome.confirmToken
}

/** The gateway's own context, whose disposal unmounts it. */
function contextOf(gateway: PluginAdminGateway): Context {
  return (gateway as unknown as { ctx: Context }).ctx
}

/** Write a minimal valid skill source directory. */
async function skillSource(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-plugin-admin-skill-'))
  tempDirs.push(dir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: fix-docs\ndescription: fixes docs\n---\nBody.\n')
  return dir
}

describe('PluginAdminGateway', () => {
  it('exports the gateway as the package entry', () => {
    expect(entry.default).toBe(PluginAdminGateway)
    expect(entry.PluginAdminGateway).toBe(PluginAdminGateway)
    expect(new entry.PluginAdminError('invalid-target', 'm').code).toBe('invalid-target')
  })

  it('exposes the eight methods as direct Remote calls', async () => {
    const gateway = await harness(fabricatedCore())
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'pluginAdmin', namespace: 'pluginAdmin' })
    expect(remoteMethods(gateway).map(marker => marker.method)).toEqual([
      'status', 'begin', 'stageInstall', 'confirm', 'cancel', 'removePlugin', 'skillAdd', 'skillRemove',
    ])
  })

  it('refuses mutations without an unspent, verb- and target-matched gesture token', async () => {
    const gateway = await harness(fabricatedCore())
    await expect(gateway.stageInstall({ token: 'absent' as never, spec: SPEC })).rejects.toMatchObject({ code: 'gesture-refused' })
    // A token minted for another verb is spent by the failed attempt and
    // cannot authorize the right verb afterwards.
    const wrongVerb = gateway.begin({ verb: 'remove', target: SPEC }).token
    await expect(gateway.stageInstall({ token: wrongVerb, spec: SPEC })).rejects.toMatchObject({ code: 'gesture-refused' })
    await expect(gateway.removePlugin({ token: wrongVerb, name: SPEC })).rejects.toMatchObject({ code: 'gesture-refused' })
    // A token minted for another spec is refused too.
    const wrongTarget = gateway.begin({ verb: 'install', target: '/plugins/other' }).token
    await expect(gateway.stageInstall({ token: wrongTarget, spec: SPEC })).rejects.toMatchObject({ code: 'gesture-refused' })
  })

  it('refuses an empty begin target', async () => {
    const gateway = await harness(fabricatedCore())
    expect(() => gateway.begin({ verb: 'install', target: '' })).toThrow(/non-empty target/)
  })

  it.each(['./plugin', '../plugin', '.', 'file:./plugin', 'link:../plugin', '~/plugin'])(
    'refuses the relative local install spec %s without reaching the core',
    async (spec) => {
      const core = fabricatedCore()
      const gateway = await harness(core)
      await expect(install(gateway, spec)).rejects.toMatchObject({ code: 'invalid-target' })
      expect(core.beginCalls).toHaveLength(0)
    },
  )

  it('parks the install, reports it from status, and settles it with the flat commit receipt', async () => {
    const parked = fakeParked()
    const core = fabricatedCore(async () => ({ kind: 'parked', install: parked }))
    const gateway = await harness(core)
    const before = await gateway.status()
    expect(before).toMatchObject({ mutations: 'enabled', plugins: [{ name: 'plugin-hello', state: 'active' }] })
    expect(before.parked).toBeUndefined()
    const outcome = await install(gateway)
    if (outcome.kind !== 'parked') throw new Error('unreachable arm')
    expect(outcome.preview).toMatchObject({ spec: SPEC, name: 'plugin-hello' })
    expect(outcome.transactionId).toMatch(/^[0-9a-f]{32}$/)
    expect(outcome.confirmToken).toMatch(/^[0-9a-f]{32}$/)
    expect((await gateway.status()).parked).toMatchObject({ transactionId: outcome.transactionId, preview: { spec: SPEC } })
    // A second install cannot start while one is parked.
    await expect(install(gateway, '/plugins/x')).rejects.toMatchObject({ code: 'transaction-pending' })
    // A wrong confirm token leaves the transaction parked and spendable.
    await expect(gateway.confirm({ token: '00000000000000000000000000000000' as PluginConfirmToken }))
      .rejects.toMatchObject({ code: 'confirm-mismatch' })
    expect(await gateway.confirm({ token: outcome.confirmToken }))
      .toEqual({ kind: 'committed', name: 'plugin-hello', version: '1.0.0', readiness: 'restart-required' })
    expect(parked.confirmCalls).toBe(1)
    expect((await gateway.status()).parked).toBeUndefined()
    // The spent token cannot settle anything again.
    await expect(gateway.confirm({ token: outcome.confirmToken })).rejects.toMatchObject({ code: 'no-parked-transaction' })
  })

  it('passes a core refusal and its rollback through and frees the slot', async () => {
    const core = fabricatedCore(async () => ({
      kind: 'refused',
      refusal: { code: 'needs-build', packages: ['native-dep'] },
      rollback: { filesRestored: true, reinstall: 'ok' },
    }))
    const gateway = await harness(core)
    expect(await install(gateway)).toEqual({
      kind: 'refused',
      refusal: { code: 'needs-build', packages: ['native-dep'] },
      rollback: { filesRestored: true, reinstall: 'ok' },
    })
    expect(await gateway.removePlugin({ token: gateway.begin({ verb: 'remove', target: 'plugin-hello' }).token, name: 'plugin-hello' }))
      .toEqual({ kind: 'removed', pnpm: 'ok' })
  })

  it('frees the slot when the core throws', async () => {
    const gateway = await harness(fabricatedCore(async () => { throw new Error('lock timed out') }))
    await expect(install(gateway)).rejects.toThrow(/lock timed out/)
    await expect(install(gateway)).rejects.toThrow(/lock timed out/)
  })

  it('cancels the parked transaction and passes the rollback report through', async () => {
    const parked = fakeParked()
    const gateway = await harness(fabricatedCore(async () => ({ kind: 'parked', install: parked })))
    const token = await parkedToken(gateway)
    expect(await gateway.cancel({ token })).toEqual({ filesRestored: true, reinstall: 'skipped' })
    expect(parked.cancelCalls).toBe(1)
    expect((await gateway.status()).parked).toBeUndefined()
  })

  it('refuses a plugin removal while an install transaction holds the profile', async () => {
    const core = fabricatedCore(async () => ({ kind: 'parked', install: fakeParked() }))
    const gateway = await harness(core)
    await parkedToken(gateway)
    await expect(gateway.removePlugin({ token: gateway.begin({ verb: 'remove', target: 'plugin-hello' }).token, name: 'plugin-hello' }))
      .rejects.toMatchObject({ code: 'transaction-pending' })
    expect(core.removeCalls).toHaveLength(0)
  })

  it('refuses a second settle while the first is still running', async () => {
    const parked = fakeParked()
    const confirming = gate()
    parked.confirmGate = confirming.promise
    const gateway = await harness(fabricatedCore(async () => ({ kind: 'parked', install: parked })))
    const token = await parkedToken(gateway)
    const confirmed = gateway.confirm({ token })
    await expect(gateway.cancel({ token })).rejects.toMatchObject({ code: 'transaction-pending' })
    confirming.open()
    expect(await confirmed).toMatchObject({ kind: 'committed' })
    expect(parked.cancelCalls).toBe(0)
  })

  it('auto-cancels the parked transaction when the configured confirm window expires', async () => {
    vi.useFakeTimers()
    const parked = fakeParked()
    const gateway = await harness(fabricatedCore(async () => ({ kind: 'parked', install: parked })), { confirmTtlMs: 1_000 })
    await parkedToken(gateway)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(parked.cancelCalls).toBe(1)
    expect((await gateway.status()).parked).toBeUndefined()
  })

  it('refuses a confirm that races an expiry rollback already in progress', async () => {
    vi.useFakeTimers()
    const parked = fakeParked()
    const rollingBack = gate()
    parked.cancelGate = rollingBack.promise
    const gateway = await harness(fabricatedCore(async () => ({ kind: 'parked', install: parked })), { confirmTtlMs: 1_000 })
    const token = await parkedToken(gateway)
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(gateway.confirm({ token })).rejects.toMatchObject({ code: 'transaction-pending' })
    rollingBack.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(parked.confirmCalls).toBe(0)
    expect(parked.cancelCalls).toBe(1)
  })

  it('answers unsupported for plugin mutations while skills stay enabled', async () => {
    const core = fabricatedCore()
    const gateway = await harness(core, { mutations: 'unsupported', skills: fakeSkills([]) })
    expect((await gateway.status()).mutations).toBe('unsupported')
    expect(await install(gateway)).toEqual({ kind: 'unsupported' })
    expect(core.beginCalls).toHaveLength(0)
    expect(await gateway.removePlugin({ token: gateway.begin({ verb: 'remove', target: 'plugin-hello' }).token, name: 'plugin-hello' }))
      .toEqual({ kind: 'unsupported' })
    expect(core.removeCalls).toHaveLength(0)
    const added = await gateway.skillAdd({ token: gateway.begin({ verb: 'skill-add', target: '/somewhere' }).token, path: '/somewhere' })
    expect(added).toEqual({ kind: 'installed', name: 'fix-docs', path: '/installed/fix-docs', digest: 'deadbeef' })
    expect(core.addCalls).toHaveLength(1)
  })

  it('mounts without a profile runtime and serves unsupported status plus skill operations', async () => {
    const core = fabricatedCore()
    const gateway = await harness(core, { mutations: null })
    expect(await gateway.status()).toEqual({ mutations: 'unsupported', plugins: [], skills: [] })
    expect(await install(gateway)).toEqual({ kind: 'unsupported' })
    expect(core.beginCalls).toHaveLength(0)
    const source = await skillSource()
    expect(await gateway.skillAdd({ token: gateway.begin({ verb: 'skill-add', target: source }).token, path: source }))
      .toMatchObject({ kind: 'installed', name: 'fix-docs' })
    expect(await gateway.skillRemove({ token: gateway.begin({ verb: 'skill-remove', target: 'fix-docs' }).token, name: 'fix-docs' }))
      .toEqual({ kind: 'removed' })
  })

  it('refuses a skill name a runtime skill already owns and reports shadowing in status', async () => {
    const core = fabricatedCore()
    const gateway = await harness(core, { skills: fakeSkills([{ name: 'fix-docs', source: 'runtime' }]) })
    const source = await skillSource()
    const outcome = await gateway.skillAdd({ token: gateway.begin({ verb: 'skill-add', target: source }).token, path: source })
    expect(outcome).toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'runtime' })
    expect(outcome.kind === 'refused' ? outcome.detail : '').toContain('runtime skill "fix-docs" is already live')
    expect(core.addCalls).toHaveLength(0)
    // The same relation is visible from status: the installed row is
    // shadowed while a same-named runtime skill is live.
    core.listResult = [{ name: 'fix-docs', description: 'fixes docs', digest: 'd', origin: source, installedAt: '2026-01-01T00:00:00.000Z' }]
    const status: PluginAdminStatusResult = await gateway.status()
    expect(status.skills).toEqual([
      { name: 'fix-docs', description: 'fixes docs', digest: 'd', origin: source, installedAt: '2026-01-01T00:00:00.000Z', shadowedBy: 'runtime' },
    ])
  })

  it('installs skills without a live-catalog owner and omits shadowing facts without a registry', async () => {
    const core = fabricatedCore()
    const gateway = await harness(core)
    const source = await skillSource()
    const outcome: SkillInstallOutcome = await gateway.skillAdd({ token: gateway.begin({ verb: 'skill-add', target: source }).token, path: source })
    expect(outcome).toMatchObject({ kind: 'installed', name: 'fix-docs' })
    core.listResult = [{ name: 'fix-docs', description: 'fixes docs', digest: 'd', origin: source, installedAt: '2026-01-01T00:00:00.000Z' }]
    expect((await gateway.status()).skills).toEqual([
      { name: 'fix-docs', description: 'fixes docs', digest: 'd', origin: source, installedAt: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('awaits the parked rollback on disposal', async () => {
    const parked = fakeParked()
    const rollingBack = gate()
    parked.cancelGate = rollingBack.promise
    const gateway = await harness(fabricatedCore(async () => ({ kind: 'parked', install: parked })))
    await parkedToken(gateway)
    let settled = false
    const disposal = contextOf(gateway).fiber.dispose().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    rollingBack.open()
    await disposal
    expect(parked.cancelCalls).toBe(1)
  })

  it('aborts a beginning install on disposal and rolls back what the core parks afterwards', async () => {
    const parked = fakeParked()
    const beginning = gate()
    const core = fabricatedCore(async (signal) => {
      await beginning.promise
      expect(signal.aborted).toBe(true)
      return { kind: 'parked', install: parked }
    })
    const gateway = await harness(core)
    const outcome = install(gateway)
    let settled = false
    const disposal = contextOf(gateway).fiber.dispose().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(core.beginCalls[0]?.signal.aborted).toBe(true)
    expect(settled).toBe(false)
    beginning.open()
    await disposal
    expect(parked.cancelCalls).toBe(1)
    expect(await outcome).toEqual({
      kind: 'refused',
      refusal: { code: 'declined' },
      rollback: { filesRestored: true, reinstall: 'skipped' },
    })
  })

  it('awaits an in-flight confirm on disposal instead of starting a second settle', async () => {
    const parked = fakeParked()
    const confirming = gate()
    parked.confirmGate = confirming.promise
    const gateway = await harness(fabricatedCore(async () => ({ kind: 'parked', install: parked })))
    const confirmed = gateway.confirm({ token: await parkedToken(gateway) })
    let settled = false
    const disposal = contextOf(gateway).fiber.dispose().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    confirming.open()
    await disposal
    expect(await confirmed).toMatchObject({ kind: 'committed' })
    expect(parked.cancelCalls).toBe(0)
  })

  it('aborts an outstanding removal on disposal and awaits it', async () => {
    const core = fabricatedCore()
    core.removePlugin = async (_profileDir, _name, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { reject(new Error('aborted by disposal')) })
      })
    const gateway = await harness(core)
    const removal = gateway.removePlugin({ token: gateway.begin({ verb: 'remove', target: 'plugin-hello' }).token, name: 'plugin-hello' })
    await contextOf(gateway).fiber.dispose()
    await expect(removal).rejects.toThrow(/aborted by disposal/)
  })

  it('logs, rather than drops, a rollback failure after the confirm window expires', async () => {
    vi.useFakeTimers()
    const parked = fakeParked()
    parked.cancel = async () => { throw new Error('restore failed') }
    const gateway = await harness(fabricatedCore(async () => ({ kind: 'parked', install: parked })), { confirmTtlMs: 1_000 })
    const warn = vi.spyOn(contextOf(gateway).logger, 'warn').mockImplementation(() => {})
    await parkedToken(gateway)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('restore failed'))
    expect((await gateway.status()).parked).toBeUndefined()
  })

  it('keeps a slot disposal cleared when the core refuses afterwards', async () => {
    const beginning = gate()
    const core = fabricatedCore(async () => {
      await beginning.promise
      return { kind: 'refused', refusal: { code: 'declined' }, rollback: { filesRestored: true, reinstall: 'skipped' } }
    })
    const gateway = await harness(core)
    const outcome = install(gateway)
    const disposal = contextOf(gateway).fiber.dispose()
    beginning.open()
    await disposal
    expect(await outcome).toMatchObject({ kind: 'refused', refusal: { code: 'declined' } })
  })

  it('reports no shadowing for installed skills without a same-named live skill', async () => {
    const core = fabricatedCore()
    const gateway = await harness(core, { skills: fakeSkills([{ name: 'other', source: 'runtime' }]) })
    core.listResult = [{ name: 'fix-docs', description: 'fixes docs', digest: 'd', origin: '/o', installedAt: '2026-01-01T00:00:00.000Z' }]
    expect((await gateway.status()).skills).toEqual([
      { name: 'fix-docs', description: 'fixes docs', digest: 'd', origin: '/o', installedAt: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('reads the declared skill name from a flat file or an alternate markdown file for the name check', async () => {
    const core = fabricatedCore()
    const gateway = await harness(core, { skills: fakeSkills([{ name: 'fix-docs', source: 'bundled' }]) })
    const dir = await mkdtemp(join(tmpdir(), 'shres-plugin-admin-flat-'))
    tempDirs.push(dir)
    const flat = join(dir, 'fix-docs.md')
    await writeFile(flat, '---\nname: fix-docs\ndescription: fixes docs\n---\nBody.\n')
    expect(await gateway.skillAdd({ token: gateway.begin({ verb: 'skill-add', target: flat }).token, path: flat }))
      .toMatchObject({ kind: 'refused', code: 'name-taken', owner: 'bundled' })
    // A directory without SKILL.md whose other markdown file declares the name.
    const alternate = join(dir, 'alternate')
    await mkdir(alternate)
    await writeFile(join(alternate, 'notes.txt'), 'not markdown')
    await writeFile(join(alternate, 'fix-docs.md'), '---\nname: fix-docs\ndescription: fixes docs\n---\nBody.\n')
    expect(await gateway.skillAdd({ token: gateway.begin({ verb: 'skill-add', target: alternate }).token, path: alternate }))
      .toMatchObject({ kind: 'refused', code: 'name-taken' })
    expect(core.addCalls).toHaveLength(0)
  })

  it('leaves the verdict to the core installer when no candidate document parses', async () => {
    const core = fabricatedCore()
    const gateway = await harness(core, { skills: fakeSkills([{ name: 'fix-docs', source: 'bundled' }]) })
    const dir = await mkdtemp(join(tmpdir(), 'shres-plugin-admin-invalid-'))
    tempDirs.push(dir)
    await writeFile(join(dir, 'SKILL.md'), 'no frontmatter')
    const missing = join(dir, 'missing')
    for (const path of [dir, missing]) {
      await gateway.skillAdd({ token: gateway.begin({ verb: 'skill-add', target: path }).token, path })
    }
    expect(core.addCalls.map(call => call.path)).toEqual([dir, missing])
  })
})

describe('nodePluginAdminCore', () => {
  it('forwards install and removal to the shared core, which refuses these requests before running pnpm', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'shres-plugin-admin-core-'))
    tempDirs.push(profileDir)
    const options = { signal: new AbortController().signal, invokingCwd: profileDir }
    expect(await nodePluginAdminCore.beginPluginInstall(profileDir, 'link:/somewhere/plugin', options))
      .toMatchObject({ kind: 'refused' })
    expect(await nodePluginAdminCore.removePlugin(profileDir, '@shres-code/shres-code-base', options))
      .toMatchObject({ kind: 'refused' })
  })
})
