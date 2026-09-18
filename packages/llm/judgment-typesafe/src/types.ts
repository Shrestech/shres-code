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
   * ask that outlives it fails with `UNAVAILABLE` naming the figure.
   */
  timeoutMs?: number
}
