/** Restoring, running, and exercising the prebuilt binary packages that the optional-package omission removes. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hostPlatformKey,
  loadPrebuiltBinaries,
  prebuiltBinaryPackage,
  restorePrebuiltBinaries,
  verifyConsumerInstall,
} from './verify-packed-install.ts'

/** The install flags the spec pins, so a repair install never runs a build script early. */
const INSTALL_FLAGS = ['--no-audit', '--no-fund', '--package-lock=false', '--omit=optional', '--ignore-scripts']

/** One command line a subject issued. */
interface Recorded {
  /** Every command line, in call order. */
  readonly calls: string[][]
  /** The invocation to inject. */
  readonly run: (args: readonly string[]) => string
}

/**
 * Record the command lines a case issues.
 * @param respond - what each invocation returns; defaults to an empty string.
 * @returns The recording and the invocation to inject.
 */
function recorder(respond: (args: readonly string[]) => string = () => ''): Recorded {
  const calls: string[][] = []
  return {
    calls,
    run: (args) => {
      calls.push([...args])
      return respond(args)
    },
  }
}

/**
 * Run one case against a fresh consumer directory, then remove it.
 * @param body - receives the consumer directory.
 */
async function withConsumer(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'shres-packed-install-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Write one installed package's manifest into a consumer tree.
 * @param root - consumer directory.
 * @param name - package name, scoped or unscoped.
 * @param manifest - fields the subject reads.
 */
async function installManifest(root: string, name: string, manifest: Record<string, unknown>): Promise<void> {
  const path = join(root, 'node_modules', ...name.split('/'), 'package.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** The optional platform packages a koffi manifest declares, at one version. */
const KOFFI_OPTIONAL = {
  '@koromix/koffi-linux-x64': '9.9.9',
  '@koromix/koffi-darwin-arm64': '9.9.9',
  '@koromix/koffi-win32-x64': '9.9.9',
}

describe('prebuilt binary package selection', () => {
  it('installs the platform package the installed dependency declares for this host', async () => {
    await withConsumer(async (root) => {
      // The version is deliberately not one koffi publishes: the subject must
      // read it from the installed manifest rather than carry its own copy.
      await installManifest(root, 'koffi', { name: 'koffi', version: '9.9.9', optionalDependencies: KOFFI_OPTIONAL })
      const { calls, run } = recorder()

      expect(restorePrebuiltBinaries({ consumerRoot: root, npm: run, platformKey: 'linux-x64' }))
        .toEqual(['@koromix/koffi-linux-x64@9.9.9'])
      // Pins the exact command line: the repair install carries the same flags as
      // the placement install, so no build script can run before the binary lands.
      expect(calls).toEqual([['install', ...INSTALL_FLAGS, '@koromix/koffi-linux-x64@9.9.9']])
    })
  })

  it('installs nothing when the tree carries no dependency with a prebuilt binary', async () => {
    await withConsumer(async (root) => {
      const { calls, run } = recorder()

      expect(restorePrebuiltBinaries({ consumerRoot: root, npm: run })).toEqual([])
      expect(calls).toEqual([])
    })
  })

  it('repairs only the dependencies the caller names', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: KOFFI_OPTIONAL })
      await installManifest(root, 'other', { optionalDependencies: { 'other-linux-x64': '1.0.0' } })
      const { calls, run } = recorder()

      expect(restorePrebuiltBinaries({ consumerRoot: root, npm: run, platformKey: 'linux-x64', dependencies: ['other'] }))
        .toEqual(['other-linux-x64@1.0.0'])
      expect(calls).toEqual([['install', ...INSTALL_FLAGS, 'other-linux-x64@1.0.0']])
    })
  })

  it('fails loud when the dependency declares no package for this host', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: { '@koromix/koffi-linux-x64': '1.0.0' } })
      const { calls, run } = recorder()

      expect(() => restorePrebuiltBinaries({ consumerRoot: root, npm: run, platformKey: 'darwin-arm64' }))
        .toThrow(/installed koffi declares no prebuilt binary package for darwin-arm64/u)
      expect(calls).toEqual([])
    })
  })

  it('fails loud when the dependency declares no optional dependencies at all', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { name: 'koffi', version: '9.9.9' })

      expect(() => restorePrebuiltBinaries({ consumerRoot: root, npm: () => {} }))
        .toThrow(/installed koffi declares no prebuilt binary package/u)
    })
  })

  it('fails loud when optionalDependencies is not an object', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: ['@koromix/koffi-linux-x64'] })

      expect(() => restorePrebuiltBinaries({ consumerRoot: root, npm: () => {} }))
        .toThrow(/declares optionalDependencies that is not an object/u)
    })
  })

  it('rejects a version that is not exact, so the binary cannot mismatch the tree', () => {
    const manifest = { optionalDependencies: { '@koromix/koffi-linux-x64': '^9.9.9' } }

    expect(() => prebuiltBinaryPackage('koffi', manifest, 'linux-x64'))
      .toThrow(/is not the exact version that binary was built for/u)
    expect(() => prebuiltBinaryPackage('koffi', { optionalDependencies: { '@koromix/koffi-linux-x64': 'latest' } }, 'linux-x64'))
      .toThrow(/is not the exact version/u)
    expect(() => prebuiltBinaryPackage('koffi', { optionalDependencies: { '@koromix/koffi-linux-x64': 99 } }, 'linux-x64'))
      .toThrow(/is not the exact version/u)
  })

  it('matches the arm64 package on an arm64 host, not its arm sibling', () => {
    const manifest = {
      optionalDependencies: {
        '@koromix/koffi-linux-arm': '2.0.0',
        '@koromix/koffi-linux-arm64': '2.0.0',
      },
    }

    expect(prebuiltBinaryPackage('koffi', manifest, 'linux-arm'))
      .toEqual({ name: '@koromix/koffi-linux-arm', version: '2.0.0' })
    expect(prebuiltBinaryPackage('koffi', manifest, 'linux-arm64'))
      .toEqual({ name: '@koromix/koffi-linux-arm64', version: '2.0.0' })
  })

  it('names the host key the way the platform packages are suffixed', () => {
    expect(hostPlatformKey('linux', 'x64')).toBe('linux-x64')
    expect(hostPlatformKey()).toBe(`${process.platform}-${process.arch}`)
  })
})

describe('installed tree inspection', () => {
  it('rejects a manifest that holds JSON other than an object', async () => {
    await withConsumer(async (root) => {
      const path = join(root, 'node_modules', 'koffi', 'package.json')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '[]\n')

      expect(() => restorePrebuiltBinaries({ consumerRoot: root, npm: () => {} }))
        .toThrow(/is not a JSON object/u)
    })
  })

  it('rethrows a read failure that is not absence', async () => {
    await withConsumer(async (root) => {
      // A directory where the manifest belongs is unreadable as a file: only an
      // absent manifest is a normal state for this subject.
      await mkdir(join(root, 'node_modules', 'koffi', 'package.json'), { recursive: true })

      expect(() => restorePrebuiltBinaries({ consumerRoot: root, npm: () => {} })).toThrow()
    })
  })

  it('fails loud when the dependency is installed only below another package', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'owner/node_modules/koffi', { optionalDependencies: KOFFI_OPTIONAL })

      expect(() => restorePrebuiltBinaries({ consumerRoot: root, npm: () => {} }))
        .toThrow(/koffi is installed only under node_modules\/owner\/node_modules\/koffi\/package.json/u)
    })
  })

  it('finds a nested dependency under a scoped owner too', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, '@owner/pkg/node_modules/koffi', { optionalDependencies: KOFFI_OPTIONAL })

      expect(() => restorePrebuiltBinaries({ consumerRoot: root, npm: () => {} }))
        .toThrow(/installed only under node_modules\/@owner\/pkg\/node_modules\/koffi\/package.json/u)
    })
  })
})

describe('prebuilt binary load check', () => {
  it('imports each carried dependency in a child process', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: KOFFI_OPTIONAL })
      const { calls, run } = recorder()

      expect(loadPrebuiltBinaries({ consumerRoot: root, node: run })).toEqual(['koffi'])
      expect(calls).toEqual([['--input-type=module', '-e', 'await import("koffi")']])
    })
  })

  it('loads nothing when the tree carries no dependency with a prebuilt binary', async () => {
    await withConsumer(async (root) => {
      const { calls, run } = recorder()

      expect(loadPrebuiltBinaries({ consumerRoot: root, node: run })).toEqual([])
      expect(calls).toEqual([])
    })
  })

  it('fails the case when a carried dependency cannot be imported', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: KOFFI_OPTIONAL })
      const failing = (): string => { throw new Error('Cannot find the native Koffi module') }

      expect(() => loadPrebuiltBinaries({ consumerRoot: root, node: failing }))
        .toThrow(/Cannot find the native Koffi module/u)
    })
  })
})

describe('packed-consumer verification', () => {
  /**
   * Run the verification over a tree carrying koffi, recording every command.
   * @param root - consumer directory.
   * @param platformKey - host key the case drives.
   * @returns The recorded command lines, in order.
   */
  async function runVerification(root: string, platformKey: string): Promise<{ events: string[]; error?: unknown }> {
    const events: string[] = []
    const npm = (args: readonly string[]): string => {
      events.push(['npm', ...args].join(' '))
      return ''
    }
    const node = (args: readonly string[]): string => {
      events.push(['node', ...args].join(' '))
      return args.includes('--version') ? '1.2.3' : ''
    }
    try {
      verifyConsumerInstall({
        consumerRoot: root,
        packageName: '@shres-code/shres-code',
        binPath: 'lib/bin.js',
        expectedVersion: '1.2.3',
        npm,
        node,
        platformKey,
      })
      return { events }
    } catch (error: unknown) {
      return { events, error }
    }
  }

  it('repairs between placement and rebuild, then exercises the binary', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: KOFFI_OPTIONAL })

      const { events, error } = await runVerification(root, 'linux-x64')

      expect(error).toBeUndefined()
      expect(events).toEqual([
        ['npm', 'install', ...INSTALL_FLAGS].join(' '),
        ['npm', 'install', ...INSTALL_FLAGS, '@koromix/koffi-linux-x64@9.9.9'].join(' '),
        'npm rebuild --dangerously-allow-all-scripts',
        'node --input-type=module -e await import("koffi")',
        `node ${join(root, 'node_modules', '@shres-code', 'shres-code', 'lib', 'bin.js')} --version`,
      ])
    })
  })

  it('aborts before npm rebuild when the prebuilt binary cannot be matched', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: { '@koromix/koffi-linux-x64': '1.0.0' } })

      const { events, error } = await runVerification(root, 'darwin-arm64')

      expect(error).toBeInstanceOf(Error)
      expect(events.some(event => event.startsWith('npm rebuild'))).toBe(false)
    })
  })

  it('aborts before the version probe when a carried dependency cannot load', async () => {
    await withConsumer(async (root) => {
      await installManifest(root, 'koffi', { optionalDependencies: KOFFI_OPTIONAL })
      const probed: string[][] = []
      const npm = (): string => ''
      const node = (args: readonly string[]): string => {
        probed.push([...args])
        if (args.includes('-e')) throw new Error('Cannot find the native Koffi module')
        return '1.2.3'
      }

      expect(() => verifyConsumerInstall({
        consumerRoot: root,
        packageName: '@shres-code/shres-code',
        binPath: 'lib/bin.js',
        expectedVersion: '1.2.3',
        npm,
        node,
        platformKey: 'linux-x64',
      })).toThrow(/Cannot find the native Koffi module/u)
      expect(probed.some(args => args.includes('--version'))).toBe(false)
    })
  })

  it('fails the case when the executable reports another version', async () => {
    await withConsumer(async (root) => {
      const npm = (): string => ''
      const node = (args: readonly string[]): string => (args.includes('--version') ? '0.0.1' : '')

      expect(() => verifyConsumerInstall({
        consumerRoot: root,
        packageName: '@shres-code/shres-code',
        binPath: 'lib/bin.js',
        expectedVersion: '1.2.3',
        npm,
        node,
      })).toThrow(/reported "0.0.1", expected 1.2.3/u)
    })
  })
})
