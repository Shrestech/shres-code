/**
 * Launcher-hosted replay executor. After the loader settles, reads job.json,
 * calls replayTrialLog in this process with the live ctx.llm, writes JSONL
 * rows plus a summary, then exits. A counting proxy forwards to ctx.llm.
 * @module
 */
import { readFile, unlink, writeFile } from 'node:fs/promises'
import Schema from '../../vendor/schemastery/lib/index.mjs'
import { resolveConfig } from '../../packages/llm/model-router/lib/index.js'
import { replayTrialLog, TrialInputIncompleteError } from './replay-frontend.js'
import { judgeReplayRows } from './replay-judge.js'

export const name = 'bench-replay-frontend'
export const inject = ['llm', 'agentDefaultModel', 'sessionPersistence']

export const Config = Schema.object({
  job: Schema.string().required(),
  out: Schema.string().required(),
})

export const internals = {
  http: 0,
  write(chunk) { process.stdout.write(chunk) },
}

function countingRuntime(llm) {
  const counts = {
    prepareCall: 0,
    resolveModelInfo: 0,
    byPhase: {
      's-validation': { prepareCall: 0, resolveModelInfo: 0 },
      consult: { prepareCall: 0, resolveModelInfo: 0 },
    },
  }
  let phase = 'consult'
  const runtime = new Proxy(llm, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === 'prepareCall' && typeof value === 'function') {
        return function prepareCallCounted(...args) {
          counts.prepareCall++
          counts.byPhase[phase].prepareCall++
          return value.apply(target, args)
        }
      }
      if (property === 'resolveModelInfo' && typeof value === 'function') {
        return function resolveModelInfoCounted(...args) {
          counts.resolveModelInfo++
          counts.byPhase[phase].resolveModelInfo++
          return value.apply(target, args)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    runtime,
    counts,
    setPhase(next) { phase = next },
  }
}

function consultKindCounts(consults) {
  const kinds = { ask: 0, ineligible: 0, warm: 0 }
  for (const consult of consults) {
    if (consult.result.kind === 'ask') kinds.ask++
    else if (consult.result.kind === 'ineligible') kinds.ineligible++
    else if (consult.result.kind === 'warm') kinds.warm++
  }
  return kinds
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('bench-replay-frontend: the launcher must provide ctx.appExit before the tree mounts')
  }
  let settled = false
  const finish = (result, code) => {
    if (settled) return
    settled = true
    internals.write(JSON.stringify(result) + '\n')
    exit(code)
  }
  void (async () => {
    await ctx.get('loader')?.await()
    const llm = ctx.get('llm')
    const defaults = ctx.get('agentDefaultModel')
    const router = ctx.get('modelRouting')
    const persistence = ctx.get('sessionPersistence')
    if (llm === undefined || defaults === undefined) {
      throw new Error('bench-replay-frontend: llm and agentDefaultModel must be composed')
    }
    if (router === undefined) {
      throw new Error('bench-replay-frontend: expected exactly one R router, found 0')
    }
    if (persistence === undefined) {
      throw new Error('bench-replay-frontend: sessionPersistence must be composed')
    }
    const job = JSON.parse(await readFile(config.job, 'utf8'))
    const routeBase = structuredClone(defaults.currentSelection())
    const requestConfig = structuredClone(routeBase)
    const ttlInfo = await llm.resolveModelInfo(routeBase.provider, routeBase.model)
    const resolved = router.config()
    if (job.routerRowConfig !== undefined) {
      const expected = resolveConfig(job.routerRowConfig)
      if (JSON.stringify(resolved) !== JSON.stringify(expected)) {
        throw new Error('router-config-mismatch')
      }
    }
    const ttl = ttlInfo.promptCacheTtlMs === undefined
      ? { ttlMs: resolved.coldPoints.unknownTtlMs, ttlSource: 'fallback' }
      : { ttlMs: ttlInfo.promptCacheTtlMs, ttlSource: 'adapter' }
    const { runtime, counts, setPhase } = countingRuntime(llm)
    let sPrepared
    if (job.arm === 'S') {
      setPhase('s-validation')
      sPrepared = (await runtime.prepareCall(structuredClone(defaults.currentSelection()))).config
    }
    setPhase('consult')
    const result = await replayTrialLog({
      trial: job.trial,
      path: job.path,
      persistence,
      runtime,
      routerConfig: resolved,
      routeBase,
      trialOwnRoute: job.trialOwnRoute,
      requestConfig,
      ttl,
      method: job.method,
      arm: job.arm,
      sPrepared,
    })
    let rows = result.rows
    let asks = []
    if (job.judge === true) {
      const judged = await judgeReplayRows({
        rows: result.rows,
        consults: result.consults,
        engine: ctx.get('judgment'),
        config: resolved,
        sessionId: result.sessionId,
      })
      rows = judged.rows
      asks = judged.asks
    }
    const kinds = consultKindCounts(result.consults)
    const summary = {
      kind: 'summary',
      artifact: result.artifact,
      routeBase,
      requestConfig,
      routerConfig: resolved,
      ttl,
      counts,
      kinds,
      asks,
      recordedAsks: job.judge === true
        ? (await import('./replay-scripted-fitting-judge.mjs')).internals.asks.slice()
        : [],
      http: internals.http,
    }
    structuredClone(result.consults)
    const lines = [
      ...rows.map(row => JSON.stringify({ kind: 'row', row })),
      ...result.consults.map(consult => JSON.stringify({ kind: 'consult', consult })),
      ...asks.map(ask => JSON.stringify({ kind: 'ask', ask })),
      JSON.stringify(summary),
    ]
    await writeFile(config.out, lines.join('\n') + '\n')
    finish({ ok: true, artifact: result.artifact, out: config.out, http: internals.http }, 0)
  })().catch(async (error) => {
    const reason = error instanceof Error ? error.message : String(error)
    const classC = error instanceof TrialInputIncompleteError
    try {
      await unlink(config.out)
    } catch (unlinkError) {
      if (!(unlinkError && unlinkError.code === 'ENOENT')) throw unlinkError
    }
    finish({
      ok: false,
      classC,
      reason,
      name: error instanceof Error ? error.name : 'Error',
      http: internals.http,
    }, 1)
  })
}
