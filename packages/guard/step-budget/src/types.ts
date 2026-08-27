/**
 * Durable vocabulary owned by the step-budget guard.
 * @module @shres-code/shres-code-step-budget/types
 */

/** The turn coordinates and budget that produced one step-budget stop. */
export interface StepBudgetExhausted {
  /** Turn the guard ended. */
  turn: number
  /** Step the guard refused to enter — always `limit + 1`. */
  step: number
  /** Configured `maxStepsPerTurn` in force when the guard fired. */
  limit: number
}

declare module '@shres-code/shres-code-session/types' {
  interface SessionEventMap {
    /**
     * The step budget refused to enter another model step, ending the turn.
     * Log-only, appended immediately before the loop's `turn/end`
     * (`{ kind: 'blocked' }`) for the same `turn`. Writers pass
     * `{ ignorable: true }`, so a build without this guard still reads the log.
     * The model-facing explanation travels separately as the guard's injected
     * notice, not in this payload.
     * @param turn - turn the guard ended.
     * @param step - step the guard refused to enter.
     * @param limit - configured `maxStepsPerTurn` in force.
     */
    'step-budget/exhausted': StepBudgetExhausted
  }
}
