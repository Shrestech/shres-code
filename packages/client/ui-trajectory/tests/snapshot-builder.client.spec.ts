import { describe, expect, it } from 'vitest'
import type {
  AssistantMessageNode, PartialAssistant, RequestView,
} from '@shres-code/shres-code-client-runtime/client'
import type {
  TrajectoryContribution, TrajectoryConversationViewNode, TrajectoryRequestHeaderState,
} from '../src/client/trajectory-contract.ts'
import { TrajectorySnapshotBuilder } from '../src/client/trajectory-snapshot-builder.ts'

function assistantRequest(startSeq: number, step: number): Extract<RequestView, { purpose: 'assistant' }> {
  return {
    purpose: 'assistant',
    startSeq,
    turn: 1,
    step,
    startedAt: startSeq,
    completedAt: startSeq + 1,
    status: 'complete',
  }
}

function assistantNode(seq: number, text: string): AssistantMessageNode {
  return {
    kind: 'assistant',
    seq,
    time: seq,
    turn: 1,
    step: 1,
    blocks: [{ kind: 'text', text }],
  }
}

function partialAssistant(text: string): PartialAssistant {
  return { turn: 1, step: 2, blocks: [{ kind: 'text', text }] }
}

function contribution(
  key: string,
  anchorSeq: number,
  data: TrajectoryContribution,
): TrajectoryConversationViewNode {
  return {
    key, kind: key, id: key, target: 'trajectory', anchorSeq,
    location: { kind: 'session' },
    data,
  }
}

function stepLocation(turn: number, step: number): TrajectoryRequestHeaderState['location'] {
  const data = { get: () => undefined }
  const stepLocation = {
    turn,
    step,
    start: undefined,
    end: undefined,
    status: 'unknown' as const,
    data,
  }
  const turnLocation = {
    turn,
    start: undefined,
    end: undefined,
    status: 'unknown' as const,
    steps: [stepLocation],
    data,
  }
  return { kind: 'step', turn: turnLocation, step: stepLocation }
}

function compactionRequest(startSeq: number): Extract<RequestView, { purpose: 'compaction' }> {
  return {
    purpose: 'compaction',
    startSeq,
    turn: null,
    step: 0,
    startedAt: startSeq,
    completedAt: null,
    status: 'running',
  }
}

describe('TrajectorySnapshotBuilder', () => {
  it('inherits one request header across requests without repeating its prompt change', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'one initial prompt',
      tools: [],
    }
    const nodes: TrajectoryConversationViewNode[] = [
      {
        key: 'header',
        kind: 'trajectory-request-header',
        id: '2',
        target: 'trajectory',
        anchorSeq: 2,
        location: { kind: 'session' },
        data: {
          kind: 'request-header',
          header: {
            seq: 2,
            time: 2,
            prompt,
            change: { seq: 2, time: 2, kind: 'initial' },
            location: { kind: 'session' },
          },
        },
      },
      ...[assistantRequest(3, 1), assistantRequest(5, 2)].map(request => ({
        key: `assistant:${request.step}`,
        kind: 'trajectory-assistant-step',
        id: `1:${request.step}`,
        target: 'trajectory' as const,
        anchorSeq: request.startSeq,
        location: { kind: 'session' as const },
        data: { kind: 'assistant' as const, partial: null, request },
      })),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['one initial prompt', 'one initial prompt'])
    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.kind
      : undefined)).toEqual(['initial', undefined])
  })

  it('indexes exact step headers and the active tool schema without backward scans', () => {
    const basePrompt = {
      config: { provider: 'test', model: 'base' },
      system: 'base prompt',
      tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
    }
    const exactPrompt = {
      config: { provider: 'test', model: 'exact' },
      system: 'exact prompt',
      tools: [{ name: 'edit', description: 'Edit', parameters: { type: 'object' } }],
    }
    const nodes: TrajectoryConversationViewNode[] = [
      contribution('header:base', 2, {
        kind: 'request-header',
        header: {
          seq: 2,
          time: 2,
          prompt: basePrompt,
          change: { seq: 2, time: 2, kind: 'initial' },
          location: { kind: 'session' },
        },
      }),
      contribution('assistant:1', 3, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(3, 1),
      }),
      contribution('assistant:2', 5, {
        kind: 'assistant',
        partial: null,
        request: assistantRequest(5, 2),
      }),
      contribution('header:exact', 6, {
        kind: 'request-header',
        header: {
          seq: 6,
          time: 6,
          prompt: exactPrompt,
          change: { seq: 6, time: 6, kind: 'system', previous: basePrompt },
          location: stepLocation(1, 2),
        },
      }),
      contribution('tool', 7, {
        kind: 'tool',
        root: {
          callId: 'call-edit',
          name: 'edit',
          argsRaw: '{}',
          turn: 1,
          step: 2,
          time: 7,
          callView: null,
          subCalls: [],
        },
      }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['base prompt', 'exact prompt'])
    expect(snapshot.callSchemas.get('call-edit')).toEqual(exactPrompt.tools[0])
  })

  it('applies session boundaries and turn errors with linear request indexes', () => {
    const nodes: TrajectoryConversationViewNode[] = [
      ...[assistantRequest(1, 1), assistantRequest(3, 2)].map(request => contribution(
        `assistant:${request.step}`,
        request.startSeq,
        { kind: 'assistant', partial: null, request },
      )),
      contribution('turn-end', 5, {
        kind: 'turn-end',
        turn: 1,
        time: 5,
        error: 'turn failed',
      }),
      contribution('compact:10', 10, {
        kind: 'compaction',
        request: compactionRequest(10),
      }),
      contribution('compact:12', 12, {
        kind: 'compaction',
        request: compactionRequest(12),
      }),
      contribution('session-end:14', 14, { kind: 'session-end', seq: 14, time: 14 }),
      contribution('session-end:16', 16, { kind: 'session-end', seq: 16, time: 16 }),
    ]

    const snapshot = new TrajectorySnapshotBuilder().replace({ nodes })

    expect(snapshot.requests).toMatchObject([
      { purpose: 'assistant', step: 1, status: 'complete' },
      { purpose: 'assistant', step: 2, status: 'error', error: 'turn failed' },
      { purpose: 'compaction', startSeq: 10, status: 'error', completedAt: 16 },
      { purpose: 'compaction', startSeq: 12, status: 'error', completedAt: 14 },
    ])
  })

  it('keeps cached contribution order across content updates and structural inserts', () => {
    const builder = new TrajectorySnapshotBuilder()
    const first = contribution('assistant:1', 1, {
      kind: 'assistant', partial: null, request: assistantRequest(1, 1),
    })
    const last = contribution('assistant:3', 5, {
      kind: 'assistant', partial: null, request: assistantRequest(5, 3),
    })
    expect(builder.replace({ nodes: [last, first] }).requests.map(request => request.startSeq))
      .toEqual([1, 5])

    const updatedLast = contribution('assistant:3', 5, {
      kind: 'assistant',
      partial: null,
      request: { ...assistantRequest(5, 3), status: 'error', error: 'failed' },
    })
    expect(builder.apply({ upserts: [updatedLast] }).requests.map(request => request.startSeq))
      .toEqual([1, 5])

    const middle = contribution('assistant:2', 3, {
      kind: 'assistant', partial: null, request: assistantRequest(3, 2),
    })
    expect(builder.apply({ upserts: [middle] }).requests.map(request => request.startSeq))
      .toEqual([1, 3, 5])
  })

  it('updates a streamed partial without rebuilding historical nodes, locations, or requests', () => {
    const prompt = {
      config: { provider: 'test', model: 'test' },
      system: 'system',
      tools: [],
    }
    const historical = contribution('assistant:1', 1, {
      kind: 'assistant',
      node: assistantNode(1, 'history'),
      partial: null,
      request: assistantRequest(1, 1),
    })
    const activeRequest = {
      ...assistantRequest(5, 2),
      prompt,
      requestConfig: prompt.config,
      promptChange: { seq: 2, time: 2, kind: 'initial' as const },
    }
    const active = contribution('assistant:2', 5, {
      kind: 'assistant',
      partial: partialAssistant('a'),
      request: activeRequest,
    })
    const builder = new TrajectorySnapshotBuilder()
    const first = builder.replace({ nodes: [historical, active] })
    const updated = {
      ...active,
      data: {
        kind: 'assistant' as const,
        partial: partialAssistant('ab'),
        request: { ...activeRequest },
      },
    }

    const second = builder.apply({ upserts: [updated] })

    expect(second.eventNodes).toBe(first.eventNodes)
    expect(second.eventLocations).toBe(first.eventLocations)
    expect(second.requests).toBe(first.requests)
    expect(second.requests[1]).toBe(first.requests[1])
    expect(second.requests[1]).toMatchObject({
      startSeq: 5,
      startedAt: 5,
      prompt,
      requestConfig: prompt.config,
      promptChange: activeRequest.promptChange,
    })
    expect(second.partial).toEqual(updated.data.partial)
    expect(second.partial).not.toBe(first.partial)

    const withUsage = {
      ...updated,
      data: {
        ...updated.data,
        partial: partialAssistant('abc'),
        request: { ...activeRequest, usage: { inputTokens: 3, outputTokens: 2 } },
      },
    }
    const third = builder.apply({ upserts: [withUsage] })
    expect(third.eventNodes).toBe(second.eventNodes)
    expect(third.eventLocations).toBe(second.eventLocations)
    expect(third.requests).not.toBe(second.requests)
    expect(third.requests[0]).toBe(second.requests[0])
    expect(third.requests[1]).not.toBe(second.requests[1])
    expect(third.requests[1]).toMatchObject({ usage: { inputTokens: 3, outputTokens: 2 } })
    expect(third.partial).toEqual(withUsage.data.partial)

    const settled = {
      ...withUsage,
      data: {
        kind: 'assistant' as const,
        node: assistantNode(8, 'abc'),
        partial: null,
        request: { ...activeRequest, completedAt: 8, status: 'complete' as const, resultSeq: 8 },
      },
    }
    const fourth = builder.apply({ upserts: [settled] })
    expect(fourth.eventNodes).not.toBe(third.eventNodes)
    expect(fourth.eventNodes).toEqual([assistantNode(1, 'history'), assistantNode(8, 'abc')])
    expect(fourth.partial).toBeNull()
    expect(fourth.requests).toMatchObject([
      {},
      { startSeq: 5, status: 'complete', resultSeq: 8 },
    ])
  })
})
