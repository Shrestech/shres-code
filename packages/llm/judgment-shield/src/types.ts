/**
 * Composition types for the local Shield judgment gateway.
 *
 * @module @shres-code/shres-code-judgment-shield/types
 */

/** The two pinned model artifacts a judgment tier resolves to. */
export interface ShieldJudgmentModels {
  /** Artifact serving the explicit `fast` tier. */
  fast: string
  /** Artifact serving `accurate` and asks that omit a tier. */
  accurate: string
}

/** Configuration for the loopback-only typed-judgment gateway. */
export interface ShieldJudgmentConfig {
  /** Loopback HTTP(S) endpoint hosting `/v1/judgments`. */
  endpoint: string
  /** Explicit artifact id for each judgment tier. */
  models: ShieldJudgmentModels
  /** Maximum time spent waiting for the gateway response, in milliseconds. */
  timeoutMs?: number
  /** Maximum UTF-8 response body size accepted from the gateway. */
  maxResponseBytes?: number
  /** Maximum complete serialized UTF-8 request body size; align with the gateway's body limit. */
  maxRequestBytes?: number
  /** Interval between readiness probes (a TCP connection to the endpoint), in milliseconds. */
  readinessIntervalMs?: number
}
