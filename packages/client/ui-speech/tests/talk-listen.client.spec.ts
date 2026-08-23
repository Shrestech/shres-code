/**
 * Silence / max-window end for hands-free instruction capture.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TALK_INSTRUCTION_MAX_MS,
  TALK_MIN_SPEECH_MS,
  TALK_SILENCE_MS,
  watchUtteranceEnd,
} from '../src/client/talk-listen.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubAnalyser(level: { rms: number }, options?: { close?: () => Promise<void> }): void {
  class FakeAnalyser {
    fftSize = 0
    getFloatTimeDomainData(samples: Float32Array): void {
      samples.fill(level.rms)
    }
  }
  class FakeAudioContext {
    createMediaStreamSource = (): { connect: (node: unknown) => void } => ({
      connect: vi.fn(),
    })
    createAnalyser = (): FakeAnalyser => new FakeAnalyser()
    close = options?.close ?? vi.fn(async () => undefined)
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

describe('watchUtteranceEnd', () => {
  it('ends after voiced samples followed by trailing silence', () => {
    vi.useFakeTimers()
    const level = { rms: 0 }
    stubAnalyser(level, {
      close: vi.fn(async () => { throw new Error('closed') }),
    })
    const onEnd = vi.fn()
    watchUtteranceEnd({} as MediaStream, onEnd)
    vi.advanceTimersByTime(100)
    expect(onEnd).not.toHaveBeenCalled()
    level.rms = 0.2
    vi.advanceTimersByTime(TALK_MIN_SPEECH_MS + 50)
    level.rms = 0
    vi.advanceTimersByTime(TALK_SILENCE_MS + 50)
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('ignores silence until the minimum voiced window has elapsed', () => {
    vi.useFakeTimers()
    const level = { rms: 0.2 }
    stubAnalyser(level)
    const onEnd = vi.fn()
    watchUtteranceEnd({} as MediaStream, onEnd)
    vi.advanceTimersByTime(50)
    level.rms = 0
    vi.advanceTimersByTime(TALK_MIN_SPEECH_MS - 100)
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('ends at the max window when no analyser is available', () => {
    vi.useFakeTimers()
    function ThrowingAudioContext() {
      throw new Error('no audio')
    }
    vi.stubGlobal('AudioContext', ThrowingAudioContext)
    const onEnd = vi.fn()
    watchUtteranceEnd({} as MediaStream, onEnd)
    vi.advanceTimersByTime(TALK_INSTRUCTION_MAX_MS - 1)
    expect(onEnd).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('disposing cancels the watch without ending the utterance', () => {
    vi.useFakeTimers()
    stubAnalyser({ rms: 0.2 }, {
      close: vi.fn(async () => { throw new Error('closed') }),
    })
    const onEnd = vi.fn()
    const dispose = watchUtteranceEnd({} as MediaStream, onEnd)
    dispose()
    dispose()
    vi.advanceTimersByTime(TALK_INSTRUCTION_MAX_MS)
    expect(onEnd).not.toHaveBeenCalled()
  })
})
