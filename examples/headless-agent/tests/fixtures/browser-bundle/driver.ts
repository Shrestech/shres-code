/** Keyless optional BrowserSkill bundle selection through the real Loader and manager. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, listProfileBundles, loadOverlayPatches, provideProfileRuntime, reconcileRootInclude, setBundleEnabled, type ProfileRuntimeControl } from '@shres-code/shres-code-app-boot'
import type { PatchOptions } from '@shres-code/cordis-plugin-include'
import type { Context } from '@shres-code/cordis'
import { PluginAdminGateway } from '@shres-code/shres-code-host-plugin-admin'
import type { PnpmRunner } from '@shres-code/shres-code-app-boot'

const config = process.argv[2]
if (config === undefined) throw new Error('Browser bundle snapshot requires a Loader config')
const home = process.env.SHRES_HOME
if (home === undefined) throw new Error('Browser bundle snapshot requires SHRES_HOME')

const BUNDLE = '@shres-code/shres-code-browser-bundle'
const profileDir = join(home, 'profiles', 'web')
const installAnchor = join(profileDir, 'package.json')
let bundlePatches: PatchOptions[] = []

function basePatches(includeBrowser: boolean): PatchOptions[] {
  return [
    { id: 'llm-deepseek', disabled: true },
    {
      id: 'agent-spine',
      config: {
        agents: [{ id: 'main', provider: 'browserskill-native-snapshot', model: 'fixture', cwd: process.cwd() }],
        workspaceContext: { maxBytes: 65536 },
        skills: { filesystem: { watch: false } },
        persona: 'Browser bundle selection fixture.',
      },
    },
    { insert: [
      { id: 'browser-bundle-model', name: './tests/fixtures/browserskill-native/model.ts' },
      { id: 'plugin-admin', name: '@shres-code/shres-code-host-plugin-admin' },
    ] },
    ...(includeBrowser ? bundlePatches : []),
  ]
}

function rootPatches(includeBrowser: boolean): PatchOptions[] {
  return [{
    id: 'base',
    config: {
      path: '../../../cordis.yml',
      patches: basePatches(includeBrowser),
    },
  }]
}

async function stageProfile(): Promise<void> {
  await mkdir(join(profileDir, 'node_modules', '@shres-code', 'shres-code-browser-bundle'), { recursive: true })
  await writeFile(installAnchor, JSON.stringify({
    name: 'browser-bundle-profile',
    private: true,
    dependencies: { [BUNDLE]: 'workspace:*' },
    shres: { profile: { bundles: [BUNDLE] }, fixture: { preserved: true } },
  }, null, 2) + '\n')
  const packageDir = join(profileDir, 'node_modules', '@shres-code', 'shres-code-browser-bundle')
  const sourcePackageDir = fileURLToPath(new URL('../../../../../packages/bundle/browser/', import.meta.url))
  const sourceManifest = await readFile(join(sourcePackageDir, 'package.json'), 'utf8')
  const parsedManifest = JSON.parse(sourceManifest) as { shres?: { bundle?: { patch?: unknown } } }
  const patch = parsedManifest.shres?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) throw new Error('Browser bundle source manifest has no shres.bundle.patch')
  await writeFile(join(packageDir, 'package.json'), sourceManifest)
  await writeFile(join(packageDir, patch), await readFile(join(sourcePackageDir, patch), 'utf8'))
  bundlePatches = loadOverlayPatches('browser-bundle-snapshot', join(packageDir, patch))
  await writeFile(join(profileDir, 'cordis.patch.yml'), '# fixture user layer\n[]\n')
}

await stageProfile()
let activeBundles = [BUNDLE]
const runtime = { context: undefined as Context | undefined }
const runner: PnpmRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' })
const control: ProfileRuntimeControl = {
  listBundles: () => listProfileBundles(profileDir, activeBundles, { installAnchor, shippedBundles: [BUNDLE] }),
  setBundleEnabled: (name, enabled, signal) => setBundleEnabled(profileDir, name, enabled, {
    runner,
    signal,
    invokingCwd: process.cwd(),
    installAnchor,
    shippedBundles: [BUNDLE],
    apply: async (candidate) => {
      const context = runtime.context
      if (context === undefined) throw new Error('profile runtime applied before Loader boot')
      await reconcileRootInclude(context, update => update(rootPatches(candidate.bundles.includes(BUNDLE))))
      activeBundles = [...candidate.bundles]
      return 'applied'
    },
  }),
  setPluginEnabled: async () => ({ kind: 'unsupported' }),
}

function snapshot(ctx: Context, manager: PluginAdminGateway, label: string): Promise<unknown> {
  return Promise.all([manager.listBundles(), ctx.skills.list()]).then(([bundles, skills]) => ({
    label,
    bundle: bundles.filter(bundle => bundle.name === BUNDLE).map(bundle => ({
      selected: bundle.selected,
      active: bundle.active,
      shipped: bundle.shipped,
    })),
    tools: ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('browser_')).sort(),
    skills: skills.filter(skill => skill.name === 'browserskill').map(skill => skill.name),
  }))
}

const ctx = await boot('browser-bundle-snapshot', config, rootPatches(true), (hostCtx) => {
  provideProfileRuntime(hostCtx, {
    profileDir,
    bootBundles: [BUNDLE],
    pluginMutations: 'enabled',
    installAnchor,
    shippedBundles: [BUNDLE],
    control,
  })
})
runtime.context = ctx

try {
  const managerCandidate: unknown = ctx.get('pluginAdmin')
  if (!(managerCandidate instanceof PluginAdminGateway)) throw new Error('browser bundle fixture did not mount PluginAdminGateway')
  const manager = managerCandidate
  const snapshots: unknown[] = [await snapshot(ctx, manager, 'selected')]
  const disable = manager.begin({ verb: 'bundle-disable', target: BUNDLE })
  snapshots.push({ operation: 'disable', outcome: await manager.setBundleEnabled({ token: disable.token, name: BUNDLE, enabled: false }) })
  snapshots.push(await snapshot(ctx, manager, 'deselected'))
  const enable = manager.begin({ verb: 'bundle-enable', target: BUNDLE })
  snapshots.push({ operation: 'enable', outcome: await manager.setBundleEnabled({ token: enable.token, name: BUNDLE, enabled: true }) })
  snapshots.push(await snapshot(ctx, manager, 'reselected'))
  process.stdout.write(JSON.stringify({ snapshots }) + String.fromCharCode(10))
} finally {
  await ctx.fiber.dispose()
}
