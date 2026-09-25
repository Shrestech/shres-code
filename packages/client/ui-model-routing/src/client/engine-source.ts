/**
 * The judgment engine facts the Routing view and the Auto chip read: one
 * source per plugin, fed by the `judgmentEngines` Remote's snapshot and
 * refreshed on each `judgment/engines-updated` notification, so a status
 * change or an engine switch reaches every open view and chip.
 */
import type {
  JudgmentEngineView, JudgmentEnginesSnapshot,
} from '@shres-code/shres-code-api-remotes/client'

/**
 * The engine facts as last read: `loading` before the first answer,
 * `no-dispatcher` when the host composes no judgment dispatcher (its Remote is
 * unavailable), `failed` when the read failed otherwise, and `ready` with the
 * snapshot.
 */
export type RoutingEngineState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'no-dispatcher' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly snapshot: JudgmentEnginesSnapshot }

/** One Remote read's result, as the generated method returns it. */
export type EngineSnapshotResult =
  | { readonly ok: true; readonly value: JudgmentEnginesSnapshot }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** An observable engine-facts source with its refresh and teardown. */
export interface RoutingEngineSource {
  /**
   * The current state; the same object until the next settled read.
   * @returns the state.
   */
  getSnapshot(): RoutingEngineState
  /**
   * Observe state replacements.
   * @param listener - invoked after each replacement.
   * @returns the disposer removing the listener.
   */
  subscribe(listener: () => void): () => void
  /** Start one read; a later read supersedes an earlier one still in flight. */
  refresh(): void
  /** Stop publishing: reads that settle afterwards are dropped. */
  dispose(): void
}

const LOADING: RoutingEngineState = { kind: 'loading' }

/**
 * Create the engine-facts source over one snapshot read.
 * @param read - the `judgmentEngines.snapshot` read.
 * @returns the source, in the loading state until its first refresh settles.
 */
export function createRoutingEngineSource(read: () => Promise<EngineSnapshotResult>): RoutingEngineSource {
  let state = LOADING
  let generation = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = (next: RoutingEngineState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: () => {
      generation += 1
      const mine = generation
      read().then((result) => {
        if (disposed || mine !== generation) return
        if (result.ok) publish({ kind: 'ready', snapshot: result.value })
        // The gateway answers an absent dispatcher with a *-unavailable code.
        else if (result.error.code.endsWith('-unavailable')) publish({ kind: 'no-dispatcher' })
        else publish({ kind: 'failed', message: `${result.error.message} (${result.error.code})` })
      }, (reason: unknown) => {
        if (disposed || mine !== generation) return
        publish({ kind: 'failed', message: reason instanceof Error ? reason.message : String(reason) })
      })
    },
    dispose: () => {
      disposed = true
      listeners.clear()
    },
  }
}

/** The judgment consumer id the model router asks under. */
export const MODEL_ROUTER_CONSUMER = 'model-router'

/**
 * The judge the model router's asks go to, resolved as the dispatcher
 * resolves it: `none` when no dispatcher is composed, judgment is switched
 * off, or the selected id names no registered engine; otherwise the engine.
 */
export type RoutingJudge =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'none'; readonly reason: 'no-dispatcher' | 'disabled' | 'unregistered' }
  | { readonly kind: 'engine'; readonly engine: JudgmentEngineView }

/**
 * Resolve the router's judge from the engine facts. A consumer override
 * applies only while that consumer is declared, which is the dispatcher's own
 * rule; otherwise the deployment-wide engine answers.
 * @param state - the engine facts.
 * @returns the judge.
 */
export function routingJudge(state: RoutingEngineState): RoutingJudge {
  switch (state.kind) {
    case 'loading': return { kind: 'loading' }
    case 'failed': return { kind: 'failed', message: state.message }
    case 'no-dispatcher': return { kind: 'none', reason: 'no-dispatcher' }
    case 'ready': {
      const { selection, consumers, engines } = state.snapshot
      if (!selection.enabled) return { kind: 'none', reason: 'disabled' }
      const declared = consumers.some(consumer => String(consumer) === MODEL_ROUTER_CONSUMER)
      const id = (declared ? selection.overrides[MODEL_ROUTER_CONSUMER] : undefined) ?? selection.engine
      const engine = engines.find(entry => String(entry.id) === id)
      return engine === undefined ? { kind: 'none', reason: 'unregistered' } : { kind: 'engine', engine }
    }
  }
}

/**
 * Whether Settings › Model routing exists to open: that page registers only
 * while the Host serves the judgment engine registry, which a read of it
 * confirms.
 * @param state - the engine facts.
 * @returns true once the registry has been read.
 */
export function routingSettingsPage(state: RoutingEngineState): boolean {
  return state.kind === 'ready'
}

/**
 * The egress class of the engine a decision names, when the registry knows
 * it. Decisions record the name the provider reported, so the name is matched
 * against registry ids and then labels.
 * @param state - the engine facts.
 * @returns a lookup, or undefined while the registry is not known.
 */
export function engineEgress(state: RoutingEngineState): ((name: string) => JudgmentEngineView['egress'] | undefined) | undefined {
  if (state.kind !== 'ready') return undefined
  const engines = state.snapshot.engines
  return name => (engines.find(entry => String(entry.id) === name) ?? engines.find(entry => entry.label === name))?.egress
}
