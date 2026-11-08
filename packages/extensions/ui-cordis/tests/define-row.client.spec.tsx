// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@shres-code/shres-code-client-web-react'
import type { ToolResultNode } from '@shres-code/shres-code-client-runtime/client'
import { makeTranslate } from '@shres-code/shres-code-client-test-runtime'
import { en as commonEn } from '@shres-code/shres-code-client-locale/src/locales/en.ts'
import { CordisDefineRow, type CordisDefineRowProps } from '../src/client/CordisDefineRow.tsx'
import { createCordisDefineViewStore, type CordisDefineViewStore } from '../src/client/define-view-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: CordisDefineRowProps['t'] = makeTranslate(en, commonEn)

const block: ToolResultNode = {
  kind: 'tool-result', seq: 2, time: 2_000, callId: 'call-1',
  call: {
    name: 'cordis_define',
    argsRaw: JSON.stringify({
      name: 'clock', purpose: 'top-bar clock',
      code: { client: 'return {}', host: 'harness.handle()' },
    }),
  },
  callTime: 1_000,
  content: [{ type: 'text', text: 'defined clock' }],
  isError: false,
  meta: { pluginId: 'clock', packageId: 'clock-v1' },
  callView: null,
  resultView: null,
  subCalls: [],
}

type CordisDefineViewInstance = ReturnType<CordisDefineViewStore['create']>

function props(store: CordisDefineViewInstance): CordisDefineRowProps {
  const inventory = { rows: [], removed: new Set(), read: true }
  const useInventory = ((selector: (value: typeof inventory) => unknown) => selector(inventory)) as CordisDefineRowProps['useInventory']
  const useLoaded = ((selector: (value: readonly unknown[]) => unknown) => selector([])) as CordisDefineRowProps['useLoaded']
  return {
    callId: block.callId,
    toolName: 'cordis_define',
    block,
    openFile: vi.fn(),
    inspect: vi.fn(),
    expanded: true,
    onExpandedChange: vi.fn(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    useInventory,
    useLoaded,
    t,
  } as unknown as CordisDefineRowProps
}

describe('CordisDefineRow', () => {
  it('restores a selected source tab after a virtual row remount', () => {
    const store = createCordisDefineViewStore().create('session-a')
    const view = render(<CordisDefineRow {...props(store)} />)
    const host = view.getByRole('tab', { name: 'Host' })
    expect(host.getAttribute('aria-selected')).toBe('false')

    fireEvent.click(host)
    expect(host.getAttribute('aria-selected')).toBe('true')

    view.unmount()
    const restored = render(<CordisDefineRow {...props(store)} />)
    expect(restored.getByRole('tab', { name: 'Host' }).getAttribute('aria-selected')).toBe('true')
  })
})
