/** Named failures for Agent Team journal and fold operations. */

import { HarnessError } from '@shres-code/shres-code-llm'

/** Stable machine-routable classifications for Agent Team substrate failures. */
export type TeamErrorCode =
  | 'TEAM_PERSISTENCE_FAILED'
  | 'TEAM_INVALID_CONFIG'
  | 'TEAM_DISPOSED'
  | 'TEAM_DISPOSAL_TIMEOUT'
  | 'TEAM_NOT_MEMBER'
  | 'TEAM_LEAD_REQUIRED'
  | 'TEAM_MEMBER_NOT_FOUND'
  | 'TEAM_SELF_MESSAGE'
  | 'TEAM_MAILBOX_FULL'
  | 'TEAM_MESSAGE_TOO_LARGE'
  | 'TEAM_MEMBER_NAME_TAKEN'
  | 'TEAM_MEMBER_LIMIT'
  | 'TEAM_INVALID_MEMBER_NAME'
  | 'TEAM_INVALID_TARGET'
  | 'TEAM_PROVISIONING_CONFLICT'
  | 'TEAM_RESERVED_NAME'
  | 'TEAM_INVALID_ARGUMENT'

/** Error returned by the Agent Team domain boundary. */
export class TeamError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: TeamErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/**
 * Render an unknown rejection as a string for contained logs.
 * @param error - thrown value.
 * @returns the Error message when present, otherwise `String(error)`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
