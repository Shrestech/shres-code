/**
 * Event-stream backpressure: each mux and host consumer has an independent
 * frame/byte budget, and ending a consumer releases its listeners and queued
 * frames even when the caller never starts iteration.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import AgentRegistry from '@shres-code/shres-code-agent'
import SessionStore from '@shres-code/shres-code-session'
import type { Session, SessionEvent } from '@shres-code/shres-code-session'
import UserQuestionService from '@shres-code/shres-code-user-questions'
import type { ApiProxy, MuxFrame, RpcRequest } from '@shres-code/shres-code-host-apiproxy/api'
import { RpcId } from '@shres-code/shres-code-host-apiproxy/api/rpc'
import { createApiProxy } from '@shres-code/shres-code-host-apiproxy'

interface QueueHarness {
  readonly ctx: Context
  readonly api: ApiProxy
  readonly session: Session
}

async function harness(options: {
  eventQueueMaxFrames?: number
  eventQueueMaxBytes?: number
} = {}): Promise<QueueHarness> {
  const { ctx, session } = await context()
  return {
    ctx,
    session,
    api: createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
      ...options,
    }),
  }
}

async function context(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create()
  return { ctx, session }
}

function request(id: string): RpcRequest<{}> {
  return { rpcId: RpcId(id), payload: {} }
}

/** Emit a session event without appending it, so a test can make a large wire frame. */
function emitEvent(ctx: Context, session: Session, seq: number, text?: string): void {
  const data = text === undefined ? { turn: seq } : { turn: seq, text }
  ctx.emit('session/event', session, {
    type: 'turn/start',
    seq,
    time: seq,
    data,
  } as unknown as SessionEvent)
}

async function firstMux(
  api: ApiProxy,
  signal: AbortSignal,
): Promise<AsyncIterator<RpcRequest<MuxFrame>>> {
  const stream = api.events.mux(request('queue'), signal)
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new Error('mux stream ended before its baseline')
  expect(first.value.payload.type).toBe('session/subscribed')
  return iterator
}

describe('bounded event queues', () => {
  it('closes a slow mux consumer at the frame limit and names the setting', async () => {
    const { ctx, api, session } = await harness({ eventQueueMaxFrames: 2, eventQueueMaxBytes: 1_000_000 })
    const iterator = await firstMux(api, new AbortController().signal)

    emitEvent(ctx, session, 1)
    emitEvent(ctx, session, 2)
    emitEvent(ctx, session, 3)

    await expect(iterator.next()).rejects.toThrow(/eventQueueMaxFrames=2/)
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('counts UTF-8 bytes in the full server-request envelope', async () => {
    const { ctx, api, session } = await harness({ eventQueueMaxFrames: 100, eventQueueMaxBytes: 512 })
    const iterator = await firstMux(api, new AbortController().signal)

    emitEvent(ctx, session, 1, '☃'.repeat(500))

    await expect(iterator.next()).rejects.toThrow(/eventQueueMaxBytes=512/)
    await ctx.fiber.dispose()
  })

  it('accepts a frame whose full envelope is exactly at the byte limit', async () => {
    const { ctx, session } = await context()
    const event = {
      type: 'session/event' as const,
      sessionId: session.id,
      event: {
        type: 'turn/start' as const,
        seq: 1,
        time: 1,
        data: { turn: 1, text: '☃'.repeat(5) },
      },
    }
    const full = {
      type: 'server-request' as const,
      rpcId: RpcId('00000000-0000-0000-0000-000000000000'),
      method: event.type,
      payload: event,
    }
    const exactBytes = Buffer.byteLength(JSON.stringify(full), 'utf8') + 1
    const exactApi = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
      eventQueueMaxBytes: exactBytes,
    })
    const exactAbort = new AbortController()
    const exact = await firstMux(exactApi, exactAbort.signal)
    emitEvent(ctx, session, 1, '☃'.repeat(5))
    await expect(exact.next()).resolves.toMatchObject({ value: { payload: { type: 'session/event' } } })
    exactAbort.abort()
    await exact.next()
    await ctx.fiber.dispose()
  })

  it('keeps a fast consumer independent when a second consumer overflows', async () => {
    const { ctx, api, session } = await harness({ eventQueueMaxFrames: 2, eventQueueMaxBytes: 1_000_000 })
    const slow = await firstMux(api, new AbortController().signal)
    const fast = await firstMux(api, new AbortController().signal)

    emitEvent(ctx, session, 1)
    await expect(fast.next()).resolves.toMatchObject({ value: { payload: { type: 'session/event' } } })
    emitEvent(ctx, session, 2)
    await expect(fast.next()).resolves.toMatchObject({ value: { payload: { type: 'session/event' } } })
    emitEvent(ctx, session, 3)
    await expect(fast.next()).resolves.toMatchObject({ value: { payload: { type: 'session/event' } } })
    await expect(slow.next()).rejects.toThrow(/eventQueueMaxFrames=2/)
    await ctx.fiber.dispose()
  })

  it('cleans up a stream that is returned before its first pull', async () => {
    const { ctx, api, session } = await harness()
    const stream = api.events.mux(request('never-pulled'), new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    emitEvent(ctx, session, 1)
    await ctx.fiber.dispose()
  })

  it('clears queued frames when its abort signal ends the stream', async () => {
    const { ctx, api, session } = await harness()
    const abort = new AbortController()
    const iterator = await firstMux(api, abort.signal)

    emitEvent(ctx, session, 1)
    abort.abort()

    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('resolves a waiting pull when the iterator is returned', async () => {
    const { ctx, api } = await harness()
    const abort = new AbortController()
    const iterator = await firstMux(api, abort.signal)
    const pending = iterator.next()

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    await expect(pending).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('removes event listeners immediately on return and abort', async () => {
    const { ctx, api, session } = await harness()
    const eventListeners = (): number => ctx.events._hooks['session/event']?.length ?? 0
    const before = eventListeners()
    const returned = api.events.mux(request('listener-return'), new AbortController().signal)
    const returnedIterator = returned[Symbol.asyncIterator]()
    expect(eventListeners()).toBe(before + 1)
    await returnedIterator.return?.()
    expect(eventListeners()).toBe(before)

    const abort = new AbortController()
    const aborted = api.events.mux(request('listener-abort'), abort.signal)
    const abortedIterator = aborted[Symbol.asyncIterator]()
    expect(eventListeners()).toBe(before + 1)
    abort.abort()
    expect(eventListeners()).toBe(before)
    emitEvent(ctx, session, 1)
    await expect(abortedIterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('reports a baseline overflow before the caller pulls', async () => {
    const { ctx, api } = await harness({ eventQueueMaxFrames: 1, eventQueueMaxBytes: 1_000_000 })
    ctx.sessions.create()
    const stream = api.events.mux(request('baseline-overflow'), new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toThrow(/eventQueueMaxFrames=1/)
    await ctx.fiber.dispose()
  })
})
