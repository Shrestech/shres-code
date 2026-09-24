import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESTART,
  defaultLocations,
  resolveConfig,
} from '../src/config.ts'
import { LayaJudgmentEngine } from '../src/index.ts'
import type { LayaJudgmentConfig } from '../src/types.ts'
import { MANIFEST_SHA, REPO, REVISION } from './helpers.ts'

const LOCATIONS = { runtimeDir: '/srv/laya', gatewayProject: '/repo/python/laya-gateway' }
const BASE: LayaJudgmentConfig = {
  model: { repo: REPO, revision: REVISION, manifestSha256: MANIFEST_SHA },
  checkpointContext: 1024,
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveConfig', () => {
  it('resolves defaults and derived paths', () => {
    const config = resolveConfig(BASE, LOCATIONS)
    expect(config).toMatchObject({
      modelId: `${REPO}@${REVISION}`,
      checkpointContext: 1024,
      dtype: 'float16',
      runtimeDir: '/srv/laya',
      hfHome: '/srv/laya/hf',
      gatewayProject: '/repo/python/laya-gateway',
      uvPath: 'uv',
      python: '3.11',
      batchSize: 16,
      startupTimeoutMs: 120_000,
      requestTimeoutMs: 2_000,
      shutdownGraceMs: 5_000,
      installTimeoutMs: 1_800_000,
      maxRequestBytes: 262_144,
      maxResponseBytes: 4_194_304,
      restart: DEFAULT_RESTART,
      venvDir: '/srv/laya/venv',
      pythonPath: '/srv/laya/venv/bin/python',
      markerPath: '/srv/laya/install.json',
      modelDir: `/srv/laya/hf/checkpoints/owner__laya-test@${REVISION}`,
      manifestPath: `/repo/python/laya-gateway/manifests/${REVISION}.json`,
      lockPath: '/repo/python/laya-gateway/uv.lock',
    })
    expect(Object.isFrozen(config.model)).toBe(true)
  })

  it('accepts explicit overrides', () => {
    const config = resolveConfig({
      ...BASE,
      checkpointContext: 512,
      dtype: 'float32',
      hfHome: '/cache/hf',
      uvPath: '/opt/uv',
      python: '3.12',
      batchSize: 4,
      restart: { maxRestarts: 1 },
    }, LOCATIONS)
    expect(config).toMatchObject({ checkpointContext: 512, dtype: 'float32', hfHome: '/cache/hf', uvPath: '/opt/uv', python: '3.12', batchSize: 4 })
    expect(config.restart).toEqual({ ...DEFAULT_RESTART, maxRestarts: 1 })
  })

  it.each([
    [{ ...BASE, timeout: 1 }, /LayaJudgmentConfig: unknown key "timeout"/],
    [{ ...BASE, model: { ...BASE.model, sha: 'x' } }, /LayaJudgmentConfig.model: unknown key "sha"/],
    [{ ...BASE, restart: { attempts: 1 } }, /LayaJudgmentConfig.restart: unknown key "attempts"/],
    [{ ...BASE, model: undefined }, /model must be an object/],
    [{ ...BASE, model: { ...BASE.model, repo: 'noslash' } }, /model.repo must be a Hugging Face owner\/name/],
    [{ ...BASE, model: { ...BASE.model, revision: '20aed815fc6a' } }, /model.revision must be a 40-character lowercase commit sha/],
    [{ ...BASE, model: { ...BASE.model, manifestSha256: 'ABC' } }, /model.manifestSha256 must be 64 lowercase/],
    [{ ...BASE, checkpointContext: 2048 }, /checkpointContext must be 512 or 1024/],
    [{ ...BASE, dtype: 'bfloat16' }, /dtype must be "float16" or "float32"/],
    [{ ...BASE, runtimeDir: 'relative' }, /runtimeDir must be an absolute path/],
    [{ ...BASE, hfHome: 'relative' }, /hfHome must be an absolute path/],
    [{ ...BASE, gatewayProject: 'relative' }, /gatewayProject must be an absolute path/],
    [{ ...BASE, uvPath: '' }, /uvPath must be a non-empty string/],
    [{ ...BASE, python: '3' }, /python must be a major.minor version/],
    [{ ...BASE, batchSize: 0 }, /batchSize must be a positive integer no greater than 64/],
    [{ ...BASE, startupTimeoutMs: 600_001 }, /startupTimeoutMs must be a positive integer no greater than 600000/],
    [{ ...BASE, requestTimeoutMs: 1.5 }, /requestTimeoutMs must be a positive integer/],
    [{ ...BASE, maxResponseBytes: 128 * 1024 * 1024 }, /maxResponseBytes must be a positive integer/],
    [{ ...BASE, restart: 'often' }, /restart must be an object/],
    [{ ...BASE, restart: { backoffMs: 100, maxBackoffMs: 50 } }, /maxBackoffMs must be at least restart.backoffMs/],
  ])('rejects %j by name', (config, message) => {
    expect(() => resolveConfig(config as LayaJudgmentConfig, LOCATIONS)).toThrow(message)
  })

  it('defaults the runtime directory under SHRES_HOME and the gateway project to the repository copy', () => {
    vi.stubEnv('SHRES_HOME', '/home/tester/.shres-test')
    const locations = defaultLocations()
    expect(locations.runtimeDir).toBe('/home/tester/.shres-test/runtimes/laya-gateway')
    expect(existsSync(join(locations.gatewayProject, 'pyproject.toml'))).toBe(true)
    expect(resolveConfig(BASE).runtimeDir).toBe('/home/tester/.shres-test/runtimes/laya-gateway')
  })
})

describe('LayaJudgmentEngine.Config', () => {
  it('fills defaults and rejects an unsupported checkpoint context', () => {
    expect(LayaJudgmentEngine.Config(BASE)).toMatchObject({ dtype: 'float16', batchSize: 16, requestTimeoutMs: 2_000 })
    expect(() => LayaJudgmentEngine.Config({ ...BASE, checkpointContext: 2048 as 1024 })).toThrow()
  })
})
