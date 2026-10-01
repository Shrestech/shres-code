// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PoolEditor } from '../src/client/PoolEditor.tsx'
import type { ModelRoutingController, ModelRoutingState } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'
import { MODELS, POOL, POOL_ROUTER, namespace } from './fixtures.client.ts'
import { double, ready, t } from './helpers.client.tsx'
import { poolSection } from '../src/client/view.ts'

afterEach(cleanup)

const STORED = poolSection(POOL_ROUTER)

/** The router section with the pool stored and no Route from entry yet. */
function routeFromEmptyRouter(): ModelRoutingState['router'] {
  return namespace('model-router', { initialMode: 'off', candidates: STORED.candidates, routeFrom: [] }, 9)
}

/** Mount the pool editor with an empty Route from allowlist. */
function mount(controller: ModelRoutingController, overrides: Partial<ModelRoutingState> = {}): void {
  render(
    <PoolEditor
      state={ready({ router: routeFromEmptyRouter(), pool: POOL, models: MODELS, ...overrides })}
      controller={controller}
      t={t as never}
    />,
  )
}

/** Add Claude Opus as a Route from model and return its row. */
function addOpus(): HTMLElement {
  fireEvent.change(screen.getByLabelText(en.routeFromPick), { target: { value: 'claude-session/claude-opus-5-5' } })
  return screen.getByText(en.objectiveNeeded).closest('tr') as HTMLElement
}

/** The strong-model picker. */
function picker(): HTMLSelectElement {
  return screen.getByLabelText(en.routeFromPick) as HTMLSelectElement
}

describe('the Route from editor', () => {
  it('shows the empty notice while no strong model is enabled', () => {
    const controller = double(ready({ router: routeFromEmptyRouter(), pool: { ...POOL, routeFrom: [] }, models: MODELS }))
    mount(controller)
    expect(screen.getByText(en.routeFromEmpty)).toBeTruthy()
    expect(picker().disabled).toBe(false)
    expect(controller.savePool).not.toHaveBeenCalled()
    // Re-opening the picker without a choice adds nothing.
    fireEvent.change(picker(), { target: { value: '' } })
    expect(controller.savePool).not.toHaveBeenCalled()
  })

  it('holds a new entry until its objective is chosen, then writes it in one write with the pool', async () => {
    const controller = double(ready({ router: routeFromEmptyRouter(), pool: POOL, models: MODELS }))
    mount(controller)
    const row = addOpus()
    expect(within(row).getByText(en.objectiveNeeded)).toBeTruthy()
    expect(controller.savePool).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByRole('radio', { name: en.objectiveDollars }))
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith(STORED.candidates, [
      { provider: 'claude-session', model: 'claude-opus-5-5', objective: 'dollars' },
    ])
  })

  it('writes a quota route at its objective, and every-turn entry is a separate opt-in', async () => {
    // A rejecting Host keeps the draft, so the row stays put across the toggles.
    const controller = double(ready({ router: routeFromEmptyRouter(), pool: POOL, models: MODELS }), { savePool: { message: 'stale revision' } })
    mount(controller)
    const row = addOpus()
    fireEvent.click(within(row).getByRole('radio', { name: en.objectiveQuota }))
    // A quota entry without the allowance writes; the router owns the rule.
    await waitFor(() => { expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith(STORED.candidates, [
      { provider: 'claude-session', model: 'claude-opus-5-5', objective: 'quota' },
    ])
    // Clicking the selected objective again changes nothing.
    fireEvent.click(within(row).getByRole('radio', { name: en.objectiveQuota }))
    expect(controller.savePool).toHaveBeenCalledTimes(1)

    // The every-turn switch allows per-turn entry, and switching it off drops the field.
    fireEvent.click(within(row).getByRole('switch', { name: t('everyTurnAllow', { model: 'Claude Opus 5.5' }) }))
    await waitFor(() => { expect(controller.savePool).toHaveBeenCalledTimes(2) })
    expect(controller.savePool).toHaveBeenLastCalledWith(STORED.candidates, [
      { provider: 'claude-session', model: 'claude-opus-5-5', objective: 'quota', allowEveryTurn: true },
    ])
    fireEvent.click(within(row).getByRole('switch', { name: t('everyTurnAllow', { model: 'Claude Opus 5.5' }) }))
    await waitFor(() => { expect(controller.savePool).toHaveBeenCalledTimes(3) })
    expect(controller.savePool).toHaveBeenLastCalledWith(STORED.candidates, [
      { provider: 'claude-session', model: 'claude-opus-5-5', objective: 'quota' },
    ])
  })

  it('shows a rejected write beside the row the Host named', async () => {
    const controller = double(ready({ router: routeFromEmptyRouter(), pool: POOL, models: MODELS }),
      { savePool: { message: 'routeFrom[0].objective "tokens" is not a routing objective', path: ['routeFrom', 0, 'objective'] } })
    mount(controller)
    const row = addOpus()
    fireEvent.click(within(row).getByRole('radio', { name: en.objectiveDollars }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('routeFrom[0].objective "tokens" is not a routing objective')
    expect(alert.closest('tr')).toBe(row)
    expect(row.getAttribute('aria-invalid')).toBe('true')
  })

  it('shows an unnamed rejection on the card, and stops offering models once every one is enabled', async () => {
    const controller = double(ready(), { savePool: { message: 'routeFrom is empty: routing can never run' } })
    mount(controller, { router: routeFromEmptyRouter(), pool: POOL, models: MODELS })
    expect(picker().disabled).toBe(false)
    for (const value of ['ollama-cloud/deepseek-v4.1-flash:cloud', 'ollama-cloud/kimi-k3:cloud', 'zai/glm-5.3', 'claude-session/claude-opus-5-5']) {
      fireEvent.change(picker(), { target: { value } })
    }
    // Every catalog model sits in the draft, and an incomplete entry holds the write.
    expect(picker().disabled).toBe(true)
    expect(controller.savePool).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('switch', { name: t('routeFromDisable', { model: 'DeepSeek V4.1 Flash' }) }))
    expect(picker().disabled).toBe(false)

    // Completing the last drafts writes the whole allowlist in one write.
    for (const [model, objective] of [
      ['kimi-k3:cloud', en.objectiveLatency], ['glm-5.3', en.objectiveDollars], ['claude-opus-5-5', en.objectiveDollars],
    ] as const) {
      const row = screen.getAllByText(en.objectiveNeeded)[0]!.closest('tr') as HTMLElement
      void model
      fireEvent.click(within(row).getByRole('radio', { name: objective }))
    }
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith(STORED.candidates, [
      { provider: 'ollama-cloud', model: 'kimi-k3:cloud', objective: 'latency' },
      { provider: 'zai', model: 'glm-5.3', objective: 'dollars' },
      { provider: 'claude-session', model: 'claude-opus-5-5', objective: 'dollars' },
    ])
  })

  it('shows a list-named rejection on the Route from card', async () => {
    const controller = double(ready(), { savePool: { message: 'routeFrom contains a duplicate entry', path: ['routeFrom'] } })
    mount(controller, { router: routeFromEmptyRouter(), pool: POOL, models: MODELS })
    addOpus()
    fireEvent.click(within(screen.getAllByText(en.objectiveNeeded)[0]!.closest('tr') as HTMLElement).getByRole('radio', { name: en.objectiveDollars }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('routeFrom contains a duplicate entry')
    expect(alert.closest('section')?.getAttribute('aria-label')).toBe(en.routeFromTitle)
    expect(alert.closest('tr')).toBeNull()
  })

  it('stops routing from a model by removing its row', async () => {
    const controller = double(ready())
    mount(controller, { router: POOL_ROUTER, pool: POOL, models: MODELS })
    const row = screen.getByRole('switch', { name: t('routeFromDisable', { model: 'Claude Opus 5.5' }) }).closest('tr') as HTMLElement
    expect(within(row).getByRole('radio', { name: en.objectiveQuota }).getAttribute('aria-checked')).toBe('true')
    expect(within(row).getByRole('switch', { name: t('everyTurnAllow', { model: 'Claude Opus 5.5' }) }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(row).getByRole('switch', { name: t('routeFromDisable', { model: 'Claude Opus 5.5' }) }))
    await waitFor(() =>{  expect(controller.savePool).toHaveBeenCalledTimes(1) })
    expect(controller.savePool).toHaveBeenCalledWith(STORED.candidates, [])
  })
})
