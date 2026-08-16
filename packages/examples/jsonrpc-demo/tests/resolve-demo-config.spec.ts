import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDemoConfig, selectExplicitConfigPath } from '../src/resolveDemoConfig.ts'

const NAME = 'dsh-jsonrpc-agent'
const FIRST_PARTY_LEAF = fileURLToPath(new URL('../../../../examples/jsonrpc-agent/cordis.yml', import.meta.url))

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

  it('allows the first-party examples/jsonrpc-agent/cordis.yml leaf', () => {
    expect(resolveDemoConfig({
      requested: FIRST_PARTY_LEAF,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
    })).toBe(resolve(FIRST_PARTY_LEAF))
  })

  it('allows !!js under a harness source checkout discovered from the bin', () => {
    const checkout = tmp()
    writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages: []\n')
    mkdirSync(join(checkout, 'examples'))
    mkdirSync(join(checkout, 'packages', 'examples', 'acp-demo'), { recursive: true })
    mkdirSync(join(checkout, 'packages', 'examples', 'jsonrpc-demo'), { recursive: true })
    writeFileSync(join(checkout, 'packages', 'examples', 'acp-demo', 'package.json'), '{}')
    writeFileSync(join(checkout, 'packages', 'examples', 'jsonrpc-demo', 'package.json'), '{}')
    const leaf = writeConfig(join(checkout, 'examples'), 'leaf.yml', '- config: !!js "1"\n')
    const anchor = join(checkout, 'packages', 'examples', 'jsonrpc-demo', 'src', 'resolveDemoConfig.ts')
    mkdirSync(dirname(anchor), { recursive: true })
    expect(resolveDemoConfig({
      requested: leaf,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
      installAnchor: anchor,
    })).toBe(resolve(leaf))
  })

  it('allows !!js under a packaged runtime tree next to the bin', () => {
    const root = tmp()
    const runtime = join(root, 'runtime')
    mkdirSync(join(runtime, 'node'), { recursive: true })
    const path = writeConfig(runtime, 'cordis.yml', '- config: !!js "1"\n')
    const bin = join(runtime, 'node', 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'packaged-bin.js')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '')
    expect(resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
      installAnchor: bin,
    })).toBe(resolve(path))
  })

  it('allows !!js inside an installed demo package directory', () => {
    const pkg = tmp()
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-sdk-jsonrpc-demo' }))
    const path = writeConfig(pkg, 'trusted.yml', '- config: !!js "1"\n')
    expect(resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
      installAnchor: join(pkg, 'lib', 'bin.js'),
    })).toBe(resolve(path))
  })

  it('refuses !!js outside $DSH_HOME and outside every first-party tree', () => {
    const cwd = tmp()
    const path = writeConfig(cwd, 'cordis.yml', '- config: !!js "process.exit(0)"\n')
    expect(() => resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd,
      home: tmp(),
      installAnchor: cwd,
    })).toThrow(/contains !!js and is not under \$DSH_HOME or a first-party\/packaged install tree/)
    expect(() => resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd,
      home: tmp(),
      installAnchor: cwd,
    })).toThrow(/Place the file under \$DSH_HOME to pre-approve/)
  })

  it('refuses a relative plugin name with a space before the colon', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name : ./plugin.js\n')
    expect(() => resolveDemoConfig({
      requested: 'cordis.yml',
      binName: NAME,
      cwd,
      home: tmp(),
      installAnchor: cwd,
    })).toThrow(/contains a relative plugin name/)
  })

  it('refuses a relative plugin name after !!str', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: !!str ./plugin.js\n')
    expect(() => resolveDemoConfig({
      requested: 'cordis.yml',
      binName: NAME,
      cwd,
      home: tmp(),
      installAnchor: cwd,
    })).toThrow(/contains a relative plugin name/)
  })

  it('refuses both constructs in one diagnostic', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: "../escape.js"\n  config: !!js "1"\n')
    expect(() => resolveDemoConfig({
      requested: join(cwd, 'cordis.yml'),
      binName: NAME,
      cwd,
      home: tmp(),
      installAnchor: cwd,
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
      installAnchor: tmp(),
    })).toBe(resolve(path))
  })

  it('treats a config whose canonical path is $DSH_HOME as inside home', () => {
    const home = writeConfig(tmp(), 'home.yml', '- config: !!js "1"\n')
    expect(resolveDemoConfig({
      requested: home,
      binName: NAME,
      cwd: tmp(),
      home,
      installAnchor: tmp(),
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
      installAnchor: tmp(),
    })).toThrow(/contains !!js/)

    const approved = writeConfig(home, 'ok.yml', '- config: !!js "1"\n')
    const aliasHome = tmp()
    const alias = join(aliasHome, 'ok.yml')
    symlinkSync(approved, alias)
    expect(resolveDemoConfig({
      requested: alias,
      binName: NAME,
      cwd: tmp(),
      home,
      installAnchor: tmp(),
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
      installAnchor: cwd,
    })).toThrow(/contains !!js/)
  })

  it('walks a directory installAnchor and ignores a non-demo package.json', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'other' }))
    const path = writeConfig(dir, 'js.yml', '- config: !!js "1"\n')
    expect(() => resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
      installAnchor: dir,
    })).toThrow(/contains !!js/)
    writeFileSync(join(dir, 'package.json'), '{')
    expect(() => resolveDemoConfig({
      requested: path,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
      installAnchor: dir,
    })).toThrow(/contains !!js/)
  })
})
