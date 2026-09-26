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
  ModelProviderGroup,
  SettingsNamespaceView,
} from '@shres-code/shres-code-api-remotes/client'
import type {
  ModelRoutingCalibration,
  ModelRoutingCandidateEligibilityReason,
  ModelRoutingGateView,
  ModelRoutingObjective,
  ModelRoutingPoolCandidate,
  ModelRoutingPoolStatus,
} from '@shres-code/shres-code-model-router/client'
import type { ModelRoutingKey } from './locales.ts'
import { ROUTER_CONSUMER } from './model.ts'
import type { PoolCandidateDraft, RouteFromDraft } from './model.ts'

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
 * @returns the stored `initialMode`, `off` when absent or unknown: a value
 * the router would reject cannot come from a validated section, and reading it
 * as off keeps the card usable instead of showing a phantom selection.
 */
export function initialMode(router: SettingsNamespaceView): 'off' | 'on' | 'shadow' {
  const value = router.value
  if (typeof value !== 'object' || value === null) return 'off'
  const stored = (value as { initialMode?: unknown }).initialMode
  return stored === 'on' || stored === 'shadow' ? stored : 'off'
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
 * How the router gates one engine's answers, as its gate read reports it.
 * @param gate - the router's gate view, when the Host serves it.
 * @param engine - the engine's registry id.
 * @returns the calibration, or undefined when the router reports none for the engine.
 */
export function engineCalibration(gate: ModelRoutingGateView | null, engine: string): ModelRoutingCalibration | undefined {
  return gate?.engines.find(entry => entry.engine === engine)?.calibration
}

/**
 * The engine the router asks now: the router's override while the consumer is
 * declared, else the selected engine. The thresholds card and the pool
 * editor's judge hint read the same engine through this one helper.
 * @param snapshot - the engine view, when it has been read.
 * @returns the registry id, or undefined when no view is read.
 */
export function routerEngine(snapshot: JudgmentEnginesSnapshot | null): string | undefined {
  if (snapshot === null) return undefined
  return consumerRoutes(snapshot).find(route => route.consumer === ROUTER_CONSUMER)?.engineId ?? snapshot.selection.engine
}

/** The pool and allowlist a section stores, as the editor edits them. */
export interface PoolSection {
  readonly candidates: PoolCandidateDraft[]
  readonly routeFrom: RouteFromDraft[]
}

/** A string field of a stored entry, or undefined. */
function stringAt(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read the pool and `routeFrom` from the resolved `model-router` section.
 * @param router - the resolved section.
 * @returns the pool and the allowlist; entries that are not objects are skipped.
 */
export function poolSection(router: SettingsNamespaceView): PoolSection {
  const value = typeof router.value === 'object' && router.value !== null ? router.value as Record<string, unknown> : {}
  const entries = (key: string): Record<string, unknown>[] => {
    const list = value[key]
    return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : []
  }
  return {
    candidates: entries('candidates').map((entry) => {
      const effort = stringAt(entry, 'reasoningEffort')
      return {
        id: stringAt(entry, 'id') ?? '',
        provider: stringAt(entry, 'provider') ?? '',
        model: stringAt(entry, 'model') ?? '',
        ...effort === undefined ? {} : { reasoningEffort: effort },
        description: stringAt(entry, 'description') ?? '',
      }
    }),
    routeFrom: entries('routeFrom').map((entry) => {
      const objective = stringAt(entry, 'objective')
      return {
        provider: stringAt(entry, 'provider') ?? '',
        model: stringAt(entry, 'model') ?? '',
        ...objective === undefined ? {} : { objective: objective as ModelRoutingObjective },
        ...typeof entry['allowEveryTurn'] === 'boolean' ? { allowEveryTurn: entry['allowEveryTurn'] } : {},
      }
    }),
  }
}

/** One model the catalog lists. */
export interface CatalogModel {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly name: string
  readonly efforts?: readonly string[]
}

/**
 * Flatten the catalog into its models, in provider then provider-preferred order.
 * @param models - the catalog groups.
 * @returns every listed model.
 */
export function catalogModels(models: readonly ModelProviderGroup[]): CatalogModel[] {
  return models.flatMap(group => group.models.map(model => ({
    provider: group.id,
    providerName: group.name,
    model: model.id,
    name: model.name,
    ...model.reasoning === undefined ? {} : { efforts: model.reasoning.efforts.map(effort => effort.id) },
  })))
}

/**
 * A model's display name: the catalog's name, else the route.
 * @param catalog - the catalog models.
 * @param provider - the provider route.
 * @param model - the model id.
 * @returns the name.
 */
export function modelLabel(catalog: readonly CatalogModel[], provider: string, model: string): string {
  return catalog.find(entry => entry.provider === provider && entry.model === model)?.name ?? `${provider}/${model}`
}

/**
 * A pool id derived from a model id: its last path segment, lower-cased, with
 * every run of other characters turned into one hyphen, made unique among the
 * ids already taken and never the reserved `keep-current`.
 * @param model - the model id.
 * @param taken - the ids in use.
 * @returns the id.
 */
export function poolIdFor(model: string, taken: ReadonlySet<string>): string {
  const last = model.substring(model.lastIndexOf('/') + 1)
  const base = last.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
  let id = base === 'keep-current' ? 'keep-current-model' : base
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`
  return id
}

/**
 * A token count in compact form: `1M`, `200k`, `131k`.
 * @param tokens - the count.
 * @returns the text.
 */
export function tokensText(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${String(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${String(Math.round(tokens / 1_000))}k`
  return String(tokens)
}

/** The copy explaining why a pool model cannot route from a base, by eligibility result. */
const WHY: Record<Exclude<ModelRoutingCandidateEligibilityReason, 'eligible' | 'equals-base' | 'context-too-small'>, ModelRoutingKey> = {
  'base-unavailable': 'whyBaseUnavailable',
  'base-context-unknown': 'whyBaseContextUnknown',
  'candidate-unavailable': 'whyCandidateUnavailable',
  'candidate-invalid': 'whyCandidateInvalid',
  'difficulty-effort-invalid': 'whyDifficultyEffort',
  'image-capability-unknown': 'whyImageUnknown',
  'image-incompatible': 'whyImageIncompatible',
  'context-unknown': 'whyContextUnknown',
  'max-tokens-exceeds-context': 'whyMaxTokens',
  'hosted-tools-incompatible': 'whyHostedTools',
  'thinking-mode-incompatible': 'whyThinkingMode',
}

/** One capability or token note beside a pool model. */
export interface PoolNote {
  readonly text: string
  readonly title?: string
  readonly tone: 'ok' | 'warn' | 'neutral'
}

/**
 * The notes beside one pool model, from the router's pool status: where it is
 * eligible from, where it never is and why, cross-membership with Route from,
 * an unregistered route, and a provider that reports no cache counts. Notes are
 * capability and token facts only.
 * @param candidate - the model's pool status.
 * @param pool - the whole pool status, for the bases' context windows.
 * @param catalog - the catalog, for display names.
 * @param t - section copy.
 * @returns the notes, in display order.
 */
export function poolNotes(
  candidate: ModelRoutingPoolCandidate,
  pool: ModelRoutingPoolStatus,
  catalog: readonly CatalogModel[],
  t: Translate,
): PoolNote[] {
  const notes: PoolNote[] = []
  if (!candidate.registered) notes.push({ text: t('noteUnregistered'), title: t('noteUnregisteredTitle'), tone: 'warn' })
  for (const result of candidate.eligibility) {
    const base = modelLabel(catalog, result.provider, result.model)
    const baseWindow = pool.routeFrom.find(entry => entry.provider === result.provider && entry.model === result.model)?.contextWindow
    switch (result.reason) {
      case 'eligible':
        notes.push({ text: t('noteEligible', { base }), tone: 'ok' })
        break
      // Cross-membership says it: a model is never a downgrade from itself.
      case 'equals-base':
        break
      case 'context-too-small':
        notes.push(candidate.contextWindow === undefined || baseWindow === undefined
          ? { text: t('noteNeverEligible', { base, why: t('whyContextUnknown') }), tone: 'warn' }
          : {
            text: t('noteNeverEligibleContext', { base, candidate: tokensText(candidate.contextWindow), limit: tokensText(baseWindow) }),
            tone: 'warn',
          })
        break
      default:
        notes.push({ text: t('noteNeverEligible', { base, why: t(WHY[result.reason]) }), tone: 'warn' })
    }
  }
  if (candidate.alsoRouteFrom) notes.push({ text: t('noteAlsoRouteFrom'), title: t('noteAlsoRouteFromTitle'), tone: 'warn' })
  if (candidate.cacheUsage === 'unreported') notes.push({ text: t('noteCacheUnreported'), title: t('noteCacheUnreportedTitle'), tone: 'neutral' })
  return notes
}
