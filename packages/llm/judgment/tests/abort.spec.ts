import { describe, expect, it } from 'vitest'
import { abortableJudgmentStep, JudgmentError, throwIfJudgmentAborted } from '../src/index.ts'

const MESSAGE = 'test engine ask was cancelled by the caller'

describe('caller-cancellation helpers', () => {
  it('throwIfJudgmentAborted throws ABORTED only for an aborted signal', () => {
    const controller = new AbortController()
    expect(() => {
      throwIfJudgmentAborted(undefined, MESSAGE)
    }).not.toThrow()
    expect(() => {
      throwIfJudgmentAborted(controller.signal, MESSAGE)
    }).not.toThrow()
    controller.abort()
    expect(() => {
      throwIfJudgmentAborted(controller.signal, MESSAGE)
    }).toThrow(new JudgmentError('ABORTED', MESSAGE))
  })

  it('runs a step to its value with or without a signal', async () => {
    await expect(abortableJudgmentStep(() => 'plain', undefined, MESSAGE)).resolves.toBe('plain')
    await expect(abortableJudgmentStep(() => Promise.resolve(7), new AbortController().signal, MESSAGE)).resolves.toBe(7)
  })

  it('does not start a step whose signal has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let started = false

    await expect(abortableJudgmentStep(() => {
      started = true
    }, controller.signal, MESSAGE)).rejects.toMatchObject({ code: 'ABORTED', message: MESSAGE })
    expect(started).toBe(false)
  })

  it('rejects ABORTED at once when the signal aborts during a step that never settles', async () => {
    const controller = new AbortController()
    const step = abortableJudgmentStep(() => new Promise<never>(() => {}), controller.signal, MESSAGE)
    controller.abort()

    await expect(step).rejects.toBeInstanceOf(JudgmentError)
    await expect(step).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('passes the step failure through, wrapping a non-Error value', async () => {
    const failure = new Error('step failed')
    await expect(abortableJudgmentStep(() => Promise.reject(failure), new AbortController().signal, MESSAGE)).rejects.toBe(failure)
    // A same-process step can reject with a non-Error value; the helper still rejects with an Error.
    const nonError: PromiseLike<never> = { then: (_onFulfilled, onRejected) => Promise.resolve(onRejected?.('text failure')) as never }
    const wrapped = await abortableJudgmentStep(() => nonError, new AbortController().signal, MESSAGE)
      .then(() => undefined, (error: unknown) => error)
    expect(wrapped).toBeInstanceOf(Error)
    expect((wrapped as Error).message).toBe('text failure')
    expect((wrapped as Error).cause).toBe('text failure')
  })
})
