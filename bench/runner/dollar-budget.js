/**
 * The experiment-wide `--max-dollars` cap. Settled trials add their counted
 * spend (`trialSpend`: upper-bound dollars of model calls and judge usage);
 * before each launch the budget projects every in-flight trial and the new
 * one at the largest settled trial's spend, and refuses the launch once the
 * cap would be exceeded. Trials in flight are never killed: the cap bounds
 * what the runner starts, and the per-trial `--max-total-tokens` watcher
 * bounds one trial.
 *
 * @module bench/runner/dollar-budget
 */

import { trialSpend } from './accounting.js'

/**
 * @typedef {object} DollarBudget
 * @property {(accounting: import('./accounting.js').TrialAccounting) => void} settle - add one settled trial.
 * @property {(inFlight: number) => boolean} admits - whether a launch fits; the first refusal records {@link DollarBudget.stop}.
 * @property {() => import('../schema/run-manifest.js').BudgetStop | null} stop - the recorded stop, once refused.
 * @property {() => number} unpricedCalls - settled calls and judge usage the cap could not count.
 */

/**
 * Create the cap for one run.
 * @param {number} maxDollars - positive cap in API-equivalent USD.
 * @returns {DollarBudget}
 */
export function createDollarBudget(maxDollars) {
  let spent = 0
  let projected = 0
  let unpriced = 0
  /** @type {import('../schema/run-manifest.js').BudgetStop | null} */
  let stop = null
  return {
    settle(accounting) {
      const spend = trialSpend(accounting)
      spent += spend
      projected = Math.max(projected, spend)
      unpriced += accounting.unpricedCalls + accounting.judge.unpricedCalls
    },
    admits(inFlight) {
      if (stop !== null) return false
      if (spent < maxDollars && spent + (inFlight + 1) * projected <= maxDollars) return true
      stop = {
        reason: 'max-dollars',
        maxDollars,
        spentDollars: spent,
        projectedTrialDollars: projected,
        inFlight,
        notLaunched: 0,
        unpricedCalls: unpriced,
      }
      return false
    },
    stop: () => stop,
    unpricedCalls: () => unpriced,
  }
}
