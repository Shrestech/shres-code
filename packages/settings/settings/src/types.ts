/**
 * Client-safe type surface of the user-settings seam: the namespace brand, the
 * commit-origin union, and the seam's Cordis event declarations. Types only —
 * no runtime code, and nothing here reaches a Host-only symbol, so a Client
 * compilation face reads exactly the signatures the Host emits.
 *
 * @module @shres-code/shres-code-settings/types
 */

import type { Branded } from '@shres-code/shres-code-brand'

/** Nominal id of one registered settings namespace. */
export type SettingsNamespace = Branded<'SettingsNamespace'>

/** Origin of one committed settings change. */
export type SettingsUpdateSource = 'update' | 'provider'

declare module '@shres-code/cordis' {
  interface Events {
    /**
     * Committed change to one registered namespace's resolved value. Emitted
     * after the provider persisted (for `update`) or published (`provider`)
     * the change; never emitted when the resolved value is deep-equal.
     * Listener failures are contained and logged — a sync throw and an async
     * rejection alike — except `INVARIANT`-coded failures, which rethrow
     * after every listener ran; that rethrow reaches the emitter only from
     * synchronous listeners, so invariant checks on this event must not be
     * async functions.
     * @param ns - the namespace whose resolved value changed.
     * @param next - the new resolved value.
     * @param prev - the previous resolved value.
     * @param source - whether the change entered through `update()` or the provider.
     * @mode emit
     */
    'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void

    /**
     * One registered namespace's RAW user section changed, whether or not the
     * resolved value did. `settings/updated` is the consumer-facing event and
     * stays deep-equal-gated; this one exists for configuration surfaces,
     * which must learn that a field went from inherited to overridden (same
     * resolved value, different meaning) and that their held revision is
     * stale. Listener containment matches `settings/updated`.
     * @param ns - the namespace whose stored section changed.
     * @param revision - the namespace's new revision.
     * @mode emit
     */
    'settings/document-updated'(ns: SettingsNamespace, revision: number): void

    /**
     * One namespace registration attached: its owner called `register()` and
     * the namespace is readable through `get()` from this point. A consumer of
     * another plugin's namespace reads `get()` once and follows this event,
     * `settings/updated`, and `settings/unregistered`, so plugin load order
     * does not matter. Listener containment matches `settings/updated`.
     * @param ns - the namespace that became registered.
     * @param value - the namespace's resolved value at registration.
     * @mode emit
     */
    'settings/registered'(ns: SettingsNamespace, value: unknown): void

    /**
     * One namespace registration detached, because its owner's fiber was
     * disposed or unloaded; `get()` returns `undefined` from this point until a
     * later registration. Listener containment matches `settings/updated`.
     * @param ns - the namespace that is no longer registered.
     * @mode emit
     */
    'settings/unregistered'(ns: SettingsNamespace): void
  }
}
