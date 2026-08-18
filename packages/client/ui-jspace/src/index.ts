/**
 * J-Space surface plugin, node half. Pure UI plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader; the browser
 * half ships via exports["./client"], discovered through the package.json
 * shres.client declaration. Card state, settings remount, and `/j-space`
 * are owned by the jspace host packages, composed independently.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
