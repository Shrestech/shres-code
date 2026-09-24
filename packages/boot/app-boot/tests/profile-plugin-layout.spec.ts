/** The installed-layout record reader and the hoisted-only refusal rule. */
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { layoutRefusal, MODULES_RECORD, readModulesLayout } from '../src/profile-plugin-layout.ts'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function profile(record?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-layout-'))
  temps.push(dir)
  if (record !== undefined) {
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, MODULES_RECORD), record)
  }
  return dir
}

describe('readModulesLayout', () => {
  it('reports an absent record', async () => {
    expect(await readModulesLayout(await profile())).toEqual({ kind: 'absent' })
  })

  it('reads the recorded linker from pnpm\'s JSON record', async () => {
    expect(await readModulesLayout(await profile(JSON.stringify({ layoutVersion: 5, nodeLinker: 'hoisted' }))))
      .toEqual({ kind: 'recorded', nodeLinker: 'hoisted' })
    expect(await readModulesLayout(await profile('nodeLinker: isolated\n')))
      .toEqual({ kind: 'recorded', nodeLinker: 'isolated' })
  })

  it.each([
    ['no nodeLinker field', JSON.stringify({ layoutVersion: 5 })],
    ['a non-string nodeLinker', JSON.stringify({ nodeLinker: 1 })],
    ['a scalar document', '"hoisted"'],
    ['an empty document', ''],
  ])('records a null linker for %s', async (_label, record) => {
    expect(await readModulesLayout(await profile(record))).toEqual({ kind: 'recorded', nodeLinker: null })
  })

  it('reports malformed YAML as unreadable', async () => {
    expect(await readModulesLayout(await profile('{ unterminated'))).toMatchObject({ kind: 'unreadable' })
  })

  it('reports a linked record as unreadable without following it', async () => {
    const dir = await profile()
    const outside = join(dir, 'outside.yaml')
    await writeFile(outside, 'nodeLinker: hoisted\n')
    await mkdir(join(dir, 'node_modules'))
    await symlink(outside, join(dir, MODULES_RECORD))
    expect(await readModulesLayout(dir)).toEqual({ kind: 'unreadable', detail: expect.stringContaining('not a regular file') as unknown })
  })

  it.runIf(process.platform !== 'win32')('reports a FIFO record as unreadable without opening it', async () => {
    const dir = await profile()
    await mkdir(join(dir, 'node_modules'))
    execFileSync('mkfifo', [join(dir, MODULES_RECORD)])
    expect(await readModulesLayout(dir)).toMatchObject({ kind: 'unreadable' })
  })

  it('reports an lstat failure other than absence as unreadable', async () => {
    const dir = await profile()
    await writeFile(join(dir, 'node_modules'), 'a file, not a directory')
    expect(await readModulesLayout(dir)).toMatchObject({ kind: 'unreadable', detail: expect.stringContaining('ENOTDIR') as unknown })
  })

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)('reports an unreadable record', async () => {
    const dir = await profile('nodeLinker: hoisted\n')
    await chmod(join(dir, MODULES_RECORD), 0o000)
    try {
      expect(await readModulesLayout(dir)).toMatchObject({ kind: 'unreadable', detail: expect.stringContaining('EACCES') as unknown })
    } finally {
      await chmod(join(dir, MODULES_RECORD), 0o600)
    }
  })
})

describe('layoutRefusal', () => {
  it('accepts hoisted in both phases and an absent record only before install', () => {
    expect(layoutRefusal({ kind: 'recorded', nodeLinker: 'hoisted' }, 'before')).toBeUndefined()
    expect(layoutRefusal({ kind: 'recorded', nodeLinker: 'hoisted' }, 'after')).toBeUndefined()
    expect(layoutRefusal({ kind: 'absent' }, 'before')).toBeUndefined()
    expect(layoutRefusal({ kind: 'absent' }, 'after')).toMatchObject({ code: 'unsupported-layout', nodeLinker: null })
  })

  it.each(['before', 'after'] as const)('refuses other, missing, and unreadable linkers %s install', (phase) => {
    expect(layoutRefusal({ kind: 'recorded', nodeLinker: 'isolated' }, phase))
      .toEqual({ code: 'unsupported-layout', nodeLinker: 'isolated', detail: expect.stringContaining('isolated linker') as unknown })
    expect(layoutRefusal({ kind: 'recorded', nodeLinker: null }, phase))
      .toEqual({ code: 'unsupported-layout', nodeLinker: null, detail: expect.stringContaining('records no nodeLinker') as unknown })
    expect(layoutRefusal({ kind: 'unreadable', detail: 'boom' }, phase))
      .toEqual({ code: 'unsupported-layout', nodeLinker: null, detail: expect.stringContaining('boom') as unknown })
  })
})
