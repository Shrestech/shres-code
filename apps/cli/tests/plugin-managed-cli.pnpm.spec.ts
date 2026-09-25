/**
 * Keyless source/built CLI smoke selected by SHRES_EXAMPLE_MODE. Source uses
 * the ESM-only tsx hook; lib requires a fresh `pnpm run build` and uses the
 * compiled bin under plain Node. Both use
 * a fresh home and an isolated offline pnpm store: `install-plugin <local dir> --yes` must
 * initialize the profile, stage and install the plugin, and commit it; `remove-plugin --yes` must deactivate it and delete
 * the staged copy. No registry, browser, model, or user profile is touched.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveExampleMode } from '@shres-code/shres-code-loader-smoke'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const PROFILE = 'managed-smoke'
const mode = resolveExampleMode()
const launcher = mode === 'lib' ? ['apps/cli/lib/bin.js'] : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts']
let root: string

beforeEach(async () => {
  // A root outside the repository: an ancestor node_modules (a repo-local
  // TMPDIR) would resolve in-box bundles and hide a missing profiles fallback.
  root = await mkdtemp(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'shres-managed-cli-'))
  await mkdir(join(root, 'home-user'))
  await mkdir(join(root, 'tmp'))
  await writeFile(join(root, 'npmrc'), '')
  await writeFile(join(root, 'npm-globalrc'), '')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A zero-dependency local bundle with no lifecycle scripts; scripted refusals are the core's real-pnpm suite. */
async function fixture(): Promise<string> {
  const directory = join(root, 'plugin-hello')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'plugin-hello',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    shres: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(directory, 'index.js'), 'export const name = "plugin-hello"\n')
  await writeFile(join(directory, 'cordis.patch.yml'), '[]\n')
  return directory
}

/** Run the selected CLI artifact without inheriting user credentials or pnpm configuration. */
async function shres(args: string[]) {
  const result = await execa(process.execPath, [...launcher, ...args], {
    cwd: repoRoot,
    input: '',
    timeout: 110_000,
    killSignal: 'SIGKILL',
    reject: false,
    extendEnv: false,
    env: {
      PATH: process.env.PATH, HOME: join(root, 'home-user'), TMPDIR: join(root, 'tmp'),
      npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'npm-globalrc'),
      SHRES_HOME: join(root, 'home'),
      SHRES_AGENTS_HOME: join(root, 'agents'),
      npm_config_store_dir: join(root, 'store'),
      npm_config_offline: 'true',
    },
  })
  if (result.timedOut) throw new Error(`shres ${args.join(' ')} timed out. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

describe.runIf(process.platform !== 'win32')(`shres managed operations (${mode} CLI, fresh home)`, () => {
  it('installs a local plugin into a fresh profile, then removes it and its staged copy', async () => {
    const source = await fixture()
    const installed = await shres(['plugin', '--profile', PROFILE, 'install-plugin', source, '--yes'])
    expect(installed.exitCode, `stdout:\n${installed.stdout}\nstderr:\n${installed.stderr}`).toBe(0)
    expect(installed.stdout).toContain('"kind": "committed"')
    expect(installed.stdout).toContain('restart the profile to activate')
    // The fresh home's shared fallback now mirrors the installation's in-box bundles.
    expect(existsSync(join(root, 'home', 'profiles', 'node_modules', '@shres-code', 'shres-code-base'))).toBe(true)

    const profileDir = join(root, 'home', 'profiles', PROFILE)
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      shres?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.shres?.profile?.bundles).toContain('plugin-hello')
    expect(manifest.dependencies?.['plugin-hello']).toMatch(/^file:/)
    expect(await readdir(join(profileDir, '.shres-plugin-sources'))).toHaveLength(1)

    const removed = await shres(['plugin', '--profile', PROFILE, 'remove-plugin', 'plugin-hello', '--yes'])
    expect(removed.exitCode, `stdout:\n${removed.stdout}\nstderr:\n${removed.stderr}`).toBe(0)
    const after = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      shres?: { profile?: { bundles?: string[] } }
    }
    expect(after.shres?.profile?.bundles).not.toContain('plugin-hello')
    expect(after.dependencies?.['plugin-hello']).toBeUndefined()
    expect(await readdir(join(profileDir, '.shres-plugin-sources'))).toEqual([])
  }, 240_000)

  it('copies, lists, and removes a skill without executing its contents', async () => {
    const source = join(root, 'skill-source')
    await mkdir(source)
    const content = '---\nname: cli-skill-probe\ndescription: Keyless CLI artifact probe.\n---\nCLI_SKILL_PROBE\n'
    await writeFile(join(source, 'SKILL.md'), content)
    const added = await shres(['skill', 'add', source])
    expect(added.exitCode, added.stderr).toBe(0)
    expect(added.stderr).toContain('external programs and browser extensions are not installed')
    const copy = join(root, 'home', 'skills-installed', 'cli-skill-probe', 'SKILL.md')
    expect(await readFile(copy, 'utf8')).toBe(content)
    await writeFile(join(source, 'SKILL.md'), 'changed source\n')
    expect(await readFile(copy, 'utf8')).toBe(content)
    const listed = await shres(['skill', 'list'])
    expect(listed.exitCode, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ name: 'cli-skill-probe' })])
    const removed = await shres(['skill', 'remove', 'cli-skill-probe'])
    expect(removed.exitCode, removed.stderr).toBe(0)
    expect(existsSync(copy)).toBe(false)
  }, 240_000)
})
