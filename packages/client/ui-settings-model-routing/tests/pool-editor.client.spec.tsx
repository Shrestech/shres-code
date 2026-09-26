// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DESCRIPTION_GUIDANCE_CHARS, MAX_DESCRIPTION_CHARS, PoolEditor } from '../src/client/PoolEditor.tsx'
import type { ModelRoutingController, ModelRoutingState } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'
import { LAYA, LAYA_VIEW, MODELS, POOL, POOL_ROUTER, TYPESAFE, namespace, snapshot } from './fixtures.client.ts'
import { double, ready, t } from './helpers.client.tsx'
import { poolSection } from '../src/client/view.ts'

afterEach(cleanup)

/** Mount the pool editor over one controller, with the stored pool, its status, and the catalog. */
function mount(controller: ModelRoutingController, overrides: Partial<ModelRoutingState> = {}): void {
  render(
    <PoolEditor
      state={ready({ router: POOL_ROUTER, pool: POOL, models: MODELS, ...overrides })}
      controller={controller}
      t={t as never}
    />,
  )
}

const STORED = poolSection(POOL_ROUTER)
const OPUS_ROUTE = [{ provider: 'claude-session', model: 'claude-opus-5-5', objective: 'quota', allowEveryTurn: true }]

/** Open the edit form of the first pool row. */
function openEdit(name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: t('poolEditTitle', { model: name }) }))
  return screen.getByRole('form', { name: t('poolEditTitle', { model: name }) })
}

describe('the candidate pool editor', () => {
  it('renders nothing without the model-router section', () => {
    const { container } = render(<PoolEditor state={ready({ router: null })} controller={double(ready())} t={t as never} />)
    expect(container.textContent).toBe('')
  })

  it('adds a catalog model with an auto-slugged id the owner can edit', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    mount(controller)
    fireEvent.click(screen.getByRole('button', { name: en.poolAdd }))
    fireEvent.change(screen.getByRole('combobox', { name: en.poolPick }), { target: { value: 'ollama-cloud/kimi-k3:cloud' } })
    const form = screen.getByRole('form', { name: en.poolAddTitle })
    const id = within(form).getByLabelText(en.poolId) as HTMLInputElement
    expect(id.value).toBe('kimi-k3-cloud')
    expect(id.closest('label')?.getAttribute('title')).toBe(en.poolIdTitle)
    fireEvent.change(id, { target: { value: 'kimi' } })
    fireEvent.change(within(form).getByLabelText(en.poolDescriptionLabel), { target: { value: 'quick lookups' } })
    fireEvent.click(within(form).getByRole('button', { name: en.poolAddConfirm }))
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith(
      [...STORED.candidates, { id: 'kimi', provider: 'ollama-cloud', model: 'kimi-k3:cloud', description: 'quick lookups' }],
      OPUS_ROUTE,
    )
  })

  it('names a route by hand when the catalog does not list the model', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    mount(controller)
    fireEvent.click(screen.getByRole('button', { name: en.poolAdd }))
    const picker = screen.getByRole('combobox', { name: en.poolPick })
    fireEvent.change(picker, { target: { value: '__other__' } })
    fireEvent.change(screen.getByLabelText(en.poolProvider), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText(en.poolModelId), { target: { value: 'gpt-6-mini' } })
    const form = screen.getByRole('form', { name: en.poolAddTitle })
    fireEvent.change(within(form).getByLabelText(en.poolDescriptionLabel), { target: { value: 'cheap drafts' } })
    fireEvent.click(within(form).getByRole('button', { name: en.poolAddConfirm }))
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith(
      [...STORED.candidates, { id: 'gpt-6-mini', provider: 'openai', model: 'gpt-6-mini', description: 'cheap drafts' }],
      OPUS_ROUTE,
    )
  })

  it('cancels the add before a model is chosen and after one is chosen', () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    mount(controller)
    fireEvent.click(screen.getByRole('button', { name: en.poolAdd }))
    expect(screen.getByRole('option', { name: en.poolPickPlaceholder })).toHaveProperty('selected', true)
    // No form exists before a model is chosen, only the cancel action.
    expect(screen.queryByRole('form', { name: en.poolAddTitle })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.poolCancel }))
    expect(screen.queryByRole('button', { name: en.poolCancel })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.poolAdd }))
    fireEvent.change(screen.getByRole('combobox', { name: en.poolPick }), { target: { value: 'ollama-cloud/kimi-k3:cloud' } })
    const form = screen.getByRole('form', { name: en.poolAddTitle })
    fireEvent.click(within(form).getByRole('button', { name: en.poolCancel }))
    expect(screen.queryByRole('form', { name: en.poolAddTitle })).toBeNull()
    void controller
  })

  it('counts description characters, warns from the guidance mark, and stops input at the hard limit', () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    const description = within(form).getByLabelText(en.poolDescriptionLabel) as HTMLTextAreaElement
    expect(description.maxLength).toBe(MAX_DESCRIPTION_CHARS)
    fireEvent.change(description, { target: { value: 'a'.repeat(DESCRIPTION_GUIDANCE_CHARS - 1) } })
    const calm = within(form).getByText(`${DESCRIPTION_GUIDANCE_CHARS - 1}/${MAX_DESCRIPTION_CHARS}`)
    expect(calm.className).not.toMatch(/counterWarn/)
    fireEvent.change(description, { target: { value: 'a'.repeat(DESCRIPTION_GUIDANCE_CHARS) } })
    const warned = within(form).getByText(`${DESCRIPTION_GUIDANCE_CHARS}/${MAX_DESCRIPTION_CHARS}`)
    expect(warned.className).toMatch(/counterWarn/)
    expect(warned.getAttribute('title')).toBe(t('poolDescriptionLong', { max: MAX_DESCRIPTION_CHARS }))
  })

  it('refuses to write an entry whose id or description is empty', () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    const id = within(form).getByLabelText(en.poolId) as HTMLInputElement
    const submit = within(form).getByRole('button', { name: en.poolSave }) as HTMLButtonElement
    fireEvent.change(id, { target: { value: '   ' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(id, { target: { value: 'flash' } })
    expect(submit.disabled).toBe(false)
    fireEvent.change(within(form).getByLabelText(en.poolDescriptionLabel), { target: { value: ' ' } })
    expect(submit.disabled).toBe(true)
    void controller
  })

  it('edits the effort an adapter offers and omits the field at the route default', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    const effort = within(form).getByLabelText(en.poolEffort) as HTMLSelectElement
    expect([...effort.options].map(option => option.value)).toEqual(['', 'low', 'high'])
    expect(effort.value).toBe('')
    fireEvent.change(effort, { target: { value: 'high' } })
    fireEvent.click(within(form).getByRole('button', { name: en.poolSave }))
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith(
      [{ ...STORED.candidates[0], reasoningEffort: 'high' }, STORED.candidates[1]],
      OPUS_ROUTE,
    )
  })

  it('removes a pool model from its edit form', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    fireEvent.click(within(form).getByRole('button', { name: en.poolRemove }))
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith([STORED.candidates[1]], OPUS_ROUTE)
  })

  it('hides the stored notes while a rejected write holds a draft, and restores them on discard', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }), { savePool: { message: 'stale revision' } })
    mount(controller)
    expect(screen.getByText(en.noteCacheUnreported)).toBeTruthy()
    const form = openEdit('GLM-5.3')
    fireEvent.change(within(form).getByLabelText(en.poolDescriptionLabel), { target: { value: 'routine code edits' } })
    fireEvent.click(within(form).getByRole('button', { name: en.poolSave }))
    await screen.findByRole('alert')
    // The draft is held, so the stored pool status no longer describes its rows.
    expect(screen.queryByText(en.noteCacheUnreported)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.poolDiscard }))
    expect(screen.getByText(en.noteCacheUnreported)).toBeTruthy()
  })

  it('warns about cross-membership when a pool model is also a route-from model', () => {
    const pool = { ...POOL, candidates: POOL.candidates.map(entry => entry.id === 'flash' ? { ...entry, alsoRouteFrom: true } : entry) }
    mount(double(ready()), { pool })
    expect(screen.getByText(en.noteAlsoRouteFrom).getAttribute('title')).toBe(en.noteAlsoRouteFromTitle)
  })

  it('shows an unnamed write failure on the pool card, and hides the stored notes of a draft', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }), { savePool: { message: 'ModelRouterConfig.candidates[1].id "glm" is already in use' } })
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    fireEvent.click(within(form).getByRole('button', { name: en.poolSave }))
    expect(await screen.findByRole('alert').then(alert => alert.textContent)).toBe('ModelRouterConfig.candidates[1].id "glm" is already in use')
    expect(screen.queryByText('Eligible from Claude Opus 5.5')).toBeNull()
  })

  it('shows a row-named write failure on that row, and recovers on a later successful write', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    controller.savePool = vi.fn()
      .mockResolvedValueOnce({ message: 'candidates[0].id "flash" is reserved', path: ['candidates', 0, 'id'] })
      .mockResolvedValueOnce(undefined)
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    fireEvent.click(within(form).getByRole('button', { name: en.poolSave }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('candidates[0].id "flash" is reserved')
    expect(alert.closest('tr')?.getAttribute('aria-invalid')).toBe('true')
    // Submitting closed the edit form; open it again and write once more.
    const reopened = openEdit('DeepSeek V4.1 Flash')
    fireEvent.click(within(reopened).getByRole('button', { name: en.poolSave }))
    await waitFor(() =>{  expect(screen.queryByRole('alert')).toBeNull() })
    expect(screen.getByText('Eligible from Claude Opus 5.5')).toBeTruthy()
  })

  it('keeps an unsaved draft with discard, and offers save again once every entry is complete', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }), { savePool: { message: 'stale revision' } })
    mount(controller)
    expect(screen.queryByText(en.poolUnsaved)).toBeNull()
    const form = openEdit('DeepSeek V4.1 Flash')
    fireEvent.change(within(form).getByLabelText(en.poolDescriptionLabel), { target: { value: 'well-scoped edits' } })
    fireEvent.click(within(form).getByRole('button', { name: en.poolSave }))
    await screen.findByRole('alert')
    // Every Route from entry is complete, so the held draft offers save again.
    expect(screen.getByText(en.poolUnsaved)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.poolRetry }))
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(2) })
    // Discarding drops the draft and its failure.
    fireEvent.click(screen.getByRole('button', { name: en.poolDiscard }))
    expect(screen.queryByText(en.poolUnsaved)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the saving line while a write runs', async () => {
    const store = { current: undefined as undefined | (() => void) }
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }))
    let release: (() => void) | undefined
    controller.savePool = vi.fn(() => new Promise<undefined>((resolve) => { release = () =>{  resolve(undefined) } }))
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    fireEvent.click(within(form).getByRole('button', { name: en.poolSave }))
    expect(screen.getByText(en.poolSaving)).toBeTruthy()
    release?.()
    store.current = release
    await waitFor(() =>{  expect(screen.queryByText(en.poolSaving)).toBeNull() })
  })

  it('shows a list-named rejection on the pool card', async () => {
    const controller = double(ready({ router: POOL_ROUTER, pool: POOL, models: MODELS }),
      { savePool: { message: 'candidates contains duplicate ids', path: ['candidates'] } })
    mount(controller)
    const form = openEdit('DeepSeek V4.1 Flash')
    fireEvent.click(within(form).getByRole('button', { name: en.poolSave }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('candidates contains duplicate ids')
    expect(alert.closest('section')?.getAttribute('aria-label')).toBe(en.poolTitle)
  })

  it('names the judge token budget in the description hint while Laya is the routed engine', () => {
    const layaReady = { ...LAYA, state: 'ready', detail: undefined } as never
    const controller = double(ready())
    mount(controller, {
      router: POOL_ROUTER,
      pool: POOL,
      models: MODELS,
      engines: snapshot([TYPESAFE, layaReady], 'laya'),
      laya: { ...LAYA_VIEW, state: 'ready', detail: undefined } as never,
    })
    const form = openEdit('DeepSeek V4.1 Flash')
    expect(within(form).getByText(t('poolDescriptionHintLaya', { tokens: '1,024' }))).toBeTruthy()
    fireEvent.click(within(form).getByRole('button', { name: en.poolCancel }))
    cleanup()

    // Laya routed without its gateway view leaves the hint generic too.
    mount(double(ready()), {
      router: POOL_ROUTER, pool: POOL, models: MODELS,
      engines: snapshot([TYPESAFE, layaReady], 'laya'),
      laya: null,
    })
    const bare = openEdit('DeepSeek V4.1 Flash')
    expect(within(bare).getByText(en.poolDescriptionHint)).toBeTruthy()
    fireEvent.click(within(bare).getByRole('button', { name: en.poolCancel }))
    cleanup()

    // Without Laya routed, the hint stays generic.
    mount(double(ready()), { router: POOL_ROUTER, pool: POOL, models: MODELS })
    const plain = openEdit('DeepSeek V4.1 Flash')
    expect(within(plain).getByText(en.poolDescriptionHint)).toBeTruthy()
  })

  it('shows an empty pool without notes and the routing-keeps-strong notice', () => {
    mount(double(ready()), {
      router: namespace('model-router', { initialMode: 'off' }, 9),
      pool: { routeFrom: [], candidates: [] },
      models: MODELS,
    })
    expect(screen.getByText(en.poolEmpty)).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
