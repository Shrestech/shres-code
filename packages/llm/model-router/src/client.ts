/**
 * Client-namespace projection of the model-routing domain: a pure re-export of
 * the package's types outlet. Client code imports ONLY the client namespace
 * (repo discipline), so `./client` serves the same single-source content
 * `./types` serves to host consumers — zero duplication.
 *
 * @module @shres-code/shres-code-model-router/client
 */

export type * from './types.ts'
