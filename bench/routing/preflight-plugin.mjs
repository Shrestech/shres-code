/**
 * The bench-owned composed-metadata preflight plugin. The preflight spawns the
 * real CLI (`shres --profile headless`) with an overlay that disables the
 * one-shot task runner and its startup row and inserts this plugin instead, so
 * the composition is exactly the launcher's and no product code changes. After
 * the loader settles it resolves each configured route through the real LLM
 * service, prints one complete JSON result line, and requests exit through the
 * launcher's bounded shutdown.
 *
 * It never creates a session, never submits a task, and never makes a model
 * request: `resolveModelInfo` reads the composed adapter registry only. The
 * result line is the preflight's whole output; a route that does not resolve
 * fails the line with the named reason.
 *
 * @module bench/routing/preflight-plugin
 */
import Schema from '../../vendor/schemastery/lib/index.mjs'

/** Stable Cordis plugin name. */
export const name = 'bench-preflight'

/** The LLM service supplies the adapter registry the routes resolve against. */
export const inject = ['llm']

export const Config = Schema.object({
  /** The arm's conversation plus candidate routes, exactly as the pricing preflight reads them. */
  routes: Schema.array(Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
  })),
})

/** The stream the result line is written to; the unit test substitutes a capture. */
export const internals = {
  /** @param {string} chunk - one complete output chunk. */
  write(chunk) {
    process.stdout.write(chunk)
  },
}

/**
 * @param {import('@shres-code/cordis').Context} ctx - the plugin context.
 * @param {{ routes: { provider: string, model: string }[] }} config - resolved plugin config.
 * @throws {Error} when the launcher provides no appExit host value.
 */
export function apply(ctx, config) {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, exactly as headless-runner reads it. The check is
  // synchronous so a miscomposed overlay fails at mount, not mid-flight.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('bench-preflight: the launcher must provide ctx.appExit before the tree mounts')
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
    const routes = []
    for (const route of config.routes) {
      try {
        await llm.resolveModelInfo(route.provider, route.model)
        routes.push({ provider: route.provider, model: route.model, resolved: true })
      } catch (error) {
        routes.push({
          provider: route.provider, model: route.model, resolved: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const reason = routes.every(route => route.resolved)
      ? undefined
      : routes.filter(route => !route.resolved).map(route => `${route.provider}/${route.model}: ${route.error}`).join('; ')
    finish({
      ok: reason === undefined,
      routes,
      ...reason === undefined ? {} : { reason },
    })
  })().catch((error) => {
    // Anything before the result line is a preflight defect: report it as a
    // failed preflight instead of hanging until the launcher timeout.
    finish({
      ok: false,
      routes: [],
      reason: error instanceof Error ? error.message : String(error),
    })
  })
}
