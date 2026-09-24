/**
 * Priced, cache-inclusive trial accounting: fold every billed model call,
 * routing judgment, and step TTFT out of a trial's session logs, then price
 * the calls against a dated research snapshot under `bench/prices/`.
 *
 * Cache counts follow the `TokenUsage` presence contract
 * (`docs/subsystems/llm-streaming.md#tokenusage`, restated here because the
 * bench imports no workspace package): a present `cacheReadTokens` or
 * `cacheWriteTokens`, including 0, is a count the provider reported; an
 * absent one is unreported, and `inputTokens` may then include cached input.
 * A call whose cache-read count is absent is an unreported call: it stays out
 * of the cache-hit share, and its dollars appear only in the upper bound,
 * which prices its whole input at the uncached input rate.
 *
 * Research only: the runtime has no price table. Dollars are API-equivalent
 * list prices from the snapshot, never billing truth.
 *
 * @module bench/runner/accounting
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Committed dated price snapshots. */
export const DEFAULT_PRICES_DIR = fileURLToPath(new URL('../prices/', import.meta.url))

/** Committed bench accounting configuration. */
export const DEFAULT_ACCOUNTING_CONFIG = fileURLToPath(new URL('../accounting.json', import.meta.url))

/** Routing judgment event types and the kind each folds as. */
const JUDGMENT_KINDS = /** @type {const} */ ({
  'model-routing/decision': 'decision',
  'model-routing/child-decision': 'child-decision',
  'model-routing/shadow-decision': 'shadow-decision',
})

/** Packed storage rows of delta chunks (`@shres-code/shres-code-session/chunk-rows`). */
const PACKED_ROWS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** Milliseconds per UTC day. */
const DAY_MS = 86_400_000

/** Snapshot prices are USD per this many tokens. */
const PRICE_UNIT_TOKENS = 1_000_000

const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}$/
const WINDOW = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/

/**
 * @typedef {object} CallUsage - one call's provider-reported counts; cache fields present only when reported.
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 */

/**
 * @typedef {object} CallRecord - one billed model call.
 * @property {string | null} provider - harness route id; null when the log names none.
 * @property {string | null} model - model id; null when the log names none.
 * @property {number | null} time - request timestamp (epoch ms): the step's `step/start` time, else the usage event's own.
 * @property {CallUsage} usage
 */

/**
 * @typedef {'decision' | 'child-decision' | 'shadow-decision'} JudgmentKind
 */

/**
 * @typedef {object} JudgmentRecord - one routing judgment record.
 * @property {JudgmentKind} kind
 * @property {string | null} engine
 * @property {string | null} model
 * @property {number | null} latencyMs
 * @property {number | null} eligibilityMs
 * @property {boolean} awaited - the consult sat on the request's critical path.
 * @property {CallUsage | null} usage - the judge's own usage, when the record carries one.
 * @property {number | null} time - event timestamp (epoch ms).
 */

/**
 * @typedef {object} SessionFacts - accounting facts folded from one session log.
 * @property {CallRecord[]} calls
 * @property {JudgmentRecord[]} judgments
 * @property {number[]} ttftMs - per-step time to first token.
 */

/**
 * @typedef {object} PriceRow - the five per-1M prices of one schedule.
 * @property {number | null} input
 * @property {number | null} output
 * @property {number | null} cacheWrite5m
 * @property {number | null} cacheWrite1h
 * @property {number | null} cacheRead
 */

/**
 * @typedef {PriceRow & { provider: string, model: string, offPeak: PriceRow | null, offPeakWindowsUtc: string[] }} PriceEntry -
 *   one snapshot `models` entry (see bench/prices/README.md).
 */

/**
 * @typedef {object} PriceSnapshot
 * @property {string} id - the snapshot date, which is also its file stem.
 * @property {Map<string, PriceEntry>} entries - keyed by `provider\u0000model`.
 */

/**
 * @typedef {object} AccountingConfig - `bench/accounting.json`.
 * @property {string[]} subscriptionProviders - route ids billed to a subscription or prepaid credit; their calls
 *   count as quota tokens, never dollars.
 * @property {Record<string, string>} priceProviders - route id → snapshot `provider`; an unlisted route is unpriced.
 * @property {Record<string, string>} judgeEnginePriceProviders - judgment engine → snapshot `provider` for pricing
 *   the judge's own usage.
 * @property {string[]} vendorPlanJudgeEngines - judgment engines billed by vendor plan; counted, never priced.
 */

/**
 * @typedef {object} AccountingContext - everything pricing needs, resolved once per run.
 * @property {PriceSnapshot} snapshot
 * @property {AccountingConfig} config
 * @property {string} configSha256 - hex SHA-256 of the config file bytes.
 */

/**
 * @typedef {object} JudgeAccounting
 * @property {number} calls - records that carry a judgment call (a `latencyMs` or an `engine`).
 * @property {Record<JudgmentKind, number>} callsByKind
 * @property {Record<string, number>} byEngine - calls by `engine/model`.
 * @property {number} latencyMs - summed judgment-call latency.
 * @property {number[]} latencySamplesMs - each judgment call's latency.
 * @property {number} criticalPathMs - `latencyMs` plus `eligibilityMs` summed over awaited consults.
 * @property {number} vendorPlanCalls - calls by a `vendorPlanJudgeEngines` engine.
 * @property {number} pricedCalls
 * @property {number} unpricedCalls - LLM judge calls carrying usage with no usable price.
 * @property {number} dollars - priced judge usage with a reported cache-read count.
 * @property {number} dollarsUpperBound - `dollars` plus unreported judge usage at the uncached input rate.
 */

/**
 * @typedef {object} TrialAccounting
 * @property {number} calls - billed model calls.
 * @property {{ uncachedInput: number, unreportedInput: number, output: number, cacheRead: number, cacheWrite: number }} tokens -
 *   raw tokens by class; `uncachedInput` is input of calls that reported cache reads, `unreportedInput` input of calls
 *   that did not, and the cache classes sum reported counts.
 * @property {number} unreportedCalls - calls without a reported cache-read count.
 * @property {number | null} cacheHitShare - cache reads over the prompt tokens of reported calls; null when none.
 * @property {number | null} unreportedShare - unreported input over all prompt tokens; null when none.
 * @property {number} dollars - API-equivalent USD over priced, reported, non-subscription calls.
 * @property {number} dollarsUpperBound - `dollars` plus priced unreported non-subscription calls at the uncached input rate.
 * @property {number} offPeakCalls - priced calls billed at an off-peak rate.
 * @property {number} unpricedCalls - non-subscription calls with no usable price.
 * @property {string[]} unpricedModels - distinct `route/model` pairs of unpriced calls, sorted.
 * @property {number} quotaCalls - calls on subscription routes.
 * @property {number} quotaTokens - input-equivalent tokens over priced subscription calls.
 * @property {number} quotaUnpricedTokens - raw tokens of subscription calls with no price to weight them.
 * @property {JudgeAccounting} judge
 * @property {number[]} ttftSamplesMs - per-step time to first token.
 */

/**
 * Whether a value is a non-negative finite count.
 * @param {unknown} value
 * @returns {value is number}
 */
const isCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * Read one usage record under the presence contract. Input and output must be
 * non-negative finite numbers or the record names no call; a cache count that
 * is absent or invalid is unreported.
 * @param {unknown} raw - candidate usage value.
 * @returns {CallUsage | null} the usage, or null when it names no call.
 */
function readUsage(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const usage = /** @type {Record<string, unknown>} */ (raw)
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return null
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...isCount(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {},
    ...isCount(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {},
  }
}

/** @param {unknown} value @returns {string | null} */
const stringOrNull = value => (typeof value === 'string' && value.length > 0 ? value : null)

/** @param {unknown} value @returns {number | null} */
const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * Whether one delta chunk carries a token, matching the client runtime's
 * `isTokenDelta`: non-empty text or reasoning, or tool-call arguments or name.
 * @param {Record<string, unknown>} chunk
 * @returns {boolean}
 */
function isTokenDelta(chunk) {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text !== ''
    case 'tool-call-delta':
      return (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '') || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * Time of the first token-bearing member of a packed delta row, or null when
 * no member carries a token. Member `k` sits at `time0` plus the first `k` gaps.
 * @param {Record<string, unknown>} row - a `text-chunks`, `reasoning-chunks`, or `tool-call-chunks` row.
 * @returns {number | null}
 */
function firstPackedTokenTime(row) {
  const data = /** @type {Record<string, unknown>} */ (row.data ?? {})
  const time0 = finiteOrNull(row.time0)
  const gaps = Array.isArray(data.dt) ? data.dt : []
  const members = row.type === 'tool-call-chunks' ? data.args : data.texts
  if (time0 === null || !Array.isArray(members)) return null
  const namedRun = row.type === 'tool-call-chunks' && typeof data.name === 'string'
  let time = time0
  for (let index = 0; index < members.length; index += 1) {
    if (index > 0) time += Number(gaps[index - 1] ?? 0)
    if (namedRun || (typeof members[index] === 'string' && members[index] !== '')) return time
  }
  return null
}

/**
 * Fold one session log's accounting facts.
 *
 * A model call is a `usage` chunk: the stream protocol emits at most one per
 * call, and a failed attempt that reported usage still bills. The step's
 * `assistant/message` usage repeats its final call, so it adds a call only
 * when the step logged no usage chunk. A call's route is the message's model
 * source when the step finalized, else the newest `request/context`.
 *
 * TTFT per step is the first token-bearing chunk's time minus the step's
 * `step/start` time, reading packed chunk rows too. A torn final line (child
 * killed mid-append) is skipped; a corrupt line before it throws.
 * @param {string} text - raw session JSONL.
 * @returns {SessionFacts} calls, judgments, and TTFT samples in log order.
 */
export function foldSessionAccounting(text) {
  /** @type {CallRecord[]} */
  const calls = []
  /** @type {JudgmentRecord[]} */
  const judgments = []
  /** @type {number[]} */
  const ttftMs = []
  /** @type {{ provider: string | null, model: string | null }} */
  let route = { provider: null, model: null }
  /** @type {Map<string, number>} step key → step/start time */
  const stepStart = new Map()
  /** @type {Set<string>} steps whose first token is already sampled */
  const sampled = new Set()
  /** @type {Map<string, number[]>} step key → indices of its chunk calls */
  const chunkCalls = new Map()

  /** @param {Record<string, unknown>} data @returns {string} */
  const stepKey = data => `${String(data.turn)}/${String(data.step)}`
  /** @param {string} key @param {number | null} time */
  const sampleFirstToken = (key, time) => {
    const start = stepStart.get(key)
    if (start === undefined || sampled.has(key) || time === null) return
    sampled.add(key)
    if (time >= start) ttftMs.push(time - start)
  }

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    /** @type {Record<string, unknown>} */
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      if (index === lines.length - 1) break // torn tail from a killed child append
      throw new Error(`session log line ${index + 1} is not valid JSON: ${/** @type {Error} */ (error).message}`)
    }
    const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
    const time = finiteOrNull(event.time)
    const type = /** @type {string} */ (event.type)
    if (type === 'step/start') {
      const key = stepKey(data)
      if (time !== null) stepStart.set(key, time)
      sampled.delete(key)
      chunkCalls.delete(key)
    } else if (type === 'request/context') {
      route = { provider: stringOrNull(data.provider), model: stringOrNull(data.model) }
    } else if (type === 'assistant/chunk') {
      const chunk = /** @type {Record<string, unknown>} */ (data.chunk ?? {})
      const key = stepKey(data)
      if (chunk.type === 'usage') {
        const usage = readUsage(chunk.usage)
        if (usage === null) continue
        const indices = chunkCalls.get(key) ?? []
        indices.push(calls.length)
        chunkCalls.set(key, indices)
        calls.push({ ...route, time: stepStart.get(key) ?? time, usage })
      } else if (isTokenDelta(chunk)) {
        sampleFirstToken(key, time)
      }
    } else if (PACKED_ROWS.has(type)) {
      sampleFirstToken(stepKey(data), firstPackedTokenTime(event))
    } else if (type === 'assistant/message') {
      const key = stepKey(data)
      const message = /** @type {Record<string, unknown>} */ (data.message ?? {})
      const source = /** @type {Record<string, unknown>} */ (message.source ?? {})
      const provider = stringOrNull(source.provider)
      const model = stringOrNull(source.model)
      const indices = chunkCalls.get(key)
      if (indices !== undefined && indices.length > 0) {
        const last = calls[/** @type {number} */ (indices.at(-1))]
        if (provider !== null) last.provider = provider
        if (model !== null) last.model = model
        chunkCalls.delete(key)
        continue
      }
      const usage = readUsage(data.usage)
      if (usage === null) continue
      calls.push({
        provider: provider ?? route.provider,
        model: model ?? route.model,
        time: stepStart.get(key) ?? time,
        usage,
      })
    } else if (Object.hasOwn(JUDGMENT_KINDS, type)) {
      const kind = JUDGMENT_KINDS[/** @type {keyof typeof JUDGMENT_KINDS} */ (type)]
      judgments.push({
        kind,
        engine: stringOrNull(data.engine),
        model: stringOrNull(data.model),
        latencyMs: finiteOrNull(data.latencyMs),
        eligibilityMs: finiteOrNull(data.eligibilityMs),
        awaited: typeof data.awaited === 'boolean' ? data.awaited : kind !== 'shadow-decision',
        usage: readUsage(data.usage),
        time,
      })
    }
  }
  return { calls, judgments, ttftMs }
}

/**
 * Parse one `HH:MM-HH:MM` UTC window into day offsets. `24:00` ends the day;
 * a window whose end precedes its start spans midnight.
 * @param {string} window - the window text.
 * @returns {{ start: number, end: number }} milliseconds since UTC midnight.
 */
function parseWindow(window) {
  const match = WINDOW.exec(window)
  if (match === null) throw new Error(`price window "${window}" must be HH:MM-HH:MM`)
  const [startH, startM, endH, endM] = match.slice(1).map(Number)
  const start = (startH * 60 + startM) * 60_000
  const end = (endH * 60 + endM) * 60_000
  if (startH > 23 || startM > 59 || endM > 59 || end > DAY_MS || start === end) {
    throw new Error(`price window "${window}" is not a non-empty span of one UTC day`)
  }
  return { start, end }
}

/**
 * Whether a request timestamp falls in one of an entry's off-peak windows.
 * Windows are half-open: the start minute is inside, the end minute is not.
 * An entry without off-peak prices, or a call without a timestamp, bills at
 * the peak rate.
 * @param {PriceEntry} entry - the model's snapshot entry.
 * @param {number | null} time - request timestamp (epoch ms).
 * @returns {boolean}
 */
export function isOffPeak(entry, time) {
  if (entry.offPeak === null || time === null) return false
  const offset = ((time % DAY_MS) + DAY_MS) % DAY_MS
  return entry.offPeakWindowsUtc.some(window => {
    const { start, end } = parseWindow(window)
    return start < end ? offset >= start && offset < end : offset >= start || offset < end
  })
}

/**
 * The per-1M rates one call bills at, or null when the model is unpriced (no
 * input or output rate). A null cache rate means the provider publishes no
 * separate rate, so that class bills at the input rate. Writes bill at the
 * 5-minute tier: logged usage carries no write TTL, and the 1-hour tier
 * applies only where it is the sole tier published.
 * @param {PriceEntry} entry - the model's snapshot entry.
 * @param {number | null} time - request timestamp (epoch ms).
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, offPeak: boolean } | null}
 */
export function ratesAt(entry, time) {
  const offPeak = isOffPeak(entry, time)
  const source = offPeak ? /** @type {PriceRow} */ (entry.offPeak) : entry
  if (source.input === null || source.output === null) return null
  return {
    input: source.input,
    output: source.output,
    cacheRead: source.cacheRead ?? source.input,
    cacheWrite: source.cacheWrite5m ?? source.cacheWrite1h ?? source.input,
    offPeak,
  }
}

/**
 * Price one call's usage. A call with a reported cache-read count has an
 * exact price; one without it prices its whole input at the uncached input
 * rate and counts toward the upper bound only.
 * @param {CallUsage} usage
 * @param {NonNullable<ReturnType<typeof ratesAt>>} rates
 * @returns {{ reported: boolean, dollars: number }}
 */
function priceUsage(usage, rates) {
  const read = usage.cacheReadTokens
  const dollars = (
    usage.inputTokens * rates.input
    + usage.outputTokens * rates.output
    + (read === undefined ? 0 : read * rates.cacheRead)
    + (usage.cacheWriteTokens ?? 0) * rates.cacheWrite
  ) / PRICE_UNIT_TOKENS
  return { reported: read !== undefined, dollars }
}

/**
 * An accounting record with nothing folded.
 * @returns {TrialAccounting}
 */
export function emptyAccounting() {
  return {
    calls: 0,
    tokens: { uncachedInput: 0, unreportedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    unreportedCalls: 0,
    cacheHitShare: null,
    unreportedShare: null,
    dollars: 0,
    dollarsUpperBound: 0,
    offPeakCalls: 0,
    unpricedCalls: 0,
    unpricedModels: [],
    quotaCalls: 0,
    quotaTokens: 0,
    quotaUnpricedTokens: 0,
    judge: {
      calls: 0,
      callsByKind: { 'decision': 0, 'child-decision': 0, 'shadow-decision': 0 },
      byEngine: {},
      latencyMs: 0,
      latencySamplesMs: [],
      criticalPathMs: 0,
      vendorPlanCalls: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      dollars: 0,
      dollarsUpperBound: 0,
    },
    ttftSamplesMs: [],
  }
}

/**
 * Recompute the derived shares from the token sums.
 * @param {TrialAccounting} accounting - mutated in place.
 * @returns {TrialAccounting} the same record.
 */
function deriveShares(accounting) {
  const { uncachedInput, unreportedInput, cacheRead, cacheWrite } = accounting.tokens
  const reportedPrompt = uncachedInput + cacheRead + cacheWrite
  const allPrompt = reportedPrompt + unreportedInput
  accounting.cacheHitShare = reportedPrompt === 0 ? null : cacheRead / reportedPrompt
  accounting.unreportedShare = allPrompt === 0 ? null : unreportedInput / allPrompt
  return accounting
}

/** @param {string | null} provider @param {string | null} model @returns {string} */
const routeLabel = (provider, model) => `${provider ?? '(unknown)'}/${model ?? '(unknown)'}`

/**
 * Price and total the folded facts of one trial's session closure.
 * @param {SessionFacts[]} sessions - facts of the root session and its descendants.
 * @param {AccountingContext} context - resolved snapshot and configuration.
 * @returns {TrialAccounting}
 */
export function priceAccounting(sessions, context) {
  const { snapshot, config } = context
  const subscription = new Set(config.subscriptionProviders)
  const vendorPlan = new Set(config.vendorPlanJudgeEngines)
  const accounting = emptyAccounting()
  const judge = accounting.judge
  /** @type {Set<string>} */
  const unpriced = new Set()
  /**
   * @param {string | undefined} priceProvider
   * @param {string | null} model
   * @param {number | null} time
   */
  const ratesFor = (priceProvider, model, time) => {
    if (priceProvider === undefined || model === null) return null
    const entry = snapshot.entries.get(`${priceProvider}\u0000${model}`)
    return entry === undefined ? null : ratesAt(entry, time)
  }

  for (const session of sessions) {
    for (const call of session.calls) {
      const { usage } = call
      accounting.calls += 1
      if (usage.cacheReadTokens === undefined) {
        accounting.unreportedCalls += 1
        accounting.tokens.unreportedInput += usage.inputTokens
      } else {
        accounting.tokens.uncachedInput += usage.inputTokens
        accounting.tokens.cacheRead += usage.cacheReadTokens
      }
      accounting.tokens.cacheWrite += usage.cacheWriteTokens ?? 0
      accounting.tokens.output += usage.outputTokens

      const rates = call.provider === null ? null : ratesFor(config.priceProviders[call.provider], call.model, call.time)
      if (call.provider !== null && subscription.has(call.provider)) {
        accounting.quotaCalls += 1
        if (rates === null || rates.input === 0) {
          accounting.quotaUnpricedTokens += usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        } else {
          accounting.quotaTokens += priceUsage(usage, rates).dollars * PRICE_UNIT_TOKENS / rates.input
        }
        continue
      }
      if (rates === null) {
        accounting.unpricedCalls += 1
        unpriced.add(routeLabel(call.provider, call.model))
        continue
      }
      if (rates.offPeak) accounting.offPeakCalls += 1
      const priced = priceUsage(usage, rates)
      if (priced.reported) accounting.dollars += priced.dollars
      accounting.dollarsUpperBound += priced.dollars
    }

    for (const judgment of session.judgments) {
      if (judgment.awaited) judge.criticalPathMs += (judgment.latencyMs ?? 0) + (judgment.eligibilityMs ?? 0)
      if (judgment.latencyMs === null && judgment.engine === null) continue
      judge.calls += 1
      judge.callsByKind[judgment.kind] += 1
      const label = routeLabel(judgment.engine, judgment.model)
      judge.byEngine[label] = (judge.byEngine[label] ?? 0) + 1
      if (judgment.latencyMs !== null) {
        judge.latencyMs += judgment.latencyMs
        judge.latencySamplesMs.push(judgment.latencyMs)
      }
      if (judgment.engine !== null && vendorPlan.has(judgment.engine)) {
        judge.vendorPlanCalls += 1
        continue
      }
      if (judgment.usage === null) continue
      const rates = judgment.engine === null
        ? null
        : ratesFor(config.judgeEnginePriceProviders[judgment.engine], judgment.model, judgment.time)
      if (rates === null) {
        judge.unpricedCalls += 1
        continue
      }
      judge.pricedCalls += 1
      const priced = priceUsage(judgment.usage, rates)
      if (priced.reported) judge.dollars += priced.dollars
      judge.dollarsUpperBound += priced.dollars
    }

    accounting.ttftSamplesMs.push(...session.ttftMs)
  }
  accounting.unpricedModels = [...unpriced].sort()
  return deriveShares(accounting)
}

/**
 * Sum two accounting records (chain phases, arm pooling), recomputing the shares.
 * @param {TrialAccounting} left
 * @param {TrialAccounting} right
 * @returns {TrialAccounting} a new record.
 */
export function mergeAccounting(left, right) {
  const sum = emptyAccounting()
  for (const field of /** @type {const} */ (['calls', 'unreportedCalls', 'dollars', 'dollarsUpperBound', 'offPeakCalls', 'unpricedCalls', 'quotaCalls', 'quotaTokens', 'quotaUnpricedTokens'])) {
    sum[field] = left[field] + right[field]
  }
  for (const field of /** @type {const} */ (['uncachedInput', 'unreportedInput', 'output', 'cacheRead', 'cacheWrite'])) {
    sum.tokens[field] = left.tokens[field] + right.tokens[field]
  }
  sum.unpricedModels = [...new Set([...left.unpricedModels, ...right.unpricedModels])].sort()
  for (const field of /** @type {const} */ (['calls', 'latencyMs', 'criticalPathMs', 'vendorPlanCalls', 'pricedCalls', 'unpricedCalls', 'dollars', 'dollarsUpperBound'])) {
    sum.judge[field] = left.judge[field] + right.judge[field]
  }
  for (const kind of /** @type {const} */ (['decision', 'child-decision', 'shadow-decision'])) {
    sum.judge.callsByKind[kind] = left.judge.callsByKind[kind] + right.judge.callsByKind[kind]
  }
  for (const source of [left.judge.byEngine, right.judge.byEngine]) {
    for (const [label, count] of Object.entries(source)) sum.judge.byEngine[label] = (sum.judge.byEngine[label] ?? 0) + count
  }
  sum.judge.latencySamplesMs = [...left.judge.latencySamplesMs, ...right.judge.latencySamplesMs]
  sum.ttftSamplesMs = [...left.ttftSamplesMs, ...right.ttftSamplesMs]
  return deriveShares(sum)
}

/**
 * Dollars a trial counts against `--max-dollars`: the upper bounds of model
 * calls and judge usage. Unpriced and subscription calls are outside it.
 * @param {TrialAccounting} accounting
 * @returns {number}
 */
export function trialSpend(accounting) {
  return accounting.dollarsUpperBound + accounting.judge.dollarsUpperBound
}

/**
 * A trial's cache-hit share: `accounting.cacheHitShare`, the one presence-based
 * reading every report, aggregate, and verdict uses. Null when the trial
 * carries no accounting (recorded before the bench priced trials) or no call
 * reported a cache-read count.
 * @param {{ accounting?: TrialAccounting }} trial
 * @returns {number | null}
 */
export function trialCacheHitShare(trial) {
  return trial.accounting?.cacheHitShare ?? null
}

/**
 * The trial's exact API-equivalent cost, or null when any non-subscription
 * call or judge usage is unpriced or lacks a cache-read report.
 * @param {TrialAccounting} accounting
 * @returns {number | null}
 */
export function exactCost(accounting) {
  const exact = accounting.unpricedCalls === 0
    && accounting.judge.unpricedCalls === 0
    && accounting.dollars === accounting.dollarsUpperBound
    && accounting.judge.dollars === accounting.judge.dollarsUpperBound
  return exact ? accounting.dollars + accounting.judge.dollars : null
}

/**
 * Nearest-rank percentile.
 * @param {number[]} values
 * @param {number} fraction - in (0, 1].
 * @returns {number | null} null for an empty list.
 */
export function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
}

/**
 * @typedef {object} AccountingSummary - one arm's pooled accounting for the report.
 * @property {number} trials - trials that carried accounting.
 * @property {string[]} priceSnapshots - distinct snapshot ids the trials were priced under.
 * @property {Omit<TrialAccounting, 'judge' | 'ttftSamplesMs'>} totals
 * @property {Omit<JudgeAccounting, 'latencySamplesMs'> & { latencyP50Ms: number | null, latencyP90Ms: number | null }} judge
 * @property {number} ttftSteps
 * @property {number | null} ttftP50Ms
 * @property {number | null} ttftP90Ms
 */

/**
 * Pool the accounting of an arm's trials: totals, pooled shares, and pooled
 * TTFT and judge-latency percentiles. Trials without accounting are skipped.
 * @param {{ priceSnapshot?: string, accounting?: TrialAccounting }[]} trials
 * @returns {AccountingSummary | null} null when no trial carries accounting.
 */
export function summarizeAccounting(trials) {
  const carrying = trials.filter(trial => trial.accounting !== undefined)
  if (carrying.length === 0) return null
  const pooled = carrying.reduce(
    (sum, trial) => mergeAccounting(sum, /** @type {TrialAccounting} */ (trial.accounting)),
    emptyAccounting(),
  )
  const { judge, ttftSamplesMs, ...totals } = pooled
  const { latencySamplesMs, ...judgeTotals } = judge
  return {
    trials: carrying.length,
    priceSnapshots: [...new Set(carrying.map(trial => trial.priceSnapshot).filter(id => typeof id === 'string'))].sort(),
    totals,
    judge: { ...judgeTotals, latencyP50Ms: percentile(latencySamplesMs, 0.5), latencyP90Ms: percentile(latencySamplesMs, 0.9) },
    ttftSteps: ttftSamplesMs.length,
    ttftP50Ms: percentile(ttftSamplesMs, 0.5),
    ttftP90Ms: percentile(ttftSamplesMs, 0.9),
  }
}

/**
 * Resolve the snapshot id a run prices under: the requested id, or the newest
 * dated snapshot in `pricesDir`.
 * @param {string} pricesDir
 * @param {string | undefined} requested - `--price-snapshot`, when given.
 * @returns {Promise<string>}
 */
export async function resolvePriceSnapshotId(pricesDir, requested) {
  if (requested !== undefined) return requested
  const ids = (await readdir(pricesDir))
    .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map(name => name.slice(0, -'.json'.length))
    .sort()
  const newest = ids.at(-1)
  if (newest === undefined) throw new Error(`no dated price snapshot in ${pricesDir}`)
  return newest
}

/**
 * Load and index one dated snapshot. Fails loud on a snapshot whose date,
 * research flag, prices, or windows do not match bench/prices/README.md.
 * @param {string} pricesDir
 * @param {string} id - `YYYY-MM-DD`.
 * @returns {Promise<PriceSnapshot>}
 */
export async function loadPriceSnapshot(pricesDir, id) {
  if (!SNAPSHOT_ID.test(id)) throw new Error(`price snapshot id "${id}" must be YYYY-MM-DD`)
  const text = await readFile(join(pricesDir, `${id}.json`), 'utf8').catch(() => {
    throw new Error(`price snapshot ${id} not found in ${pricesDir}`)
  })
  const doc = JSON.parse(text)
  if (doc.snapshotDate !== id) throw new Error(`price snapshot ${id}: snapshotDate is ${String(doc.snapshotDate)}`)
  if (doc.researchOnly !== true) throw new Error(`price snapshot ${id}: researchOnly must be true`)
  if (!Array.isArray(doc.models)) throw new Error(`price snapshot ${id}: models must be an array`)
  const isPrice = value => value === null || isCount(value)
  /** @type {Map<string, PriceEntry>} */
  const entries = new Map()
  for (const entry of doc.models) {
    const name = `price snapshot ${id}: ${String(entry?.provider)}/${String(entry?.model)}`
    if (typeof entry?.provider !== 'string' || typeof entry.model !== 'string') throw new Error(`${name}: provider and model must be strings`)
    for (const field of ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']) {
      if (!isPrice(entry[field])) throw new Error(`${name}: ${field} must be a non-negative number or null`)
      if (entry.offPeak !== null && !isPrice(entry.offPeak?.[field])) {
        throw new Error(`${name}: offPeak.${field} must be a non-negative number or null`)
      }
    }
    if (!Array.isArray(entry.offPeakWindowsUtc)) throw new Error(`${name}: offPeakWindowsUtc must be an array`)
    for (const window of entry.offPeakWindowsUtc) parseWindow(window)
    const key = `${entry.provider}\u0000${entry.model}`
    if (entries.has(key)) throw new Error(`${name}: duplicate entry`)
    entries.set(key, entry)
  }
  return { id, entries }
}

/**
 * Load `bench/accounting.json`. Every key is required and no other key is
 * accepted, so a misspelled list fails loud instead of pricing nothing.
 * @param {string} path
 * @returns {Promise<{ config: AccountingConfig, sha256: string }>}
 */
export async function loadAccountingConfig(path) {
  const text = await readFile(path, 'utf8').catch(() => {
    throw new Error(`accounting config not found: ${path}`)
  })
  const raw = JSON.parse(text)
  const keys = ['subscriptionProviders', 'priceProviders', 'judgeEnginePriceProviders', 'vendorPlanJudgeEngines']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`)
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
  const nonEmpty = value => typeof value === 'string' && value.length > 0
  for (const key of ['subscriptionProviders', 'vendorPlanJudgeEngines']) {
    if (!Array.isArray(raw[key]) || !raw[key].every(nonEmpty)) throw new Error(`${path}: ${key} must be an array of non-empty strings`)
  }
  for (const key of ['priceProviders', 'judgeEnginePriceProviders']) {
    const dict = raw[key]
    if (typeof dict !== 'object' || dict === null || Array.isArray(dict) || !Object.values(dict).every(nonEmpty)) {
      throw new Error(`${path}: ${key} must map ids to non-empty strings`)
    }
  }
  return { config: /** @type {AccountingConfig} */ (raw), sha256: createHash('sha256').update(text).digest('hex') }
}

/**
 * Resolve everything pricing needs for one run: the snapshot id (requested or
 * newest), the loaded snapshot, and the accounting configuration.
 * @param {{ pricesDir: string, configPath: string, snapshotId: string | undefined }} request
 * @returns {Promise<AccountingContext>}
 */
export async function resolveAccountingContext({ pricesDir, configPath, snapshotId }) {
  const id = await resolvePriceSnapshotId(pricesDir, snapshotId)
  const snapshot = await loadPriceSnapshot(pricesDir, id)
  const { config, sha256 } = await loadAccountingConfig(configPath)
  return { snapshot, config, configSha256: sha256 }
}
