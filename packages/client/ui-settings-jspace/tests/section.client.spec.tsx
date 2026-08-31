// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JSpaceSection, writeAdvisorRoute, writeWikiLibrarian,
  type AdvisorSettings, type JSpaceSettings, type WikiSettings,
} from '../src/client/JSpaceSection.tsx'
import type { JSpaceCardView } from '../src/client/card-source.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@shres-code/shres-code-client-runtime/client'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function snapshot(partial: Partial<SettingsScopeSnapshot<JSpaceSettings>>): SettingsScopeSnapshot<JSpaceSettings> {
  return {
    status: 'ready',
    value: { mode: 'available' },
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
    ...partial,
  }
}

function sessionLabel(state: string): string {
  return `${en.session} · ${state}`
}

function wikiSnapshot(partial: Partial<SettingsScopeSnapshot<WikiSettings>> = {}): SettingsScopeSnapshot<WikiSettings> {
  return {
    status: 'ready',
    value: { enabled: true },
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
    ...partial,
  }
}

function advisorSnapshot(
  partial: Partial<SettingsScopeSnapshot<AdvisorSettings>> = {},
): SettingsScopeSnapshot<AdvisorSettings> {
  return {
    status: 'unavailable',
    value: undefined,
    base: {},
    user: {},
    revision: 1,
    writable: false,
    mode: 'host',
    ...partial,
  }
}

function mount(
  snap: SettingsScopeSnapshot<JSpaceSettings>,
  set = vi.fn(async () => {}),
  card?: JSpaceCardView,
  wikiSnap: SettingsScopeSnapshot<WikiSettings> = wikiSnapshot(),
  wikiSet = vi.fn(async () => {}),
  api = {
    settings: { mutate: vi.fn(async () => ({ rpcId: 'm', result: { ok: true, value: {} } })) },
    llm: {
      models: vi.fn(async () => ({
        rpcId: 'l',
        result: {
          ok: true as const,
          value: {
            groups: [
              { id: 'ollama-local', name: 'Ollama (local)', models: [{ id: 'qwen', name: 'Qwen' }] },
              { id: 'ollama-cloud', name: 'Ollama Cloud', models: [{ id: 'flash', name: 'Flash' }] },
            ],
          },
        },
      })),
    },
  },
  advisorSnap: SettingsScopeSnapshot<AdvisorSettings> = advisorSnapshot(),
  advisorSet = vi.fn(async () => {}),
) {
  const scope = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    set,
    unset: vi.fn(async () => {}),
  } as unknown as SettingsScope<JSpaceSettings>
  const wikiScope = {
    getSnapshot: () => wikiSnap,
    subscribe: () => () => {},
    set: wikiSet,
    unset: vi.fn(async () => {}),
  } as unknown as SettingsScope<WikiSettings>
  const advisorScope = {
    getSnapshot: () => advisorSnap,
    subscribe: () => () => {},
    set: advisorSet,
    unset: vi.fn(async () => {}),
  } as unknown as SettingsScope<AdvisorSettings>
  render(
    <JSpaceSection
      scope={scope}
      useSnapshot={select => select(snap)}
      wikiScope={wikiScope}
      useWikiSnapshot={select => select(wikiSnap)}
      advisorScope={advisorScope}
      useAdvisorSnapshot={select => select(advisorSnap)}
      useCard={select => select(card)}
      api={api as never}
      t={key => en[key]}
      useSessions={select => select({ current: 's-test' } as never)}
      useWorkspaces={() => undefined as never}
      close={vi.fn()}
    />,
  )
  return { set, wikiSet, advisorSet, api }
}

describe('JSpaceSection', () => {
  it('toggles the activate switch', () => {
    const { set } = mount(snapshot({ value: { enabled: false, mode: 'available' } }))
    fireEvent.click(screen.getByRole('switch', { name: en.activate }))
    expect(set).toHaveBeenCalledWith('enabled', true)
    expect(screen.getByText(en.inactive)).toBeTruthy()
  })

  it('writes mode on change', () => {
    const { set } = mount(snapshot({}))
    fireEvent.change(screen.getByLabelText(en.mode), { target: { value: 'always-open' } })
    expect(set).toHaveBeenCalledWith('mode', 'always-open')
  })

  it('ignores an unknown mode value', () => {
    const { set } = mount(snapshot({}))
    fireEvent.change(screen.getByLabelText(en.mode), { target: { value: 'nope' } })
    expect(set).not.toHaveBeenCalled()
  })

  it('toggles requireCoverage', () => {
    const { set } = mount(snapshot({ value: { requireCoverage: true } }))
    fireEvent.click(screen.getByRole('switch', { name: en.requireCoverage }))
    expect(set).toHaveBeenCalledWith('requireCoverage', false)
  })

  it('shows last-known open card counts', () => {
    mount(snapshot({}), vi.fn(async () => {}), { open: true, checked: 3 })
    expect(screen.getByText((_, node) => node?.textContent === sessionLabel(en.open))).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText(en.coverageHonesty)).toBeTruthy()
  })

  it('shows a closed card and keeps the checked count', () => {
    mount(snapshot({ value: { enabled: false } }), vi.fn(async () => {}), { open: false, checked: 2 })
    expect(screen.getByText((_, node) => node?.textContent === sessionLabel(en.closed))).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByText(en.inactive)).toBeTruthy()
  })

  it('shows an em dash when no card is known', () => {
    mount(snapshot({}))
    expect(screen.getByText((_, node) => node?.textContent === sessionLabel('—'))).toBeTruthy()
    expect(screen.getByText('—', { selector: 'dd' })).toBeTruthy()
  })

  it('shows settings loading without a switch', () => {
    mount(
      snapshot({ status: 'loading', value: undefined, writable: false }),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ status: 'unavailable', value: undefined, writable: false }),
    )
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByText(en.coverageHonesty)).toBeTruthy()
  })

  it('explains when the host seat is not mounted', () => {
    mount(
      snapshot({ status: 'unavailable', value: undefined, writable: false }),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ status: 'unavailable', value: undefined, writable: false }),
    )
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('disables writes when the settings document is read-only', () => {
    mount(snapshot({ writable: false, value: { enabled: true, mode: 'available' } }))
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByRole('switch', { name: en.disable }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('switch', { name: en.requireCoverage }).hasAttribute('disabled')).toBe(true)
  })

  it('turns requireCoverage on from an explicit false value', () => {
    const { set } = mount(snapshot({ value: { requireCoverage: false } }))
    fireEvent.click(screen.getByRole('switch', { name: en.requireCoverage }))
    expect(set).toHaveBeenCalledWith('requireCoverage', true)
  })

  it('toggles LLM Wiki and hides model pickers when disabled', () => {
    const { wikiSet } = mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ value: { enabled: true } }),
    )
    expect(screen.getByText(en.wikiIntro)).toBeTruthy()
    expect(screen.getByLabelText(`${en.wikiLibrarian} ${en.wikiProvider}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: en.wikiDisable }))
    expect(wikiSet).toHaveBeenCalledWith('enabled', false)
    cleanup()
    const { api } = mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ value: { enabled: false } }),
    )
    expect(screen.queryByLabelText(`${en.wikiLibrarian} ${en.wikiProvider}`)).toBeNull()
    expect(api.llm.models).not.toHaveBeenCalled()
  })

  it('writes the librarian provider and model', async () => {
    const { api } = mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({
        value: { enabled: true, roles: { librarian: { provider: 'ollama-local' } } },
      }),
    )
    await screen.findByRole('option', { name: 'Ollama Cloud' })
    fireEvent.change(screen.getByLabelText(`${en.wikiLibrarian} ${en.wikiProvider}`), {
      target: { value: 'ollama-cloud' },
    })
    expect(api.settings.mutate).toHaveBeenCalledWith({
      ns: 'wiki',
      ops: [{ op: 'set', path: ['roles', 'librarian'], value: { provider: 'ollama-cloud' } }],
    })
    fireEvent.change(screen.getByLabelText(`${en.wikiLibrarian} ${en.wikiModel}`), {
      target: { value: '' },
    })
    expect(api.settings.mutate).toHaveBeenCalledWith({
      ns: 'wiki',
      ops: [{ op: 'set', path: ['roles', 'librarian'], value: { provider: 'ollama-local' } }],
    })
    fireEvent.change(screen.getByLabelText(`${en.wikiLibrarian} ${en.wikiModel}`), {
      target: { value: 'qwen' },
    })
    expect(api.settings.mutate).toHaveBeenCalledWith({
      ns: 'wiki',
      ops: [{ op: 'set', path: ['roles', 'librarian'], value: { provider: 'ollama-local', model: 'qwen' } }],
    })
    fireEvent.change(screen.getByLabelText(`${en.wikiLibrarian} ${en.wikiProvider}`), {
      target: { value: '' },
    })
    expect(api.settings.mutate).toHaveBeenCalledWith({
      ns: 'wiki',
      ops: [{ op: 'unset', path: ['roles', 'librarian'] }],
    })
    await writeWikiLibrarian(api as never, undefined)
  })

  it('ignores a failed models catalog lookup', async () => {
    mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ value: { enabled: true } }),
      vi.fn(async () => {}),
      {
        settings: { mutate: vi.fn(async () => ({ rpcId: 'm', result: { ok: true, value: {} } })) },
        llm: { models: vi.fn(async () => ({ rpcId: 'l', result: { ok: false as const, error: {} } })) },
      } as never,
    )
    await Promise.resolve()
    expect(screen.getByLabelText(`${en.wikiLibrarian} ${en.wikiProvider}`)).toBeTruthy()
  })

  it('toggles Advisor and hides model pickers when disabled', () => {
    const catalog = {
      settings: { mutate: vi.fn(async () => ({ rpcId: 'm', result: { ok: true, value: {} } })) },
      llm: {
        models: vi.fn(async () => ({
          rpcId: 'l',
          result: {
            ok: true as const,
            value: {
              groups: [
                { id: 'ollama-local', name: 'Ollama (local)', models: [{ id: 'qwen', name: 'Qwen' }] },
              ],
            },
          },
        })),
      },
    }
    const { advisorSet } = mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ value: { enabled: false } }),
      vi.fn(async () => {}),
      catalog as never,
      advisorSnapshot({ status: 'ready', writable: true, value: { enabled: true } }),
    )
    expect(screen.getByText(en.advisorIntro)).toBeTruthy()
    expect(screen.getByLabelText(`${en.advisorTitle} ${en.advisorProvider}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: en.advisorDisable }))
    expect(advisorSet).toHaveBeenCalledWith('enabled', false)
    cleanup()
    const idle = {
      settings: { mutate: vi.fn(async () => ({ rpcId: 'm', result: { ok: true, value: {} } })) },
      llm: { models: vi.fn(async () => ({ rpcId: 'l', result: { ok: true as const, value: { groups: [] } } })) },
    }
    const { api } = mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ value: { enabled: false } }),
      vi.fn(async () => {}),
      idle as never,
      advisorSnapshot({ status: 'ready', writable: true, value: { enabled: false } }),
    )
    expect(screen.queryByLabelText(`${en.advisorTitle} ${en.advisorProvider}`)).toBeNull()
    expect(api.llm.models).not.toHaveBeenCalled()
  })

  it('writes the advisor provider and model', async () => {
    const { api } = mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ value: { enabled: false } }),
      vi.fn(async () => {}),
      {
        settings: { mutate: vi.fn(async () => ({ rpcId: 'm', result: { ok: true, value: {} } })) },
        llm: {
          models: vi.fn(async () => ({
            rpcId: 'l',
            result: {
              ok: true as const,
              value: {
                groups: [
                  { id: 'ollama-local', name: 'Ollama (local)', models: [{ id: 'qwen', name: 'Qwen' }] },
                  { id: 'ollama-cloud', name: 'Ollama Cloud', models: [{ id: 'flash', name: 'Flash' }] },
                ],
              },
            },
          })),
        },
      } as never,
      advisorSnapshot({
        status: 'ready',
        writable: true,
        value: { enabled: true, provider: 'ollama-local' },
      }),
    )
    await screen.findByRole('option', { name: 'Ollama Cloud' })
    fireEvent.change(screen.getByLabelText(`${en.advisorTitle} ${en.advisorProvider}`), {
      target: { value: 'ollama-cloud' },
    })
    expect(api.settings.mutate).toHaveBeenCalledWith({
      ns: 'jspace-advisor',
      ops: [
        { op: 'set', path: ['provider'], value: 'ollama-cloud' },
        { op: 'unset', path: ['model'] },
      ],
    })
    fireEvent.change(screen.getByLabelText(`${en.advisorTitle} ${en.advisorModel}`), {
      target: { value: 'qwen' },
    })
    expect(api.settings.mutate).toHaveBeenCalledWith({
      ns: 'jspace-advisor',
      ops: [
        { op: 'set', path: ['provider'], value: 'ollama-local' },
        { op: 'set', path: ['model'], value: 'qwen' },
      ],
    })
    fireEvent.change(screen.getByLabelText(`${en.advisorTitle} ${en.advisorProvider}`), {
      target: { value: '' },
    })
    expect(api.settings.mutate).toHaveBeenCalledWith({
      ns: 'jspace-advisor',
      ops: [{ op: 'unset', path: ['provider'] }, { op: 'unset', path: ['model'] }],
    })
    await writeAdvisorRoute(api as never, undefined)
  })

  it('keeps a stored advisor model id that is not in the live catalog', () => {
    mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({ value: { enabled: false } }),
      vi.fn(async () => {}),
      {
        settings: { mutate: vi.fn(async () => ({ rpcId: 'm', result: { ok: true, value: {} } })) },
        llm: { models: vi.fn(async () => ({ rpcId: 'l', result: { ok: true as const, value: { groups: [] } } })) },
      } as never,
      advisorSnapshot({
        status: 'ready',
        writable: true,
        value: { enabled: true, provider: 'ollama-local', model: 'custom-id' },
      }),
    )
    expect(screen.getByDisplayValue('custom-id')).toBeTruthy()
  })

  it('keeps a stored model id that is not in the live catalog', () => {
    mount(
      snapshot({}),
      vi.fn(async () => {}),
      undefined,
      wikiSnapshot({
        value: { enabled: true, roles: { librarian: { provider: 'ollama-local', model: 'custom-id' } } },
      }),
    )
    expect(screen.getByDisplayValue('custom-id')).toBeTruthy()
  })
})
