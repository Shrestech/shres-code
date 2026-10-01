/**
 * Profile bundle and row activation: shipped optional discovery, durable
 * selection, manager-protection refusals, and exact metadata restoration when
 * a live loader application fails.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listProfileBundles,
  setBundleEnabled,
  setPluginEnabled,
  type ProfileMutationOptions,
} from '../src/profile-activation.ts'
import type { PnpmRunner } from '../src/profile-pnpm.ts'

const atomicWriteHook = vi.hoisted(() => ({
  afterWrite: undefined as ((filename: string) => void | Promise<void>) | undefined,
}))

vi.mock('@shres-code/shres-code-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shres-code/shres-code-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>): Promise<void> => {
      await actual.writeFileAtomic(...args)
      await atomicWriteHook.afterWrite?.(args[0])
    },
  }
})

const tempDirs: string[] = []
const BROWSER_BUNDLE = '@shres-code/shres-code-browser-bundle'
const BASE_BUNDLE = '@shres-code/shres-code-base'

afterEach(async () => {
  atomicWriteHook.afterWrite = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function fixture(options: {
  bundles?: readonly string[]
  dependencies?: Record<string, string>
  patch?: string
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shres-profile-activation-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'activation-fixture',
    private: true,
    dependencies: options.dependencies ?? {},
    shres: { profile: { bundles: [...options.bundles ?? []] }, fixture: { keep: true } },
  }, null, 2) + '\n')
  await writeFile(join(dir, 'cordis.patch.yml'), options.patch ?? '# user layer\n[]\n')
  return dir
}

async function bundle(dir: string, name: string, patch: string, description = 'Fixture bundle'): Promise<void> {
  const packageDir = join(dir, 'node_modules', name)
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name,
    version: '1.2.3',
    description,
    type: 'module',
    shres: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  await writeFile(join(packageDir, 'cordis.patch.yml'), patch)
}

function options(dir: string, extra: Partial<ProfileMutationOptions> = {}): ProfileMutationOptions {
  const runner = vi.fn<PnpmRunner>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  return {
    runner,
    signal: new AbortController().signal,
    invokingCwd: dir,
    installAnchor: join(dir, 'package.json'),
    ...extra,
  }
}

const browserPatch = `- insert:
    - id: browser
      name: browser-plugin
`

describe.runIf(process.platform !== 'win32')('profile bundle activation', () => {
  it('lists an installed but deselected shipped bundle and enables it without importing code', async () => {
    const dir = await fixture({ dependencies: { persisted: '1.0.0' } })
    await bundle(dir, BROWSER_BUNDLE, browserPatch, 'BrowserSkill browser control with a separate Chrome profile')

    const before = await listProfileBundles(dir, [], {
      installAnchor: join(dir, 'package.json'),
      shippedBundles: [BROWSER_BUNDLE],
    })
    expect(before).toEqual([expect.objectContaining({
      name: BROWSER_BUNDLE,
      description: 'BrowserSkill browser control with a separate Chrome profile',
      version: '1.2.3',
      selected: false,
      active: false,
      shipped: true,
      rows: ['include:browser'],
    })])

    const applied: unknown[] = []
    const outcome = await setBundleEnabled(dir, BROWSER_BUNDLE, true, options(dir, {
      shippedBundles: [BROWSER_BUNDLE],
      apply: async (candidate) => { applied.push(candidate); return 'applied' },
    }))
    expect(outcome).toEqual({ kind: 'saved', application: 'applied' })
    expect(applied).toHaveLength(1)
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { persisted: '1.0.0' },
      shres: { profile: { bundles: [BROWSER_BUNDLE] }, fixture: { keep: true } },
    })
  })

  it('disables a selected bundle while retaining profile dependencies and unrelated metadata', async () => {
    const dir = await fixture({ bundles: [BROWSER_BUNDLE], dependencies: { persisted: '1.0.0' } })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const before = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    const outcome = await setBundleEnabled(dir, BROWSER_BUNDLE, false, options(dir, {
      apply: async () => 'applied',
    }))
    expect(outcome).toEqual({ kind: 'saved', application: 'applied' })
    const after = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(after.dependencies).toEqual(before.dependencies)
    expect(after.shres).toMatchObject({ fixture: { keep: true }, profile: { bundles: [] } })
  })

  it('refuses unknown and protected bundles before changing the manifest', async () => {
    const dir = await fixture({ bundles: [BASE_BUNDLE] })
    await bundle(dir, BASE_BUNDLE, '- insert:\n    - id: base\n      name: base-plugin\n')
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    expect(await setBundleEnabled(dir, 'missing-bundle', true, options(dir))).toEqual({
      kind: 'refused', code: 'unknown-bundle', detail: 'The bundle is not available in this profile.',
    })
    expect(await setBundleEnabled(dir, BASE_BUNDLE, false, options(dir))).toEqual({
      kind: 'refused', code: 'management-required', detail: 'This bundle keeps plugin management available.',
    })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it.each([
    '- id: admin\n  disabled: true\n',
    '- id: infrastructure\n  disabled: true\n',
    '- id: api-gateway\n  disabled: true\n',
  ])('refuses bundles that override a protected row or its parent group', async (patch) => {
    const dir = await fixture({ bundles: [BASE_BUNDLE] })
    await bundle(dir, BASE_BUNDLE, `- insert:
    - id: api-gateway
      name: '@shres-code/shres-code-host-apiproxy'
- insert:
    - id: infrastructure
      name: cordis:group
      group: true
      config:
        - id: admin
          name: '@shres-code/shres-code-host-plugin-admin'
`)
    const override = '@example/overrides'
    await bundle(dir, override, patch)
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const apply = vi.fn<NonNullable<ProfileMutationOptions['apply']>>()
    expect(await setBundleEnabled(dir, override, true, options(dir, {
      shippedBundles: [override], apply,
    }))).toMatchObject({ kind: 'refused', code: 'management-required' })
    expect(apply).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('lists an override-only bundle as read-only when it disables the API proxy', async () => {
    const dir = await fixture({ bundles: [BASE_BUNDLE] })
    await bundle(dir, BASE_BUNDLE, `- insert:
    - id: api-gateway
      name: '@shres-code/shres-code-host-apiproxy'
`)
    const override = '@example/api-proxy-override'
    await bundle(dir, override, '- id: api-gateway\n  disabled: true\n')

    const rows = await listProfileBundles(dir, [BASE_BUNDLE], {
      installAnchor: join(dir, 'package.json'),
      shippedBundles: [override],
    })
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: override,
        selected: false,
        active: false,
        shipped: true,
        rows: [],
        readOnlyReason: 'management-required',
      }),
    ]))
  })

  it('refuses a malformed candidate patch without touching the manifest', async () => {
    const dir = await fixture({ patch: '- id: [broken\n' })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const outcome = await setBundleEnabled(dir, BROWSER_BUNDLE, true, options(dir, { shippedBundles: [BROWSER_BUNDLE] }))
    expect(outcome.kind).toBe('refused')
    expect(outcome).toMatchObject({ code: 'invalid-composition' })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('restores exact manifest bytes when live application throws', async () => {
    const dir = await fixture({ dependencies: { persisted: '1.0.0' } })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const before = await readFile(join(dir, 'package.json'), 'utf8')
    const outcome = await setBundleEnabled(dir, BROWSER_BUNDLE, true, options(dir, {
      shippedBundles: [BROWSER_BUNDLE],
      apply: async () => { throw new Error('loader refused candidate') },
    }))
    expect(outcome).toEqual({ kind: 'refused', code: 'invalid-composition', detail: 'Error: loader refused candidate' })
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(before)
  })

  it('restores the manifest when cancellation arrives after the atomic write', async () => {
    const dir = await fixture({ dependencies: { persisted: '1.0.0' } })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const manifestPath = join(dir, 'package.json')
    const before = await readFile(manifestPath, 'utf8')
    const controller = new AbortController()
    let firstManifestWrite = true
    atomicWriteHook.afterWrite = (filename) => {
      if (filename === manifestPath && firstManifestWrite) {
        firstManifestWrite = false
        controller.abort(new Error('cancelled after manifest write'))
      }
    }
    const apply = vi.fn<NonNullable<ProfileMutationOptions['apply']>>()
    const outcome = await setBundleEnabled(dir, BROWSER_BUNDLE, true, options(dir, {
      signal: controller.signal, shippedBundles: [BROWSER_BUNDLE], apply,
    }))
    expect(outcome).toEqual({ kind: 'refused', code: 'invalid-composition', detail: 'Error: cancelled after manifest write' })
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
    expect(apply).not.toHaveBeenCalled()
  })

  it('restores the manifest for cancellation at a restart-only boundary', async () => {
    const dir = await fixture({ dependencies: { persisted: '1.0.0' } })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const manifestPath = join(dir, 'package.json')
    const before = await readFile(manifestPath, 'utf8')
    const controller = new AbortController()
    let firstManifestWrite = true
    atomicWriteHook.afterWrite = (filename) => {
      if (filename === manifestPath && firstManifestWrite) {
        firstManifestWrite = false
        controller.abort(new Error('cancelled at restart-only boundary'))
      }
    }
    const outcome = await setBundleEnabled(dir, BROWSER_BUNDLE, true, options(dir, {
      signal: controller.signal, shippedBundles: [BROWSER_BUNDLE],
    }))
    expect(outcome).toEqual({ kind: 'refused', code: 'invalid-composition', detail: 'Error: cancelled at restart-only boundary' })
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
  })
})

describe.runIf(process.platform !== 'win32')('profile plugin row activation', () => {
  it('preserves comments and !!js tags while writing an enablement override', async () => {
    const userPatch = `# keep this operator note
- id: browser
  name: browser-plugin
  disabled: false
  config:
    probe: !!js process.env.SHRES_BROWSER_PROBE
`
    const dir = await fixture({ bundles: [BROWSER_BUNDLE], patch: userPatch })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const outcome = await setPluginEnabled(dir, { id: 'browser', moduleName: 'browser-plugin', enabled: false }, options(dir))
    expect(outcome).toEqual({ kind: 'saved', application: 'restart-required' })
    const after = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(after).toContain('# keep this operator note')
    expect(after).toContain('!!js process.env.SHRES_BROWSER_PROBE')
    expect(after).toContain('disabled: true')
  })

  it('refuses management rows and restores the exact patch file after live failure', async () => {
    const userPatch = '# retain this comment\n- id: admin\n  name: \'@shres-code/shres-code-host-plugin-admin\'\n'
    const dir = await fixture({ bundles: [BROWSER_BUNDLE], patch: userPatch })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const before = await readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(await setPluginEnabled(dir, {
      id: 'admin', moduleName: '@shres-code/shres-code-host-plugin-admin', enabled: false,
    }, options(dir))).toEqual({ kind: 'refused', code: 'management-required' })
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(before)

    const failing = await setPluginEnabled(dir, { id: 'browser', moduleName: 'browser-plugin', enabled: false }, options(dir, {
      apply: async () => { throw new Error('client refused candidate') },
    }))
    expect(failing).toEqual({ kind: 'refused', code: 'invalid-composition', detail: 'Error: client refused candidate' })
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(before)
  })

  it('restores the exact patch bytes when cancellation arrives after the atomic write', async () => {
    const userPatch = '- id: browser\n  name: browser-plugin\n'
    const dir = await fixture({ bundles: [BROWSER_BUNDLE], patch: userPatch })
    await bundle(dir, BROWSER_BUNDLE, browserPatch)
    const patchPath = join(dir, 'cordis.patch.yml')
    const before = await readFile(patchPath, 'utf8')
    const controller = new AbortController()
    let firstPatchWrite = true
    atomicWriteHook.afterWrite = (filename) => {
      if (filename === patchPath && firstPatchWrite) {
        firstPatchWrite = false
        controller.abort(new Error('cancelled after patch write'))
      }
    }
    const apply = vi.fn<NonNullable<ProfileMutationOptions['apply']>>()
    const outcome = await setPluginEnabled(dir, { id: 'browser', moduleName: 'browser-plugin', enabled: false }, options(dir, {
      signal: controller.signal, apply,
    }))
    expect(outcome).toEqual({ kind: 'refused', code: 'invalid-composition', detail: 'Error: cancelled after patch write' })
    expect(await readFile(patchPath, 'utf8')).toBe(before)
    expect(apply).not.toHaveBeenCalled()
  })
})
