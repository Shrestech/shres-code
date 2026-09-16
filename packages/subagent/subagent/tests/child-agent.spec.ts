/**
 * Child route inheritance: logged header, else live default, else creation options.
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
}): Agent {
  return {
    session: {
      requestHeader: () => overrides.header === undefined ? undefined : { config: overrides.header },
    },
    ctx: {
      get: (name: string) => name === 'agentDefaultModel' && overrides.defaults !== undefined
        ? { currentSelection: () => overrides.defaults }
        : undefined,
    },
    options: overrides.options ?? {},
  } as Agent
}

describe('effectiveChildRoute', () => {
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
