import { describe, expect, it } from 'vitest'
import { Context } from '@shres-code/cordis'
import { CallId , createMessage, createToolResultMessage } from '@shres-code/shres-code-llm'
import type { ContentBlock } from '@shres-code/shres-code-llm'
import SessionStore, {
  Session,
  SessionId,
} from '@shres-code/shres-code-session'
import type { SurfaceEvent } from '@shres-code/shres-code-session'
import * as SessionInvariant from '@shres-code/shres-code-session/invariant'
import InvariantRegistry from '@shres-code/shres-code-invariants'
import TokenMeter from '@shres-code/shres-code-token-meter'
import ToolResultPruner, {
  codePointLength,
  DEFAULTS,
  MAX_PRUNE_MARKER_CHARS,
  PRUNE_READ_CUE,
  pruneMarker,
  resolveConfig,
} from '@shres-code/shres-code-compaction-tool-result-pruner'
import type { ToolResultPruneConfig } from '@shres-code/shres-code-compaction-tool-result-pruner'

const MODEL = 'test-model'
const PLANTED_SEQ = 12

const SMALL: ToolResultPruneConfig = {
  thresholdChars: MAX_PRUNE_MARKER_CHARS + 20,
  headChars: 4,
  tailChars: 3,
}

function service(config: ToolResultPruneConfig = SMALL): ToolResultPruner {
  const ctx = new Context()
  // Service constructors self-register, so `ctx.tokenMeter` resolves for the
  // shadow-price pricing without a full plugin boot.
  void new TokenMeter(ctx)
  return new ToolResultPruner(ctx, config)
}

/** Pricing oracle mirroring the service's estimator for expectations. */
const METER = new TokenMeter(new Context())

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
  extra: Record<string, unknown> = {},
): number {
  const callId = CallId(call)
  session.append('turn/start', {
    turn,
  })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
    ...extra,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

describe('tool-result pruning configuration', () => {
  it('resolves detached immutable defaults and partial overrides', () => {
    const raw = { thresholdChars: 400, headChars: 20, tailChars: 10 }
    const resolved = resolveConfig(raw)
    raw.headChars = 1
    expect(resolved).toEqual({ thresholdChars: 400, headChars: 20, tailChars: 10 })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(DEFAULTS).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    expect(Object.isFrozen(DEFAULTS)).toBe(true)
    expect(PRUNE_READ_CUE).toBe('session_event_read this session, seq')
    expect(MAX_PRUNE_MARKER_CHARS).toBe(codePointLength(pruneMarker(Number.MAX_SAFE_INTEGER)))
  })

  it('rejects stale keys, invalid scalars, and an output budget above threshold', () => {
    const bad = [
      [{ thresholdChars: 0 }, /thresholdChars .* positive integer/],
      [{ headChars: -1 }, /headChars .* non-negative integer/],
      [{ tailChars: 1.5 }, /tailChars .* non-negative integer/],
      [{ thresholdChars: 50, headChars: 20, tailChars: 20 }, /headChars \+ marker \+ tailChars/],
      [{ thresholdChars: MAX_PRUNE_MARKER_CHARS - 1, headChars: 0, tailChars: 0 }, /headChars \+ marker \+ tailChars/],
      [{ threshold: 10 }, /unknown key "threshold"/],
    ] as Array<[unknown, RegExp]>
    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as ToolResultPruneConfig)).toThrow(pattern)
    }
  })
})

describe('ToolResultPruner content transform', () => {
  it('measures text code points only and skips content within threshold', () => {
    const prune = service()
    const blocks = [
      { type: 'text', text: 'a😀b' },
      { type: 'reasoning', text: 'not measured' },
    ] satisfies ContentBlock[]
    expect(prune.measureContent(blocks)).toBe(3)
    expect(prune.pruneContent(blocks, PLANTED_SEQ)).toBeNull()
    expect(codePointLength('a😀b')).toBe(3)
  })

  it('keeps configured head and tail without splitting surrogate pairs', () => {
    const prune = service()
    const overflow = SMALL.thresholdChars! + 40
    const result = prune.pruneContent([{ type: 'text', text: '😀'.repeat(overflow) }], PLANTED_SEQ)
    const marker = pruneMarker(PLANTED_SEQ)
    expect(result).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${marker}${'😀'.repeat(3)}`,
    }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(SMALL.thresholdChars!)
    expect(result![0]).toMatchObject({ type: 'text' })
    expect((result![0] as { text: string }).text).not.toContain('\uFFFD')
    expect((result![0] as { text: string }).text).toContain(`${PRUNE_READ_CUE} ${String(PLANTED_SEQ)}`)
  })

  it('preserves non-text blocks and their relative ordering across removed text', () => {
    const prune = service()
    const reasoning: ContentBlock = { type: 'reasoning', text: 'private-rich-block' }
    const call: ContentBlock = {
      type: 'tool-call',
      id: CallId('nested'),
      name: 'nested',
      arguments: '{}',
    }
    const chunk = Math.ceil((SMALL.thresholdChars! + 40) / 3)
    const result = prune.pruneContent([
      { type: 'text', text: 'A'.repeat(chunk) },
      reasoning,
      { type: 'text', text: 'B'.repeat(chunk) },
      call,
      { type: 'text', text: 'C'.repeat(chunk) },
    ], PLANTED_SEQ)
    expect(result).toEqual([
      { type: 'text', text: `AAAA${pruneMarker(PLANTED_SEQ)}` },
      reasoning,
      call,
      { type: 'text', text: 'CCC' },
    ])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(SMALL.thresholdChars!)
  })

  it('supports zero-sized head and tail while still shrinking', () => {
    const prune = service({
      thresholdChars: MAX_PRUNE_MARKER_CHARS,
      headChars: 0,
      tailChars: 0,
    })
    const result = prune.pruneContent(
      [{ type: 'text', text: 'x'.repeat(MAX_PRUNE_MARKER_CHARS + 40) }],
      PLANTED_SEQ,
    )
    expect(result).toEqual([{ type: 'text', text: pruneMarker(PLANTED_SEQ) }])
    expect(prune.measureContent(result!)).toBeLessThanOrEqual(prune.config.thresholdChars)
  })

  it('rejects a non-integer originalSeq before emitting a marker', () => {
    const prune = service()
    expect(() => prune.pruneContent([{ type: 'text', text: 'x'.repeat(SMALL.thresholdChars! + 40) }], -1))
      .toThrow(/originalSeq .* non-negative safe integer/)
    expect(() => prune.pruneContent([{ type: 'text', text: 'x'.repeat(SMALL.thresholdChars! + 40) }], 1.5))
      .toThrow(/originalSeq .* non-negative safe integer/)
  })
})

describe('ToolResultPruner session transaction', () => {
  it('prunes a stable snapshot, preserves all data, and cites the replaced result', () => {
    const session = Session.create(SessionId('preserve'))
    const originalSeq = appendToolStep(session, 1, 'one', [{
      type: 'text',
      text: 'x'.repeat(SMALL.thresholdChars! + 80),
    }], {
      isError: true,
      error: { name: 'ExitError', code: 'EXIT_1' },
      meta: { diff: ['a', 'b'] },
      futureField: { nested: true },
    })
    session.append('turn/start', {
      turn: 2,
    })

    const result = service().pruneSession(session)
    expect(result.pruned).toHaveLength(1)
    expect(result.charsRemoved).toBeGreaterThan(0)
    const entry = result.pruned[0]!
    expect(entry).toMatchObject({
      originalSeq,
      callId: CallId('one'),
      charsBefore: SMALL.thresholdChars! + 80,
    })
    expect(entry.charsAfter).toBeLessThanOrEqual(SMALL.thresholdChars!)

    const original = session.events[originalSeq]!
    const replacement = session.events[entry.replacementSeq]! as SurfaceEvent
    expect(original).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            content: [{ type: 'text', text: 'x'.repeat(SMALL.thresholdChars! + 80) }],
          }],
        },
      },
    })
    expect(replacement).toMatchObject({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        isError: true,
        message: {
          source: { kind: 'tool', callId: CallId('one') },
        },
        error: { name: 'ExitError', code: 'EXIT_1' },
        meta: { diff: ['a', 'b'] },
        futureField: { nested: true },
      },
      surfaceOp: { op: 'replace', start: originalSeq, end: originalSeq },
      sourceEventSeqs: [originalSeq],
    })
    expect(session.surface.nodes).not.toContain(originalSeq)
    expect(JSON.stringify(replacement.data)).toContain(`${PRUNE_READ_CUE} ${String(originalSeq)}`)
    expect(JSON.stringify(replacement.data)).toContain('remains in the session log')

    // Shadow-price protocol: the metering event sits directly before the
    // replacement and prices the shadowed node with the shared estimator.
    if (original.type !== 'tool/result') throw new Error('original is not a tool/result')
    expect(session.events[entry.replacementSeq - 1]).toMatchObject({
      type: 'compaction/prune',
      data: {
        shadowedRange: { start: originalSeq, end: originalSeq },
        shadowedSeqs: [originalSeq],
        shadowedTokenCount: METER.estimateMessage(original.data.message),
      },
    })
  })

  it('prunes multiple results, skips short ones, and converges in one pass', () => {
    const session = Session.create(SessionId('multiple'))
    const overflow = SMALL.thresholdChars! + 80
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(overflow) }])
    appendToolStep(session, 2, 'b', [{ type: 'text', text: 'short' }])
    appendToolStep(session, 3, 'c', [{ type: 'text', text: 'C'.repeat(overflow) }])
    session.append('turn/start', {
      turn: 4,
    })
    const prune = service()
    const first = prune.pruneSession(session)
    const second = prune.pruneSession(session)
    expect(first.pruned.map(entry => entry.callId)).toEqual([CallId('a'), CallId('c')])
    expect(first.charsRemoved).toBe(
      first.pruned.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    )
    expect(second).toEqual({ pruned: [], charsRemoved: 0 })
  })

  it('replays to the identical pruned model messages', () => {
    const session = Session.create(SessionId('replay'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(SMALL.thresholdChars! + 80) }])
    session.append('turn/start', {
      turn: 2,
    })
    service().pruneSession(session)
    const replay = Session.create(session.id, [...session.events])
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(replay.surface.replaceGeneration).toBe(session.surface.replaceGeneration)
  })

  it('runs under real invariants between closed steps but not outside a turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SessionInvariant)
    await ctx.plugin(TokenMeter)
    const prune = new ToolResultPruner(ctx, SMALL)
    const session = ctx.sessions.create(SessionId('invariants'))
    appendToolStep(session, 1, 'a', [{ type: 'text', text: 'A'.repeat(SMALL.thresholdChars! + 80) }])
    expect(() => prune.pruneSession(session)).toThrow(/outside any open turn/)
    session.append('turn/start', {
      turn: 2,
    })
    expect(() => prune.pruneSession(session)).not.toThrow()
  })
})
