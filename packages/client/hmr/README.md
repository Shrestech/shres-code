# @shres-code/shres-code-client-hmr

Hot reload for script-loaded client plugins. The web bundle mounts the row unconditionally; without a rebuild watcher (`pnpm run dev:web`) rewriting client bundles, the poll observes no changes and the chain stays idle.

The browser half subscribes to the system SSE channel (`GET /plugins/events`) and processes graph and rebuild frames through one serialized queue. A graph frame validates through `parseBootManifest`, prefetches newly immediate rows, creates new Loader entries, disposes removed entries, withdraws their factories/styles, and reloads changed rows through the existing rebuilt sequence. A missing, FAILED, or DISPOSED Loader fiber is retried from the actual entry tree; a legitimately PENDING fiber remains under Loader dependency semantics. The rebuilt sequence is `invalidate`, `prefetch` (load and register the new bundle while the old fiber still serves), `registry.delete` (before the fiber: a bare fiber dispose trips the vendored Loader's self-dispose branch, which would mark the entry disabled), drain the old fiber, delete `entry.fiber`, remove owned `<style data-plugin>` tags, `entry.refresh()` re-imports and remounts, `fiber.await()` rethrows startup failures loud. Graph changes reload every other changed row before the HMR row so self-disposal cannot discard unfinished work; a self-reload drains the old HMR fiber while its owning Loader tree remains active, and self-removal is scheduled after unrelated graph rows settle. Dependents reload through cordis itself: a fiber's activation epoch strings its service providers' uids, so replacing a provider's fiber cascades every dependent with zero client-side graph analysis. The node half detects rebuilds with one interval that stat-polls each graph bundle from a synchronous baseline, immediately re-hashes after adding a row, retains missing rows as dirty, and broadcasts graph membership after loader settlement as well as real rev changes; any tsdown watch process producing the bundle therefore triggers HMR with no builder→host channel.

## Model Experience

None, as the reload driver is browser-side machinery; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Reload is coarse by design** — a fresh fiber and fresh components; React state inside the reloaded plugin is lost while the data layer (connection/runtime fibers, Session objects) is untouched. react-refresh-grade state preservation conflicts with "re-executing the bundle re-runs the factory" and is deliberately out.
- **No failure rollback** — a reload that fails leaves the entry FAILED and visible in the loader status projection; the previous bundle is not restored automatically.
- **Graph transitions are dev-channel operations** — a disconnected browser applies membership and revision changes when it reconnects; the initial graph remains the authoritative boot snapshot for a fresh page.
