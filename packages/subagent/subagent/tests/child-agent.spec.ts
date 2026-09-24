/**
 * Child route inheritance: the parent's selection in force, else live default,
 * else creation options.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@shres-code/shres-code-agent'
import { SessionId } from '@shres-code/shres-code-session'
import { childSessionMeta, effectiveChildRoute, resolveRequestedChildCwd } from '../src/child-agent.ts'

function parent(overrides: {
  header?: { provider?: string; model?: string }
  defaults?: { provider: string; model: string }
  options?: { provider?: string; model?: string }
  /** The manual base a composed router reports beneath a routed header. */
  sticky?: { provider: string; model: string }
  /** An explicit `agent/model-selection` in the parent's log. */
  selection?: { provider: string; model: string }
}): Agent {
  const services: Record<string, unknown> = {
    ...overrides.defaults === undefined ? {} : { agentDefaultModel: { currentSelection: () => overrides.defaults } },
    ...overrides.sticky === undefined ? {} : { modelRouting: { stickySelection: () => overrides.sticky } },
  }
  return {
    session: {
      events: overrides.selection === undefined ? [] : [{ type: 'agent/model-selection', data: overrides.selection }],
      requestHeader: () => overrides.header === undefined ? undefined : { config: overrides.header },
    },
    ctx: { get: (name: string) => services[name] },
    options: overrides.options ?? {},
  } as unknown as Agent
}

const MANUAL = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const ROUTED = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

describe('effectiveChildRoute', () => {
  it('inherits the manual base a composed router reports beneath a routed header', () => {
    expect(effectiveChildRoute(parent({ header: ROUTED, sticky: MANUAL, defaults: ROUTED }), undefined)).toEqual(MANUAL)
  })

  it('inherits an explicit model selection over the logged header', () => {
    expect(effectiveChildRoute(parent({ header: ROUTED, selection: MANUAL }), undefined)).toEqual(MANUAL)
  })

  it('inherits the logged header when no router and no explicit selection exist', () => {
    expect(effectiveChildRoute(parent({ header: ROUTED, defaults: MANUAL, options: MANUAL }), undefined)).toEqual(ROUTED)
  })

  it('applies a per-child override over the manual selection', () => {
    expect(effectiveChildRoute(parent({ header: ROUTED, sticky: MANUAL }), { model: 'pinned' }))
      .toEqual({ provider: MANUAL.provider, model: 'pinned' })
  })

  it('inherits the live default model when the parent has no logged header', () => {
    expect(effectiveChildRoute(parent({ defaults: { provider: 'live', model: 'm' } }), undefined))
      .toEqual({ provider: 'live', model: 'm' })
  })

  it('falls back to creation options when no header and no default-model service exist', () => {
    expect(effectiveChildRoute(parent({ options: { provider: 'opt', model: 'n' } }), undefined))
      .toEqual({ provider: 'opt', model: 'n' })
  })
})

function parentForMeta(cwd?: string): Agent {
  return {
    session: { header: { id: SessionId('parent'), ...cwd === undefined ? {} : { cwd } } },
    ctx: { get: () => undefined },
  } as unknown as Agent
}

describe('childSessionMeta workspace', () => {
  it('inherits the parent cwd and accepts a validated override', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'shres-child-cwd-'))
    try {
      expect(childSessionMeta(parentForMeta('/parent-ws'), 1, 0).cwd).toBe('/parent-ws')
      expect(childSessionMeta(parentForMeta('/parent-ws'), 1, 0, workspace).cwd).toBe(workspace)
      expect(childSessionMeta(parentForMeta(), 1, 0).cwd).toBeUndefined()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('resolveRequestedChildCwd', () => {
  it('omits blank values and rejects a path that cannot host the child', () => {
    expect(resolveRequestedChildCwd(undefined)).toBeUndefined()
    expect(resolveRequestedChildCwd('   ')).toBeUndefined()
    expect(() => resolveRequestedChildCwd('relative/path')).toThrow('must be an absolute path')
    const workspace = mkdtempSync(join(tmpdir(), 'shres-child-cwd-ok-'))
    try {
      expect(resolveRequestedChildCwd(`  ${workspace}  `)).toBe(workspace)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
