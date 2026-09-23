/** Copy the prepared runtime before electron-builder signs or creates installers. */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const TREE = join(APP_ROOT, '.desktop-build', 'targets', 'mac-arm64', 'shres')
const REQUIRED_FILES = [
  'desktop-runtime.json',
  'node_modules/@shres-code/shres-code/package.json',
  'node_modules/@shres-code/shres-code-desktop-host/lib/index.js',
  'node_modules/@shres-code/shres-code/config/agent-presets',
  'node_modules/@shres-code/shres-code-web-frontend/dist/index.html',
]

function assertNoLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`desktop packaging: runtime symlink at ${path}`)
    if (entry.isDirectory()) assertNoLinks(path)
  }
}

/**
 * Install the runtime into the unsigned app; electron-builder owns every later mutation.
 * @param context - electron-builder's afterPack context.
 * @returns nothing; rejects missing runtime files or links before signing can start.
 */
export default function finalizePackage(context) {
  const resources = join(context.appOutDir, 'Shres Code.app', 'Contents', 'Resources')
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(TREE, file))) throw new Error(`desktop packaging: runtime is missing ${file}`)
  }
  assertNoLinks(TREE)
  const main = readFileSync(join(resources, 'app', 'lib', 'main.js'), 'utf8')
  if (main.includes('@shres-code/shres-code-desktop-host')) {
    throw new Error('desktop packaging: shell entry imports the external host package')
  }
  rmSync(join(resources, 'shres'), { recursive: true, force: true })
  cpSync(TREE, join(resources, 'shres'), { recursive: true })
}
