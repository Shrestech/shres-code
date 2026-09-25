/**
 * The judgment dispatcher: the one `ctx.judgment` implementation in a
 * deployment that composes selectable judgment engines.
 *
 * The dispatcher provides the engine registry as `ctx.judgmentEngines`, where
 * each provider (`judgment-typesafe`, `judgment-shield`, …) registers one
 * engine, and installs the `judgment` settings section with the configured
 * `defaultEngine` as its composition layer. Every ask goes to the one engine the
 * section selects for the asking consumer — an `overrides` entry, else
 * `engine` — and every answer and every failure carries that engine's registry
 * id. A consumer reads its own fitting capability through `fittingFor`. The dispatcher
 * never answers with a different engine: an unregistered selection fails
 * `UNCONFIGURED` and a registered engine that is not `ready` fails
 * `UNAVAILABLE`, so consumers take their own fallback path instead of reading a
 * judgment made under another engine's calibration. An override applies only
 * to a consumer that declared its id in the registry.
 *
 * Live-service checks apply only to what a configuration write changes: a
 * write that selects an engine that is not composed or runs on another host,
 * or adds an override for an undeclared consumer, is rejected naming the field
 * written. A reloaded document is never rejected for the state of live
 * services, because rejecting it would keep the previous engine answering with
 * no visible sign; the dispatcher applies it, reports each unregistered
 * selection and undeclared override once, and reports again when one resolves.
 *
 * @module @shres-code/shres-code-judgment-dispatch
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { SettingsFieldError } from '@shres-code/shres-code-settings'
import {
  JUDGMENT_SETTINGS_NAMESPACE,
  JudgmentEngineRegistry,
  JudgmentError,
  JudgmentService,
  judgmentEngineId,
} from '@shres-code/shres-code-judgment'
import type {
  JudgmentConsumerId,
  JudgmentEngineEntry,
  JudgmentEngineId,
  JudgmentFittingEngine,
  JudgmentFittingInput,
  JudgmentFittingResult,
  JudgmentInput,
  JudgmentResult,
  JudgmentSettings,
} from '@shres-code/shres-code-judgment'
import { resolveConfig } from './config.ts'
import type { JudgmentDispatchConfig, ResolvedJudgmentDispatchConfig } from './config.ts'

export { resolveConfig } from './config.ts'
export type { JudgmentDispatchConfig, ResolvedJudgmentDispatchConfig } from './config.ts'

/** Config omitted by a direct `ctx.plugin(JudgmentDispatch)` call; {@link resolveConfig} rejects it by name. */
const NO_CONFIG = {} as JudgmentDispatchConfig

/** The `judgment` section as the dispatcher installs it: the composition layer always selects an engine. */
interface DispatchedSettings extends JudgmentSettings {
  engine: string
}


/**
 * Routes every judgment ask to the engine the `judgment` settings select.
 * Registers `ctx.judgment` and `ctx.judgmentEngines` with its own fiber.
 */
export class JudgmentDispatch extends JudgmentService {
  /** Composition schema consumed by the Loader; {@link resolveConfig} repeats the check for direct construction. */
  static Config: z<JudgmentDispatchConfig> = z.object({
    defaultEngine: z.string().required(),
  })

  /** Resolved composition default. */
  readonly config: ResolvedJudgmentDispatchConfig
  /** The registry this dispatcher provides as `ctx.judgmentEngines`. */
  readonly registry: JudgmentEngineRegistry
  /** One fitting capability object, returned while the selection it is read for supports fitting. */
  private readonly dispatchedFitting: JudgmentFittingEngine
  /** Unregistered selections currently reported, so each condition is reported once. */
  private readonly reportedUnresolved = new Set<string>()
  /** Undeclared override consumers currently reported, so each condition is reported once. */
  private readonly reportedUndeclared = new Set<string>()
  /** Whether the Loader has settled, after which selection and registry changes are reconciled. */
  private settled = false
  /**
   * {@link settings} with `engine` known to be present: the composition layer
   * supplies it, a stored layer cannot remove it (a merge skips an absent key),
   * and the Definition's shape check rejects a stored `null`.
   */
  private readonly selection: () => DispatchedSettings

  /**
   * @param ctx - context receiving `ctx.judgment` and `ctx.judgmentEngines`.
   * @param config - the required `defaultEngine` registry id.
   * @throws Error when `defaultEngine` is missing or empty, or config names an unknown key.
   */
  constructor(ctx: Context, config: JudgmentDispatchConfig = NO_CONFIG) {
    const resolved = resolveConfig(config)
    const registry = new JudgmentEngineRegistry((error: unknown) => {
      ctx.logger.warn('judgment-dispatch: a judgment engine registry subscriber failed: %s', String(error))
    })
    super(ctx, {
      base: { enabled: true, engine: resolved.defaultEngine },
      validateSelection: (value, previous) => {
        assertWriteServable(registry, value as DispatchedSettings, previous as DispatchedSettings)
      },
    })
    this.config = resolved
    this.registry = registry
    this.selection = this.settings as () => DispatchedSettings
    this.dispatchedFitting = { ask: input => this.askFitted(input) }
    Object.defineProperty(this, 'fitting', {
      configurable: true,
      enumerable: true,
      get: (): JudgmentFittingEngine | undefined => this.fittingFor(),
    })
    ctx.provide('judgmentEngines', registry)
    ctx.effect(() => {
      let live = true
      // The Loader is read structurally so the dispatcher carries no Loader
      // dependency; without one there is no settle point, and the report
      // happens at the first ask routed to a missing engine instead.
      const loader = (ctx.get as (name: string) => { await(): Promise<void> } | undefined)('loader')
      loader?.await().then(() => {
        if (!live) return
        this.settled = true
        this.reconcileReports()
      }, () => {
        // A fiber elsewhere in the tree failed; the Loader and boot report it,
        // and the unresolved-selection report still happens at the first ask
        // routed to a missing engine.
      })
      return () => {
        live = false
      }
    }, 'judgment-dispatch: report unresolved selection')
    // After the settle, a committed settings change (a write or a reload) and a
    // registry change (an engine or consumer arriving or leaving) each
    // re-reconcile the reports; before it, a provider may still be loading.
    ctx.effect(() => ctx.on('settings/updated', (ns) => {
      if (ns === JUDGMENT_SETTINGS_NAMESPACE && this.settled) this.reconcileReports()
    }), 'judgment-dispatch: reconcile reports on settings change')
    ctx.effect(() => registry.subscribe(() => {
      if (this.settled) this.reconcileReports()
    }), 'judgment-dispatch: reconcile reports on registry change')
  }

  /**
   * Answer typed questions with the engine the settings select for
   * `input.consumer`.
   * @param input - state, typed questions, optional tier, signal, and consumer id.
   * @returns the selected engine's answers, stamped with its registry id.
   * @throws JudgmentError `UNCONFIGURED` when no provider registered the
   *   selected id, `UNAVAILABLE` when that engine is not `ready`, and whatever
   *   the selected engine throws.
   */
  override async ask(input: JudgmentInput): Promise<JudgmentResult> {
    const id = this.selectedEngine(input.consumer)
    const entry = this.readyEntry(id)
    try {
      const result = await entry.engine.ask(input)
      return { ...result, engineId: id }
    } catch (error: unknown) {
      throw stampEngine(error, id)
    }
  }

  /**
   * Resolve the engine that answers one consumer's asks.
   * @param consumer - the asking consumer; omission, or a consumer that has not
   *   declared its id, selects the deployment-wide engine.
   * @returns the registry id the settings select.
   */
  override selectedEngine(consumer?: JudgmentConsumerId): JudgmentEngineId {
    const settings = this.selection()
    // An override applies only while its consumer declares itself, so a stored
    // override the settle-time report names as ignored is ignored for every ask.
    const override = consumer === undefined || !this.registry.hasConsumer(consumer) ? undefined : settings.overrides?.[consumer]
    return judgmentEngineId(override ?? settings.engine)
  }

  /**
   * The fitting capability for the engine the settings select for one
   * consumer. It is present exactly while that engine exposes fitting, and a
   * fitted ask through it routes by the ask's own `consumer` at ask time.
   * @param consumer - the asking consumer; omission reads the deployment-wide selection.
   * @returns the dispatched fitting capability, or `undefined` when the selected engine has none or is not composed.
   */
  override fittingFor(consumer?: JudgmentConsumerId): JudgmentFittingEngine | undefined {
    const entry = this.registry.get(this.selectedEngine(consumer))
    return entry?.engine.fitting === undefined ? undefined : this.dispatchedFitting
  }

  /** Route one fitted ask to the engine selected for its consumer. */
  private async askFitted(input: JudgmentFittingInput): Promise<JudgmentFittingResult> {
    const id = this.selectedEngine(input.consumer)
    const fitting = this.readyEntry(id).engine.fitting
    if (fitting === undefined) {
      throw new JudgmentError(
        'UNAVAILABLE',
        `judgment engine "${id}" selected for consumer "${input.consumer ?? '(none)'}" does not support fitting`,
        { engineId: id },
      )
    }
    let result: JudgmentFittingResult
    try {
      result = await fitting.ask(input)
    } catch (error: unknown) {
      throw stampEngine(error, id)
    }
    return result.kind === 'answered'
      ? { ...result, result: { ...result.result, engineId: id } }
      : { ...result, engineId: id }
  }

  /** Look up a selected engine that can answer now. */
  private readyEntry(id: JudgmentEngineId): JudgmentEngineEntry {
    const entry = this.registry.get(id)
    if (entry === undefined) {
      this.reportUnresolved(id)
      throw new JudgmentError('UNCONFIGURED', `judgment engine "${id}" is not composed`, { engineId: id })
    }
    const status = entry.status()
    if (status.state !== 'ready') {
      const detail = status.detail === undefined ? '' : `: ${status.detail}`
      throw new JudgmentError('UNAVAILABLE', `judgment engine "${id}" is ${status.state}${detail}`, { engineId: id })
    }
    return entry
  }

  /**
   * Bring the reports in line with the current selection and registry: log
   * each selected id no provider registered and each override for an
   * undeclared consumer that is not yet reported, log at info level each
   * reported condition that has since resolved while still selected, and
   * forget each reported condition the selection no longer contains, so a
   * condition that returns is reported again.
   */
  private reconcileReports(): void {
    const settings = this.selection()
    const selected = new Set(selectedIds(settings))
    for (const id of selected) {
      if (this.registry.get(judgmentEngineId(id)) === undefined) this.reportUnresolved(id)
    }
    for (const id of [...this.reportedUnresolved]) {
      if (selected.has(id) && this.registry.get(judgmentEngineId(id)) === undefined) continue
      this.reportedUnresolved.delete(id)
      if (selected.has(id)) this.ctx.logger.info('judgment-dispatch: judgment engine "%s" is now composed and answers the asks routed to it', id)
    }
    const overrides = settings.overrides ?? {}
    for (const consumer of Object.keys(overrides)) {
      if (this.registry.hasConsumer(consumer) || this.reportedUndeclared.has(consumer)) continue
      this.reportedUndeclared.add(consumer)
      this.ctx.logger.error('judgment-dispatch: %s; the stored override is ignored', undeclaredConsumer(consumer))
    }
    for (const consumer of [...this.reportedUndeclared]) {
      const engine = overrides[consumer]
      if (engine !== undefined && !this.registry.hasConsumer(consumer)) continue
      this.reportedUndeclared.delete(consumer)
      if (engine !== undefined) {
        this.ctx.logger.info('judgment-dispatch: consumer "%s" now names itself in judgment asks; its override to engine "%s" is honoured', consumer, engine)
      }
    }
  }

  /** Log one unregistered selection the first time it is seen. */
  private reportUnresolved(id: string): void {
    if (this.reportedUnresolved.has(id)) return
    this.reportedUnresolved.add(id)
    this.ctx.logger.error('judgment-dispatch: judgment engine "%s" is selected but not composed; every ask routed to it fails UNCONFIGURED', id)
  }
}

/**
 * Attach the routed engine's registry id to one engine failure, as every
 * answer carries it. A `JudgmentError` is re-created with the same code,
 * message, and cause plus `engineId`; anything else an engine throws breaks
 * the provider contract and propagates unchanged.
 * @param error - what the engine threw.
 * @param id - the registry id the ask was routed to.
 * @returns the value to rethrow.
 */
function stampEngine(error: unknown, id: JudgmentEngineId): unknown {
  if (!(error instanceof JudgmentError) || error.engineId !== undefined) return error
  return new JudgmentError(error.code, error.message, { cause: error.cause, engineId: id })
}

/** Every engine id one settings value selects: the deployment-wide engine, then each override. */
function selectedIds(settings: DispatchedSettings): string[] {
  return [settings.engine, ...Object.values(settings.overrides ?? {})]
}

/**
 * Diagnostic for an override whose consumer never names itself on its asks.
 * @param consumer - the override key.
 * @returns the message, shared by the write rejection and the settle-time log.
 */
function undeclaredConsumer(consumer: string): string {
  return `judgment: consumer "${consumer}" does not name itself in judgment asks; this override would have no effect`
}

/**
 * Reject what a configuration write introduces that this dispatcher cannot
 * serve: a changed `engine`, or an added or changed override, that names an
 * engine no provider registered or one whose descriptor names another host,
 * and an added or changed override for a consumer that did not declare its
 * id. Fields the write leaves as they were are not re-judged, so a stale entry
 * never blocks an unrelated write, and the error names the field written.
 * @param registry - the live registry.
 * @param settings - the resolved section the write would commit.
 * @param previous - the resolved section in force before the write.
 * @throws SettingsFieldError naming the written field.
 */
function assertWriteServable(registry: JudgmentEngineRegistry, settings: DispatchedSettings, previous: DispatchedSettings): void {
  const fields: Array<[readonly string[], string]> = settings.engine === previous.engine ? [] : [[['engine'], settings.engine]]
  for (const [consumer, id] of Object.entries(settings.overrides ?? {})) {
    if (previous.overrides?.[consumer] === id) continue
    if (!registry.hasConsumer(consumer)) throw new SettingsFieldError(['overrides', consumer], undeclaredConsumer(consumer))
    fields.push([['overrides', consumer], id])
  }
  const host = `${process.platform}-${process.arch}`
  for (const [path, id] of fields) {
    const entry = registry.get(judgmentEngineId(id))
    if (entry === undefined) {
      throw new SettingsFieldError(path, `judgment: ${path.join('.')} names engine "${id}", which is not composed`)
    }
    const required = entry.descriptor.host
    if (required !== undefined && required !== 'any' && required !== host) {
      throw new SettingsFieldError(path, `judgment: engine "${id}" requires ${required}`)
    }
  }
}

export default JudgmentDispatch
