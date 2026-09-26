/**
 * Bench-owned replay composition plugin. Mounts after the loader settles,
 * exposes one R router config and ctx.llm to the frontend, and never makes
 * an HTTP request.
 * @module
 */
export const name = 'bench-replay-frontend'
export const inject = ['llm', 'agentDefaultModel']

/** Test-visible request counter. */
export const internals = { http: 0 }

/**
 * @param {import('@shres-code/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.provide('benchReplay', {
    llm: () => ctx.llm,
    routeBase: () => ctx.agentDefaultModel.currentSelection(),
    http: () => internals.http,
  })
}
