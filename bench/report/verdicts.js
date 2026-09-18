/**
 * Pre-registered verdicts: the Jev routing and compaction decision rules of
 * `bench/jev-preregistration.md` applied to one experiment's trials, so the
 * report states each hypothesis as a graded verdict instead of leaving its
 * numbers to be read by eye. That file is the authority for every threshold and
 * every rule text below; a changed rule is a new experiment name, and this
 * module is the code half of the same claim.
 *
 * Four rules are computed here (H1 and H7 stay with the report's existing
 * machinery: H1 is the McNemar grade on `comparisons[]`, H7's adversarial
 * stratum floor is not computed — see bench/README.md):
 * - H2 token reduction on the trials where routing acted.
 * - H3 routing adoption, which gates H2.
 * - H4 the churn screen, which is applied only when both arms carry usage data.
 * - H5 the compaction pass-rate delta and token ceiling, gated by H6.
 * - H6 compaction-verification adoption.
 *
 * Three honesty rules hold for every verdict, and the report schema enforces
 * them: a missing datum, an empty subset, or fewer than two paired trials is
 * `not-evaluable` **with its reason** — never a pass, and never a fail by
 * default (a not-evaluable verdict carries no outcome at all); a computed
 * verdict carries its interval and its trial count (protocol rule 3: a delta
 * without an interval is not a result); and a screen that fails makes the
 * hypothesis it gates not-evaluable rather than confirmed, exactly as the
 * pre-registration states.
 *
 * @module bench/report/verdicts
 */

import { bootstrapDeltaCi, bootstrapMeanCi, wilsonInterval } from '../stats/intervals.js'
import { mcnemarExactP, pairOutcomes } from '../stats/paired.js'

/** Arms the Jev pre-registration freezes. */
export const JEV_ARMS = Object.freeze({
  routingControl: 'route-off',
  routingTreatment: 'route-on',
  compactionControl: 'compact-basic',
  compactionTreatment: 'compact-jev',
})

/** Adoption share both adoption screens require: 2/3 of the arm's trials. */
const ADOPTION_PART = 2
const ADOPTION_WHOLE = 3

/** Churn-screen coverage floor: 80% of trials in each arm carry usage data. */
const COVERAGE_PART = 4
const COVERAGE_WHOLE = 5

/** Churn margin: cacheHitShare(route-on) ≥ cacheHitShare(route-off) − 5 points. */
const CHURN_MARGIN = 0.05

/** Token-reduction floor: route-on tokens at least 15% below their paired baseline. */
const TOKEN_REDUCTION = 0.15

/** Compaction pass-rate floor: at least +10 points over the basic arm. */
const COMPACTION_DELTA = 0.1

/** Compaction token ceiling: within 1.2× of the basic arm. */
const COMPACTION_TOKEN_CEILING = 1.2

/**
 * Smallest paired sample a paired rule is evaluated on. One pair reproduces
 * itself under every bootstrap resample, so it carries no interval to report;
 * the pre-registration states no minimum, and this guard is the suite's own
 * reading of protocol rule 3 rather than a threshold of the frozen file.
 */
const MIN_PAIRS = 2

/**
 * @typedef {object} ReportVerdict
 * @property {string} id - hypothesis id from the pre-registration: H2 … H6.
 * @property {string} rule - the frozen rule, restated.
 * @property {string[]} arms - arms the verdict reads: one for a screen, two for a paired rule.
 * @property {'evaluable' | 'not-evaluable'} status
 * @property {'pass' | 'fail' | null} outcome - null exactly when the verdict is not evaluable.
 * @property {string | null} reason - why the verdict is not evaluable; null when it is.
 * @property {number | null} observed - the measured quantity the threshold compares.
 * @property {number | null} threshold - the pre-registered bar.
 * @property {[number, number] | null} ci95 - interval on `observed`; null only when not evaluable.
 * @property {number} trials - trials (or matched pairs) the verdict reads.
 * @property {Record<string, unknown>} facts - the supporting counts, rates, and estimator values.
 */

/**
 * Exact share comparison `part/whole ≥ num/den`, by cross-multiplication so a
 * boundary such as exactly 80% or exactly 2/3 never turns on float equality.
 * @param {number} part - numerator.
 * @param {number} whole - denominator.
 * @param {number} num - required share numerator.
 * @param {number} den - required share denominator.
 * @returns {boolean} true when the share meets the requirement.
 */
function meetsShare(part, whole, num, den) {
  return whole > 0 && part * den >= whole * num
}

/**
 * Successful trials of one arm.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the experiment.
 * @param {string} arm - arm name.
 * @returns {import('../schema/trial.js').Trial[]} the arm's success-status trials.
 */
function armTrials(trials, arm) {
  return trials.filter(t => t.arm === arm && t.status === 'success')
}

/**
 * Pairing key shared with `pairOutcomes` (taskId + trialIndex).
 * @param {{ taskId: string, trialIndex: number }} trial - a trial or a pair.
 * @returns {string} the pairing key.
 */
function pairKey(trial) {
  return JSON.stringify([trial.taskId, trial.trialIndex])
}

/**
 * Index one arm's trials by pairing key for metric lookup after pairing.
 * @param {import('../schema/trial.js').Trial[]} trials - one arm's trials.
 * @returns {Map<string, import('../schema/trial.js').Trial>} key → trial.
 */
function byPairKey(trials) {
  const map = new Map()
  for (const trial of trials) {
    if (trial.status === 'success') map.set(pairKey(trial), trial)
  }
  return map
}

/**
 * Mean of a numeric list; NaN for empty input (never reached by a caller that
 * has already rejected an empty subset).
 * @param {number[]} values - the sample.
 * @returns {number} arithmetic mean.
 */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Build a not-evaluable verdict: no outcome, and the reason is mandatory.
 * @param {string} id - hypothesis id.
 * @param {string} rule - the frozen rule.
 * @param {string[]} arms - arms the verdict reads.
 * @param {string} reason - why the pre-registered rule cannot be applied.
 * @param {Record<string, unknown>} [facts] - supporting counts observed so far.
 * @returns {ReportVerdict} the verdict record.
 */
function notEvaluable(id, rule, arms, reason, facts = {}) {
  return {
    id,
    rule,
    arms,
    status: 'not-evaluable',
    outcome: null,
    reason,
    observed: null,
    threshold: null,
    ci95: null,
    trials: 0,
    facts,
  }
}

/**
 * H3 — routing adoption. At least 2/3 of the treatment arm's trials must log a
 * routing decision; below that the arm did not exercise the intervention.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the experiment.
 * @returns {ReportVerdict} the adoption verdict.
 */
export function verdictRoutingAdoption(trials) {
  const rule = `≥2/3 of ${JEV_ARMS.routingTreatment} trials log ≥1 model-routing/decision`
  const arm = JEV_ARMS.routingTreatment
  const ok = armTrials(trials, arm)
  if (ok.length === 0) return notEvaluable('H3', rule, [arm], `arm ${arm} has no success-status trial in this experiment`)
  // A recorded streak list is the fold's witness that the trial logged at least
  // one decision (an empty list still means the router judged turns).
  const judged = ok.filter(t => Array.isArray(t.metrics.downgradedStreaks))
  return {
    id: 'H3',
    rule,
    arms: [arm],
    status: 'evaluable',
    outcome: meetsShare(judged.length, ok.length, ADOPTION_PART, ADOPTION_WHOLE) ? 'pass' : 'fail',
    reason: null,
    observed: judged.length / ok.length,
    threshold: ADOPTION_PART / ADOPTION_WHOLE,
    ci95: wilsonInterval(judged.length, ok.length),
    trials: ok.length,
    facts: { arm, decisionTrials: judged.length, trials: ok.length },
  }
}

/**
 * H4 — the churn screen. `cacheHitShare(route-on) ≥ cacheHitShare(route-off) −
 * 5 points`, applied only when at least 80% of the trials in **both** arms
 * carry usage data; a shortfall is not-evaluable with the null share as its
 * reason. The point estimate is each arm's mean per-trial share (the aggregate
 * the report shows); the interval is a paired bootstrap over the matched
 * per-pair share deltas.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the experiment.
 * @returns {ReportVerdict} the churn-screen verdict.
 */
export function verdictChurnScreen(trials) {
  const rule = `cacheHitShare(${JEV_ARMS.routingTreatment}) ≥ cacheHitShare(${JEV_ARMS.routingControl}) − 5 points, applied only when ≥80% of trials in both arms carry usage data`
  const arms = [JEV_ARMS.routingControl, JEV_ARMS.routingTreatment]
  const control = armTrials(trials, JEV_ARMS.routingControl)
  const treatment = armTrials(trials, JEV_ARMS.routingTreatment)
  for (const [arm, armList] of [[JEV_ARMS.routingControl, control], [JEV_ARMS.routingTreatment, treatment]]) {
    if (armList.length === 0) return notEvaluable('H4', rule, arms, `arm ${arm} has no success-status trial in this experiment`)
  }
  const coverage = arm => {
    const list = arm === JEV_ARMS.routingControl ? control : treatment
    const withUsage = list.filter(t => t.metrics.cacheHitShare !== null && t.metrics.cacheHitShare !== undefined)
    return { trials: list.length, withUsage: withUsage.length, nullTrials: list.length - withUsage.length }
  }
  const controlCoverage = coverage(JEV_ARMS.routingControl)
  const treatmentCoverage = coverage(JEV_ARMS.routingTreatment)
  const shortfalls = [
    [JEV_ARMS.routingControl, controlCoverage],
    [JEV_ARMS.routingTreatment, treatmentCoverage],
  ].filter(([, c]) => !meetsShare(c.withUsage, c.trials, COVERAGE_PART, COVERAGE_WHOLE))
  if (shortfalls.length > 0) {
    const detail = shortfalls
      .map(([arm, c]) => `${arm}: cacheHitShare is null on ${c.nullTrials} of ${c.trials} trials (${(100 * c.withUsage / c.trials).toFixed(1)}% carry usage data)`)
      .join('; ')
    return notEvaluable('H4', rule, arms, `the 80% usage-data screen fails — ${detail}`, {
      routeOffUsageTrials: controlCoverage.withUsage,
      routeOffTrials: controlCoverage.trials,
      routeOnUsageTrials: treatmentCoverage.withUsage,
      routeOnTrials: treatmentCoverage.trials,
      requiredShare: COVERAGE_PART / COVERAGE_WHOLE,
    })
  }
  const { pairs } = pairOutcomes(control, treatment)
  const deltas = []
  const controlByKey = byPairKey(control)
  const treatmentByKey = byPairKey(treatment)
  for (const pair of pairs) {
    const off = controlByKey.get(pairKey(pair))?.metrics.cacheHitShare
    const on = treatmentByKey.get(pairKey(pair))?.metrics.cacheHitShare
    if (typeof off === 'number' && typeof on === 'number') deltas.push(on - off)
  }
  if (deltas.length < MIN_PAIRS) {
    return notEvaluable('H4', rule, arms, `fewer than ${MIN_PAIRS} matched trial pairs carry a cacheHitShare in both arms (${deltas.length} do)`, {
      matchedPairs: pairs.length,
      sharePairs: deltas.length,
    })
  }
  // Each arm's estimate is the mean over the trials that carry a share: a
  // null share is a missing datum, and folding it in as 0 would read as a total
  // cache miss and drag the screen in exactly the direction it audits.
  const meanOn = mean(treatment.filter(t => typeof t.metrics.cacheHitShare === 'number').map(t => /** @type {number} */ (t.metrics.cacheHitShare)))
  const meanOff = mean(control.filter(t => typeof t.metrics.cacheHitShare === 'number').map(t => /** @type {number} */ (t.metrics.cacheHitShare)))
  const observed = meanOn - meanOff
  return {
    id: 'H4',
    rule,
    arms,
    status: 'evaluable',
    outcome: observed >= -CHURN_MARGIN ? 'pass' : 'fail',
    reason: null,
    observed,
    threshold: -CHURN_MARGIN,
    ci95: bootstrapMeanCi(deltas),
    trials: deltas.length,
    facts: {
      meanCacheHitShareRouteOff: meanOff,
      meanCacheHitShareRouteOn: meanOn,
      routeOffUsageTrials: controlCoverage.withUsage,
      routeOffTrials: controlCoverage.trials,
      routeOnUsageTrials: treatmentCoverage.withUsage,
      routeOnTrials: treatmentCoverage.trials,
      matchedPairs: pairs.length,
      sharePairs: deltas.length,
    },
  }
}

/**
 * H2 — token reduction where routing acted. On the treatment arm's trials with
 * at least one downgraded decision, `tokensIncludingDescendants` must sit at
 * least 15% below the paired control trial's; billed tokens include the
 * transition re-prefills by construction, so no estimator is added. Gated by
 * H3: a failed adoption screen leaves H2 not-evaluable rather than confirmed.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the experiment.
 * @param {ReportVerdict} adoption - the H3 verdict this rule is gated by.
 * @returns {ReportVerdict} the token-delta verdict.
 */
export function verdictTokenDelta(trials, adoption) {
  const rule = `mean tokensIncludingDescendants on ${JEV_ARMS.routingTreatment} trials with ≥1 downgraded decision is ≥15% below the paired ${JEV_ARMS.routingControl} trial`
  const arms = [JEV_ARMS.routingControl, JEV_ARMS.routingTreatment]
  const control = armTrials(trials, JEV_ARMS.routingControl)
  const treatment = armTrials(trials, JEV_ARMS.routingTreatment)
  const downgraded = treatment.filter(t => (t.metrics.downgradedStreaks?.length ?? 0) > 0)
  if (downgraded.length === 0) {
    return notEvaluable('H2', rule, arms, `no ${JEV_ARMS.routingTreatment} trial logged a downgraded decision, so routing never acted`, { downgradedTrials: 0 })
  }
  if (adoption.status === 'not-evaluable') {
    return notEvaluable('H2', rule, arms, `the routing-adoption screen (H3) is not evaluable: ${adoption.reason}`, { downgradedTrials: downgraded.length })
  }
  if (adoption.outcome === 'fail') {
    return notEvaluable('H2', rule, arms, `the routing-adoption screen (H3) failed: ${adoption.facts.decisionTrials} of ${adoption.facts.trials} trials logged a decision, so the arm did not exercise the intervention`, { downgradedTrials: downgraded.length })
  }
  if (control.length === 0) {
    return notEvaluable('H2', rule, arms, `arm ${JEV_ARMS.routingControl} has no success-status trial in this experiment`, { downgradedTrials: downgraded.length })
  }
  // `pairOutcomes` owns the (taskId, trialIndex) matching; the filtered
  // treatment list makes the pairs exactly the trials where routing acted.
  const { pairs } = pairOutcomes(control, downgraded)
  const controlByKey = byPairKey(control)
  const treatmentByKey = byPairKey(downgraded)
  /** @type {{ off: number, on: number }[]} */
  const tokenPairs = []
  for (const pair of pairs) {
    const off = controlByKey.get(pairKey(pair))?.metrics.tokensIncludingDescendants
    const on = treatmentByKey.get(pairKey(pair))?.metrics.tokensIncludingDescendants
    if (typeof off === 'number' && typeof on === 'number' && off > 0) tokenPairs.push({ off, on })
  }
  if (tokenPairs.length < MIN_PAIRS) {
    return notEvaluable('H2', rule, arms, `fewer than ${MIN_PAIRS} matched pairs carry usable billed tokens in both arms (${tokenPairs.length} do)`, {
      downgradedTrials: downgraded.length,
      matchedPairs: pairs.length,
      tokenPairs: tokenPairs.length,
    })
  }
  // The estimator is the mean paired relative delta; each pair contributes one
  // number, so the bootstrap over those numbers is the paired bootstrap the
  // pre-registration's "paired bootstrap over the trials with ≥1 downgraded
  // decision" asks for, with the pair matching already baked in.
  const deltas = tokenPairs.map(pair => (pair.on - pair.off) / pair.off)
  const observed = mean(deltas)
  return {
    id: 'H2',
    rule,
    arms,
    status: 'evaluable',
    outcome: observed <= -TOKEN_REDUCTION ? 'pass' : 'fail',
    reason: null,
    observed,
    threshold: -TOKEN_REDUCTION,
    ci95: bootstrapMeanCi(deltas),
    trials: tokenPairs.length,
    facts: {
      downgradedTrials: downgraded.length,
      matchedPairs: pairs.length,
      tokenPairs: tokenPairs.length,
      meanTokensRouteOff: mean(tokenPairs.map(pair => pair.off)),
      meanTokensRouteOn: mean(tokenPairs.map(pair => pair.on)),
    },
  }
}

/**
 * H6 — compaction-verification adoption. At least 2/3 of the treatment arm's
 * trials that compacted must log a verification event.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the experiment.
 * @returns {ReportVerdict} the verification-adoption verdict.
 */
export function verdictVerificationAdoption(trials) {
  const rule = `≥2/3 of ${JEV_ARMS.compactionTreatment} trials that compact at all log ≥1 compaction/verification`
  const arm = JEV_ARMS.compactionTreatment
  const compacted = armTrials(trials, arm).filter(t => t.metrics.pressureFired === true)
  if (compacted.length === 0) {
    return notEvaluable('H6', rule, [arm], `no ${arm} trial compacted (pressureFired) in this experiment`)
  }
  // A recorded verdict count is the fold's witness that the trial logged at
  // least one compaction/verification event.
  const verified = compacted.filter(t => t.metrics.jevCompactionAcceptedBelowThreshold !== null && t.metrics.jevCompactionAcceptedBelowThreshold !== undefined)
  return {
    id: 'H6',
    rule,
    arms: [arm],
    status: 'evaluable',
    outcome: meetsShare(verified.length, compacted.length, ADOPTION_PART, ADOPTION_WHOLE) ? 'pass' : 'fail',
    reason: null,
    observed: verified.length / compacted.length,
    threshold: ADOPTION_PART / ADOPTION_WHOLE,
    ci95: wilsonInterval(verified.length, compacted.length),
    trials: compacted.length,
    facts: { arm, verifiedTrials: verified.length, compactedTrials: compacted.length },
  }
}

/**
 * H5 — compaction pays off at comparable cost. On `pressureFired` trials the
 * treatment arm's verifier-passed rate must be at least +10 points over the
 * control arm's with the paired interval excluding zero, and
 * `tokensIncludingDescendants` must stay within 1.2× of the control arm's.
 * Gated by H6: a failed verification-adoption screen leaves H5 not-evaluable.
 * @param {import('../schema/trial.js').Trial[]} trials - every trial of the experiment.
 * @param {ReportVerdict} adoption - the H6 verdict this rule is gated by.
 * @returns {ReportVerdict} the compaction verdict.
 */
export function verdictCompactionDelta(trials, adoption) {
  const rule = `on pressureFired trials the verifier-passed rate under ${JEV_ARMS.compactionTreatment} is ≥+10 points over ${JEV_ARMS.compactionControl} with the interval excluding zero, and tokens stay within 1.2× of the basic arm`
  const arms = [JEV_ARMS.compactionControl, JEV_ARMS.compactionTreatment]
  const control = armTrials(trials, JEV_ARMS.compactionControl).filter(t => t.metrics.pressureFired === true)
  const treatment = armTrials(trials, JEV_ARMS.compactionTreatment).filter(t => t.metrics.pressureFired === true)
  for (const [arm, list] of [[JEV_ARMS.compactionControl, control], [JEV_ARMS.compactionTreatment, treatment]]) {
    if (list.length === 0) return notEvaluable('H5', rule, arms, `arm ${arm} has no trial that compacted (pressureFired) in this experiment`)
  }
  if (adoption.status === 'not-evaluable') {
    return notEvaluable('H5', rule, arms, `the verification-adoption screen (H6) is not evaluable: ${adoption.reason}`)
  }
  if (adoption.outcome === 'fail') {
    return notEvaluable('H5', rule, arms, `the verification-adoption screen (H6) failed: ${adoption.facts.verifiedTrials} of ${adoption.facts.compactedTrials} compacting trials logged a verification`)
  }
  const { pairs, wins, losses, ties } = pairOutcomes(control, treatment)
  if (pairs.length < MIN_PAIRS) {
    return notEvaluable('H5', rule, arms, `fewer than ${MIN_PAIRS} matched pressureFired trial pairs (${pairs.length} do)`, {
      compactedTrialsControl: control.length,
      compactedTrialsTreatment: treatment.length,
      matchedPairs: pairs.length,
    })
  }
  const controlPass = mean(pairs.map(pair => Number(pair.off)))
  const treatmentPass = mean(pairs.map(pair => Number(pair.on)))
  const observed = treatmentPass - controlPass
  const ci95 = bootstrapDeltaCi(pairs)
  const controlByKey = byPairKey(control)
  const treatmentByKey = byPairKey(treatment)
  const tokenPairs = []
  for (const pair of pairs) {
    const off = controlByKey.get(pairKey(pair))?.metrics.tokensIncludingDescendants
    const on = treatmentByKey.get(pairKey(pair))?.metrics.tokensIncludingDescendants
    if (typeof off === 'number' && typeof on === 'number' && off > 0) tokenPairs.push({ off, on })
  }
  const facts = {
    matchedPairs: pairs.length,
    wins,
    losses,
    ties,
    mcnemarP: mcnemarExactP(wins, losses),
    passRateControl: controlPass,
    passRateTreatment: treatmentPass,
    compactedTrialsControl: control.length,
    compactedTrialsTreatment: treatment.length,
    tokenPairs: tokenPairs.length,
    tokenRatio: null,
    tokenCeiling: COMPACTION_TOKEN_CEILING,
  }
  if (tokenPairs.length < MIN_PAIRS) {
    return notEvaluable('H5', rule, arms,
      `fewer than ${MIN_PAIRS} matched pressureFired pairs carry usable billed tokens in both arms (${tokenPairs.length} do), so the 1.2× token ceiling cannot be measured`,
      facts)
  }
  const tokenRatio = mean(tokenPairs.map(pair => pair.on)) / mean(tokenPairs.map(pair => pair.off))
  facts.tokenRatio = tokenRatio
  const deltaMet = observed >= COMPACTION_DELTA && ci95[0] > 0
  const ceilingMet = tokenRatio <= COMPACTION_TOKEN_CEILING
  return {
    id: 'H5',
    rule,
    arms,
    status: 'evaluable',
    outcome: deltaMet && ceilingMet ? 'pass' : 'fail',
    reason: null,
    observed,
    threshold: COMPACTION_DELTA,
    ci95,
    trials: pairs.length,
    facts: { ...facts, deltaMet, ceilingMet },
  }
}

/**
 * Build the pre-registered verdict block for one experiment: the five Jev
 * hypotheses the report grades, each evaluable or not-evaluable with its
 * reason, in pre-registration order. Every experiment gets all five records —
 * an experiment that ran none of these arms reports five not-evaluable
 * verdicts rather than an absent or silently passing claim.
 * @param {import('../schema/trial.js').Trial[]} trials - every validated trial of the experiment.
 * @returns {ReportVerdict[]} the verdict block, in H2, H3, H4, H5, H6 order.
 */
export function buildVerdicts(trials) {
  const routingAdoption = verdictRoutingAdoption(trials)
  const verificationAdoption = verdictVerificationAdoption(trials)
  return [
    verdictTokenDelta(trials, routingAdoption),
    routingAdoption,
    verdictChurnScreen(trials),
    verdictCompactionDelta(trials, verificationAdoption),
    verificationAdoption,
  ]
}
