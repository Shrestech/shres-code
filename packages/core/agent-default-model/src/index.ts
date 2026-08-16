/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @roos-code/roos-code-agent-default-model
 */

import { Context, Service } from '@roos-code/cordis'
import z from '@roos-code/schemastery'
import { installModelSelection } from '@roos-code/roos-code-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@roos-code/roos-code-agent'
import type {} from '@roos-code/roos-code-commands'
import { ReasoningEffortId } from '@roos-code/roos-code-llm'
import type {} from '@roos-code/roos-code-llm'
import { installSettingsSection, settingsNamespace } from '@roos-code/roos-code-settings'
import { handleModelCommand } from './command.ts'

export {
  applyModelSwitch,
  formatModelCatalog,
  formatSelection,
  handleModelCommand,
  MODEL_COMMAND_USAGE,
  parseModelCommand,
  validateSelection,
} from './command.ts'
export type { ParsedModelCommand } from './command.ts'

declare module '@roos-code/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = settingsNamespace('agent-default-model')

/** GenerateOptions.purpose values that may override the conversation default. */
export type ModelPurpose = 'compaction' | 'session-title'

/** Purpose keys accepted by `saveSelection({ purpose })` and `/model` listing. */
export const MODEL_PURPOSES: readonly ModelPurpose[] = ['compaction', 'session-title']

/** One stored provider/model/effort triple. */
export interface StoredModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Stored and composed default model selection, plus optional purpose overrides. */
export interface AgentDefaultModelSettings extends StoredModelSelection {
  /** Optional per-purpose overrides keyed by GenerateOptions.purpose. */
  purposes?: Partial<Record<ModelPurpose, StoredModelSelection>>
}

const storedSelectionSchema: z<StoredModelSelection> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  purposes: z.dict(storedSelectionSchema),
})

/** Composition entry for the default model selection. */
export interface Config {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Options for {@link AgentDefaultModelConfig.saveSelection}. */
export interface SaveSelectionOptions {
  /** When set, write this selection under `purposes[purpose]` instead of the conversation default. */
  purpose?: ModelPurpose
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: StoredModelSelection): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

function stored(next: ModelSelection): StoredModelSelection {
  return {
    provider: next.provider,
    model: next.model,
    ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
  }
}

/** Session-local selection that falls back to the log, then the live default. */
interface LiveModelSelectionRef extends ModelSelectionRef {
  current: ModelSelection
}

/**
 * Owns the default model selection independently of any Host or transport.
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live. `/model` is an optional child that
 * activates only when a command registry is composed.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })

  private source: () => AgentDefaultModelSettings
  private readonly selections = new WeakMap<Agent, LiveModelSelectionRef>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentDefaultModel')
    const entry: AgentDefaultModelSettings = { provider: config.provider, model: config.model }
    this.source = () => entry
    installSettingsSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      // Every consumer reads through currentSelection(), so no registration-level fact
      // needs rebuilding when the settings document changes.
      onChange: () => {},
    })
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'model',
        description: 'Show or switch the session model and reasoning effort',
        input: { hint: '[<provider> <model>] [--effort <level>]' },
        handler: ({ agent, rawInput }) => handleModelCommand(this, agent, rawInput),
      })
    })
  }

  /**
   * The mounted LLM service, when one is composed.
   * @returns the live llm service, or undefined.
   */
  llm(): Context['llm'] | undefined {
    return this.ctx.get('llm')
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    return selection(this.source())
  }

  /**
   * Read stored purpose overrides.
   * @returns a detached map of purpose to selection; absent keys have no override.
   */
  purposeSelections(): Partial<Record<ModelPurpose, ModelSelection>> {
    const purposes = this.source().purposes
    if (purposes === undefined) return {}
    const result: Partial<Record<ModelPurpose, ModelSelection>> = {}
    for (const purpose of MODEL_PURPOSES) {
      const override = purposes[purpose]
      if (override !== undefined) result[purpose] = selection(override)
    }
    return result
  }

  /**
   * Read the stored override for one GenerateOptions.purpose, when present.
   * @param purpose - compaction or session-title.
   * @returns the override, or `undefined` when the conversation default applies.
   */
  selectionForPurpose(purpose: ModelPurpose): ModelSelection | undefined {
    return this.purposeSelections()[purpose]
  }

  /**
   * Install or return the session-local model selection that prompt assembly snapshots.
   *
   * Precedence, resolved on every read: a selection made in this process, else
   * the session's latest logged request/header, else the live default.
   *
   * @param agent - the Agent whose request waterfall should observe this selection.
   * @returns the shared mutable selection for this Agent.
   */
  selectionFor(agent: Agent): LiveModelSelectionRef {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    let picked: ModelSelection | undefined
    const readDefault = (): ModelSelection => this.currentSelection()
    const selectionRef: LiveModelSelectionRef = {
      get current(): ModelSelection {
        if (picked !== undefined) return picked
        const logged = agent.session.requestHeader()?.config
        if (logged === undefined) return readDefault()
        return {
          provider: logged.provider,
          model: logged.model,
          ...logged.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: logged.reasoningEffort },
        }
      },
      set current(next: ModelSelection) {
        picked = next
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selectionRef)
    this.selections.set(agent, selectionRef)
    return selectionRef
  }

  /**
   * Save a default or purpose-specific model selection. A deployment without a
   * settings provider keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @param options - optional purpose key; omit to write the conversation default.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelection, options: SaveSelectionOptions = {}): Promise<void> {
    const settings = this.ctx.get('settings')
    if (settings === undefined) return
    const current = this.source()
    if (options.purpose === undefined) {
      const purposes = current.purposes
      await settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
        ...stored(next),
        ...purposes === undefined || Object.keys(purposes).length === 0 ? {} : { purposes },
      })
      return
    }
    await settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      provider: current.provider,
      model: current.model,
      ...current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort },
      purposes: {
        ...current.purposes,
        [options.purpose]: stored(next),
      },
    })
  }
}

export default AgentDefaultModelConfig
