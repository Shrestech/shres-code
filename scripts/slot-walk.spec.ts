/**
 * Slot catalog scan skips oxlint-contract probes and vanished files so a
 * concurrent coverage run cannot ENOENT mid-walk.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { indexExportedTypes } from './slot-walk.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('slot-walk source listing', () => {
  it('indexes real exports and ignores oxlint-contract probe files', () => {
    const root = mkdtempSync(join(tmpdir(), 'shres-slot-walk-'))
    roots.push(root)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'keep.ts'), 'export interface Keep { n: number }\n')
    writeFileSync(
      join(root, 'src', 'oxlint-contract-deadbeef.ts'),
      'export interface Probe { n: number }\n',
    )
    const types = indexExportedTypes(root, ['src/**/*.ts'])
    expect([...types.keys()]).toEqual(['Keep'])
  })
})
