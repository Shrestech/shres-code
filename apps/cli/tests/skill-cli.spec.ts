/** Skill CLI commands use the real install helpers in an isolated Harness home. */
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSkillCli } from '../src/skill-cli.ts'

let root: string
let source: string
let output: string[]
let errors: string[]
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-cli-'))
  source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'SKILL.md'), '---\nname: cli-probe\ndescription: Skill CLI integration probe.\n---\nLocal instructions.\n')
  vi.stubEnv('SHRES_HOME', join(root, 'home'))
  vi.stubEnv('SHRES_AGENTS_HOME', join(root, 'agents'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  output = []
  errors = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { errors.push(String(chunk)); return true })
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('skill CLI', () => {
  it('adds, lists, and removes a managed copy without claiming external setup', async () => {
    expect(await runSkillCli({ kind: 'add', directory: source })).toBe(0)
    expect(JSON.parse(output.join('')) as unknown).toMatchObject({ kind: 'installed', name: 'cli-probe' })
    expect(errors.join('')).toContain('external programs and browser extensions are not installed')
    expect(errors.join('')).toContain('runtime')
    output.length = 0
    expect(await runSkillCli({ kind: 'list' })).toBe(0)
    expect(JSON.parse(output.join('')) as unknown).toMatchObject([{ name: 'cli-probe', origin: await realpath(source) }])
    output.length = 0
    expect(await runSkillCli({ kind: 'remove', name: 'cli-probe' })).toBe(0)
    expect(JSON.parse(output.join('')) as unknown).toEqual({ kind: 'removed' })
    output.length = 0
    expect(await runSkillCli({ kind: 'list' })).toBe(0)
    expect(JSON.parse(output.join('')) as unknown).toEqual([])
  })
  it('returns failure for invalid source and duplicate names', async () => {
    expect(await runSkillCli({ kind: 'add', directory: join(root, 'missing') })).toBe(1)
    expect(await runSkillCli({ kind: 'add', directory: source })).toBe(0)
    output.length = 0
    expect(await runSkillCli({ kind: 'add', directory: source })).toBe(1)
    expect(JSON.parse(output.join('')) as unknown).toMatchObject({ kind: 'refused', code: 'name-taken' })
  })
  it('does not remove an unmanaged or nonexistent entry', async () => {
    expect(await runSkillCli({ kind: 'remove', name: 'missing' })).toBe(1)
    const handPlaced = join(root, 'home', 'skills-installed', 'manual')
    await mkdir(handPlaced, { recursive: true })
    await writeFile(join(handPlaced, 'SKILL.md'), '---\nname: manual\ndescription: Hand-placed skill.\n---\nBody.\n')
    output.length = 0
    expect(await runSkillCli({ kind: 'remove', name: 'manual' })).toBe(1)
    expect(JSON.parse(output.join('')) as unknown).toMatchObject({ kind: 'refused', code: 'not-managed' })
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports unreadable roots without printing a successful list', async () => {
    const installed = join(root, 'home', 'skills-installed')
    await mkdir(installed, { recursive: true })
    await chmod(installed, 0o000)
    try {
      expect(await runSkillCli({ kind: 'list' })).toBe(1)
      expect(output).toEqual([])
      expect(errors.join('')).toContain('EACCES')
    } finally { await chmod(installed, 0o700) }
  })
})
