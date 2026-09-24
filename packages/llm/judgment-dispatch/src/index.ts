/**
 * The judgment dispatcher: the one `ctx.judgment` implementation in a
 * deployment that composes selectable judgment engines.
 *
 * The dispatcher provides the engine registry as `ctx.judgmentEngines`, where
 * each provider (`judgment-typesafe`, `judgment-shield`, …) registers one
 * engine, and installs the `judgment` settings section with the configured
 * `defaultEngine` as its composition layer. Every ask goes to the one engine the
 * section selects for the asking consumer — an `overrides` entry, else
 * `engine` — and every answer carries that engine's registry id. The dispatcher
 * never answers with a different engine: an unregistered selection fails
 * `UNCONFIGURED` and a registered engine that is not `ready` fails
 * `UNAVAILABLE`, so consumers take their own fallback path instead of reading a
 * judgment made under another engine's calibration.
 *
 * @module @shres-code/shres-code-judgment-dispatch
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import { SettingsFieldError } from '@shres-code/shres-code-settings'
import {
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
  /** One fitting capability object, returned while the default selection supports fitting. */
  private readonly dispatchedFitting: JudgmentFittingEngine
  /** Unregistered selections already logged, so each is reported once. */
  private readonly reportedUnresolved = new Set<string>()
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
      validateSelection: (value) => {
        assertSelectionServable(registry, value as DispatchedSettings)
      },
    })
    this.config = resolved
    this.registry = registry
    this.selection = this.settings as () => DispatchedSettings
    this.dispatchedFitting = { ask: input => this.askFitted(input) }
    Object.defineProperty(this, 'fitting', {
      configurable: true,
      enumerable: true,
      get: (): JudgmentFittingEngine | undefined => this.defaultFitting(),
    })
    ctx.provide('judgmentEngines', registry)
    ctx.effect(() => {
      let live = true
      // The Loader is read structurally so the dispatcher carries no Loader
      // dependency; without one there is no settle point, and the report
      // happens at the first ask routed to a missing engine instead.
      const loader = (ctx.get as (name: string) => { await(): Promise<void> } | undefined)('loader')
      loader?.await().then(() => {
        if (live) this.reportUnresolvedSelection()
      }, () => {
        // A fiber elsewhere in the tree failed; the Loader and boot report it,
        // and the unresolved-selection report still happens at the first ask
        // routed to a missing engine.
      })
      return () => {
        live = false
      }
    }, 'judgment-dispatch: report unresolved selection')
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
    const result = await entry.engine.ask(input)
    return { ...result, engineId: id }
  }

  /**
   * Resolve the engine that answers one consumer's asks.
   * @param consumer - the asking consumer; omission selects the deployment-wide engine.
   * @returns the registry id the settings select.
   */
  selectedEngine(consumer?: JudgmentConsumerId): JudgmentEngineId {
    const settings = this.selection()
    const override = consumer === undefined ? undefined : settings.overrides?.[consumer]
    return judgmentEngineId(override ?? settings.engine)
  }

  /** The fitting capability while the deployment-wide selection supports it. */
  private defaultFitting(): JudgmentFittingEngine | undefined {
    const entry = this.registry.get(this.selectedEngine())
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
      )
    }
    const result = await fitting.ask(input)
    return result.kind === 'answered'
      ? { ...result, result: { ...result.result, engineId: id } }
      : { ...result, engineId: id }
  }

  /** Look up a selected engine that can answer now. */
  private readyEntry(id: JudgmentEngineId): JudgmentEngineEntry {
    const entry = this.registry.get(id)
    if (entry === undefined) {
      this.reportUnresolved(id)
      throw new JudgmentError('UNCONFIGURED', `judgment engine "${id}" is not composed`)
    }
    const status = entry.status()
    if (status.state !== 'ready') {
      const detail = status.detail === undefined ? '' : `: ${status.detail}`
      throw new JudgmentError('UNAVAILABLE', `judgment engine "${id}" is ${status.state}${detail}`)
    }
    return entry
  }

  /** Log every selected id no provider registered, once per id. */
  private reportUnresolvedSelection(): void {
    for (const id of selectedIds(this.selection())) {
      if (this.registry.get(judgmentEngineId(id)) === undefined) this.reportUnresolved(id)
    }
  }

  /** Log one unregistered selection the first time it is seen. */
  private reportUnresolved(id: string): void {
    if (this.reportedUnresolved.has(id)) return
    this.reportedUnresolved.add(id)
    this.ctx.logger.error('judgment-dispatch: judgment engine "%s" is selected but not composed; every ask routed to it fails UNCONFIGURED', id)
  }
}

/** Every engine id one settings value selects: the deployment-wide engine, then each override. */
function selectedIds(settings: DispatchedSettings): string[] {
  return [settings.engine, ...Object.values(settings.overrides ?? {})]
}

/**
 * Reject a selection this dispatcher cannot serve: an id no provider
 * registered, or an engine whose descriptor names another host.
 * @param registry - the live registry.
 * @param settings - the resolved section a write or reload would commit.
 * @throws SettingsFieldError naming the selecting field and the engine.
 */
function assertSelectionServable(registry: JudgmentEngineRegistry, settings: DispatchedSettings): void {
  const fields: Array<[readonly string[], string]> = [[['engine'], settings.engine]]
  for (const [consumer, id] of Object.entries(settings.overrides ?? {})) fields.push([['overrides', consumer], id])
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
