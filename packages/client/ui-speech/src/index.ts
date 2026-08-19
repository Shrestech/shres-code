/**
 * Speech surface plugin, node half. Pure UI plugin: empty apply exists so
 * the plugin appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"].
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
