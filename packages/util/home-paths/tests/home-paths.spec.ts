import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ROOS_HOME_DISPLAY,
  ROOS_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultRoosHome,
  roosHomeDisplay,
  roosHomePath,
  expandHomePath,
  resolveRoosHome,
} from '@roos-code/roos-code-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('roos path helpers', () => {
  it('owns the shared default Roos home directory name', () => {
    expect(ROOS_HOME_DIR_NAME).toBe('.roos')
    expect(DEFAULT_ROOS_HOME_DISPLAY).toBe('~/.roos')
    expect(defaultRoosHome()).toBe(join(homedir(), '.roos'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.roos')).toBe(join(homedir(), '.roos'))
    expect(expandHomePath('~\\.roos')).toBe(join(homedir(), '.roos'))
    expect(expandHomePath('/tmp/.roos')).toBe('/tmp/.roos')
    expect(expandHomePath('~other/.roos')).toBe('~other/.roos')
  })

  it('resolves explicit path before ROOS_HOME and the default', () => {
    const envHome = join(homedir(), 'env-roos')

    expect(resolveRoosHome('/tmp/explicit-roos', { ROOS_HOME: '~/env-roos' })).toBe(resolve('/tmp/explicit-roos'))
    expect(resolveRoosHome(undefined, { ROOS_HOME: '~/env-roos' })).toBe(envHome)
    expect(resolveRoosHome(undefined, {})).toBe(defaultRoosHome())
  })

  it('treats an empty or whitespace-only ROOS_HOME as unset', () => {
    expect(resolveRoosHome(undefined, { ROOS_HOME: '' })).toBe(defaultRoosHome())
    expect(resolveRoosHome(undefined, { ROOS_HOME: '   ' })).toBe(defaultRoosHome())
  })

  it('joins child segments onto the resolved ROOS_HOME', () => {
    vi.stubEnv('ROOS_HOME', '~/env-roos')
    expect(roosHomePath()).toBe(join(homedir(), 'env-roos'))
    expect(roosHomePath('storages', 'cache')).toBe(join(homedir(), 'env-roos', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(roosHomeDisplay(resolve(defaultRoosHome()))).toBe('~/.roos')
    expect(roosHomeDisplay('/some/other/root')).toBe('$ROOS_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'roos-watch-path-'))
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
