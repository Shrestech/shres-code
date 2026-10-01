/** Engine-view, Laya, and settings fixtures shaped like the Host's real answers. */

import { vi } from 'vitest'
import type {
  JudgmentEnginesSnapshot,
  JudgmentEngineView,
  LayaGatewayView,
  SettingsNamespaceView,
} from '@shres-code/shres-code-api-remotes/client'
import type { ModelRoutingRemotes, RemoteOutcome } from '../src/client/model.ts'
import type { ModelProviderGroup } from '@shres-code/shres-code-api-remotes/client'
import type { ModelRoutingGateView, ModelRoutingPoolStatus } from '@shres-code/shres-code-model-router/client'

/** TypeSafe as judgment-typesafe registers it with the vendor defaults. */
export const TYPESAFE: JudgmentEngineView = {
  id: 'typesafe' as JudgmentEngineView['id'],
  label: 'Jev (TypeSafe)',
  egress: 'remote',
  calibration: 'calibrated',
  supportsFitting: false,
  host: 'any',
  runsOnThisHost: true,
  terms: 'https://typesafe.ai/legal/terms',
  models: { fast: 'jev-1.13.0-fast', accurate: 'jev-1.13.0' },
  destination: 'api.typesafe.ai',
  state: 'ready',
}

/** Laya as judgment-laya registers it with the pinned checkpoint. */
export const LAYA: JudgmentEngineView = {
  id: 'laya' as JudgmentEngineView['id'],
  label: 'Laya (local MLX)',
  egress: 'none',
  calibration: 'calibrated',
  supportsFitting: true,
  host: 'darwin-arm64',
  runsOnThisHost: true,
  models: {
    fast: 'convaiinnovations/laya-typed-decisions@f9ab0b228f0fc0f14d873dbc99038f135c2da1b2',
    accurate: 'convaiinnovations/laya-typed-decisions@f9ab0b228f0fc0f14d873dbc99038f135c2da1b2',
  },
  state: 'not-installed',
  detail: 'Laya is not installed; run /laya install',
}

/** The Laya gateway view before an install. */
export const LAYA_VIEW: LayaGatewayView = {
  state: 'not-installed',
  detail: 'Laya is not installed; run /laya install',
  modelId: 'convaiinnovations/laya-typed-decisions@f9ab0b228f0fc0f14d873dbc99038f135c2da1b2',
  checkpointContext: 1024,
  dtype: 'float16',
  installing: false,
}

/** Selection and consumer facts beyond the engines and the selected id. */
export interface SnapshotExtras {
  readonly enabled?: boolean
  readonly overrides?: Record<string, string>
  readonly consumers?: string[]
}

/**
 * An engine snapshot. The router's consumer is declared unless the extras list others.
 * @param engines - the registered engines.
 * @param engine - the selected id.
 * @param extras - classifier switch, overrides, and declared consumers.
 * @returns the snapshot as the Remote returns it.
 */
export function snapshot(engines: JudgmentEngineView[] = [TYPESAFE, LAYA], engine = 'typesafe', extras: SnapshotExtras = {}): JudgmentEnginesSnapshot {
  return {
    engines,
    selection: { enabled: extras.enabled ?? true, engine, overrides: extras.overrides ?? {} },
    consumers: (extras.consumers ?? ['model-router']) as unknown as JudgmentEnginesSnapshot['consumers'],
    thisHost: 'darwin-arm64',
  }
}

/**
 * One settings namespace view.
 * @param ns - namespace.
 * @param value - resolved value.
 * @param revision - section revision.
 * @returns the view.
 */
export function namespace(ns: string, value: unknown, revision = 3): SettingsNamespaceView {
  return { ns, schema: {}, value, applies: 'live', secrets: [], revision }
}

/** The shipped model-router section, routing off by default. */
export const ROUTER = namespace('model-router', { initialMode: 'off', state: { maxChars: 12000, maxFitCandidates: 4 } }, 7)
/** A router section whose schema declares childPolicies (13b capability). */
export const ROUTER_CHILD = { ...ROUTER, schema: { childPolicies: {} } }
/** The judgment section selecting TypeSafe. */
export const JUDGMENT = namespace('judgment', { enabled: true, engine: 'typesafe' }, 4)

let rpc = 0

/**
 * A successful RPC response.
 * @param value - the result value.
 * @returns the response envelope.
 */
export function ok<T>(value: T): { rpcId: never; result: { ok: true; value: T } } {
  rpc += 1
  return { rpcId: `r${rpc}` as never, result: { ok: true, value } }
}

/**
 * A successful Remote settlement.
 * @param value - the value.
 * @returns the settlement.
 */
export function remoteOk<T>(value: T): RemoteOutcome<T> {
  return { ok: true, value }
}

/**
 * A failed Remote settlement.
 * @param code - failure code.
 * @param message - failure text.
 * @returns the settlement.
 */
export function remoteFail<T>(code: string, message: string): RemoteOutcome<T> {
  return { ok: false, error: { code, message } }
}

/** The router's gate as it reports the TypeSafe and Laya engines with no operating point. */
export const GATE: ModelRoutingGateView = {
  downgradeThreshold: 0.8,
  downgradeMargin: 0.1,
  operatingPoints: [],
  engines: [
    { engine: 'typesafe', calibration: { kind: 'global' } },
    { engine: 'laya', calibration: { kind: 'global' } },
  ],
  judgmentDeadlineMs: 1500,
  entryScoreCeiling: 2,
  escalateBackScoreThreshold: 3,
  difficultyLevels: ['trivial', 'easy', 'moderate', 'hard', 'expert'],
  hold: { minSteps: 20, maxSteps: 40 },
  stateMaxChars: 12000,
}

const OPUS = { provider: 'claude-session', model: 'claude-opus-5-5' }
const FLASH = { provider: 'ollama-cloud', model: 'deepseek-v4.1-flash:cloud' }
const GLM = { provider: 'zai', model: 'glm-5.3' }

/** The live pool: Flash eligible from Opus, GLM too small a context and reporting no cache counts. */
export const POOL: ModelRoutingPoolStatus = {
  routeFrom: [{ ...OPUS, objective: 'quota', allowEveryTurn: true, registered: true, contextWindow: 1_000_000 }],
  candidates: [
    {
      id: 'flash', ...FLASH, description: 'small, well-scoped edits in familiar code', registered: true,
      contextWindow: 1_000_000, efforts: ['low', 'high'], cacheUsage: 'reported', alsoRouteFrom: false,
      eligibility: [{ ...OPUS, reason: 'eligible' }],
    },
    {
      id: 'glm', ...GLM, description: 'routine code edits', registered: true,
      contextWindow: 200_000, cacheUsage: 'unreported', alsoRouteFrom: false,
      eligibility: [{ ...OPUS, reason: 'context-too-small' }],
    },
  ],
}

/** The model-router section matching {@link POOL}. */
export const POOL_ROUTER = namespace('model-router', {
  initialMode: 'off',
  state: { maxChars: 12000, maxFitCandidates: 4 },
  candidates: [
    { id: 'flash', ...FLASH, description: 'small, well-scoped edits in familiar code' },
    { id: 'glm', ...GLM, description: 'routine code edits' },
  ],
  routeFrom: [{ ...OPUS, objective: 'quota', allowEveryTurn: true }],
}, 9)

/** The model catalog, as `llm.models` groups it. */
export const MODELS: ModelProviderGroup[] = [
  { id: 'claude-session', name: 'Claude', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] },
  {
    id: 'ollama-cloud', name: 'Ollama Cloud', models: [
      {
        id: 'deepseek-v4.1-flash:cloud', name: 'DeepSeek V4.1 Flash',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
      },
      { id: 'kimi-k3:cloud', name: 'Kimi K3' },
    ],
  },
  { id: 'zai', name: 'Z.ai', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
]

/** Scripted settings face and Remote methods. */
export function scripted(
  initial: { engines?: JudgmentEnginesSnapshot; namespaces?: SettingsNamespaceView[]; models?: ModelProviderGroup[] } = {},
) {
  const namespaces = initial.namespaces ?? [JUDGMENT, ROUTER]
  const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: true, namespaces })))
  const mutate = vi.fn((_request: { ns: string; ops: unknown[]; expectedRevision?: number }) => Promise.resolve(ok(JUDGMENT)))
  const remotes = {
    snapshot: vi.fn<ModelRoutingRemotes['snapshot']>(() => Promise.resolve(remoteOk(initial.engines ?? snapshot()))),
    layaStatus: vi.fn<ModelRoutingRemotes['layaStatus']>(() => Promise.resolve(remoteOk(LAYA_VIEW))),
    layaInstall: vi.fn<ModelRoutingRemotes['layaInstall']>(() => Promise.resolve(remoteOk({ modelDir: '/m', manifestSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64) }))),
    layaRestart: vi.fn<ModelRoutingRemotes['layaRestart']>(() => Promise.resolve(remoteOk({ ...LAYA_VIEW, state: 'starting' as const }))),
    gate: vi.fn<ModelRoutingRemotes['gate']>(() => Promise.resolve(remoteOk(GATE))),
    poolStatus: vi.fn<ModelRoutingRemotes['poolStatus']>(() => Promise.resolve(remoteOk(POOL))),
  }
  const models = vi.fn((_request: object) => Promise.resolve(ok({ groups: initial.models ?? MODELS, failures: [] })))
  return { api: { settings: { describe, mutate }, llm: { models } } as never, describe, mutate, models, remotes }
}
