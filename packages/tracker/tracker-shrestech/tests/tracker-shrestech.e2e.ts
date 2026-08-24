import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@shres-code/cordis'
import { CredentialProvider } from '@shres-code/shres-code-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@shres-code/shres-code-credentials'
import ShrestechTrackerService from '@shres-code/shres-code-tracker-shrestech'
import type { LogRunSpec, TrackerRunId } from '@shres-code/shres-code-tracker'

const baseUrl = process.env.TRACKER_BASE_URL
const token = process.env.TRACKER_TOKEN

/** In-memory credentials seeded from the `TRACKER_TOKEN` environment value. */
class EnvCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly value: string) {
    super(ctx)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(ref === 'TRACKER_TOKEN' ? { value: this.value, source: 'env' } : undefined)
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: ref === 'TRACKER_TOKEN', source: 'env', writable: false })
  }

  set(): Promise<void> {
    return Promise.reject(new Error('env credentials are read-only'))
  }

  unset(): Promise<void> {
    return Promise.resolve()
  }
}

const spec: LogRunSpec = {
  experiment: 'tracker-e2e',
  hypothesis: 'live round-trip proof',
  decisionRule: 'val_bpb < 1.0',
  dataVersion: 'v1',
  gitSha: '0a378bd89b',
  metrics: [],
  artifacts: [],
}

describe.skipIf(!baseUrl || !token)('shrestech-tracker real HTTP round-trip', () => {
  it('posts a run over real HTTP and marks it landed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tracker-e2e-'))
    try {
      const ctx = new Context()
      await ctx.plugin(EnvCredentials, token!)
      await ctx.plugin(ShrestechTrackerService, {
        baseUrl: baseUrl!,
        lane: 'e2e',
        credentialRef: 'TRACKER_TOKEN',
        spoolPath: join(dir, 'spool.jsonl'),
        indexPath: join(dir, 'landed.jsonl'),
      })
      const result = await ctx.tracker.postRun('run-e2e-1' as TrackerRunId, spec)
      expect(result.kind).toBe('landed')
      // The landed run is answerable from the derived index with no network.
      const runs = await ctx.tracker.queryRuns({ experiment: 'tracker-e2e' })
      expect(runs.map(r => r.runId)).toContain('run-e2e-1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
