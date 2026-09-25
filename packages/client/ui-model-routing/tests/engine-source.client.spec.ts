/**
 * The judgment engine facts source and the router's judge: the source reads
 * the `judgmentEngines` snapshot, keeps the latest of overlapping reads,
 * reports an absent dispatcher and other failures, and stops publishing when
 * disposed; the judge follows the dispatcher's rule, where a consumer
 * override applies only while that consumer is declared.
 */
import { describe, expect, it, vi } from 'vitest'
import type { JudgmentConsumerId } from '@shres-code/shres-code-api-remotes/client'
import {
  createRoutingEngineSource, engineEgress, MODEL_ROUTER_CONSUMER, routingJudge,
  type EngineSnapshotResult, type RoutingEngineState,
} from '../src/client/engine-source.ts'
import { engines, LOCAL, REMOTE } from './fixtures/engines.client.ts'

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('createRoutingEngineSource', () => {
  it('starts loading, then publishes the snapshot to subscribers', async () => {
    const source = createRoutingEngineSource(() => Promise.resolve({ ok: true, value: engines('laya') }))
    expect(source.getSnapshot()).toEqual({ kind: 'loading' })
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    source.refresh()
    await flush()
    expect(source.getSnapshot()).toEqual({ kind: 'ready', snapshot: engines('laya') })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    source.refresh()
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reports an absent dispatcher, another failure, and a rejected read', async () => {
    const read = vi.fn<() => Promise<EngineSnapshotResult>>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'service-unavailable', message: 'no judgmentEngines' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'boom' } })
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce('plain')
    const source = createRoutingEngineSource(read)
    const states: RoutingEngineState[] = []
    for (let index = 0; index < 4; index += 1) {
      source.refresh()
      await flush()
      states.push(source.getSnapshot())
    }
    expect(states).toEqual([
      { kind: 'no-dispatcher' },
      { kind: 'failed', message: 'boom (internal)' },
      { kind: 'failed', message: 'socket closed' },
      { kind: 'failed', message: 'plain' },
    ])
  })

  it('keeps the latest of overlapping reads', async () => {
    const first = deferred<EngineSnapshotResult>()
    const second = deferred<EngineSnapshotResult>()
    const read = vi.fn<() => Promise<EngineSnapshotResult>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const source = createRoutingEngineSource(read)
    source.refresh()
    source.refresh()
    second.resolve({ ok: true, value: engines('typesafe') })
    await flush()
    first.resolve({ ok: true, value: engines('laya') })
    await flush()
    expect(source.getSnapshot()).toEqual({ kind: 'ready', snapshot: engines('typesafe') })
    const third = deferred<EngineSnapshotResult>()
    read.mockReturnValueOnce(third.promise)
    const late = deferred<EngineSnapshotResult>()
    read.mockReturnValueOnce(late.promise)
    source.refresh()
    source.refresh()
    third.reject(new Error('stale'))
    await flush()
    expect(source.getSnapshot().kind).toBe('ready')
    late.resolve({ ok: true, value: engines('laya') })
    await flush()
    expect(source.getSnapshot()).toEqual({ kind: 'ready', snapshot: engines('laya') })
  })

  it('stops publishing once disposed', async () => {
    const ok = deferred<EngineSnapshotResult>()
    const failing = deferred<EngineSnapshotResult>()
    const read = vi.fn<() => Promise<EngineSnapshotResult>>().mockReturnValueOnce(ok.promise).mockReturnValueOnce(failing.promise)
    const source = createRoutingEngineSource(read)
    const listener = vi.fn()
    source.subscribe(listener)
    source.refresh()
    source.dispose()
    ok.resolve({ ok: true, value: engines('laya') })
    await flush()
    expect(source.getSnapshot()).toEqual({ kind: 'loading' })
    const again = createRoutingEngineSource(() => failing.promise)
    again.refresh()
    again.dispose()
    failing.reject(new Error('late'))
    await flush()
    expect(again.getSnapshot()).toEqual({ kind: 'loading' })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('routingJudge', () => {
  it('passes loading and failure through, and names why there is no judge', () => {
    expect(routingJudge({ kind: 'loading' })).toEqual({ kind: 'loading' })
    expect(routingJudge({ kind: 'failed', message: 'x' })).toEqual({ kind: 'failed', message: 'x' })
    expect(routingJudge({ kind: 'no-dispatcher' })).toEqual({ kind: 'none', reason: 'no-dispatcher' })
    const disabled = engines('laya', { selection: { enabled: false, engine: 'laya', overrides: {} } })
    expect(routingJudge({ kind: 'ready', snapshot: disabled })).toEqual({ kind: 'none', reason: 'disabled' })
    expect(routingJudge({ kind: 'ready', snapshot: engines('missing') })).toEqual({ kind: 'none', reason: 'unregistered' })
  })

  it('selects the deployment engine, and a model-router override only while that consumer is declared', () => {
    expect(routingJudge({ kind: 'ready', snapshot: engines('laya') })).toEqual({ kind: 'engine', engine: LOCAL })
    const selection = { enabled: true, engine: 'laya', overrides: { [MODEL_ROUTER_CONSUMER]: 'typesafe' } }
    expect(routingJudge({ kind: 'ready', snapshot: engines('laya', { selection }) })).toEqual({ kind: 'engine', engine: LOCAL })
    const declared = engines('laya', { selection, consumers: [MODEL_ROUTER_CONSUMER as JudgmentConsumerId] })
    expect(routingJudge({ kind: 'ready', snapshot: declared })).toEqual({ kind: 'engine', engine: REMOTE })
    const noOverride = engines('laya', { consumers: [MODEL_ROUTER_CONSUMER as JudgmentConsumerId] })
    expect(routingJudge({ kind: 'ready', snapshot: noOverride })).toEqual({ kind: 'engine', engine: LOCAL })
  })
})

describe('engineEgress', () => {
  it('knows nothing until the registry is read, then matches ids and then labels', () => {
    expect(engineEgress({ kind: 'loading' })).toBeUndefined()
    const lookup = engineEgress({ kind: 'ready', snapshot: engines('laya') })!
    expect(lookup('typesafe')).toBe('remote')
    expect(lookup('Laya (local, MLX)')).toBe('local')
    expect(lookup('snapshot-judgment')).toBeUndefined()
  })
})
