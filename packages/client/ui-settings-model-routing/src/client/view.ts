/**
 * Pure view helpers of the Model routing page: copy selection over the Host's
 * engine and settings facts. Nothing here reads or writes the Host.
 */

import type {
  JudgmentEngineState,
  JudgmentEnginesSnapshot,
  JudgmentEngineView,
  LayaGatewayState,
  LayaGatewayView,
  SettingsNamespaceView,
} from '@shres-code/shres-code-api-remotes/client'
import type { ModelRoutingKey } from './locales.ts'

/** Section copy, as the slot renderer's `t` seat supplies it. */
export type Translate = (key: ModelRoutingKey, params?: Record<string, unknown>) => string

/** Visual class of one lifecycle state. */
export type StateTone = 'ok' | 'pending' | 'warn' | 'error'

/** Copy key and tone of every engine and Laya gateway state. */
const STATES: Record<JudgmentEngineState | LayaGatewayState, { key: ModelRoutingKey; tone: StateTone }> = {
  'ready': { key: 'stateReady', tone: 'ok' },
  'starting': { key: 'stateStarting', tone: 'pending' },
  'unavailable': { key: 'stateUnavailable', tone: 'error' },
  'unconfigured': { key: 'stateUnconfigured', tone: 'warn' },
  'not-installed': { key: 'stateNotInstalled', tone: 'warn' },
  'unsupported-host': { key: 'stateUnsupportedHost', tone: 'warn' },
  'stopped': { key: 'stateStopped', tone: 'warn' },
}

/**
 * The label and tone of one state.
 * @param state - an engine or Laya gateway state.
 * @param t - section copy.
 * @returns the localized label and its visual tone.
 */
export function stateLabel(state: JudgmentEngineState | LayaGatewayState, t: Translate): { label: string; tone: StateTone } {
  const entry = STATES[state]
  return { label: t(entry.key), tone: entry.tone }
}

/**
 * Whether an engine keeps the judged state on this machine: `none` and `local` do,
 * `remote` sends it to another host, including one on the local network.
 * @param engine - the engine.
 * @returns true for a remote engine.
 */
export function isRemote(engine: JudgmentEngineView): boolean {
  return engine.egress === 'remote'
}

/**
 * The selector option text of one engine.
 * @param engine - the engine.
 * @param t - section copy.
 * @returns its label with its egress, or the host it needs when this machine is not one.
 */
export function engineOption(engine: JudgmentEngineView, t: Translate): string {
  if (!engine.runsOnThisHost) return t('engineOptionElsewhere', { label: engine.label, host: engine.host })
  return t('engineOption', { label: engine.label, egress: t(isRemote(engine) ? 'egressRemoteWord' : 'egressLocalWord') })
}

/**
 * The model id text of one engine.
 * @param engine - the engine.
 * @param t - section copy.
 * @returns one id when both tiers use it, both ids otherwise, or undefined when the provider names none.
 */
export function modelsText(engine: JudgmentEngineView, t: Translate): string | undefined {
  const models = engine.models
  if (models === undefined) return undefined
  return models.fast === models.accurate
    ? t('models', { model: models.fast })
    : t('modelsByTier', { fast: models.fast, accurate: models.accurate })
}

/**
 * The last-exit line of the Laya gateway.
 * @param laya - the gateway view.
 * @param t - section copy.
 * @returns the line, or undefined when no exit is reported.
 */
export function lastExitText(laya: LayaGatewayView, t: Translate): string | undefined {
  const exit = laya.lastExit
  if (exit === undefined) return undefined
  const cause = exit.signal === null ? t('layaExitCode', { code: String(exit.exitCode) }) : t('layaExitSignal', { signal: exit.signal })
  return t('layaLastExit', { exit: exit.timedOut ? t('layaExitTimedOut', { exit: cause }) : cause })
}

/**
 * Read one number from a resolved settings section.
 * @param section - the namespace view, when the Host exposes it.
 * @param path - keys from the section root.
 * @returns the number, or undefined when absent or not a number.
 */
export function numberAt(section: SettingsNamespaceView | null, path: readonly string[]): number | undefined {
  let value: unknown = section?.value
  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return typeof value === 'number' ? value : undefined
}

/**
 * The routing mode new sessions start in.
 * @param router - the resolved `model-router` section.
 * @returns `on` only when the section stores it.
 */
export function initialMode(router: SettingsNamespaceView): 'off' | 'on' {
  const value = router.value
  return typeof value === 'object' && value !== null && (value as { initialMode?: unknown }).initialMode === 'on' ? 'on' : 'off'
}

/**
 * Whether judgment is on in the resolved `judgment` section; an omitted field is on.
 * @param judgment - the resolved section.
 * @returns false only for a stored `false`.
 */
export function classifierEnabled(judgment: SettingsNamespaceView): boolean {
  const value = judgment.value
  return !(typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === false)
}

/** The engine one declared consumer asks. */
export interface ConsumerRoute {
  /** Declared consumer id. */
  readonly consumer: string
  /** Id of the engine the dispatcher asks for this consumer. */
  readonly engineId: string
  /** That engine, or undefined when no engine with that id is registered, so every ask fails. */
  readonly engine: JudgmentEngineView | undefined
  /** Whether a per-consumer override, rather than the selected engine, names it. */
  readonly overridden: boolean
}

/**
 * The engine each declared consumer asks, by the dispatcher's rule: the
 * consumer's `judgment.overrides` entry while the consumer is declared, else
 * the selected engine.
 * @param snapshot - the engine view.
 * @returns one route per declared consumer, in declaration order.
 */
export function consumerRoutes(snapshot: JudgmentEnginesSnapshot): ConsumerRoute[] {
  const { engine, overrides } = snapshot.selection
  return snapshot.consumers.map((consumer) => {
    const overridden = Object.hasOwn(overrides, consumer)
    const engineId = overridden ? overrides[consumer] as string : engine
    return { consumer, engineId, engine: snapshot.engines.find(candidate => candidate.id === engineId), overridden }
  })
}

/**
 * Overrides naming a consumer that is not declared, which the dispatcher ignores.
 * @param snapshot - the engine view.
 * @returns each ignored override's consumer and engine ids.
 */
export function ignoredOverrides(snapshot: JudgmentEnginesSnapshot): { consumer: string; engineId: string }[] {
  const declared = new Set<string>(snapshot.consumers)
  return Object.entries(snapshot.selection.overrides)
    .filter(([consumer]) => !declared.has(consumer))
    .map(([consumer, engineId]) => ({ consumer, engineId }))
}

/**
 * How the router gates one engine's answers, read from `model-router.operatingPoints`:
 * `refused` for a verbalized engine whose operating point does not set
 * `acceptVerbalized` (the router keeps the strong model without asking), then
 * `calibrated` when its operating point names `calibratedBy`, `point` when
 * one without it applies, and `global` when none names the engine.
 */
export type RoutingCalibration =
  | { readonly kind: 'calibrated'; readonly by: string }
  | { readonly kind: 'point' }
  | { readonly kind: 'global' }
  | { readonly kind: 'refused' }

/**
 * The router's gate for one engine.
 * @param router - the resolved `model-router` section, when the Host exposes it.
 * @param engine - the engine the router asks.
 * @returns the gate kind, and the evaluator of a calibrated operating point.
 */
export function routingCalibration(router: SettingsNamespaceView | null, engine: JudgmentEngineView): RoutingCalibration {
  const value = router?.value
  const points = typeof value === 'object' && value !== null ? (value as { operatingPoints?: unknown }).operatingPoints : undefined
  const point = Array.isArray(points)
    ? points.find((entry): entry is { engine: unknown; calibratedBy?: unknown; acceptVerbalized?: unknown } =>
      typeof entry === 'object' && entry !== null && (entry as { engine?: unknown }).engine === engine.id)
    : undefined
  if (engine.calibration === 'verbalized' && point?.acceptVerbalized !== true) return { kind: 'refused' }
  if (point === undefined) return { kind: 'global' }
  return typeof point.calibratedBy === 'string' && point.calibratedBy.length > 0
    ? { kind: 'calibrated', by: point.calibratedBy }
    : { kind: 'point' }
}
