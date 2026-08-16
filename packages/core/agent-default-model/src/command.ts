/**
 * `/model` command: print or switch the receiving Agent's ModelSelection.
 *
 * @module @roos-code/roos-code-agent-default-model/command
 */

import type { Agent, ModelSelection } from '@roos-code/roos-code-agent'
import type { CommandResult } from '@roos-code/roos-code-commands'
import { LlmError, ReasoningEffortId } from '@roos-code/roos-code-llm'
import type { LlmResolvedModelInfo } from '@roos-code/roos-code-llm'
import type { AgentDefaultModelConfig } from './index.ts'

/** Usage printed for a malformed `/model` line. */
export const MODEL_COMMAND_USAGE = 'Usage: /model [<provider> <model>] [--effort <level>]'

/** Parsed `/model` invocation. */
export type ParsedModelCommand =
  | { kind: 'show' }
  | { kind: 'set'; provider?: string; model?: string; effort?: string }

/**
 * Split `/model` raw input into a show or set action.
 * @param rawInput - exact text following the command name.
 * @returns the parsed action, or an error string.
 */
export function parseModelCommand(rawInput: string): ParsedModelCommand | { error: string } {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  let effort: string | undefined
  const rest: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    /* v8 ignore next -- tokens[index] is defined for index < length; the check satisfies noUncheckedIndexedAccess */
    if (token === undefined) continue
    if (token === '--effort') {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return { error: MODEL_COMMAND_USAGE }
      }
      if (effort !== undefined) return { error: MODEL_COMMAND_USAGE }
      effort = value
      index += 1
      continue
    }
    if (token.startsWith('--')) return { error: MODEL_COMMAND_USAGE }
    rest.push(token)
  }
  if (rest.length === 0 && effort === undefined) return { kind: 'show' }
  if (rest.length === 0 && effort !== undefined) return { kind: 'set', effort }
  const provider = rest[0]
  const model = rest[1]
  if (rest.length === 2 && provider !== undefined && model !== undefined) {
    return {
      kind: 'set',
      provider,
      model,
      ...effort === undefined ? {} : { effort },
    }
  }
  return { error: MODEL_COMMAND_USAGE }
}

/**
 * Execute one `/model` invocation against the receiving agent.
 * @param service - default-model service that owns the live selection.
 * @param agent - exact receiving agent.
 * @param rawInput - exact text following the command name.
 * @returns the command result shown to the user.
 */
export async function handleModelCommand(
  service: AgentDefaultModelConfig,
  agent: Agent,
  rawInput: string,
): Promise<CommandResult> {
  if (isSubagentSession(agent)) {
    return { kind: 'error', text: 'model: /model is not available on a subagent session' }
  }
  const parsed = parseModelCommand(rawInput)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }
  if (parsed.kind === 'show') {
    return { kind: 'success', text: await formatModelCatalog(service, agent) }
  }
  try {
    const selected = await applyModelSwitch(service, agent, parsed)
    return { kind: 'success', text: formatSelection('model', selected) }
  } catch (error: unknown) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Validate and assign a session-local selection, then save it as the
 * process-wide default used by future sessions.
 * @param service - default-model service.
 * @param agent - receiving agent.
 * @param parsed - set action.
 * @returns the applied selection.
 */
export async function applyModelSwitch(
  service: AgentDefaultModelConfig,
  agent: Agent,
  parsed: Extract<ParsedModelCommand, { kind: 'set' }>,
): Promise<ModelSelection> {
  const current = service.selectionFor(agent).current
  const requested: ModelSelection = {
    provider: parsed.provider ?? current.provider,
    model: parsed.model ?? current.model,
    ...parsed.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(parsed.effort) },
  }
  const selected = await validateSelection(service, requested)
  service.selectionFor(agent).current = selected
  await service.saveSelection(selected)
  return selected
}

/**
 * Reject an unknown provider or an effort the adapter does not advertise.
 * `resolveCallConfig` is a validator, not a defaulting step: an omitted
 * effort is not persisted even when the adapter materializes `defaultEffort`.
 * A requested effort must survive `resolveCallConfig` unchanged.
 * @param service - default-model service (reads `ctx.llm` when mounted).
 * @param requested - candidate selection.
 * @returns the provider/model pair, plus the requested effort when one was supplied.
 */
export async function validateSelection(
  service: AgentDefaultModelConfig,
  requested: ModelSelection,
): Promise<ModelSelection> {
  const llm = service.llm()
  if (llm === undefined) {
    if (requested.reasoningEffort !== undefined) {
      throw new Error(
        `model: cannot validate effort "${requested.reasoningEffort}" because no llm service is mounted`,
      )
    }
    return { provider: requested.provider, model: requested.model }
  }
  try {
    const resolved = await llm.resolveCallConfig({
      provider: requested.provider,
      model: requested.model,
      ...requested.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: requested.reasoningEffort },
    })
    if (requested.reasoningEffort === undefined) {
      return { provider: resolved.provider, model: resolved.model }
    }
    if (resolved.reasoningEffort !== requested.reasoningEffort) {
      throw new Error(
        `model: effort "${requested.reasoningEffort}" did not survive validation for ${resolved.provider} ${resolved.model}`,
      )
    }
    return {
      provider: resolved.provider,
      model: resolved.model,
      reasoningEffort: requested.reasoningEffort,
    }
  } catch (error: unknown) {
    if (error instanceof LlmError) throw new Error(`model: ${error.message}`)
    throw error
  }
}

/**
 * Whether this agent is a subagent child whose switch must not write the process default.
 * `parentSession` is fork/seed lineage and is not a subagent mark.
 */
function isSubagentSession(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * Format the current selection plus advertised models and their efforts.
 * @param service - default-model service.
 * @param agent - receiving agent.
 * @returns printable catalog text.
 */
export async function formatModelCatalog(
  service: AgentDefaultModelConfig,
  agent: Agent,
): Promise<string> {
  const current = service.selectionFor(agent).current
  const lines = [formatSelection('current', current)]
  const purposes = service.purposeSelections()
  for (const purpose of ['compaction', 'session-title'] as const) {
    const override = purposes[purpose]
    if (override !== undefined) lines.push(formatSelection(`purpose ${purpose}`, override))
  }
  const llm = service.llm()
  if (llm === undefined) return lines.join('\n')
  lines.push('', 'available:')
  for (const provider of llm.listProviders()) {
    const models = await llm.listModels(provider.id)
    lines.push(`  ${provider.id}`)
    if (models.length === 0) {
      lines.push('    (no advertised models)')
      continue
    }
    for (const model of models) {
      const info = await resolveInfo(service, provider.id, model.id)
      lines.push(`    ${formatListedModel(model.id, info)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render one labeled selection line.
 * @param label - prefix (`current`, `model`, `purpose compaction`).
 * @param selected - selection to print.
 * @returns one physical line.
 */
export function formatSelection(label: string, selected: ModelSelection): string {
  const effort = selected.reasoningEffort === undefined ? '' : ` effort=${selected.reasoningEffort}`
  return `${label}: ${selected.provider} ${selected.model}${effort}`
}

function formatListedModel(id: string, info: LlmResolvedModelInfo | undefined): string {
  const efforts = info?.reasoning?.efforts.map(effort => effort.id) ?? []
  if (efforts.length === 0) return id
  const fallback = info?.reasoning?.defaultEffort === undefined
    ? ''
    : ` default=${info.reasoning.defaultEffort}`
  return `${id}  efforts: ${efforts.join(', ')}${fallback}`
}

async function resolveInfo(
  service: AgentDefaultModelConfig,
  provider: string,
  model: string,
): Promise<LlmResolvedModelInfo | undefined> {
  const llm = service.llm()
  /* v8 ignore next -- callers already return when llm is absent */
  if (llm === undefined) return undefined
  try {
    return await llm.resolveModelInfo(provider, model)
  } catch (error: unknown) {
    // Advisory listing: one model's metadata failure must not abort the catalog.
    void error
    return undefined
  }
}
