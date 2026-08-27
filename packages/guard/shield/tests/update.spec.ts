/**
 * npm check/install helpers: packument parse, version walk, spawn, and
 * `pnpm add` refusal of non-semver specs. Network and pnpm are injected.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  defaultSpawn, installPayload, isNpmVersion, NPM_PAYLOAD_PACKUMENT, pnpmEnv,
  queryNpmLatest, readPayloadVersion, restoreDefaultSpawn, shieldSpawn, spawnBinary,
  type ShieldSpawner,
} from '@shres-code/shres-code-shield'
import { PAYLOAD_SPECIFIER } from '@shres-code/shres-code-shield'

afterEach(() => {
  restoreDefaultSpawn()
})

function scratchDir(): { dir: string; cleanup(): void } {
  const dir = resolve(tmpdir(), `shres-shield-update-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return { dir, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

describe('isNpmVersion', () => {
  it('accepts concrete semver and pre-release, rejects tags and ranges', () => {
    expect(isNpmVersion('0.2.0')).toBe(true)
    expect(isNpmVersion('0.2.0-rc.1')).toBe(true)
    expect(isNpmVersion('1.0.0+build')).toBe(true)
    expect(isNpmVersion('latest')).toBe(false)
    expect(isNpmVersion('^0.2.0')).toBe(false)
    expect(isNpmVersion('')).toBe(false)
  })
})

describe('readPayloadVersion', () => {
  it('walks from dist to the paid package.json and ignores other manifests', () => {
    const scratch = scratchDir()
    const dist = join(scratch.dir, 'packages', 'plugin', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'package.json'), '{"type":"module"}\n')
    writeFileSync(
      join(scratch.dir, 'packages', 'plugin', 'package.json'),
      `{"name":"${PAYLOAD_SPECIFIER}","version":"0.2.0"}\n`,
    )
    writeFileSync(join(dist, 'index.js'), 'export {}\n')
    try {
      expect(readPayloadVersion(join(dist, 'index.js'))).toBe('0.2.0')
      expect(readPayloadVersion(pathToFileURL(join(dist, 'index.js')).href)).toBe('0.2.0')
    } finally {
      scratch.cleanup()
    }
  })

  it('returns null for a relative specifier, a foreign package, empty version, and invalid JSON', () => {
    const scratch = scratchDir()
    try {
      writeFileSync(join(scratch.dir, 'package.json'), '{"name":"other","version":"1.0.0"}\n')
      expect(readPayloadVersion(join(scratch.dir, 'index.js'))).toBeNull()
      expect(readPayloadVersion('./relative.js')).toBeNull()
      expect(readPayloadVersion('file://')).toBeNull()
      writeFileSync(
        join(scratch.dir, 'package.json'),
        `{"name":"${PAYLOAD_SPECIFIER}","version":""}\n`,
      )
      expect(readPayloadVersion(join(scratch.dir, 'index.js'))).toBeNull()
      writeFileSync(join(scratch.dir, 'package.json'), '{')
      expect(readPayloadVersion(join(scratch.dir, 'index.js'))).toBeNull()
    } finally {
      scratch.cleanup()
    }
  })
})

describe('queryNpmLatest', () => {
  it('reads a concrete version from the packument', async () => {
    const result = await queryNpmLatest(async (url) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      expect(href).toBe(NPM_PAYLOAD_PACKUMENT)
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 })
    })
    expect(result).toEqual({ latest: '0.2.0' })
  })

  it('blocks on HTTP errors, thrown fetch, non-JSON, non-object, and bad version', async () => {
    await expect(queryNpmLatest(async () => new Response('nope', { status: 500 })))
      .resolves.toEqual({ latest: null, blocked: 'registry', detail: 'HTTP 500' })
    await expect(queryNpmLatest(async () => {
      throw new Error('offline')
    })).resolves.toEqual({ latest: null, blocked: 'registry', detail: 'offline' })
    await expect(queryNpmLatest(async () => {
      throw 'offline'
    })).resolves.toEqual({ latest: null, blocked: 'registry', detail: 'registry request failed' })
    await expect(queryNpmLatest(async () => new Response('not-json', { status: 200 })))
      .resolves.toMatchObject({ latest: null, blocked: 'registry' })
    await expect(queryNpmLatest(async () => new Response('null', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))).resolves.toEqual({ latest: null, blocked: 'registry', detail: 'registry response is not an object' })
    await expect(queryNpmLatest(async () => new Response(JSON.stringify({ version: 'latest' }), { status: 200 })))
      .resolves.toEqual({
        latest: null,
        blocked: 'registry',
        detail: 'registry version is missing or not a semver string',
      })
    await expect(queryNpmLatest(async () => new Response(JSON.stringify({}), { status: 200 })))
      .resolves.toEqual({
        latest: null,
        blocked: 'registry',
        detail: 'registry version is missing or not a semver string',
      })
    const aborted = new AbortController()
    aborted.abort()
    await expect(queryNpmLatest(fetch, aborted.signal))
      .resolves.toMatchObject({ latest: null, blocked: 'registry' })
  })
})

describe('pnpmEnv', () => {
  it('copies ordinary keys and drops credential-shaped names', () => {
    const saved = process.env.SHRES_FAKE_TOKEN
    process.env.SHRES_FAKE_TOKEN = 'secret'
    process.env.SHRES_FAKE_PATHISH = 'keep'
    try {
      const env = pnpmEnv()
      expect(env.SHRES_FAKE_TOKEN).toBeUndefined()
      expect(env.SHRES_FAKE_PATHISH).toBe('keep')
    } finally {
      if (saved === undefined) delete process.env.SHRES_FAKE_TOKEN
      else process.env.SHRES_FAKE_TOKEN = saved
      delete process.env.SHRES_FAKE_PATHISH
    }
  })
})

describe('spawnBinary', () => {
  it('reports exit 0 and non-zero stderr from a real Node process', async () => {
    const scratch = scratchDir()
    try {
      const ok = await spawnBinary(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: scratch.dir,
        env: process.env,
      })
      expect(ok.status).toBe(0)
      const noisy = await spawnBinary(
        process.execPath,
        ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(0)'],
        { cwd: scratch.dir, env: process.env },
      )
      expect(noisy.status).toBe(0)
      const fail = await spawnBinary(
        process.execPath,
        ['-e', 'console.error("boom"); process.exit(3)'],
        { cwd: scratch.dir, env: process.env },
      )
      expect(fail.status).toBe(3)
      expect(fail.stderr).toContain('boom')
    } finally {
      scratch.cleanup()
    }
  })

  it('reports ENOENT for a missing binary', async () => {
    const scratch = scratchDir()
    try {
      const result = await spawnBinary(join(scratch.dir, 'no-such-pnpm'), [], {
        cwd: scratch.dir,
        env: process.env,
      })
      expect(result.status).toBeNull()
      expect(result.errorCode).toBe('ENOENT')
    } finally {
      scratch.cleanup()
    }
  })
})

describe('installPayload', () => {
  it('refuses a non-semver spec without spawning', async () => {
    const spawn: ShieldSpawner = async () => {
      throw new Error('spawned')
    }
    await expect(installPayload('/profile', 'latest', spawn))
      .resolves.toEqual({ ok: false, detail: 'refusing to install non-semver "latest"' })
  })

  it('adds the pinned specifier on exit 0', async () => {
    const seen: string[][] = []
    const spawn: ShieldSpawner = async (args, options) => {
      seen.push([...args])
      expect(options.cwd).toBe('/profile')
      expect(options.env.SHRES_FAKE_TOKEN).toBeUndefined()
      return { status: 0, stderr: '' }
    }
    await expect(installPayload('/profile', '0.2.0', spawn))
      .resolves.toEqual({ ok: true })
    expect(seen).toEqual([['add', `${PAYLOAD_SPECIFIER}@0.2.0`]])
    const withSignal = new AbortController()
    await expect(installPayload('/profile', '0.2.0', async (_args, options) => {
      expect(options.signal).toBe(withSignal.signal)
      return { status: 0, stderr: '' }
    }, withSignal.signal)).resolves.toEqual({ ok: true })
  })

  it('maps ENOENT, empty stderr failure, and pnpm stderr onto ok: false', async () => {
    await expect(installPayload('/profile', '0.2.0', async () => ({
      status: null,
      errorCode: 'ENOENT',
      stderr: '',
    }))).resolves.toEqual({ ok: false, detail: 'pnpm not found on PATH', errorCode: 'ENOENT' })
    await expect(installPayload('/profile', '0.2.0', async () => ({
      status: 1,
      stderr: '',
    }))).resolves.toEqual({ ok: false, detail: 'pnpm exited 1' })
    await expect(installPayload('/profile', '0.2.0', async () => ({
      status: null,
      stderr: '',
    }))).resolves.toEqual({ ok: false, detail: 'pnpm exited null' })
    await expect(installPayload('/profile', '0.2.0', async () => ({
      status: 1,
      errorCode: 'abort',
      stderr: ' EACCES \n',
    }))).resolves.toEqual({ ok: false, detail: 'EACCES', errorCode: 'abort' })
  })

  it('uses defaultSpawn when the caller omits a spawner', async () => {
    shieldSpawn.current = async () => ({ status: 0, stderr: '' })
    await expect(installPayload('/profile', '0.2.0')).resolves.toEqual({ ok: true })
  })

  it('production spawn invokes pnpm', async () => {
    restoreDefaultSpawn()
    const scratch = scratchDir()
    try {
      const result = await defaultSpawn(['--version'], { cwd: scratch.dir, env: pnpmEnv() })
      expect(result.status === 0 || result.errorCode === 'ENOENT').toBe(true)
    } finally {
      scratch.cleanup()
    }
  })
})
