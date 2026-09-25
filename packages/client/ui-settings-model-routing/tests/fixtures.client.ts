/** Engine-view, Laya, and settings fixtures shaped like the Host's real answers. */

import { vi } from 'vitest'
import type {
  JudgmentEnginesSnapshot,
  JudgmentEngineView,
  LayaGatewayView,
  SettingsNamespaceView,
} from '@shres-code/shres-code-api-remotes/client'
import type { ModelRoutingRemotes, RemoteOutcome } from '../src/client/model.ts'

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

/**
 * An engine snapshot.
 * @param engines - the registered engines.
 * @param engine - the selected id.
 * @returns the snapshot as the Remote returns it.
 */
export function snapshot(engines: JudgmentEngineView[] = [TYPESAFE, LAYA], engine = 'typesafe'): JudgmentEnginesSnapshot {
  return {
    engines,
    selection: { enabled: true, engine, overrides: {} },
    consumers: [],
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
export const ROUTER = namespace('model-router', { initialMode: 'off', state: { maxChars: 12000 } }, 7)
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

/** Scripted settings face and Remote methods. */
export function scripted(initial: { engines?: JudgmentEnginesSnapshot; namespaces?: SettingsNamespaceView[] } = {}) {
  const namespaces = initial.namespaces ?? [JUDGMENT, ROUTER]
  const describe = vi.fn(() => Promise.resolve(ok({ writable: true, hasDocument: true, namespaces })))
  const mutate = vi.fn((_request: { ns: string; ops: unknown[]; expectedRevision?: number }) => Promise.resolve(ok(JUDGMENT)))
  const remotes = {
    snapshot: vi.fn<ModelRoutingRemotes['snapshot']>(() => Promise.resolve(remoteOk(initial.engines ?? snapshot()))),
    layaStatus: vi.fn<ModelRoutingRemotes['layaStatus']>(() => Promise.resolve(remoteOk(LAYA_VIEW))),
    layaInstall: vi.fn<ModelRoutingRemotes['layaInstall']>(() => Promise.resolve(remoteOk({ modelDir: '/m', manifestSha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64) }))),
    layaRestart: vi.fn<ModelRoutingRemotes['layaRestart']>(() => Promise.resolve(remoteOk({ ...LAYA_VIEW, state: 'starting' as const }))),
  }
  return { api: { settings: { describe, mutate } } as never, describe, mutate, remotes }
}
