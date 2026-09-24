import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@shres-code/cordis'
import {
  declareJudgmentConsumer,
  JudgmentEngineRegistry,
  judgmentConsumerId,
  judgmentEngineId,
  registerJudgmentEngine,
} from '../src/index.ts'
import type { JudgmentEngineEntry, JudgmentInput, JudgmentResult } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

/** An engine entry answering nothing, with or without fitting. */
function entry(id: string, fitting = false): JudgmentEngineEntry {
  const ask = (_input: JudgmentInput): Promise<JudgmentResult> =>
    Promise.resolve({ answers: [], engine: id, model: `${id}-1`, latencyMs: 0 })
  return {
    engine: fitting ? { ask, fitting: { ask: () => Promise.reject(new Error('unused')) } } : { ask },
    descriptor: { id: judgmentEngineId(id), label: id, egress: 'none', calibration: 'calibrated', supportsFitting: fitting },
    status: () => ({ state: 'ready' }),
  }
}

/** A registry that fails the test on a subscriber failure it reports. */
function registry(failures: unknown[] = []): JudgmentEngineRegistry {
  return new JudgmentEngineRegistry((error: unknown) => {
    failures.push(error)
  })
}

describe('JudgmentEngineRegistry', () => {
  it('lists descriptors in registration order and looks engines up by id', () => {
    const engines = registry()
    const alpha = entry('alpha')
    engines.register(judgmentEngineId('alpha'), alpha)
    engines.register(judgmentEngineId('beta'), entry('beta', true))

    expect(engines.list().map(descriptor => descriptor.id)).toEqual(['alpha', 'beta'])
    expect(engines.get(judgmentEngineId('alpha'))).toBe(alpha)
    expect(engines.get(judgmentEngineId('gamma'))).toBeUndefined()
  })

  it('rejects a descriptor whose fitting flag disagrees with the engine in either direction', () => {
    const engines = registry()
    const plain = entry('plain')
    const fitter = entry('fitter', true)

    expect(() => engines.register(judgmentEngineId('plain'), { ...plain, descriptor: { ...plain.descriptor, supportsFitting: true } }))
      .toThrow('judgment engine "plain" declares supportsFitting true but does not expose fitting')
    expect(() => engines.register(judgmentEngineId('fitter'), { ...fitter, descriptor: { ...fitter.descriptor, supportsFitting: false } }))
      .toThrow('judgment engine "fitter" declares supportsFitting false but exposes fitting')
    expect(engines.list()).toEqual([])
  })

  it('notifies on registration, status change, and removal, and goes quiet after removal', () => {
    const engines = registry()
    let notified = 0
    const unsubscribe = engines.subscribe(() => {
      notified += 1
    })
    const registration = engines.register(judgmentEngineId('alpha'), entry('alpha'))
    registration.statusChanged()
    registration()
    registration()
    registration.statusChanged()

    expect(notified).toBe(3)
    expect(engines.get(judgmentEngineId('alpha'))).toBeUndefined()

    unsubscribe()
    engines.register(judgmentEngineId('alpha'), entry('alpha'))
    expect(notified).toBe(3)
  })

  it('keeps one listener subscribed twice as two subscriptions', () => {
    const engines = registry()
    let notified = 0
    const listener = (): void => {
      notified += 1
    }
    const first = engines.subscribe(listener)
    engines.subscribe(listener)
    first()

    engines.register(judgmentEngineId('alpha'), entry('alpha'))

    expect(notified).toBe(1)
  })

  it('reports a throwing or rejecting subscriber and still notifies the next one', async () => {
    const failures: unknown[] = []
    const engines = registry(failures)
    const reached: string[] = []
    engines.subscribe(() => {
      throw new Error('sync')
    })
    engines.subscribe(() => Promise.reject(new Error('async')))
    engines.subscribe(() => {
      reached.push('last')
    })

    engines.register(judgmentEngineId('alpha'), entry('alpha'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(reached).toEqual(['last'])
    expect(failures.map(error => (error as Error).message)).toEqual(['sync', 'async'])
  })
})

describe('consumer declarations', () => {
  it('keeps an id declared until every declaration is disposed, notifying on the first and the last', () => {
    const engines = registry()
    let notified = 0
    engines.subscribe(() => {
      notified += 1
    })
    const first = engines.declareConsumer(judgmentConsumerId('worker-escalation'))
    const second = engines.declareConsumer(judgmentConsumerId('worker-escalation'))
    engines.declareConsumer(judgmentConsumerId('compaction-jev'))

    expect(engines.consumers()).toEqual(['worker-escalation', 'compaction-jev'])
    expect(notified).toBe(2)

    first()
    first()
    expect(engines.hasConsumer('worker-escalation')).toBe(true)
    expect(notified).toBe(2)

    second()
    expect(engines.hasConsumer('worker-escalation')).toBe(false)
    expect(engines.consumers()).toEqual(['compaction-jev'])
    expect(notified).toBe(3)
  })

  it('declareJudgmentConsumer declares while the registry is provided and releases with either fiber', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const engines = registry()
    const provider = await ctx.plugin({
      name: 'registry-provider',
      apply: (inner: Context) => {
        inner.provide('judgmentEngines', engines)
      },
    })
    const consumerFiber = await ctx.plugin({
      name: 'consumer',
      apply: (inner: Context) => {
        declareJudgmentConsumer(inner, judgmentConsumerId('judgment-guardrails'))
      },
    })
    await vi.waitFor(() => {
      expect(engines.hasConsumer('judgment-guardrails')).toBe(true)
    })

    await provider.dispose()
    expect(engines.hasConsumer('judgment-guardrails')).toBe(false)

    const replacement = registry()
    await ctx.plugin({
      name: 'registry-provider-2',
      apply: (inner: Context) => {
        inner.provide('judgmentEngines', replacement)
      },
    })
    await vi.waitFor(() => {
      expect(replacement.hasConsumer('judgment-guardrails')).toBe(true)
    })

    await consumerFiber.dispose()
    expect(replacement.hasConsumer('judgment-guardrails')).toBe(false)
  })

  it('declareJudgmentConsumer declares nothing where no registry is provided', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    await ctx.plugin({
      name: 'consumer',
      apply: (inner: Context) => {
        declareJudgmentConsumer(inner, judgmentConsumerId('worker-escalation'))
      },
    })

    expect(ctx.get('judgmentEngines')).toBeUndefined()
  })
})

describe('registerJudgmentEngine', () => {
  it('registers for the fiber lifetime and announces status only while registered', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const engines = registry()
    ctx.provide('judgmentEngines', engines)
    let notified = 0
    engines.subscribe(() => {
      notified += 1
    })
    let announce: (() => void) | undefined
    const fiber = await ctx.plugin({
      name: 'alpha-provider',
      inject: ['judgmentEngines'],
      apply: (inner: Context) => {
        announce = registerJudgmentEngine(inner, entry('alpha'))
      },
    })

    expect(engines.list().map(descriptor => descriptor.id)).toEqual(['alpha'])
    announce?.()
    expect(notified).toBe(2)

    await fiber.dispose()
    announce?.()

    expect(engines.list()).toEqual([])
    expect(notified).toBe(3)
  })
})

describe('id brands', () => {
  it('reject an empty engine or consumer id', () => {
    expect(() => judgmentEngineId('')).toThrow('judgment engine id must be non-empty')
    expect(() => judgmentConsumerId('')).toThrow('judgment consumer id must be non-empty')
    expect(judgmentEngineId('laya')).toBe('laya')
    expect(judgmentConsumerId('model-router')).toBe('model-router')
  })
})
