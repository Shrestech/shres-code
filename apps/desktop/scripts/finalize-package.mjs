// Post-build finalization: copy the runtime tree into the built application
// (electron-builder's resource copy drops node_modules contents), then apply
// the stage-A ad-hoc signature so the bundle launches without a Developer ID.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const APP_ROOT = resolve(import.meta.dirname, '..')
const TREE = join(APP_ROOT, '.desktop-build', 'targets', 'mac-arm64', 'shres')
const APP_BUNDLE = join(APP_ROOT, '.desktop-build', 'targets', 'mac-arm64', 'artifacts', 'mac-arm64', 'Shres Code.app')
const RESOURCES = join(APP_BUNDLE, 'Contents', 'Resources')

if (!existsSync(APP_BUNDLE)) throw new Error('desktop finalize: built application not found at ' + APP_BUNDLE)
rmSync(join(RESOURCES, 'shres'), { recursive: true, force: true })
cpSync(TREE, join(RESOURCES, 'shres'), { recursive: true, dereference: true })
// The runtime tree self-links the host package into its own node_modules;
// codesign rejects bundle symlinks, so materialize it as a real copy.
const selfLink = join(RESOURCES, 'shres', 'node_modules', '@shres-code', 'shres-code-desktop-host')
rmSync(selfLink, { recursive: true, force: true })
for (const entry of readdirSync(TREE)) {
  if (entry === 'node_modules') continue
  cpSync(join(TREE, entry), join(selfLink, entry), { recursive: true, dereference: true })
}
const stray = spawnSync('find', [join(RESOURCES, 'shres'), '-type', 'l'], { encoding: 'utf8' })
if (stravyCheck(stray.stdout)) throw new Error('desktop finalize: symlinks remain in the runtime tree: ' + stray.stdout.trim())
function stravyCheck(out) { return out.trim() !== '' }
for (const probe of [
  'shres/node_modules/@shres-code/shres-code/package.json',
  'shres/node_modules/@shres-code/shres-code-desktop-host/lib/index.js',
  'shres/node_modules/@shres-code/shres-code/config/agent-presets',
  'shres/node_modules/@shres-code/shres-code-web-frontend/dist/index.html',
]) {
  if (!existsSync(join(RESOURCES, probe))) throw new Error('desktop finalize: missing ' + probe)
}
// The shell spawns the host by path; its bundled entry must not import the host
// package, which no longer ships beside the app payload.
const mainEntry = readFileSync(join(RESOURCES, 'app', 'lib', 'main.js'), 'utf8')
if (mainEntry.includes('@shres-code/shres-code-desktop-host')) {
  throw new Error('desktop finalize: the bundled shell entry still imports the host package')
}
const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', APP_BUNDLE], { stdio: 'inherit' })
if (signed.status !== 0) throw new Error('desktop finalize: ad-hoc codesign failed')
const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', APP_BUNDLE], { stdio: 'inherit' })
if (verified.status !== 0) throw new Error('desktop finalize: signature verification failed')
console.log('desktop finalize: runtime tree installed and ad-hoc signature applied')
