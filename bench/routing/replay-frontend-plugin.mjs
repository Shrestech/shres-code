/**
 * Launcher-hosted replay composition plugin. Overlay disables one-shot rows
 * and inserts this plugin. After the loader settles it prints one JSON line
 * of the composed ctx.llm + agentDefaultModel.currentSelection + resolved
 * model-router config, using a scripted judge. No session, no HTTP.
 * @module
 */
import Schema from '../../vendor/schemastery/lib/index.mjs'
import { KEEP_CURRENT_OPTION_ID } from '../../packages/llm/model-router/lib/index.js'

export const name = 'bench-replay-frontend'
export const inject = ['llm', 'agentDefaultModel']

export const Config = Schema.object({})

export const internals = {
  http: 0,
  write(chunk) { process.stdout.write(chunk) },
}

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('bench-replay-frontend: the launcher must provide ctx.appExit before the tree mounts')
  }
  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    internals.write(JSON.stringify(result) + '\n')
    exit(result.ok ? 0 : 1)
  }
  void (async () => {
    await ctx.get('loader')?.await()
    const llm = ctx.get('llm')
    const defaults = ctx.get('agentDefaultModel')
    const router = ctx.get('modelRouting')
    if (llm === undefined || defaults === undefined) {
      throw new Error('bench-replay-frontend: llm and agentDefaultModel must be composed')
    }
    if (router === undefined) {
      throw new Error('bench-replay-frontend: expected exactly one R router, found 0')
    }
    const routeBase = defaults.currentSelection()
    const requestConfig = { ...routeBase }
    delete requestConfig.adapterDefaults
    const ttlInfo = await llm.resolveModelInfo(routeBase.provider, routeBase.model)
    const resolved = router.config()
    finish({
      ok: true,
      keepCurrent: KEEP_CURRENT_OPTION_ID,
      routeBase,
      requestConfig,
      ttl: ttlInfo.promptCacheTtlMs === undefined
        ? { ttlMs: resolved.coldPoints.unknownTtlMs, ttlSource: 'fallback' }
        : { ttlMs: ttlInfo.promptCacheTtlMs, ttlSource: 'adapter' },
      routerConfig: {
        initialMode: resolved.initialMode,
        candidates: resolved.candidates,
        routeFrom: resolved.routeFrom,
        downgradeThreshold: resolved.downgradeThreshold,
        downgradeMargin: resolved.downgradeMargin,
      },
      http: internals.http,
    })
  })().catch((error) => {
    finish({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      http: internals.http,
    })
  })
}
