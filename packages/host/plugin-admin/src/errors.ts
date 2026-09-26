/**
 * Typed caller-misuse failures of the pluginAdmin namespace. They cross the
 * wire as the carrier's generic message envelope; the code is for host-side
 * branching and tests, not a wire field.
 * @module @shres-code/shres-code-host-plugin-admin
 */

/** Error codes thrown by the pluginAdmin gateway for caller misuse. */
export type PluginAdminErrorCode =
  | 'gesture-refused'
  | 'invalid-target'
  | 'transaction-pending'
  | 'no-parked-transaction'
  | 'confirm-mismatch'

/**
 * Caller misuse of the pluginAdmin namespace: a missing, spent, wrong-scope,
 * or expired gesture, a relative local install spec, or a transaction-slot
 * conflict.
 */
export class PluginAdminError extends Error {
  /** Why the call was refused. */
  readonly code: PluginAdminErrorCode

  /**
   * @param code - why the call was refused.
   * @param message - human-readable refusal, rendered by the client as the wire error message.
   */
  constructor(code: PluginAdminErrorCode, message: string) {
    super(message)
    this.name = 'PluginAdminError'
    this.code = code
  }
}
