/**
 * Judgment engine fixtures typed against the `judgmentEngines` Remote: a
 * local and a remote engine, and snapshots selecting either.
 */
import type {
  JudgmentConsumerId, JudgmentEngineId, JudgmentEngineView, JudgmentEnginesSnapshot,
} from '@shres-code/shres-code-api-remotes/client'

/** A local engine on this machine. */
export const LOCAL: JudgmentEngineView = {
  id: 'laya' as JudgmentEngineId,
  label: 'Laya (local, MLX)',
  egress: 'local',
  calibration: 'verbalized',
  supportsFitting: true,
  host: 'darwin-arm64',
  runsOnThisHost: true,
  state: 'ready',
}

/** A remote engine that sends state to its host. */
export const REMOTE: JudgmentEngineView = {
  id: 'typesafe' as JudgmentEngineId,
  label: 'Jev (TypeSafe)',
  egress: 'remote',
  calibration: 'calibrated',
  supportsFitting: false,
  host: 'any',
  runsOnThisHost: true,
  destination: 'api.typesafe.ai',
  state: 'ready',
}

/**
 * A snapshot selecting one engine.
 * @param engine - the selected engine id.
 * @param overrides - the snapshot fields to replace.
 * @returns the snapshot.
 */
export function engines(engine: string, overrides: Partial<JudgmentEnginesSnapshot> = {}): JudgmentEnginesSnapshot {
  return {
    engines: [LOCAL, REMOTE],
    selection: { enabled: true, engine, overrides: {} },
    consumers: [] as JudgmentConsumerId[],
    thisHost: 'darwin-arm64',
    ...overrides,
  }
}
