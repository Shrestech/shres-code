/** Optional BrowserSkill bundle selection through the real headless Loader and Plugins manager. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@shres-code/shres-code-loader-smoke'

const fixture = fileURLToPath(new URL('./fixtures/browser-bundle/', import.meta.url))
const configPath = join(fixture, 'cordis.yml')
const binScript = join(fixture, 'driver.ts')
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe.runIf(process.platform !== 'win32')('BrowserSkill optional bundle headless snapshot', () => {
  it('withdraws and restores tools and guide through the real manager and Loader', async () => {
    let runtimeRoot = ''
    const result = await runLoaderSmoke({
      label: 'BrowserSkill optional bundle headless snapshot',
      tempDirPrefix: 'browser-bundle-snapshot-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      env: { SHRES_SNAPSHOT: 'refresh' },
      prepare: async (cwd) => { runtimeRoot = join(cwd, '.shres', 'browserskill') },
      inspect: async () => {
        for (const path of ['artifacts', 'profile', 'runtime.lock']) {
          await expect(access(join(runtimeRoot, path))).rejects.toMatchObject({ code: 'ENOENT' })
        }
      },
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout.trim())).toMatchInlineSnapshot(`
      {
        "snapshots": [
          {
            "bundle": [
              {
                "active": true,
                "selected": true,
                "shipped": true,
              },
            ],
            "label": "selected",
            "skills": [
              "browserskill",
            ],
            "tools": [
              "browser_act",
              "browser_navigate",
              "browser_observe",
              "browser_session",
            ],
          },
          {
            "operation": "disable",
            "outcome": {
              "application": "applied",
              "kind": "saved",
            },
          },
          {
            "bundle": [
              {
                "active": false,
                "selected": false,
                "shipped": true,
              },
            ],
            "label": "deselected",
            "skills": [],
            "tools": [],
          },
          {
            "operation": "enable",
            "outcome": {
              "application": "applied",
              "kind": "saved",
            },
          },
          {
            "bundle": [
              {
                "active": true,
                "selected": true,
                "shipped": true,
              },
            ],
            "label": "reselected",
            "skills": [
              "browserskill",
            ],
            "tools": [
              "browser_act",
              "browser_navigate",
              "browser_observe",
              "browser_session",
            ],
          },
        ],
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
