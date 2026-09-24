/**
 * Real, keyless managed-plugin smoke through the SOURCE CLI entry
 * (`node --import tsx/esm apps/cli/src/bin.ts`) in a fresh SHRES_HOME with an
 * isolated offline pnpm store: `install-plugin <local dir> --yes` must
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

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const PROFILE = 'managed-smoke'
let root: string

beforeEach(async () => {
  // A root outside the repository: an ancestor node_modules (a repo-local
  // TMPDIR) would resolve in-box bundles and hide a missing profiles fallback.
  root = await mkdtemp(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'shres-managed-cli-'))
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

/** Run the source CLI with a fresh home and an isolated offline store. */
async function shres(args: string[]) {
  const result = await execa(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...args], {
    cwd: repoRoot,
    input: '',
    timeout: 110_000,
    killSignal: 'SIGKILL',
    reject: false,
    env: {
      SHRES_HOME: join(root, 'home'),
      SHRES_AGENTS_HOME: join(root, 'agents'),
      npm_config_store_dir: join(root, 'store'),
      npm_config_offline: 'true',
    },
  })
  if (result.timedOut) throw new Error(`shres ${args.join(' ')} timed out. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result
}

describe.runIf(process.platform !== 'win32')('shres plugin install-plugin / remove-plugin (source CLI, fresh home)', () => {
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
})
