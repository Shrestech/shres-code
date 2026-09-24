/**
 * The judgment engine registry provided as `ctx.judgmentEngines`.
 *
 * Each provider registers one engine under a stable id; the service mounted as
 * `ctx.judgment` (`judgment-dispatch`) owns the registry and routes every ask
 * to the one engine its settings select. The registry itself selects nothing
 * and never answers an ask.
 *
 * @module @shres-code/shres-code-judgment/registry
 */

import type {
  JudgmentEngineDescriptor,
  JudgmentEngineEntry,
  JudgmentEngineId,
  JudgmentEngineRegistration,
} from './types.ts'

/** One subscription; a token rather than the bare listener, so one function can subscribe twice. */
interface Subscription {
  readonly listener: () => unknown
}

/**
 * Engines a deployment composes, keyed by id. Registration is all-or-nothing
 * and synchronous; subscribers are notified after every registration, removal,
 * and announced status change, and re-read {@link list} and each entry's
 * `status()` themselves.
 */
export class JudgmentEngineRegistry {
  private readonly entries = new Map<JudgmentEngineId, JudgmentEngineEntry>()
  private readonly subscriptions = new Set<Subscription>()

  /**
   * @param reportListenerFailure - receives what a subscriber threw or
   *   rejected with; notification continues with the next subscriber.
   */
  constructor(private readonly reportListenerFailure: (error: unknown) => void) {}

  /**
   * Register one engine. Call it inside the provider's `ctx.effect` so the
   * returned disposer runs with the provider's fiber.
   * @param id - the engine's registry id.
   * @param entry - the engine, its descriptor, and its status read.
   * @returns the disposer, carrying the status-change announcement.
   * @throws Error when the descriptor names another id, when
   *   `supportsFitting` disagrees with the engine's `fitting` capability, or
   *   when the id is already registered.
   */
  register(id: JudgmentEngineId, entry: JudgmentEngineEntry): JudgmentEngineRegistration {
    if (entry.descriptor.id !== id) {
      throw new Error(`judgment engine "${id}" cannot register a descriptor naming "${entry.descriptor.id}"`)
    }
    const fits = entry.engine.fitting !== undefined
    if (entry.descriptor.supportsFitting !== fits) {
      throw new Error(`judgment engine "${id}" declares supportsFitting ${String(entry.descriptor.supportsFitting)} but ${fits ? 'exposes' : 'does not expose'} fitting`)
    }
    if (this.entries.has(id)) throw new Error(`judgment engine "${id}" is already registered`)
    this.entries.set(id, entry)
    let released = false
    const registration = ((): void => {
      if (released) return
      released = true
      this.entries.delete(id)
      this.notify()
    }) as JudgmentEngineRegistration
    registration.statusChanged = (): void => {
      if (!released) this.notify()
    }
    this.notify()
    return registration
  }

  /**
   * Describe every registered engine.
   * @returns the descriptors, in registration order.
   */
  list(): readonly JudgmentEngineDescriptor[] {
    return [...this.entries.values()].map(entry => entry.descriptor)
  }

  /**
   * Look up one registered engine.
   * @param id - the registry id.
   * @returns the entry, or `undefined` when no provider registered the id.
   */
  get(id: JudgmentEngineId): JudgmentEngineEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * Observe registrations, removals, and announced status changes.
   * @param listener - called after each change; what it throws or rejects
   *   with is reported and does not reach the caller that caused the change.
   * @returns the disposer ending this subscription.
   */
  subscribe(listener: () => unknown): () => void {
    const subscription: Subscription = { listener }
    this.subscriptions.add(subscription)
    return () => {
      this.subscriptions.delete(subscription)
    }
  }

  /** Call every current subscriber, containing each one's failure. */
  private notify(): void {
    for (const { listener } of [...this.subscriptions]) {
      try {
        const returned = listener()
        if (isThenable(returned)) {
          void Promise.resolve(returned).then(undefined, (error: unknown) => {
            this.reportListenerFailure(error)
          })
        }
      } catch (error: unknown) {
        this.reportListenerFailure(error)
      }
    }
  }
}

/** Whether a listener returned a promise-like value whose rejection must be contained. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}
