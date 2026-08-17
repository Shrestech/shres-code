import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SHRES_HOME_DISPLAY,
  SHRES_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultShresHome,
  shresHomeDisplay,
  shresHomePath,
  expandHomePath,
  resolveShresHome,
} from '@shres-code/shres-code-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('shres path helpers', () => {
  it('owns the shared default Shres home directory name', () => {
    expect(SHRES_HOME_DIR_NAME).toBe('.shres')
    expect(DEFAULT_SHRES_HOME_DISPLAY).toBe('~/.shres')
    expect(defaultShresHome()).toBe(join(homedir(), '.shres'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.shres')).toBe(join(homedir(), '.shres'))
    expect(expandHomePath('~\\.shres')).toBe(join(homedir(), '.shres'))
    expect(expandHomePath('/tmp/.shres')).toBe('/tmp/.shres')
    expect(expandHomePath('~other/.shres')).toBe('~other/.shres')
  })

  it('resolves explicit path before SHRES_HOME and the default', () => {
    const envHome = join(homedir(), 'env-shres')

    expect(resolveShresHome('/tmp/explicit-shres', { SHRES_HOME: '~/env-shres' })).toBe(resolve('/tmp/explicit-shres'))
    expect(resolveShresHome(undefined, { SHRES_HOME: '~/env-shres' })).toBe(envHome)
    expect(resolveShresHome(undefined, {})).toBe(defaultShresHome())
  })

  it('treats an empty or whitespace-only SHRES_HOME as unset', () => {
    expect(resolveShresHome(undefined, { SHRES_HOME: '' })).toBe(defaultShresHome())
    expect(resolveShresHome(undefined, { SHRES_HOME: '   ' })).toBe(defaultShresHome())
  })

  it('joins child segments onto the resolved SHRES_HOME', () => {
    vi.stubEnv('SHRES_HOME', '~/env-shres')
    expect(shresHomePath()).toBe(join(homedir(), 'env-shres'))
    expect(shresHomePath('storages', 'cache')).toBe(join(homedir(), 'env-shres', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(shresHomeDisplay(resolve(defaultShresHome()))).toBe('~/.shres')
    expect(shresHomeDisplay('/some/other/root')).toBe('$SHRES_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shres-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
