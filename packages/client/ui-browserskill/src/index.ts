/**
 * BrowserSkill Settings surface, node half. The empty apply exists so the
 * plugin appears in the host cordis.yml / Loader; the browser half owns the
 * section through the package.json shres.client declaration and its
 * exports ./client entry.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
