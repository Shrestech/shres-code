/**
 * Per-route CLI settings for delegated completion.
 * @module @shres-code/shres-code-llm-cli-bridge/config
 */

import z from '@shres-code/schemastery'
import { ReasoningEffortId } from '@shres-code/shres-code-llm'
import type { LlmReasoningEffortInfo } from '@shres-code/shres-code-llm'

/** How a route turns `GenerateOptions.reasoningEffort` into argv. */
export type EffortStyle = 'flag' | 'thinking-bool' | 'codex-config'

/** Conservative context capacity advertised when a route omits one. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Conservative per-request output cap advertised when a route omits one. */
export const DEFAULT_MAX_TOKENS = 8_192

/** In-memory stdout cap for one CLI JSON / stream-json transcript. */
export const STDOUT_COLLECT_MAX_BYTES = 8_000_000

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** One advisory model listed for a CLI route. */
export interface CliBridgeModel {
  /** Model id passed to {@link import('@shres-code/shres-code-llm').GenerateOptions.model}. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
}

/** One CLI route the adapter can register. */
export interface CliBridgeRoute {
  /** Human-readable route name for selectors. */
  displayName: string
  /** Executable name or absolute path. */
  binary: string
  /** Flag that receives `GenerateOptions.model` (for example `--model`). */
  modelArg: string
  /**
   * Flag that receives `GenerateOptions.reasoningEffort` when
   * {@link effortStyle} is `flag`.
   */
  effortArg?: string
  /** How this CLI spells reasoning effort on argv. */
  effortStyle: EffortStyle
  /** Efforts this CLI accepts, in display order. */
  efforts: string[]
  /** Extra argv inserted before the prompt (output format, yolo, …). */
  extraArgs: string[]
  /** Where the serialized prompt is placed. */
  promptStyle: 'flag' | 'trailing'
  /** Prompt flag when {@link promptStyle} is `flag` (for example `-p`). */
  promptArg?: string
  /** How to parse collected stdout. */
  parseMode: 'json' | 'stream-json'
  /** Explicit child env layered after the subprocess scrub. */
  env: Record<string, string>
  /**
   * Credential reference (and child env var name) resolved through the
   * credentials seam. The secret is never stored in this section.
   */
  apiKeyEnv?: string
  /**
   * When true, a non-empty `GenerateOptions.tools` is allowed because the
   * CLI will run its own tools. When false, that request throws
   * `UNSUPPORTED_OPTION`.
   */
  allowDelegatedTools: boolean
  /** Conservative combined context capacity. */
  contextWindow: number
  /** Conservative per-request output cap. */
  defaultMaxTokens: number
  /** Advisory models shown by discovery consumers. */
  models: CliBridgeModel[]
  /** When false, this route is omitted from the live adapter registry. Defaults to on. */
  enabled?: boolean
}

/** Plugin / settings section: a dict of named routes. */
export interface Config {
  /** Named CLI routes this adapter registers. */
  routes?: Record<string, Partial<CliBridgeRoute> & {
    /** Human-readable route name shown in model pickers. */
    displayName?: string
    /** Executable name override resolved for this route. */
    binary?: string
  }>
  /** Grace in milliseconds for CLI process-tree termination. */
  disposeGraceMs?: number
}

const routeSchema = z.object({
  displayName: z.string(),
  binary: z.string(),
  modelArg: z.string(),
  effortArg: z.string(),
  effortStyle: z.union(['flag', 'thinking-bool', 'codex-config']),
  efforts: z.array(z.string()).default(undefined as unknown as string[]),
  extraArgs: z.array(z.string()).default(undefined as unknown as string[]),
  promptStyle: z.union(['flag', 'trailing']),
  promptArg: z.string(),
  parseMode: z.union(['json', 'stream-json']),
  env: z.dict(z.string().role('secret')).default(undefined as unknown as Record<string, string>),
  apiKeyEnv: z.string().role('credential-ref'),
  allowDelegatedTools: z.boolean(),
  contextWindow: z.number().step(1).min(1),
  defaultMaxTokens: z.number().step(1).min(1),
  models: z.array(z.object({ id: z.string().required(), name: z.string() }))
    .default(undefined as unknown as { id: string; name: string }[]),
  enabled: z.boolean().default(true),
})

export const Config = z.object({
  routes: z.dict(routeSchema),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

/**
 * Shipped route ids: none — delegated completion for the shipped CLIs was
 * retired in favor of the subscription-session routes (`codex-session`,
 * `grok-session`, `cursor-session`); this adapter serves hand-declared
 * overlay routes only.
 */
export const SHIPPED_ROUTE_IDS = [] as const

/** One shipped route id. */
export type ShippedRouteId = never

/**
 * Blank template for a hand-declared extra route. Overlays must opt into
 * yolo flags and `allowDelegatedTools`.
 */
export const CUSTOM_ROUTE_TEMPLATE: CliBridgeRoute = {
  displayName: '',
  binary: '',
  modelArg: '--model',
  effortStyle: 'flag',
  efforts: [],
  extraArgs: [],
  promptStyle: 'flag',
  promptArg: '-p',
  parseMode: 'json',
  env: {},
  allowDelegatedTools: false,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  models: [],
}


/**
 * Merge shipped defaults with a settings/composition overlay.
 * @param overlay - partial routes from config or settings.
 * @returns fully resolved routes keyed by provider id.
 */
export function resolveRoutes(
  overlay: Config['routes'],
): ReadonlyMap<string, CliBridgeRoute> {
  const resolved = new Map<string, CliBridgeRoute>()
  if (overlay !== undefined) {
    for (const [id, partial] of Object.entries(overlay)) {
      if (resolved.has(id)) continue
      if (partial.binary === undefined || partial.displayName === undefined) {
        throw new Error(`llm-cli-bridge: route "${id}" needs displayName and binary`)
      }
      resolved.set(id, mergeRoute({
        ...CUSTOM_ROUTE_TEMPLATE,
        displayName: partial.displayName,
        binary: partial.binary,
      }, partial))
    }
  }
  return resolved
}

function mergeRoute(base: CliBridgeRoute, overlay: Partial<CliBridgeRoute> | undefined): CliBridgeRoute {
  if (overlay === undefined) {
    return {
      ...base,
      env: { ...base.env },
      extraArgs: [...base.extraArgs],
      efforts: [...base.efforts],
      models: [...base.models],
      enabled: base.enabled ?? true,
    }
  }
  const extraArgs = overlay.extraArgs ?? base.extraArgs
  const efforts = overlay.efforts ?? base.efforts
  const models = overlay.models ?? base.models
  const env = overlay.env ?? base.env
  if (efforts.some(effort => effort.length === 0)) {
    throw new Error('llm-cli-bridge: effort ids must be non-empty')
  }
  if (models.some(model => model.id.length === 0)) {
    throw new Error('llm-cli-bridge: model ids must be non-empty')
  }
  return {
    displayName: overlay.displayName ?? base.displayName,
    binary: overlay.binary ?? base.binary,
    modelArg: overlay.modelArg ?? base.modelArg,
    ...((overlay.effortArg ?? base.effortArg) === undefined
      ? {}
      : { effortArg: overlay.effortArg ?? base.effortArg }),
    effortStyle: overlay.effortStyle ?? base.effortStyle,
    efforts: [...efforts],
    extraArgs: [...extraArgs],
    promptStyle: overlay.promptStyle ?? base.promptStyle,
    ...((overlay.promptArg ?? base.promptArg) === undefined
      ? {}
      : { promptArg: overlay.promptArg ?? base.promptArg }),
    parseMode: overlay.parseMode ?? base.parseMode,
    env: { ...env },
    ...((overlay.apiKeyEnv ?? base.apiKeyEnv) === undefined
      ? {}
      : { apiKeyEnv: overlay.apiKeyEnv ?? base.apiKeyEnv }),
    allowDelegatedTools: overlay.allowDelegatedTools ?? base.allowDelegatedTools,
    contextWindow: overlay.contextWindow ?? base.contextWindow,
    defaultMaxTokens: overlay.defaultMaxTokens ?? base.defaultMaxTokens,
    models: models.map(model => ({ id: model.id, ...model.name === undefined ? {} : { name: model.name } })),
    enabled: overlay.enabled ?? base.enabled ?? true,
  }
}

/**
 * Convert advertised effort ids into adapter metadata.
 * @param efforts - opaque ids in display order.
 * @returns reasoning metadata for `resolveModel()`.
 */
export function effortInfo(efforts: readonly string[]): readonly LlmReasoningEffortInfo[] {
  return efforts.map(id => ({
    id: ReasoningEffortId(id),
    name: id,
  }))
}
