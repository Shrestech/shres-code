// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@roos-code/schemastery'
import { bindSnapshotSelector } from '@roos-code/roos-code-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@roos-code/roos-code-api-remotes/client'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { seatValueOf, writeSeat } from '../src/client/SeatsCard.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

const SeatsConfig = Schema.object({
  seats: Schema.object({
    boomer: Schema.object({ provider: Schema.string(), model: Schema.string() }),
    joey: Schema.object({ provider: Schema.string(), model: Schema.string() }),
    flyer: Schema.object({ provider: Schema.string(), model: Schema.string() }),
  }),
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
    expect(seatValueOf({ seats: { boomer: { provider: 'ollama-cloud', model: 'kimi-k3' } } }, 'boomer'))
      .toEqual({ provider: 'ollama-cloud', model: 'kimi-k3' })
    expect(seatValueOf({}, 'joey')).toEqual({})
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    await writeSeat({ settings: { mutate } as never }, 'flyer', { provider: 'p', model: 'm' })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'agent-seats',
      ops: [{ op: 'set', path: ['seats', 'flyer'], value: { provider: 'p', model: 'm' } }],
    })
    await writeSeat({ settings: { mutate } as never }, 'flyer', undefined)
    expect(mutate).toHaveBeenLastCalledWith({
      ns: 'agent-seats',
      ops: [{ op: 'unset', path: ['seats', 'flyer'] }],
    })
  })
})

describe('SeatsCard', () => {
  it('shows Architect / Worker / Reviewer copy and binds an enabled provider', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok(seatsNamespace())))
    const face = {
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
      },
      credentials: {
        describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))),
      },
    }
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
    expect(screen.getByText(en.seatBoomerRole)).toBeTruthy()
    expect(screen.getByText(en.seatJoeyRole)).toBeTruthy()
    expect(screen.getByText(en.seatFlyerRole)).toBeTruthy()
    expect(screen.getByText(en.seatBoomerDescription)).toBeTruthy()
    await waitFor(() => {
      expect(face.llm.models).toHaveBeenCalled()
    })
    fireEvent.change(screen.getByLabelText(`${en.seatBoomerName} ${en.seatsProvider}`), {
      target: { value: 'ollama-cloud' },
    })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'agent-seats',
        ops: [{ op: 'set', path: ['seats', 'boomer'], value: { provider: 'ollama-cloud' } }],
      })
    })
  })
})
