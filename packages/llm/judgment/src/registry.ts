/**
 * The judgment engine registry provided as `ctx.judgmentEngines`.
 *
 * Each provider registers one engine under a stable id, and each consumer that
 * names itself on its asks declares its consumer id; the service mounted as
 * `ctx.judgment` (`judgment-dispatch`) owns the registry, routes every ask to the
 * one engine its settings select, and accepts a per-consumer override only for
 * a declared consumer. The registry itself selects nothing and never answers
 * an ask.
 *
 * @module @shres-code/shres-code-judgment/registry
 */

import type {
  JudgmentConsumerId,
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
 * Engines a deployment composes, keyed by id, and the consumer ids that name
 * themselves on their asks. Registration is all-or-nothing and synchronous;
 * subscribers are notified after every engine registration, removal, and
 * announced status change, and when a consumer id becomes declared or stops
 * being declared, and re-read {@link list}, {@link consumers}, and each
 * entry's `status()` themselves.
 */
export class JudgmentEngineRegistry {
  private readonly entries = new Map<JudgmentEngineId, JudgmentEngineEntry>()
  /** Live declarations per consumer id; an id is declared while its set is non-empty. */
  private readonly declarations = new Map<JudgmentConsumerId, Set<object>>()
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
   * Declare that a consumer names itself with `id` on its asks, so a
   * per-consumer override for it has an effect. Call it inside the consumer's
   * `ctx.effect` so the returned disposer runs with the consumer's fiber;
   * {@link declareJudgmentConsumer} does that. Several live declarations of one
   * id are allowed, and the id stays declared until every one is disposed.
   * @param id - the consumer id the consumer's asks carry.
   * @returns the disposer ending this declaration; repeated calls do nothing.
   */
  declareConsumer(id: JudgmentConsumerId): () => void {
    let live = this.declarations.get(id)
    const first = live === undefined
    if (live === undefined) {
      live = new Set()
      this.declarations.set(id, live)
    }
    const declaration = {}
    const tokens = live
    tokens.add(declaration)
    if (first) this.notify()
    return () => {
      // A repeated call finds the token already gone and changes nothing.
      if (!tokens.delete(declaration) || tokens.size > 0) return
      this.declarations.delete(id)
      this.notify()
    }
  }

  /**
   * Whether a consumer currently names itself with `id` on its asks.
   * @param id - the consumer id.
   * @returns true while at least one declaration of the id is live.
   */
  hasConsumer(id: string): boolean {
    return this.declarations.has(id as JudgmentConsumerId)
  }

  /**
   * List the declared consumer ids.
   * @returns the ids, in first-declaration order.
   */
  consumers(): readonly JudgmentConsumerId[] {
    return [...this.declarations.keys()]
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
