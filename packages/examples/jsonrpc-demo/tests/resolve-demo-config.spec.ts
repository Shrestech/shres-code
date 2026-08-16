import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDemoConfig, selectExplicitConfigPath } from '../src/resolveDemoConfig.ts'

const NAME = 'dsh-jsonrpc-agent'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-jsonrpc-demo-config-'))

afterEach(() => {
  Reflect.deleteProperty(process.env, 'DSH_HOME')
})

function writeConfig(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

describe('selectExplicitConfigPath', () => {
  it('returns undefined when neither channel is set, ignoring a CWD cordis.yml', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: \'./hostile.js\'\n')
    expect(selectExplicitConfigPath({}, ['node', 'dsh-jsonrpc-agent'])).toBeUndefined()
  })

  it('prefers DSH_CORDIS_CONFIG over argv and treats empty values as absent', () => {
    expect(selectExplicitConfigPath(
      { DSH_CORDIS_CONFIG: '/from-env.yml' },
      ['node', 'bin', '/from-argv.yml'],
    )).toBe('/from-env.yml')
    expect(selectExplicitConfigPath(
      { DSH_CORDIS_CONFIG: '' },
      ['node', 'bin', '/from-argv.yml'],
    )).toBe('/from-argv.yml')
    expect(selectExplicitConfigPath({ DSH_CORDIS_CONFIG: '' }, ['node', 'bin', ''])).toBeUndefined()
  })

  it('reads process.env and process.argv when callers omit the sources', () => {
    const previous = process.env['DSH_CORDIS_CONFIG']
    process.env['DSH_CORDIS_CONFIG'] = '/default-env.yml'
    try {
      expect(selectExplicitConfigPath()).toBe('/default-env.yml')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'DSH_CORDIS_CONFIG')
      else process.env['DSH_CORDIS_CONFIG'] = previous
    }
  })
})

describe('resolveDemoConfig', () => {
  it('requires an explicit path and does not pick up CWD cordis.yml', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: \'@deepseek-ai/dsh-sdk-jsonrpc-server\'\n')
    expect(() => resolveDemoConfig({ binName: NAME, cwd, home: tmp() })).toThrow(
      `${NAME}: config is required — pass an explicit path; there is no working-directory fallback`,
    )
  })

  it('uses a bundled default when one is supplied and requested is empty', () => {
    const bundled = join(tmp(), 'bundled-cordis.yml')
    expect(resolveDemoConfig({
      requested: '',
      bundledDefault: bundled,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
    })).toBe(resolve(bundled))
  })

  it('refuses !!js outside $DSH_HOME', () => {
    const cwd = tmp()
    const path = writeConfig(cwd, 'cordis.yml', '- config: !!js "process.exit(0)"\n')
    expect(() => resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd,
      home: tmp(),
    })).toThrow(/outside \$DSH_HOME and contains !!js/)
    expect(() => resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd,
      home: tmp(),
    })).toThrow(/Place the file under \$DSH_HOME to pre-approve/)
  })

  it('refuses an unquoted relative plugin name outside $DSH_HOME', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: ./plugin.js\n')
    expect(() => resolveDemoConfig({
      requested: 'cordis.yml',
      binName: NAME,
      cwd,
      home: tmp(),
    })).toThrow(/outside \$DSH_HOME and contains a relative plugin name/)
  })

  it('refuses both constructs in one diagnostic', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: "../escape.js"\n  config: !!js "1"\n')
    expect(() => resolveDemoConfig({
      requested: join(cwd, 'cordis.yml'),
      binName: NAME,
      cwd,
      home: tmp(),
    })).toThrow(/contains !!js and a relative plugin name/)
  })

  it('allows !!js inside $DSH_HOME', () => {
    const home = tmp()
    const path = writeConfig(home, 'approved.yml', '- config: !!js "1"\n')
    expect(resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd: tmp(),
      home,
    })).toBe(resolve(path))
  })

  it('treats a config whose canonical path is $DSH_HOME as inside home', () => {
    const home = writeConfig(tmp(), 'home.yml', '- config: !!js "1"\n')
    expect(resolveDemoConfig({
      requested: home,
      binName: NAME,
      cwd: tmp(),
      home,
    })).toBe(resolve(home))
  })

  it('allows a file with neither construct outside $DSH_HOME', () => {
    const cwd = tmp()
    const path = writeConfig(cwd, 'safe.yml', '- name: \'@deepseek-ai/dsh-sdk-jsonrpc-server\'\n')
    expect(resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd,
      home: tmp(),
    })).toBe(resolve(path))
  })

  it('fails a missing explicit file as not found', () => {
    const cwd = tmp()
    const missing = join(cwd, 'missing.yml')
    expect(() => resolveDemoConfig({
      requested: missing,
      binName: NAME,
      cwd,
      home: tmp(),
    })).toThrow(`${NAME}: config file not found: ${resolve(missing)}`)
  })

  it('fails an unreadable explicit path with a read error', () => {
    const cwd = tmp()
    const dir = join(cwd, 'not-a-file.yml')
    mkdirSync(dir)
    expect(() => resolveDemoConfig({
      requested: dir,
      binName: NAME,
      cwd,
      home: tmp(),
    })).toThrow(new RegExp(`^${NAME}: failed to read config ${resolve(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `))
  })

  it('follows a symlink when deciding whether the file is under $DSH_HOME', () => {
    const home = tmp()
    const outside = tmp()
    const real = writeConfig(outside, 'evil.yml', '- config: !!js "1"\n')
    const linked = join(home, 'linked.yml')
    symlinkSync(real, linked)
    expect(() => resolveDemoConfig({
      requested: linked,
      binName: NAME,
      cwd: tmp(),
      home,
    })).toThrow(/outside \$DSH_HOME and contains !!js/)

    const approved = writeConfig(home, 'ok.yml', '- config: !!js "1"\n')
    const aliasHome = tmp()
    const alias = join(aliasHome, 'ok.yml')
    symlinkSync(approved, alias)
    expect(resolveDemoConfig({
      requested: alias,
      binName: NAME,
      cwd: tmp(),
      home,
    })).toBe(resolve(alias))
  })

  it('uses process.cwd and resolveDshHome when cwd and home are omitted', () => {
    const cwd = tmp()
    const home = tmp()
    writeConfig(cwd, 'safe.yml', '- name: \'@deepseek-ai/dsh-sdk-jsonrpc-server\'\n')
    const previous = process.cwd()
    process.env.DSH_HOME = home
    process.chdir(cwd)
    try {
      expect(resolveDemoConfig({ requested: 'safe.yml', binName: NAME })).toBe(resolve(process.cwd(), 'safe.yml'))
    } finally {
      process.chdir(previous)
    }
  })

  it('falls back to the spelled home path when $DSH_HOME does not exist', () => {
    const cwd = tmp()
    const path = writeConfig(cwd, 'js.yml', '- config: !!js "1"\n')
    expect(() => resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd,
      home: join(tmp(), 'missing-home'),
    })).toThrow(/outside \$DSH_HOME and contains !!js/)
  })
})
