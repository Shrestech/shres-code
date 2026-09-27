/**
 * Page model of Settings › Model routing: one snapshot joining the Host's
 * judgment engine view (`judgmentEngines.snapshot`), the local Laya gateway
 * view (`laya.status`, when a `laya` engine is registered), the resolved
 * `judgment` and `model-router` settings sections, and, while the router is
 * composed, its gate (`modelRouting.gate`), its pool status
 * (`modelRouting.poolStatus`), and the model catalog (`llm.models`) the pool
 * editor picks from. The Host stays the single fact source: every write goes
 * through the settings seam or the Laya Remote and the page re-renders from
 * the next read, pushed or refetched.
 */

import type {
  IApiClient,
  JudgmentEnginesSnapshot,
  LayaGatewayView,
  LayaInstallResult,
  ModelProviderGroup,
  SettingsNamespaceView,
} from '@shres-code/shres-code-api-remotes/client'
import type { ModelRoutingGateView, ModelRoutingObjective, ModelRoutingPoolStatus } from '@shres-code/shres-code-model-router/client'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SnapshotStore } from '@shres-code/shres-code-client-runtime/client'

/** The settings namespace the judgment seam installs. */
export const JUDGMENT_NS = 'judgment'
/** The settings namespace the model router installs. */
export const MODEL_ROUTER_NS = 'model-router'
/** Registry id of the supervised local Laya engine. */
export const LAYA_ENGINE = 'laya'
/** Consumer id the model router declares and asks under. */
export const ROUTER_CONSUMER = 'model-router'

/** One Remote call's settlement, as the generated Client methods return it. */
export type RemoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The Remote methods the page calls. */
export interface ModelRoutingRemotes {
  /**
   * Read the judgment engine view.
   * @returns the snapshot, or the gateway failure.
   */
  snapshot: () => Promise<RemoteOutcome<JudgmentEnginesSnapshot>>
  /**
   * Read the local Laya gateway view.
   * @returns the view, or the gateway failure.
   */
  layaStatus: () => Promise<RemoteOutcome<LayaGatewayView>>
  /**
   * Install or reinstall the pinned Laya environment and checkpoint.
   * @returns the verified install, or the failure.
   */
  layaInstall: () => Promise<RemoteOutcome<LayaInstallResult>>
  /**
   * Restart the local Laya gateway.
   * @returns the view once the restart began, or the failure.
   */
  layaRestart: () => Promise<RemoteOutcome<LayaGatewayView>>
  /**
   * Read the router's gate configuration in force.
   * @returns the gate view, or the gateway failure.
   */
  gate: () => Promise<RemoteOutcome<ModelRoutingGateView>>
  /**
   * Read the router's pool and routeFrom with each model's facts and eligibility.
   * @returns the pool status, or the gateway failure.
   */
  poolStatus: () => Promise<RemoteOutcome<ModelRoutingPoolStatus>>
}

/** One pool model as the editor writes it. */
export interface PoolCandidateDraft {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly description: string
}

/** One `routeFrom` entry as the editor writes it; the objective is absent until the owner picks one. */
export interface RouteFromDraft {
  readonly provider: string
  readonly model: string
  readonly objective?: ModelRoutingObjective
  readonly allowEveryTurn?: boolean
}

/** Whether the Host composes the judgment dispatcher, as far as the page has read. */
export type ModelRoutingAvailability = 'unknown' | 'composed' | 'absent'

/** A Laya operation the page started. */
export type LayaAction = 'install' | 'restart'

/** Page snapshot. */
export interface ModelRoutingState {
  /** Whether the Host serves the engine view; the Settings entry exists only while it is `composed`. */
  availability: ModelRoutingAvailability
  /** Whole-page read state. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-page read failure; the last good facts stay rendered. */
  error: string | null
  /** The engine view, once read. */
  engines: JudgmentEnginesSnapshot | null
  /** The Laya gateway view while a `laya` engine is registered. */
  laya: LayaGatewayView | null
  /** The Laya read failure, or the last Laya action failure. */
  layaError: string | null
  /** The Laya operation in flight. */
  layaAction: LayaAction | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** The resolved `judgment` section. */
  judgment: SettingsNamespaceView | null
  /** The resolved `model-router` section, when the Host composes the router. */
  router: SettingsNamespaceView | null
  /** The router's gate configuration in force, while the Host serves it. */
  gate: ModelRoutingGateView | null
  /** The router's pool status, while the Host serves it. */
  pool: ModelRoutingPoolStatus | null
  /** The model catalog the pool editor picks from, by provider. */
  models: ModelProviderGroup[] | null
  /** A router or catalog read failure; the facts read before stay rendered. */
  routingError: string | null
}

/** A rejected write: the Host's message, and the field path an owner named. */
export interface WriteFailure {
  readonly message: string
  readonly path?: readonly (string | number)[]
}

/** The page controller the Settings entry injects. */
export interface ModelRoutingController {
  /** The page snapshot. */
  readonly store: SnapshotStore<ModelRoutingState>
  /**
   * Read only the engine view, which settles {@link ModelRoutingState.availability}.
   * @returns settlement once the snapshot is published.
   */
  probe(): Promise<void>
  /**
   * Read the engine view, the settings sections, and the Laya view.
   * @returns settlement once the snapshot is published.
   */
  load(): Promise<void>
  /**
   * Re-read what the page has read so far: everything once loaded, else the engine view.
   * @returns settlement once the snapshot is published.
   */
  refresh(): Promise<void>
  /**
   * Select the deployment-wide judgment engine (`judgment.engine`).
   * @param engine - the registry id to select.
   * @returns the failure, or undefined once the write committed.
   */
  selectEngine(engine: string): Promise<WriteFailure | undefined>
  /**
   * Turn every judgment consumer on or off (`judgment.enabled`).
   * @param enabled - the next switch value.
   * @returns the failure, or undefined once the write committed.
   */
  setClassifier(enabled: boolean): Promise<WriteFailure | undefined>
  /**
   * Set the routing mode new sessions start in (`model-router.initialMode`).
   * @param mode - `off` or `on`.
   * @returns the failure, or undefined once the write committed.
   */
  setDefaultMode(mode: 'off' | 'on'): Promise<WriteFailure | undefined>
  /**
   * Write the pool and the `routeFrom` allowlist in one settings write.
   * @param candidates - the pool, in order.
   * @param routeFrom - the enabled strong models, in order.
   * @returns the failure (with the field path the Host named), or undefined once the write committed.
   */
  savePool(candidates: readonly PoolCandidateDraft[], routeFrom: readonly RouteFromDraft[]): Promise<WriteFailure | undefined>
  /**
   * Install or restart the local Laya gateway.
   * @param action - the operation.
   * @returns settlement once the operation and the following read finished; a
   *   failure is published as {@link ModelRoutingState.layaError}.
   */
  runLaya(action: LayaAction): Promise<void>
}

/**
 * Whether a Remote failure means the Host composes no service for the call.
 * @param code - the gateway failure code.
 * @returns true for the gateway's `*-unavailable` codes.
 */
export function isAbsent(code: string): boolean {
  return code.endsWith('-unavailable')
}

/**
 * Human text for a rejected call.
 * @param error - the rejection value.
 * @returns its message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the page controller.
 * @param api - the settings wire face.
 * @param remotes - the Remote methods the page calls.
 * @returns the controller; nothing is read until {@link ModelRoutingController.probe} or `load`.
 */
export function createModelRoutingController(api: Pick<IApiClient, 'settings' | 'llm'>, remotes: ModelRoutingRemotes): ModelRoutingController {
  const store = createSnapshotStore<ModelRoutingState>({
    availability: 'unknown',
    status: 'idle',
    error: null,
    engines: null,
    laya: null,
    layaError: null,
    layaAction: null,
    writable: false,
    judgment: null,
    router: null,
    gate: null,
    pool: null,
    models: null,
    routingError: null,
  })
  let generation = 0

  /** Read the engine view; publish availability and the view, or the failure. */
  const readEngines = async (current: number): Promise<JudgmentEnginesSnapshot | undefined> => {
    let outcome: RemoteOutcome<JudgmentEnginesSnapshot>
    try {
      outcome = await remotes.snapshot()
    } catch (error) {
      if (current === generation) store.update((s) => { s.status = 'error'; s.error = messageOf(error) })
      return undefined
    }
    if (current !== generation) return undefined
    if (!outcome.ok) {
      const absent = isAbsent(outcome.error.code)
      store.update((s) => {
        s.availability = absent ? 'absent' : s.availability
        s.status = 'error'
        s.error = outcome.error.message
      })
      return undefined
    }
    const engines = outcome.value
    store.update((s) => { s.availability = 'composed'; s.engines = engines })
    return engines
  }

  /** Read the Laya view while a laya engine is registered; called by the current read only. */
  const readLaya = async (engines: JudgmentEnginesSnapshot, current: number): Promise<void> => {
    if (!engines.engines.some(engine => engine.id === LAYA_ENGINE)) {
      store.update((s) => { s.laya = null; s.layaError = null })
      return
    }
    let outcome: RemoteOutcome<LayaGatewayView>
    try {
      outcome = await remotes.layaStatus()
    } catch (error) {
      outcome = { ok: false, error: { code: 'internal', message: messageOf(error) } }
    }
    if (current !== generation) return
    store.update((s) => {
      s.laya = outcome.ok ? outcome.value : null
      s.layaError = outcome.ok ? null : outcome.error.message
    })
  }

  /**
   * Read the router's gate and pool status and the model catalog; called by the
   * current read only, while the `model-router` section is exposed. A router the
   * Host does not serve (`*-unavailable`) leaves them absent without an error.
   */
  const readRouting = async (current: number): Promise<void> => {
    const settle = <T>(call: () => Promise<RemoteOutcome<T>>): Promise<RemoteOutcome<T>> =>
      call().catch((error: unknown) => ({ ok: false as const, error: { code: 'internal', message: messageOf(error) } }))
    const catalog = api.llm.models({}).then(
      (response): RemoteOutcome<ModelProviderGroup[]> => response.result.ok
        ? { ok: true, value: response.result.value.groups }
        : { ok: false, error: { code: response.result.error.code, message: response.result.error.message } },
      (error: unknown): RemoteOutcome<ModelProviderGroup[]> => ({ ok: false, error: { code: 'internal', message: messageOf(error) } }),
    )
    const [gate, pool, models] = await Promise.all([settle(remotes.gate), settle(remotes.poolStatus), catalog])
    if (current !== generation) return
    const failures = [gate, pool, models].flatMap(outcome => outcome.ok || isAbsent(outcome.error.code) ? [] : [outcome.error.message])
    store.update((s) => {
      s.gate = gate.ok ? gate.value : null
      s.pool = pool.ok ? pool.value : null
      s.models = models.ok ? models.value : null
      s.routingError = failures[0] ?? null
    })
  }

  const probe = async (): Promise<void> => {
    await readEngines(++generation)
  }

  const load = async (): Promise<void> => {
    const current = ++generation
    store.update((s) => { s.status = 'loading'; s.error = null })
    const [engines, settings] = await Promise.all([
      readEngines(current),
      api.settings.describe({}).then(response => response, (error: unknown) => error instanceof Error ? error : new Error(String(error))),
    ])
    if (current !== generation || engines === undefined) return
    const fail = (message: string): void => {
      store.update((s) => { s.status = 'error'; s.error = message })
    }
    if (settings instanceof Error) {
      fail(settings.message)
      return
    }
    const result = settings.result
    if (!result.ok) {
      fail(result.error.message)
      return
    }
    const { namespaces, writable } = result.value
    const router = namespaces.find(view => view.ns === MODEL_ROUTER_NS) ?? null
    store.update((s) => {
      s.status = 'ready'
      s.writable = writable
      s.judgment = namespaces.find(view => view.ns === JUDGMENT_NS) ?? null
      s.router = router
      if (router === null) {
        s.gate = null
        s.pool = null
        s.models = null
        s.routingError = null
      }
    })
    await Promise.all([readLaya(engines, current), router === null ? undefined : readRouting(current)])
  }

  const refresh = (): Promise<void> => store.getSnapshot().status === 'idle' ? probe() : load()

  /** Set top-level fields of one section in one write, then re-read the page. */
  const write = async (ns: string, fields: Record<string, unknown>, revision: number | undefined): Promise<WriteFailure | undefined> => {
    let failure: WriteFailure | undefined
    try {
      const response = await api.settings.mutate({
        ns,
        ops: Object.entries(fields).map(([path, value]) => ({ op: 'set' as const, path: [path], value })),
        ...revision === undefined ? {} : { expectedRevision: revision },
      })
      if (!response.result.ok) {
        const error = response.result.error
        failure = error.code === 'settings-rejected' && error.details.path !== undefined
          ? { message: error.message, path: error.details.path }
          : { message: error.message }
      }
    } catch (error) {
      failure = { message: messageOf(error) }
    }
    await load()
    return failure
  }

  return {
    store,
    probe,
    load,
    refresh,
    selectEngine: engine => write(JUDGMENT_NS, { engine }, store.getSnapshot().judgment?.revision),
    setClassifier: enabled => write(JUDGMENT_NS, { enabled }, store.getSnapshot().judgment?.revision),
    setDefaultMode: mode => write(MODEL_ROUTER_NS, { initialMode: mode }, store.getSnapshot().router?.revision),
    savePool: (candidates, routeFrom) => write(MODEL_ROUTER_NS, { candidates, routeFrom }, store.getSnapshot().router?.revision),
    runLaya: async (action) => {
      store.update((s) => { s.layaAction = action; s.layaError = null })
      let failure: string | null = null
      try {
        const outcome = action === 'install' ? await remotes.layaInstall() : await remotes.layaRestart()
        failure = outcome.ok ? null : outcome.error.message
      } catch (error) {
        failure = messageOf(error)
      }
      store.update((s) => { s.layaAction = null })
      await load()
      if (failure !== null) store.update((s) => { s.layaError = failure })
    },
  }
}
