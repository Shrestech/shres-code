/**
 * Per-repo gate: precedence, key normalization, and validation of the
 * `repos` exception map.
 */

import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  liveSessionCwds, repoDisabled, repoGateBlocksMount, resolveRepoPath, validateRepoKeys,
} from '../src/repos.ts'

let scratch: string | undefined

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('repoGateBlocksMount', () => {
  it('stays mounted with no live sessions', () => {
    expect(repoGateBlocksMount({}, [])).toBe(false)
  })

  it('stays mounted when no entry names a live repo', () => {
    expect(repoGateBlocksMount({}, ['/repo/a'])).toBe(false)
    expect(repoGateBlocksMount({ '/repo/b': { enabled: false } }, ['/repo/a'])).toBe(false)
  })

  it('stays mounted while any live repo is enabled', () => {
    const repos = { '/repo/a': { enabled: false }, '/repo/b': { enabled: false } }
    expect(repoGateBlocksMount(repos, ['/repo/a', '/repo/b', '/repo/c'])).toBe(false)
  })

  it('blocks when every live repo is disabled', () => {
    const repos = { '/repo/a': { enabled: false }, '/repo/b': { enabled: false } }
    expect(repoGateBlocksMount(repos, ['/repo/a', '/repo/b'])).toBe(true)
  })

  it('ignores enabled:true entries', () => {
    expect(repoGateBlocksMount({ '/repo/a': { enabled: true } }, ['/repo/a'])).toBe(false)
  })

  it('matches a stored symlinked key to the realpath session cwd', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'shield-repos-'))
    const real = join(scratch, 'real-repo')
    await mkdir(real)
    const alias = join(scratch, 'alias-repo')
    await symlink(real, alias)
    // Stored through the alias; the session side reports the normalized cwd,
    // exactly as ShieldHost.resolveCwd hands it to the gate.
    const cwd = resolveRepoPath(real)
    expect(repoDisabled({ [alias]: { enabled: false } }, cwd)).toBe(true)
    expect(repoGateBlocksMount({ [alias]: { enabled: false } }, [cwd])).toBe(true)
  })

  it('collapses two stored keys that normalize to the same path, later entry wins', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'shield-repos-'))
    const real = join(scratch, 'real-repo')
    await mkdir(real)
    const alias = join(scratch, 'alias-repo')
    await symlink(real, alias)
    const cwd = resolveRepoPath(real)
    // Insertion order decides: the later key overwrites the earlier one.
    const disabledThenEnabled = { [real]: { enabled: false }, [alias]: { enabled: true } }
    expect(repoDisabled(disabledThenEnabled, cwd)).toBe(false)
    const enabledThenDisabled = { [alias]: { enabled: true }, [real]: { enabled: false } }
    expect(repoDisabled(enabledThenDisabled, cwd)).toBe(true)
  })

  it('compares a vanished stored key exactly', () => {
    const gone = join(tmpdir(), 'shield-repos-gone')
    expect(repoDisabled({ [gone]: { enabled: false } }, gone)).toBe(true)
    expect(repoDisabled({ [gone]: { enabled: false } }, `${gone}/sub`)).toBe(false)
  })
})

describe('liveSessionCwds', () => {
  it('collects normalized cwds and drops sessions without one', () => {
    const cwds = liveSessionCwds({
      list: () => [{ header: { cwd: '/a' } }, { header: {} }, { header: { cwd: '/a' } }, { header: {} }],
    })
    expect(cwds).toEqual(['/a'])
  })

  it('returns empty without a session store', () => {
    expect(liveSessionCwds(undefined)).toEqual([])
    expect(liveSessionCwds({})).toEqual([])
  })
})

describe('validateRepoKeys', () => {
  it('accepts absolute paths', () => {
    expect(() => { validateRepoKeys({ '/repo/a': { enabled: false } }) }).not.toThrow()
  })

  it('rejects relative and empty keys', () => {
    expect(() => { validateRepoKeys({ 'repo/a': { enabled: false } }) }).toThrow(/absolute/)
    expect(() => { validateRepoKeys({ '': { enabled: false } }) }).toThrow(/absolute/)
  })
})
