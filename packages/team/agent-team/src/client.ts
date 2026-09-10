/**
 * Client-namespace projection of the Agent Team domain: a pure re-export of
 * the package's types outlet. Client code imports ONLY the client namespace,
 * so `./client` projects the same single-source content `./types` serves to
 * host consumers.
 *
 * @module @shres-code/shres-code-agent-team/client
 */

export type * from './types.ts'
export { TeamId, TeamMessageId, TeamTaskId } from './brand.ts'
