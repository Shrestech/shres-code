/** The installer hook copies the complete runtime before signing and rejects unsafe inputs. */

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
const require = createRequire(import.meta.url)
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { runtime: string; resources: string; run: () => ReturnType<typeof spawnSync> } {
  const root = mkdtempSync(join(tmpdir(), 'shres-desktop-afterpack-'))
  roots.push(root)
  const script = join(root, 'scripts', 'finalize-package.mjs')
  mkdirSync(dirname(script), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../scripts/finalize-package.mjs', import.meta.url)), script)
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(dirname(require.resolve('typescript/package.json')), join(root, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir')
  const runtime = join(root, '.desktop-build', 'targets', 'mac-arm64', 'shres')
  for (const file of [
    'desktop-runtime.json',
    'node_modules/@shres-code/shres-code/package.json',
    'node_modules/@shres-code/shres-code-desktop-host/lib/index.js',
    'node_modules/@shres-code/shres-code/config/agent-presets/default.yml',
    'node_modules/@shres-code/shres-code-web-frontend/dist/index.html',
  ]) {
    mkdirSync(dirname(join(runtime, file)), { recursive: true })
    writeFileSync(join(runtime, file), 'bundled payload')
  }
  const appOutDir = join(root, 'artifacts', 'mac-arm64')
  const resources = join(appOutDir, 'Shres Code.app', 'Contents', 'Resources')
  mkdirSync(join(resources, 'app', 'lib'), { recursive: true })
  writeFileSync(join(resources, 'app', 'lib', 'main.js'), 'export {}')
  return {
    runtime,
    resources,
    run: () => spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: finalize } = await import(${JSON.stringify(pathToFileURL(script).href)})
      finalize({ appOutDir: ${JSON.stringify(appOutDir)} })
    `], { encoding: 'utf8' }),
  }
}

it('copies runtime assets into the app and replaces stale runtime files', () => {
  const setup = fixture()
  mkdirSync(join(setup.resources, 'shres'), { recursive: true })
  writeFileSync(join(setup.resources, 'shres', 'stale'), 'old')
  const result = setup.run()
  expect(result.status, String(result.stderr)).toBe(0)
  expect(existsSync(join(setup.resources, 'shres', 'stale'))).toBe(false)
  expect(readFileSync(join(setup.resources, 'shres', 'node_modules/@shres-code/shres-code-web-frontend/dist/index.html'), 'utf8')).toBe('bundled payload')
})

it('rejects a runtime missing built frontend output', () => {
  const setup = fixture()
  rmSync(join(setup.runtime, 'node_modules/@shres-code/shres-code-web-frontend/dist/index.html'))
  const result = setup.run()
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('runtime is missing')
})

it('rejects an app missing the main shell entry', () => {
  const setup = fixture()
  rmSync(join(setup.resources, 'app', 'lib', 'main.js'))
  const result = setup.run()
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('shell entry is missing')
})

it('rejects runtime links without following them into another tree', () => {
  const setup = fixture()
  symlinkSync(join(setup.runtime, 'desktop-runtime.json'), join(setup.runtime, 'linked-file'), 'file')
  const result = setup.run()
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('runtime symlink')
})

it('rejects an unbundled shell import', () => {
  const setup = fixture()
  writeFileSync(join(setup.resources, 'app', 'lib', 'main.js'), 'import "@shres-code/shres-code-desktop-host"')
  const result = setup.run()
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('shell entry imports')
})

it('allows built-in Node and Electron shell imports', () => {
  const setup = fixture()
  writeFileSync(join(setup.resources, 'app', 'lib', 'main.js'), 'import "electron"; import "node:fs"; import "./local.js"; require("node:path")')
  const result = setup.run()
  expect(result.status, String(result.stderr)).toBe(0)
})

it('rejects the home-paths package left outside the shell bundle', () => {
  const setup = fixture()
  writeFileSync(join(setup.resources, 'app', 'lib', 'main.js'), 'import "@shres-code/shres-code-home-paths"')
  const result = setup.run()
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('unbundled package "@shres-code/shres-code-home-paths"')
})

it('rejects a generic external shell import', () => {
  const setup = fixture()
  writeFileSync(join(setup.resources, 'app', 'lib', 'main.js'), 'import "external-shell-package"')
  const result = setup.run()
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('unbundled package "external-shell-package"')
})

it('rejects an unbundled import from an emitted preload', () => {
  const setup = fixture()
  writeFileSync(join(setup.resources, 'app', 'lib', 'preload.cjs'), 'module.exports = require("missing-shell-package")')
  const result = setup.run()
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('unbundled package "missing-shell-package"')
})
