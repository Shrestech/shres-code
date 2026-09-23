/** Copy the prepared runtime before electron-builder signs or creates installers. */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { join, resolve } from 'node:path'

const { preProcessFile } = createRequire(import.meta.url)('typescript')

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
 * Reject shell imports that electron-builder cannot resolve after app/node_modules is excluded.
 * @param directory - emitted Electron shell library directory.
 * @returns nothing; throws for an external bare import that must be bundled.
 */
function assertBundledShellImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      assertBundledShellImports(path)
      continue
    }
    if (!/\.(?:cjs|mjs|js)$/u.test(entry.name)) continue
    const importedFiles = preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles
    for (const { fileName: specifier } of importedFiles) {
      if (specifier === 'electron' || isBuiltin(specifier) || specifier.startsWith('.')) continue
      throw new Error(`desktop packaging: shell entry imports unbundled package ${JSON.stringify(specifier)} (${path})`)
    }
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
  const shellDirectory = join(resources, 'app', 'lib')
  const main = join(shellDirectory, 'main.js')
  if (!existsSync(main)) throw new Error(`desktop packaging: shell entry is missing ${main}`)
  assertBundledShellImports(shellDirectory)
  rmSync(join(resources, 'shres'), { recursive: true, force: true })
  cpSync(TREE, join(resources, 'shres'), { recursive: true })
}
