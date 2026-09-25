/**
 * JSON views of the judgment engine registry and the `judgment` selection,
 * served by the `judgmentEngines` Remote. Types only, safe for Client builds.
 *
 * @module @shres-code/shres-code-judgment-dispatch/types
 */

import type {
  JudgmentConsumerId,
  JudgmentEngineCalibration,
  JudgmentEngineEgress,
  JudgmentEngineHost,
  JudgmentEngineId,
  JudgmentEngineState,
} from '@shres-code/shres-code-judgment/types'

/** Per-tier model or pinned artifact ids of one engine. */
export interface JudgmentEngineModelsView {
  readonly fast: string
  readonly accurate: string
}

/** One registered engine: its descriptor facts and its current status. */
export interface JudgmentEngineView {
  readonly id: JudgmentEngineId
  readonly label: string
  /** Where the engine sends the state it judges. */
  readonly egress: JudgmentEngineEgress
  readonly calibration: JudgmentEngineCalibration
  readonly supportsFitting: boolean
  /** Host the engine requires; `any` when its descriptor names none. */
  readonly host: JudgmentEngineHost
  /** Whether {@link host} admits this machine; a write selecting an engine that does not is rejected. */
  readonly runsOnThisHost: boolean
  /** URL of the terms that govern a remote engine's use. */
  readonly terms?: string
  /** Per-tier model ids, when the provider names them. */
  readonly models?: JudgmentEngineModelsView
  /** Host the engine sends state to, when the provider names one. */
  readonly destination?: string
  /** Current lifecycle state; only `ready` answers asks. */
  readonly state: JudgmentEngineState
  /** Diagnostic explaining a state other than `ready`. */
  readonly detail?: string
}

/** The resolved `judgment` settings section. */
export interface JudgmentSelectionView {
  /** Whether judgment is available to consumers. */
  readonly enabled: boolean
  /** Registry id of the deployment-wide engine. */
  readonly engine: string
  /** Per-consumer engine ids, keyed by consumer id. */
  readonly overrides: Readonly<Record<string, string>>
}

/** Point-in-time view returned by `judgmentEngines.snapshot`. */
export interface JudgmentEnginesSnapshot {
  /** Registered engines, in registration order. */
  readonly engines: readonly JudgmentEngineView[]
  readonly selection: JudgmentSelectionView
  /** Consumer ids currently declared, which an override may name. */
  readonly consumers: readonly JudgmentConsumerId[]
  /** This machine's platform-architecture pair, such as `darwin-arm64`. */
  readonly thisHost: string
}
