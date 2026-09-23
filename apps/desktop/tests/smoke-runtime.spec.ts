/** Focused checks for the packaged runtime smoke's isolated environment and output contract. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopBootBundleUrls, smokeEnvironment } from '../scripts/smoke-runtime.ts'

afterEach(() => { vi.unstubAllEnvs() })

it('rejects an empty boot graph and returns the required providers from a complete graph', () => {
  const html = (entries: unknown[]): string => `<script>window.__SHRES_BOOT__ = ${JSON.stringify({ rev: 'test', entries })}</script>`
  expect(() => desktopBootBundleUrls(html([]), ['layout'])).toThrow('missing required client plugin layout')
  expect(desktopBootBundleUrls(html([{ id: 'layout', url: '/plugins/layout/client.js' }]), ['layout']))
    .toEqual(['/plugins/layout/client.js'])
})

describe('desktop runtime smoke environment', () => {
  it('replaces user homes and removes inherited settings and secret variables', () => {
    vi.stubEnv('HOME', '/Users/example')
    vi.stubEnv('SHRES_HOME', '/Users/example/.shres')
    vi.stubEnv('SHRES_AGENTS_HOME', '/Users/example/.agents')
    vi.stubEnv('XDG_CONFIG_HOME', '/Users/example/.config')
    vi.stubEnv('ELECTRON_USER_DATA_DIR', '/Users/example/Library/Application Support/Electron')
    vi.stubEnv('DEEPSEEK_API_KEY', 'secret')
    vi.stubEnv('GITHUB_TOKEN', 'secret')
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'secret')
    vi.stubEnv('SAFE_SMOKE_VALUE', 'kept')

    const environment = smokeEnvironment('/tmp/shres-smoke-home')

    expect(environment).toMatchObject({
      HOME: '/tmp/shres-smoke-home',
      USERPROFILE: '/tmp/shres-smoke-home',
      SHRES_HOME: '/tmp/shres-smoke-home',
      SHRES_AGENTS_HOME: '/tmp/shres-smoke-home/agents',
      XDG_CONFIG_HOME: '/tmp/shres-smoke-home/.config',
      ELECTRON_RUN_AS_NODE: '1',
      SAFE_SMOKE_VALUE: 'kept',
    })
    expect(environment.DEEPSEEK_API_KEY).toBeUndefined()
    expect(environment.GITHUB_TOKEN).toBeUndefined()
    expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(environment.ELECTRON_USER_DATA_DIR).toBeUndefined()
  })
})
