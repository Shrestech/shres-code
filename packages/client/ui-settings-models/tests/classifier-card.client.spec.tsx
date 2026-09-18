// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { RpcResponse, SettingsNamespaceView } from '@shres-code/shres-code-api-remotes/client'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected } from '../src/client/ModelsSection.tsx'
import { judgmentEnabled, writeJudgmentEnabled } from '../src/client/ClassifierCard.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]

/**
 * The section as the Host describes it. The card renders the resolved value
 * alone, so the serialized schema stays empty here: nothing on this page
 * rehydrates the `judgment` envelope.
 */
const judgmentNamespace = (value: unknown, revision: number): SettingsNamespaceView => ({
  ns: 'judgment',
  schema: {},
  value,
  applies: 'live',
  secrets: [],
  revision,
})

/** The section one fake host serves, updated in place by an accepted write. */
interface FakeHost {
  stored: { enabled: boolean; revision: number }
  /** Whether `settings.describe` exposes the `judgment` namespace at all. */
  exposed: boolean
}

const hostOf = (enabled: boolean, revision = 2, exposed = true): FakeHost => ({
  stored: { enabled, revision },
  exposed,
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}

/** The write a host refuses because the section moved on since it was read. */
const CONFLICT: RpcResponse<SettingsNamespaceView> = {
  rpcId: 'r-conflict' as never,
  result: {
    ok: false,
    error: {
      code: 'settings-conflict',
      message: 'the section moved on',
      details: { ns: 'judgment', expected: 2, actual: 3 },
    },
  },
}

/** The Models page over a fake host serving one `judgment` section. */
function buildFace(host: FakeHost, mutate = vi.fn(), writable = true) {
  const describe = vi.fn(() => Promise.resolve(ok({
    writable,
    hasDocument: false,
    namespaces: host.exposed ? [judgmentNamespace({ enabled: host.stored.enabled }, host.stored.revision)] : [],
  })))
  return {
    describe,
    mutate,
    api: {
      llm: {
        providers: vi.fn(() => Promise.resolve(ok({ providers: [] }))),
        models: vi.fn(() => Promise.resolve(ok({ groups: [], failures: [] }))),
      },
      settings: { describe, mutate, openDocument: vi.fn(() => Promise.resolve(ok({}))) },
      credentials: { describe: vi.fn(() => Promise.resolve(ok({ credentials: {} }))) },
    },
  }
}

/** Render the Models page and settle its first load. */
async function renderModels(face: ReturnType<typeof buildFace>) {
  const controller = new ModelsSettingsStore(face.api as never)
  await controller.load()
  render(
    <ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={face.api as never}
      t={t}
    />,
  )
  return controller
}

describe('judgmentEnabled / writeJudgmentEnabled', () => {
  it('reads the switch off only from an explicit false and writes one path op', async () => {
    expect(judgmentEnabled(judgmentNamespace({ enabled: true }, 1))).toBe(true)
    expect(judgmentEnabled(judgmentNamespace({}, 1))).toBe(true)
    expect(judgmentEnabled(judgmentNamespace({ enabled: false }, 1))).toBe(false)

    const mutate = vi.fn(() => Promise.resolve(ok(judgmentNamespace({ enabled: false }, 6))))
    await expect(writeJudgmentEnabled({ settings: { mutate } as never }, false, 5)).resolves.toBeUndefined()
    expect(mutate).toHaveBeenCalledWith({
      ns: 'judgment',
      ops: [{ op: 'set', path: ['enabled'], value: false }],
      expectedRevision: 5,
    })
    // A rejected write reports the host's own text instead of throwing.
    const refused = vi.fn(() => Promise.resolve(CONFLICT))
    await expect(writeJudgmentEnabled({ settings: { mutate: refused } as never }, true, 5))
      .resolves.toBe('the section moved on')
    const broken = vi.fn(() => Promise.reject(new Error('socket closed')))
    await expect(writeJudgmentEnabled({ settings: { mutate: broken } as never }, true, 5))
      .resolves.toBe('socket closed')
  })
})

describe('ClassifierCard', () => {
  it('renders the deployment switch, its copy, and what off means', async () => {
    await renderModels(buildFace(hostOf(true)))
    expect(screen.getByText(en.classifierTitle)).toBeTruthy()
    expect(screen.getByText(en.classifierIntro)).toBeTruthy()
    expect(screen.getByText(en.classifierSwitchLabel)).toBeTruthy()
    expect(screen.getByText(en.classifierOffMeans)).toBeTruthy()
    expect(screen.getByText(en.classifierBinding)).toBeTruthy()
    // The composition default is on; the switch and its value line both say so.
    expect(screen.getByText(en.classifierOn)).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.classifierDisable }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows the stored switch position when the section is off', async () => {
    await renderModels(buildFace(hostOf(false, 4)))
    expect(screen.getByText(en.classifierOff)).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.classifierEnable }).getAttribute('aria-checked')).toBe('false')
  })

  it('writes the toggle through the settings path and re-reads the section', async () => {
    const host = hostOf(true)
    const mutate = vi.fn((payload: { ops: readonly { value?: unknown }[] }) => {
      host.stored.enabled = payload.ops[0]?.value === true
      host.stored.revision += 1
      return Promise.resolve(ok(judgmentNamespace({ enabled: host.stored.enabled }, host.stored.revision)))
    })
    const face = buildFace(host, mutate)
    await renderModels(face)

    fireEvent.click(screen.getByRole('switch', { name: en.classifierDisable }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'judgment',
        ops: [{ op: 'set', path: ['enabled'], value: false }],
        expectedRevision: 2,
      })
    })
    // The page's write convention: the write settles, then the snapshot is
    // re-read, and the switch follows the section rather than the click.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.classifierEnable }).getAttribute('aria-checked')).toBe('false')
    })
    expect(face.describe.mock.calls.length).toBeGreaterThan(1)
  })

  it('surfaces a refused write inline and leaves the switch where the section had it', async () => {
    const face = buildFace(hostOf(true), vi.fn(() => Promise.resolve(CONFLICT)))
    await renderModels(face)

    fireEvent.click(screen.getByRole('switch', { name: en.classifierDisable }))
    await waitFor(() => {
      expect(screen.getByText('the section moved on')).toBeTruthy()
    })
    expect(screen.getByRole('switch', { name: en.classifierDisable }).getAttribute('aria-checked')).toBe('true')
    expect(face.describe.mock.calls.length).toBe(1)
  })

  it('surfaces a transport failure inline', async () => {
    const face = buildFace(hostOf(true), vi.fn(() => Promise.reject(new Error('socket closed'))))
    await renderModels(face)

    fireEvent.click(screen.getByRole('switch', { name: en.classifierDisable }))
    await waitFor(() => {
      expect(screen.getByText('socket closed')).toBeTruthy()
    })
    expect(screen.getByRole('switch', { name: en.classifierDisable }).getAttribute('aria-checked')).toBe('true')
  })

  it('disables the switch in a read-only deployment', async () => {
    await renderModels(buildFace(hostOf(true), vi.fn(), false))
    expect(screen.getByRole('switch', { name: en.classifierDisable }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
  })

  it('renders nothing when the Host exposes no judgment section', async () => {
    await renderModels(buildFace(hostOf(true, 2, false)))
    expect(screen.queryByText(en.classifierTitle)).toBeNull()
  })
})
