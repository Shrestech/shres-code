/**
 * Typed failures for the remote-control package. Every caller-valuable
 * condition carries a stable {@link RemoteControlErrorCode} so CLI and host
 * consumers render one decision instead of string-matching messages.
 * @module @shres-code/shres-code-host-remote-control
 */

import type { RemoteControlErrorCode } from './types.ts'

/** Typed failure carrying a stable machine-readable code. */
export class RemoteControlError extends Error {
  /** Stable code for consumer dispatch; never suffixed or localized. */
  readonly code: RemoteControlErrorCode
  /** Machine-readable facts for outcome mapping; absent when the message alone suffices. */
  readonly facts: Readonly<Record<string, string | null>>

  /**
   * @param code - stable machine-readable failure code.
   * @param message - human-readable failure description.
   * @param facts - structured values (an observed version, a fingerprint) the
   *   caller folds into a discriminated outcome instead of parsing the message.
   */
  constructor(code: RemoteControlErrorCode, message: string, facts: Readonly<Record<string, string | null>> = {}) {
    super(message)
    this.name = 'RemoteControlError'
    this.code = code
    this.facts = facts
  }
}
