/**
 * Composer image-input capability: how a plugin the composer cannot import
 * says whether a session's current model accepts images.
 *
 * The dependency runs one way — ui-model-selection knows the routed model's
 * declared modalities, ui-conversation owns image intake, never back — so the
 * fact is pushed here, exactly like the composer blocks, and the bar's intake
 * reads its own session's entry. Tri-state by design: `undefined` is "no
 * declaration to read" (nothing loaded yet, or the route never stated its
 * modalities) and must stay admissible, the same reading the Host's own
 * admission gives absence; only a definite `false` refuses, with the
 * composer's own copy.
 *
 * This is an affordance, not enforcement: the Host refuses an image prompt
 * the route cannot serve regardless of what any client pre-checks.
 */

import type { SessionId } from '@shres-code/shres-code-client-runtime/client'

/** The image-input face other plugins reach through `ctx.conversation.imageInput`. */
export interface ComposerImageInput {
  /**
   * Declare or clear one session's image-input capability. Idempotent:
   * restating the current value notifies nobody.
   * @param sessionId - the session whose current model is described.
   * @param accepts - whether the model declares image input, or `undefined`
   * when nothing is declared (the admissible state).
   */
  set(sessionId: SessionId, accepts: boolean | undefined): void
  /**
   * Point-in-time read for the intake path. Intake is an action, not a
   * subscription: the answer is needed at the gesture, so no store is kept.
   * @param sessionId - the session to read.
   * @returns the declared capability, or `undefined` when none is known.
   */
  accepts(sessionId: SessionId): boolean | undefined
}

/** The per-session image-input registry (one instance per plugin fiber). */
export class ComposerImageInputRegistry implements ComposerImageInput {
  private readonly declared = new Map<SessionId, boolean>()

  /** @inheritdoc */
  set(sessionId: SessionId, accepts: boolean | undefined): void {
    if (accepts === undefined) this.declared.delete(sessionId)
    else this.declared.set(sessionId, accepts)
  }

  /** @inheritdoc */
  accepts(sessionId: SessionId): boolean | undefined {
    return this.declared.get(sessionId)
  }
}
