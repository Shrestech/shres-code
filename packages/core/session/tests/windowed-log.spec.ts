import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@shres-code/shres-code-llm'
import { Session, SessionId } from '@shres-code/shres-code-session'
import type { SessionEvent, SessionEventArchive } from '@shres-code/shres-code-session'

/** Map-backed archive that records which seqs were re-read. */
function mapArchive(store: Map<number, SessionEvent>, reads: number[][] = []): SessionEventArchive {
  return {
    read(seqs) {
      reads.push([...seqs])
      return seqs.map((seq) => {
        const event = store.get(seq)
        if (event === undefined) throw new Error(`archive missing seq ${seq}`)
        return event
      })
    },
  }
}

/** One turn with a log-only chunk and a surface assistant message. */
function populate(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/chunk', {
    turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' },
  })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [2] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

describe('windowed in-memory session log', () => {
  it('retains every event until a window and archive are attached', () => {
    const session = Session.create(SessionId('retain-all'))
    populate(session)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()
    expect(session.residentSeqs()).toEqual([0, 1, 2, 3, 4])
    expect(session.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'assistant/chunk', 'assistant/message', 'turn/end',
    ])
  })

  it('drops flushed events that are outside the model surface', () => {
    const session = Session.create(SessionId('drop-off-surface'))
    populate(session)
    const store = new Map(session.events.map(event => [event.seq, event]))
    const reads: number[][] = []
    session.attachMemoryArchive(mapArchive(store, reads), 0)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()

    expect(session.residentSeqs()).toEqual([1, 3])
    expect(session.surface.nodes).toEqual([1, 3])
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant'])
    expect(reads).toEqual([])
  })

  it('re-reads dropped seqs on demand and keeps the model surface reconstructable', () => {
    const session = Session.create(SessionId('hydrate'))
    populate(session)
    const store = new Map(session.events.map(event => [event.seq, event]))
    const reads: number[][] = []
    session.attachMemoryArchive(mapArchive(store, reads), 0)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()

    const events = session.events
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'assistant/chunk', 'assistant/message', 'turn/end',
    ])
    expect(events[2]).toEqual(store.get(2))
    expect(reads).toEqual([[0, 2, 4]])
    expect(session.residentSeqs()).toEqual([1, 3])
  })

  it('keeps a configured trailing window of recent seqs', () => {
    const session = Session.create(SessionId('tail-window'))
    populate(session)
    const store = new Map(session.events.map(event => [event.seq, event]))
    session.attachMemoryArchive(mapArchive(store), 2)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()

    expect(session.residentSeqs()).toEqual([1, 3, 4])
  })

  it('never drops unflushed events', () => {
    const session = Session.create(SessionId('unflushed'))
    populate(session)
    const store = new Map(session.events.map(event => [event.seq, event]))
    session.attachMemoryArchive(mapArchive(store), 0)
    session.markDurableThrough(1)
    session.releaseFlushedOutsideSurface()

    expect(session.residentSeqs()).toEqual([1, 2, 3, 4])
  })

  it('drops surface nodes shadowed by a replace once they are flushed', () => {
    const session = Session.create(SessionId('compaction-elision'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'old-a' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1] })
    const store = new Map(session.events.map(event => [event.seq, event]))
    session.attachMemoryArchive(mapArchive(store), 0)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()

    expect(session.surface.nodes).toEqual([2])
    expect(session.residentSeqs()).toEqual([2])
    expect(session.deriveMessages()).toHaveLength(1)
    expect(session.events.map(event => event.type)).toEqual([
      'user/message', 'assistant/message', 'user/message',
    ])
  })

  it('fails loud on a non-integer or negative window', () => {
    const session = Session.create(SessionId('bad-window'))
    expect(() => session.attachMemoryArchive({ read: () => [] }, -1))
      .toThrow(/inMemoryLogWindow must be a non-negative integer/)
    expect(() => session.attachMemoryArchive({ read: () => [] }, 1.5))
      .toThrow(/inMemoryLogWindow must be a non-negative integer/)
  })

  it('fails loud when hydrate runs after the archive has been lost', () => {
    const session = Session.create(SessionId('lost-archive'))
    populate(session)
    const store = new Map(session.events.map(event => [event.seq, event]))
    session.attachMemoryArchive(mapArchive(store), 0)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()
    delete (session as unknown as { archive?: SessionEventArchive }).archive
    expect(() => session.events).toThrow(/has no durable archive to re-read/)
  })

  it('fails loud when release runs with a window and no archive', () => {
    const session = Session.create(SessionId('release-without-archive'))
    populate(session)
    const store = new Map(session.events.map(event => [event.seq, event]))
    session.attachMemoryArchive(mapArchive(store), 0)
    delete (session as unknown as { archive?: SessionEventArchive }).archive
    session.markDurableThrough(session.seq - 1)
    expect(() => session.releaseFlushedOutsideSurface())
      .toThrow(/no durable event archive is attached/)
  })

  it('fails loud when hydrate cannot reconstruct a dropped seq', () => {
    const session = Session.create(SessionId('archive-gap'))
    populate(session)
    session.attachMemoryArchive({
      read: seqs => seqs.slice(0, -1).map(seq => ({
        type: 'turn/start', seq, time: 1, data: { turn: 1 },
      })),
    }, 0)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()
    expect(() => session.events).toThrow(/archive returned/)
  })

  it('fails loud when the archive returns a mismatched seq', () => {
    const session = Session.create(SessionId('archive-mismatch'))
    populate(session)
    session.attachMemoryArchive({
      read: seqs => seqs.map(seq => ({
        type: 'turn/start', seq: seq + 1, time: 1, data: { turn: 1 },
      })),
    }, 0)
    session.markDurableThrough(session.seq - 1)
    session.releaseFlushedOutsideSurface()
    expect(() => session.events).toThrow(/where .* was requested/)
  })

  it('rejects a durable mark past the live log', () => {
    const session = Session.create(SessionId('bad-durable'))
    expect(() => session.markDurableThrough(0)).toThrow(/outside session/)
    session.append('turn/start', { turn: 1 })
    session.markDurableThrough(0)
    expect(session.residentSeqs()).toEqual([0])
  })
})
