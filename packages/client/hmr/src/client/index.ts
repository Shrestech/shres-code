/**
 * client-hmr, browser half: hot-reload driver for client plugin entries.
 *
 * Listens on the host's system SSE channel (`GET /plugins/events`); on a
 * `rebuilt` frame it reloads the entry's bundle and swaps the cordis
 * fiber in place. Every graph entry is a plugin bundle
 * — `immediately` rows differ only in stage-one prefetch (a boot
 * optimization), so all rostered plugin packages share these reload semantics;
 * normal packages (react family, cordis, shell, pure libs) are not entries
 * and shell changes still mean a page reload. Cascade is zero-touch:
 * downstream fibers key their activation epoch on provider fiber uids
 * (vendor/cordis/src/fiber.ts `_refresh`), so replacing a provider fiber
 * re-cascades natively — reloading a data-layer plugin (connection/runtime)
 * cascades into its UI dependents with no HMR-side bookkeeping.
 *
 * Reload order (lazy CJS table): invalidate (drop the stale factory and
 * materialized record) → prefetch (load and register the fresh
 * factory) → registry-first teardown → drain old fiber unload → remove
 * owned `<style data-plugin>` tags → `entry.refresh()` materializes the new
 * factory. Invalidate MUST precede prefetch: a live factory makes prefetch
 * a no-op, and re-executing a bundle over an undeleted registration is a
 * loud duplicate. The swap is safe because execution is pure registration
 * under the lazy model — every module side effect (CSS injection included)
 * lives in the factory closure and runs at materialization, inside
 * refresh(). That also keeps the CSS ordering guarantee: owned styles are
 * removed after the old fiber's disposers drained (SlotCore one-owner
 * unregister) and before materialization re-injects tags under the same
 * stable tag ids.
 *
 * Failure window: if prefetch rejects after invalidate, the module is left
 * unregistered while the OLD fiber keeps running untouched (teardown never
 * started) — degraded but recoverable, the next rebuilt frame retries from
 * scratch. Consistent with the no-rollback policy below. Known dev-only
 * race: a rebuilt frame overlapping a still-in-flight boot arrival shares
 * that arrival's task and may materialize the pre-rebuild bytes; the next
 * rebuilt frame self-heals.
 *
 * Why not the naive `entry.fiber.dispose()` → `entry.refresh()` path:
 * 1. `Entry.fiber` is never cleared on dispose (vendor/loader/src/config/
 *    entry.ts assigns it only in `_init`), so `refresh()` hits its
 *    `if (this.fiber) return` guard and no-ops.
 * 2. A bare `fiber.dispose()` lands in Loader's self-dispose branch
 *    (vendor/loader/src/index.ts `internal/plugin` case 4: the registry
 *    still holds the runtime at emit time), which flags the entry
 *    `disabled: true` — permanently.
 * vendor/hmr's reload skeleton documents the fix: delete the runtime record
 * FIRST (`registry.delete` → case 4 returns early, the entry stays enabled),
 * then rebuild. `entry.fiber` is additionally cleared so
 * `entry.refresh()` re-imports and re-plugins through the Loader's own
 * `_init` (entry-resolved config, automatic `fiber.entry` rebinding) instead
 * of hand-rolling `registry.plugin`. Client entries have exactly one fiber
 * per runtime, so `registry.delete` never collaterally disposes siblings.
 *
 * Self-reload: this plugin is itself a graph entry, so a rebuilt frame may
 * name it. The old fiber's disposer closes its EventSource, but the reload
 * continuation is allowed to drain that fiber and refresh the same Loader
 * entry while the owning Loader tree remains active. The new bundle's apply
 * opens a fresh channel. Frames arriving during the gap are lost — acceptable
 * for the dev channel, since the next graph or rebuild frame resynchronizes it.
 *
 * Failure policy: no rollback. An import failure leaves the entry
 * fiberless (the next rebuilt frame retries from scratch); an apply failure
 * leaves a FAILED fiber for the shell's status projection. Both log loudly.
 */
import { FiberState, type Context } from '@shres-code/cordis'
import type { Entry, Loader } from '@shres-code/cordis-plugin-loader'
import type { BootManifest, WebBootGraph } from '@shres-code/shres-code-client-modules/client'
import { parseBootManifest, type PluginsEventFrame } from '../events.ts'
import { EVENTS_ENDPOINT } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'
export { EVENTS_ENDPOINT } from '../events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the vendored Loader (entry governance) and the client module system (boot provide, service name `modules`). */
export const inject = ['loader', 'modules']

const SELF_ID = '@shres-code/shres-code-client-hmr'

/** Find the loader entry whose module specifier is `id` (entry tree ids are random; the package name lives in `options.name`). */
function findEntry(loader: Loader, id: string): Entry | undefined {
  for (const entry of loader.entries()) {
    if (entry.options.name === id) return entry
  }
  return undefined
}

/** Remove every `<style data-plugin>` tag owned by `id` (attribute compared verbatim — no CSS-selector escaping pitfalls). */
function removeOwnedStyles(id: string): void {
  for (const el of document.querySelectorAll('style[data-plugin]')) {
    if (el.getAttribute('data-plugin') === id) el.remove()
  }
}

function graphFromManifest(manifest: BootManifest): WebBootGraph {
  return {
    rev: manifest.rev,
    entries: manifest.modules.map((module, index) => {
      const plugin = manifest.plugins[index]
      return {
        ...module,
        ...(plugin?.inject.length ? { inject: plugin.inject } : {}),
        ...(plugin?.immediately ? { immediately: true } : {}),
      }
    }),
  }
}

function parseFrame(value: unknown): PluginsEventFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as Record<string, unknown>
  if (frame.type === 'graph') {
    try {
      return { type: 'graph', graph: graphFromManifest(parseBootManifest(frame.graph)) }
    } catch {
      // The SSE channel is an untrusted wire input; malformed graph frames are
      // dropped before they can alter module rows or Loader entries.
      return undefined
    }
  }
  if (frame.type === 'rebuilt' && typeof frame.id === 'string' && typeof frame.rev === 'string') {
    return { type: 'rebuilt', id: frame.id, rev: frame.rev }
  }
  return undefined
}

/**
 * Mount the HMR driver: subscribe to the system SSE channel and hot-swap
 * rebuilt entries.
 * @param ctx - plugin context with `loader` and `modules` available.
 */
export function apply(ctx: Context): void {
  // Both are declared injections (typed Context merges: `modules` from the
  // client module loader package, `loader` from the vendored Loader).
  const modLoader = ctx.modules
  const loader: Loader = ctx.loader
  const loaderOwner = ctx.fiber.parent.fiber
  let disposed = false
  let selfReloading = false
  // Keep every graph id observed during this page lifetime. If an earlier
  // transition stopped after removing a Loader entry, the next identical host
  // graph still has enough ownership information to recreate or withdraw it.
  const managedGraphIds = new Set(modLoader.graphRows().map(row => row.id))
  const pendingReloadIds = new Set<string>()

  const ownerIsLive = (): boolean => !disposed && ctx.fiber.state === FiberState.ACTIVE

  const loaderTreeIsLive = (): boolean => loaderOwner.state === FiberState.ACTIVE

  const transitionIsLive = (id: string): boolean =>
    ownerIsLive() || (id === SELF_ID && selfReloading && loaderTreeIsLive())

  const assertCreatedEntriesSettled = (ids: readonly string[]): void => {
    for (const id of ids) {
      const entry = loader.resolve(id)
      // Loader.await() settles a fiber that is PENDING on a missing service;
      // only an absent, FAILED, or DISPOSED fiber needs graph repair here.
      if (entry.fiber === undefined || entry.fiber.state === FiberState.FAILED || entry.fiber.state === FiberState.DISPOSED) {
        throw new Error(`client-hmr: graph entry "${entry.options.name}" failed to activate`)
      }
    }
  }

  async function applyGraph(graph: WebBootGraph): Promise<void> {
    if (!ownerIsLive()) return
    const manifest = parseBootManifest(graph)
    const update = modLoader.applyGraph(manifest.modules)
    // Preserve revision work across a failed arrival: the module graph has
    // already accepted the new rows, so a repeated identical frame reports no
    // second `changed` diff.
    for (const change of update.changed) pendingReloadIds.add(change.after.id)
    for (const row of manifest.modules) managedGraphIds.add(row.id)
    const desired = new Set(manifest.modules.map(row => row.id))
    const actual = new Map([...loader.entries()].map(entry => [entry.options.name, entry]))
    const additions = new Map(update.added.map(row => [row.id, row]))
    for (const row of manifest.modules) {
      const entry = actual.get(row.id)
      // A failed import can leave a fiberless or FAILED entry in the Loader
      // tree. Repeated identical graph frames must repair that entry rather
      // than treating its name as already present.
      if (
        entry === undefined
        || entry.fiber === undefined
        || entry.fiber.state === FiberState.FAILED
        || entry.fiber.state === FiberState.DISPOSED
        || entry.disabled
      ) {
        additions.set(row.id, row)
      }
    }
    // A failed old fiber can be recreated as part of a changed graph row.
    // Drop its cached factory before prefetch so the new revision is loaded;
    // unchanged retries keep their cached factory and can retry activation.
    for (const change of update.changed) {
      if (additions.has(change.after.id)) modLoader.invalidate(change.after.id)
    }
    const removals = new Set(update.removed.map(row => row.id))
    for (const id of managedGraphIds) {
      if (!desired.has(id)) removals.add(id)
    }
    const selfRemoval = removals.delete(SELF_ID)

    // Register new factories before creating entries. This preserves the
    // boot barrier for synchronous cross-bundle require edges.
    await Promise.all(manifest.plugins
      .filter(row => additions.has(row.id) && row.immediately)
      .map(row => modLoader.prefetch(row.id)))
    if (!ownerIsLive()) return

    // Dispose old fibers before dropping their factories and styles. Loader
    // owns effect teardown; withdraw only removes module-owned resources.
    for (const id of removals) {
      const entry = findEntry(loader, id)
      if (entry !== undefined) await loader.remove(entry.id)
      if (!ownerIsLive()) return
      modLoader.withdraw(id)
      managedGraphIds.delete(id)
      pendingReloadIds.delete(id)
    }
    await loader.await()
    if (!ownerIsLive()) return

    // Remove obsolete entries before creating additions: two versions of a
    // provider cannot coexist while Cordis checks service ownership.
    const created: string[] = []
    for (const row of additions.values()) {
      const existing = findEntry(loader, row.id)
      if (existing !== undefined) {
        if (
          existing.fiber !== undefined
          && existing.fiber.state !== FiberState.FAILED
          && existing.fiber.state !== FiberState.DISPOSED
          && !existing.disabled
        ) continue
        await loader.remove(existing.id)
        if (!ownerIsLive()) return
      }
      created.push(await loader.create({ name: row.id }))
    }
    await loader.await()
    if (!ownerIsLive()) return
    assertCreatedEntriesSettled(created)
    for (const row of additions.values()) pendingReloadIds.delete(row.id)

    // A graph rev can replace a bundle without a separate rebuilt frame.
    // Reuse the existing invalidate/prefetch/refresh path for those rows.
    for (const id of pendingReloadIds) {
      if (!desired.has(id)) {
        pendingReloadIds.delete(id)
        continue
      }
      const change = update.changed.find(item => item.after.id === id)
      if (change !== undefined && additions.has(change.after.id)) continue
      await reload(id)
      pendingReloadIds.delete(id)
    }

    // Removing this entry disposes the owner of the current queue. Schedule
    // its Loader teardown only after every unrelated graph row has settled;
    // awaiting our own removal would strand the queue in its disposer.
    if (selfRemoval) {
      const entry = findEntry(loader, SELF_ID)
      managedGraphIds.delete(SELF_ID)
      pendingReloadIds.delete(SELF_ID)
      if (entry !== undefined) {
        void loader.remove(entry.id).then(
          () => { modLoader.withdraw(SELF_ID) },
          (error: unknown) => { ctx.logger.error('client-hmr: self-removal failed'); ctx.logger.error(error) },
        )
      }
    }
  }

  async function reload(id: string): Promise<void> {
    if (!ownerIsLive()) return
    const entry = findEntry(loader, id)
    if (entry === undefined) {
      ctx.logger.warn(`client-hmr: rebuilt frame for unknown entry "${id}" (not in the loader tree)`)
      return
    }
    // Invalidate first (drop stale factory + record — a live factory makes
    // prefetch a no-op and re-registration a loud duplicate), then run the
    // async half while the old fiber still serves: script loading registers
    // the fresh factory with zero side effects (lazy CJS — module bodies run
    // at materialization, not execution).
    modLoader.invalidate(id)
    await modLoader.prefetch(id)
    if (!ownerIsLive()) return

    const oldFiber = entry.fiber
    const self = id === SELF_ID && oldFiber !== undefined
    if (self) selfReloading = true
    try {
      if (oldFiber !== undefined) {
        // Registry-first teardown (see module comment): the runtime record
        // must be gone before the fiber's disposer emits internal/plugin, or
        // the Loader flags the entry disabled.
        const runtime = oldFiber.runtime
        if (runtime !== null) entry.ctx.registry.delete(runtime.callback)
        // Drain the unload: effect disposers (slots, subscriptions) must
        // finish before the new bundle executes and the new apply re-registers.
        while (oldFiber.inertia !== undefined) {
          await oldFiber.inertia
          if (!transitionIsLive(id)) return
        }
        delete entry.fiber
      }
      // Old owned styles go before materialization re-injects them (the CSS
      // idempotency guard keys on stable tag ids).
      removeOwnedStyles(id)
      // Re-init through the entry: fiber cleared above, so refresh() re-imports
      // — materializing the prefetched factory (CSS injects here) — and
      // re-plugins under the entry context. Import failures are logged by
      // Entry._init and leave the entry fiberless (retryable).
      await entry.refresh()
      if (!transitionIsLive(id)) return
      // Surface apply failures loudly (no rollback, FAILED state stays).
      if (entry.fiber === undefined) throw new Error(`client-hmr: rebuilt entry "${id}" did not activate`)
      await entry.fiber.await()
    } finally {
      if (self) selfReloading = false
    }
  }

  // Serialize reloads: frames can arrive faster than a swap completes, and
  // interleaved dispose/execute chains would corrupt the single-slot handoff.
  let queue: Promise<void> = Promise.resolve()
  const handle = (frame: PluginsEventFrame): void => {
    switch (frame.type) {
      case 'rebuilt':
        pendingReloadIds.add(frame.id)
        queue = queue.then(async () => {
          await reload(frame.id)
          pendingReloadIds.delete(frame.id)
        }).catch((error: unknown) => {
          ctx.logger.error(`client-hmr: reload of "${frame.id}" failed`)
          ctx.logger.error(error)
        })
        break
      case 'graph':
        queue = queue.then(() => applyGraph(frame.graph)).catch((error: unknown) => {
          ctx.logger.error('client-hmr: graph transition failed')
          ctx.logger.error(error)
        })
        break
      default:
        // Merge-extensible frame union: unknown frame types from newer hosts
        // are ignored by design.
        break
    }
  }

  ctx.effect(() => {
    const source = new EventSource(EVENTS_ENDPOINT)
    source.addEventListener('message', (event: MessageEvent<string>) => {
      let raw: unknown
      try {
        raw = JSON.parse(event.data) as unknown
      } catch {
        // Wire boundary: a malformed dev-channel frame is dropped loudly.
        ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`)
        return
      }
      const frame = parseFrame(raw)
      if (frame === undefined) {
        ctx.logger.warn(`client-hmr: invalid event frame: ${event.data}`)
        return
      }
      handle(frame)
    })
    return () => {
      disposed = true
      source.close()
    }
  }, 'client-hmr: event source')
}
