// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { createChatRowViewingStore } from '../src/client/stores.ts'
import { en } from '../src/client/locales.ts'

let nextAnimationFrameId = 1
let animationFrames = new Map<number, FrameRequestCallback>()

function flushAnimationFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const callbacks = [...animationFrames.values()]
    animationFrames.clear()
    for (const callback of callbacks) callback(index)
  }
}

beforeEach(() => {
  nextAnimationFrameId = 1
  animationFrames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId
    nextAnimationFrameId += 1
    animationFrames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    animationFrames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = makeTranslate(en, commonEn)

function rowProps(nodeKey = 'reasoning-test') {
  const store = createChatRowViewingStore().create('reasoning-test')
  return { nodeKey, useStore: bindSnapshotSelector(store), actions: store.actions }
}

describe('ReasoningRow', () => {
  it('follows the latest streaming line, scrolls to its end, then restores the settled first line', () => {
    const viewing = rowProps()
    const view = render(
      <AssistantMarkdown
        {...viewing}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming
      />,
    )
    expect(view.getByText('Running')).toBeTruthy()
    const summary = view.getByText('Newest reasoning tokens')
    Object.defineProperties(summary, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
    })

    view.rerender(
      <AssistantMarkdown
        {...viewing}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving' }]}
        streaming
      />,
    )
    expect(summary.scrollLeft).toBe(0)
    flushAnimationFrames(2)
    expect(summary.scrollLeft).toBe(0)
    flushAnimationFrames(1)
    expect(summary.scrollLeft).toBe(200)
    expect(summary.getAttribute('data-follow-end')).toBe('true')

    view.rerender(
      <AssistantMarkdown
        {...viewing}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n' }]}
        streaming={false}
      />,
    )
    flushAnimationFrames(3)
    expect(view.getByText('Inspect the session')).toBeTruthy()
    expect(view.queryByText('Running')).toBeNull()
    expect(summary.scrollLeft).toBe(0)
    expect(summary.hasAttribute('data-follow-end')).toBe(false)
  })

  it('expands from either Think or the reasoning summary', () => {
    const viewing = rowProps()
    const view = render(
      <AssistantMarkdown
        {...viewing}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('Inspect the session'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('Think'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps an expanded reasoning block open after its virtual row remounts', () => {
    const viewing = rowProps('reasoning-remount')
    const first = render(
      <AssistantMarkdown
        {...viewing}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nKeep this open' }]}
        streaming={false}
      />,
    )
    fireEvent.click(first.getByRole('button'))
    expect(first.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    first.unmount()

    const remounted = render(
      <AssistantMarkdown
        {...viewing}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nKeep this open' }]}
        streaming={false}
      />,
    )
    expect(remounted.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(remounted.getByText(/Keep this open/)).toBeTruthy()
  })

  it('expanded Think drops the inline summary and renders plain prose, no IN card', () => {
    const viewing = rowProps()
    const view = render(
      <AssistantMarkdown
        {...viewing}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
      />,
    )
    fireEvent.click(view.getByText('Think'))
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
  })
})
