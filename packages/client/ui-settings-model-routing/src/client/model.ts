/**
 * Page model of Settings › Model routing: one snapshot joining the Host's
 * judgment engine view (`judgmentEngines.snapshot`), the local Laya gateway
 * view (`laya.status`, when a `laya` engine is registered), and the resolved
 * `judgment` and `model-router` settings sections. The Host stays the single fact
 * source: every write goes through the settings seam or the Laya Remote and
 * the page re-renders from the next read, pushed or refetched.
 */

import type {
  IApiClient,
  JudgmentEnginesSnapshot,
  LayaGatewayView,
  LayaInstallResult,
  SettingsNamespaceView,
} from '@shres-code/shres-code-api-remotes/client'
import { createSnapshotStore } from '@shres-code/shres-code-client-runtime/client'
import type { SnapshotStore } from '@shres-code/shres-code-client-runtime/client'

/** The settings namespace the judgment seam installs. */
export const JUDGMENT_NS = 'judgment'
/** The settings namespace the model router installs. */
export const MODEL_ROUTER_NS = 'model-router'
/** Registry id of the supervised local Laya engine. */
export const LAYA_ENGINE = 'laya'

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
export function createModelRoutingController(api: Pick<IApiClient, 'settings'>, remotes: ModelRoutingRemotes): ModelRoutingController {
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
    store.update((s) => {
      s.status = 'ready'
      s.writable = writable
      s.judgment = namespaces.find(view => view.ns === JUDGMENT_NS) ?? null
      s.router = namespaces.find(view => view.ns === MODEL_ROUTER_NS) ?? null
    })
    await readLaya(engines, current)
  }

  const refresh = (): Promise<void> => store.getSnapshot().status === 'idle' ? probe() : load()

  /** Write one field and re-read the page. */
  const write = async (ns: string, path: string, value: unknown, revision: number | undefined): Promise<WriteFailure | undefined> => {
    let failure: WriteFailure | undefined
    try {
      const response = await api.settings.mutate({
        ns,
        ops: [{ op: 'set', path: [path], value }],
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
    selectEngine: engine => write(JUDGMENT_NS, 'engine', engine, store.getSnapshot().judgment?.revision),
    setClassifier: enabled => write(JUDGMENT_NS, 'enabled', enabled, store.getSnapshot().judgment?.revision),
    setDefaultMode: mode => write(MODEL_ROUTER_NS, 'initialMode', mode, store.getSnapshot().router?.revision),
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
