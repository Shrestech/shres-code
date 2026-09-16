// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@shres-code/schemastery'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { membersOf, memberDraftValid, seatValueOf, writeMembers, writeSeat } from '../src/client/TeamCard.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const SeatsConfig = Schema.object({
  seats: Schema.object({
    aegis: Schema.object({ provider: Schema.string(), model: Schema.string() }),
    stride: Schema.object({ provider: Schema.string(), model: Schema.string() }),
    ward: Schema.object({ provider: Schema.string(), model: Schema.string() }),
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
  it('reads a stored binding and writes field path ops', async () => {
    expect(seatValueOf({
      seats: { aegis: { provider: 'ollama-cloud', model: 'kimi-k3' } },
    }, 'aegis')).toEqual({
      provider: 'ollama-cloud',
      model: 'kimi-k3',
    })
    expect(seatValueOf({}, 'stride')).toEqual({})
    expect(seatValueOf({ seats: { aegis: { provider: 1, model: 2 } } }, 'aegis')).toEqual({})
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    await writeSeat({ settings: { mutate } as never }, 'ward', { provider: 'p', model: 'm' })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'agent-seats',
      ops: [
        { op: 'set', path: ['seats', 'ward', 'provider'], value: 'p' },
        { op: 'set', path: ['seats', 'ward', 'model'], value: 'm' },
      ],
    })
    await writeSeat({ settings: { mutate } as never }, 'ward', undefined)
    expect(mutate).toHaveBeenLastCalledWith({
      ns: 'agent-seats',
      ops: [
        { op: 'unset', path: ['seats', 'ward', 'provider'] },
        { op: 'unset', path: ['seats', 'ward', 'model'] },
      ],
    })
  })
})

function buildFace(mutate: ReturnType<typeof vi.fn>, seatsValue: unknown = {}) {
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
          seatsNamespace(seatsValue),
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
        ops: [
          { op: 'set', path: ['seats', 'aegis', 'provider'], value: 'ollama-cloud' },
          { op: 'unset', path: ['seats', 'aegis', 'model'] },
        ],
      })
    })
    fireEvent.change(screen.getByLabelText(`${en.seatSubagentName} ${en.seatsProvider}`), {
      target: { value: 'ollama-cloud' },
    })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [
          { op: 'set', path: ['seats', 'subagent', 'provider'], value: 'ollama-cloud' },
          { op: 'unset', path: ['seats', 'subagent', 'model'] },
        ],
      })
    })
  })

  it('does not offer a persona field for Aegis, Stride, or Ward', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace())))
    const face = buildFace(mutate, {
      seats: { aegis: { provider: 'ollama-cloud', model: 'kimi-k3' } },
    })
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
    expect(screen.queryByRole('textbox', { name: /Aegis/ })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Stride/ })).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Ward/ })).toBeNull()
    expect(screen.getByLabelText(en.teamMemberPersona)).toBeTruthy()
  })

  it('opens the shipped persona for each product seat from the wrap-text control', async () => {
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
    expect(screen.queryByRole('button', { name: `${en.seatSubagentName} ${en.seatsPersona}` })).toBeNull()
    expect(screen.queryByText(en.seatAegisPersona)).toBeNull()
    const aegis = screen.getByRole('button', { name: `${en.seatAegisName} ${en.seatsPersona}` })
    fireEvent.click(aegis)
    expect(screen.getByText(en.seatAegisPersona)).toBeTruthy()
    expect(aegis.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: `${en.seatStrideName} ${en.seatsPersona}` }))
    fireEvent.click(screen.getByRole('button', { name: `${en.seatWardName} ${en.seatsPersona}` }))
    expect(screen.getByText(en.seatStridePersona)).toBeTruthy()
    expect(screen.getByText(en.seatWardPersona)).toBeTruthy()
    fireEvent.click(aegis)
    expect(screen.queryByText(en.seatAegisPersona)).toBeNull()
    expect(aegis.getAttribute('aria-expanded')).toBe('false')
  })

  it('writes model path ops, keeps an unknown catalog id, and ignores a model change while unbound', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace())))
    const face = buildFace(mutate, {
      seats: { aegis: { provider: 'ollama-cloud', model: 'legacy-id' } },
    })
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
    await waitFor(() => {
      expect(face.llm.models).toHaveBeenCalled()
    })
    expect(screen.getByText('legacy-id')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(`${en.seatAegisName} ${en.seatsModel}`), {
      target: { value: 'kimi-k3' },
    })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [
          { op: 'set', path: ['seats', 'aegis', 'provider'], value: 'ollama-cloud' },
          { op: 'set', path: ['seats', 'aegis', 'model'], value: 'kimi-k3' },
        ],
      })
    })
    fireEvent.change(screen.getByLabelText(`${en.seatAegisName} ${en.seatsModel}`), {
      target: { value: '' },
    })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [
          { op: 'set', path: ['seats', 'aegis', 'provider'], value: 'ollama-cloud' },
          { op: 'unset', path: ['seats', 'aegis', 'model'] },
        ],
      })
    })
    fireEvent.change(screen.getByLabelText(`${en.seatAegisName} ${en.seatsProvider}`), {
      target: { value: '' },
    })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [
          { op: 'unset', path: ['seats', 'aegis', 'provider'] },
          { op: 'unset', path: ['seats', 'aegis', 'model'] },
        ],
      })
    })
    fireEvent.change(screen.getByLabelText(`${en.seatStrideName} ${en.seatsModel}`), {
      target: { value: 'kimi-k3' },
    })
    expect(mutate).toHaveBeenCalledTimes(3)
  })

  it('adds and removes custom members through the card form', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace())))
    const face = buildFace(mutate, {
      extras: [
        { name: 'docs-reviewer', persona: 'Review docs.', provider: 'ollama-cloud', model: 'kimi-k3' },
        { persona: 'Incomplete row.' },
      ],
    })
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
    await waitFor(() => {
      expect(face.llm.models).toHaveBeenCalled()
    })
    expect(screen.getByText('docs-reviewer')).toBeTruthy()
    expect(screen.getByText('? / ?')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(`${en.teamRemoveMember} docs-reviewer`))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [{ op: 'set', path: ['extras'], value: [{ persona: 'Incomplete row.' }] }],
      })
    })
    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[1]!)
    fireEvent.change(screen.getByLabelText(en.teamMemberName), { target: { value: 'note-taker' } })
    fireEvent.change(screen.getByLabelText(en.teamMemberPersona), { target: { value: 'Take notes.' } })
    fireEvent.change(screen.getByLabelText(`${en.teamAddMember} ${en.seatsProvider}`), {
      target: { value: 'ollama-cloud' },
    })
    fireEvent.change(screen.getByLabelText(`${en.teamAddMember} ${en.seatsModel}`), {
      target: { value: 'kimi-k3' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.teamAddMember }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [{
          op: 'set',
          path: ['extras'],
          value: [
            { name: 'docs-reviewer', persona: 'Review docs.', provider: 'ollama-cloud', model: 'kimi-k3' },
            { persona: 'Incomplete row.' },
            { name: 'note-taker', persona: 'Take notes.', provider: 'ollama-cloud', model: 'kimi-k3' },
          ],
        }],
      })
    })
  })

  it('falls back to provider rows when the catalog fails and still hides without agent-seats', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace())))
    const face = buildFace(mutate)
    face.llm.models = vi.fn(() => Promise.resolve({
      rpcId: `r-${nextRpc++}` as never,
      result: { ok: false, error: { code: 'unavailable', message: 'no catalog' } },
    } as never))
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
    await waitFor(() => {
      expect(face.llm.models).toHaveBeenCalled()
    })
    expect(screen.getByLabelText(`${en.seatAegisName} ${en.seatsProvider}`)).toBeTruthy()
    const empty = buildFace(mutate)
    empty.settings.describe = vi.fn(() => Promise.resolve(ok({
      writable: true,
      hasDocument: false,
      namespaces: [],
    })))
    const emptyController = new ModelsSettingsStore(empty as never)
    await emptyController.load()
    cleanup()
    render(
      <ModelsSection
        controller={emptyController}
        useSnapshot={bindSnapshotSelector(emptyController.store)}
        api={empty as never}
        t={t}
      />,
    )
    expect(screen.queryByText(en.seatsTitle)).toBeNull()
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
  })
})
