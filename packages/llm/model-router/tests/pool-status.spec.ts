/**
 * The `model-router` settings section as a configuration surface edits it:
 * shape errors name their field path, the write-time registered-route check
 * runs only on writes and only for entries a write adds or changes, and the
 * `poolStatus` read reports each pool model with the router's own
 * eligibility result from every `routeFrom` base.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@shres-code/cordis'
import type { LlmCallConfig, LlmProviderInfo, LlmResolvedModelInfo } from '@shres-code/shres-code-llm'
import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import { SettingsFieldError } from '@shres-code/shres-code-settings'
import { FileSettingsProvider } from '@shres-code/shres-code-settings-file'
import { remoteMethods } from '@shres-code/shres-code-typert-protocol'
import ModelRoutingController, { MODEL_ROUTER_SETTINGS_NAMESPACE } from '../src/index.ts'
import type { ModelRouterConfig } from '../src/config.ts'

const OPUS = { provider: 'claude-session', model: 'claude-opus-5-5' }
const FLASH = { provider: 'ollama-cloud', model: 'deepseek-v4.1-flash:cloud' }
const GLM = { provider: 'zai', model: 'glm-5.3' }

const CONFIG: ModelRouterConfig = {
  initialMode: 'off',
  candidates: [
    { id: 'flash', ...FLASH, description: 'small, well-scoped edits in familiar code' },
    { id: 'glm', ...GLM, reasoningEffort: 'high', description: 'mid-size refactors' },
  ],
  routeFrom: [{ ...OPUS, objective: 'quota', allowEveryTurn: true }],
  downgradeThreshold: 0.8,
  downgradeMargin: 0.1,
  routeInstructions: 'Pick the cheapest route that can finish this turn.',
  difficultyInstructions: 'Rate how much reasoning this turn needs.',
}

/** A stand-in llm runtime: registered providers and each model's declared facts. */
class FakeLlm extends Service {
  readonly models = new Map<string, LlmResolvedModelInfo>()

  constructor(ctx: Context, readonly providers: string[], models: LlmResolvedModelInfo[]) {
    super(ctx, 'llm')
    for (const model of models) this.models.set(`${model.provider}/${model.id}`, model)
  }

  listProviders(): LlmProviderInfo[] {
    return this.providers.map(id => ({ id, name: id }))
  }

  resolveModelInfo(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = this.models.get(`${provider}/${model}`)
    return info === undefined ? Promise.reject(new Error(`no model ${provider}/${model}`)) : Promise.resolve(info)
  }

  prepareCall(config: LlmCallConfig): Promise<{ config: LlmCallConfig }> {
    return this.resolveModelInfo(config.provider, config.model).then(() => ({ config }))
  }
}

const MODELS: LlmResolvedModelInfo[] = [
  { ...OPUS, id: OPUS.model, name: 'Opus', context: { contextWindow: 1_000_000 }, cacheUsage: 'reported' },
  {
    ...FLASH, id: FLASH.model, name: 'Flash', context: { contextWindow: 1_000_000 }, inputModalities: ['text'],
    reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }] },
  },
  { ...GLM, id: GLM.model, name: 'GLM', context: { contextWindow: 200_000 }, cacheUsage: 'unreported' },
]

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A router over a file settings provider, with a stand-in llm runtime unless `llm` is false. */
async function setup(options: { config?: ModelRouterConfig; providers?: string[]; llm?: boolean } = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'shres-model-router-pool-'))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FileSettingsProvider, { path: join(root, 'settings.yaml'), watch: false })
  const providers = options.providers ?? [OPUS.provider, FLASH.provider, GLM.provider]
  if (options.llm !== false) ctx.plugin({ apply: (inner: Context) => { new FakeLlm(inner, providers, MODELS) } })
  await ctx.plugin(ModelRoutingController, options.config ?? CONFIG)
  return ctx
}

/** The router's section as a configuration surface reads it. */
function section(ctx: Context): ModelRouterConfig {
  return ctx.settings.get(MODEL_ROUTER_SETTINGS_NAMESPACE) as ModelRouterConfig
}

/**
 * Write the section's pool and routeFrom lists wholesale, as the editor does:
 * a settings op path names object keys, so a list is written as a whole.
 * @param ctx - the root context.
 * @param changes - the lists to write.
 * @returns the settled write.
 */
function write(ctx: Context, changes: Pick<ModelRouterConfig, 'candidates' | 'routeFrom'>): Promise<unknown> {
  return ctx.settings.mutate(MODEL_ROUTER_SETTINGS_NAMESPACE, Object.entries(changes).map(([key, value]) => ({ op: 'set' as const, path: [key], value })))
}

/** The current pool with one entry replaced or appended. */
function pool(ctx: Context, index: number, entry: Partial<NonNullable<ModelRouterConfig['candidates']>[number]>): NonNullable<ModelRouterConfig['candidates']> {
  const current = [...section(ctx).candidates ?? []]
  current[index] = { ...current[index], ...entry } as NonNullable<ModelRouterConfig['candidates']>[number]
  return current
}

/** Commit a document the settings provider observed in storage, as a file reload does. */
function reload(ctx: Context, doc: Record<string, unknown>): void {
  ;(ctx.settings as unknown as { publish(document: Record<string, unknown>): void }).publish(doc)
}

describe('poolStatus', () => {
  it('is published on the modelRouting Remote namespace', async () => {
    const ctx = await setup()
    expect(remoteMethods(ctx.modelRouting).map(marker => marker.exportName ?? marker.method)).toContain('poolStatus')
  })

  it('reports each pool model with its declared facts and the router\'s eligibility from every base', async () => {
    const ctx = await setup({ config: {
      ...CONFIG,
      candidates: [...CONFIG.candidates!, { id: 'opus', ...OPUS, description: 'the strong model itself' }],
    } })
    const status = await ctx.modelRouting.poolStatus()
    expect(status.routeFrom).toEqual([{ ...OPUS, objective: 'quota', allowEveryTurn: true, registered: true, contextWindow: 1_000_000 }])
    expect(status.candidates).toEqual([
      {
        id: 'flash', ...FLASH, description: 'small, well-scoped edits in familiar code', registered: true,
        contextWindow: 1_000_000, inputModalities: ['text'], efforts: ['low', 'high'], alsoRouteFrom: false,
        eligibility: [{ ...OPUS, reason: 'eligible' }],
      },
      {
        id: 'glm', ...GLM, reasoningEffort: 'high', description: 'mid-size refactors', registered: true,
        contextWindow: 200_000, cacheUsage: 'unreported', alsoRouteFrom: false,
        eligibility: [{ ...OPUS, reason: 'context-too-small' }],
      },
      {
        id: 'opus', ...OPUS, description: 'the strong model itself', registered: true,
        contextWindow: 1_000_000, cacheUsage: 'reported', alsoRouteFrom: true,
        eligibility: [{ ...OPUS, reason: 'equals-base' }],
      },
    ])
  })

  it('reports an unregistered route, a model its adapter cannot describe, and no eligibility without routeFrom', async () => {
    const ctx = await setup({ providers: [FLASH.provider], config: {
      ...CONFIG,
      candidates: [
        { id: 'flash', ...FLASH, model: 'retired-model', description: 'a model the route no longer serves' },
        { id: 'glm', ...GLM, description: 'mid-size refactors' },
      ],
      routeFrom: [],
    } })
    const status = await ctx.modelRouting.poolStatus()
    expect(status.routeFrom).toEqual([])
    expect(status.candidates.map(candidate => [candidate.id, candidate.registered, candidate.contextWindow, candidate.eligibility]))
      .toEqual([['flash', true, undefined, []], ['glm', false, undefined, []]])
  })

  it('reports every route unregistered and no eligibility when no llm runtime is composed', async () => {
    const ctx = await setup({ llm: false })
    const status = await ctx.modelRouting.poolStatus()
    expect(status.routeFrom.map(base => base.registered)).toEqual([false])
    expect(status.candidates.map(candidate => [candidate.registered, candidate.eligibility])).toEqual([[false, []], [false, []]])
  })
})

describe('the model-router section as the pool editor writes it', () => {
  it('names the field path of a shape error in a written section', async () => {
    const ctx = await setup()
    const long = 'x'.repeat(161)
    // The schema refuses an over-long description itself; its failure carries the path the wire reports.
    await expect(write(ctx, { candidates: pool(ctx, 1, { description: long }) }))
      .rejects.toMatchObject({ name: 'ValidationError', options: { path: ['candidates', 1, 'description'] } })
    // The resolver names what the schema cannot express, as a SettingsFieldError at the field.
    await expect(write(ctx, { candidates: pool(ctx, 1, { id: 'keep-current' }) }))
      .rejects.toMatchObject({ path: ['candidates', 1, 'id'], message: 'ModelRouterConfig.candidates["keep-current"].id is reserved for the keep-current route option' })
    // A quota route without allowEveryTurn is valid: the cold-point entry policy replaced per-turn entry.
    await write(ctx, { routeFrom: [{ ...OPUS, objective: 'quota', allowEveryTurn: false }] })
    await expect(write(ctx, { routeFrom: [{ ...OPUS, objective: 'latency' }] }))
      .rejects.toMatchObject({ path: ['routeFrom', 0, 'objective'], message: expect.stringContaining('judgmentDeadlineMs of at most 200') as unknown })
    await expect(write(ctx, { candidates: pool(ctx, 1, { id: 'flash' }) }))
      .rejects.toMatchObject({ path: ['candidates', 1, 'id'], message: 'ModelRouterConfig.candidates lists "flash" more than once' })
    // An empty routeFrom is valid while routing starts off.
    await write(ctx, { routeFrom: [] })
    expect(section(ctx).routeFrom).toEqual([])
    expect(section(ctx).candidates?.[1]?.description).toBe('mid-size refactors')
  })

  it('refuses a written pool model or routeFrom entry whose provider route the llm runtime does not register', async () => {
    const ctx = await setup()
    const refusal = await write(ctx, { candidates: pool(ctx, 2, { id: 'typo', provider: 'olama-cloud', model: 'm', description: 'a typo in the route' }) })
      .then(() => undefined, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(SettingsFieldError)
    expect(refusal).toMatchObject({
      path: ['candidates', 2, 'provider'],
      message: 'ModelRouterConfig.candidates["typo"].provider "olama-cloud" is not a registered route',
    })
    await expect(write(ctx, { routeFrom: [{ ...OPUS, objective: 'quota', allowEveryTurn: true }, { provider: 'nope', model: 'big', objective: 'dollars' }] }))
      .rejects.toMatchObject({
        path: ['routeFrom', 1, 'provider'],
        message: 'ModelRouterConfig.routeFrom["nope/big"].provider "nope" is not a registered route',
      })
    // The pool is unchanged.
    expect(section(ctx).candidates?.map(candidate => candidate.id)).toEqual(['flash', 'glm'])
    // A registered route with a model its catalog does not list is accepted: catalogs are advisory.
    await write(ctx, { candidates: pool(ctx, 2, { id: 'new', ...FLASH, model: 'unlisted', description: 'a newer model' }) })
    expect(section(ctx).candidates?.map(candidate => candidate.id)).toEqual(['flash', 'glm', 'new'])
  })

  it('checks only entries the write adds or changes, and never a reloaded section', async () => {
    const ctx = await setup({ providers: [OPUS.provider, FLASH.provider, GLM.provider] })
    // A reload is not checked: the route may be registered later.
    reload(ctx, { 'model-router': { candidates: [{ id: 'later', provider: 'later-route', model: 'm', description: 'registered later' }] } })
    expect(section(ctx).candidates?.map(candidate => candidate.provider)).toEqual(['later-route'])
    // An edit that keeps that entry's route is not re-judged.
    await write(ctx, { candidates: pool(ctx, 0, { description: 'still later' }) })
    expect(section(ctx).candidates?.[0]?.description).toBe('still later')
    // Changing its model is a change, and is checked.
    await expect(write(ctx, { candidates: pool(ctx, 0, { model: 'm2' }) }))
      .rejects.toMatchObject({ path: ['candidates', 0, 'provider'] })
    reload(ctx, { 'model-router': { routeFrom: [{ provider: 'later-route', model: 'big', objective: 'dollars' }] } })
    await write(ctx, { routeFrom: [{ provider: 'later-route', model: 'big', objective: 'dollars', allowEveryTurn: true }] })
    expect(section(ctx).routeFrom?.[0]).toMatchObject({ provider: 'later-route', allowEveryTurn: true })
  })

  it('refuses every added route when no llm runtime is composed', async () => {
    const ctx = await setup({ llm: false })
    await expect(write(ctx, { candidates: pool(ctx, 2, { id: 'more', provider: 'zai', model: 'glm-6', description: 'another' }) }))
      .rejects.toMatchObject({ path: ['candidates', 2, 'provider'] })
    void vi
  })
})
