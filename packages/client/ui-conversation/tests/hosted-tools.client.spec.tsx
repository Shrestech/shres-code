// @vitest-environment jsdom
/** Provider-hosted calls have named, neutral summaries rather than local execution controls. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en, commonEn)
afterEach(cleanup)

describe('hosted search transcript', () => {
  it.each([
    ['x_keyword_search', 'keyword'],
    ['x_semantic_search', 'semantic'],
    ['x_user_search', 'accounts'],
    ['x_thread_fetch', 'thread'],
    ['x_future_search', 'x_future_search'],
  ])('names %s without claiming completion', (name, operation) => {
    render(<AssistantMarkdown t={t} streaming={false} blocks={[
      { kind: 'server-tool-call', block: { type: 'server-tool-call', kind: 'x_search', name } },
    ]} />)
    expect(screen.getByText('Hosted X search · ' + operation)).toBeTruthy()
    expect(screen.queryByText('Failed')).toBeNull()
    expect(screen.queryByText(/Completed|Unknown content block/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a failure only when the provider reported it', () => {
    render(<AssistantMarkdown t={t} streaming={false} blocks={[
      { kind: 'server-tool-call', block: { type: 'server-tool-call', kind: 'x_search', status: 'failed' } },
    ]} />)
    expect(screen.getByText('Hosted X search')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('shows the web category and preserves names of provider extensions', () => {
    render(<AssistantMarkdown t={t} streaming={false} blocks={[
      { kind: 'server-tool-call', block: { type: 'server-tool-call', kind: 'web_search', name: 'web_search', status: 'completed' } },
      { kind: 'server-tool-call', block: { type: 'server-tool-call', kind: 'custom', name: 'x_keyword_search' } },
      { kind: 'server-tool-call', block: { type: 'server-tool-call', kind: 'custom' } },
    ]} />)
    expect(screen.getByText('Hosted web search')).toBeTruthy()
    expect(screen.getByText('custom · x_keyword_search')).toBeTruthy()
    expect(screen.getByText('custom')).toBeTruthy()
  })
})
