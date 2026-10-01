/**
 * Type surface of the TypeSafe judgment engine: the composition config and the
 * two model ids a tier resolves to. Types only — the schema, the request
 * mapping, the response validation, and the engine live in their own modules.
 *
 * @module @shres-code/shres-code-judgment-typesafe/types
 */

/** Model id each judgment tier resolves to. */
export interface TypesafeJudgmentModels {
  /** Model serving the `fast` tier. */
  fast: string
  /** Model serving the `accurate` tier, and every ask that omits a tier. */
  accurate: string
}

/**
 * Bounded transient-failure retry for one ask.
 *
 * The vendor's documented transient responses are the rate-limit 429 and the
 * overloaded 529; its 401 and 422 are deterministic refusals that a repeat
 * cannot change, so they are not retried unless a deployment names them here.
 */
export interface TypesafeJudgmentRetry {
  /**
   * Retries allowed after the first request, defaulting to 1. `0` disables
   * retry and leaves every refusal to the caller, which is how the engine
   * behaved before this field existed.
   */
  maxRetries?: number
  /**
   * Fixed delay before each retry in milliseconds, defaulting to 300. `0`
   * retries on the next timer turn. The ask's `timeoutMs` deadline stays armed
   * through the wait, so a wait that outlives it fails as a timeout.
   */
  delayMs?: number
  /**
   * HTTP statuses eligible for retry, defaulting to the vendor's documented
   * transient 429 and 529. A status this list omits fails on its first
   * response, and the list must not be empty while `maxRetries` is positive.
   */
  statuses?: number[]
}

/**
 * Composition config of the TypeSafe judgment engine.
 *
 * Schemastery rejects a wrong type at plugin load; {@link resolveConfig} from
 * `./config.ts` re-judges every field, including unknown and misspelled keys,
 * because programmatic construction bypasses the schema.
 */
export interface TypesafeJudgmentConfig {
  /**
   * Credential reference (environment-variable name) holding the API key.
   * Required with no default: which environment reference holds the key is the
   * deployment's decision, and the reference is resolved per ask through the
   * credentials seam.
   */
  apiKeyRef: string
  /** Vendor endpoint base without a trailing slash; defaults to the public API. */
  endpoint?: string
  /** Model id per judgment tier; defaults to `jev-preview` and `jev-latest`. */
  models?: TypesafeJudgmentModels
  /**
   * Deadline for one vendor request in milliseconds, defaulting to 30000. An
   * ask that outlives it fails with `UNAVAILABLE` naming the figure. The
   * deadline is armed once per ask, so it also bounds a retry and its wait.
   */
  timeoutMs?: number
  /** Bounded transient-failure retry; omitted takes every default in {@link TypesafeJudgmentRetry}. */
  retry?: TypesafeJudgmentRetry
}
