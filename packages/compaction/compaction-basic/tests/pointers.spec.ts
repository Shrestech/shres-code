import { describe, expect, it } from 'vitest'
import { CompactionId, compactCheckpointSource } from '@shres-code/shres-code-compaction'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@shres-code/shres-code-llm'
import { Session, SessionId } from '@shres-code/shres-code-session'
import {
  attachElisionPointers,
  attachElisionPointersWithinBudget,
  formatElisionPointerLine,
  POINTER_READ_CUE,
  POINTER_SECTION_HEADING,
  selectElisionPointers,
} from '../src/pointers.ts'

const MODEL = 'test-model'

function openTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
}

function closeTurn(session: Session, turn: number): void {
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function appendUser(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function appendAssistant(session: Session, turn: number, text: string): number {
  return session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' }).seq
}

function appendToolResult(
  session: Session,
  turn: number,
  name: string,
  citeCall: boolean,
): { callSeq: number; resultSeq: number } {
  const callId = CallId(`call-${name}-${turn}`)
  const callSeq = session.append('tool/call', {
    turn,
    step: 1,
    callId,
    name,
    arguments: '{}',
  }).seq
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: `${name} output` }],
      isError: false,
    }),
  }, {
    surfaceOp: 'append',
    ...citeCall ? { sourceEventSeqs: [callSeq] } : {},
  })
  return { callSeq, resultSeq: result.seq }
}

describe('elision pointer selection and formatting', () => {
  it('formats a named current-session read cue', () => {
    expect(formatElisionPointerLine({
      seq: 15,
      subject: 'full output of bash',
    })).toBe(`- full output of bash at seq 15 — ${POINTER_READ_CUE} 15`)
  })

  it('returns no pointers when maxPointers is 0 or the span is empty', () => {
    const session = Session.create(SessionId('empty-span'))
    openTurn(session, 1)
    const seq = appendUser(session, 'hello')
    expect(selectElisionPointers(session, [seq], 0)).toEqual([])
    expect(selectElisionPointers(session, [], 8)).toEqual([])
    expect(attachElisionPointers([{ type: 'text', text: 'sum' }], session, [seq], 0))
      .toEqual([{ type: 'text', text: 'sum' }])
  })

  it('prefers tool results, then user messages, and caps the count', () => {
    const session = Session.create(SessionId('ranked'))
    openTurn(session, 1)
    const user = appendUser(session, 'please run tools')
    const first = appendToolResult(session, 1, 'bash', true)
    const second = appendToolResult(session, 1, 'read', true)
    appendAssistant(session, 1, 'working')
    closeTurn(session, 1)

    const selected = selectElisionPointers(
      session,
      [user, first.resultSeq, second.resultSeq],
      2,
    )
    expect(selected).toEqual([
      { seq: first.resultSeq, subject: 'full output of bash' },
      { seq: second.resultSeq, subject: 'full output of read' },
    ])
  })

  it('labels prior checkpoints separately from ordinary user messages', () => {
    const session = Session.create(SessionId('checkpoint'))
    openTurn(session, 1)
    const ordinary = appendUser(session, 'task')
    const checkpoint = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prior summary' }],
      source: compactCheckpointSource(CompactionId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')),
    }), { surfaceOp: 'append' }).seq
    expect(selectElisionPointers(session, [ordinary, checkpoint], 8)).toEqual([
      { seq: ordinary, subject: 'user message' },
      { seq: checkpoint, subject: 'prior checkpoint' },
    ])
  })

  it('falls back to assistant messages only when nothing else is salient', () => {
    const session = Session.create(SessionId('assistant-only'))
    openTurn(session, 1)
    const assistant = appendAssistant(session, 1, 'only text')
    expect(selectElisionPointers(session, [assistant], 4)).toEqual([
      { seq: assistant, subject: 'assistant message' },
    ])
  })

  it('resolves a tool name from a preceding call when the result cites none', () => {
    const session = Session.create(SessionId('uncited'))
    openTurn(session, 1)
    const { resultSeq } = appendToolResult(session, 1, 'write', false)
    expect(selectElisionPointers(session, [resultSeq], 1)).toEqual([
      { seq: resultSeq, subject: 'full output of write' },
    ])
  })

  it('ignores cited seqs that are not a matching tool/call', () => {
    const session = Session.create(SessionId('bad-cite'))
    openTurn(session, 1)
    const user = appendUser(session, 'before')
    const callId = CallId('cited-user')
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: 'bash',
      arguments: '{}',
    })
    const resultSeq = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'out' }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [user] }).seq
    expect(selectElisionPointers(session, [resultSeq], 1)).toEqual([
      { seq: resultSeq, subject: 'full output of bash' },
    ])
  })

  it('skips missing seqs and non-message events', () => {
    const session = Session.create(SessionId('skips'))
    openTurn(session, 1)
    const user = appendUser(session, 'keep')
    const startSeq = session.events.find(event => event.type === 'turn/start')!.seq
    expect(selectElisionPointers(session, [startSeq, 9_999, user], 8)).toEqual([
      { seq: user, subject: 'user message' },
    ])
  })

  it('appends a pointer section that rides with the summary blocks', () => {
    const session = Session.create(SessionId('attach'))
    openTurn(session, 1)
    const user = appendUser(session, 'remember this')
    const attached = attachElisionPointers(
      [{ type: 'text', text: 'small checkpoint' }],
      session,
      [user],
      8,
    )
    expect(attached[0]).toEqual({ type: 'text', text: 'small checkpoint' })
    expect(attached[1]?.type).toBe('text')
    const text = attached[1]?.type === 'text' ? attached[1].text : ''
    expect(text).toContain(POINTER_SECTION_HEADING)
    expect(text).toContain(formatElisionPointerLine({ seq: user, subject: 'user message' }))
  })

  it('keeps the longest prefix of pointers that still fits the shrink budget', () => {
    const session = Session.create(SessionId('budget'))
    openTurn(session, 1)
    const first = appendToolResult(session, 1, 'bash', true)
    const second = appendToolResult(session, 1, 'read', true)
    const summary = [{ type: 'text' as const, text: 'sum' }]
    const fitted = attachElisionPointersWithinBudget(
      summary,
      session,
      [first.resultSeq, second.resultSeq],
      8,
      (blocks) => {
        if (blocks.length === 1) return 10
        const text = blocks[1]?.type === 'text' ? blocks[1].text : ''
        return 10 + [...text.matchAll(/^- /gm)].length * 2
      },
      13,
    )
    expect(fitted).toHaveLength(2)
    const text = fitted[1]?.type === 'text' ? fitted[1].text : ''
    expect(text).toContain('full output of bash')
    expect(text).not.toContain('full output of read')
  })

  it('omits every pointer when even one would not shrink', () => {
    const session = Session.create(SessionId('over-budget'))
    openTurn(session, 1)
    const user = appendUser(session, 'tiny')
    expect(attachElisionPointersWithinBudget(
      [{ type: 'text', text: 'sum' }],
      session,
      [user],
      8,
      () => 50,
      20,
    )).toEqual([{ type: 'text', text: 'sum' }])
  })
})
