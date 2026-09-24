import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import JudgmentService, { JUDGMENT_SETTINGS_NAMESPACE, judgmentEnabled } from '../src/index.ts'
import type { JudgmentInput, JudgmentResult } from '../src/index.ts'

/** Engine stub: this suite covers the settings namespace each mount installs. */
class StubJudgment extends JudgmentService {
  override ask(_input: JudgmentInput): Promise<JudgmentResult> {
    return Promise.resolve({ answers: [], engine: 'stub', model: 'stub-1', latencyMs: 0 })
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** One context with the real file-backed settings provider and one engine mount. */
async function boot(): Promise<{
  ctx: Context
  settings: Awaited<ReturnType<Context['plugin']>>
  engine: Awaited<ReturnType<Context['plugin']>>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-judgment-settings-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  const settings = await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  const engine = await ctx.plugin(StubJudgment)
  return { ctx, settings, engine }
}

describe('the judgment settings namespace', () => {
  it('resolves enabled from the composition default without a settings service', async () => {
    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
    })
    await ctx.plugin(StubJudgment)

    expect(ctx.get('settings')).toBeUndefined()
    expect(ctx.judgment.settings()).toEqual({ enabled: true })
    expect(judgmentEnabled(ctx.judgment.settings)).toBe(true)
  })

  it('registers the section with the mounting engine fiber', async () => {
    const { ctx, engine } = await boot()

    expect(ctx.settings.get(JUDGMENT_SETTINGS_NAMESPACE)).toEqual({ enabled: true })
    await engine.dispose()
    expect(ctx.get('judgment')).toBeUndefined()
    expect(ctx.settings.get(JUDGMENT_SETTINGS_NAMESPACE)).toBeUndefined()
  })

  it('follows a stored user layer through the same live source', async () => {
    const { ctx } = await boot()
    const source = ctx.judgment.settings

    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    expect(source()).toEqual({ enabled: false })
    expect(judgmentEnabled(source)).toBe(false)

    // The composition default is the base layer, so clearing the user layer
    // restores it without touching the registration.
    await ctx.settings.replace(JUDGMENT_SETTINGS_NAMESPACE, {})
    expect(judgmentEnabled(source)).toBe(true)
  })

  it('rejects a value its schema cannot resolve', async () => {
    const { ctx } = await boot()

    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { enabled: 'yes' })).rejects.toThrow()
    expect(judgmentEnabled(ctx.judgment.settings)).toBe(true)
  })

  it('rejects an engine id that is empty or written without a value, naming the field', async () => {
    const { ctx } = await boot()

    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: '' }))
      .rejects.toThrow('judgment: engine must name an engine id')
    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: null }))
      .rejects.toThrow('judgment: engine must name an engine id')
    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { 'model-router': null } }))
      .rejects.toThrow('judgment: overrides.model-router must name an engine id')
    await expect(ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { overrides: { '': 'laya' } }))
      .rejects.toThrow('judgment: overrides keys must name a consumer id')
    expect(ctx.judgment.settings()).toEqual({ enabled: true })
  })

  it('accepts a valueless overrides key as no overrides', async () => {
    const { ctx } = await boot()

    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { engine: 'laya', overrides: null })

    expect(ctx.judgment.settings()).toEqual({ enabled: true, engine: 'laya', overrides: null })
  })

  it('falls back to the composition default when the settings service detaches', async () => {
    const { ctx, settings } = await boot()
    await ctx.settings.update(JUDGMENT_SETTINGS_NAMESPACE, { enabled: false })
    expect(judgmentEnabled(ctx.judgment.settings)).toBe(false)

    await settings.dispose()
    expect(ctx.get('settings')).toBeUndefined()
    expect(judgmentEnabled(ctx.judgment.settings)).toBe(true)
  })
})
