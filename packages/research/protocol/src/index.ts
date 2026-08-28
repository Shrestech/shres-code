/**
 * Settings-toggled researcher-cycle protocol. Owns the `autoresearch`
 * settings namespace and mounts the `research:protocol` prompt section plus
 * the design-defense gate on the experiment tools while enabled.
 *
 * @module @shres-code/shres-code-research-protocol
 */

import type { Context } from '@shres-code/cordis'
import z from '@shres-code/schemastery'
import type { Session } from '@shres-code/shres-code-session'
import { installSettingsSection, settingsNamespace } from '@shres-code/shres-code-settings'
import type {} from '@shres-code/shres-code-tools'
import type {} from '@shres-code/shres-code-jspace'
import { designDefenseDeny, missingDebateTools } from './epoch.ts'
import {
  RESEARCH_PROTOCOL_CARD_LINE,
  RESEARCH_PROTOCOL_SECTION_NAME,
  RESEARCH_PROTOCOL_SECTION_ORDER,
  RESEARCH_PROTOCOL_SECTION_TEXT,
} from './protocol.ts'

export { DESIGN_DEFENSE_DENY_PREFIX, designDefenseDeny, missingDebateTools } from './epoch.ts'
export { renderDigest } from './digest.ts'
export type { DigestBudget, DigestCard, DigestDecision, DigestInput } from './digest.ts'
export type { CompletedDebateCall } from './epoch.ts'
export {
  RESEARCH_PROTOCOL_CARD_LINE,
  RESEARCH_PROTOCOL_SECTION_NAME,
  RESEARCH_PROTOCOL_SECTION_ORDER,
  RESEARCH_PROTOCOL_SECTION_TEXT,
} from './protocol.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'research-protocol'

/** Required services. Settings is optional and read through `installSettingsSection`. */
export const inject = ['systemPrompt']

/** Settings namespace the autoresearch Settings page writes. */
export const AUTORESEARCH_SETTINGS_NAMESPACE = settingsNamespace('autoresearch')

/** Plugin config; also the settings schema for the `autoresearch` namespace. */
export interface Config {
  /** Master allow. Off mounts an empty section and a passthrough gate. Default false. */
  enabled?: boolean
  /** `per-epoch` refuses gated tools until every debate tool has a completed call this epoch. Default `per-epoch`. */
  requireDesignDefense?: 'per-epoch' | 'off'
  /** Seat tools whose completed calls satisfy the design defense. Default aegis and ward. */
  debateTools?: string[]
  /** Model-facing tools the gate holds back until the design defense exists. */
  gatedTools?: string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  requireDesignDefense: z.union(['per-epoch', 'off'] as const).default('per-epoch'),
  debateTools: z.array(z.string()).default(['aegis', 'ward']),
  gatedTools: z.array(z.string()).default(['experiment_log_run', 'experiment_log_metrics']),
})

/** Fully materialized plugin config. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly requireDesignDefense: 'per-epoch' | 'off'
  readonly debateTools: readonly string[]
  readonly gatedTools: readonly string[]
}

/**
 * Validate config even when apply is called directly outside Loader
 * normalization: lists must hold non-empty names, and the defense mode must
 * be a known union member.
 * @param config - raw plugin or settings value.
 * @returns the resolved config.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const debateTools = config.debateTools ?? ['aegis', 'ward']
  const gatedTools = config.gatedTools ?? ['experiment_log_run', 'experiment_log_metrics']
  for (const tool of [...debateTools, ...gatedTools]) {
    if (typeof tool !== 'string' || tool.trim().length === 0) {
      throw new TypeError('research-protocol: debateTools and gatedTools must hold non-empty tool names')
    }
  }
  const requireDesignDefense = validateDefenseMode(config.requireDesignDefense as string)
  return {
    enabled: config.enabled === true,
    requireDesignDefense,
    debateTools,
    gatedTools,
  }
}

/**
 * Validate one defense-mode value straight from raw config.
 * @param value - the raw value.
 * @returns the validated mode.
 */
function validateDefenseMode(value: string): 'per-epoch' | 'off' {
  // Direct apply callers bypass Loader schema defaulting; an omitted mode is
  // a misconfiguration, not a silent default.
  if (value !== 'per-epoch' && value !== 'off') {
    throw new TypeError("research-protocol: requireDesignDefense must be 'per-epoch' or 'off'")
  }
  return value
}

/**
 * Current Goal epoch anchor: the open card's `goalOpenedSeq` when the jspace
 * seat is mounted, active, and holding a card; session start (0) otherwise.
 * @param ctx - Cordis context; jspace is optional.
 * @param session - session the gated call executes in.
 * @returns the inclusive anchor seq.
 */
function epochAnchor(ctx: Context, session: Session): number {
  const jspace = ctx.get('jspace')
  if (jspace === undefined || !jspace.status.active) return 0
  const card = jspace.card(session)
  return card?.goalOpenedSeq ?? 0
}

/**
 * Mount the protocol. The section and the gate are registered once and read
 * the live settings value on every request, matching the jspace consumers:
 * a flip changes behavior on the next request without a remount.
 * @param ctx - Cordis context with the system-prompt service.
 * @param config - plugin config, also the composition base for the namespace.
 */
export function apply(ctx: Context, config: Config = {}): void {
  let current = resolveConfig(config)
  let source: () => Config = () => config
  installSettingsSection(ctx, AUTORESEARCH_SETTINGS_NAMESPACE, Config, config, {
    setSource: (next) => {
      source = next
    },
    onChange: () => {
      current = resolveConfig(source())
    },
  })
  current = resolveConfig(source())
  ctx.systemPrompt.section({
    name: RESEARCH_PROTOCOL_SECTION_NAME,
    order: RESEARCH_PROTOCOL_SECTION_ORDER,
    text: (context) => {
      if (!current.enabled) return ''
      const session = context.agent?.session
      const jspace = ctx.get('jspace')
      const cardOpen = jspace !== undefined && jspace.status.active
        && session !== undefined && jspace.card(session) !== null
      const lines = [RESEARCH_PROTOCOL_SECTION_TEXT]
      if (cardOpen) lines.push(RESEARCH_PROTOCOL_CARD_LINE)
      return lines.join('\n')
    },
  })
  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
    if (!current.enabled) return next()
    if (current.requireDesignDefense === 'off') return next()
    if (!current.gatedTools.includes(exec.name)) return next()
    const session = exec.agent?.session
    if (session === undefined) return next()
    const missing = missingDebateTools(session.events, current.debateTools, epochAnchor(ctx, session))
    if (missing.length === 0) return next()
    return Promise.resolve({ kind: 'deny' as const, reason: designDefenseDeny(missing) })
  }), 'research-protocol: design defense')
}
