import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledAcpDemoConfigPath, resolveDemoConfig } from '../src/resolveDemoConfig.ts'

const NAME = 'dsh-acp-demo'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-acp-demo-config-'))

afterEach(() => {
  Reflect.deleteProperty(process.env, 'DSH_HOME')
})

function writeConfig(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

describe('bundledAcpDemoConfigPath', () => {
  it('resolves the package-local default beside the given module URL', () => {
    const dir = tmp()
    const moduleUrl = pathToFileURL(join(dir, 'src', 'resolveDemoConfig.ts')).href
    expect(bundledAcpDemoConfigPath(moduleUrl)).toBe(join(dir, 'cordis.yml'))
  })

  it('defaults to this package\'s cordis.yml beside the resolver module', () => {
    expect(bundledAcpDemoConfigPath()).toBe(resolve(fileURLToPath(new URL('../cordis.yml', import.meta.url))))
  })
})

describe('resolveDemoConfig', () => {
  it('uses the bundled default even when CWD holds a cordis.yml', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: \'./hostile.js\'\nconfig: !!js "1"\n')
    const bundled = join(tmp(), 'bundled-cordis.yml')
    expect(resolveDemoConfig({
      bundledDefault: bundled,
      binName: NAME,
      cwd,
      home: tmp(),
    })).toBe(resolve(bundled))
  })

  it('treats an empty requested path as absent', () => {
    const bundled = join(tmp(), 'bundled-cordis.yml')
    expect(resolveDemoConfig({
      requested: '',
      bundledDefault: bundled,
      binName: NAME,
      cwd: tmp(),
      home: tmp(),
    })).toBe(resolve(bundled))
  })

  it('throws when neither an explicit path nor a bundled default is given', () => {
    const cwd = tmp()
    writeConfig(cwd, 'cordis.yml', '- name: \'@deepseek-ai/dsh-acp-demo\'\n')
    expect(() => resolveDemoConfig({ binName: NAME, cwd, home: tmp() })).toThrow(
      `${NAME}: config is required — pass an explicit path; there is no working-directory fallback`,
    )
  })

  it('refuses !!js outside $DSH_HOME', () => {
    const cwd = tmp()
    const path = writeConfig(cwd, 'cordis.yml', '- id: x\n  config: !!js "process.exit(0)"\n')
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

  it('refuses a relative plugin name outside $DSH_HOME', () => {
    const cwd = tmp()
    const path = writeConfig(cwd, 'cordis.yml', '- name: \'./plugin.js\'\n')
    expect(() => resolveDemoConfig({
      requested: 'cordis.yml',
      binName: NAME,
      cwd,
      home: tmp(),
    })).toThrow(/outside \$DSH_HOME and contains a relative plugin name/)
    expect(path).toBe(join(cwd, 'cordis.yml'))
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
    const path = writeConfig(cwd, 'safe.yml', '- name: \'@deepseek-ai/dsh-acp-demo\'\n')
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
    writeConfig(cwd, 'safe.yml', '- name: \'@deepseek-ai/dsh-acp-demo\'\n')
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
