/**
 * Edition ensure in the `shres plugin` forwarder: `enable-edition` selects a
 * declared edition (sets autoProvision and provisions), and the boot ensure
 * installs an enabled edition's missing packages through the same pnpm
 * forwarder, failing loud on a pnpm error. pnpm is stubbed — the profile
 * directory and manifest are the unit under test.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
import { spawnSync } from 'node:child_process'
import { ensureProfileEditions, runEnableEdition } from '../src/plugin.ts'

const pnpm = vi.mocked(spawnSync)

let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.SHRES_HOME
  pnpm.mockReset()
  pnpm.mockReturnValue({ status: 0, error: undefined } as never)
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.SHRES_HOME
  else process.env.SHRES_HOME = savedHome
})

interface Stage {
  home: string
  dir: string
  cleanup(): void
}

/** Stage a profile directory under a scratch SHRES_HOME with the given manifest body. */
function stageProfile(manifest: Record<string, unknown>): Stage {
  const home = mkdtempSync(join(tmpdir(), 'shres-plugin-'))
  const dir = join(home, 'profiles', 'tui')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  process.env.SHRES_HOME = home
  return { home, dir, cleanup: () =>{  rmSync(home, { recursive: true, force: true }) } }
}

const edition = (packages: string[], autoProvision: boolean) => ({ packages, autoProvision })
const MANIFEST = (editions?: Record<string, unknown>) => ({
  name: 'shres-profile-tui',
  private: true,
  dependencies: {},
  ...(editions === undefined ? {} : { shres: { editions } }),
})

function readJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('shres plugin edition ensure', () => {
  it('ensure is a no-op without declared editions', () => {
    const s = stageProfile(MANIFEST())
    try {
      expect(ensureProfileEditions(s.dir)).toBe(0)
      expect(pnpm).not.toHaveBeenCalled()
    } finally {
      s.cleanup()
    }
  })

  it('ensure is a no-op when no edition is enabled', () => {
    const s = stageProfile(MANIFEST({ shield: edition(['@shrestech/shres-shield-plugin'], false) }))
    try {
      expect(ensureProfileEditions(s.dir)).toBe(0)
      expect(pnpm).not.toHaveBeenCalled()
    } finally {
      s.cleanup()
    }
  })

  it('ensure is a no-op when an enabled edition is already resolvable', () => {
    const s = stageProfile(MANIFEST({ shield: edition(['@shrestech/shres-shield-plugin'], true) }))
    const pkgDir = join(s.dir, 'node_modules', '@shrestech', 'shres-shield-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{"name":"@shrestech/shres-shield-plugin","version":"0.1.0","main":"index.js"}\n')
    writeFileSync(join(pkgDir, 'index.js'), 'export const apply = () => {}\n')
    try {
      expect(ensureProfileEditions(s.dir)).toBe(0)
      expect(pnpm).not.toHaveBeenCalled()
    } finally {
      s.cleanup()
    }
  })

  it('provisions a missing enabled-edition package through pnpm add', () => {
    const s = stageProfile(MANIFEST({ shield: edition(['@shrestech/shres-shield-plugin'], true) }))
    try {
      expect(ensureProfileEditions(s.dir)).toBe(0)
      expect(pnpm).toHaveBeenCalledTimes(1)
      const [cmd, args, opts] = pnpm.mock.calls[0] as [string, string[], { cwd: string }]
      expect(cmd).toBe('pnpm')
      expect(args).toEqual(['add', '@shrestech/shres-shield-plugin'])
      expect(opts.cwd).toBe(s.dir)
    } finally {
      s.cleanup()
    }
  })

  it('provisions each missing spec once across enabled editions', () => {
    const s = stageProfile(MANIFEST({
      shield: edition(['@shrestech/shres-shield-plugin'], true),
      other: edition(['@scope/a', '@shrestech/shres-shield-plugin'], true),
    }))
    try {
      expect(ensureProfileEditions(s.dir)).toBe(0)
      const [, args] = pnpm.mock.calls[0] as [string, string[]]
      expect(args).toEqual(['add', '@shrestech/shres-shield-plugin', '@scope/a'])
    } finally {
      s.cleanup()
    }
  })

  it('fails loud with the pnpm exit code when provisioning fails', () => {
    const s = stageProfile(MANIFEST({ shield: edition(['@shrestech/shres-shield-plugin'], true) }))
    pnpm.mockReturnValue({ status: 5, error: undefined } as never)
    try {
      expect(ensureProfileEditions(s.dir)).toBe(5)
    } finally {
      s.cleanup()
    }
  })

  it('enable-edition rejects an undeclared edition without spawning pnpm', () => {
    const s = stageProfile(MANIFEST({}))
    try {
      expect(runEnableEdition('tui', 'shield')).toBe(1)
      expect(pnpm).not.toHaveBeenCalled()
      expect(readJson(s.dir)).toEqual(MANIFEST({}))
    } finally {
      s.cleanup()
    }
  })

  it('enable-edition selects a declared edition and provisions its packages', () => {
    const s = stageProfile(MANIFEST({ shield: edition(['@shrestech/shres-shield-plugin'], false) }))
    try {
      expect(runEnableEdition('tui', 'shield')).toBe(0)
      const manifest = readJson(s.dir) as { shres: { editions: Record<string, { autoProvision: boolean }> } }
      expect(manifest.shres?.editions?.shield?.autoProvision).toBe(true)
      expect(pnpm).toHaveBeenCalledTimes(1)
      const [, args] = pnpm.mock.calls[0] as [string, string[]]
      expect(args).toEqual(['add', '@shrestech/shres-shield-plugin'])
    } finally {
      s.cleanup()
    }
  })

  it('enable-edition is a no-op spawn when the declared edition carries no packages', () => {
    const s = stageProfile(MANIFEST({ shield: edition([], false) }))
    try {
      expect(runEnableEdition('tui', 'shield')).toBe(0)
      expect(pnpm).not.toHaveBeenCalled()
    } finally {
      s.cleanup()
    }
  })
})
