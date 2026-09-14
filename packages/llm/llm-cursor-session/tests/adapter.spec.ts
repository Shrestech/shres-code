/**
 * Adapter behavior: the verified catalog is served for listing and
 * resolution, the credential resolves ahead of the wire gate so login
 * failures surface first, and stream() fails loud with the gate diagnostic.
 */

import { describe, expect, it, vi } from 'vitest'
import { CursorSessionLlmAdapter, resolveConfig } from '../src/index.ts'
import type { CursorSessionManager } from '@shres-code/shres-code-cursor-credential'

/** A route resolved from the shipped defaults. */
function route() {
  return resolveConfig({})
}

/** A manager spy: records current() calls, serves or rejects. */
function managerSpy(serve: () => Promise<{ accessToken: string }>): { manager: CursorSessionManager; calls: () => number } {
  const current = vi.fn(serve)
  return {
    manager: { current } as unknown as CursorSessionManager,
    calls: () => current.mock.calls.length,
  }
}

describe('CursorSessionLlmAdapter', () => {
  it('serves the shipped display name on providerInfo', () => {
    const adapter = new CursorSessionLlmAdapter({ route, manager: () => undefined })
    expect(adapter.providerInfo('cursor-session')).toEqual({
      id: 'cursor-session',
      name: 'Cursor (subscription)',
    })
  })

  it('lists the shipped catalog', async () => {
    const adapter = new CursorSessionLlmAdapter({ route, manager: () => undefined })
    const models = await adapter.listModels('cursor-session')
    expect(models.map(model => model.id)).toContain('cursor-grok-4.6-high')
    expect(models.every(model => model.provider === 'cursor-session')).toBe(true)
  })

  it('resolves a catalog entry with its context window', async () => {
    const adapter = new CursorSessionLlmAdapter({ route, manager: () => undefined })
    await expect(adapter.resolveModel('cursor-session', 'gpt-5.2'))
      .resolves.toMatchObject({ provider: 'cursor-session', id: 'gpt-5.2', context: { contextWindow: 272_000 } })
  })

  it('resolves an unlisted id without context facts', async () => {
    const adapter = new CursorSessionLlmAdapter({ route, manager: () => undefined })
    await expect(adapter.resolveModel('cursor-session', 'unlisted'))
      .resolves.toMatchObject({ id: 'unlisted', name: 'unlisted' })
  })

  it('resolves the credential before failing with the wire-gate diagnostic', async () => {
    const spy = managerSpy(() => Promise.resolve({ accessToken: 'token' }))
    const adapter = new CursorSessionLlmAdapter({ route, manager: () => spy.manager })
    const chunks: unknown[] = []
    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'cursor-session', model: 'gpt-5.2', messages: [] })) {
        chunks.push(chunk)
      }
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
    expect(spy.calls()).toBe(1)
    expect(chunks).toEqual([])
  })

  it('surfaces a credential failure ahead of the gate', async () => {
    const spy = managerSpy(() => Promise.reject(new Error('login missing')))
    const adapter = new CursorSessionLlmAdapter({ route, manager: () => spy.manager })
    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'cursor-session', model: 'gpt-5.2', messages: [] })) {
        void chunk
      }
    }).rejects.toThrow(/login missing/)
  })

  it('names the cursor-cli alternative in the gate message', async () => {
    const adapter = new CursorSessionLlmAdapter({ route, manager: () => undefined })
    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'cursor-session', model: 'gpt-5.2', messages: [] })) {
        void chunk
      }
    }).rejects.toThrow(/cursor-cli/)
  })
})

describe('resolveConfig defaults', () => {
  it('serves the shipped catalog and defaults', () => {
    const resolved = resolveConfig({})
    expect(resolved.displayName).toBe('Cursor (subscription)')
    expect(resolved.enabled).toBe(true)
    expect(resolved.baseURL).toBe('https://api2.cursor.sh')
    expect(resolved.models).toHaveLength(6)
    expect(resolved.useKeychain).toBe(process.platform === 'darwin')
  })

  it('honors an explicit models overlay', () => {
    const resolved = resolveConfig({ models: [{ id: 'custom-model' }] })
    expect(resolved.models.map(model => model.id)).toEqual(['custom-model'])
  })
})
