/** Release configuration must not silently substitute ad-hoc signing for a public build. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const config = new URL('../electron-builder.config.mjs', import.meta.url).href
const credentials = {
  CSC_LINK: 'test-certificate',
  CSC_KEY_PASSWORD: 'test-password',
  APPLE_ID: 'test@example.invalid',
  APPLE_APP_SPECIFIC_PASSWORD: 'test-app-password',
  APPLE_TEAM_ID: 'TESTTEAM',
}

function readConfig(overrides: NodeJS.ProcessEnv, platform = 'darwin', arch = 'arm64'): ReturnType<typeof spawnSync> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !key.startsWith('SHRES_DESKTOP_') && !key.startsWith('CSC_') && !key.startsWith('APPLE_')
  )))
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })
    Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} })
    const { default: config } = await import(${JSON.stringify(config)})
    console.log(JSON.stringify(config))
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...env, ...overrides }, encoding: 'utf8' })
}

it('builds both local installers with ad-hoc signing and no publication', () => {
  const result = readConfig({})
  expect(result.status, String(result.stderr)).toBe(0)
  expect(JSON.parse(String(result.stdout))).toMatchObject({
    publish: null,
    forceCodeSigning: false,
    afterPack: './scripts/finalize-package.mjs',
    mac: { identity: '-', notarize: false, hardenedRuntime: false, target: [
      { target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] },
    ] },
  })
})

it('requires signing and notarization in release mode', () => {
  const result = readConfig({ ...credentials, SHRES_DESKTOP_RELEASE: '1' })
  expect(result.status, String(result.stderr)).toBe(0)
  const value = JSON.parse(String(result.stdout)) as { mac: Record<string, unknown> }
  expect(value).toMatchObject({ forceCodeSigning: true, mac: { notarize: true, hardenedRuntime: true } })
  expect(value.mac).not.toHaveProperty('identity')
})

it.each(Object.keys(credentials))('rejects a release missing %s', (name) => {
  const result = readConfig({ ...credentials, SHRES_DESKTOP_RELEASE: '1', [name]: '' })
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain(`missing ${name}`)
})

it('rejects an unrecognized release mode', () => {
  expect(readConfig({ SHRES_DESKTOP_RELEASE: 'true' }).status).not.toBe(0)
})

it.each([['linux', 'arm64'], ['darwin', 'x64']])('rejects unsupported build host %s/%s', (platform, arch) => {
  const result = readConfig({}, platform, arch)
  expect(result.status).not.toBe(0)
  expect(String(result.stderr)).toContain('native Apple Silicon')
})
