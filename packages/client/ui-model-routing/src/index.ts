/**
 * Model-routing chip plugin, node half. Pure UI plugin: the empty apply exists
 * so the plugin appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"], discovered through the package.json shres.client
 * declaration. Routing behavior itself (the /route command, the two log-only
 * routing events, the sticky fold, and the modelRouting projection) is owned by
 * `@shres-code/shres-code-model-router`, composed independently on the host
 * roster.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
