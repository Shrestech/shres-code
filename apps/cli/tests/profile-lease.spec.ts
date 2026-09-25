/**
 * Real profile-lease behavior for the manifest readers that can normalize:
 * `--dump-config` loads the profile under the same cooperative lease the
 * managed plugin transactions hold, so a held lease blocks normalization
 * instead of racing it. Runs against a temporary SHRES_HOME and the real
 * app-boot lease; no pnpm, network, or model is involved.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodePnpmRunner, resolveProfileDir, withRecoveredProfile } from '@shres-code/shres-code-app-boot'
import { runDumpConfig } from '../src/dump-config.ts'
import { prepareProfileLeased } from '../src/profile-boot.ts'

/** The installation-owned headless tuple that loading normalizes to the shipped template. */
const OWNED_TUPLE = ['@shres-code/shres-code-base', '@shres-code/shres-code-web-app', '@shres-code/shres-code-headless']
const SHIPPED_TEMPLATE = ['@shres-code/shres-code-base', '@shres-code/shres-code-headless']

let root: string
let savedHome: string | undefined
let profileDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shres-profile-lease-'))
  savedHome = process.env.SHRES_HOME
  process.env.SHRES_HOME = join(root, 'home')
  profileDir = resolveProfileDir('headless')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'shres-profile-headless', private: true, dependencies: {}, shres: { profile: { bundles: OWNED_TUPLE } },
  }, undefined, 2) + '\n')
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (savedHome === undefined) delete process.env.SHRES_HOME
  else process.env.SHRES_HOME = savedHome
  await rm(root, { recursive: true, force: true })
})

async function bundles(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as { shres: { profile: { bundles: string[] } } }
  return manifest.shres.profile.bundles
}

const live = (): AbortSignal => new AbortController().signal

describe('profile lease for manifest readers', () => {
  it('normalizes a shipped profile under the lease when it is free', async () => {
    const profile = await prepareProfileLeased('headless', true, live())
    expect(profile.dir).toBe(profileDir)
    expect(await bundles()).toEqual(SHIPPED_TEMPLATE)
    expect(existsSync(join(profileDir, 'cordis.yml'))).toBe(true)
    // The lease is released once the load returns.
    expect(existsSync(join(profileDir, 'package.json.lock'))).toBe(false)
  })

  it('refuses without normalizing while this process holds the lease', async () => {
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const holder = withRecoveredProfile(profileDir, { runner: nodePnpmRunner, signal: live(), invokingCwd: root }, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    try {
      await expect(prepareProfileLeased('headless', true, live())).rejects.toThrow(/transaction by pid \d+ pending on profile headless/)
      expect(await bundles()).toEqual(OWNED_TUPLE)
      expect(existsSync(join(profileDir, 'cordis.yml'))).toBe(false)
    } finally {
      release.resolve(undefined)
      await holder
    }
  })

  it('waits for another process\'s lock, then refuses without normalizing', async () => {
    // A lock another process holds: the lease never steals it, so the reader
    // times out and the manifest keeps its bytes.
    await writeFile(join(profileDir, 'package.json.lock'), String(process.pid + 1) + '\n')
    await expect(prepareProfileLeased('headless', true, live())).rejects.toThrow(/profile headless is locked by another shres process/)
    expect(await bundles()).toEqual(OWNED_TUPLE)
    expect(existsSync(join(profileDir, 'cordis.yml'))).toBe(false)
  }, 15_000)

  it('serializes --dump-config behind the lease and prints nothing while it is held', async () => {
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })
    await writeFile(join(profileDir, 'package.json.lock'), String(process.pid + 1) + '\n')
    await expect(runDumpConfig('headless', true, [])).rejects.toThrow(/locked by another shres process/)
    expect(written).toEqual([])
    expect(await bundles()).toEqual(OWNED_TUPLE)

    await rm(join(profileDir, 'package.json.lock'))
    await runDumpConfig('headless', true, [])
    expect(written.join('')).toContain('@shres-code/shres-code-headless')
    expect(await bundles()).toEqual(SHIPPED_TEMPLATE)
  }, 15_000)
})
