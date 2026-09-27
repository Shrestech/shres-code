import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  toServerToolCallBlock,
} from '@shres-code/shres-code-llm'
import { Session, SessionId } from '@shres-code/shres-code-session'
import { buildRoutingState, buildRoutingStateCandidates } from '../src/state.ts'

interface StateItemFixture {
  seq?: number
  type?: string
  count?: number
  [key: string]: unknown
}

function parseStateItems(text: string): StateItemFixture[] {
  return JSON.parse(text) as StateItemFixture[]
}

function stateItemFor(items: readonly StateItemFixture[], seq: number): StateItemFixture {
  const item = items.find(candidate => candidate.seq === seq)
  if (item === undefined) throw new Error(`missing state item for seq ${seq}`)
  return item
}

function makeSession(id = 'routing-state'): Session {
  return Session.create(SessionId(id))
}

function user(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function assistant(session: Session, content: Parameters<typeof createAssistantMessage>[0]['content']): number {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content,
      source: { provider: 'mock', model: 'mock-1' },
    }),
  }, { surfaceOp: 'append' }).seq
}

function toolResult(session: Session, text: string, isError = false): number {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId('call-1'),
      content: [{ type: 'text', text }],
      isError,
    }),
  }, { surfaceOp: 'append' }).seq
}

describe('buildRoutingState', () => {
  it('renders an empty surface as an empty JSON array', () => {
    const exact = buildRoutingState(makeSession(), { contextTurns: 2, maxChars: 2 })
    expect(exact).toEqual({ text: '[]', seqs: [], omittedSeqs: [], oversizedCurrent: false })

    const tiny = buildRoutingState(makeSession(), { contextTurns: 2, maxChars: 1 })
    expect(tiny).toEqual({ text: '', seqs: [], omittedSeqs: [], oversizedCurrent: true })
  })

  it('skips an empty assistant event that only carries usage', () => {
    const session = makeSession()
    const seq = assistant(session, [])

    const state = buildRoutingState(session, { contextTurns: 0, maxChars: 10_000 })

    expect(session.surface.nodes).toEqual([seq])
    expect(state).toEqual({ text: '[]', seqs: [], omittedSeqs: [], oversizedCurrent: false })
  })

  it('keeps continue context and intervening assistant/tool evidence from the live surface', () => {
    const session = makeSession()
    const first = user(session, 'inspect the change')
    const assistantSeq = assistant(session, [
      { type: 'reasoning', text: 'private chain of thought' },
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool-call', id: CallId('call-1'), name: 'read', arguments: '{"path":"a.ts"}' },
    ])
    const resultSeq = toolResult(session, 'the file is clean')
    const current = user(session, 'continue with the fix')

    const state = buildRoutingState(session, { contextTurns: 1, maxChars: 10_000 })
    const parsed = JSON.parse(state.text) as Array<Record<string, unknown>>

    expect(state.seqs).toEqual([first, assistantSeq, resultSeq, current])
    expect(parsed.map(item => item['seq'])).toEqual(state.seqs)
    expect(parsed[1]).toMatchObject({ role: 'assistant', source: 'model' })
    expect(parsed[1]?.['content']).toEqual([
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool-call', name: 'read', arguments: '{"path":"a.ts"}' },
    ])
    expect(parsed[2]?.['content']).toEqual([{
      type: 'tool-result',
      status: 'success',
      content: [{ type: 'text', text: 'the file is clean' }],
    }])
    expect(state.omittedSeqs).toEqual([])
  })

  it('uses replacement-aware surface nodes and excludes shadowed/raw messages', () => {
    const session = makeSession()
    const shadowed = user(session, 'old prompt')
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('raw-call'),
      name: 'secret_tool',
      arguments: '{"secret":true}',
    })
    const replacement = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement prompt' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', start: shadowed, end: shadowed },
      sourceEventSeqs: [shadowed],
    }).seq

    const state = buildRoutingState(session, { contextTurns: 1, maxChars: 10_000 })

    expect(state.seqs).toEqual([replacement])
    expect(state.omittedSeqs).toEqual([])
    expect(state.text).not.toContain('old prompt')
    expect(state.text).not.toContain('secret_tool')
    expect(state.text).not.toContain('raw-call')
  })

  it('renders image markers, nested tool errors, hosted summaries, and omits replay metadata', () => {
    const session = makeSession()
    const seq = assistant(session, [
      {
        type: 'image',
        attachment: {
          attachmentId: 'sha256:image' as never,
          mediaType: 'image/png',
          bytes: 12,
          width: 2,
          height: 2,
        },
      },
      {
        type: 'tool-result',
        toolCallId: CallId('call-2'),
        isError: true,
        content: [{ type: 'text', text: 'permission denied' }],
      },
      toServerToolCallBlock({
        kind: 'web_search',
        name: 'search',
        status: 'completed',
        results: [{ title: 'Result', url: 'https://example.test', snippet: 'summary' }],
      }),
      toServerToolCallBlock({ kind: 'web_search', status: 'failed' }),
      toServerToolCallBlock({ kind: 'web_search', status: 'completed', results: [{ title: 'Title only' }] }),
      toServerToolCallBlock({ kind: 'web_search', status: 'completed', results: [{ url: 'URL only' }] }),
      toServerToolCallBlock({ kind: 'x_search', name: 'x_keyword_search' }),
      { type: 'future-block', value: 'provider-private' } as never,
      { type: 'reasoning', text: 'must never reach the judge' },
    ])

    const state = buildRoutingState(session, { contextTurns: 0, maxChars: 10_000 })
    const parsed = JSON.parse(state.text) as Array<Record<string, unknown>>
    expect(state.seqs).toEqual([seq])
    expect(parsed[0]).toMatchObject({ seq, role: 'assistant', source: 'model' })
    expect(parsed[0]?.['content']).toEqual([
      { type: 'image' },
      {
        type: 'tool-result',
        status: 'error',
        content: [{ type: 'text', text: 'permission denied' }],
      },
      {
        type: 'hosted-tool-call',
        kind: 'web_search',
        name: 'search',
        status: 'completed',
        results: [{ title: 'Result', url: 'https://example.test', snippet: 'summary' }],
      },
      { type: 'hosted-tool-call', kind: 'web_search', status: 'failed' },
      { type: 'hosted-tool-call', kind: 'web_search', status: 'completed', results: [{ title: 'Title only' }] },
      { type: 'hosted-tool-call', kind: 'web_search', status: 'completed', results: [{ url: 'URL only' }] },
      // An unreported status stays absent rather than reading as a success or a failure.
      { type: 'hosted-tool-call', kind: 'x_search', name: 'x_keyword_search' },
      { type: 'unsupported', kind: 'future-block' },
    ])
    expect(state.text).not.toContain('permission denied\nprivate')
    expect(state.text).not.toContain('replayState')
  })

  it('omits older complete entries, exposes the omission count, and never slices a message', () => {
    const session = makeSession()
    const first = user(session, 'old')
    const second = user(session, 'current')
    const full = buildRoutingState(session, { contextTurns: 1, maxChars: 10_000 })
    const currentOnly = buildRoutingState(session, { contextTurns: 0, maxChars: 10_000 })
    const cap = currentOnly.text.length + JSON.stringify({ type: 'omitted', count: 1 }).length
    const bounded = buildRoutingState(session, { contextTurns: 1, maxChars: cap })
    const parsed = JSON.parse(bounded.text) as Array<Record<string, unknown>>

    expect(full.seqs).toEqual([first, second])
    expect(bounded.seqs).toEqual([second])
    expect(bounded.omittedSeqs).toEqual([first])
    expect(parsed.at(-1)).toEqual({ type: 'omitted', count: 1 })
    expect(bounded.text.length).toBeLessThanOrEqual(cap)
    expect(bounded.text).not.toContain('old')
    expect(bounded.text).toContain('current')
  })

  it('returns manual fallback for a current entry that cannot fit its complete wrapper', () => {
    const session = makeSession()
    const seq = user(session, '😀 current prompt')
    const unconstrained = buildRoutingState(session, { contextTurns: 0, maxChars: 10_000 })

    const state = buildRoutingState(session, {
      contextTurns: 0,
      maxChars: unconstrained.text.length - 1,
    })

    expect(state).toEqual({
      text: '',
      seqs: [],
      omittedSeqs: [seq],
      oversizedCurrent: true,
    })
  })

  it('respects an exact cap and can skip an oversized newest evidence entry', () => {
    const session = makeSession()
    const task = user(session, 'short task')
    const evidence = assistant(session, [{ type: 'text', text: 'short evidence' }])
    const hugeResult = toolResult(session, 'x'.repeat(2_000))
    const current = user(session, 'continue')

    const exact = buildRoutingState(session, { contextTurns: 1, maxChars: 10_000 })
    const exactItems = parseStateItems(exact.text)
    const cap = JSON.stringify([
      stateItemFor(exactItems, task),
      stateItemFor(exactItems, evidence),
      stateItemFor(exactItems, current),
      { type: 'omitted', count: 1 },
    ]).length
    const bounded = buildRoutingState(session, { contextTurns: 1, maxChars: cap })

    expect(bounded.text.length).toBe(cap)
    expect(bounded.seqs).toEqual([task, evidence, current])
    expect(bounded.omittedSeqs).toEqual([hugeResult])
    expect(parseStateItems(bounded.text).at(-1)).toEqual({ type: 'omitted', count: 1 })
  })

  it('reports an unrepresentable no-user history without exceeding a tiny cap', () => {
    const session = makeSession()
    const seq = assistant(session, [{ type: 'text', text: 'history' }])

    const state = buildRoutingState(session, { contextTurns: 0, maxChars: 1 })
    const fits = buildRoutingState(session, { contextTurns: 0, maxChars: 10_000 })

    expect(state).toEqual({ text: '', seqs: [], omittedSeqs: [seq], oversizedCurrent: true })
    expect(state.text.length).toBeLessThanOrEqual(1)
    expect(fits.seqs).toEqual([seq])
  })
})


describe('complete tokenizer fitting alternatives', () => {
  it('bounds alternatives and removes older entries while preserving the whole current request', () => {
    const session = makeSession()
    const seqs = Array.from({ length: 9 }, (_, index) => user(session, `task ${index}`))
    const config = { contextTurns: 8, maxChars: 12_000, maxFitCandidates: 3 }
    const alternatives = buildRoutingStateCandidates(session, config)
    expect(alternatives).toHaveLength(3)
    expect(alternatives[0]).toEqual(buildRoutingState(session, config))
    expect(alternatives[1]?.seqs).toEqual(seqs.slice(4))
    expect(alternatives[2]?.seqs).toEqual(seqs.slice(-1))
    for (const alternative of alternatives) {
      expect(alternative.text).toContain('task 8')
      expect(alternative.text.length).toBeLessThanOrEqual(config.maxChars)
      expect(alternative.omittedSeqs).toEqual(seqs.filter(seq => !alternative.seqs.includes(seq)))
      const omitted = parseStateItems(alternative.text).find(item => item.type === 'omitted')
      expect(omitted?.count ?? 0).toBe(alternative.omittedSeqs.length)
    }
  })

  it('offers each possible removal when the alternative cap allows it', () => {
    const session = makeSession()
    user(session, 'task')
    assistant(session, [{ type: 'text', text: 'previous answer' }])
    const current = user(session, 'continue')
    const alternatives = buildRoutingStateCandidates(session, { contextTurns: 1, maxChars: 12_000, maxFitCandidates: 8 })
    expect(alternatives.map(candidate => candidate.seqs.length)).toEqual([3, 2, 1])
    expect(alternatives[2]?.seqs).toEqual([current])
  })

  it('retains the latest complete evidence when no user message exists', () => {
    const session = makeSession()
    assistant(session, [{ type: 'text', text: 'old evidence' }])
    const latest = assistant(session, [{ type: 'text', text: 'latest evidence' }])
    const alternatives = buildRoutingStateCandidates(session, { contextTurns: 1, maxChars: 12_000, maxFitCandidates: 8 })
    expect(alternatives.map(candidate => candidate.seqs)).toEqual([[latest - 1, latest], [latest]])
  })
})


describe('user intent among injected context messages', () => {
  it('retains the actual current user after a trailing plugin context and does not count context as a prior turn', () => {
    const session = makeSession()
    const old = user(session, 'old request')
    const current = user(session, 'REAL CURRENT USER')
    const context = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'workspace context' }],
      source: { kind: 'plugin', plugin: 'runtime-context' },
    }), { surfaceOp: 'append' }).seq
    const candidates = buildRoutingStateCandidates(session, { contextTurns: 0, maxChars: 12_000, maxFitCandidates: 8 })
    expect(candidates[0].seqs).toEqual([current, context])
    expect(candidates[0].omittedSeqs).toEqual([old])
    expect(candidates.at(-1)?.seqs).toEqual([current])
    expect(candidates.at(-1)?.omittedSeqs).toEqual([old, context])
    expect(candidates.every(candidate => candidate.text.includes('REAL CURRENT USER'))).toBe(true)
  })

  it('rejects an oversized user request even when a later plugin message would fit', () => {
    const session = makeSession()
    user(session, 'large user request '.repeat(100))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'short context' }], source: { kind: 'plugin', plugin: 'runtime-context' },
    }), { surfaceOp: 'append' })
    const candidates = buildRoutingStateCandidates(session, { contextTurns: 0, maxChars: 200, maxFitCandidates: 8 })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].oversizedCurrent).toBe(true)
    expect(candidates[0].seqs).toEqual([])
  })

  it('does not treat a steered subagent-report as the current request', () => {
    const session = makeSession()
    const current = user(session, 'REAL CURRENT USER')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'report from child' }],
      source: { kind: 'subagent-report', form: 'relay', senderSessionId: SessionId('child') },
    }), { surfaceOp: 'append' })
    const state = buildRoutingState(session, { contextTurns: 4, maxChars: 12_000 })
    const items = parseStateItems(state.text)
    const currentItem = stateItemFor(items, current)
    expect(currentItem.source).toBe('user')
    expect(items.some(item => item.source === 'subagent-report')).toBe(true)
    expect(state.seqs).toContain(current)
  })
})
