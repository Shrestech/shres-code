/**
 * In-process trial pool and a serial work queue. The pool walks an already
 * built list (the interleaved plan) and never reorders it; it only controls
 * how many list entries run at once. The queue makes `trials.jsonl` appends
 * and progress lines happen one at a time so concurrent completions cannot
 * interleave bytes.
 *
 * @module bench/runner/pool
 */

/**
 * Run `worker` over `items` in list order, with at most `concurrency`
 * calls in flight. The next item starts as soon as a slot frees. After
 * `signal` aborts, no further items start; in-flight workers are left to
 * settle (they watch the same signal and kill their children). A worker
 * rejection stops launching and is rethrown after in-flight work settles.
 * `admit`, when given, is asked before every launch with the in-flight count;
 * the first `false` stops launching for good, and in-flight workers settle
 * normally (unlike an abort, nothing is killed).
 *
 * Concurrency 1 is sequential: item i+1 starts only after item i's worker
 * fulfills, so completion order matches the list.
 *
 * @template T
 * @param {T[]} items - work list; not copied, not reordered.
 * @param {number} concurrency - max in-flight workers; integer >= 1.
 * @param {(item: T) => Promise<void> | void} worker - per-item work.
 * @param {{ signal?: AbortSignal, admit?: (inFlight: number) => boolean }} [options]
 * @returns {Promise<void>}
 */
export async function mapPool(items, concurrency, worker, { signal, admit } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be an integer >= 1; got ${concurrency}`)
  }
  let next = 0
  /** @type {Set<Promise<void>>} */
  const pending = new Set()
  /** @type {unknown} */
  let workerError

  while (next < items.length && workerError === undefined && !signal?.aborted) {
    if (pending.size >= concurrency) {
      await Promise.race(pending)
      continue
    }
    if (admit !== undefined && !admit(pending.size)) break
    const item = items[next]
    next += 1
    const run = (async () => {
      try {
        await worker(item)
      } catch (error) {
        if (workerError === undefined) workerError = error
      }
    })().finally(() => {
      pending.delete(run)
    })
    pending.add(run)
  }
  await Promise.all(pending)
  if (workerError !== undefined) throw workerError
}

/**
 * FIFO of async functions: each starts only after the previous settles.
 * Used so concurrent trial completions append one whole JSONL line and
 * print one progress line at a time.
 *
 * @returns {{ enqueue: <T>(work: () => Promise<T> | T) => Promise<T> }}
 */
export function createSerialQueue() {
  /** @type {Promise<void>} */
  let tail = Promise.resolve()
  return {
    enqueue(work) {
      const run = tail.then(() => work())
      tail = run.then(() => {}, () => {})
      return run
    },
  }
}
