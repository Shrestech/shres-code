import type {
  LlmCallConfig,
  LlmResolvedModelInfo,
  LlmRuntime,
  LlmThinkingMode,
  Message,
  ModelModality,
  HostedTool,
} from '@shres-code/shres-code-llm'
import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import { describe, expect, it, vi } from 'vitest'
import { assessModelRoutingCandidates } from '../src/eligibility.ts'
import type { ModelRoutingCandidate } from '../src/types.ts'

const BASE: LlmCallConfig = {
  provider: 'manual',
  model: 'strong',
  maxTokens: 100,
}

interface ModelOverrides {
  contextWindow?: number
  inputModalities?: readonly ModelModality[]
  hostedTools?: readonly HostedTool[]
  defaultMaxTokens?: number
  thinkingMode?: LlmThinkingMode
}

function model(
  provider: string,
  id: string,
  overrides: ModelOverrides = {},
): LlmResolvedModelInfo {
  return {
    provider,
    id,
    name: id,
    ...overrides.contextWindow === undefined ? {} : { context: { contextWindow: overrides.contextWindow } },
    ...overrides.inputModalities === undefined ? {} : { inputModalities: overrides.inputModalities },
    ...overrides.hostedTools === undefined ? {} : { hostedTools: overrides.hostedTools },
    ...overrides.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: overrides.defaultMaxTokens },
    ...overrides.thinkingMode === undefined ? {} : { thinkingMode: overrides.thinkingMode },
  }
}

function candidate(id: string, overrides: Partial<ModelRoutingCandidate> = {}): ModelRoutingCandidate {
  return {
    id,
    provider: `${id}-provider`,
    model: `${id}-model`,
    description: `the ${id} test candidate`,
    ...overrides,
  }
}

interface RuntimeOptions {
  models: readonly LlmResolvedModelInfo[]
  prepareFailure?: (config: LlmCallConfig) => Error | undefined
  resolveFailure?: (provider: string, model: string) => unknown
}

function fakeRuntime(options: RuntimeOptions): {
  runtime: LlmRuntime
  prepareCall: ReturnType<typeof vi.fn>
  resolveModelInfo: ReturnType<typeof vi.fn>
  configs: LlmCallConfig[]
  streams: ReturnType<typeof vi.fn>[]
} {
  const byKey = new Map(options.models.map(info => [`${info.provider}/${info.id}`, info]))
  const configs: LlmCallConfig[] = []
  const streams: ReturnType<typeof vi.fn>[] = []
  const resolveModelInfo = vi.fn(async (provider: string, id: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const failure = options.resolveFailure?.(provider, id)
    if (failure !== undefined) throw failure
    const info = byKey.get(`${provider}/${id}`)
    if (info === undefined) throw new Error(`missing model ${provider}/${id}`)
    return info
  })
  const prepareCall = vi.fn(async (config: LlmCallConfig, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    configs.push(config)
    const failure = options.prepareFailure?.(config)
    if (failure !== undefined) throw failure
    const info = byKey.get(`${config.provider}/${config.model}`)
    if (info === undefined) throw new Error(`missing model ${config.provider}/${config.model}`)
    const stream = vi.fn()
    streams.push(stream)
    return {
      config: {
        ...config,
        ...config.maxTokens === undefined && info.defaultMaxTokens !== undefined
          ? { maxTokens: info.defaultMaxTokens }
          : {},
      },
      context: info.context,
      adapterDefaults: {},
      stream,
    }
  })
  return {
    runtime: { resolveModelInfo, prepareCall } as unknown as LlmRuntime,
    prepareCall,
    resolveModelInfo,
    configs,
    streams,
  }
}

function messageWithContent(content: unknown[]): Message {
  return { content } as unknown as Message
}

describe('assessModelRoutingCandidates', () => {
  it('keeps configuration order, validates the lift, and never dispatches', async () => {
    const configured = [candidate('cheap'), candidate('mid')]
    const { runtime, configs, streams } = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000 }),
        model('cheap-provider', 'cheap-model', { contextWindow: 2_000 }),
        model('mid-provider', 'mid-model', { contextWindow: 2_000 }),
      ],
    })

    const result = await assessModelRoutingCandidates(
      runtime,
      BASE,
      [],
      configured,
      { scoreThreshold: 3, reasoningEffort: 'high' },
    )

    expect(result.requirements).toEqual({
      requiresImage: false,
      provider: 'manual',
      model: 'strong',
      contextWindow: 1_000,
    })
    expect(result.candidates).toBe(configured)
    expect(result.eligibleCandidates).toEqual(configured)
    expect(result.assessments).toEqual([
      expect.objectContaining({ id: 'cheap', reason: 'eligible', difficultyReasoningEffort: 'high' }),
      expect.objectContaining({ id: 'mid', reason: 'eligible', difficultyReasoningEffort: 'high' }),
    ])
    expect(configs.map(config => ({
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort === undefined ? undefined : String(config.reasoningEffort),
    }))).toEqual([
      { provider: 'manual', model: 'strong', reasoningEffort: undefined },
      { provider: 'cheap-provider', model: 'cheap-model', reasoningEffort: undefined },
      { provider: 'cheap-provider', model: 'cheap-model', reasoningEffort: 'high' },
      { provider: 'mid-provider', model: 'mid-model', reasoningEffort: undefined },
      { provider: 'mid-provider', model: 'mid-model', reasoningEffort: 'high' },
    ])
    expect(streams.every(stream => stream.mock.calls.length === 0)).toBe(true)
    expect(JSON.stringify(result.assessments)).not.toContain('messages')
  })

  it('excludes a candidate equal to the manual provider/model with reason equals-base', async () => {
    const configured = [candidate('same', { provider: 'manual', model: 'strong' }), candidate('cheap')]
    const { runtime, resolveModelInfo } = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000 }),
        model('cheap-provider', 'cheap-model', { contextWindow: 2_000 }),
      ],
    })

    const result = await assessModelRoutingCandidates(runtime, BASE, [], configured)

    expect(result.eligibleCandidates).toEqual([configured[1]])
    expect(result.assessments).toEqual([
      { id: 'same', provider: 'manual', model: 'strong', reason: 'equals-base' },
      expect.objectContaining({ id: 'cheap', reason: 'eligible' }),
    ])
    // The identity comparison needs no candidate metadata: only the manual route
    // and the other candidate are resolved.
    expect(resolveModelInfo.mock.calls.map(call => `${String(call[0])}/${String(call[1])}`))
      .toEqual(['manual/strong', 'cheap-provider/cheap-model'])
  })

  it('excludes routing under a budget-thinking Anthropic base', async () => {
    const configured = [candidate('same', { provider: 'manual', model: 'strong' }), candidate('cheap')]
    const { runtime, resolveModelInfo } = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000, thinkingMode: 'budget' }),
        model('cheap-provider', 'cheap-model', { contextWindow: 2_000 }),
      ],
    })

    const result = await assessModelRoutingCandidates(runtime, { ...BASE, reasoningEffort: ReasoningEffortId('high') }, [], configured)

    expect(result.requirements).toMatchObject({ thinkingMode: 'budget' })
    expect(result.eligibleCandidates).toEqual([])
    expect(result.assessments).toEqual([
      { id: 'same', provider: 'manual', model: 'strong', reason: 'equals-base' },
      { id: 'cheap', provider: 'cheap-provider', model: 'cheap-model', reason: 'thinking-mode-incompatible' },
    ])
    // The base property excludes candidates without looking them up.
    expect(resolveModelInfo.mock.calls.map(call => `${String(call[0])}/${String(call[1])}`)).toEqual(['manual/strong'])
  })

  it('keeps routing under a budget-thinking base with reasoning off or unset, and under an adaptive base', async () => {
    const cases: [LlmThinkingMode, LlmCallConfig][] = [
      ['budget', BASE],
      ['budget', { ...BASE, reasoningEffort: ReasoningEffortId('off') }],
      ['adaptive', { ...BASE, reasoningEffort: ReasoningEffortId('high') }],
      ['none', { ...BASE, reasoningEffort: ReasoningEffortId('high') }],
    ]
    for (const [thinkingMode, base] of cases) {
      const { runtime } = fakeRuntime({
        models: [
          model('manual', 'strong', { contextWindow: 1_000, thinkingMode }),
          model('cheap-provider', 'cheap-model', { contextWindow: 2_000 }),
        ],
      })
      const result = await assessModelRoutingCandidates(runtime, base, [], [candidate('cheap')])
      expect(result.assessments.map(assessment => assessment.reason)).toEqual(['eligible'])
      expect(result.requirements.thinkingMode).toBe(thinkingMode)
    }
  })

  it('excludes a same-model different-effort candidate as equals-base', async () => {
    const configured = [candidate('lower', { provider: 'manual', model: 'strong', reasoningEffort: ReasoningEffortId('low') })]
    const { runtime } = fakeRuntime({ models: [model('manual', 'strong', { contextWindow: 1_000 })] })

    const result = await assessModelRoutingCandidates(
      runtime,
      { ...BASE, reasoningEffort: ReasoningEffortId('high') },
      [],
      configured,
    )

    expect(result.eligibleCandidates).toEqual([])
    expect(result.assessments).toEqual([
      { id: 'lower', provider: 'manual', model: 'strong', reasoningEffort: 'low', reason: 'equals-base' },
    ])
  })

  it('requires declared image capability, including nested tool-result images', async () => {
    const configured = [candidate('unknown'), candidate('text'), candidate('vision')]
    const nestedImage = messageWithContent([{
      type: 'tool-result',
      content: [{ type: 'image' }],
    }])
    const { runtime } = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000 }),
        model('unknown-provider', 'unknown-model', { contextWindow: 2_000 }),
        model('text-provider', 'text-model', { contextWindow: 2_000, inputModalities: ['text'] }),
        model('vision-provider', 'vision-model', { contextWindow: 2_000, inputModalities: ['text', 'image'] }),
      ],
    })

    const result = await assessModelRoutingCandidates(runtime, BASE, [nestedImage], configured)

    expect(result.requirements).toMatchObject({
      requiresImage: true,
      provider: 'manual',
      model: 'strong',
      contextWindow: 1_000,
    })
    expect(result.eligibleCandidates).toEqual([configured[2]])
    expect(result.assessments.map(assessment => assessment.reason)).toEqual([
      'image-capability-unknown',
      'image-incompatible',
      'eligible',
    ])
  })

  it('requires a known context that covers the manual route and output cap', async () => {
    const configured = [candidate('unknown'), candidate('small'), candidate('maxed'), candidate('wide')]
    const baseWithoutExplicitMaxTokens: LlmCallConfig = { provider: 'manual', model: 'strong' }
    const { runtime } = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000 }),
        model('unknown-provider', 'unknown-model'),
        model('small-provider', 'small-model', { contextWindow: 999 }),
        model('maxed-provider', 'maxed-model', { contextWindow: 1_000, defaultMaxTokens: 1_000 }),
        model('wide-provider', 'wide-model', { contextWindow: 1_001 }),
      ],
    })

    const result = await assessModelRoutingCandidates(runtime, baseWithoutExplicitMaxTokens, [], configured)

    expect(result.requirements).toMatchObject({
      requiresImage: false,
      provider: 'manual',
      model: 'strong',
      contextWindow: 1_000,
    })
    expect(result.eligibleCandidates).toEqual([configured[3]])
    expect(result.assessments.map(assessment => assessment.reason)).toEqual([
      'context-unknown',
      'context-too-small',
      'max-tokens-exceeds-context',
      'eligible',
    ])
    expect(result.assessments[2]).toMatchObject({ contextWindow: 1_000, effectiveMaxTokens: 1_000 })
  })

  it('uses manual hosted-tool declarations as a floor without inferring local tools', async () => {
    const configured = [candidate('unknown'), candidate('wrong'), candidate('right')]
    const { runtime } = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000, hostedTools: ['web_search'] }),
        model('unknown-provider', 'unknown-model', { contextWindow: 2_000 }),
        model('wrong-provider', 'wrong-model', { contextWindow: 2_000, hostedTools: ['x_search'] }),
        model('right-provider', 'right-model', { contextWindow: 2_000, hostedTools: ['web_search', 'x_search'] }),
      ],
    })

    const result = await assessModelRoutingCandidates(runtime, BASE, [], configured)

    expect(result.requirements).toMatchObject({
      hostedTools: ['web_search'],
      contextWindow: 1_000,
    })
    expect(result.eligibleCandidates).toEqual([configured[2]])
    expect(result.assessments.map(assessment => assessment.reason)).toEqual([
      'hosted-tools-incompatible',
      'hosted-tools-incompatible',
      'eligible',
    ])

    const noFloor = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000 }),
        model('cheap-provider', 'cheap-model', { contextWindow: 2_000 }),
      ],
    })
    const localToolMessage = messageWithContent([{ type: 'tool-call' }])
    const withoutFloor = await assessModelRoutingCandidates(
      noFloor.runtime,
      BASE,
      [localToolMessage],
      [candidate('cheap')],
    )
    expect(withoutFloor.eligibleCandidates).toEqual([expect.objectContaining({ id: 'cheap' })])
  })

  it('classifies unavailable and invalid candidates without exposing provider errors', async () => {
    const configured = [
      candidate('missing'),
      candidate('malformed'),
      candidate('nonobject'),
      candidate('unsupported', { reasoningEffort: ReasoningEffortId('bogus') }),
      candidate('lift'),
    ]
    const secret = 'provider secret should stay out of the assessment'
    const { runtime } = fakeRuntime({
      models: [
        model('manual', 'strong', { contextWindow: 1_000 }),
        model('malformed-provider', 'malformed-model', { contextWindow: 2_000 }),
        model('nonobject-provider', 'nonobject-model', { contextWindow: 2_000 }),
        model('unsupported-provider', 'unsupported-model', { contextWindow: 2_000 }),
        model('lift-provider', 'lift-model', { contextWindow: 2_000 }),
      ],
      prepareFailure: config => config.reasoningEffort === 'bogus' || config.reasoningEffort === 'high'
        ? new Error(secret)
        : undefined,
      resolveFailure: provider => provider === 'malformed-provider'
        ? { code: 'INVALID_MODEL_INFO' }
        : provider === 'nonobject-provider'
          ? 'transport failure'
          : undefined,
    })

    const result = await assessModelRoutingCandidates(
      runtime,
      BASE,
      [],
      configured,
      { scoreThreshold: 3, reasoningEffort: 'high' },
    )

    expect(result.eligibleCandidates).toEqual([])
    expect(result.requirements).toMatchObject({
      requiresImage: false,
      provider: 'manual',
      model: 'strong',
      contextWindow: 1_000,
    })
    expect(result.assessments.map(assessment => assessment.reason)).toEqual([
      'candidate-unavailable',
      'candidate-invalid',
      'candidate-unavailable',
      'candidate-invalid',
      'difficulty-effort-invalid',
    ])
    expect(JSON.stringify(result.assessments)).not.toContain(secret)
  })

  it('excludes every candidate when the manual context window is unknown', async () => {
    const configured = [candidate('cheap')]
    const { runtime } = fakeRuntime({
      models: [
        model('manual', 'strong'),
        model('cheap-provider', 'cheap-model', { contextWindow: 2_000 }),
      ],
    })

    const result = await assessModelRoutingCandidates(runtime, BASE, [], configured)

    expect(result.requirements).toEqual({ requiresImage: false, provider: 'manual', model: 'strong' })
    expect(result.eligibleCandidates).toEqual([])
    expect(result.assessments).toEqual([
      expect.objectContaining({ id: 'cheap', reason: 'base-context-unknown' }),
    ])
  })

  it('marks every candidate ineligible when the base route is unavailable', async () => {
    const configured = [candidate('cheap'), candidate('mid')]
    const { runtime, resolveModelInfo } = fakeRuntime({
      models: [],
      resolveFailure: (provider, modelId) => provider === BASE.provider && modelId === BASE.model
        ? new Error('base credential')
        : undefined,
    })

    const result = await assessModelRoutingCandidates(runtime, BASE, [], configured)

    expect(result.eligibleCandidates).toEqual([])
    expect(result.requirements).toEqual({ requiresImage: false })
    expect(result.assessments.map(assessment => assessment.reason)).toEqual([
      'base-unavailable',
      'base-unavailable',
    ])
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation from a candidate lookup', async () => {
    const abort = new DOMException('cancelled', 'AbortError')
    const configured = [candidate('cheap')]
    const { runtime } = fakeRuntime({
      models: [model('manual', 'strong', { contextWindow: 1_000 })],
      resolveFailure: provider => provider === 'cheap-provider' ? abort : undefined,
    })

    await expect(assessModelRoutingCandidates(runtime, BASE, [], configured)).rejects.toBe(abort)
  })
})
