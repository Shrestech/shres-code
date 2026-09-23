import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyRuntimeTree } from '../scripts/prepare-runtime-tree.ts'

const packageNames = [
  'shres-code',
  'shres-code-desktop-host',
  'shres-code-base',
  'shres-code-web-app',
  'shres-code-web-frontend',
] as const

const roots: string[] = []

function fixture(options: { missingAsset?: string; missingPeer?: boolean; symlink?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shres-runtime-fixture-'))
  roots.push(root)
  const scope = join(root, 'node_modules', '@shres-code')
  for (const name of packageNames) {
    const directory = join(scope, name)
    mkdirSync(directory, { recursive: true })
    const manifest = options.missingPeer && name === 'shres-code'
      ? { peerDependencies: { '@shres-code/missing': '^1.0.0' } }
      : {}
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest)}\n`)
  }

  const files = {
    hostEntry: join(scope, 'shres-code-desktop-host/lib/index.js'),
    hostPatch: join(scope, 'shres-code-desktop-host/config/desktop.cordis.patch.yml'),
    presets: join(scope, 'shres-code/config/agent-presets/default.yml'),
    frontend: join(scope, 'shres-code-web-frontend/dist/index.html'),
  }
  for (const path of Object.values(files)) {
    if (path.endsWith(options.missingAsset ?? '\u0000')) continue
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'fixture\n')
  }
  if (options.symlink) symlinkSync(join(root, 'outside'), join(root, 'runtime-link'))
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verifyRuntimeTree', () => {
  it('accepts a complete packed runtime fixture', () => {
    const budget = verifyRuntimeTree(fixture())
    expect(budget.files).toBeGreaterThan(0)
    expect(budget.bytes).toBeGreaterThan(0)
  })

  it('rejects a packed package peer that is absent', () => {
    expect(() => verifyRuntimeTree(fixture({ missingPeer: true }))).toThrow(
      /references absent packed dependency @shres-code\/missing/,
    )
  })

  it('rejects a missing boot asset', () => {
    expect(() => verifyRuntimeTree(fixture({ missingAsset: 'desktop.cordis.patch.yml' }))).toThrow(
      /missing required file .*desktop\.cordis\.patch\.yml/,
    )
  })

  it('rejects a surviving symlink before tree promotion', () => {
    expect(() => verifyRuntimeTree(fixture({ symlink: true }))).toThrow(/unexpected link/)
  })
})
