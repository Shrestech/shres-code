/**
 * The frame's full-page navigation takes a destination id owned by the
 * destination's provider. Settings sections open through `ctx.settingsPages`,
 * which checks the id against the settings.section ledger, so the only
 * caller of `ctx.layout.navigate` in the client packages is that provider.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLIENT = fileURLToPath(new URL('../../', import.meta.url))
const ALLOWED = ['ui-settings-general/src/client/index.ts']

/** Every TypeScript source file under one package's src. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * Client source files that call the frame navigation through ctx.layout.
 * @returns paths relative to packages/client.
 */
export function layoutNavigateCallers(): string[] {
  return readdirSync(CLIENT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'ui-layout')
    .flatMap((entry) => {
      try {
        return sources(join(CLIENT, entry.name, 'src'))
      } catch {
        // A package directory without src (lib-only residue) has nothing to scan.
        return []
      }
    })
    .filter(file => /\blayout\s*\.\s*navigate\s*\(/.test(readFileSync(file, 'utf8')))
    .map(file => relative(CLIENT, file).replaceAll('\\', '/'))
    .sort()
}

describe('full-page navigation callers', () => {
  it('only the Settings pages provider calls ctx.layout.navigate', () => {
    expect(layoutNavigateCallers()).toEqual(ALLOWED)
  })
})
