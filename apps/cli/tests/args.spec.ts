import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseShresArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseShresArgs(argv, '1.2.3')

/** Capture the process exit code while muting Commander's output. */
function exitCode(argv: string[]): number {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    parse(argv)
    throw new Error(`expected ${JSON.stringify(argv)} to exit`)
  } catch {
    return exit.mock.calls.at(-1)?.[0] as number
  } finally {
    vi.restoreAllMocks()
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseShresArgs', () => {
  it('routes profile boots and the web alias, handing the rest to the app', () => {
    expect(parse(['--profile', 'tui'])).toEqual({ mode: 'profile', profile: 'tui', patches: [], args: [] })
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--patch', 'b.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml', 'b.yml'], args: [] })
    expect(parse(['web'])).toEqual({ mode: 'profile', profile: 'web', patches: [], args: [] })
    expect(parse(['web', '--patch', 'web.yml']))
      .toEqual({ mode: 'profile', profile: 'web', patches: ['web.yml'], args: [] })
  })

  it('ends the launcher flags at the first token it does not own', () => {
    // App flags, including its -h, and positionals reach the app verbatim.
    expect(parse(['--profile', 'tui', '--resume', 'abc']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: [], args: ['--resume', 'abc'] })
    expect(parse(['--profile', 'web', '-h']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['-h'] })
    expect(parse(['web', '--host', '127.0.0.1', '--port', '8080', '--dev']))
      .toEqual({ mode: 'profile', profile: 'web', patches: [], args: ['--host', '127.0.0.1', '--port', '8080', '--dev'] })
    expect(parse(['--profile', 'headless', 'run', 'the', 'tests']))
      .toEqual({ mode: 'profile', profile: 'headless', patches: [], args: ['run', 'the', 'tests'] })
    // Launcher flags placed after that boundary belong to the app too.
    expect(parse(['--profile', 'tui', '--patch', 'a.yml', '--resume', 'b', '--patch', 'late.yml']))
      .toEqual({ mode: 'profile', profile: 'tui', patches: ['a.yml'], args: ['--resume', 'b', '--patch', 'late.yml'] })
  })

  it('routes managed plugin operations with explicit consent flags', () => {
    expect(parse(['plugin', '--profile', 'web', 'install-plugin', './plugin']))
      .toEqual({ mode: 'plugin-management', command: { kind: 'install', profile: 'web', target: './plugin', yes: false } })
    expect(parse(['plugin', '--profile', 'web', 'install-plugin', '@example/plugin@1', '--yes']))
      .toEqual({ mode: 'plugin-management', command: { kind: 'install', profile: 'web', target: '@example/plugin@1', yes: true } })
    expect(parse(['plugin', '--profile', 'web', 'remove-plugin', '--yes', '@example/plugin']))
      .toEqual({ mode: 'plugin-management', command: { kind: 'remove', profile: 'web', target: '@example/plugin', yes: true } })
  })

  it.each([
    ['install-plugin'],
    ['install-plugin', '--yes'],
    ['install-plugin', ''],
    ['install-plugin', 'one', 'two'],
    ['install-plugin', 'one', '--yes', '--yes'],
    ['install-plugin', 'one', '--ignore-scripts'],
    ['remove-plugin'],
    ['remove-plugin', '--unknown'],
  ])('rejects malformed managed plugin arguments %j', (...args) => {
    expect(exitCode(['plugin', '--profile', 'web', ...args])).toBe(1)
  })

  it('routes local skill operations independently of profiles', () => {
    expect(parse(['skill', 'add', './browser-skill']))
      .toEqual({ mode: 'skill', command: { kind: 'add', directory: './browser-skill' } })
    expect(parse(['skill', 'list']))
      .toEqual({ mode: 'skill', command: { kind: 'list' } })
    expect(parse(['skill', 'remove', 'browser-skill']))
      .toEqual({ mode: 'skill', command: { kind: 'remove', name: 'browser-skill' } })
    expect(exitCode(['skill', 'add'])).toBe(1)
    expect(exitCode(['skill', 'remove'])).toBe(1)
    expect(exitCode(['skill', 'add', './one', '--force'])).toBe(1)
    expect(exitCode(['--profile', 'web', 'skill', 'list'])).toBe(1)
  })

  it('routes the plugin pnpm forwarder', () => {
    expect(parse(['plugin', '--profile', 'tui', 'add', 'turtle-ui']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', 'turtle-ui'] })
    expect(parse(['plugin', '--profile', 'tui', 'remove', 'turtle-ui']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['remove', 'turtle-ui'] })
    expect(parse(['plugin', '--profile', 'tui', 'why', '@shres-code/cordis']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['why', '@shres-code/cordis'] })
    // Unknown pnpm flags forward verbatim.
    expect(parse(['plugin', '--profile', 'tui', 'add', '--save-dev', 'x']))
      .toEqual({ mode: 'plugin', profile: 'tui', args: ['add', '--save-dev', 'x'] })
  })

  it('routes plugin enable-edition as an edition selection', () => {
    expect(parse(['plugin', '--profile', 'tui', 'enable-edition', 'shield']))
      .toEqual({ mode: 'enable-edition', profile: 'tui', edition: 'shield' })
    expect(exitCode(['plugin', '--profile', 'tui', 'enable-edition'])).toBe(1) // missing edition name
    expect(exitCode(['plugin', '--profile', 'tui', 'enable-edition', 'shield', 'extra'])).toBe(1)
  })

  it('routes models and providers subcommands', () => {
    expect(parse(['models', 'list'])).toEqual({ mode: 'models', command: { kind: 'models-list' } })
    expect(parse(['models', 'set', 'ollama-local', 'llama3.2', '--effort', 'high']))
      .toEqual({
        mode: 'models',
        command: { kind: 'models-set', provider: 'ollama-local', model: 'llama3.2', effort: 'high' },
      })
    expect(parse(['models', 'set', 'ollama-local', 'qwen3', '--purpose', 'compaction']))
      .toEqual({
        mode: 'models',
        command: {
          kind: 'models-set', provider: 'ollama-local', model: 'qwen3', purpose: 'compaction',
        },
      })
    expect(parse(['models', 'discover', 'ollama-local', '--base-url', 'http://127.0.0.1:11434/v1', '--add']))
      .toEqual({
        mode: 'models',
        command: {
          kind: 'models-discover',
          provider: 'ollama-local',
          baseURL: 'http://127.0.0.1:11434/v1',
          add: true,
        },
      })
    expect(parse(['providers', 'list'])).toEqual({ mode: 'models', command: { kind: 'providers-list' } })
    expect(parse(['providers', 'add', '--template', 'ollama-local']))
      .toEqual({ mode: 'models', command: { kind: 'providers-add', template: 'ollama-local' } })
    expect(parse(['providers', 'add', '--template', 'custom', '--base-url', 'http://x/v1', '--provider', 'acme', '--model', 'm']))
      .toEqual({
        mode: 'models',
        command: {
          kind: 'providers-add',
          template: 'custom',
          baseURL: 'http://x/v1',
          provider: 'acme',
          model: 'm',
        },
      })
    expect(parse(['providers', 'remove', 'acme']))
      .toEqual({ mode: 'models', command: { kind: 'providers-remove', provider: 'acme' } })
  })

  it('routes profile and web config dumps', () => {
    expect(parse(['--profile', 'web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['--profile', 'web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
    expect(parse(['--profile', 'tui', '--dump-config', '--patch', 'x.yml']))
      .toEqual({ mode: 'dump-config', profile: 'tui', defaultOnly: false, patches: ['x.yml'] })
    expect(parse(['web', '--dump-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: false, patches: [] })
    expect(parse(['web', '--dump-default-config']))
      .toEqual({ mode: 'dump-config', profile: 'web', defaultOnly: true, patches: [] })
  })

  it('rejects missing profile, removed flags, and contradictory inputs', () => {
    expect(exitCode([])).toBe(1)
    expect(exitCode(['tui'])).toBe(1) // an app argument without --profile has no app to reach
    expect(exitCode(['--config', 'c.yml'])).toBe(1) // removed
    expect(exitCode(['-p', 'task'])).toBe(1) // removed
    expect(exitCode(['run', 'task'])).toBe(1) // app-owned task replaced the launcher subcommand
    expect(exitCode(['--profile', ''])).toBe(1)
    expect(exitCode(['--profile', 'x', '--patch='])).toBe(1)
    expect(exitCode(['--dump-config'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-default-config', '--patch', 'p.yml'])).toBe(1)
    expect(exitCode(['--profile', 'x', '--dump-config', 'task'])).toBe(1)
    expect(exitCode(['--bogus'])).toBe(1)
    expect(exitCode(['--profile', 'x', 'web'])).toBe(1)
    expect(exitCode(['web', '--dump-config', '--dump-default-config'])).toBe(1)
    expect(exitCode(['web', '--dump-default-config', '--patch', 'w.yml'])).toBe(1)
    expect(exitCode(['web', '--patch='])).toBe(1)
    // A dump never runs app command-line providers, so it cannot show what
    // those flags would decide; printing a tree that differs from the same
    // invocation's boot would mislead.
    expect(exitCode(['web', '--dump-config', '--port', '8080'])).toBe(1)
    expect(exitCode(['--profile', 'web', '--dump-config', '-h'])).toBe(1)
    expect(exitCode(['plugin', 'add', 'x'])).toBe(1) // --profile required
    expect(exitCode(['plugin', '--profile', 'tui'])).toBe(1) // nothing to forward
    expect(exitCode(['plugin', '--profile', ''])).toBe(1)
    expect(exitCode(['--profile', 'x', 'plugin', 'add', 'y'])).toBe(1)
    expect(exitCode(['models', 'set', 'p', 'm', '--purpose', 'nope'])).toBe(1)
    expect(exitCode(['providers', 'add', '--template', 'nope'])).toBe(1)
    expect(exitCode(['--profile', 'x', 'models', 'list'])).toBe(1)
    expect(exitCode(['--profile', 'x', 'providers', 'list'])).toBe(1)
  })

  it('keeps its own help for an invocation with no app to hand it to', () => {
    expect(exitCode(['--help'])).toBe(0)
    expect(exitCode(['-h'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})

describe('parseShresArgs remote family', () => {
  it('parses add with the default daemon port', () => {
    expect(parse(['remote', 'add', 'lab', 'ci@r.example']))
      .toEqual({ mode: 'remote', command: { kind: 'remote-add', alias: 'lab', target: 'ci@r.example', remotePort: 3080 } })
  })

  it('parses add with explicit daemon port', () => {
    expect(parse(['remote', 'add', 'lab', 'ci@r.example', '--port', '4022']))
      .toEqual({ mode: 'remote', command: { kind: 'remote-add', alias: 'lab', target: 'ci@r.example', remotePort: 4022 } })
  })

  it('parses list, remove, and connect flags', () => {
    expect(parse(['remote', 'list'])).toEqual({ mode: 'remote', command: { kind: 'remote-list' } })
    expect(parse(['remote', 'remove', 'lab'])).toEqual({ mode: 'remote', command: { kind: 'remote-remove', alias: 'lab' } })
    expect(parse(['remote', 'connect', 'lab', '--allow-version-skew']))
      .toEqual({ mode: 'remote', command: { kind: 'remote-connect', alias: 'lab', allowVersionSkew: true, forceFingerprint: false } })
    expect(parse(['remote', 'connect', 'lab', '--force-fingerprint']))
      .toEqual({ mode: 'remote', command: { kind: 'remote-connect', alias: 'lab', allowVersionSkew: false, forceFingerprint: true } })
  })

  it('refuses malformed remote input loudly', () => {
    expect(exitCode(['remote', 'add', '', 'x@y'])).toBe(1)
    expect(exitCode(['remote', 'connect', ''])).toBe(1)
    expect(exitCode(['remote', 'add', 'lab', 'u@h', '--port', 'oops'])).toBe(1)
  })
})
