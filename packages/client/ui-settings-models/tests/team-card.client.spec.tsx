// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@shres-code/schemastery'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { membersOf, memberDraftValid, seatValueOf, writeMembers, writeSeat, writeSeatPersona } from '../src/client/TeamCard.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const SeatsConfig = Schema.object({
  seats: Schema.object({
    aegis: Schema.object({ provider: Schema.string(), model: Schema.string(), persona: Schema.string() }),
    stride: Schema.object({ provider: Schema.string(), model: Schema.string(), persona: Schema.string() }),
    ward: Schema.object({ provider: Schema.string(), model: Schema.string(), persona: Schema.string() }),
    subagent: Schema.object({ provider: Schema.string(), model: Schema.string() }),
  }),
  extras: Schema.array(Schema.object({
    name: Schema.string(),
    persona: Schema.string(),
    provider: Schema.string(),
    model: Schema.string(),
  })),
})

function seatsNamespace(value: unknown = {}): SettingsNamespaceView {
  return {
    ns: 'agent-seats',
    schema: JSON.parse(JSON.stringify(SeatsConfig.toJSON())) as unknown,
    value,
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}

describe('seatValueOf / writeSeat', () => {
  it('reads a stored binding and writes set/unset ops', async () => {
    expect(seatValueOf({ seats: { aegis: { provider: 'ollama-cloud', model: 'kimi-k3' } } }, 'aegis'))
      .toEqual({ provider: 'ollama-cloud', model: 'kimi-k3' })
    expect(seatValueOf({}, 'stride')).toEqual({})
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    await writeSeat({ settings: { mutate } as never }, 'ward', { provider: 'p', model: 'm' })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'agent-seats',
      ops: [{ op: 'set', path: ['seats', 'ward'], value: { provider: 'p', model: 'm' } }],
    })
    await writeSeat({ settings: { mutate } as never }, 'ward', undefined)
    expect(mutate).toHaveBeenLastCalledWith({
      ns: 'agent-seats',
      ops: [{ op: 'unset', path: ['seats', 'ward'] }],
    })
  })
})

function buildFace(mutate: ReturnType<typeof vi.fn>) {
  return {
    llm: {
      providers: vi.fn(() => Promise.resolve(ok({
        providers: [
          {
            provider: 'ollama-cloud', displayName: 'Ollama Cloud',
            settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'ollama-cloud'], active: true,
          },
        ],
      }))),
      models: vi.fn(() => Promise.resolve(ok({
        groups: [{
          id: 'ollama-cloud',
          name: 'Ollama Cloud',
          models: [{ id: 'kimi-k3', name: 'Kimi K3' }],
        }],
        failures: [],
      }))),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [
          seatsNamespace(),
          {
            ns: 'llm-pi-ai',
            schema: JSON.parse(JSON.stringify(Schema.object({
              providers: Schema.dict(Schema.object({ enabled: Schema.boolean() })),
            }).toJSON())) as unknown,
            value: { providers: { 'ollama-cloud': {} } },
            applies: 'live',
            secrets: [],
            revision: 0,
          },
        ],
      }))),
      mutate,
      openDocument: vi.fn(() => Promise.resolve(ok({}))),
    },
    credentials: {
      describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))),
    },
  }
}
describe('TeamCard', () => {
  it('shows Architect / Worker / Reviewer copy and binds an enabled provider', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace())))
    const face = buildFace(mutate)
    const controller = new ModelsSettingsStore(face as never)
    await controller.load()
    render(
      <ModelsSection
        controller={controller}
        useSnapshot={bindSnapshotSelector(controller.store)}
        api={face as never}
        t={t}
      />,
    )
    expect(screen.getByText(en.seatsTitle)).toBeTruthy()
    expect(screen.getByText(en.seatAegisRole)).toBeTruthy()
    expect(screen.getByText(en.seatStrideRole)).toBeTruthy()
    expect(screen.getByText(en.seatWardRole)).toBeTruthy()
    expect(screen.getByText(en.seatSubagentName)).toBeTruthy()
    expect(screen.getByText(en.seatSubagentRole)).toBeTruthy()
    expect(screen.getByText(en.seatSubagentDescription)).toBeTruthy()
    expect(screen.getByText(en.seatAegisDescription)).toBeTruthy()
    await waitFor(() => {
      expect(face.llm.models).toHaveBeenCalled()
    })
    fireEvent.change(screen.getByLabelText(`${en.seatAegisName} ${en.seatsProvider}`), {
      target: { value: 'ollama-cloud' },
    })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [{ op: 'set', path: ['seats', 'aegis'], value: { provider: 'ollama-cloud' } }],
      })
    })
    fireEvent.change(screen.getByLabelText(`${en.seatSubagentName} ${en.seatsProvider}`), {
      target: { value: 'ollama-cloud' },
    })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [{ op: 'set', path: ['seats', 'subagent'], value: { provider: 'ollama-cloud' } }],
      })
    })
  })

  it('commits an edited persona on blur and restores the default with an empty value', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace({ seats: { aegis: { provider: 'ollama-cloud', model: 'kimi-k3' } } }))))
    const face = buildFace(mutate)
    const controller = new ModelsSettingsStore(face as never)
    await controller.load()
    render(
      <ModelsSection
        controller={controller}
        useSnapshot={bindSnapshotSelector(controller.store)}
        api={face as never}
        t={t}
      />,
    )
    const persona = screen.getByLabelText(`${en.seatAegisName} ${en.seatsPersona}`)
    fireEvent.change(persona, { target: { value: '  You are the planning seat.  ' } })
    fireEvent.blur(persona)
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [{ op: 'set', path: ['seats', 'aegis', 'persona'], value: 'You are the planning seat.' }],
      })
    })
  })

  it('opens the configuration file from the card header', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace())))
    const face = buildFace(mutate)
    const controller = new ModelsSettingsStore(face as never)
    await controller.load()
    render(
      <ModelsSection
        controller={controller}
        useSnapshot={bindSnapshotSelector(controller.store)}
        api={face as never}
        t={t}
      />,
    )
    fireEvent.click(screen.getByText(en.teamOpenDocument))
    await waitFor(() => {
      expect(face.settings.openDocument).toHaveBeenCalled()
    })
  })
})

describe('TeamCard member helpers', () => {
  it('reads members, validates drafts, and writes the complete member list', async () => {
    const stored = [{ name: 'docs-reviewer', persona: 'Review docs.', provider: 'deepseek', model: 'kimi-k3' }]
    expect(membersOf({ extras: stored })).toEqual(stored)
    expect(membersOf({})).toEqual([])
    expect(memberDraftValid({ name: 'docs-reviewer', persona: 'p', provider: 'a', model: 'm' }, stored)).toBe(false)
    expect(memberDraftValid({ name: 'Docs', persona: 'p', provider: 'a', model: 'm' }, stored)).toBe(false)
    expect(memberDraftValid({ name: 'lead', persona: 'p', provider: 'a', model: 'm' }, stored)).toBe(false)
    expect(memberDraftValid({ name: 'note-taker', persona: ' ', provider: 'a', model: 'm' }, stored)).toBe(false)
    expect(memberDraftValid({ name: 'note-taker', persona: 'p', provider: 'a', model: 'm' }, stored)).toBe(true)
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    await writeMembers({ settings: { mutate } as never }, [{ name: 'note-taker', persona: 'p', provider: 'a', model: 'm' }])
    expect(mutate).toHaveBeenCalledWith({
      ns: 'agent-seats',
      ops: [{ op: 'set', path: ['extras'], value: [{ name: 'note-taker', persona: 'p', provider: 'a', model: 'm' }] }],
    })
    await writeSeatPersona({ settings: { mutate } as never }, 'ward', undefined)
    expect(mutate).toHaveBeenLastCalledWith({
      ns: 'agent-seats',
      ops: [{ op: 'unset', path: ['seats', 'ward', 'persona'] }],
    })
  })
})
